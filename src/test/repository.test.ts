import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveReviewRepository } from "../repository.js";

function createRootPi(roots: { jj?: string; git?: string }) {
  return {
    exec: vi.fn(async (command: string) => {
      const root = command === "jj" ? roots.jj : command === "git" ? roots.git : undefined;
      return root == null
        ? { code: 1, stdout: "", stderr: "not a repository" }
        : { code: 0, stdout: `${root}\n`, stderr: "" };
    }),
  };
}

describe("review repository discovery", () => {
  it("selects a nested JJ workspace instead of its enclosing Git repository", async () => {
    const pi = createRootPi({ jj: "/repo/.wp/workspace", git: "/repo" });

    await expect(resolveReviewRepository(pi as never, "/repo/.wp/workspace/src")).resolves.toEqual({
      kind: "jj",
      repoRoot: "/repo/.wp/workspace",
    });
  });

  it("selects a nested Git repository inside an enclosing JJ workspace", async () => {
    const pi = createRootPi({ jj: "/repo", git: "/repo/vendor/project" });

    await expect(resolveReviewRepository(pi as never, "/repo/vendor/project/src")).resolves.toEqual({
      kind: "git",
      repoRoot: "/repo/vendor/project",
    });
  });

  it("prefers JJ when a colocated repository has the same root", async () => {
    const pi = createRootPi({ jj: "/repo", git: "/repo" });

    await expect(resolveReviewRepository(pi as never, "/repo/src")).resolves.toEqual({
      kind: "jj",
      repoRoot: "/repo",
    });
  });

  it("falls back to Git when JJ discovery fails", async () => {
    const pi = createRootPi({ git: "/repo" });

    await expect(resolveReviewRepository(pi as never, "/repo/src")).resolves.toEqual({
      kind: "git",
      repoRoot: "/repo",
    });
  });

  it("fails closed on a nested .jj marker when the JJ command is unavailable", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "pi-slopchop-repository-test-"));
    const workspaceRoot = join(repoRoot, ".wp", "workspace");
    try {
      await mkdir(join(repoRoot, ".git"), { recursive: true });
      await mkdir(join(workspaceRoot, ".jj"), { recursive: true });
      const pi = createRootPi({ git: repoRoot });

      await expect(resolveReviewRepository(pi as never, workspaceRoot)).resolves.toEqual({
        kind: "jj",
        repoRoot: workspaceRoot,
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails when neither backend recognizes the working directory", async () => {
    const pi = createRootPi({});

    await expect(resolveReviewRepository(pi as never, "/tmp/outside")).rejects.toThrow("Not inside a Git or Jujutsu repository");
  });
});
