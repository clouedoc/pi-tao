import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getChangedFileReferenceGraph, getReviewWindowData, isReviewableFilePath, loadReviewFileContents, parseJjDiffEntries } from "../jj.js";

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

  it("tracks references between changed files", () => {
    const changes = [
      { status: "added" as const, oldPath: null, newPath: "src/root.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "modified" as const, oldPath: "src/nested/b.ts", newPath: "src/nested/b.ts" },
    ];
    const contents = new Map([
      ["src/a.ts", "import { root } from './root';\n"],
      ["src/nested/b.ts", "export { root } from '../root';\n"],
    ]);

    const graph = getChangedFileReferenceGraph(changes, contents);
    expect(graph.counts.get("src/root.ts")).toBe(2);
    expect(graph.outgoing.get("src/a.ts")).toEqual(["src/root.ts"]);
    expect(graph.incoming.get("src/root.ts")).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("filters obvious binary and minified assets", () => {
    expect(isReviewableFilePath("src/app.ts")).toBe(true);
    expect(isReviewableFilePath("assets/logo.png")).toBe(false);
    expect(isReviewableFilePath("dist/app.min.js")).toBe(false);
  });
});

describe("JJ workspace integration", () => {
  it("requires a Jujutsu workspace", async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "not a Jujutsu workspace" }));

    await expect(getReviewWindowData({ exec } as never, "/tmp/outside")).rejects.toThrow("Not inside a Jujutsu workspace");
    expect(exec).toHaveBeenCalledWith("jj", ["--no-pager", "--color=never", "root"], { cwd: "/tmp/outside" });
  });

  jjIt("reviews the active nested JJ workspace", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "pi-tao-test-"));
    const workspaceRoot = join(repoRoot, ".wp", "my-workspace");
    try {
      await run("jj", ["git", "init", "--colocate", "."], repoRoot);
      await writeFile(join(repoRoot, "README.md"), "initial\n", "utf8");
      await run("jj", ["describe", "-m", "initial"], repoRoot);
      await run("jj", ["new"], repoRoot);
      await mkdir(join(repoRoot, ".wp"), { recursive: true });
      await run("jj", ["workspace", "add", ".wp/my-workspace"], repoRoot);

      await writeFile(join(repoRoot, "outer-only.txt"), "wrong workspace\n", "utf8");
      await writeFile(join(workspaceRoot, "README.md"), "initial\nworkspace change\n", "utf8");
      await writeFile(join(workspaceRoot, "new.ts"), "export const value = 1;\n", "utf8");

      const pi = createExecPi();
      const data = await getReviewWindowData(pi as never, workspaceRoot);

      expect(data.repoRoot).toBe(workspaceRoot);
      expect(data.files.filter((file) => file.inChange).map((file) => file.path).sort()).toEqual(["README.md", "new.ts"]);
      expect(data.files.some((file) => file.path === "outer-only.txt")).toBe(false);
      expect(data.selectedChange.isWorkingCopy).toBe(true);
      expect(data.selectedChange.changeId.startsWith(data.selectedChange.changeIdPrefix)).toBe(true);
      expect(data.changes.some((change) => !change.isWorkingCopy)).toBe(true);
      expect(data.stackRange?.start.description).toBe("initial");
      expect(data.stackRange?.end.isWorkingCopy).toBe(true);

      const readme = data.files.find((file) => file.path === "README.md" && file.inChange)!;
      const stackReadme = data.files.find((file) => file.path === "README.md" && file.inStack)!;
      await expect(loadReviewFileContents(pi as never, workspaceRoot, readme, "change")).resolves.toEqual({
        originalContent: "initial\n",
        modifiedContent: "initial\nworkspace change\n",
      });
      await expect(loadReviewFileContents(pi as never, workspaceRoot, stackReadme, "stack")).resolves.toEqual({
        // With no configured remote, JJ's default trunk() is the root commit.
        originalContent: "",
        modifiedContent: "initial\nworkspace change\n",
      });

      await writeFile(join(workspaceRoot, "README.md"), "initial\n", "utf8");
      await rename(join(workspaceRoot, "README.md"), join(workspaceRoot, "RENAMED.md"));
      const withRename = await getReviewWindowData(pi as never, workspaceRoot);
      const renamed = withRename.files.find((file) => file.path === "RENAMED.md")!;
      expect(renamed.change?.status).toBe("renamed");
      await expect(loadReviewFileContents(pi as never, workspaceRoot, renamed, "change")).resolves.toEqual({
        originalContent: "initial\n",
        modifiedContent: "initial\n",
      });
      await rename(join(workspaceRoot, "RENAMED.md"), join(workspaceRoot, "README.md"));
      await writeFile(join(workspaceRoot, "README.md"), "initial\nworkspace change\n", "utf8");

      const restoredData = await getReviewWindowData(pi as never, workspaceRoot);
      const restoredStackReadme = restoredData.files.find((file) => file.path === "README.md" && file.inStack)!;
      const initialChange = restoredData.changes.find((change) => change.description === "initial")!;
      const olderChange = await getReviewWindowData(pi as never, workspaceRoot, initialChange.commitId);
      expect(olderChange.selectedChange.isWorkingCopy).toBe(false);
      expect(olderChange.changes.some((change) => change.commitId === olderChange.selectedChange.commitId)).toBe(true);
      const olderReadme = olderChange.files.find((file) => file.path === "README.md" && file.inChange)!;
      expect(olderReadme.id).not.toBe(readme.id);
      expect(olderChange.files.find((file) => file.path === "README.md" && file.inStack)?.id).toBe(restoredStackReadme.id);
      await expect(loadReviewFileContents(pi as never, workspaceRoot, olderReadme, "change")).resolves.toEqual({
        originalContent: "",
        modifiedContent: "initial\n",
      });

      await writeFile(join(workspaceRoot, "delete-me.txt"), "delete me\n", "utf8");
      await writeFile(join(workspaceRoot, "large-added.txt"), "x".repeat(1_000_001), "utf8");
      await writeFile(join(workspaceRoot, "high-churn.txt"), "a\n".repeat(11_000), "utf8");
      await run("jj", ["new"], workspaceRoot);
      await rm(join(workspaceRoot, "delete-me.txt"));
      await writeFile(join(workspaceRoot, "large-current.txt"), "y".repeat(1_000_001), "utf8");
      await writeFile(join(workspaceRoot, "high-churn.txt"), "b\n".repeat(11_000), "utf8");

      const withLargeFiles = await getReviewWindowData(pi as never, workspaceRoot);
      const deleted = withLargeFiles.files.find((file) => file.path === "delete-me.txt")!;
      expect(deleted.change?.status).toBe("deleted");
      await expect(loadReviewFileContents(pi as never, workspaceRoot, deleted, "change")).resolves.toEqual({
        originalContent: "delete me\n",
        modifiedContent: "",
      });
      for (const path of ["large-current.txt", "high-churn.txt"]) {
        expect(withLargeFiles.files.find((file) => file.path === path)?.change?.isTooLarge, path).toBe(true);
      }
      expect(withLargeFiles.files.find((file) => file.path === "large-added.txt")?.stack?.isTooLarge).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
