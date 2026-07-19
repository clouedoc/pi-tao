import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { buildStructuredDiff } from "../diff.js";
import type { DiffReviewComment, ReviewChange, ReviewFile, ReviewState } from "../types.js";
import { alignHeaderColumns, buildCommentPanelEmptyStateLines, buildCommentPanelTextLines, buildDisplayRows, buildEditorLaunchCommand, buildFooterLines, buildHelpPanelLines, buildSideBySideDisplayRows, filterReviewChanges, formatFocusStatus, formatPaneTitle, formatReviewChangeRange, formatReviewChangeSummary, formatSelectedLineTargetLabel, getCancelAction, getDraftCommentCount, getEditorLineForTarget, getHalfPageStep, getPaneLayout, getRelatedFileMarker, getRelatedFilePaths, getSideBySidePairedLineTarget, getStackedPaneLayout, parseMouseWheelInput, renderCenteredOverlay, renderReviewChangeId, shouldStackPanes } from "../ui/review-app.js";

function makeFile(path: string, flags?: Partial<ReviewFile>): ReviewFile {
  return {
    id: path,
    path,
    hasWorkingCopyFile: true,
    inChange: false,
    inStack: true,
    change: null,
    stack: null,
    ...flags,
  };
}

function makeState(draft?: Partial<ReviewState["draft"]>): ReviewState {
  return {
    activeScope: "change",
    activeFileId: "src/app.ts",
    searchQuery: "",
    focus: "diff",
    wrapLines: false,
    hideUnchanged: false,
    selectedCommentIndex: 0,
    selectedLineTargetByScopeFile: {},
    draft: {
      allComment: "",
      allIntent: "fix",
      comments: [],
      ...draft,
    },
  };
}

const lineComment: DiffReviewComment = {
  id: "line:change:src/app.ts:added:2",
  fileId: "src/app.ts",
  scope: "change",
  side: "added",
  intent: "fix",
  startLine: 2,
  endLine: 2,
  body: "Rename this.",
};

describe("buildDisplayRows", () => {
  it("keeps deleted and added rows independently commentable when line numbers overlap", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    const rowsAtLineTwo = buildDisplayRows(diff).filter((row) => row.displayLineNumber === 2);

    expect(rowsAtLineTwo).toHaveLength(2);
    expect(rowsAtLineTwo.map((row) => ({ kind: row.kind, commentLineNumber: row.commentLineNumber, commentSide: row.commentSide }))).toEqual([
      { kind: "removed", commentLineNumber: 2, commentSide: "deleted" },
      { kind: "context", commentLineNumber: 2, commentSide: "added" },
    ]);
  });
});

describe("side-by-side diff helpers", () => {
  it("pairs replacement rows into old and new cells", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    const rows = buildSideBySideDisplayRows(diff);
    const replacement = rows.find((row) => row.kind === "change" && row.oldCell?.text === "old value");

    expect(replacement?.oldCell).toMatchObject({ side: "deleted", lineNumber: 2, text: "old value" });
    expect(replacement?.newCell).toMatchObject({ side: "added", lineNumber: 2, text: "new value" });
  });

  it("finds the paired side for replacement selections", () => {
    const diff = buildStructuredDiff(
      ["alpha", "old value", "omega"].join("\n") + "\n",
      ["alpha", "new value", "omega"].join("\n") + "\n",
      3,
    );

    expect(getSideBySidePairedLineTarget(diff, { side: "deleted", line: 2 })).toEqual({ side: "added", line: 2 });
    expect(getSideBySidePairedLineTarget(diff, { side: "added", line: 2 })).toEqual({ side: "deleted", line: 2 });
  });

  it("describes the selected side and range", () => {
    expect(formatSelectedLineTargetLabel({ side: "deleted", line: 4 })).toBe("selected deleted line 4");
    expect(formatSelectedLineTargetLabel({ side: "added", line: 8, endLine: 10 })).toBe("selected added lines 8-10");
  });
});

describe("getEditorLineForTarget", () => {
  it("maps deleted lines to the nearest surviving change line", () => {
    const diff = buildStructuredDiff(
      ["alpha", "removed", "kept"].join("\n") + "\n",
      ["alpha", "kept"].join("\n") + "\n",
      3,
    );

    expect(getEditorLineForTarget(diff, { side: "deleted", line: 2 })).toBe(2);
  });
});

describe("getHalfPageStep", () => {
  it("uses at least one row and otherwise half the visible rows", () => {
    expect(getHalfPageStep(1)).toBe(1);
    expect(getHalfPageStep(9)).toBe(4);
    expect(getHalfPageStep(10)).toBe(5);
  });
});

describe("pane layout", () => {
  it("gives the diff pane the comments width when comments are hidden", () => {
    const shown = getPaneLayout(100, false);
    const hidden = getPaneLayout(100, true);

    expect(hidden.commentsWidth).toBe(0);
    expect(hidden.navigatorWidth).toBe(shown.navigatorWidth);
    expect(hidden.diffWidth).toBeGreaterThan(shown.diffWidth);
  });

  it("stacks panes below the desktop width breakpoint", () => {
    expect(shouldStackPanes(99)).toBe(true);
    expect(shouldStackPanes(100)).toBe(false);
  });

  it("allocates stacked pane heights with more room for the diff", () => {
    expect(getStackedPaneLayout(11, false)).toEqual({
      navigatorHeight: 3,
      diffHeight: 5,
      commentsHeight: 3,
    });

    expect(getStackedPaneLayout(9, true)).toEqual({
      navigatorHeight: 3,
      diffHeight: 6,
      commentsHeight: 0,
    });
  });
});

describe("review header", () => {
  it("right-aligns change details beside the tabs", () => {
    const header = alignHeaderColumns("1:Change  2:Stack", "abcd1234 Add parser", 40);

    expect(visibleWidth(header)).toBe(40);
    expect(header.endsWith("abcd1234 Add parser")).toBe(true);
  });

  it("shows an explicit label for an empty change description", () => {
    expect(formatReviewChangeSummary({
      changeId: "abcd1234more",
      changeIdPrefix: "a",
      commitId: "a".repeat(40),
      description: "",
      bookmarks: [],
      isWorkingCopy: false,
    })).toBe("abcd1234 (empty)");
  });

  it("uses dedicated colors for the important prefix and remaining change ID", () => {
    const theme = {
      fg(color: string, text: string) { return `<${color}>${text}</${color}>`; },
      bold(text: string) { return `<bold>${text}</bold>`; },
    };
    const change: ReviewChange = {
      changeId: "abcd1234more",
      changeIdPrefix: "ab",
      commitId: "a".repeat(40),
      description: "Change title",
      bookmarks: [],
      isWorkingCopy: false,
    };

    expect(renderReviewChangeId(theme as any, change)).toBe("<bold><accent>ab</accent></bold><syntaxVariable>cd1234</syntaxVariable>");
  });

  it("keeps both change IDs and titles in a constrained stack range", () => {
    const summary = formatReviewChangeRange({
      start: { changeId: "start123more", changeIdPrefix: "s", commitId: "a".repeat(40), description: "Start change title", bookmarks: [], isWorkingCopy: false },
      end: { changeId: "end45678more", changeIdPrefix: "e", commitId: "b".repeat(40), description: "End change title", bookmarks: [], isWorkingCopy: true },
    }, 40);

    expect(visibleWidth(summary)).toBeLessThanOrEqual(40);
    expect(summary).toContain("start123 Start");
    expect(summary).toContain("end45678 End");
  });
});

describe("change picker", () => {
  const changes: ReviewChange[] = [
    { changeId: "wxyz1234", changeIdPrefix: "w", commitId: "a".repeat(40), description: "add parser", bookmarks: ["feature"], isWorkingCopy: true },
    { changeId: "abcd5678", changeIdPrefix: "a", commitId: "b".repeat(40), description: "update docs", bookmarks: [], isWorkingCopy: false },
  ];

  it("filters changes by IDs, bookmarks, and description", () => {
    expect(filterReviewChanges(changes, "feature")).toEqual([changes[0]]);
    expect(filterReviewChanges(changes, "BBBB")).toEqual([changes[1]]);
    expect(filterReviewChanges(changes, "docs")).toEqual([changes[1]]);
    expect(filterReviewChanges(changes, "")).toEqual(changes);
  });
});

describe("related navigator helpers", () => {
  it("marks incoming, outgoing, and bidirectional related files", () => {
    const active = makeFile("src/active.ts", {
      stackOutgoingReferences: ["src/out.ts", "src/both.ts"],
      stackIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect(getRelatedFileMarker(makeFile("src/out.ts"), active, "stack")).toBe("→");
    expect(getRelatedFileMarker(makeFile("src/in.ts"), active, "stack")).toBe("←");
    expect(getRelatedFileMarker(makeFile("src/both.ts"), active, "stack")).toBe("↔");
    expect(getRelatedFileMarker(makeFile("src/other.ts"), active, "stack")).toBeNull();
  });

  it("combines incoming and outgoing related file paths", () => {
    const active = makeFile("src/active.ts", {
      stackOutgoingReferences: ["src/out.ts", "src/both.ts"],
      stackIncomingReferences: ["src/in.ts", "src/both.ts"],
    });

    expect([...getRelatedFilePaths(active)].sort()).toEqual(["src/both.ts", "src/in.ts", "src/out.ts"]);
  });
});

describe("parseMouseWheelInput", () => {
  it("parses SGR mouse wheel events", () => {
    expect(parseMouseWheelInput("\x1b[<64;10;5M")).toEqual({ direction: "up", col: 10, row: 5 });
    expect(parseMouseWheelInput("\x1b[<65;10;5M")).toEqual({ direction: "down", col: 10, row: 5 });
  });

  it("ignores non-wheel mouse events", () => {
    expect(parseMouseWheelInput("\x1b[<0;10;5M")).toBeNull();
  });
});

describe("cancel helpers", () => {
  it("counts scoped comments and the review-wide note", () => {
    expect(getDraftCommentCount(makeState())).toBe(0);
    expect(getDraftCommentCount(makeState({ comments: [lineComment] }))).toBe(1);
    expect(getDraftCommentCount(makeState({ allComment: "Explain the diff.", comments: [lineComment] }))).toBe(2);
  });

  it("confirms cancellation when draft feedback exists", () => {
    expect(getCancelAction(makeState())).toBe("cancel");
    expect(getCancelAction(makeState({ comments: [lineComment] }))).toBe("confirm");
  });
});

describe("renderCenteredOverlay", () => {
  it("draws a centered overlay without replacing the background outside the popup", () => {
    const base = [
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
      ".......",
    ];
    const overlay = [
      "+-+",
      "|x|",
      "+-+",
    ];

    expect(renderCenteredOverlay(base, overlay, 7, 7)).toEqual([
      ".......",
      ".......",
      "..+-+..",
      "..|x|..",
      "..+-+..",
      ".......",
      ".......",
    ]);
  });
});

describe("buildEditorLaunchCommand", () => {
  it("opens the requested file and line with shell-safe quoting", () => {
    expect(buildEditorLaunchCommand("nvim", "/tmp/a b's.ts", 12)).toBe("nvim +12 -- '/tmp/a b'\\''s.ts'");
  });

  it("falls back to vi and clamps invalid line numbers", () => {
    expect(buildEditorLaunchCommand(" ", "/tmp/file.ts", 0)).toBe("vi +1 -- '/tmp/file.ts'");
  });
});

const plainTheme = {
  fg(_color: string, text: string) { return text; },
  bg(_color: string, text: string) { return text; },
};

describe("focused panel feedback", () => {
  it("marks the active panel title explicitly", () => {
    expect(formatPaneTitle("Navigator", true)).toBe("▶ Navigator");
    expect(formatPaneTitle("Diff (2 hunks)", true)).toBe("▶ Diff (2 hunks)");
    expect(formatPaneTitle("Comments", false)).toBe("Comments");
  });

  it("describes the current focus in the status footer", () => {
    expect(formatFocusStatus("navigator")).toBe("Focus: Navigator");
    expect(formatFocusStatus("diff")).toBe("Focus: Diff");
    expect(formatFocusStatus("comments")).toBe("Focus: Comments");
  });
});

describe("action and shortcut help rendering", () => {
  it("keeps the persistent footer concise and panel-scoped", () => {
    const lines = buildFooterLines(plainTheme as any, "Tab focus • / search • ? help • 1/2 scopes • h hide comments • o open in $EDITOR • s submit • Esc exit", 80);

    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("navigator:");
    expect(lines[1]).not.toContain("diff:");
    expect(lines[1]).not.toContain("comments:");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("wraps full help text to the comments sidebar width", () => {
    const lines = buildHelpPanelLines(plainTheme as any, 24, [
      { id: "explain-added", key: "e", label: "explain", intent: "discuss", side: "added", text: "Explain what this code is doing." },
    ], "/home/user/.pi/agent/extensions/slopchop.json");

    expect(lines).toContain("Navigation");
    expect(lines).toContain("Diff actions");
    expect(lines.some((line) => line.includes("navigator: ↑↓/j/k files") && line.includes("diff:"))).toBe(false);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("wraps comments-panel guidance to the comments width", () => {
    const lines = buildCommentPanelEmptyStateLines(plainTheme as any, 24);

    expect(lines.join(" ")).toContain("Use f/d/c");
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });

  it("accounts for comment preview indentation when wrapping", () => {
    const lines = buildCommentPanelTextLines(plainTheme as any, 24, "This preview wraps within the comments panel content area.", "muted", "   ", 3);

    expect(lines.length).toBe(3);
    expect(lines.every((line) => line.startsWith("   "))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
  });
});
