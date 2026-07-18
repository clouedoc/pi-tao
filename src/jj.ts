import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getChangedFileReferenceGraph, isReviewableFilePath, type ChangedPath } from "./git.js";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope } from "./types.js";

const LARGE_DIFF_MAX_BYTES = 1_000_000;
const LARGE_DIFF_MAX_CHANGED_LINES = 20_000;

const JJ_DIFF_TEMPLATE = [
  `'\{"status":' ++ status.escape_json()`,
  ` ++ ',"sourcePath":' ++ stringify(source.path()).escape_json()`,
  ` ++ ',"targetPath":' ++ stringify(target.path()).escape_json()`,
  ` ++ ',"sourceType":' ++ source.file_type().escape_json()`,
  ` ++ ',"targetType":' ++ target.file_type().escape_json()`,
  ` ++ "}\\n"`,
].join("");

const JJ_FILE_LIST_TEMPLATE = [
  `'\{"path":' ++ stringify(path).escape_json()`,
  ` ++ ',"type":' ++ file_type.escape_json()`,
  ` ++ "}\\n"`,
].join("");

interface JjDiffTemplateEntry {
  status: string;
  sourcePath: string;
  targetPath: string;
  sourceType: string;
  targetType: string;
}

interface JjFileListEntry {
  path: string;
  type: string;
}

interface JjRevisionInfo {
  commitId: string;
  parentIds: string[];
}

interface JjReviewFileSeed {
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  inAllFiles: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  allFiles: ReviewFileComparison | null;
  allFilesReferenceCount: number;
  allFilesOutgoingReferences: string[];
  allFilesIncomingReferences: string[];
}

function commandText(args: string[]): string {
  return `jj ${args.join(" ")}`;
}

async function runJj(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const fullArgs = ["--no-pager", "--color=never", "--quiet", "-R", repoRoot, ...args];
  const result = await pi.exec("jj", fullArgs, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `${commandText(args)} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runJjAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string | null> {
  try {
    return await runJj(pi, repoRoot, args);
  } catch {
    return null;
  }
}

async function getJjGitStoreRoot(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const output = await runJjAllowFailure(pi, repoRoot, ["git", "root"]);
  return output?.trim() || null;
}

async function getRevisionFileSize(
  pi: ExtensionAPI,
  repoRoot: string,
  gitStoreRoot: string | null,
  revision: string,
  path: string | null,
): Promise<number | null> {
  if (gitStoreRoot == null || path == null) return null;
  try {
    const result = await pi.exec("git", [
      `--git-dir=${gitStoreRoot}`,
      "cat-file",
      "-s",
      `${revision}:${path}`,
    ], { cwd: repoRoot });
    if (result.code !== 0) return null;
    const size = Number.parseInt(result.stdout.trim(), 10);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

async function getChangedLineCount(
  pi: ExtensionAPI,
  repoRoot: string,
  fromRevision: string,
  toRevision: string,
  path: string,
): Promise<number | null> {
  const output = await runJjAllowFailure(pi, repoRoot, [
    "diff",
    "--from",
    fromRevision,
    "--to",
    toRevision,
    "--stat",
    "--",
    path,
  ]);
  if (output == null) return null;

  let largestCount: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\|\s+(\d+)\s+[+-]*\s*$/);
    if (match == null) continue;
    const count = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(count)) largestCount = Math.max(largestCount ?? 0, count);
  }
  return largestCount;
}

function parseJsonLines<T>(output: string, description: string): T[] {
  const values: T[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`Could not parse ${description} from jj: ${line}`);
    }
  }
  return values;
}

function isJjReviewableType(type: string): boolean {
  return type === "" || type === "file" || type === "conflict";
}

function mapJjStatus(status: string): ChangeStatus | null {
  switch (status) {
    case "modified": return "modified";
    case "added": return "added";
    case "removed": return "deleted";
    case "renamed": return "renamed";
    case "copied": return "copied";
    default: return null;
  }
}

export function parseJjDiffEntries(output: string): ChangedPath[] {
  const changes: ChangedPath[] = [];
  for (const entry of parseJsonLines<JjDiffTemplateEntry>(output, "diff metadata")) {
    const status = mapJjStatus(entry.status);
    if (status == null) throw new Error(`Unsupported JJ diff status: ${String(entry.status)}`);
    if (!isJjReviewableType(entry.sourceType) || !isJjReviewableType(entry.targetType)) continue;

    const oldPath = status === "added" ? null : entry.sourcePath;
    const newPath = status === "deleted" ? null : entry.targetPath;
    const reviewPath = newPath ?? oldPath ?? "";
    if (reviewPath.length === 0 || !isReviewableFilePath(reviewPath)) continue;
    changes.push({ status, oldPath, newPath });
  }
  return changes;
}

function parseJjFileList(output: string): string[] {
  return parseJsonLines<JjFileListEntry>(output, "file list")
    .filter((entry) => isJjReviewableType(entry.type) && isReviewableFilePath(entry.path))
    .map((entry) => normalizeJjPath(entry.path));
}

function parseRevisionInfo(output: string): JjRevisionInfo {
  const line = output.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
  if (line == null) throw new Error("jj did not return revision metadata.");
  const [commitId = "", rawParents = ""] = line.split("\t", 2);
  if (!/^[0-9a-f]+$/i.test(commitId)) throw new Error(`jj returned an invalid commit ID: ${commitId}`);
  return {
    commitId,
    parentIds: rawParents.split(" ").filter((parent) => parent.length > 0),
  };
}

async function getRevisionInfo(pi: ExtensionAPI, repoRoot: string, revision: string): Promise<JjRevisionInfo> {
  const output = await runJj(pi, repoRoot, [
    "log",
    "--no-graph",
    "-r",
    revision,
    "-T",
    `commit_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(" ") ++ "\\n"`,
  ]);
  return parseRevisionInfo(output);
}

async function getOptionalRevisionInfo(pi: ExtensionAPI, repoRoot: string, revision: string): Promise<JjRevisionInfo | null> {
  const output = await runJjAllowFailure(pi, repoRoot, [
    "log",
    "--no-graph",
    "-r",
    `exactly(${revision}, 1)`,
    "-T",
    `commit_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(" ") ++ "\\n"`,
  ]);
  return output == null ? null : parseRevisionInfo(output);
}

async function getJjRangeChanges(
  pi: ExtensionAPI,
  repoRoot: string,
  fromRevision: string,
  toRevision: string,
): Promise<ChangedPath[]> {
  const output = await runJj(pi, repoRoot, [
    "diff",
    "--from",
    fromRevision,
    "--to",
    toRevision,
    "-T",
    JJ_DIFF_TEMPLATE,
  ]);
  return parseJjDiffEntries(output);
}

function normalizeJjPath(path: string): string {
  return posix.normalize(path).replace(/^\.\//, "");
}

function getChangeKey(change: ChangedPath): string {
  return normalizeJjPath(change.newPath ?? change.oldPath ?? "(unknown)");
}

function toDisplayPath(change: ChangedPath): string {
  if ((change.status === "renamed" || change.status === "copied") && change.oldPath != null && change.newPath != null) {
    return `${change.oldPath} -> ${change.newPath}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(
  change: ChangedPath,
  fromRevision: string,
  toRevision: string,
  isTooLarge: boolean,
): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
    isTooLarge,
    originalRevision: fromRevision,
    modifiedRevision: toRevision,
  };
}

function createSeed(path: string, hasWorkingTreeFile: boolean): JjReviewFileSeed {
  return {
    path,
    worktreeStatus: null,
    hasWorkingTreeFile,
    inGitDiff: false,
    inLastCommit: false,
    inAllFiles: false,
    gitDiff: null,
    lastCommit: null,
    allFiles: null,
    allFilesReferenceCount: 0,
    allFilesOutgoingReferences: [],
    allFilesIncomingReferences: [],
  };
}

function upsertSeed(
  seeds: Map<string, JjReviewFileSeed>,
  key: string,
  hasWorkingTreeFile: boolean,
): JjReviewFileSeed {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = createSeed(key, hasWorkingTreeFile);
  seeds.set(key, seed);
  return seed;
}

async function inspectWorkingFile(repoRoot: string, path: string | null): Promise<{ isTooLarge: boolean; lines: number | null }> {
  if (path == null) return { isTooLarge: false, lines: null };
  try {
    const absolutePath = join(repoRoot, path);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) return { isTooLarge: false, lines: null };
    if (fileStat.size > LARGE_DIFF_MAX_BYTES) return { isTooLarge: true, lines: null };
    const content = await readFile(absolutePath);
    let lines = 0;
    for (const byte of content) {
      if (byte === 0x0a) lines += 1;
    }
    if (content.length > 0 && content[content.length - 1] !== 0x0a) lines += 1;
    return { isTooLarge: lines > LARGE_DIFF_MAX_CHANGED_LINES, lines };
  } catch {
    return { isTooLarge: false, lines: null };
  }
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function buildReviewFileId(seed: JjReviewFileSeed): string {
  return [
    seed.path,
    seed.hasWorkingTreeFile ? "working" : "gone",
    seed.gitDiff?.displayPath ?? "",
    seed.lastCommit?.displayPath ?? "",
    seed.allFiles?.displayPath ?? "",
  ].join("::");
}

function createReviewFile(seed: JjReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed),
    path: seed.path,
    reviewBackend: "jj",
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inGitDiff: seed.inGitDiff,
    inLastCommit: seed.inLastCommit,
    inAllFiles: seed.inAllFiles,
    gitDiff: seed.gitDiff,
    lastCommit: seed.lastCommit,
    allFiles: seed.allFiles,
    allFilesReferenceCount: seed.allFilesReferenceCount,
    allFilesOutgoingReferences: seed.allFilesOutgoingReferences,
    allFilesIncomingReferences: seed.allFilesIncomingReferences,
  };
}

async function getCurrentPaths(pi: ExtensionAPI, repoRoot: string, revision: string): Promise<string[]> {
  const output = await runJj(pi, repoRoot, ["file", "list", "-r", revision, "-T", JJ_FILE_LIST_TEMPLATE]);
  return parseJjFileList(output);
}

export async function getJjReviewWindowData(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<{ repoRoot: string; files: ReviewFile[] }> {
  // This snapshots on-disk changes into @. Later queries use the resulting full
  // commit IDs so every scope and lazy content read refers to the same trees.
  const workingCopy = await getRevisionInfo(pi, repoRoot, "@");
  if (workingCopy.parentIds.length !== 1) {
    throw new Error("Slopchop cannot yet review a JJ working-copy merge. Create or edit a single-parent change and try again.");
  }

  const workingParent = await getRevisionInfo(pi, repoRoot, workingCopy.parentIds[0]!);
  let workingChanges: ChangedPath[];
  try {
    workingChanges = await getJjRangeChanges(pi, repoRoot, workingParent.commitId, workingCopy.commitId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read JJ diff metadata. Slopchop requires jj 0.31 or newer. ${message}`);
  }

  const parentChanges = workingParent.parentIds.length === 1
    ? await getJjRangeChanges(pi, repoRoot, workingParent.parentIds[0]!, workingParent.commitId)
    : [];

  const trunk = await getOptionalRevisionInfo(pi, repoRoot, "trunk()");
  const forkPoint = trunk == null
    ? null
    : await getOptionalRevisionInfo(pi, repoRoot, `fork_point(${trunk.commitId} | ${workingCopy.commitId})`);
  const stackChanges = forkPoint == null
    ? []
    : await getJjRangeChanges(pi, repoRoot, forkPoint.commitId, workingCopy.commitId);

  const currentPaths = await getCurrentPaths(pi, repoRoot, workingCopy.commitId);
  const currentPathSet = new Set(currentPaths);
  const seeds = new Map<string, JjReviewFileSeed>();
  const gitStoreRoot = await getJjGitStoreRoot(pi, repoRoot);
  const workingInspectionCache = new Map<string, Promise<{ isTooLarge: boolean; lines: number | null }>>();
  const revisionSizeCache = new Map<string, Promise<number | null>>();
  const changedLineCache = new Map<string, Promise<number | null>>();

  const inspectWorkingTarget = (path: string | null) => {
    if (path == null) return Promise.resolve({ isTooLarge: false, lines: null });
    const normalized = normalizeJjPath(path);
    let inspection = workingInspectionCache.get(normalized);
    if (inspection == null) {
      inspection = inspectWorkingFile(repoRoot, normalized);
      workingInspectionCache.set(normalized, inspection);
    }
    return inspection;
  };
  const getCachedRevisionSize = (revision: string, path: string | null) => {
    if (path == null) return Promise.resolve(null);
    const cacheKey = `${revision}\u001f${path}`;
    let size = revisionSizeCache.get(cacheKey);
    if (size == null) {
      size = getRevisionFileSize(pi, repoRoot, gitStoreRoot, revision, path);
      revisionSizeCache.set(cacheKey, size);
    }
    return size;
  };
  const getCachedChangedLines = (fromRevision: string, toRevision: string, change: ChangedPath) => {
    const path = change.newPath ?? change.oldPath;
    if (path == null) return Promise.resolve(null);
    const cacheKey = `${fromRevision}\u001f${toRevision}\u001f${path}`;
    let count = changedLineCache.get(cacheKey);
    if (count == null) {
      count = getChangedLineCount(pi, repoRoot, fromRevision, toRevision, path);
      changedLineCache.set(cacheKey, count);
    }
    return count;
  };
  const inspectComparison = async (change: ChangedPath, fromRevision: string, toRevision: string) => {
    const [workingTarget, originalSize, modifiedSize, changedLines] = await Promise.all([
      inspectWorkingTarget(change.newPath),
      getCachedRevisionSize(fromRevision, change.oldPath),
      getCachedRevisionSize(toRevision, change.newPath),
      getCachedChangedLines(fromRevision, toRevision, change),
    ]);
    return {
      lines: workingTarget.lines,
      isTooLarge: workingTarget.isTooLarge
        || (originalSize != null && originalSize > LARGE_DIFF_MAX_BYTES)
        || (modifiedSize != null && modifiedSize > LARGE_DIFF_MAX_BYTES)
        || (changedLines != null && changedLines > LARGE_DIFF_MAX_CHANGED_LINES),
    };
  };

  for (const change of workingChanges) {
    const key = getChangeKey(change);
    const inspection = await inspectComparison(change, workingParent.commitId, workingCopy.commitId);
    const seed = upsertSeed(seeds, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change, workingParent.commitId, workingCopy.commitId, inspection.isTooLarge);
    if (change.status === "added" && inspection.lines != null) {
      seed.gitDiff.additions = inspection.lines;
      seed.gitDiff.deletions = 0;
    }
  }

  for (const change of parentChanges) {
    const key = getChangeKey(change);
    const inspection = await inspectComparison(change, workingParent.parentIds[0]!, workingParent.commitId);
    const seed = upsertSeed(seeds, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change, workingParent.parentIds[0]!, workingParent.commitId, inspection.isTooLarge);
  }

  if (forkPoint != null) {
    const stackContentsByPath = new Map<string, string>();
    await Promise.all(stackChanges.map(async (change) => {
      if (change.newPath == null) return;
      const inspection = await inspectComparison(change, forkPoint.commitId, workingCopy.commitId);
      if (inspection.isTooLarge) return;
      stackContentsByPath.set(normalizeJjPath(change.newPath), await getWorkingTreeContent(repoRoot, change.newPath));
    }));
    const references = getChangedFileReferenceGraph(stackChanges, stackContentsByPath);

    for (const change of stackChanges) {
      const key = getChangeKey(change);
      const inspection = await inspectComparison(change, forkPoint.commitId, workingCopy.commitId);
      const seed = upsertSeed(seeds, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
      seed.inAllFiles = true;
      seed.allFiles = toComparison(change, forkPoint.commitId, workingCopy.commitId, inspection.isTooLarge);
      seed.allFilesReferenceCount = references.counts.get(key) ?? 0;
      seed.allFilesOutgoingReferences = references.outgoing.get(key) ?? [];
      seed.allFilesIncomingReferences = references.incoming.get(key) ?? [];
    }
  }

  if (seeds.size === 0) {
    for (const path of currentPaths) {
      const seed = createSeed(path, true);
      seed.inAllFiles = true;
      seeds.set(path, seed);
    }
  }

  return {
    repoRoot,
    files: [...seeds.values()].map(createReviewFile).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function assertReviewableContent(content: string, path: string): void {
  if (Buffer.byteLength(content, "utf8") > LARGE_DIFF_MAX_BYTES) {
    throw new Error(`JJ file is too large for interactive review: ${path}`);
  }
  let lines = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 0x0a) lines += 1;
  }
  if (content.length > 0 && content.charCodeAt(content.length - 1) !== 0x0a) lines += 1;
  if (lines > LARGE_DIFF_MAX_CHANGED_LINES) {
    throw new Error(`JJ file has too many lines for interactive review: ${path}`);
  }
}

async function getJjRevisionContent(
  pi: ExtensionAPI,
  repoRoot: string,
  revision: string,
  path: string,
): Promise<string> {
  const result = await pi.exec("jj", [
    "--no-pager",
    "--color=never",
    "--quiet",
    "-R",
    repoRoot,
    "file",
    "show",
    "-r",
    revision,
    "-T",
    "",
    "--",
    path,
  ], { cwd: repoRoot });
  if (result.code === 0) {
    assertReviewableContent(result.stdout, path);
    return result.stdout;
  }
  const message = result.stderr.trim() || result.stdout.trim();
  if (/no such path|doesn't match any files/i.test(message)) return "";
  throw new Error(message || `Could not read ${path} at JJ revision ${revision}.`);
}

export async function loadJjReviewFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: ReviewFile,
  scope: ReviewScope,
): Promise<ReviewFileContents> {
  const comparison = scope === "git-diff" ? file.gitDiff : scope === "last-commit" ? file.lastCommit : file.allFiles;
  if (scope === "all-files" && comparison == null) {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return { originalContent: content, modifiedContent: content };
  }
  if (comparison == null || comparison.isTooLarge) {
    return { originalContent: "", modifiedContent: "" };
  }
  if (comparison.originalRevision == null || comparison.modifiedRevision == null) {
    throw new Error("JJ comparison is missing an exact revision range.");
  }

  const [originalContent, modifiedContent] = await Promise.all([
    comparison.oldPath == null
      ? Promise.resolve("")
      : getJjRevisionContent(pi, repoRoot, comparison.originalRevision, comparison.oldPath),
    comparison.newPath == null
      ? Promise.resolve("")
      : getJjRevisionContent(pi, repoRoot, comparison.modifiedRevision, comparison.newPath),
  ]);
  return { originalContent, modifiedContent };
}
