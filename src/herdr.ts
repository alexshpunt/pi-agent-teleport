import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { shellQuote } from "./remote.ts";

/** Encode a script so the receiving Windows shell never parses paths or handoff JSON. */
export function powershellCommand(script: string): string {
  return `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

export function powershellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/** Publish a launch exit even when Pi dies before the first process observation. */
export function guardedLaunch(argv: string[], receipt: string, env: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): string {
  const temporary = `${receipt}.exit.tmp`;
  if (platform === "win32") {
    const quote = powershellQuote;
    return powershellCommand([
      "$ErrorActionPreference = 'Stop'",
      ...Object.entries(env).map(([name, value]) => `[Environment]::SetEnvironmentVariable(${quote(name)}, ${quote(value)}, 'Process')`),
      "$status = 1",
      `try { $global:LASTEXITCODE = 0; & ${argv.map(quote).join(" ")}; $status = $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.ToString()) }`,
      `if ([IO.Directory]::Exists([IO.Path]::GetDirectoryName(${quote(receipt)}))) {`,
      `  $json = @{ok = $false; error = "Destination Pi exited (status $status)."} | ConvertTo-Json -Compress`,
      `  [IO.File]::WriteAllText(${quote(temporary)}, $json, (New-Object Text.UTF8Encoding $false))`,
      `  Move-Item -LiteralPath ${quote(temporary)} -Destination ${quote(receipt)} -Force`,
      "}",
    ].join("\n"));
  }
  const command = [...Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`), ...argv.map(shellQuote)].join(" ");
  const script = `${command}; status=$?; if [ -d ${shellQuote(dirname(receipt))} ]; then printf '{"ok":false,"error":"Destination Pi exited (status %s)."}\\n' "$status" > ${shellQuote(temporary)} && mv ${shellQuote(temporary)} ${shellQuote(receipt)}; fi`;
  return `sh -c ${shellQuote(script)}`;
}

/** Caller IDs and the CLI connection that owns them. */
export type HerdrContext = { workspaceId: string; tabId: string; paneId: string; session: string; socketPath?: string };
/** A workspace and its initial shell, recorded with the owning connection. */
export type HerdrLocation = HerdrContext;

/** Enable Herdr only inside a fully identified managed pane. */
export function getHerdrContext(env: NodeJS.ProcessEnv = process.env): HerdrContext | undefined {
  if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID?.trim() || !env.HERDR_TAB_ID?.trim() || !env.HERDR_PANE_ID?.trim()) return;
  return { workspaceId: env.HERDR_WORKSPACE_ID, tabId: env.HERDR_TAB_ID, paneId: env.HERDR_PANE_ID, session: env.HERDR_SESSION || "default", ...(env.HERDR_SOCKET_PATH ? { socketPath: env.HERDR_SOCKET_PATH } : {}) };
}

/** Address the caller's connection, never the UI-focused session. */
function herdrEnvironment(context: HerdrContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: context.workspaceId, HERDR_TAB_ID: context.tabId, HERDR_PANE_ID: context.paneId, HERDR_SESSION: context.session };
  if (context.socketPath) env.HERDR_SOCKET_PATH = context.socketPath;
  else delete env.HERDR_SOCKET_PATH;
  return env;
}

/** Run the public CLI against the caller's connection, never the UI-focused session. */
export function runHerdr(context: HerdrContext, args: string[]): any {
  const env = herdrEnvironment(context);
  try {
    const output = execFileSync("herdr", args, { encoding: "utf8", env, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
    // pane run acknowledges successful delivery with no JSON body.
    if (!output && args[0] === "pane" && args[1] === "run") return { type: "ok" };
    if (!output) throw new Error(`Herdr returned an empty response to ${args.join(" ")}.`);
    const response = JSON.parse(output);
    if (response.error || !response.result) throw new Error(response.error?.message || "Herdr returned no result.");
    return response.result;
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(stderr || (error instanceof Error ? error.message : String(error)));
  }
}

/** Refuse stale or forged caller IDs before changing Herdr state. */
export function assertHerdrContext(context: HerdrContext): void {
  const pane = runHerdr(context, ["pane", "current", "--current"]).pane;
  if (pane?.pane_id !== context.paneId || pane?.tab_id !== context.tabId || pane?.workspace_id !== context.workspaceId) throw new Error("Herdr caller IDs no longer match the current pane.");
}

/** Compare connections before using a persisted Herdr handle. */
export function sameHerdrConnection(a: HerdrContext, b: HerdrContext): boolean {
  return a.socketPath === b.socketPath && a.session === b.session;
}

/** Read IDs from a creation/open response and verify its checkout path. */
export function herdrLocation(context: HerdrContext, result: any, path?: string): HerdrLocation {
  const workspaceId = result.workspace?.workspace_id;
  const tabId = result.tab?.tab_id;
  const paneId = result.root_pane?.pane_id;
  if (!workspaceId || !tabId || !paneId || result.tab.workspace_id !== workspaceId || result.root_pane.workspace_id !== workspaceId || result.root_pane.tab_id !== tabId) throw new Error("Herdr did not return matching workspace, tab, and pane IDs.");
  if (path && (!result.worktree?.path || realpathSync(result.worktree.path) !== realpathSync(path))) throw new Error("Herdr returned a different checkout path.");
  return { ...context, workspaceId, tabId, paneId };
}

/** True only when the shell, rather than a command or agent, owns the foreground. */
export function isHerdrShell(context: HerdrContext, paneId: string): boolean {
  return shellOwnsForeground(runHerdr(context, ["pane", "process-info", "--pane", paneId]).process_info);
}

/** Interpret a `pane process-info` result: the shell is back in the foreground. */
export function shellOwnsForeground(info: { shell_pid?: number; foreground_process_group_id?: number } | undefined): boolean {
  return !!info?.shell_pid && info.foreground_process_group_id === info.shell_pid;
}

/** Append the destination's own terminal or process output to a failure. */
export function withOutput(message: string, output: string | undefined): string {
  return output?.trim() ? `${message}\nDestination output:\n${output.trim()}` : message;
}

/** Read a pane's recent terminal text, or undefined when Herdr cannot provide it. Use `machine` for a saved remote Herdr machine. */
export function readHerdrPane(context: HerdrContext, paneId: string, machine?: string): string | undefined {
  try {
    const args = [...(machine ? ["--machine", machine] : []), "pane", "read", paneId, "--source", "recent", "--lines", "80"];
    const output = execFileSync("herdr", args, { encoding: "utf8", env: machine ? process.env : herdrEnvironment(context), timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    const lines = output.split("\n").map((line) => line.trimEnd());
    while (lines.length && !lines.at(-1)) lines.pop();
    return lines.join("\n").trim() || undefined;
  } catch { return undefined; }
}
