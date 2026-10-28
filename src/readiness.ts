import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { readHerdrPane, runHerdr, shellOwnsForeground, withOutput, type HerdrContext } from "./herdr.ts";
import { hasSessionProcess, piCommand } from "./remote.ts";

/** A destination Pi's own verdict on whether it can continue the session. */
export type Readiness = { ok: true; pid: number; cwd: string; sessionFile: string } | { ok: false; error: string };

/** Publish a readiness verdict atomically, so a reader never sees a partial receipt. */
export function writeReadiness(path: string, readiness: Readiness): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(readiness), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

function readReadiness(path: string): Readiness | undefined {
  if (!existsSync(path)) return;
  try { return JSON.parse(readFileSync(path, "utf8")) as Readiness; }
  catch { return { ok: false, error: `Destination readiness receipt is unreadable: ${path}` }; }
}


/**
 * Wait for startup to report readiness, without a deadline. A process alone is
 * insufficient: a later startup hook can still fail before the session is usable.
 */
export async function awaitHerdrArrival(context: HerdrContext, paneId: string, sessionFile: string, receipt: string): Promise<void> {
  let running = false;
  while (true) {
    const readiness = readReadiness(receipt);
    if (readiness && !readiness.ok) throw new Error(withOutput(`Destination Pi cannot continue this session: ${readiness.error}`, readHerdrPane(context, paneId)));
    let info;
    try { info = runHerdr(context, ["pane", "process-info", "--pane", paneId]).process_info; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
    if (readiness?.ok) {
      if (!hasSessionProcess(info?.foreground_processes, readiness.pid, readiness.cwd, sessionFile)) throw new Error("The ready destination Pi is not running in its Herdr pane.");
      return;
    }
    if (info?.foreground_processes?.length && !shellOwnsForeground(info)) running = true;
    else if (shellOwnsForeground(info) && running) {
      // The verdict may have landed between the two reads.
      if (existsSync(receipt)) continue;
      throw new Error(withOutput("Destination Pi exited before it was ready.", readHerdrPane(context, paneId)));
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const SESSION_FLAGS_WITH_VALUE = new Set(["--session", "--session-id", "--fork", "--export", "--name", "-n"]);
const SESSION_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--no-session", "--print", "-p", "--help", "-h", "--version", "-v"]);
const isValue = (next: string | undefined) => next !== undefined && !next.startsWith("-");

/**
 * Keep the current process's runtime flags, such as extensions, models, tools and trust,
 * and drop session selection, output mode and prompt messages.
 */
export function preflightArguments(argv: string[]): string[] {
  const kept: string[] = [];
  let positional = 0;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") break;
    // Parse each prefix so values of value-taking flags are never mistaken for messages.
    const parsed = parseArgs(argv.slice(0, index + 1));
    const count = parsed.messages.length + parsed.fileArgs.length;
    if (count > positional) { positional = count; continue; }
    if (SESSION_FLAGS.has(arg)) continue;
    if (SESSION_FLAGS_WITH_VALUE.has(arg)) { if (index + 1 < argv.length) index++; continue; }
    if (arg === "--mode" || arg === "--tui-mode") { if (isValue(argv[index + 1])) index++; continue; }
    if (arg === "--list-models") { if (isValue(argv[index + 1]) && !argv[index + 1].startsWith("@")) index++; continue; }
    kept.push(arg);
  }
  return kept;
}

function tail(text: string, limit = 16_384): string { return text.length > limit ? text.slice(-limit) : text; }

/**
 * Start a separate Pi with a copy of the session at the destination and wait for its verdict.
 * The copy gets its own session ID, so other extensions never see a second live owner.
 * Throws the destination's exact failure; nothing in the current process changes.
 */
export async function preflightSession(input: { target: string; sessionText: string }): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pi-teleport-preflight-"));
  try {
    const [header, ...entries] = input.sessionText.trimEnd().split("\n");
    const session = join(dir, "session.jsonl");
    writeFileSync(session, `${[JSON.stringify({ ...JSON.parse(header), id: randomUUID(), cwd: input.target }), ...entries].join("\n")}\n`, { mode: 0o600 });
    const receipt = join(dir, "ready.json");
    const env: NodeJS.ProcessEnv = { ...process.env, PI_TELEPORT_PREFLIGHT: receipt };
    // The check must not register as an agent in the caller's terminal or join a handoff.
    for (const name of Object.keys(env)) if (name.startsWith("HERDR_") || name === "PI_TELEPORT_CONTINUATION" || name === "PI_TELEPORT_HANDOFF") delete env[name];
    const [command, ...prefix] = piCommand();
    // Relative CLI paths resolve against this process's launch directory, as in the current runtime.
    const child = spawn(command, [...prefix, ...preflightArguments(process.argv.slice(2)), "--mode", "rpc", "--session", session], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buffered = "";
    const outcome = await new Promise<{ kind: "started" } | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null } | { kind: "error"; error: Error }>((resolve) => {
      const done = resolve;
      child.once("error", (error) => done({ kind: "error", error }));
      child.once("exit", (code, signal) => done({ kind: "exited", code, signal }));
      child.stdin.on("error", () => {});
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = tail(stderr + chunk); });
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buffered += chunk;
        let end: number;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          let message: any;
          try { message = JSON.parse(line); } catch { stdout = tail(`${stdout}${line}\n`); continue; }
          if (message.type === "response" && message.id === "teleport-preflight") done({ kind: "started" });
          // Nobody can answer a dialog in the check; decline it instead of stalling.
          else if (message.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(message.method)) {
            child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`);
          } else if (message.type === "extension_error") stdout = tail(`${stdout}Extension error in ${message.extensionPath} (${message.event}): ${message.error}\n`);
        }
      });
      // RPC mode reads commands only after startup, including session_start, has finished.
      child.stdin.write(`${JSON.stringify({ id: "teleport-preflight", type: "get_state" })}\n`);
    });
    if (outcome.kind !== "error" && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killer);
    }
    const readiness = readReadiness(receipt);
    const output = stderr.trim() || stdout.trim();
    if (readiness && !readiness.ok) throw new Error(`Destination Pi cannot continue this session: ${readiness.error}`);
    // A verdict counts only once startup has finished; Pi can still fail after reporting it.
    if (readiness?.ok && outcome.kind === "started") return;
    if (outcome.kind === "started") throw new Error(withOutput("Destination Pi started without loading this Teleport extension, so the session could not continue or return from there.", output));
    if (outcome.kind === "error") throw new Error(`Could not start destination Pi: ${outcome.error.message}`);
    throw new Error(withOutput(`Destination Pi exited before it was ready (${outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.code}`}).`, output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
