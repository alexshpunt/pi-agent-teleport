import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionManager, VERSION, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";


import { createManagedWorktree, prepareHerdrDestination, preserveHerdrSourceWorkspace, readState, reconcileState, removeManagedWorktree, writeState, type Resource } from "./core.ts";
import { assertHerdrContext, getHerdrContext, runHerdr, type HerdrContext } from "./herdr.ts";
import { HANDOFF_TIMEOUT, UnknownRemoteOutcome, agentDirectory, confirmArrival, extensionFile, parseTarget, probeRemote, qualifyLocation, remoteMachine, requestController, runtimeFingerprint, shellQuote as quote, startRemoteMove, workerFile } from "./remote.ts";

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
async function waitForDestination(context: HerdrContext, pane: string, session: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = runHerdr(context, ["pane", "process-info", "--pane", pane]).process_info;
    if (info?.foreground_processes?.some((p: any) => Array.isArray(p.argv) && p.argv.includes(session))) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out confirming the destination Pi process.");
}
/** Build the detached command that closes only the source pane before cleaning its session file. */
export function buildSourcePaneCleanup(paneId: string, sourcePid: number, sessionFile: string): string {
  return [
    "sleep 0.25",
    `herdr pane close ${quote(paneId)} >/dev/null 2>&1 || true`,
    "i=0",
    `while kill -0 ${sourcePid} 2>/dev/null && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.1; done`,
    `rm -f -- ${quote(sessionFile)}`,
  ].join("; ");
}

/** Describe a removed worktree using human-facing identifiers. */
export function formatRemovedWorktree(resource: Resource): string {
  return `Removed worktree ${qualifyLocation(resource.path, resource.machine)}\nBranch: ${resource.branch}`;
}

async function scheduleSourceCleanup(pi: ExtensionAPI, context: HerdrContext, cwd: string, sessionFile: string): Promise<void> {
  preserveHerdrSourceWorkspace(context, cwd);
  const cleanup = buildSourcePaneCleanup(context.paneId, process.pid, sessionFile);
  const launcher = `if command -v setsid >/dev/null 2>&1; then setsid sh -c ${quote(cleanup)} >/dev/null 2>&1 < /dev/null & else nohup sh -c ${quote(cleanup)} >/dev/null 2>&1 < /dev/null & fi`;
  const result = await pi.exec('sh', ['-lc', launcher], { timeout: 5_000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || 'Failed to schedule source cleanup.');
}

export default function teleport(pi: ExtensionAPI) {
  const implementation = runtimeFingerprint();
  if (process.env.PI_TELEPORT_PROBE) {
    process.stdout.write(`PI_TELEPORT_PROBE:${process.env.PI_TELEPORT_PROBE}:${JSON.stringify({ fingerprint: implementation, worker: workerFile, agentDir: agentDirectory(), version: VERSION })}\n`);
  }
  let sessionId = "unknown";
  let dir = dataDir(sessionId);
  const notify = (ctx: ExtensionCommandContext, text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);

  function snapshot(ctx: ExtensionCommandContext): { source: string; sessionText: string } {
    const source = ctx.sessionManager.getSessionFile();
    const header = ctx.sessionManager.getHeader();
    if (!source || !header) throw new Error("Teleport requires a persisted Pi session.");
    return { source, sessionText: `${[header, ...ctx.sessionManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n` };
  }

  async function retireSource(ctx: ExtensionCommandContext, source: string, context: HerdrContext) {
    try { await scheduleSourceCleanup(pi, context, ctx.cwd, source); }
    catch (error) { notify(ctx, `Destination is running. Could not close source pane ${context.paneId}: ${String(error)}`, "error"); }
    ctx.shutdown();
  }

  async function jumpRemote(ctx: ExtensionCommandContext, host: string, path: string) {
    const herdr = getHerdrContext();
    if (!herdr) throw new Error("Remote Teleport requires Herdr on both machines. Local moves still work without Herdr.");
    assertHerdrContext(herdr);
    const { source, sessionText } = snapshot(ctx);
    const profile = remoteMachine(host);
    const remote = probeRemote(host, path, implementation);
    const id = randomUUID();
    const state = readState(dir);
    const move = { id, host, path, ...profile, sourceCwd: ctx.cwd, sourceSession: source, sourcePid: process.pid, sessionText, sessionId, sessionName: ctx.sessionManager.getSessionName(), state, stateDir: dir, herdr, fingerprint: implementation, remoteWorker: remote.worker, remoteAgentDir: remote.agentDir, localVersion: VERSION, remoteVersion: remote.version };
    state.pendingRemote = { id, receipt: join(dir, "bridges", id, "result.json") };
    writeState(dir, state);
    // Keep the captured source state independent from the in-flight marker.
    delete move.state.pendingRemote;
    if (VERSION !== remote.version) notify(ctx, `Pi versions differ: ${VERSION} → ${remote.version}. Attempting the move without changing either installation.`);
    try {
      await startRemoteMove(move);
    } catch (error) {
      if (!(error instanceof UnknownRemoteOutcome)) {
        const current = readState(dir);
        delete current.pendingRemote;
        writeState(dir, current);
      }
      throw error;
    }
    await retireSource(ctx, source, herdr);
  }

  async function returnRemote(ctx: ExtensionCommandContext) {
    const state = readState(dir);
    if (!state.returnRoute) throw new Error("No remote return route is recorded.");
    const herdr = getHerdrContext();
    if (!herdr) throw new Error("Return through the native Herdr pane that owns this session.");
    const { source, sessionText } = snapshot(ctx);
    const id = randomUUID();
    const requests = join(dir, "return-requests");
    mkdirSync(requests, { recursive: true, mode: 0o700 });
    const receipt = join(requests, `${id}.json`);
    writeFileSync(receipt, JSON.stringify({ phase: "submitting", operationId: state.returnRoute.operationId }), { mode: 0o600, flag: "wx" });
    state.pendingRemote = { id, receipt };
    writeState(dir, state);
    let result: unknown;
    try {
      result = await requestController(state.returnRoute, { action: "return", operationId: state.returnRoute.operationId, sessionText, state, cwd: ctx.cwd, sessionName: ctx.sessionManager.getSessionName() }, HANDOFF_TIMEOUT * 3);
    } catch (error) {
      const uncertain = error instanceof UnknownRemoteOutcome;
      try { writeFileSync(receipt, JSON.stringify({ ok: false, uncertain, error: String(error) }), { mode: 0o600 }); } catch { /* The persisted pending marker still fences this source. */ }
      if (!uncertain) {
        const current = readState(dir);
        delete current.pendingRemote;
        writeState(dir, current);
      }
      throw error;
    }
    try { writeFileSync(receipt, JSON.stringify(result), { mode: 0o600 }); }
    catch { notify(ctx, "Return committed. Its local receipt could not be saved; continue only at the returned destination.", "error"); }
    await retireSource(ctx, source, herdr);
  }
  async function jump(ctx: ExtensionCommandContext, rawTarget: string) {
    const sourceCwd = ctx.cwd;
    const currentState = readState(dir);
    const parsed = parseTarget(rawTarget, ctx.cwd, currentState.machine);
    if (parsed.host) { await jumpRemote(ctx, parsed.host, parsed.path); return; }
    const target = realpathSync(parsed.path);
    const { source, destination } = serialize(ctx, target);
    let state = readState(dir);
    state.transition = { id: randomUUID(), phase: "prepared", from: sourceCwd, to: target, sourceSession: source, destinationSession: destination, startedAt: Date.now() };
    writeState(dir, state);

    const context = getHerdrContext();
    if (context) {
      let prepared: ReturnType<typeof prepareHerdrDestination> | undefined;
      try {
        const resource = Object.values(state.resources).find((resource) => resource.machine === state.machine && resource.path === target);
        prepared = prepareHerdrDestination(context, target, resource?.herdr, ctx.sessionManager.getSessionName());
        const location = prepared.location;
        const continuation = Buffer.from(`Agent teleported: ${sourceCwd} → ${target}. Continue the original task from the destination. Do not repeat the teleport request.`, "utf8").toString("base64url");
        runHerdr(context, ["pane", "run", location.paneId, `PI_TELEPORT_CONTINUATION=${quote(continuation)} pi --approve --session ${quote(destination)}`]);
        await waitForDestination(context, location.paneId, destination);
        state = readState(dir);
        state.active = { cwd: target, sessionFile: destination, herdr: location };
        state.history.push({ from: qualifyLocation(sourceCwd, state.machine), to: qualifyLocation(target, state.machine), at: Date.now(), status: "completed", fromHerdr: context, toHerdr: location });
        if (resource?.herdr && state.resources[resource.id]) state.resources[resource.id].herdr = { ...location, parentWorkspaceId: resource.herdr.parentWorkspaceId };
        delete state.transition;
        writeState(dir, state);
      } catch (error) {
        try { prepared?.rollback(); } catch {}
        rmSync(destination, { force: true });
        state = readState(dir);
        state.active = { cwd: sourceCwd, sessionFile: source, herdr: context };
        delete state.transition;
        writeState(dir, state);
        throw error;
      }
      // A confirmed destination must never be rolled back if source cleanup fails.
      try { await scheduleSourceCleanup(pi, context, sourceCwd, source); }
      catch (error) { notify(ctx, `Destination is running. Could not close source pane ${context.paneId}: ${String(error)}`, "error"); }
      ctx.shutdown();
      return;
    }

    let started = false;
    const result = await ctx.switchSession(destination, { withSession: async (next) => {
      started = true;
      const current = readState(dir);
      current.active = { cwd: target, sessionFile: destination };
      current.history.push({ from: qualifyLocation(sourceCwd, current.machine), to: qualifyLocation(target, current.machine), at: Date.now(), status: "completed" });
      delete current.transition;
      writeState(dir, current);
      rmSync(source, { force: true });
      next.ui.notify(`✦ Agent teleported: ${sourceCwd} → ${target}`, "info");
      await next.sendMessage({
        customType: "pi-agent-teleport-continuation",
        content: `Agent teleported: ${sourceCwd} → ${target}. Continue the original task from the destination. Do not repeat the teleport request.`,
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
    }});
    if (result.cancelled || !started) { rmSync(destination, { force: true }); state = readState(dir); delete state.transition; writeState(dir, state); throw new Error("Teleport was cancelled."); }
  }

  type PendingOperation = { action: "jump" | "back"; target?: string };
  const pending = new Map<string, PendingOperation>();
  let queuedToken: string | undefined;

  // Slash commands execute immediately in Pi, even with followUp delivery.
  // Wait until the tool turn has fully settled before replacing its session.
  pi.on("agent_settled", (_event, ctx) => {
    if (!queuedToken || !ctx.isIdle()) return;
    const token = queuedToken;
    queuedToken = undefined;
    pi.sendUserMessage(`/__teleport_internal ${token}`, { deliverAs: "followUp", expandPromptTemplates: true });
  });

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
          const state = readState(dir);
          const previous = state.history.at(-1)?.from;
          if (!previous) throw new Error("Teleport history is empty.");
          if (state.returnRoute?.previous === previous) await returnRemote(ctx);
          else await jump(ctx, previous);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, message, "error");
        if (error instanceof UnknownRemoteOutcome) return;
        pi.sendMessage({
          customType: "pi-agent-teleport-failure",
          content: `Teleport failed: ${message} Continue the original task from the current location.`,
          display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
      }
    },
  });

  pi.registerTool({
    name: "teleport",
    label: "Teleport",
    description: [
      "Use teleport to move this persisted Pi session between local directories, Git worktrees, and remote machines.",
      "For remote moves, use jump with an ssh://SSH_ALIAS/absolute/directory target, then back to return through the recorded SSH channel. Remote moves require Herdr on both machines and the current Teleport installation on the destination. Do not copy provider credentials or change Pi versions to make a move.",
      "Use Teleport whenever work needs to continue from another folder or repository; use create followed by jump when a feature or fix should be isolated in its own worktree.",
      "Use back to return, then remove to safely clean up a Teleport-owned worktree. Remove requires resourceId from create or history. Prefer this tool over shell cd because Teleport moves the active session and preserves its navigation history.",
      "Inside Herdr, create uses its configured worktree paths and grouped workspaces; jump and back continue Pi in the checkout workspace. Remove cleans up the checkout and its idle workspace in the same Herdr session. Do not create extra Herdr tabs yourself.",
    ].join(" "),
    parameters: Type.Object({
      action: StringEnum(["jump", "back", "history", "create", "remove"] as const),
      target: Type.Optional(Type.String({ description: "For jump: a local directory or ssh://SSH_ALIAS/absolute/directory. Use an existing trusted OpenSSH alias also configured as an enabled Herdr machine." })),
      branch: Type.Optional(Type.String()),
      base: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      resourceId: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.action === "history") {
        const state = readState(dir);
        const history = state.history;
        const resources = Object.values(state.resources);
        const routes = history.length ? history.map((entry) => `${entry.from} → ${entry.to}`).join("\n") : "Teleport history is empty.";
        const managed = resources.length ? resources.map((resource) => `${qualifyLocation(resource.path, resource.machine)} (${resource.branch}) — resourceId: ${resource.id}${resource.herdr ? ` — Herdr workspace: ${resource.herdr.workspaceId}` : ""}`).join("\n") : "none";
        return { content: [{ type: "text" as const, text: `${routes}\nManaged worktrees:\n${managed}` }], details: { history, resources } };
      }
      const handoff = readState(dir).pendingRemote;
      if (handoff) throw new Error(`A remote Teleport outcome needs inspection at ${handoff.receipt}. Keep the source idle; do not mutate its locations.`);
      if (params.action === "create") {
        if (!params.branch) throw new Error("A branch is required.");
        const resource = createManagedWorktree({ repo: ctx.cwd, branch: params.branch, base: params.base, path: params.path, stateDir: dir, herdr: getHerdrContext() });
        return { content: [{ type: "text" as const, text: `Created worktree ${qualifyLocation(resource.path, resource.machine)}\nBranch: ${resource.branch}${resource.herdr ? `\nHerdr workspace: ${resource.herdr.workspaceId}` : ""}\nUse resourceId: ${resource.id} to remove this worktree` }], details: { resource } };
      }
      if (params.action === "remove") {
        if (!params.resourceId) throw new Error("A resourceId is required.");
        const resource = removeManagedWorktree({ repo: ctx.cwd, id: params.resourceId, stateDir: dir, herdr: getHerdrContext() });
        return { content: [{ type: "text" as const, text: formatRemovedWorktree(resource) }], details: { resource } };
      }
      if (params.action === "jump" && !params.target) throw new Error("A target directory is required.");
      if (params.action === "jump") {
        const state = readState(dir);
        const target = parseTarget(params.target!, ctx.cwd, state.machine);
        if (!target.host && !existsSync(target.path)) {
          throw new Error(`Directory does not exist: ${target.path}. Find the correct directory and retry teleport.`);
        }
        if (target.host && !getHerdrContext()) throw new Error("Remote Teleport requires Herdr on both machines. Local moves still work without Herdr.");
      }
      const state = readState(dir);
      const current = qualifyLocation(ctx.cwd, state.machine);
      const destination = params.target ? parseTarget(params.target, ctx.cwd, state.machine) : undefined;
      const target = destination ? qualifyLocation(destination.path, destination.host ?? state.machine) : "previous location";
      if (pending.size) throw new Error("A Teleport move is already queued. Wait for it to finish.");
      const token = randomUUID();
      pending.set(token, { action: params.action, target: params.target });
      queuedToken = token;
      return {
        content: [{ type: "text" as const, text: `✦ Agent teleport queued: ${current} → ${target}` }],
        details: { action: params.action, target: params.target },
        terminate: true,
      };
    },
    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold("✦ Agent teleport"));
      if (args.action === "jump" && args.target) {
        const state = readState(dir);
        let target = args.target;
        try {
          const parsed = parseTarget(args.target, context.cwd, state.machine);
          target = qualifyLocation(parsed.path, parsed.host ?? state.machine);
        } catch { /* Invalid input is reported by execute, not by the renderer. */ }
        const completed = state.history.findLast((entry) => entry.to === target);
        const current = qualifyLocation(context.cwd, state.machine);
        const source = current === target && completed ? completed.from : current;
        component.setText(`${title}\n  ${theme.fg("accent", source)}\n  ${theme.fg("muted", "└─→")} ${theme.fg("warning", target)}`);
      } else if (args.action === "back") {
        component.setText(`${title} ${theme.fg("accent", "←")} ${theme.fg("muted", "previous location")}`);
      } else if (args.action === "create") {
        component.setText(`${title} ${theme.fg("accent", "+ worktree")} ${theme.fg("muted", args.branch ?? "branch required")}`);
      } else if (args.action === "remove") {
        const resource = args.resourceId ? readState(dir).resources[args.resourceId] : undefined;
        if (resource) {
          component.setText(`${title} ${theme.fg("warning", "− worktree")}\n  ${theme.fg("accent", qualifyLocation(resource.path, resource.machine))}\n  ${theme.fg("muted", "branch:")} ${theme.fg("warning", resource.branch)}`);
        } else if (!context.lastComponent) {
          component.setText(`${title} ${theme.fg("warning", "− worktree")}${args.resourceId ? "" : ` ${theme.fg("muted", "resource required")}`}`);
        }
      } else {
        component.setText(`${title} ${theme.fg("muted", "history")}`);
      }
      return component;
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Text(theme.fg("warning", "  ◌ preparing destination…"), 0, 0);
      const text = result.content?.find((item) => item.type === "text")?.text ?? "";
      if (!text) return new Text("", 0, 0);
      if (context.isError) return new Text(`  ${theme.fg("error", "✗")} ${theme.fg("error", text)}`, 0, 0);
      const details = result.details as { action?: string; history?: Array<{ from: string; to: string }>; resources?: Resource[] } | undefined;
      if (details?.history) {
        const routes = details.history.map((entry) =>
          `  ${theme.fg("accent", entry.from)} ${theme.fg("muted", "→")} ${theme.fg("warning", entry.to)}`
        );
        const worktrees = details.resources?.length
          ? details.resources.map((resource) => `  ${theme.fg("accent", qualifyLocation(resource.path, resource.machine))} ${theme.fg("muted", `(${resource.branch}) resourceId: ${resource.id}`)}`).join("\n")
          : theme.fg("muted", "  None");
        return new Text(`${routes.length ? routes.join("\n") : theme.fg("muted", "  No teleport history.")}\n  ${theme.fg("muted", "Managed worktrees:")}\n${worktrees}`, 0, 0);
      }
      const prefix = details?.action === "jump" || details?.action === "back"
        ? theme.fg("warning", "  ◌ queued")
        : theme.fg("success", "  ✓");
      return new Text(`${prefix} ${theme.fg("toolOutput", text)}`, 0, 0);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    dir = dataDir(sessionId);
    const handoffFile = process.env.PI_TELEPORT_HANDOFF;
    if (handoffFile) {
      delete process.env.PI_TELEPORT_HANDOFF;
      try {
        const handoff = JSON.parse(readFileSync(handoffFile, "utf8"));
        const herdr = getHerdrContext();
        if (!herdr || !ctx.model) throw new Error("Destination needs a ready Pi model and its own native Herdr pane.");
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
        if (!auth.ok) throw new Error(`Destination authentication is unavailable for ${ctx.model.provider}/${ctx.model.id}. Configure it on that machine before retrying.`);
        const selected = pi.getAllTools().find((tool) => tool.name === "teleport");
        if (!selected?.sourceInfo?.path || realpathSync(selected.sourceInfo.path) !== realpathSync(extensionFile)) throw new Error("Another Teleport installation owns the active tool. Load only the current implementation and retry.");
        await confirmArrival(handoff, {
          operationId: handoff.operationId, fingerprint: implementation,
          sessionId, cwd: realpathSync(ctx.cwd), sessionFile: ctx.sessionManager.getSessionFile(), paneId: herdr.paneId, pid: process.pid, agentDir: agentDirectory(),
        });
      } catch (error) {
        ctx.ui.notify(`Teleport arrival not committed: ${error instanceof Error ? error.message : String(error)}`, "error");
        ctx.shutdown();
        return;
      }
    }
    const encodedContinuation = process.env.PI_TELEPORT_CONTINUATION;
    // The source process owns the pending handoff. Do not reconcile it while
    // the destination is starting, or start another turn before it commits.
    if (encodedContinuation) {
      const deadline = Date.now() + 15_000;
      while (readState(dir).transition) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Teleport handoff to commit.");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const state = reconcileState(dir);
    const file = ctx.sessionManager.getSessionFile();
    if (file) {
      state.active = { cwd: ctx.cwd, sessionFile: file, ...(getHerdrContext() ? { herdr: getHerdrContext() } : {}) };
      writeState(dir, state);
    }
    if (handoffFile) {
      const route = state.history.at(-1);
      ctx.ui.setStatus("teleport-location", `Teleport · ${state.machine ?? "local"}`);
      ctx.ui.notify(`✦ Agent teleported: ${route?.from} → ${route?.to}`, "info");
      pi.sendMessage({
        customType: "pi-agent-teleport-continuation",
        content: `Agent teleported: ${route?.from} → ${route?.to}. This Pi process is now running at ${qualifyLocation(ctx.cwd, state.machine)}. Continue the original task from here. Do not repeat the teleport request. Use teleport back for the recorded return journey.`,
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
    }
    if (encodedContinuation) {
      delete process.env.PI_TELEPORT_CONTINUATION;
      pi.sendMessage({
        customType: "pi-agent-teleport-continuation",
        content: Buffer.from(encodedContinuation, "base64url").toString("utf8"),
        display: false,
      }, { triggerTurn: true, deliverAs: "followUp" });
    }
  });
}
