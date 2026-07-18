import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseJjDiffEntries } from "../jj.js";
import { getReviewWindowData, loadReviewFileContents } from "../repository.js";

const execFileAsync = promisify(execFile);
const hasJj = spawnSync("jj", ["--version"], { stdio: "ignore" }).status === 0;
const jjIt = hasJj ? it : it.skip;

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function createExecPi() {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      try {
        const result = await execFileAsync(command, args, { cwd: options?.cwd, maxBuffer: 10 * 1024 * 1024 });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
        return {
          code: typeof execError.code === "number" ? execError.code : 1,
          stdout: execError.stdout ?? "",
          stderr: execError.stderr ?? execError.message,
        };
      }
    },
  };
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd });
}

describe("JJ diff metadata", () => {
  it("parses JJ statuses, rename/copy paths, and escaped path characters", () => {
    const output = [
      { status: "modified", sourcePath: "src/app.ts", targetPath: "src/app.ts", sourceType: "file", targetType: "file" },
      { status: "added", sourcePath: "new\tfile.ts", targetPath: "new\tfile.ts", sourceType: "", targetType: "file" },
      { status: "removed", sourcePath: "old\nfile.ts", targetPath: "old\nfile.ts", sourceType: "file", targetType: "" },
      { status: "renamed", sourcePath: "before.ts", targetPath: "after.ts", sourceType: "file", targetType: "file" },
      { status: "copied", sourcePath: "source.ts", targetPath: "copy.ts", sourceType: "file", targetType: "file" },
    ].map(jsonLine).join("");

    expect(parseJjDiffEntries(output)).toEqual([
      { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts" },
      { status: "added", oldPath: null, newPath: "new\tfile.ts" },
      { status: "deleted", oldPath: "old\nfile.ts", newPath: null },
      { status: "renamed", oldPath: "before.ts", newPath: "after.ts" },
      { status: "copied", oldPath: "source.ts", newPath: "copy.ts" },
    ]);
  });

  it("filters unsupported non-file tree values", () => {
    const output = [
      { status: "modified", sourcePath: "link", targetPath: "link", sourceType: "symlink", targetType: "symlink" },
      { status: "modified", sourcePath: "module", targetPath: "module", sourceType: "git-submodule", targetType: "git-submodule" },
    ].map(jsonLine).join("");

    expect(parseJjDiffEntries(output)).toEqual([]);
  });

  it("rejects malformed JSONL instead of returning a partial diff", () => {
    expect(() => parseJjDiffEntries('{"status":"modified"\n')).toThrow("Could not parse diff metadata from jj");
  });
});

describe("JJ workspace integration", () => {
  jjIt("reviews a nested JJ workspace instead of the enclosing Git worktree", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "pi-slopchop-jj-test-"));
    const workspaceRoot = join(repoRoot, ".wp", "my-workspace");
    try {
      await run("git", ["init", "-q"], repoRoot);
      await run("git", ["config", "user.email", "test@example.com"], repoRoot);
      await run("git", ["config", "user.name", "Test User"], repoRoot);
      await writeFile(join(repoRoot, "README.md"), "initial\n", "utf8");
      await run("git", ["add", "README.md"], repoRoot);
      await run("git", ["commit", "-qm", "initial"], repoRoot);
      await run("jj", ["git", "init", "--colocate", "."], repoRoot);
      await mkdir(join(repoRoot, ".wp"), { recursive: true });
      await run("jj", ["workspace", "add", ".wp/my-workspace"], repoRoot);

      await writeFile(join(repoRoot, "outer-only.txt"), "wrong workspace\n", "utf8");
      await writeFile(join(workspaceRoot, "README.md"), "initial\nworkspace change\n", "utf8");
      await writeFile(join(workspaceRoot, "new.ts"), "export const value = 1;\n", "utf8");

      const pi = createExecPi();
      const data = await getReviewWindowData(pi as never, workspaceRoot);

      expect(data.backend).toBe("jj");
      expect(data.repoRoot).toBe(workspaceRoot);
      expect(data.scopeLabels).toEqual({
        "git-diff": "working copy",
        "last-commit": "parent change",
        "all-files": "stack vs trunk",
      });
      expect(data.files.filter((file) => file.inGitDiff).map((file) => file.path).sort()).toEqual(["README.md", "new.ts"]);
      expect(data.files.some((file) => file.path === "outer-only.txt")).toBe(false);

      const readme = data.files.find((file) => file.path === "README.md")!;
      expect(readme.reviewBackend).toBe("jj");
      expect(readme.inLastCommit).toBe(true);
      expect(readme.inAllFiles).toBe(true);
      await expect(loadReviewFileContents(pi as never, workspaceRoot, readme, "git-diff")).resolves.toEqual({
        originalContent: "initial\n",
        modifiedContent: "initial\nworkspace change\n",
      });
      await expect(loadReviewFileContents(pi as never, workspaceRoot, readme, "last-commit")).resolves.toEqual({
        originalContent: "",
        modifiedContent: "initial\n",
      });
      await expect(loadReviewFileContents(pi as never, workspaceRoot, readme, "all-files")).resolves.toEqual({
        // With no configured remote, JJ's default trunk() is the root commit.
        originalContent: "",
        modifiedContent: "initial\nworkspace change\n",
      });

      await writeFile(join(workspaceRoot, "README.md"), "initial\n", "utf8");
      await rename(join(workspaceRoot, "README.md"), join(workspaceRoot, "RENAMED.md"));
      const withRename = await getReviewWindowData(pi as never, workspaceRoot);
      const renamed = withRename.files.find((file) => file.path === "RENAMED.md")!;
      expect(renamed.gitDiff?.status).toBe("renamed");
      await expect(loadReviewFileContents(pi as never, workspaceRoot, renamed, "git-diff")).resolves.toEqual({
        originalContent: "initial\n",
        modifiedContent: "initial\n",
      });
      await rename(join(workspaceRoot, "RENAMED.md"), join(workspaceRoot, "README.md"));
      await writeFile(join(workspaceRoot, "README.md"), "initial\nworkspace change\n", "utf8");

      await writeFile(join(workspaceRoot, "delete-me.txt"), "delete me\n", "utf8");
      await writeFile(join(workspaceRoot, "large-added.txt"), "x".repeat(1_000_001), "utf8");
      await writeFile(join(workspaceRoot, "large-deleted.txt"), "x".repeat(1_000_001), "utf8");
      await writeFile(join(workspaceRoot, "large-replaced.txt"), "x".repeat(1_000_001), "utf8");
      await writeFile(join(workspaceRoot, "high-churn.txt"), "a\n".repeat(11_000), "utf8");
      await run("jj", ["new"], workspaceRoot);
      await rm(join(workspaceRoot, "delete-me.txt"));
      await rm(join(workspaceRoot, "large-deleted.txt"));
      await writeFile(join(workspaceRoot, "large-current.txt"), "y".repeat(1_000_001), "utf8");
      await writeFile(join(workspaceRoot, "large-replaced.txt"), "small\n", "utf8");
      await writeFile(join(workspaceRoot, "high-churn.txt"), "b\n".repeat(11_000), "utf8");

      const withLargeFiles = await getReviewWindowData(pi as never, workspaceRoot);
      const deleted = withLargeFiles.files.find((file) => file.path === "delete-me.txt")!;
      expect(deleted.gitDiff?.status).toBe("deleted");
      await expect(loadReviewFileContents(pi as never, workspaceRoot, deleted, "git-diff")).resolves.toEqual({
        originalContent: "delete me\n",
        modifiedContent: "",
      });
      for (const path of ["large-current.txt", "large-deleted.txt", "large-replaced.txt", "high-churn.txt"]) {
        expect(withLargeFiles.files.find((file) => file.path === path)?.gitDiff?.isTooLarge, path).toBe(true);
      }
      expect(withLargeFiles.files.find((file) => file.path === "large-added.txt")?.lastCommit?.isTooLarge).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
