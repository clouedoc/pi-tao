import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeStatus, ReviewChange, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope, ReviewWindowData } from "./types.js";

const LARGE_DIFF_MAX_BYTES = 1_000_000;
const LARGE_DIFF_MAX_CHANGED_LINES = 20_000;
const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".avif", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe",
  ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lockb", ".map", ".mov", ".mp3", ".mp4",
  ".o", ".otf", ".pdf", ".png", ".pyc", ".so", ".svgz", ".tar", ".ttf", ".wasm", ".webm",
  ".webp", ".woff", ".woff2", ".zip",
]);

export interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

export function isReviewableFilePath(path: string): boolean {
  const fileName = path.toLowerCase().split("/").pop() ?? "";
  if (fileName.length === 0 || BINARY_EXTENSIONS.has(posix.extname(fileName))) return false;
  return !fileName.endsWith(".min.js") && !fileName.endsWith(".min.css");
}

function getChangeKey(change: ChangedPath): string {
  return normalizeJjPath(change.newPath ?? change.oldPath ?? "(unknown)");
}

function getImportAliases(path: string): string[] {
  const aliases = [path];
  const extension = posix.extname(path);
  if (extension.length > 0) aliases.push(path.slice(0, -extension.length));

  const directory = posix.dirname(path);
  if (posix.basename(path, extension) === "index" && directory !== ".") aliases.push(directory);
  return aliases;
}

function extractImportSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1] != null) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

export interface ChangedFileReferenceGraph {
  counts: Map<string, number>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
}

export function getChangedFileReferenceGraph(changes: ChangedPath[], contentsByPath: Map<string, string>): ChangedFileReferenceGraph {
  const paths = changes.map(getChangeKey);
  const aliases = new Map<string, string>();
  const counts = new Map(paths.map((path) => [path, 0]));
  const outgoing = new Map(paths.map((path) => [path, new Set<string>()]));
  const incoming = new Map(paths.map((path) => [path, new Set<string>()]));

  for (const path of paths) {
    for (const alias of getImportAliases(path)) aliases.set(alias, aliases.get(alias) ?? path);
  }

  for (const change of changes) {
    if (change.newPath == null) continue;
    const sourcePath = normalizeJjPath(change.newPath);
    const references = new Set<string>();
    for (const specifier of extractImportSpecifiers(contentsByPath.get(sourcePath) ?? "")) {
      if (!specifier.startsWith(".")) continue;
      const referencedPath = aliases.get(normalizeJjPath(posix.join(posix.dirname(sourcePath), specifier)));
      if (referencedPath != null && referencedPath !== sourcePath) references.add(referencedPath);
    }
    for (const referencedPath of references) {
      counts.set(referencedPath, (counts.get(referencedPath) ?? 0) + 1);
      outgoing.get(sourcePath)?.add(referencedPath);
      incoming.get(referencedPath)?.add(sourcePath);
    }
  }

  const sorted = (values: Map<string, Set<string>>): Map<string, string[]> => new Map(
    [...values].map(([path, related]) => [path, [...related].sort((a, b) => a.localeCompare(b))]),
  );
  return { counts, outgoing: sorted(outgoing), incoming: sorted(incoming) };
}

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

const JJ_CHANGE_TEMPLATE = [
  `'\{"commitId":' ++ stringify(commit_id).escape_json()`,
  ` ++ ',"changeId":' ++ stringify(change_id).escape_json()`,
  ` ++ ',"description":' ++ description.first_line().escape_json()`,
  ` ++ ',"bookmarks":' ++ stringify(bookmarks.map(|b| b.name()).join("\\n")).escape_json()`,
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

interface JjChangeTemplateEntry {
  commitId: string;
  changeId: string;
  description: string;
  bookmarks: string;
}

interface JjRevisionInfo {
  commitId: string;
  parentIds: string[];
}

interface JjReviewFileSeed {
  path: string;
  hasWorkingCopyFile: boolean;
  inChange: boolean;
  inStack: boolean;
  change: ReviewFileComparison | null;
  stack: ReviewFileComparison | null;
  stackReferenceCount: number;
  stackOutgoingReferences: string[];
  stackIncomingReferences: string[];
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

async function getReviewChanges(pi: ExtensionAPI, repoRoot: string, workingCopyCommitId: string): Promise<ReviewChange[]> {
  const output = await runJj(pi, repoRoot, ["log", "--no-graph", "-r", "all() ~ root() ~ merges()", "-T", JJ_CHANGE_TEMPLATE]);
  return parseJsonLines<JjChangeTemplateEntry>(output, "change list").map((entry) => ({
    commitId: entry.commitId,
    changeId: entry.changeId,
    description: entry.description || "(no description)",
    bookmarks: entry.bookmarks.length === 0 ? [] : entry.bookmarks.split("\n"),
    isWorkingCopy: entry.commitId === workingCopyCommitId,
  }));
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
    isTooLarge,
    originalRevision: fromRevision,
    modifiedRevision: toRevision,
  };
}

function createSeed(path: string, hasWorkingCopyFile: boolean): JjReviewFileSeed {
  return {
    path,
    hasWorkingCopyFile,
    inChange: false,
    inStack: false,
    change: null,
    stack: null,
    stackReferenceCount: 0,
    stackOutgoingReferences: [],
    stackIncomingReferences: [],
  };
}

function upsertSeed(
  seeds: Map<string, JjReviewFileSeed>,
  mapKey: string,
  path: string,
  hasWorkingCopyFile: boolean,
): JjReviewFileSeed {
  const existing = seeds.get(mapKey);
  if (existing != null) return existing;
  const seed = createSeed(path, hasWorkingCopyFile);
  seeds.set(mapKey, seed);
  return seed;
}

async function isWorkingFileTooLarge(repoRoot: string, path: string | null): Promise<boolean> {
  if (path == null) return false;
  try {
    const fileStat = await stat(join(repoRoot, path));
    return fileStat.isFile() && fileStat.size > LARGE_DIFF_MAX_BYTES;
  } catch {
    return false;
  }
}

async function getWorkingCopyContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function buildReviewFileId(seed: JjReviewFileSeed): string {
  return [
    seed.inChange ? "change" : "stack",
    seed.path,
    seed.hasWorkingCopyFile ? "working" : "gone",
    seed.change?.originalRevision ?? seed.stack?.originalRevision ?? "",
    seed.change?.modifiedRevision ?? seed.stack?.modifiedRevision ?? "",
    seed.change?.displayPath ?? seed.stack?.displayPath ?? "",
  ].join("::");
}

function createReviewFile(seed: JjReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed),
    path: seed.path,
    hasWorkingCopyFile: seed.hasWorkingCopyFile,
    inChange: seed.inChange,
    inStack: seed.inStack,
    change: seed.change,
    stack: seed.stack,
    stackReferenceCount: seed.stackReferenceCount,
    stackOutgoingReferences: seed.stackOutgoingReferences,
    stackIncomingReferences: seed.stackIncomingReferences,
  };
}

async function getCurrentPaths(pi: ExtensionAPI, repoRoot: string, revision: string): Promise<string[]> {
  const output = await runJj(pi, repoRoot, ["file", "list", "-r", revision, "-T", JJ_FILE_LIST_TEMPLATE]);
  return parseJjFileList(output);
}

async function buildReviewWindowData(
  pi: ExtensionAPI,
  repoRoot: string,
  revision: string,
): Promise<ReviewWindowData> {
  // Snapshot on-disk changes into @, then resolve symbolic revisions to exact
  // commit IDs so lazy content reads keep using the same trees.
  const workingCopy = await getRevisionInfo(pi, repoRoot, "@");
  const selectedRevision = await getRevisionInfo(pi, repoRoot, revision);
  if (selectedRevision.parentIds.length !== 1) {
    throw new Error("Slopchop cannot yet review a JJ merge change. Pick a single-parent change and try again.");
  }

  const selectedParent = await getRevisionInfo(pi, repoRoot, selectedRevision.parentIds[0]!);
  let selectedChanges: ChangedPath[];
  try {
    selectedChanges = await getJjRangeChanges(pi, repoRoot, selectedParent.commitId, selectedRevision.commitId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read JJ diff metadata. Slopchop requires jj 0.31 or newer. ${message}`);
  }

  const trunk = await getOptionalRevisionInfo(pi, repoRoot, "trunk()");
  const forkPoint = trunk == null
    ? null
    : await getOptionalRevisionInfo(pi, repoRoot, `fork_point(${trunk.commitId} | ${workingCopy.commitId})`);
  const stackChanges = forkPoint == null
    ? []
    : await getJjRangeChanges(pi, repoRoot, forkPoint.commitId, workingCopy.commitId);

  const changes = await getReviewChanges(pi, repoRoot, workingCopy.commitId);
  const selectedChange = changes.find((change) => change.commitId === selectedRevision.commitId);
  if (selectedChange == null) {
    throw new Error(`Could not find selected JJ change ${revision}.`);
  }

  const currentPaths = await getCurrentPaths(pi, repoRoot, workingCopy.commitId);
  const currentPathSet = new Set(currentPaths);
  const seeds = new Map<string, JjReviewFileSeed>();
  const workingInspectionCache = new Map<string, Promise<boolean>>();
  const changedLineCache = new Map<string, Promise<number | null>>();

  const inspectWorkingTarget = (path: string | null) => {
    if (path == null) return Promise.resolve(false);
    const normalized = normalizeJjPath(path);
    let inspection = workingInspectionCache.get(normalized);
    if (inspection == null) {
      inspection = isWorkingFileTooLarge(repoRoot, normalized);
      workingInspectionCache.set(normalized, inspection);
    }
    return inspection;
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
    const [workingFileTooLarge, changedLines] = await Promise.all([
      toRevision === workingCopy.commitId
        ? inspectWorkingTarget(change.newPath)
        : Promise.resolve(false),
      getCachedChangedLines(fromRevision, toRevision, change),
    ]);
    return {
      changedLines,
      isTooLarge: workingFileTooLarge
        || (changedLines != null && changedLines > LARGE_DIFF_MAX_CHANGED_LINES),
    };
  };

  for (const change of selectedChanges) {
    const key = getChangeKey(change);
    const inspection = await inspectComparison(change, selectedParent.commitId, selectedRevision.commitId);
    const seed = upsertSeed(seeds, `change::${key}`, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
    seed.inChange = true;
    seed.change = toComparison(change, selectedParent.commitId, selectedRevision.commitId, inspection.isTooLarge);
    if (change.status === "added" && inspection.changedLines != null) {
      seed.change.additions = inspection.changedLines;
      seed.change.deletions = 0;
    }
  }

  if (forkPoint != null) {
    const stackContentsByPath = new Map<string, string>();
    await Promise.all(stackChanges.map(async (change) => {
      if (change.newPath == null) return;
      const inspection = await inspectComparison(change, forkPoint.commitId, workingCopy.commitId);
      if (inspection.isTooLarge) return;
      stackContentsByPath.set(normalizeJjPath(change.newPath), await getWorkingCopyContent(repoRoot, change.newPath));
    }));
    const references = getChangedFileReferenceGraph(stackChanges, stackContentsByPath);

    for (const change of stackChanges) {
      const key = getChangeKey(change);
      const inspection = await inspectComparison(change, forkPoint.commitId, workingCopy.commitId);
      const seed = upsertSeed(seeds, `stack::${key}`, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
      seed.inStack = true;
      seed.stack = toComparison(change, forkPoint.commitId, workingCopy.commitId, inspection.isTooLarge);
      seed.stackReferenceCount = references.counts.get(key) ?? 0;
      seed.stackOutgoingReferences = references.outgoing.get(key) ?? [];
      seed.stackIncomingReferences = references.incoming.get(key) ?? [];
    }
  }

  return {
    repoRoot,
    files: [...seeds.values()].map(createReviewFile).sort((a, b) => a.path.localeCompare(b.path)),
    changes,
    selectedChange,
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

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string, revision = "@"): Promise<ReviewWindowData> {
  const result = await pi.exec("jj", ["--no-pager", "--color=never", "root"], { cwd });
  const repoRoot = result.stdout.trim();
  if (result.code !== 0 || repoRoot.length === 0) {
    throw new Error("Not inside a Jujutsu workspace.");
  }
  return buildReviewWindowData(pi, repoRoot, revision);
}

export async function loadReviewFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: ReviewFile,
  scope: ReviewScope,
): Promise<ReviewFileContents> {
  const comparison = scope === "change" ? file.change : file.stack;
  if (scope === "stack" && comparison == null) {
    const content = file.hasWorkingCopyFile ? await getWorkingCopyContent(repoRoot, file.path) : "";
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
