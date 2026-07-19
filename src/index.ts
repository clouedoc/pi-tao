import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData, loadReviewFileContents } from "./jj.js";
import { composeReviewPrompt } from "./prompt.js";
import { loadCommentShortcuts } from "./shortcuts.js";
import { runReviewApp } from "./ui/review-app.js";

export default function slopReviewExtension(pi: ExtensionAPI) {
  let activeReview = false;

  function notifyShortcutWarnings(ctx: ExtensionContext, warnings: string[]): void {
    if (warnings.length === 0 || !ctx.hasUI) return;
    ctx.ui.notify(`slopchop config: ${warnings.join(" ")}`, "warning");
  }

  async function openReview(ctx: ExtensionContext, args: string): Promise<void> {
    if (activeReview) {
      ctx.ui.notify("A review session is already open.", "warning");
      return;
    }

    activeReview = true;
    try {
      const requestedRoot = args.trim();
      const reviewCwd = requestedRoot.length === 0 ? ctx.cwd : resolve(ctx.cwd, requestedRoot);
      const { repoRoot, files, changes, selectedChange, stackRange } = await getReviewWindowData(pi, reviewCwd);
      const shortcutConfig = loadCommentShortcuts();
      if (files.length === 0 && changes.length === 0) {
        ctx.ui.notify("No reviewable changes found in this Jujutsu workspace.", "info");
        return;
      }

      notifyShortcutWarnings(ctx, shortcutConfig.warnings);

      const { result, files: submittedFiles } = await runReviewApp(ctx, {
        files,
        repoRoot,
        changes,
        selectedChange,
        stackRange,
        loadFileContents: (activeRepoRoot, file, scope) => loadReviewFileContents(pi, activeRepoRoot, file, scope),
        loadChange: (revision) => getReviewWindowData(pi, repoRoot, revision),
        commentShortcuts: shortcutConfig.shortcuts,
      });

      if (result.type === "cancel") {
        ctx.ui.notify("Review cancelled.", "info");
        return;
      }

      ctx.ui.setEditorText(composeReviewPrompt(submittedFiles, result));
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not open review UI: ${message}`, "error");
    } finally {
      activeReview = false;
    }
  }

  const reviewCommand = {
    description: "Review and annotate changes in the current or specified Jujutsu workspace",
    handler: async (args: string, ctx: ExtensionContext) => {
      await openReview(ctx, args);
    },
  };

  pi.registerCommand("diff", reviewCommand);

  pi.on("session_shutdown", async () => {
    activeReview = false;
  });
}
