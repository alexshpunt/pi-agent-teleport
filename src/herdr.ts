import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { release } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./remote.ts";
import { discoverWslAppDesktop, parkAppTerminal, runAppOperation } from "./app.ts";

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
  // The receiving login shell may be fish: nested POSIX quote escapes differ.
  // Octal passes only inert ASCII through it; POSIX sh decodes its own script.
  const encoded = [...Buffer.from(script)].map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
  return `sh -c 'eval "$(printf %b "${encoded}")"'`;
}

/** Caller IDs and the CLI connection that owns them. */
export type HerdrContext = { workspaceId: string; tabId: string; paneId: string; session: string; socketPath?: string; backend?: "app"; stateHome?: string; configHome?: string; runtimeDir?: string; appHome?: string; appCli?: string; appMachine?: string; appWindowsInterop?: boolean; appRoute?: { socket: string; token: string; operationId: string }; appSsh?: { target: string; session?: string; stateHome?: string; configHome?: string; runtimeDir?: string; appHome?: string; appCli?: string; coreSocketPath?: string }; coreSocketPath?: string };
/** A workspace and its initial shell, recorded with the owning connection. */
export type HerdrLocation = HerdrContext;

/** Capture native routing without inventing caller IDs, including during an SSH probe. */
export function appConnection(session = process.env.HC_SESSION || "default", env: NodeJS.ProcessEnv = process.env): HerdrContext {
  return { backend: "app", paneId: "", workspaceId: "", tabId: "", session, stateHome: env.XDG_STATE_HOME, configHome: env.XDG_CONFIG_HOME, runtimeDir: env.XDG_RUNTIME_DIR, appHome: env.HERDR_APP_HOME, appCli: env.PI_HERDR_APP_CLI, coreSocketPath: env.HC_TERMINAL_SOCKET || env.HC_SOCKET };
}

/** Locate the Windows App for a WSL terminal without relying on the focused window. */
function wslAppContext(context: HerdrContext): HerdrContext {
  const where = "/mnt/c/Windows/System32/where.exe";
  if (process.platform !== "linux" || !release().toLowerCase().includes("microsoft") || !existsSync(where) || context.appCli) return context;
  let executable: string;
  try {
    const windows = execFileSync(where, ["herdr-app.exe"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).find((line) => line.trim());
    if (!windows) return context;
    executable = execFileSync("wslpath", ["-u", windows.trim()], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return context; }
  return discoverWslAppDesktop(context, executable) || context;
}

/** Enable Herdr only inside a fully identified managed pane. */
export function getHerdrContext(env: NodeJS.ProcessEnv = process.env): HerdrContext | undefined {
  if (env.HC_TERMINAL_ID?.trim()) {
    if (env.HC_SOCKET && env.HC_TERMINAL_SOCKET && env.HC_SOCKET !== env.HC_TERMINAL_SOCKET) throw new Error("The current terminal belongs to a different core socket.");
    const context = { ...appConnection(env.HC_SESSION || "default", env), paneId: env.HC_TERMINAL_ID };
    if (env.PI_TELEPORT_APP_CONTEXT) {
      const saved = JSON.parse(readFileSync(env.PI_TELEPORT_APP_CONTEXT, "utf8")) as HerdrContext;
      const controllerRoute = saved.appRoute && [saved.appRoute.socket, saved.appRoute.token, saved.appRoute.operationId].every((value) => typeof value === "string" && value.length > 0);
      const sshRoute = typeof saved.appSsh?.target === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(saved.appSsh.target);
      const routed = saved.appRoute ? controllerRoute && !saved.appSsh : sshRoute;
      if (saved.backend !== "app" || saved.session !== context.session || !saved.appMachine || saved.appMachine.includes("/") || !routed) throw new Error("The saved App UI route does not match this core connection.");
      context.appMachine = saved.appMachine;
      context.appRoute = saved.appRoute;
      context.appSsh = saved.appSsh;
    }
    const terminal = runCore(context, ["get", context.paneId]);
    if (terminal.address !== context.paneId || terminal.state !== "live" || !terminal.labels?.["herdr.space"] || !terminal.labels?.["herdr.tab"]) throw new Error("This core terminal has no verified Herdr App space and tab.");
    const source = { ...context, workspaceId: terminal.labels["herdr.space"], tabId: terminal.labels["herdr.tab"] };
    return env === process.env && !source.appRoute && !source.appSsh ? wslAppContext(source) : source;
  }
  if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID?.trim() || !env.HERDR_TAB_ID?.trim() || !env.HERDR_PANE_ID?.trim()) return;
  return { workspaceId: env.HERDR_WORKSPACE_ID, tabId: env.HERDR_TAB_ID, paneId: env.HERDR_PANE_ID, session: env.HERDR_SESSION || "default", ...(env.HERDR_SOCKET_PATH ? { socketPath: env.HERDR_SOCKET_PATH } : {}) };
}

/** Pin every core call to the connection captured with its handle. */
export function coreEnvironment(context: HerdrContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HC_SESSION: context.session, HC_TERMINAL_ID: context.paneId };
  for (const [name, value] of Object.entries({ XDG_STATE_HOME: context.stateHome, XDG_CONFIG_HOME: context.configHome, XDG_RUNTIME_DIR: context.runtimeDir, HERDR_APP_HOME: context.appHome, HC_SOCKET: context.coreSocketPath, HC_TERMINAL_SOCKET: context.coreSocketPath, HC_SCOPE: undefined })) {
    if (value === undefined) delete env[name]; else env[name] = value;
  }
  return env;
}

/** Run a public hc query. Its JSON is the result itself, without Herdr's envelope. */
export function runCore(context: HerdrContext, args: string[]): any {
  return JSON.parse(runCoreText(context, args));
}
function runCoreText(context: HerdrContext, args: string[]): string {
  return execFileSync("hc", args, { encoding: "utf8", env: coreEnvironment(context), timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
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
  if (context.backend === "app") {
    if (args[0] === "pane" && args[1] === "run" && args.length === 4) {
      runCore(context, ["send", args[2], args[3]]);
      return { type: "ok" };
    }
    if (args[0] === "pane" && args[1] === "close" && args.length === 3) {
      parkAppTerminal(context, args[2]);
      runCore(context, ["kill", args[2]]);
      runCore(context, ["rm", args[2]]);
      return { type: "ok" };
    }
    if (args[0] === "pane" && args[1] === "process-info" && args[2] === "--pane" && args.length === 4) return { process_info: coreProcessInfo(context, args[3]) };
    return runAppOperation(context, args);
  }
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
  if (context.backend === "app") {
    const terminal = runCore(context, ["get", context.paneId]);
    if (terminal.address !== context.paneId || terminal.state !== "live" || terminal.labels?.["herdr.space"] !== context.workspaceId || terminal.labels?.["herdr.tab"] !== context.tabId) throw new Error("Herdr App caller IDs no longer match the current terminal.");
    return;
  }
  const pane = runHerdr(context, ["pane", "current", "--current"]).pane;
  if (pane?.pane_id !== context.paneId || pane?.tab_id !== context.tabId || pane?.workspace_id !== context.workspaceId) throw new Error("Herdr caller IDs no longer match the current pane.");
}

/** Compare connections before using a persisted Herdr handle. */
export function sameHerdrConnection(a: HerdrContext, b: HerdrContext): boolean {
  return a.backend === b.backend && a.socketPath === b.socketPath && a.session === b.session && a.stateHome === b.stateHome && a.configHome === b.configHome && a.runtimeDir === b.runtimeDir && a.appHome === b.appHome && a.appCli === b.appCli && a.appWindowsInterop === b.appWindowsInterop && a.appMachine === b.appMachine && a.appSsh?.target === b.appSsh?.target && a.appSsh?.session === b.appSsh?.session && a.appSsh?.appHome === b.appSsh?.appHome && a.appSsh?.stateHome === b.appSsh?.stateHome && a.appSsh?.configHome === b.appSsh?.configHome && a.appSsh?.runtimeDir === b.appSsh?.runtimeDir && a.appSsh?.coreSocketPath === b.appSsh?.coreSocketPath && a.appSsh?.appCli === b.appSsh?.appCli && a.coreSocketPath === b.coreSocketPath;
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

/** Observe the whole foreground group, not only core's group leader (often a launch wrapper). */
function coreProcessInfo(context: HerdrContext, paneId: string): any {
  const terminal = runCore(context, ["get", paneId]);
  if (terminal.address !== paneId || terminal.state !== "live" || !Number.isSafeInteger(terminal.pid)) throw new Error("The addressed core terminal is not live.");
  if (process.platform === "win32") {
    const info = JSON.parse(execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      fileURLToPath(new URL("./process-info.ps1", import.meta.url)), String(terminal.pid)], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }));
    if (info?.shell_pid !== terminal.pid || typeof info.shell_owns_foreground !== "boolean" || !Array.isArray(info.foreground_processes) ||
        (info.shell_owns_foreground && (info.foreground_processes.length !== 1 || info.foreground_processes[0]?.pid !== terminal.pid)) ||
        !info.foreground_processes.every((item: any) => Number.isSafeInteger(item.pid) && item.pid > 0 && typeof item.cwd === "string" && item.cwd.length > 0 &&
          Array.isArray(item.argv) && item.argv.length > 0 && item.argv.every((arg: unknown) => typeof arg === "string"))) throw new Error("Invalid native Windows process observation.");
    return info;
  }
  if (process.platform !== "linux") throw new Error("Native core process observation is not implemented on this platform.");
  const stat = (pid: number) => {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    return content.slice(content.lastIndexOf(")") + 2).trim().split(/\s+/);
  };
  const shell = stat(terminal.pid);
  // Core's foreground record is sampled; /proc stat exposes the terminal's live tpgid.
  const group = Number(shell[4]) !== 0 ? Number(shell[5]) : terminal.foreground?.pid;
  const processes: Array<{ pid: number; cwd: string; argv: string[] }> = [];
  if (Number.isSafeInteger(group) && group > 0) {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const before = stat(pid);
        if (Number(before[2]) !== group || before[3] !== shell[3]) continue;
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
        const after = stat(pid);
        if (after[19] === before[19] && after[2] === before[2] && after[3] === before[3]) processes.push({ pid, cwd, argv });
      } catch { /* A process can exit while /proc is being read. */ }
    }
  }
  return { shell_pid: terminal.pid, foreground_process_group_id: group, foreground_processes: processes };
}
/** True only when the shell, rather than a command or agent, owns the foreground. */
export function isHerdrShell(context: HerdrContext, paneId: string): boolean {
  return shellOwnsForeground(runHerdr(context, ["pane", "process-info", "--pane", paneId]).process_info);
}

/** Interpret a `pane process-info` result: the shell is back in the foreground. */
export function shellOwnsForeground(info: { shell_pid?: number; shell_owns_foreground?: boolean; foreground_process_group_id?: number } | undefined): boolean {
  return !!info?.shell_pid && (typeof info.shell_owns_foreground === "boolean" ? info.shell_owns_foreground : info.foreground_process_group_id === info.shell_pid);
}

/** Append the destination's own terminal or process output to a failure. */
export function withOutput(message: string, output: string | undefined): string {
  return output?.trim() ? `${message}\nDestination output:\n${output.trim()}` : message;
}

/** Read a pane's recent terminal text, or undefined when Herdr cannot provide it. Use `machine` for a saved remote Herdr machine. */
export function readHerdrPane(context: HerdrContext, paneId: string, machine?: string): string | undefined {
  try {
    if (context.backend === "app") {
      if (machine) throw new Error("Read remote core output through its owning endpoint.");
      return runCoreText(context, ["read", paneId, "--lines", "80"]).trim() || undefined;
    }
    const args = [...(machine ? ["--machine", machine] : []), "pane", "read", paneId, "--source", "recent", "--lines", "80"];
    const output = execFileSync("herdr", args, { encoding: "utf8", env: machine ? process.env : herdrEnvironment(context), timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    const lines = output.split("\n").map((line) => line.trimEnd());
    while (lines.length && !lines.at(-1)) lines.pop();
    return lines.join("\n").trim() || undefined;
  } catch { return undefined; }
}
