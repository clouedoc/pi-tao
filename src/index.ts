import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDefaultWorkspaceRoot, registerJjCommands } from "./jj-commands.js";
import { getReviewWindowData, loadReviewFileContents } from "./jj.js";
import { composeReviewPrompt } from "./prompt.js";
import { loadCommentShortcuts } from "./shortcuts.js";
import { runReviewApp } from "./ui/review-app.js";

export default function slopReviewExtension(pi: ExtensionAPI) {
  let activeReview = false;

  function notifyShortcutWarnings(ctx: ExtensionContext, warnings: string[]): void {
    if (warnings.length === 0 || !ctx.hasUI) return;
    ctx.ui.notify(`tao config: ${warnings.join(" ")}`, "warning");
  }

  async function openReview(ctx: ExtensionContext, args: string): Promise<void> {
    if (activeReview) {
      ctx.ui.notify("A review session is already open.", "warning");
      return;
    }

    activeReview = true;
    try {
      const commandArgs = args.trim();
      let reviewCwd = getDefaultWorkspaceRoot() ?? ctx.cwd;
      let revision: string | undefined;
      if (commandArgs.length > 0) {
        const candidateRoot = resolve(ctx.cwd, commandArgs);
        const pathAndRevision = commandArgs.match(/^(.*\S)\s+(\S+)$/);
        if (existsSync(candidateRoot) && statSync(candidateRoot).isDirectory()) {
          reviewCwd = candidateRoot;
        } else if (pathAndRevision != null) {
          reviewCwd = resolve(ctx.cwd, pathAndRevision[1]!);
          revision = pathAndRevision[2]!;
        } else {
          revision = commandArgs;
        }
      }

      const reviewData = revision == null
        ? await getReviewWindowData(pi, reviewCwd)
        : await getReviewWindowData(pi, reviewCwd, revision);
      const { repoRoot, files, changes, selectedChange, stackRange } = reviewData;
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
    description: "Review and annotate a change in the current or specified Jujutsu workspace",
    handler: async (args: string, ctx: ExtensionContext) => {
      await openReview(ctx, args);
    },
  };

  pi.registerCommand("jj:diff", reviewCommand);
  registerJjCommands(pi);

  pi.on("session_shutdown", async () => {
    activeReview = false;
  });
}
