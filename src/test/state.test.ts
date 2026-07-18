import { describe, expect, it } from "vitest";
import {
  clampSelectedLineTarget,
  createInitialReviewState,
  extendSelectedLineTarget,
  getDefaultScope,
  getFileComment,
  getFilteredFiles,
  getLineComment,
  getScopedFiles,
  moveActiveFile,
  moveSelectedCommentIndex,
  moveSelectedLineTarget,
  setScope,
  setSearchQuery,
  upsertFileComment,
  upsertLineComment,
} from "../state.js";
import type { ReviewFile } from "../types.js";

function makeFile(path: string, flags?: Partial<ReviewFile>): ReviewFile {
  return {
    id: path,
    path,
    hasWorkingCopyFile: true,
    inWorkingCopy: true,
    inParentChange: false,
    inStack: false,
    workingCopy: null,
    parentChange: null,
    stack: null,
    ...flags,
  };
}

describe("review state", () => {
  it("picks the working copy as the default scope when available", () => {
    expect(getDefaultScope([
      makeFile("src/a.ts", { inWorkingCopy: true }),
      makeFile("src/b.ts", { inWorkingCopy: false, inParentChange: true }),
    ])).toBe("working-copy");
  });

  it("prefers the stack over the parent change when the working copy is empty", () => {
    expect(getDefaultScope([
      makeFile("src/a.ts", { inWorkingCopy: false, inStack: true }),
      makeFile("src/b.ts", { inWorkingCopy: false, inParentChange: true }),
    ])).toBe("stack");
  });

  it("orders stack changes by review priority", () => {
    const makeAllFile = (path: string, status: "modified" | "added" | "deleted", references = 0) => makeFile(path, {
      inWorkingCopy: false,
      inStack: true,
      stackReferenceCount: references,
      stack: {
        status,
        oldPath: status === "added" ? null : path,
        newPath: status === "deleted" ? null : path,
        displayPath: path,
      },
    });

    const files = [
      makeAllFile("docs/readme.md", "added"),
      makeAllFile("src/new.ts", "added"),
      makeAllFile("src/feature.ts", "modified"),
      makeAllFile("src/root.ts", "added", 2),
    ];

    expect(getScopedFiles(files, "stack").map((file) => file.path)).toEqual([
      "src/root.ts",
      "src/feature.ts",
      "src/new.ts",
      "docs/readme.md",
    ]);
  });

  it("switches scopes and keeps selection valid", () => {
    const files = [
      makeFile("src/a.ts", { inWorkingCopy: true, inParentChange: false }),
      makeFile("src/b.ts", { inWorkingCopy: false, inParentChange: true }),
    ];
    let state = createInitialReviewState(files);
    state = setScope(state, files, "parent-change");
    expect(state.activeFileId).toBe("src/b.ts");
  });

  it("enforces one line comment per file+scope+side+line", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = upsertLineComment(state, "src/a.ts", "working-copy", "added", 12, "First");
    state = upsertLineComment(state, "src/a.ts", "working-copy", "added", 12, "Second");
    state = upsertLineComment(state, "src/a.ts", "working-copy", "deleted", 12, "Removed note");

    expect(state.draft.comments).toHaveLength(2);
    expect(getLineComment(state, "src/a.ts", "working-copy", "added", 12)?.body).toBe("Second");
    expect(getLineComment(state, "src/a.ts", "working-copy", "added", 12)?.intent).toBe("fix");
    expect(getLineComment(state, "src/a.ts", "working-copy", "deleted", 12)?.body).toBe("Removed note");
  });

  it("supports line comment ranges", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = upsertLineComment(state, "src/a.ts", "working-copy", "added", 12, "Range note", "discuss", 14);

    expect(state.draft.comments).toHaveLength(1);
    expect(getLineComment(state, "src/a.ts", "working-copy", "added", 13)?.body).toBe("Range note");
    expect(state.draft.comments[0]).toMatchObject({ startLine: 12, endLine: 14, intent: "discuss" });
  });

  it("replaces overlapping line comment ranges", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = upsertLineComment(state, "src/a.ts", "working-copy", "added", 12, "Range note", "fix", 14);
    state = upsertLineComment(state, "src/a.ts", "working-copy", "added", 13, "Middle note");

    expect(state.draft.comments).toHaveLength(1);
    expect(state.draft.comments[0]).toMatchObject({ startLine: 13, endLine: 13, body: "Middle note" });
  });

  it("enforces one file comment per file+scope", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = upsertFileComment(state, "src/a.ts", "working-copy", "One", "discuss");
    state = upsertFileComment(state, "src/a.ts", "working-copy", "Two", "fix");

    expect(state.draft.comments).toHaveLength(1);
    expect(getFileComment(state, "src/a.ts", "working-copy")?.body).toBe("Two");
    expect(getFileComment(state, "src/a.ts", "working-copy")?.intent).toBe("fix");
  });

  it("filters files using search query", () => {
    const files = [makeFile("src/button.ts"), makeFile("src/input.ts")];
    let state = createInitialReviewState(files);
    state = setSearchQuery(state, files, "but");
    expect(getFilteredFiles(files, state).map((file) => file.path)).toEqual(["src/button.ts"]);
  });

  it("moves active file within filtered results", () => {
    const files = [makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")];
    let state = createInitialReviewState(files);
    state = moveActiveFile(state, files, 1);
    expect(state.activeFileId).toBe("src/b.ts");
  });

  it("clamps large file jumps to the list boundaries", () => {
    const files = [makeFile("src/a.ts"), makeFile("src/b.ts"), makeFile("src/c.ts")];
    let state = createInitialReviewState(files);
    state = moveActiveFile(state, files, 99);
    expect(state.activeFileId).toBe("src/c.ts");
    state = moveActiveFile(state, files, -99);
    expect(state.activeFileId).toBe("src/a.ts");
  });

  it("clamps selected line target to a visible target", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    state = clampSelectedLineTarget(state, "src/a.ts", "working-copy", [{ side: "deleted", line: 4 }, { side: "added", line: 8 }]);
    expect(state.selectedLineTargetByScopeFile["working-copy::src/a.ts"]).toEqual({ side: "deleted", line: 4 });
  });

  it("clamps large diff jumps to the visible boundaries", () => {
    const files = [makeFile("src/a.ts")];
    const visibleTargets = [{ side: "deleted" as const, line: 4 }, { side: "added" as const, line: 8 }, { side: "added" as const, line: 12 }];
    let state = createInitialReviewState(files);
    state = moveSelectedLineTarget(state, "src/a.ts", "working-copy", visibleTargets, 99);
    expect(state.selectedLineTargetByScopeFile["working-copy::src/a.ts"]).toEqual({ side: "added", line: 12 });
    state = moveSelectedLineTarget(state, "src/a.ts", "working-copy", visibleTargets, -99);
    expect(state.selectedLineTargetByScopeFile["working-copy::src/a.ts"]).toEqual({ side: "deleted", line: 4 });
  });

  it("extends selected line targets on the same side", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    const targets = [{ side: "added" as const, line: 10 }, { side: "deleted" as const, line: 10 }, { side: "added" as const, line: 11 }, { side: "added" as const, line: 12 }];
    state = extendSelectedLineTarget(state, "src/a.ts", "working-copy", targets, 1);
    state = extendSelectedLineTarget(state, "src/a.ts", "working-copy", targets, 1);

    expect(state.selectedLineTargetByScopeFile["working-copy::src/a.ts"]).toEqual({ side: "added", line: 12, endLine: 10 });
  });

  it("collapses range selection when no farther line exists on that side", () => {
    const files = [makeFile("src/a.ts")];
    let state = createInitialReviewState(files);
    const targets = [{ side: "added" as const, line: 10 }, { side: "added" as const, line: 11 }];
    state = extendSelectedLineTarget(state, "src/a.ts", "working-copy", targets, 1);
    state = extendSelectedLineTarget(state, "src/a.ts", "working-copy", targets, 1);

    expect(state.selectedLineTargetByScopeFile["working-copy::src/a.ts"]).toEqual({ side: "added", line: 10 });
  });

  it("clamps large comment jumps to the list boundaries", () => {
    let state = createInitialReviewState([makeFile("src/a.ts")]);
    state = moveSelectedCommentIndex(state, 3, 99);
    expect(state.selectedCommentIndex).toBe(2);
    state = moveSelectedCommentIndex(state, 3, -99);
    expect(state.selectedCommentIndex).toBe(0);
  });
});
