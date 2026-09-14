import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";


import { createManagedWorktree, readState, reconcileState, removeManagedWorktree, writeState } from "./core.ts";
import { resolveWorktrunkTarget } from "./worktrunk.ts";

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
function herdr(args: string[]): any { return JSON.parse(execFileSync("herdr", args, { encoding: "utf8" })); }
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
    const target = resolve(ctx.cwd, rawTarget);
    const { source, destination } = serialize(ctx, target);
    let state = readState(dir);
    state.transition = { id: randomUUID(), phase: "prepared", from: ctx.cwd, to: target, sourceSession: source, destinationSession: destination, startedAt: Date.now() };
    writeState(dir, state);

    if (process.env.HERDR_ENV === "1" && process.env.HERDR_TAB_ID && process.env.HERDR_WORKSPACE_ID) {
      const created = herdr(["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID, "--label", `Teleport: ${target.split("/").at(-1)}`, "--cwd", target, "--no-focus"]);
      const pane = created?.result?.root_pane?.pane_id;
      const tab = created?.result?.tab?.tab_id ?? created?.result?.root_pane?.tab_id;
      if (!pane || !tab) throw new Error("Herdr did not return a destination pane and tab.");
      try {
        herdr(["pane", "run", pane, `pi --session ${quote(destination)}`]);
        await waitForDestination(pane, destination);
        state = readState(dir);
        state.active = { cwd: target, sessionFile: destination };
        state.history.push({ from: ctx.cwd, to: target, at: Date.now(), status: "completed" });
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
      current.history.push({ from: ctx.cwd, to: target, at: Date.now(), status: "completed" });
      delete current.transition;
      writeState(dir, current);
      rmSync(source, { force: true });
      next.ui.notify(`Teleported to ${target}`, "info");
    }});
    if (result.cancelled || !started) { rmSync(destination, { force: true }); state = readState(dir); delete state.transition; writeState(dir, state); throw new Error("Teleport was cancelled."); }
  }

  pi.registerCommand("teleport", { description: "Jump to an existing directory", async handler(args, ctx) { try { if (!args.trim()) throw new Error("Usage: /teleport <directory>"); await jump(ctx, args.trim()); } catch (e) { notify(ctx, e instanceof Error ? e.message : String(e), "error"); } } });
  pi.registerCommand("teleport-wt", { description: "Jump to an existing Worktrunk worktree", async handler(args, ctx) { try { if (!args.trim()) throw new Error("Usage: /teleport-wt <branch-or-path>"); await jump(ctx, resolveWorktrunkTarget(ctx.cwd, args.trim())); } catch (e) { notify(ctx, e instanceof Error ? e.message : String(e), "error"); } } });
  pi.registerCommand("teleport-back", { description: "Jump to the previous directory", async handler(_args, ctx) { try { const previous = readState(dir).history.at(-1)?.from; if (!previous) throw new Error("Teleport history is empty."); await jump(ctx, previous); } catch (e) { notify(ctx, e instanceof Error ? e.message : String(e), "error"); } } });
  pi.registerCommand("teleport-history", { description: "Show teleport history", async handler(_args, ctx) { const history = readState(dir).history; notify(ctx, history.length ? history.map((h, i) => `${i + 1}. ${h.from} → ${h.to}`).join("\n") : "Teleport history is empty."); } });
  pi.registerCommand("teleport-create", { description: "Create a Teleport-owned Git worktree", async handler(args, ctx) { try { const [branch, base = "HEAD", path] = args.trim().split(/\s+/); if (!branch) throw new Error("Usage: /teleport-create <branch> [base] [path]"); const resource = createManagedWorktree({ repo: ctx.cwd, branch, base, path, stateDir: dir }); notify(ctx, `Created ${resource.path}\nResource: ${resource.id}`); } catch (e) { notify(ctx, e instanceof Error ? e.message : String(e), "error"); } } });
  pi.registerCommand("teleport-remove", { description: "Remove a clean Teleport-owned Git worktree", async handler(id, ctx) { try { removeManagedWorktree({ repo: ctx.cwd, id: id.trim(), stateDir: dir }); notify(ctx, `Removed managed worktree ${id.trim()}.`); } catch (e) { notify(ctx, e instanceof Error ? e.message : String(e), "error"); } } });

  pi.registerTool({ name: "teleport", label: "Teleport", description: "Move this persisted Pi session, manage Teleport-owned worktrees, or inspect movement history. Move operations are queued until the current model turn ends.", parameters: Type.Object({ action: StringEnum(["jump", "back", "history", "create", "remove"] as const), target: Type.Optional(Type.String()), branch: Type.Optional(Type.String()), base: Type.Optional(Type.String()), path: Type.Optional(Type.String()), resourceId: Type.Optional(Type.String()) }, { additionalProperties: false }), async execute(_id, p) {
    if (p.action === "history") { const history = readState(dir).history; return { content: [{ type: "text", text: history.length ? history.map((h) => `${h.from} → ${h.to}`).join("\n") : "Teleport history is empty." }], details: {} }; }
    const command = p.action === "jump" ? `/teleport ${p.target ?? ""}` : p.action === "back" ? "/teleport-back" : p.action === "create" ? `/teleport-create ${[p.branch, p.base, p.path].filter(Boolean).join(" ")}` : `/teleport-remove ${p.resourceId ?? ""}`;
    pi.sendUserMessage(command, { deliverAs: "followUp", expandPromptTemplates: true });
    return { content: [{ type: "text", text: `Queued ${command}. It will run after this turn.` }], details: {}, terminate: true };
  }});

  pi.on("session_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); dir = dataDir(sessionId); const state = reconcileState(dir); const file = ctx.sessionManager.getSessionFile(); if (file) { state.active = { cwd: ctx.cwd, sessionFile: file }; writeState(dir, state); } });
}
