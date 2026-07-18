import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCommentShortcuts: vi.fn(),
  getReviewWindowData: vi.fn(),
  loadReviewFileContents: vi.fn(),
  composeReviewPrompt: vi.fn(),
  runReviewApp: vi.fn(),
}));

vi.mock("../shortcuts.js", () => ({
  loadCommentShortcuts: mocks.loadCommentShortcuts,
}));

vi.mock("../jj.js", () => ({
  getReviewWindowData: mocks.getReviewWindowData,
  loadReviewFileContents: mocks.loadReviewFileContents,
}));

vi.mock("../prompt.js", () => ({
  composeReviewPrompt: mocks.composeReviewPrompt,
}));

vi.mock("../ui/review-app.js", () => ({
  runReviewApp: mocks.runReviewApp,
}));

const { default: slopReviewExtension } = await import("../index.js");

describe("slop review extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCommentShortcuts.mockReturnValue({
      shortcuts: [],
      warnings: ["bad shortcut config"],
      path: "/tmp/slopchop.json",
    });
  });

  it("registers only /diff and opens the Jujutsu review", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify: ReturnType<typeof vi.fn>; setEditorText: ReturnType<typeof vi.fn> } }) => Promise<void> }>();
    const pi = {
      registerCommand: vi.fn((name: string, command) => commands.set(name, command)),
      registerShortcut: vi.fn(),
      on: vi.fn(),
    };
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      ui: {
        notify: vi.fn(),
        setEditorText: vi.fn(),
      },
    };
    const files = [{ id: "README.md", path: "README.md" }];
    const result = { type: "submit", allComment: "Review this.", allIntent: "fix", comments: [] };
    mocks.getReviewWindowData.mockResolvedValue({ repoRoot: "/repo", files });
    mocks.runReviewApp.mockResolvedValue({ result, files });
    mocks.composeReviewPrompt.mockReturnValue("prompt body");

    slopReviewExtension(pi as never);

    expect([...commands]).toEqual([["diff", expect.any(Object)]]);
    expect(pi.registerShortcut).not.toHaveBeenCalled();

    await commands.get("diff")?.handler("", ctx);

    expect(mocks.getReviewWindowData).toHaveBeenCalledWith(pi, "/repo");
    expect(mocks.runReviewApp).toHaveBeenCalledWith(ctx, expect.objectContaining({
      repoRoot: "/repo",
      files,
      commentShortcuts: [],
    }));
    expect(mocks.composeReviewPrompt).toHaveBeenCalledWith(files, result);
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith("prompt body");
    expect(ctx.ui.notify).toHaveBeenCalledWith("slopchop config: bad shortcut config", "warning");
  });
});
