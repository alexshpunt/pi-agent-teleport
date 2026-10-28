import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeMachineResources, prepareHerdrArrival, preserveHerdrSourceWorkspace, readState, writeState, type TeleportState } from "./core.ts";
import { guardedLaunch, readHerdrPane, runHerdr, shellOwnsForeground, withOutput, type HerdrContext } from "./herdr.ts";
import type { TeleportExecution } from "./output.ts";
import { agentDirectory, piCommand, MAX_PACKET, hasSessionProcess, qualifyLocation, relocateSession, runtimeFingerprint, UnknownRemoteOutcome, shellQuote, sshOptions, validateReady, type ReadyIdentity, type RemoteMove, type ReturnRoute } from "./remote.ts";

const implementation = runtimeFingerprint();
type Arrival = {
  operationId: string; sessionId: string; sessionText: string; path: string; sessionName?: string;
  state: TeleportState; connection: HerdrContext; callback: Pick<ReturnRoute, "socket" | "token">;
  fingerprint: string; from: string; to: string; execution: TeleportExecution;
  dormantSource?: { operationId: string; sessionFile: string; cwd: string; snapshot: string };
};
type Prepared = {
  operationId: string; sessionId: string; dir: string; stateDir: string; sessionFile: string; cwd: string; agentDir: string;
  location: HerdrContext; rollbackArgs: string[]; fingerprint: string;
};

function save(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
function identity(prepared: Prepared): ReadyIdentity {
  return { operationId: prepared.operationId, sessionId: prepared.sessionId, fingerprint: prepared.fingerprint, cwd: prepared.cwd, sessionFile: prepared.sessionFile, paneId: prepared.location.paneId, agentDir: prepared.agentDir };
}
function connection(session: string): HerdrContext { return { session, workspaceId: "", tabId: "", paneId: "" }; }

type ArrivalProcessInfo = { shell_pid?: number; foreground_process_group_id?: number; foreground_processes?: Array<{ pid: number; cwd?: string; argv?: string[] }> };

/** Observe launch without turning a missing callback or transient query failure into rollback. */
export function watchArrival(input: { failure?: () => string | undefined; observe: () => ArrivalProcessInfo | undefined; output: () => string | undefined }): { ready: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let running = false;
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((accept, refuse) => { resolve = accept; reject = refuse; });
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    if (error) reject(error); else resolve();
  };
  const poll = setInterval(() => {
    try {
      const failure = input.failure?.();
      if (failure) { finish(new Error(withOutput(failure, input.output()))); return; }
      const info = input.observe();
      if (!info) return;
      if (info.foreground_processes?.length && !shellOwnsForeground(info)) running = true;
      else if (shellOwnsForeground(info) && running) {
        finish(new Error(withOutput("Destination Pi exited before it was ready. The source is retained.", input.output())));
        return;
      }
    } catch { /* Observation failed; no destination failure has been established. */ }
  }, 2_000);
  return { ready, resolve: () => finish(), reject: (error) => finish(error) };
}

/** Stage only owned files and a new native Herdr arrival; do not activate the conversation. */
export function stageArrival(input: Arrival): Prepared {
  if (input.fingerprint !== implementation) throw new Error("The installed Teleport changed. Update both endpoints before retrying.");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(input.sessionId) || !/^[a-f0-9-]+$/.test(input.operationId)) throw new Error("Invalid Teleport handoff identity.");
  if (input.execution?.sessionId !== input.sessionId) throw new Error("Teleport execution does not match the transferred session.");
  const cwd = realpathSync(input.path);
  if (!statSync(cwd).isDirectory()) throw new Error("The Teleport destination is not a directory.");
  const text = relocateSession(input.sessionText, input.sessionId, cwd);
  const stateDir = join(agentDirectory(), "teleport", input.sessionId);
  const old = readState(stateDir);
  if (old.active && !old.active.cwd.startsWith("ssh://") && existsSync(old.active.sessionFile)) {
    const dormant = input.dormantSource;
    if (!dormant || old.pendingRemote?.id !== dormant.operationId || old.active.sessionFile !== dormant.sessionFile || old.active.cwd !== dormant.cwd || readFileSync(dormant.sessionFile, "utf8") !== dormant.snapshot) {
      throw new Error("This machine already has a resumable copy of the session. Inspect it before retrying the handoff.");
    }
  }
  const arrivals = join(stateDir, "arrivals");
  mkdirSync(arrivals, { recursive: true, mode: 0o700 });
  const dir = join(arrivals, input.operationId);
  mkdirSync(dir, { mode: 0o700 });
  save(join(dir, "previous-state.json"), old);
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, text, { mode: 0o600, flag: "wx" });
  let destination: ReturnType<typeof prepareHerdrArrival> | undefined;
  try {
    destination = prepareHerdrArrival(input.connection, cwd, input.sessionName);
    const prepared: Prepared = { operationId: input.operationId, sessionId: input.sessionId, dir, stateDir, sessionFile, cwd, agentDir: agentDirectory(), location: destination.location, rollbackArgs: destination.rollbackArgs, fingerprint: input.fingerprint };
    save(join(dir, "prepared.json"), prepared);
    const state = structuredClone(input.state);
    delete state.transition;
    state.active = { cwd, sessionFile, herdr: prepared.location };
    state.history.push({ from: input.from, to: input.to, at: Date.now(), status: "completed", toHerdr: prepared.location });
    save(join(dir, "next-state.json"), state);
    save(join(dir, "handoff.json"), { ...input.callback, ...identity(prepared), commitFile: join(dir, "committed.json"), execution: input.execution });
    runHerdr(input.connection, ["pane", "run", prepared.location.paneId, guardedLaunch([...(process.platform === "win32" ? piCommand() : ["pi"]), "--approve", "--session", sessionFile], join(dir, "exited.json"), { PI_CODING_AGENT_DIR: prepared.agentDir, PI_TELEPORT_HANDOFF: join(dir, "handoff.json") })]);
    return prepared;
  } catch (error) {
    if (!destination) throw new UnknownRemoteOutcome(`Native arrival preparation is unconfirmed. Inspect ${dir} and the destination Herdr state before retrying.`);
    try { destination.rollback(); }
    catch { throw new UnknownRemoteOutcome(`Prepared destination cleanup is unconfirmed. Inspect ${dir} before retrying.`); }
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Publish the prepared state before releasing the destination's continuation gate. */
export function commitArrival(prepared: Prepared): void {
  const state = JSON.parse(readFileSync(join(prepared.dir, "next-state.json"), "utf8")) as TeleportState;
  writeState(prepared.stateDir, state);
  save(join(prepared.dir, "committed.json"), { ok: true });
}

/** Roll back only an uncommitted arrival that this controller prepared. */
export function abortArrival(prepared: Prepared): void {
  if (existsSync(join(prepared.dir, "committed.json"))) throw new Error("Destination already committed; refusing rollback.");
  runHerdr(prepared.location, prepared.rollbackArgs);
  const current = readState(prepared.stateDir);
  if (current.active?.sessionFile === prepared.sessionFile) {
    const published = JSON.parse(readFileSync(join(prepared.dir, "next-state.json"), "utf8"));
    if (JSON.stringify(current) !== JSON.stringify(published)) throw new UnknownRemoteOutcome("The uncommitted destination state changed; inspect it before restoring the prior state.");
    writeState(prepared.stateDir, JSON.parse(readFileSync(join(prepared.dir, "previous-state.json"), "utf8")));
  }
  rmSync(prepared.dir, { recursive: true, force: true });
}

function endpoint(action: string, input: any): any {
  if (action === "reserve") {
    const dir = mkdtempSync(join(tmpdir(), "pi-teleport-"));
    return { dir, socket: join(dir, "return.sock") };
  }
  if (action === "stage") return stageArrival({ ...input, dormantSource: undefined });
  if (action === "failure") {
    const receipt = join(input.dir, "exited.json");
    return { error: existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")).error : undefined };
  }
  if (action === "commit") { commitArrival(input); return { committed: true }; }
  if (action === "abort") { abortArrival(input); return { aborted: true }; }
  if (action === "status") return { committed: existsSync(join(input.dir, "committed.json")) };
  if (action === "lookup") {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(input.sessionId) || !/^[a-f0-9-]+$/.test(input.operationId)) throw new Error("Invalid handoff receipt identity.");
    const path = join(agentDirectory(), "teleport", input.sessionId, "arrivals", input.operationId, "prepared.json");
    return { prepared: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined };
  }
  if (action === "reset-socket") {
    if (dirname(input.socket) !== input.dir || !input.dir.startsWith(join(tmpdir(), "pi-teleport-"))) throw new Error("Unowned Teleport socket directory.");
    if (existsSync(input.socket)) {
      if (!lstatSync(input.socket).isSocket()) throw new Error("The return socket was replaced; refusing to remove it.");
      rmSync(input.socket);
    }
    return { reset: true };
  }
  if (action === "cleanup-socket") {
    // The random directory was returned by reserve, not selected by a user path.
    if (dirname(input.socket) !== input.dir || !input.dir.startsWith(join(tmpdir(), "pi-teleport-"))) throw new Error("Unowned Teleport socket directory.");
    rmSync(input.dir, { recursive: true, force: true });
    return { removed: true };
  }
  throw new Error("Unknown Teleport endpoint operation.");
}

function remoteEndpoint<T = any>(move: RemoteMove, action: string, input: unknown): T {
  let output: string;
  try {
    output = execFileSync("ssh", [...sshOptions, move.host, `PI_CODING_AGENT_DIR=${shellQuote(move.remoteAgentDir)} node --experimental-strip-types ${shellQuote(move.remoteWorker)} endpoint ${shellQuote(action)}`], {
      input: JSON.stringify(input), encoding: "utf8", maxBuffer: MAX_PACKET, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const response = (error as { stdout?: string }).stdout;
    if (!response?.trim()) throw new UnknownRemoteOutcome(`Remote ${action} outcome is unconfirmed. Inspect the handoff receipt before retrying.`);
    output = response;
  }
  let result: any;
  try { result = JSON.parse(output); }
  catch { throw new UnknownRemoteOutcome(`Remote ${action} returned an unrecognized receipt. Inspect the handoff before retrying.`); }
  if (result.ok === false && typeof result.error === "string") throw result.uncertain ? new UnknownRemoteOutcome(result.error) : new Error(result.error);
  if (result.ok !== true) throw new UnknownRemoteOutcome(`Remote ${action} receipt is unconfirmed.`);
  return result.result;
}

/** Keep an authenticated Unix-socket return bridge alive after the source Pi exits. */
async function controller(config: string): Promise<void> {
  const move = JSON.parse(readFileSync(config, "utf8")) as RemoteMove;
  const receipt = join(dirname(config), "result.json");
  const localDir = mkdtempSync(join(tmpdir(), "pi-teleport-"));
  const localSocket = join(localDir, "controller.sock");
  const token = randomBytes(32).toString("hex");
  let tunnel: ChildProcess | undefined;
  let reservation: { dir: string; socket: string } | undefined;
  let outward: Prepared | undefined;
  let stageAttempted = false;
  let committed = false;
  let returning = false;
  let pending: { expected: ReadyIdentity; resolve: () => void; reject: (error: Error) => void; remote: boolean } | undefined;
  const accepted = new Map<string, { expected: ReadyIdentity; remote: boolean }>();
  let closed = false;
  let reconnects = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((socket) => {
    let content = "";
    let received = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      content += chunk;
      if (Buffer.byteLength(content) > MAX_PACKET) { socket.destroy(); return; }
      if (received || !content.includes("\n")) return;
      received = true;
      void dispatch(socket, content.slice(0, content.indexOf("\n")));
    });
  });
  async function dispatch(socket: Socket, content: string): Promise<void> {
    try {
      const packet = JSON.parse(content);
      if (typeof packet.token !== "string" || packet.token.length !== token.length || !timingSafeEqual(Buffer.from(packet.token), Buffer.from(token))) throw new Error("Unauthenticated Teleport callback.");
      if (packet.action === "failed") {
        // The destination Pi reports why it cannot continue, before it exits.
        if (!pending || packet.operationId !== pending.expected.operationId || typeof packet.error !== "string") throw new Error("No matching Teleport arrival is awaiting readiness.");
        pending.reject(new Error(`Destination Pi cannot continue this session: ${packet.error} The source is retained.`));
        socket.end(`${JSON.stringify({ ok: true })}\n`);
        return;
      }
      if (packet.action === "ready") {
        const arrival = pending?.expected.operationId === packet.operationId ? pending : accepted.get(packet.operationId);
        if (!arrival) throw new Error("No Teleport arrival is awaiting readiness.");
        try {
          validateReady(arrival.expected, packet);
          let info;
          try { info = paneProcess(arrival.expected.paneId, arrival.remote); }
          catch { throw new UnknownRemoteOutcome("Destination process observation is unavailable; its handoff remains pending."); }
          if (!hasSessionProcess(info?.foreground_processes, packet.pid, arrival.expected.cwd, arrival.expected.sessionFile)) throw new Error("The expected destination Pi is not running in its owned Herdr pane.");
          if (arrival === pending) pending.resolve();
          socket.end(`${JSON.stringify({ ok: true })}\n`);
        } catch (error) {
          if (!(error instanceof UnknownRemoteOutcome) && arrival === pending) pending.reject(error as Error);
          throw error;
        }
        return;
      }
      if (packet.action !== "return" || packet.operationId !== move.id || !committed || returning) throw new Error("The return route is not available for this operation.");
      returning = true;
      let arrival: Prepared | undefined;
      try {
        relocateSession(packet.sessionText, move.sessionId, move.sourceCwd);
        const remoteState = packet.state as TeleportState;
        const state = structuredClone(move.state);
        state.history = remoteState.history;
        state.resources = mergeMachineResources(move.state.resources, remoteState.resources, move.host);
        const input: Arrival = {
          operationId: randomUUID(), sessionId: move.sessionId, sessionText: packet.sessionText, path: move.sourceCwd, sessionName: packet.sessionName,
          state, connection: move.herdr, callback: { socket: localSocket, token }, fingerprint: move.fingerprint,
          dormantSource: { operationId: move.id, sessionFile: move.sourceSession, cwd: move.sourceCwd, snapshot: move.sessionText },
          from: qualifyLocation(packet.cwd, move.host), to: qualifyLocation(move.sourceCwd, state.machine), execution: packet.execution,
        };
        arrival = stageArrival(input);
        await awaitReady(arrival, false);
        if (existsSync(move.sourceSession) && readFileSync(move.sourceSession, "utf8") !== move.sessionText) throw new UnknownRemoteOutcome("The retained source changed while returning. Inspect both sessions before activating a replacement.");
        commitArrival(arrival);
        if (existsSync(move.sourceSession)) {
          try {
            const source = runHerdr(move.herdr, ["pane", "process-info", "--pane", move.herdr.paneId]).process_info;
            if (hasSessionProcess(source?.foreground_processes, move.sourcePid, move.sourceCwd, move.sourceSession)) {
              preserveHerdrSourceWorkspace(move.herdr, move.sourceCwd);
              runHerdr(move.herdr, ["pane", "close", move.herdr.paneId]);
              const deadline = Date.now() + 5_000;
              while (Date.now() < deadline) {
                try { process.kill(move.sourcePid, 0); }
                catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(move.sourceSession, { force: true });
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            }
          } catch (error) { console.error(`Returned destination is running; retained source cleanup needs inspection: ${String(error)}`); }
        }
        socket.end(`${JSON.stringify({ ok: true, destination: input.to })}\n`);
        // Allow the remote command to receive the committed receipt before closing its tunnel.
        setTimeout(() => { cleanup(); }, 1_000);
      } catch (error) {
        if (arrival && existsSync(join(arrival.dir, "committed.json"))) {
          socket.end(`${JSON.stringify({ ok: true, destination: qualifyLocation(move.sourceCwd, move.state.machine), warning: "Return committed; cleanup needs inspection." })}\n`);
          setTimeout(cleanup, 1_000);
          return;
        }
        returning = false;
        if (arrival) {
          try { abortArrival(arrival); }
          catch { throw new UnknownRemoteOutcome("Return preparation cleanup is unconfirmed. Keep the remote source idle and inspect the recorded local arrival."); }
        }
        throw error;
      }
    } catch (error) { socket.end(`${JSON.stringify({ ok: false, uncertain: error instanceof UnknownRemoteOutcome, error: error instanceof Error ? error.message : String(error) })}\n`); }
  }
  function paneProcess(paneId: string, remote: boolean): any {
    return remote
      ? JSON.parse(execFileSync("herdr", ["--machine", move.machine, "pane", "process-info", "--pane", paneId], { encoding: "utf8", timeout: 15_000 })).result?.process_info
      : runHerdr(move.herdr, ["pane", "process-info", "--pane", paneId]).process_info;
  }
  /** Wait for startup without a deadline; only confirmed failure permits rollback. */
  async function awaitReady(arrival: Prepared, remote: boolean): Promise<void> {
    const watch = watchArrival({
      failure: () => remote
        ? remoteEndpoint<{ error?: string }>(move, "failure", arrival).error
        : endpoint("failure", arrival).error,
      observe: () => paneProcess(arrival.location.paneId, remote),
      output: () => readHerdrPane(arrival.location, arrival.location.paneId, remote ? move.machine : undefined),
    });
    pending = { expected: identity(arrival), remote, resolve: watch.resolve, reject: watch.reject };
    try {
      await watch.ready;
      accepted.set(arrival.operationId, { expected: identity(arrival), remote });
    } finally { pending = undefined; }
  }
  function reconnectTunnel(): void {
    if (closed || reconnectTimer) return;
    save(join(dirname(config), "channel.json"), { phase: "disconnected", attempts: reconnects, localSocket, reservation, host: move.host });
    if (reconnects >= 3) return; // Keep the narrow controller alive for an inspected manual reconnection.
    reconnects += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (closed) return;
      try {
        remoteEndpoint(move, "reset-socket", reservation);
        startTunnel();
      } catch (error) { console.error(`Return channel reconnection failed: ${String(error)}`); reconnectTunnel(); }
    }, reconnects * 1_000);
  }
  function startTunnel(): void {
    if (!reservation) throw new Error("No owned remote return socket was reserved.");
    const transport = spawn("ssh", [...sshOptions, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-N", "-R", `${reservation.socket}:${localSocket}`, move.host], { stdio: ["ignore", "ignore", "inherit"] });
    tunnel = transport;
    transport.once("error", (error) => { console.error(`Teleport return channel unavailable: ${error.message}`); });
    transport.once("close", () => {
      if (closed || transport !== tunnel) return;
      // Channel loss does not establish that the destination failed to start.
      reconnectTunnel();
    });
  }
  function cleanup(): void {
    if (closed) return;
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    server.close();
    tunnel?.kill("SIGTERM");
    if (reservation) {
      try { remoteEndpoint(move, "cleanup-socket", reservation); } catch (error) { console.error(String(error)); }
    }
    rmSync(localDir, { recursive: true, force: true });
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(localSocket, resolve); });
    reservation = remoteEndpoint<{ dir: string; socket: string }>(move, "reserve", {});
    startTunnel();
    const source = qualifyLocation(move.sourceCwd, move.state.machine);
    const target = qualifyLocation(move.path, move.host);
    const state = structuredClone(move.state);
    state.machine = move.host;
    state.returnRoute = { socket: reservation.socket, token, operationId: move.id, previous: source };
    stageAttempted = true;
    outward = remoteEndpoint<Prepared>(move, "stage", {
      operationId: move.id, sessionId: move.sessionId, sessionText: move.sessionText, path: move.path, sessionName: move.sessionName,
      state, execution: move.execution, connection: connection(move.remoteSession), callback: { socket: reservation.socket, token }, fingerprint: move.fingerprint, from: source, to: target,
    } satisfies Arrival);
    save(join(dirname(config), "destination.json"), outward);
    await awaitReady(outward, true);
    try {
      remoteEndpoint(move, "commit", outward);
      committed = true;
    } catch (error) {
      try { committed = remoteEndpoint(move, "status", outward).committed === true; }
      catch {
        save(receipt, { ok: false, uncertain: true, error: "Remote commit outcome is unknown. Keep this source idle and inspect the destination before retrying." });
        // Keep the authenticated return bridge available if commit reached the destination.
        committed = true;
        return;
      }
      if (!committed) throw error;
    }
    const localState = readState(move.stateDir);
    delete localState.pendingRemote;
    localState.active = { cwd: target, sessionFile: outward.sessionFile, herdr: outward.location };
    localState.history.push({ from: source, to: target, at: Date.now(), status: "completed", fromHerdr: move.herdr, toHerdr: outward.location });
    writeState(move.stateDir, localState);
    save(receipt, { ok: true, destination: target, versions: { source: move.localVersion, destination: move.remoteVersion } });
  } catch (error) {
    if (committed) {
      save(receipt, { ok: true, destination: qualifyLocation(move.path, move.host), warning: `Destination committed; local receipt update needs inspection: ${String(error)}` });
      return;
    }
    let failure = error;
    if (!outward && stageAttempted && error instanceof UnknownRemoteOutcome) {
      try { outward = remoteEndpoint(move, "lookup", { sessionId: move.sessionId, operationId: move.id }).prepared; }
      catch { /* The deterministic receipt remains an explicit inspection target. */ }
    }
    if (outward) {
      try {
        remoteEndpoint(move, "abort", outward);
        failure = new Error(`Remote move did not commit; its prepared destination was closed. ${String(error)}`);
      } catch { failure = new UnknownRemoteOutcome("Prepared destination cleanup is unconfirmed. Inspect the saved destination receipt and Herdr pane before retrying."); }
    }
    save(receipt, { ok: false, uncertain: failure instanceof UnknownRemoteOutcome, error: failure instanceof Error ? failure.message : String(failure) });
    cleanup();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "endpoint") {
    try {
      const content = readFileSync(0, "utf8");
      if (Buffer.byteLength(content) > MAX_PACKET) throw new Error("Teleport transfer exceeds 64 MiB.");
      const result = endpoint(process.argv[3], JSON.parse(content));
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) { process.stdout.write(JSON.stringify({ ok: false, uncertain: error instanceof UnknownRemoteOutcome, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; }
  } else if (process.argv[2] === "controller") {
    controller(process.argv[3]).catch((error) => { console.error(error); process.exitCode = 1; });
  }
}
