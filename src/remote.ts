import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeleportState } from "./core.ts";
import { runCore, type HerdrContext } from "./herdr.ts";
import type { TeleportExecution } from "./output.ts";
import { discoverAppDesktop } from "./app.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));
export const extensionFile = join(sourceDir, "index.ts");
export const arrivalGuardFile = join(sourceDir, "arrival-guard.ts");
export const workerFile = join(sourceDir, "bridge.ts");
export const MAX_PACKET = 64 * 1024 * 1024;

/** Run the current Pi installation directly, without an npm shell wrapper. */
export function piCommand(): string[] {
  const script = process.argv[1];
  return script && existsSync(script) ? [process.execPath, ...process.execArgv, resolve(script)] : [process.execPath];
}

/** An unconfirmed commit must leave the source idle, not launch a competing continuation. */
export class UnknownRemoteOutcome extends Error {}

export type ModelIdentity = { provider: string; id: string; thinkingLevel: ReturnType<import("@earendil-works/pi-coding-agent").ExtensionAPI["getThinkingLevel"]> };
/** A private return channel, carried only in Teleport's mode-0600 state. */
export type ReturnRoute = { socket: string; token: string; operationId: string; previous: string };
/** A destination's exact persisted session and native Herdr pane. */
export type ReadyIdentity = { operationId: string; fingerprint: string; sessionId: string; cwd: string; sessionFile: string; paneId: string; agentDir: string };
/** Plain data captured before retiring the source extension runtime. */
export type RemoteMove = {
  id: string; host: string; path: string; machine: string; remoteSession: string;
  sessionId: string; sessionText: string; sessionName?: string; state: TeleportState; execution: TeleportExecution;
  sourceCwd: string; sourceSession: string; sourcePid: number; stateDir: string; herdr: HerdrContext;
  fingerprint: string; remoteWorker: string; remoteAgentDir: string; localVersion: string; remoteVersion: string;
  localCommand?: string[]; remoteCommand?: string[]; remoteCore?: HerdrContext; remotePlatform?: NodeJS.Platform; desktop?: boolean; expectedModel: ModelIdentity; sourceBashHidden: boolean;
};

/** Resolve local paths or a trusted OpenSSH alias with an absolute remote path. */
export function parseTarget(value: string, cwd: string, currentMachine?: string): { host?: string; path: string } {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Teleport destinations cannot contain control characters.");
  if (!value.includes("://")) return { path: resolve(cwd, value) };
  const match = /^ssh:\/\/((?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*)(\/.*)$/.exec(value);
  if (!match || match[2] === "/") throw new Error("Use ssh://SSH_ALIAS/absolute/directory. Put ports and connection options in OpenSSH config.");
  const path = /^\/[A-Za-z]:\//.test(match[2]) ? win32.normalize(match[2].slice(1)).replaceAll("\\", "/") : posix.resolve("/", match[2]);
  return match[1] === currentMachine ? { path } : { host: match[1], path };
}

/** Include machine identity without mistaking remote paths for local files. */
export function qualifyLocation(path: string, machine?: string): string {
  if (!machine) return path;
  const remote = /^[A-Za-z]:[\\/]/.test(path) ? `/${path.replaceAll("\\", "/")}` : path;
  return `ssh://${machine}${remote}`;
}
/** Quote exactly one argument for the remote login shell. */
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
/** Locate the current host's agent directory without copying controller settings. */
export function agentDirectory(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }
/** Normalize checkout line endings while detecting executable content changes. */
export function fingerprintFiles(files: Array<{ name: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.name).update(file.content.replaceAll("\r\n", "\n"));
  return hash.digest("hex");
}

/** Fingerprint executable Teleport files, not Pi or unrelated extensions. */
export function runtimeFingerprint(): string {
  return fingerprintFiles(["index.ts", "arrival-guard.ts", "core.ts", "herdr.ts", "app.ts", "process-info.ps1", "readiness.ts", "remote.ts", "bridge.ts", "output.ts"].map((name) => ({ name, content: readFileSync(join(sourceDir, name), "utf8") })));
}

/** Preserve every conversation entry and the session ID while relocating its header. */
export function relocateSession(content: string, sessionId: string, cwd: string): string {
  const lines = content.trimEnd().split("\n");
  const header = JSON.parse(lines[0]);
  if (header.type !== "session" || header.id !== sessionId) throw new Error("Transferred session identity does not match the requested session.");
  for (const line of lines.slice(1)) JSON.parse(line);
  return `${[JSON.stringify({ ...header, cwd }), ...lines.slice(1)].join("\n")}\n`;
}

/** Reject a stale extension, wrong session, or another pane before handoff commit. */
export function validateReady(expected: ReadyIdentity, actual: ReadyIdentity & { pid: number }): void {
  for (const field of ["operationId", "fingerprint", "sessionId", "cwd", "sessionFile", "paneId", "agentDir"] as const) {
    if (actual[field] !== expected[field]) throw new Error(`Destination readiness mismatch: ${field}. The source has not been retired.`);
  }
  if (!Number.isSafeInteger(actual.pid) || actual.pid <= 0) throw new Error("Destination readiness has no valid Pi process.");
}

/** Match the authenticated callback to its native foreground process; Pi may replace its visible argv with its process title. */
export function hasSessionProcess(processes: Array<{ pid: number; cwd?: string; argv?: string[] }> | undefined, pid: number, cwd: string, sessionFile: string, platform: NodeJS.Platform = process.platform): boolean {
  const canonicalCwd = platform === "win32" ? win32.resolve : (value: string) => value;
  return !!processes?.some((process) => {
    if (process.pid !== pid || process.cwd === undefined || canonicalCwd(process.cwd) !== canonicalCwd(cwd)) return false;
    const argument = process.argv?.indexOf("--session") ?? -1;
    return argument < 0 || process.argv?.[argument + 1] === sessionFile;
  });
}
/** Send one bounded authenticated message over an owned Unix socket. */
export function requestController(route: Pick<ReturnRoute, "socket" | "token">, payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const message = `${JSON.stringify({ ...payload, token: route.token })}\n`;
    if (Buffer.byteLength(message) > MAX_PACKET) { reject(new Error("Teleport session exceeds the 64 MiB transfer limit.")); return; }
    const tcp = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(route.socket);
    if (route.socket.startsWith("tcp://") && (!tcp || Number(tcp[1]) > 65535)) { reject(new Error("Invalid Teleport loopback channel.")); return; }
    const socket = tcp ? createConnection({ host: "127.0.0.1", port: Number(tcp[1]) }) : createConnection(route.socket);
    let content = "";
    let submitted = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => { submitted = true; socket.write(message); });
    socket.on("data", (chunk: string) => {
      content += chunk;
      if (Buffer.byteLength(content) > MAX_PACKET) { socket.destroy(new Error("Teleport controller response exceeds its limit.")); return; }
      const end = content.indexOf("\n");
      if (end < 0) return;
      try {
        const result = JSON.parse(content.slice(0, end));
        socket.end();
        if (result.ok === true) resolve(result);
        else if (result.ok === false && typeof result.error === "string") reject(result.uncertain ? new UnknownRemoteOutcome(result.error) : new Error(result.error));
        else reject(new UnknownRemoteOutcome("Teleport returned an unrecognized receipt. Keep this source idle and inspect the destination."));
      } catch { socket.destroy(); reject(new UnknownRemoteOutcome("Teleport returned a malformed receipt after submission. Keep this source idle and inspect the destination.")); }
    });
    socket.on("error", (error) => reject(submitted ? new UnknownRemoteOutcome(`Teleport callback outcome is unconfirmed: ${error.message}. Keep this source idle and inspect the destination.`) : error));
    socket.on("end", () => { if (!content.includes("\n")) reject(new UnknownRemoteOutcome("Teleport return channel disconnected after submission. Keep this source idle and inspect the destination.")); });
  });
}

/** Release an arrival only after its source publishes a durable commit, even if the readiness acknowledgement was lost. */
export async function confirmArrival(handoff: Pick<ReturnRoute, "socket" | "token"> & { commitFile: string }, ready: Record<string, unknown>): Promise<void> {
  while (!existsSync(handoff.commitFile)) {
    try { await requestController(handoff, { ...ready, action: "ready" }); break; }
    catch (error) {
      // Readiness is idempotent; retry only an inconclusive observation or transport.
      const transportFailure = typeof (error as NodeJS.ErrnoException).code === "string";
      if (!existsSync(handoff.commitFile) && !(error instanceof UnknownRemoteOutcome) && !transportFailure) throw error;
      if (!existsSync(handoff.commitFile)) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  // A timeout alone cannot shut down a living destination. Only the durable source
  // decision releases it; an unconfirmed source remains fenced while this waits.
  await waitForReceipt(handoff.commitFile);
}
/** Wait for an owned durable receipt, never interpreting a timeout as success. */
export async function waitForReceipt(path: string): Promise<any> {
  while (!existsSync(path)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  let result: any;
  try { result = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new UnknownRemoteOutcome(`Teleport's durable receipt is unreadable. Keep the source idle and inspect ${path}.`); }
  if (result.ok !== true) {
    if (result.uncertain) throw new UnknownRemoteOutcome(result.error);
    throw new Error(result.error || "Remote Teleport failed; the source is retained.");
  }
  return result;
}

/** Fail closed on SSH authentication or host-key trust; never forward an SSH agent. */
export const sshOptions = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=10"];

/** Wait for OpenSSH's forward confirmation before submitting an arrival. */
export function waitForForward(child: ChildProcess, dynamic: boolean): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    if (!child.stderr) { reject(new Error("SSH return channel has no confirmation stream.")); return; }
    let output = "";
    const stream = child.stderr;
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer);
      stream.off("data", data);
      stream.resume();
      child.off("error", failed);
      child.off("close", closed);
      if (error) reject(error); else resolve(port);
    };
    const failed = (error: Error) => finish(error);
    const closed = () => finish(new Error("SSH return channel closed before forwarding was confirmed."));
    const data = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
      const allocated = /Allocated port ([0-9]+) for remote forward/.exec(output);
      if (dynamic && allocated) {
        const port = Number(allocated[1]);
        if (port > 0 && port <= 65535) finish(undefined, port);
        else finish(new Error("SSH returned an invalid forwarding port."));
      } else if (!dynamic && output.includes("remote forward success for:")) finish();
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error("SSH did not confirm its return forward.")); }, 30_000);
    stream.on("data", data);
    child.once("error", failed);
    child.once("close", closed);
  });
}

/** Encode the entire program so POSIX shells, PowerShell and cmd receive the same command. */
export function remoteNodeCommand(script: string): string {
  return `node -e "eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString())"`;
}

/** Validate paths using the operating system that produced them. */
export function validProbe(probe: any, fingerprint: string): boolean {
  const absolute = probe?.platform === "win32" ? win32.isAbsolute : posix.isAbsolute;
  return probe?.fingerprint === fingerprint && typeof probe.worker === "string" && absolute(probe.worker) && typeof probe.agentDir === "string" && absolute(probe.agentDir);
}

/** Probe the remote configured Pi runtime without starting a model or changing its installation. */
export function probeRemote(host: string, path: string, expectedFingerprint: string): { fingerprint: string; worker: string; agentDir: string; version: string; command: string[]; core: HerdrContext; platform: NodeJS.Platform } {
  const nonce = randomUUID();
  const prefix = `PI_TELEPORT_PROBE:${nonce}:`;
  const config = JSON.stringify({ path, nonce });
  const program = `const cfg=${config};
const {spawn,spawnSync}=require('node:child_process');
const windows=process.platform==='win32';
const child=spawn(windows?(process.env.ComSpec||'cmd.exe'):'pi',windows?['/d','/s','/c','pi.cmd --approve --help']:['--approve','--help'],{cwd:cfg.path,env:{...process.env,PI_TELEPORT_PROBE:cfg.nonce},stdio:['ignore','pipe','pipe'],windowsHide:true});
child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
const timer=setTimeout(()=>{if(windows&&child.pid)spawnSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore'});else child.kill('SIGKILL');},180000);
child.on('error',error=>{clearTimeout(timer);console.error(error);process.exitCode=1});
child.on('close',code=>{clearTimeout(timer);process.exitCode=code??1});`;
  let output: string;
  try {
    output = execFileSync("ssh", [...sshOptions, host, remoteNodeCommand(program)], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 195_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const cause = error as { code?: string | number; killed?: boolean };
    throw new Error(`Pi could not complete its startup probe on ${host}${cause.killed ? " within three minutes" : ""}. Check Pi and the destination directory; the source is unchanged.`);
  }
  const probes = output.split("\n").filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));
  if (probes.length !== 1 || !validProbe(probes[0], expectedFingerprint)) {
    throw new Error(`Install or update Teleport on ${host} to this implementation, then retry. A usable current Teleport is required for the return journey. The source is unchanged.`);
  }
  return probes[0];
}

/** Resolve one configured SSH profile without using UI focus. */
export function remoteMachine(host: string, context?: HerdrContext): { machine: string; remoteSession: string; desktop?: boolean; sourceContext?: HerdrContext } {
  if (context?.backend === "app") {
    const profiles = runCore(context, ["machine", "ls", "--json"]).machines;
    if (!Array.isArray(profiles)) throw new Error("Core returned no machine profiles.");
    const matches = profiles.filter((profile: any) => profile.target === host && !profile.via && !profile.temporary);
    if (matches.length === 0) {
      const sourceContext = discoverAppDesktop(context, host);
      if (sourceContext) return { machine: "", remoteSession: sourceContext.appSsh?.target === host ? sourceContext.appSsh.session || "default" : "default", desktop: true, sourceContext };
    }
    if (matches.length !== 1 || typeof matches[0].name !== "string" || !matches[0].name || matches[0].name.includes("/") || (matches[0].session != null && typeof matches[0].session !== "string")) throw new Error(`Configure one persistent direct SSH core machine for ${host} before teleporting.`);
    return { machine: matches[0].name, remoteSession: matches[0].session || "default" };
  }
  const profiles = JSON.parse(execFileSync("herdr", ["machine", "list", "--json"], { encoding: "utf8", timeout: 15_000 }));
  const matches = profiles.filter((profile: any) => profile.enabled && profile.target === host);
  if (matches.length !== 1) throw new Error(`Configure one enabled Herdr machine for SSH target ${host} before teleporting.`);
  return { machine: matches[0].id, remoteSession: matches[0].session };
}

/** Detachment does not escape core's terminal sweep token. Drop origin identity too. */
export function independentProcessEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...input };
  for (const name of ["HC_SCOPE", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"]) delete env[name];
  return env;
}

/** Launch a worker in its own unparented core terminal, outside the caller's cleanup scope. */
export function startCoreWorker(context: HerdrContext, cwd: string, argv: string[]): { address: string } {
  const result = runCore(context, ["run", "--no-parent", "--outlive-parent", "--no-notify", "--bg", "--rm", "--json", "--cwd", cwd, ...argv]);
  if (typeof result.address !== "string" || !result.address) throw new UnknownRemoteOutcome("The worker's core terminal is unconfirmed.");
  return { address: result.address };
}
/** Schedule transcript cleanup independently of UI cleanup after a confirmed handoff. */
export function startSessionCleanup(sessionFile: string, sourcePid: number, cwd: string, stateDir: string, context?: HerdrContext): Promise<void> {
  const stat = lstatSync(sessionFile);
  if (!stat.isFile()) throw new Error("The source transcript is not a regular file.");
  const dir = join(stateDir, "cleanup", randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = join(dir, "session.json");
  writeFileSync(config, JSON.stringify({ sourcePid, sessionFile, dev: stat.dev, ino: stat.ino }), { mode: 0o600, flag: "wx" });
  if (context?.backend === "app") {
    startCoreWorker(context, cwd, [process.execPath, "--experimental-strip-types", workerFile, "cleanup-session", config]);
    return Promise.resolve();
  }
  const log = openSync(join(dir, "worker.log"), "ax", 0o600);
  return new Promise((resolve, reject) => {
    try {
      const worker = spawn(process.execPath, ["--experimental-strip-types", workerFile, "cleanup-session", config], { cwd, env: independentProcessEnvironment(), detached: true, windowsHide: true, stdio: ["ignore", log, log] });
      worker.once("error", reject);
      worker.once("spawn", () => { worker.unref(); resolve(); });
    } catch (error) { reject(error); }
    finally { closeSync(log); }
  });
}
/** Keep App cleanup outside the source terminal's lifetime and sweep scope. */
export function startAppSourceCleanup(input: import("./bridge.ts").AppSourceCleanup, stateDir: string): Promise<void> {
  const dir = join(stateDir, "cleanup", randomUUID());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = join(dir, "source.json");
  writeFileSync(config, JSON.stringify(input), { mode: 0o600, flag: "wx" });
  startCoreWorker(input.context, input.cwd, [process.execPath, "--experimental-strip-types", workerFile, "cleanup-app", config]);
  return Promise.resolve();
}
/** Start a narrow detached controller that survives retirement of the source Pi. */
export async function startRemoteMove(move: RemoteMove): Promise<any> {
  const dir = join(move.stateDir, "bridges", move.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const config = join(dir, "request.json");
  writeFileSync(config, JSON.stringify(move), { mode: 0o600, flag: "wx" });
  if (move.herdr.backend === "app") {
    try { startCoreWorker(move.herdr, move.sourceCwd, [process.execPath, "--experimental-strip-types", workerFile, "controller", config]); }
    catch (error) { throw new UnknownRemoteOutcome(`Controller start is unconfirmed: ${String(error)}`); }
    return waitForReceipt(join(dir, "result.json"));
  }
  const log = openSync(join(dir, "controller.log"), "ax", 0o600);
  try {
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerFile, "controller", config], { cwd: move.sourceCwd, env: independentProcessEnvironment(), detached: true, stdio: ["ignore", log, log] });
    worker.once("error", (error) => writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: false, error: `Could not start the Teleport controller: ${error.message}` }), { mode: 0o600, flag: "wx" }));
    worker.unref();
  } finally { closeSync(log); }
  return waitForReceipt(join(dir, "result.json"));
}
