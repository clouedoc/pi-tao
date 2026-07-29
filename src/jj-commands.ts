import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

let defaultWorkspaceRoot: string | undefined;

export function getDefaultWorkspaceRoot(): string | undefined {
  return defaultWorkspaceRoot;
}

async function getDirectoryCompletions(argumentPrefix: string) {
  const lastSlash = argumentPrefix.lastIndexOf("/");
  const directoryPrefix = lastSlash === -1 ? "" : argumentPrefix.slice(0, lastSlash + 1);
  const namePrefix = argumentPrefix.slice(lastSlash + 1);

  try {
    const entries = await readdir(resolve(process.cwd(), directoryPrefix || "."), { withFileTypes: true });
    const names = [
      ...["./", "../"].filter((name) => name.startsWith(namePrefix)),
      ...entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(namePrefix))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => `${entry.name}/`),
    ];

    if (names.length === 0) return null;
    return names.map((name) => ({
      value: `${directoryPrefix}${name}`,
      label: `${directoryPrefix}${name}`,
      description: "directory",
    }));
  } catch {
    return null;
  }
}

async function readWorkspaceRoot(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string | null> {
  const cwd = defaultWorkspaceRoot ?? ctx.cwd;
  const root = await pi.exec("jj", ["root"], { cwd });
  if (root.code !== 0) {
    ctx.ui.notify(`${cwd} is not inside a Jujutsu workspace`, "warning");
    return null;
  }
  return root.stdout.trim();
}

async function handleJjCdCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const path = args.trim();
  if (!path) {
    ctx.ui.notify("Usage: /jj:cd <path>", "warning");
    return;
  }

  const candidateRoot = resolve(ctx.cwd, path);
  const root = await pi.exec("jj", ["root"], { cwd: candidateRoot });
  if (root.code !== 0) {
    ctx.ui.notify(`${candidateRoot} is not inside a Jujutsu workspace`, "warning");
    return;
  }

  defaultWorkspaceRoot = root.stdout.trim();
  ctx.ui.notify(`Default workspace set to ${defaultWorkspaceRoot}`, "info");
}

async function handleJjCwdCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (args.trim()) {
    ctx.ui.notify("/jj:cwd takes no arguments", "warning");
    return;
  }

  const root = await readWorkspaceRoot(pi, ctx);
  if (root) ctx.ui.notify(root, "info");
}

async function handleJjDescribeCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (args.trim()) {
    ctx.ui.notify("/jj:describe takes no arguments", "warning");
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("/jj:describe requires Pi's interactive TUI", "warning");
    return;
  }

  await ctx.waitForIdle();

  const root = await readWorkspaceRoot(pi, ctx);
  if (!root) return;

  let commandError: Error | undefined;
  const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
    tui.stop();
    process.stdout.write("\x1b[2J\x1b[H");

    let status: number | null = null;
    try {
      const result = spawnSync("jj", ["describe"], { cwd: root, stdio: "inherit" });
      commandError = result.error;
      status = result.status;
    } catch (error) {
      commandError = error instanceof Error ? error : new Error(String(error));
    } finally {
      tui.start();
      tui.requestRender(true);
    }

    done(status);
    return { render: () => [], invalidate: () => {} };
  });

  if (commandError) {
    ctx.ui.notify(`Failed to run jj describe: ${commandError.message}`, "error");
  } else if (exitCode !== 0) {
    ctx.ui.notify(`jj describe exited with code ${exitCode}`, "error");
  }
}

async function handleJjCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (args.trim()) {
    ctx.ui.notify("/jj takes no arguments; its task comes from the current change description", "warning");
    return;
  }

  const root = await readWorkspaceRoot(pi, ctx);
  if (!root) return;

  const changeId = await pi.exec("jj", ["log", "--no-graph", "-r", "@", "-T", "change_id"], { cwd: root });
  if (changeId.code !== 0) {
    ctx.ui.notify(changeId.stderr.trim() || "Could not read the current jj change ID", "error");
    return;
  }

  const description = await pi.exec("jj", ["log", "--no-graph", "-r", "@", "-T", "description"], { cwd: root });
  if (description.code !== 0) {
    ctx.ui.notify(description.stderr.trim() || "Could not read the current jj change description", "error");
    return;
  }

  if (!description.stdout.trim()) {
    ctx.ui.notify("The current jj change has no description", "warning");
    return;
  }

  const message = {
    customType: "jj-task",
    content: `Implement the task described by the current Jujutsu change.

The current change ID at the start of the task is: ${changeId.stdout.trim()}
The repository root for this task is: ${root}

<jj-change-description>
${description.stdout.trim()}
</jj-change-description>

Follow this protocol:

- Treat the change description as the complete task specification, subject to system instructions and repository guidance.
- Inspect the repository, \`jj status\`, and the existing \`jj diff\` before editing.
- Implement all and only the requested changes. Do not perform unrelated cleanup, refactoring, or feature work.
- Preserve existing work in the change when it is consistent with the description. If it is inconsistent, or if the specification is materially ambiguous, stop and ask the user before proceeding.
- Do not change the jj description or create, abandon, squash, rebase, or otherwise reorganize jj changes.
- Run the relevant automated verification required by the repository.
- Before finishing, review \`jj diff\` and verify that the current change ID is still ${changeId.stdout.trim()}.
- Report the implementation and verification results concisely.`,
    display: true,
  };

  if (!ctx.isIdle()) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    ctx.ui.notify("Queued /jj for after the current agent run", "info");
    return;
  }

  pi.sendMessage(message, { triggerTurn: true });
}

export function registerJjCommands(pi: ExtensionAPI): void {
  pi.registerCommand("jj", {
    description: "Implement the task in the current jj change description",
    handler: (args: string, ctx: ExtensionCommandContext) => handleJjCommand(args, ctx, pi),
  });

  pi.registerCommand("jj:describe", {
    description: "Edit the current jj change description in your editor",
    handler: (args: string, ctx: ExtensionCommandContext) => handleJjDescribeCommand(args, ctx, pi),
  });

  pi.registerCommand("jj:cd", {
    description: "Set the default Jujutsu workspace used by /jj:diff and /jj",
    getArgumentCompletions: getDirectoryCompletions,
    handler: (args: string, ctx: ExtensionCommandContext) => handleJjCdCommand(args, ctx, pi),
  });

  pi.registerCommand("jj:cwd", {
    description: "Show the default Jujutsu workspace used by /jj:diff and /jj",
    handler: (args: string, ctx: ExtensionCommandContext) => handleJjCwdCommand(args, ctx, pi),
  });
}
