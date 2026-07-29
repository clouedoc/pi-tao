import { beforeEach, describe, expect, it, vi } from "vitest";

type Command = { handler: (args: string, ctx: never) => Promise<void> };

async function createPi(execResults: Record<string, { code: number; stdout: string; stderr: string }>) {
  vi.resetModules();
  const { getDefaultWorkspaceRoot, registerJjCommands } = await import("../jj-commands.js");

  const commands = new Map<string, Command>();
  const pi = {
    registerCommand: vi.fn((name: string, command: Command) => commands.set(name, command)),
    exec: vi.fn(async (_command: string, args: string[]) => {
      const key = args.includes("root") ? "root" : (args.at(-1) ?? "");
      return execResults[key] ?? { code: 1, stdout: "", stderr: `unexpected exec: ${args.join(" ")}` };
    }),
    sendMessage: vi.fn(),
  };
  registerJjCommands(pi as never);

  return { pi, commands, getDefaultWorkspaceRoot };
}

function createCtx() {
  return {
    cwd: "/repo",
    hasUI: true,
    isIdle: () => true,
    ui: { notify: vi.fn() },
  };
}

describe("jj commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets the default workspace with /jj-cd and reports it with /jj-cwd", async () => {
    const { pi, commands, getDefaultWorkspaceRoot } = await createPi({
      root: { code: 0, stdout: "/other-workspace\n", stderr: "" },
    });
    const ctx = createCtx();

    await commands.get("jj-cd")?.handler("../other-workspace", ctx as never);

    expect(pi.exec).toHaveBeenCalledWith("jj", ["root"], { cwd: "/other-workspace" });
    expect(getDefaultWorkspaceRoot()).toBe("/other-workspace");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Default workspace set to /other-workspace", "info");

    await commands.get("jj-cwd")?.handler("", ctx as never);

    expect(pi.exec).toHaveBeenLastCalledWith("jj", ["root"], { cwd: "/other-workspace" });
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("/other-workspace", "info");
  });

  it("keeps the default workspace unset when the path is not a Jujutsu workspace", async () => {
    const { commands, getDefaultWorkspaceRoot } = await createPi({ root: { code: 1, stdout: "", stderr: "no repo" } });
    const ctx = createCtx();

    await commands.get("jj-cd")?.handler("../not-a-workspace", ctx as never);

    expect(getDefaultWorkspaceRoot()).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("/not-a-workspace is not inside a Jujutsu workspace", "warning");
  });

  it("sends the current change description as a task with /jj", async () => {
    const { pi, commands } = await createPi({
      root: { code: 0, stdout: "/repo\n", stderr: "" },
      change_id: { code: 0, stdout: "abcdef\n", stderr: "" },
      description: { code: 0, stdout: "make it work\n", stderr: "" },
    });
    const ctx = createCtx();

    await commands.get("jj")?.handler("", ctx as never);

    const [message, options] = pi.sendMessage.mock.calls[0] ?? [];
    expect(options).toEqual({ triggerTurn: true });
    expect(message.customType).toBe("jj-task");
    expect(message.content).toContain("make it work");
    expect(message.content).toContain("abcdef");
  });

  it("refuses to run /jj when the current change has no description", async () => {
    const { pi, commands } = await createPi({
      root: { code: 0, stdout: "/repo\n", stderr: "" },
      change_id: { code: 0, stdout: "abcdef\n", stderr: "" },
      description: { code: 0, stdout: "\n", stderr: "" },
    });
    const ctx = createCtx();

    await commands.get("jj")?.handler("", ctx as never);

    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("The current jj change has no description", "warning");
  });
});
