import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData as getGitReviewWindowData, getSubmoduleReviewWindowData, loadReviewFileContents as loadGitReviewFileContents } from "./git.js";
import { getJjReviewWindowData, loadJjReviewFileContents } from "./jj.js";
import type { ReviewBackendKind, ReviewFile, ReviewFileContents, ReviewScope, ReviewScopeLabels, ReviewWindowData } from "./types.js";
import { GIT_SCOPE_LABELS, JJ_SCOPE_LABELS } from "./types.js";

export interface ReviewRepositoryLocation {
  kind: ReviewBackendKind;
  repoRoot: string;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function findMarkerRoot(kind: ReviewBackendKind, cwd: string): Promise<ReviewRepositoryLocation | null> {
  const markerName = kind === "jj" ? ".jj" : ".git";
  let directory = cwd;
  while (true) {
    try {
      await lstat(join(directory, markerName));
      return { kind, repoRoot: directory };
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  }
}

async function probeRoot(pi: ExtensionAPI, kind: ReviewBackendKind, cwd: string): Promise<ReviewRepositoryLocation | null> {
  try {
    const result = kind === "jj"
      ? await pi.exec("jj", ["--no-pager", "--color=never", "root"], { cwd })
      : await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    const output = result.stdout.trim();
    if (result.code !== 0 || output.length === 0) return null;
    return { kind, repoRoot: await canonicalPath(output) };
  } catch {
    return null;
  }
}

function pathDepth(path: string): number {
  return resolve(path).split(sep).filter((part) => part.length > 0).length;
}

function containsPath(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`));
}

export async function resolveReviewRepository(pi: ExtensionAPI, cwd: string): Promise<ReviewRepositoryLocation> {
  const canonicalCwd = await canonicalPath(cwd);
  const [jjProbe, gitProbe, jjMarker, gitMarker] = await Promise.all([
    probeRoot(pi, "jj", canonicalCwd),
    probeRoot(pi, "git", canonicalCwd),
    findMarkerRoot("jj", canonicalCwd),
    findMarkerRoot("git", canonicalCwd),
  ]);
  const candidates = [jjProbe, gitProbe, jjMarker, gitMarker]
    .filter((candidate): candidate is ReviewRepositoryLocation => (
      candidate != null && containsPath(candidate.repoRoot, canonicalCwd)
    ));

  if (candidates.length === 0) {
    throw new Error("Not inside a Git or Jujutsu repository.");
  }

  candidates.sort((a, b) => {
    const depthDelta = pathDepth(b.repoRoot) - pathDepth(a.repoRoot);
    if (depthDelta !== 0) return depthDelta;
    if (a.kind === b.kind) return 0;
    return a.kind === "jj" ? -1 : 1;
  });
  return candidates[0]!;
}

function withReviewMetadata(
  data: { repoRoot: string; files: ReviewFile[] },
  backend: ReviewBackendKind,
  scopeLabels: ReviewScopeLabels,
): ReviewWindowData {
  return {
    ...data,
    backend,
    scopeLabels,
    files: data.files.map((file) => ({ ...file, reviewBackend: backend })),
  };
}

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string): Promise<ReviewWindowData> {
  const repository = await resolveReviewRepository(pi, cwd);
  if (repository.kind === "jj") {
    return withReviewMetadata(await getJjReviewWindowData(pi, repository.repoRoot), "jj", JJ_SCOPE_LABELS);
  }
  return withReviewMetadata(await getGitReviewWindowData(pi, repository.repoRoot), "git", GIT_SCOPE_LABELS);
}

export async function loadReviewFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: ReviewFile,
  scope: ReviewScope,
): Promise<ReviewFileContents> {
  return file.reviewBackend === "jj"
    ? loadJjReviewFileContents(pi, repoRoot, file, scope)
    : loadGitReviewFileContents(pi, repoRoot, file, scope);
}

export { getSubmoduleReviewWindowData };
