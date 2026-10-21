import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TeleportState } from "./core.ts";
import type { HerdrContext } from "./herdr.ts";
import type { TeleportExecution } from "./output.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));
export const extensionFile = join(sourceDir, "index.ts");
export const workerFile = join(sourceDir, "bridge.ts");
export const MAX_PACKET = 64 * 1024 * 1024;
export const HANDOFF_TIMEOUT = 45_000;

/** An unconfirmed commit must leave the source idle, not launch a competing continuation. */
export class UnknownRemoteOutcome extends Error {}

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
};

/** Resolve local paths or a trusted OpenSSH alias with an absolute remote path. */
export function parseTarget(value: string, cwd: string, currentMachine?: string): { host?: string; path: string } {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Teleport destinations cannot contain control characters.");
  if (!value.includes("://")) return { path: resolve(cwd, value) };
  const match = /^ssh:\/\/((?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*)(\/.*)$/.exec(value);
  if (!match || match[2] === "/") throw new Error("Use ssh://SSH_ALIAS/absolute/directory. Put ports and connection options in OpenSSH config.");
  const path = resolve("/", match[2]);
  return match[1] === currentMachine ? { path } : { host: match[1], path };
}

/** Include machine identity without mistaking remote paths for local files. */
export function qualifyLocation(path: string, machine?: string): string { return machine ? `ssh://${machine}${path}` : path; }
/** Quote exactly one argument for the remote login shell. */
export function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
/** Locate the current host's agent directory without copying controller settings. */
export function agentDirectory(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }
/** Fingerprint executable Teleport files, not Pi or unrelated extensions. */
export function runtimeFingerprint(): string {
  const hash = createHash("sha256");
  for (const name of ["index.ts", "core.ts", "herdr.ts", "remote.ts", "bridge.ts", "output.ts"]) hash.update(name).update(readFileSync(join(sourceDir, name)));
  return hash.digest("hex");
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
export function hasSessionProcess(processes: Array<{ pid: number; cwd?: string; argv?: string[] }> | undefined, pid: number, cwd: string, sessionFile: string): boolean {
  return !!processes?.some((process) => {
    if (process.pid !== pid || process.cwd !== cwd) return false;
    const argument = process.argv?.indexOf("--session") ?? -1;
    return argument < 0 || process.argv?.[argument + 1] === sessionFile;
  });
}
/** Send one bounded authenticated message over an owned Unix socket. */
export function requestController(route: Pick<ReturnRoute, "socket" | "token">, payload: Record<string, unknown>, timeout = HANDOFF_TIMEOUT): Promise<any> {
  return new Promise((resolve, reject) => {
    const message = `${JSON.stringify({ ...payload, token: route.token })}\n`;
    if (Buffer.byteLength(message) > MAX_PACKET) { reject(new Error("Teleport session exceeds the 64 MiB transfer limit.")); return; }
    const socket = createConnection(route.socket);
    let content = "";
    let submitted = false;
    socket.setEncoding("utf8");
    socket.setTimeout(timeout, () => socket.destroy(new Error("Teleport controller timed out. Keep the current session and inspect the handoff before retrying.")));
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
  try { await requestController(handoff, { ...ready, action: "ready" }); }
  catch (error) { if (!(error instanceof UnknownRemoteOutcome)) throw error; }
  await waitForReceipt(handoff.commitFile, HANDOFF_TIMEOUT + 30_000);
}
/** Wait for an owned durable receipt, never interpreting a timeout as success. */
export async function waitForReceipt(path: string, timeout = HANDOFF_TIMEOUT): Promise<any> {
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new UnknownRemoteOutcome(`Teleport outcome is unconfirmed. Keep the source idle and inspect ${path} before retrying.`);
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

/** Probe the remote configured Pi runtime without starting a model or changing its installation. */
export function probeRemote(host: string, path: string, expectedFingerprint: string): { fingerprint: string; worker: string; agentDir: string; version: string } {
  const nonce = randomUUID();
  const prefix = `PI_TELEPORT_PROBE:${nonce}:`;
  const output = execFileSync("ssh", [...sshOptions, host, `cd ${shellQuote(path)} && PI_TELEPORT_PROBE=${shellQuote(nonce)} pi --approve --help`], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const probes = output.split("\n").filter((line) => line.startsWith(prefix)).map((line) => JSON.parse(line.slice(prefix.length)));
  if (probes.length !== 1 || probes[0].fingerprint !== expectedFingerprint || (!probes[0].worker?.startsWith("/") || !probes[0].agentDir?.startsWith("/"))) {
    throw new Error(`Install or update Teleport on ${host} to this implementation, then retry. A usable current Teleport is required for the return journey. The source is unchanged.`);
  }
  return probes[0];
}

/** Keep only a matching enabled native Herdr machine, never its focused pane. */
export function remoteMachine(host: string): { machine: string; remoteSession: string } {
  const profiles = JSON.parse(execFileSync("herdr", ["machine", "list", "--json"], { encoding: "utf8", timeout: 15_000 }));
  const matches = profiles.filter((profile: any) => profile.enabled && profile.target === host);
  if (matches.length !== 1) throw new Error(`Configure one enabled Herdr machine for SSH target ${host} before teleporting.`);
  return { machine: matches[0].id, remoteSession: matches[0].session };
}

/** Start a narrow detached controller that survives retirement of the source Pi. */
export async function startRemoteMove(move: RemoteMove): Promise<any> {
  const dir = join(move.stateDir, "bridges", move.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const config = join(dir, "request.json");
  writeFileSync(config, JSON.stringify(move), { mode: 0o600, flag: "wx" });
  const log = openSync(join(dir, "controller.log"), "ax", 0o600);
  try {
    const worker = spawn(process.execPath, ["--experimental-strip-types", workerFile, "controller", config], { cwd: move.sourceCwd, detached: true, stdio: ["ignore", log, log] });
    worker.once("error", (error) => writeFileSync(join(dir, "result.json"), JSON.stringify({ ok: false, error: `Could not start the Teleport controller: ${error.message}` }), { mode: 0o600, flag: "wx" }));
    worker.unref();
  } finally { closeSync(log); }
  return waitForReceipt(join(dir, "result.json"), HANDOFF_TIMEOUT * 4);
}
