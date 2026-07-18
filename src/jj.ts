import { readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope, ReviewWindowData } from "./types.js";

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
  hasWorkingCopyFile: boolean;
  inWorkingCopy: boolean;
  inParentChange: boolean;
  inStack: boolean;
  workingCopy: ReviewFileComparison | null;
  parentChange: ReviewFileComparison | null;
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
    inWorkingCopy: false,
    inParentChange: false,
    inStack: false,
    workingCopy: null,
    parentChange: null,
    stack: null,
    stackReferenceCount: 0,
    stackOutgoingReferences: [],
    stackIncomingReferences: [],
  };
}

function upsertSeed(
  seeds: Map<string, JjReviewFileSeed>,
  key: string,
  hasWorkingCopyFile: boolean,
): JjReviewFileSeed {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = createSeed(key, hasWorkingCopyFile);
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

async function getWorkingCopyContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function buildReviewFileId(seed: JjReviewFileSeed): string {
  return [
    seed.path,
    seed.hasWorkingCopyFile ? "working" : "gone",
    seed.workingCopy?.displayPath ?? "",
    seed.parentChange?.displayPath ?? "",
    seed.stack?.displayPath ?? "",
  ].join("::");
}

function createReviewFile(seed: JjReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed),
    path: seed.path,
    hasWorkingCopyFile: seed.hasWorkingCopyFile,
    inWorkingCopy: seed.inWorkingCopy,
    inParentChange: seed.inParentChange,
    inStack: seed.inStack,
    workingCopy: seed.workingCopy,
    parentChange: seed.parentChange,
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
): Promise<ReviewWindowData> {
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
  const workingInspectionCache = new Map<string, Promise<{ isTooLarge: boolean; lines: number | null }>>();
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
    const [workingTarget, changedLines] = await Promise.all([
      inspectWorkingTarget(change.newPath),
      getCachedChangedLines(fromRevision, toRevision, change),
    ]);
    return {
      lines: workingTarget.lines,
      isTooLarge: workingTarget.isTooLarge
        || (changedLines != null && changedLines > LARGE_DIFF_MAX_CHANGED_LINES),
    };
  };

  for (const change of workingChanges) {
    const key = getChangeKey(change);
    const inspection = await inspectComparison(change, workingParent.commitId, workingCopy.commitId);
    const seed = upsertSeed(seeds, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
    seed.hasWorkingCopyFile = change.newPath != null;
    seed.inWorkingCopy = true;
    seed.workingCopy = toComparison(change, workingParent.commitId, workingCopy.commitId, inspection.isTooLarge);
    if (change.status === "added" && inspection.lines != null) {
      seed.workingCopy.additions = inspection.lines;
      seed.workingCopy.deletions = 0;
    }
  }

  for (const change of parentChanges) {
    const key = getChangeKey(change);
    const inspection = await inspectComparison(change, workingParent.parentIds[0]!, workingParent.commitId);
    const seed = upsertSeed(seeds, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
    seed.inParentChange = true;
    seed.parentChange = toComparison(change, workingParent.parentIds[0]!, workingParent.commitId, inspection.isTooLarge);
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
      const seed = upsertSeed(seeds, key, change.newPath != null && currentPathSet.has(normalizeJjPath(change.newPath)));
      seed.inStack = true;
      seed.stack = toComparison(change, forkPoint.commitId, workingCopy.commitId, inspection.isTooLarge);
      seed.stackReferenceCount = references.counts.get(key) ?? 0;
      seed.stackOutgoingReferences = references.outgoing.get(key) ?? [];
      seed.stackIncomingReferences = references.incoming.get(key) ?? [];
    }
  }

  if (seeds.size === 0) {
    for (const path of currentPaths) {
      const seed = createSeed(path, true);
      seed.inStack = true;
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

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string): Promise<ReviewWindowData> {
  const result = await pi.exec("jj", ["--no-pager", "--color=never", "root"], { cwd });
  const repoRoot = result.stdout.trim();
  if (result.code !== 0 || repoRoot.length === 0) {
    throw new Error("Not inside a Jujutsu workspace.");
  }
  return buildReviewWindowData(pi, repoRoot);
}

export async function loadReviewFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: ReviewFile,
  scope: ReviewScope,
): Promise<ReviewFileContents> {
  const comparison = scope === "working-copy" ? file.workingCopy : scope === "parent-change" ? file.parentChange : file.stack;
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
