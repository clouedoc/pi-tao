export type ReviewScope = "change" | "stack";

export interface ReviewChange {
  commitId: string;
  changeId: string;
  changeIdPrefix: string;
  description: string;
  bookmarks: string[];
  isWorkingCopy: boolean;
}

export interface ReviewChangeRange {
  start: ReviewChange;
  end: ReviewChange;
}

export interface ReviewWindowData {
  repoRoot: string;
  files: ReviewFile[];
  changes: ReviewChange[];
  selectedChange: ReviewChange;
  stackRange: ReviewChangeRange | null;
}

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface ReviewFileComparison {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  additions?: number;
  deletions?: number;
  /** True when the diff is represented by a compact review placeholder. */
  isTooLarge?: boolean;
  /** Exact revisions used for the original and modified sides. */
  originalRevision?: string;
  modifiedRevision?: string;
}

export interface ReviewFile {
  id: string;
  path: string;
  hasWorkingCopyFile: boolean;
  inChange: boolean;
  inStack: boolean;
  change: ReviewFileComparison | null;
  stack: ReviewFileComparison | null;
  stackReferenceCount?: number;
  stackOutgoingReferences?: string[];
  stackIncomingReferences?: string[];
}

export interface ReviewFileContents {
  originalContent: string;
  modifiedContent: string;
}

export type CommentSide = "added" | "deleted" | "file";

export type CommentIntent = "fix" | "discuss";

export interface DiffReviewComment {
  id: string;
  fileId: string;
  scope: ReviewScope;
  side: CommentSide;
  intent: CommentIntent;
  startLine: number | null;
  endLine: number | null;
  body: string;
}

export interface ReviewDraft {
  allComment: string;
  allIntent: CommentIntent;
  comments: DiffReviewComment[];
}

export type ReviewFocus = "navigator" | "diff" | "comments";

export interface ReviewLineTarget {
  side: Exclude<CommentSide, "file">;
  /** Active cursor line for the selection. */
  line: number;
  /** Anchor line when the selection spans multiple diff lines. */
  endLine?: number;
}

export interface ReviewState {
  activeScope: ReviewScope;
  activeFileId: string | null;
  searchQuery: string;
  focus: ReviewFocus;
  wrapLines: boolean;
  hideUnchanged: boolean;
  selectedCommentIndex: number;
  selectedLineTargetByScopeFile: Record<string, ReviewLineTarget>;
  draft: ReviewDraft;
}

export interface ReviewSubmitPayload extends ReviewDraft {
  type: "submit";
}

export interface ReviewCancelPayload {
  type: "cancel";
}

export type ReviewResult = ReviewSubmitPayload | ReviewCancelPayload;

export function formatScopeLabel(scope: ReviewScope): string {
  return scope === "change" ? "Change" : "Stack";
}

export function scopeFileKey(scope: ReviewScope, fileId: string): string {
  return `${scope}::${fileId}`;
}

export function formatIntentLabel(intent: CommentIntent): string {
  switch (intent) {
    case "fix": return "FIX";
    case "discuss": return "DISCUSS";
  }
}

export function getReviewFileDisplayPath(file: ReviewFile | null | undefined, scope: ReviewScope): string {
  if (file == null) return "(no file)";
  const comparison = scope === "change" ? file.change : file.stack;
  return comparison?.displayPath ?? file.path;
}
