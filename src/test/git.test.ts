import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getChangedFileReferenceCounts, getChangedFileReferenceGraph, getReviewWindowData, getSubmoduleReviewWindowData, isReviewableFilePath, loadReviewFileContents, mergeChangedPaths, parseNameStatus, parseNumStat, parseRawDiff, parseUntrackedPaths } from "../git.js";

const execFileAsync = promisify(execFile);

async function runGit(repoRoot: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoRoot });
}

async function createGitRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-slopchop-git-test-"));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Test User"]);
  await writeFile(join(repoRoot, "README.md"), "initial\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

function createExecPi() {
  return {
    exec: async (command: string, args: string[], options?: { cwd?: string }) => {
      try {
        const result = await execFileAsync(command, args, { cwd: options?.cwd });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { code: typeof execError.code === "number" ? execError.code : 1, stdout: execError.stdout ?? "", stderr: execError.stderr ?? execError.message };
      }
    },
  };
}

describe("git helpers", () => {
  it("parses modified, added, deleted, and renamed files", () => {
    const output = [
      "M\tsrc/app.ts",
      "A\tREADME.md",
      "D\told.txt",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
    ].join("\n");

    expect(parseNameStatus(output)).toEqual([
      { status: "modified", oldPath: "src/app.ts", newPath: "src/app.ts" },
      { status: "added", oldPath: null, newPath: "README.md" },
      { status: "deleted", oldPath: "old.txt", newPath: null },
      { status: "renamed", oldPath: "src/old-name.ts", newPath: "src/new-name.ts" },
    ]);
  });

  it("merges tracked and untracked changes without duplicates", () => {
    const tracked = [{ status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" }];
    const untracked = [
      { status: "added" as const, oldPath: null, newPath: "src/new.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
    ];

    expect(mergeChangedPaths(tracked, untracked)).toEqual([
      { status: "modified", oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "added", oldPath: null, newPath: "src/new.ts" },
    ]);
  });

  it("parses untracked paths", () => {
    expect(parseUntrackedPaths("src/new.ts\nnotes.md\n")).toEqual([
      { status: "added", oldPath: null, newPath: "src/new.ts" },
      { status: "added", oldPath: null, newPath: "notes.md" },
    ]);
  });

  it("parses numstat additions and deletions", () => {
    expect(parseNumStat("12\t3\tsrc/app.ts\n-\t-\tassets/generated.bin\n")).toEqual(new Map([
      ["src/app.ts", { additions: 12, deletions: 3 }],
      ["assets/generated.bin", { additions: 0, deletions: 0 }],
    ]));
  });

  it("parses raw submodule gitlink changes with old and new commits", () => {
    const output = ":160000 160000 abc1234 def5678 M\0packages/app\0";

    expect(parseRawDiff(output)).toEqual([
      {
        status: "modified",
        oldPath: "packages/app",
        newPath: "packages/app",
        oldMode: "160000",
        newMode: "160000",
        oldSha: "abc1234",
        newSha: "def5678",
      },
    ]);
  });

  it("builds nested submodule review data from the explicit parent gitlink range", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined === "diff --find-renames -M --name-status old-sha new-sha --") return { code: 0, stdout: "M\tsrc/app.ts\n", stderr: "" };
      if (joined === "diff --find-renames -M --raw -z old-sha new-sha --") return { code: 0, stdout: "", stderr: "" };
      if (joined === "diff --find-renames -M --numstat old-sha new-sha --") return { code: 0, stdout: "4\t2\tsrc/app.ts\n", stderr: "" };
      if (joined === "show new-sha:src/app.ts") return { code: 0, stdout: "export const app = true;\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    });

    const data = await getSubmoduleReviewWindowData({ exec } as never, "/repo/packages/app", "old-sha", "new-sha");

    expect(data.files).toHaveLength(1);
    expect(data.files[0]).toMatchObject({
      path: "src/app.ts",
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      allFiles: {
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        originalRevision: "old-sha",
        modifiedRevision: "new-sha",
        additions: 4,
        deletions: 2,
      },
    });
  });

  it("loads explicit range contents from comparison revisions", async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined === "show old-sha:src/app.ts") return { code: 0, stdout: "old\n", stderr: "" };
      if (joined === "show new-sha:src/app.ts") return { code: 0, stdout: "new\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected command" };
    });

    await expect(loadReviewFileContents({ exec } as never, "/repo/packages/app", {
      id: "src/app.ts",
      path: "src/app.ts",
      worktreeStatus: null,
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inLastCommit: false,
      inAllFiles: true,
      gitDiff: null,
      lastCommit: null,
      allFiles: {
        status: "modified",
        oldPath: "src/app.ts",
        newPath: "src/app.ts",
        displayPath: "src/app.ts",
        hasOriginal: true,
        hasModified: true,
        originalRevision: "old-sha",
        modifiedRevision: "new-sha",
      },
    }, "all-files")).resolves.toEqual({ originalContent: "old\n", modifiedContent: "new\n" });
  });

  it("marks large untracked files with compact review metadata", async () => {
    const repoRoot = await createGitRepo();
    try {
      await writeFile(join(repoRoot, "large.md"), `${"line\n".repeat(20_001)}`, "utf8");

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      const file = data.files.find((entry) => entry.path === "large.md");

      expect(file?.gitDiff).toMatchObject({
        status: "added",
        additions: 20_001,
        deletions: 0,
        isTooLarge: true,
        statsTruncated: true,
      });
      await expect(loadReviewFileContents(createExecPi() as never, repoRoot, file!, "git-diff")).resolves.toEqual({ originalContent: "", modifiedContent: "" });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("marks tracked diffs over the changed-line limit as compact placeholders", async () => {
    const repoRoot = await createGitRepo();
    try {
      await writeFile(join(repoRoot, "large.md"), `${"line\n".repeat(20_001)}`, "utf8");
      await runGit(repoRoot, ["add", "large.md"]);

      const data = await getReviewWindowData(createExecPi() as never, repoRoot);
      const file = data.files.find((entry) => entry.path === "large.md");

      expect(file?.gitDiff).toMatchObject({
        status: "added",
        additions: 20_001,
        deletions: 0,
        isTooLarge: true,
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("counts changed files referenced by other changed files", () => {
    const changes = [
      { status: "added" as const, oldPath: null, newPath: "src/root.ts" },
      { status: "modified" as const, oldPath: "src/a.ts", newPath: "src/a.ts" },
      { status: "modified" as const, oldPath: "src/nested/b.ts", newPath: "src/nested/b.ts" },
    ];
    const contents = new Map([
      ["src/a.ts", "import { root } from './root';\n"],
      ["src/nested/b.ts", "export { root } from '../root';\n"],
    ]);

    expect(getChangedFileReferenceCounts(changes, contents).get("src/root.ts")).toBe(2);
    const graph = getChangedFileReferenceGraph(changes, contents);
    expect(graph.outgoing.get("src/a.ts")).toEqual(["src/root.ts"]);
    expect(graph.incoming.get("src/root.ts")).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  it("filters obvious binary or minified assets", () => {
    expect(isReviewableFilePath("src/app.ts")).toBe(true);
    expect(isReviewableFilePath("assets/logo.png")).toBe(false);
    expect(isReviewableFilePath("dist/app.min.js")).toBe(false);
  });
});
