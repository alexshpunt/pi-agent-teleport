import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";


import { createManagedWorktree, readState, reconcileState, removeManagedWorktree, writeState } from "./core.ts";

function dataDir(sessionId: string): string { return join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? homedir(), ".pi", "agent"), "teleport", sessionId); }
function serialize(ctx: ExtensionCommandContext, target: string): { source: string; destination: string } {
  const source = ctx.sessionManager.getSessionFile();
  const header = ctx.sessionManager.getHeader();
  if (!source || !header) throw new Error("Teleport requires a persisted Pi session.");
  if (!existsSync(target)) throw new Error(`Directory does not exist: ${target}`);
  const manager = SessionManager.create(target, undefined, { id: header.id });
  const destination = manager.getSessionFile();
  if (!destination) throw new Error("Pi did not create a destination session.");
  const nextHeader = { ...structuredClone(header), cwd: target };
  writeFileSync(destination, `${[nextHeader, ...structuredClone(ctx.sessionManager.getEntries())].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  return { source, destination };
}
function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function herdr(args: string[]): any {
  const output = execFileSync("herdr", args, { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : {};
}
async function waitForDestination(pane: string, session: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = herdr(["pane", "process-info", "--pane", pane])?.result?.process_info;
    if (info?.foreground_processes?.some((p: any) => Array.isArray(p.argv) && p.argv.includes(session))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out confirming the destination Pi process.");
}
async function scheduleSourceCleanup(pi: ExtensionAPI, sessionFile: string, tabId: string): Promise<void> {
  const cleanup = [
    `old_pid=${process.pid}`,
    `old_session=${quote(sessionFile)}`,
    `old_tab=${quote(tabId)}`,
    'i=0',
    'while kill -0 "$old_pid" 2>/dev/null && [ "$i" -lt 600 ]; do i=$((i + 1)); sleep 0.1; done',
    'rm -f -- "$old_session"',
    'herdr tab close "$old_tab" >/dev/null 2>&1 || true',
  ].join('; ');
  const launcher = `if command -v setsid >/dev/null 2>&1; then setsid sh -c ${quote(cleanup)} >/dev/null 2>&1 < /dev/null & else nohup sh -c ${quote(cleanup)} >/dev/null 2>&1 < /dev/null & fi`;
  const result = await pi.exec('sh', ['-lc', launcher], { timeout: 5_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Failed to schedule source cleanup.');
}

export default function teleport(pi: ExtensionAPI) {
  let sessionId = "unknown";
  let dir = dataDir(sessionId);
  const notify = (ctx: ExtensionCommandContext, text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);

  async function jump(ctx: ExtensionCommandContext, rawTarget: string) {
    const sourceCwd = ctx.cwd;
    const target = resolve(ctx.cwd, rawTarget);
    const { source, destination } = serialize(ctx, target);
    let state = readState(dir);
    state.transition = { id: randomUUID(), phase: "prepared", from: sourceCwd, to: target, sourceSession: source, destinationSession: destination, startedAt: Date.now() };
    writeState(dir, state);

    if (process.env.HERDR_ENV === "1" && process.env.HERDR_TAB_ID && process.env.HERDR_WORKSPACE_ID) {
      const created = herdr(["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID, "--label", `Teleport: ${target.split("/").at(-1)}`, "--cwd", target, "--no-focus"]);
      const pane = created?.result?.root_pane?.pane_id;
      const tab = created?.result?.tab?.tab_id ?? created?.result?.root_pane?.tab_id;
      if (!pane || !tab) throw new Error("Herdr did not return a destination pane and tab.");
      try {
        const continuation = Buffer.from(`Agent teleported: ${sourceCwd} → ${target}. Continue the original task from the destination. Do not repeat the teleport request.`, "utf8").toString("base64url");
        herdr(["pane", "run", pane, `PI_TELEPORT_CONTINUATION=${quote(continuation)} pi --session ${quote(destination)}`]);
        await waitForDestination(pane, destination);
        state = readState(dir);
        state.active = { cwd: target, sessionFile: destination };
        state.history.push({ from: sourceCwd, to: target, at: Date.now(), status: "completed" });
        delete state.transition;
        writeState(dir, state);
        await scheduleSourceCleanup(pi, source, process.env.HERDR_TAB_ID);
        herdr(["workspace", "focus", process.env.HERDR_WORKSPACE_ID]);
        ctx.shutdown();
      } catch (error) {
        try { herdr(["tab", "close", tab]); } catch {}
        rmSync(destination, { force: true });
        state = readState(dir); delete state.transition; writeState(dir, state);
        throw error;
      }
      return;
    }

    let started = false;
    const result = await ctx.switchSession(destination, { withSession: async (next) => {
      started = true;
      const current = readState(dir);
      current.active = { cwd: target, sessionFile: destination };
      current.history.push({ from: sourceCwd, to: target, at: Date.now(), status: "completed" });
      delete current.transition;
      writeState(dir, current);
      rmSync(source, { force: true });
      next.ui.notify(`✦ Agent teleported: ${sourceCwd} → ${target}`, "info");
      await next.sendMessage({
        customType: "pi-agent-teleport-continuation",
        content: `Agent teleported: ${sourceCwd} → ${target}. Continue the original task from the destination. Do not repeat the teleport request.`,
        display: false,
      }, { triggerTurn: true });
    }});
    if (result.cancelled || !started) { rmSync(destination, { force: true }); state = readState(dir); delete state.transition; writeState(dir, state); throw new Error("Teleport was cancelled."); }
  }

  type PendingOperation = { action: "jump" | "back"; target?: string };
  const pending = new Map<string, PendingOperation>();

  // Pi exposes session replacement only to command contexts. This command is an
  // internal one-shot transport for the agent tool and is not a public API.
  pi.registerCommand("__teleport_internal", {
    async handler(token, ctx) {
      const operation = pending.get(token);
      pending.delete(token);
      if (!operation) return;
      try {
        if (operation.action === "jump") {
          if (!operation.target) throw new Error("A target directory is required.");
          await jump(ctx, operation.target);
        } else {
          const previous = readState(dir).history.at(-1)?.from;
          if (!previous) throw new Error("Teleport history is empty.");
          await jump(ctx, previous);
        }
      } catch (error) {
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "teleport",
    label: "Teleport",
    description: "Move this persisted Pi session, manage Teleport-owned worktrees, or inspect movement history.",
    parameters: Type.Object({
      action: StringEnum(["jump", "back", "history", "create", "remove"] as const),
      target: Type.Optional(Type.String()),
      branch: Type.Optional(Type.String()),
      base: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      resourceId: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.action === "history") {
        const history = readState(dir).history;
        return { content: [{ type: "text" as const, text: history.length ? history.map((entry) => `${entry.from} → ${entry.to}`).join("\n") : "Teleport history is empty." }], details: { history } };
      }
      if (params.action === "create") {
        if (!params.branch) throw new Error("A branch is required.");
        const resource = createManagedWorktree({ repo: ctx.cwd, branch: params.branch, base: params.base, path: params.path, stateDir: dir });
        return { content: [{ type: "text" as const, text: `Created ${resource.path}\nResource: ${resource.id}` }], details: { resource } };
      }
      if (params.action === "remove") {
        if (!params.resourceId) throw new Error("A resourceId is required.");
        removeManagedWorktree({ repo: ctx.cwd, id: params.resourceId, stateDir: dir });
        return { content: [{ type: "text" as const, text: `Removed managed worktree ${params.resourceId}.` }], details: { resourceId: params.resourceId } };
      }
      if (params.action === "jump" && !params.target) throw new Error("A target directory is required.");
      const token = randomUUID();
      pending.set(token, { action: params.action, target: params.target });
      pi.sendUserMessage(`/__teleport_internal ${token}`, { deliverAs: "followUp", expandPromptTemplates: true });
      return {
        content: [{ type: "text" as const, text: params.action === "jump" ? `✦ Agent teleport queued: ${ctx.cwd} → ${resolve(ctx.cwd, params.target!)}` : `✦ Agent teleport queued: ${ctx.cwd} → previous location` }],
        details: { action: params.action, target: params.target },
        terminate: true,
      };
    },
    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold("✦ Agent teleport"));
      if (args.action === "jump" && args.target) {
        const target = resolve(context.cwd, args.target);
        const completed = readState(dir).history.findLast((entry) => resolve(entry.to) === target);
        const source = resolve(context.cwd) === target && completed ? completed.from : context.cwd;
        component.setText(`${title}\n  ${theme.fg("muted", source)}\n  ${theme.fg("accent", "└─→")} ${theme.fg("success", target)}`);
      } else if (args.action === "back") {
        component.setText(`${title} ${theme.fg("accent", "←")} ${theme.fg("muted", "previous location")}`);
      } else if (args.action === "create") {
        component.setText(`${title} ${theme.fg("accent", "+ worktree")} ${theme.fg("muted", args.branch ?? "branch required")}`);
      } else if (args.action === "remove") {
        component.setText(`${title} ${theme.fg("warning", "− worktree")} ${theme.fg("muted", args.resourceId ?? "resource required")}`);
      } else {
        component.setText(`${title} ${theme.fg("muted", "history")}`);
      }
      return component;
    },
    renderResult(result, options, theme) {
      if (options.isPartial) return new Text(theme.fg("warning", "  ◌ preparing destination…"), 0, 0);
      const text = result.content?.find((item) => item.type === "text")?.text ?? "";
      if (!text) return new Text("", 0, 0);
      const details = result.details as { action?: string } | undefined;
      const prefix = details?.action === "jump" || details?.action === "back"
        ? theme.fg("success", "  ✓ handoff prepared")
        : theme.fg("success", "  ✓");
      return new Text(`${prefix} ${theme.fg("toolOutput", text)}`, 0, 0);
    },
  });
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    dir = dataDir(sessionId);
    const state = reconcileState(dir);
    const file = ctx.sessionManager.getSessionFile();
    if (file) {
      state.active = { cwd: ctx.cwd, sessionFile: file };
      writeState(dir, state);
    }
    const encodedContinuation = process.env.PI_TELEPORT_CONTINUATION;
    if (encodedContinuation) {
      delete process.env.PI_TELEPORT_CONTINUATION;
      pi.sendMessage({
        customType: "pi-agent-teleport-continuation",
        content: Buffer.from(encodedContinuation, "base64url").toString("utf8"),
        display: false,
      }, { triggerTurn: true });
    }
  });
}
