import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { coreEnvironment, type HerdrContext } from "./herdr.ts";
import type { ArrivalPlacement } from "./core.ts";
import { UnknownRemoteOutcome, sshOptions, workerFile } from "./remote.ts";
import { defaultAppCliName, resolveAppCli, runningInWsl } from "./app-binary.ts";

export type AppSpace = { id: string; name?: string; folder?: string; machine?: string | null; tabs: Array<{ id: string; name?: string; terminals: Array<{ terminal: string; pane: string }> }> };
class AppCommandError extends Error {
  readonly reply: string;
  constructor(reply: string) { super(reply); this.reply = reply; }
}

/** Use the public window CLI, never the private layout document. */
export function runApp(context: HerdrContext, args: string[]): any {
  if (context.appRoute) {
    let output: string;
    try {
      output = execFileSync(process.execPath, ["--experimental-strip-types", workerFile, "app-request"], {
        input: JSON.stringify({ route: context.appRoute, args }), encoding: "utf8", timeout: 40_000, maxBuffer: 16 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (!stdout?.trim()) throw new UnknownRemoteOutcome("The App UI request has no confirmed receipt.");
      output = stdout;
    }
    let reply: any;
    try { reply = JSON.parse(output); } catch { throw new UnknownRemoteOutcome("The App UI receipt is unreadable."); }
    if (reply.ok !== true) {
      if (reply.ok === false && typeof reply.error === "string" && !reply.uncertain) throw new Error(reply.error);
      throw new UnknownRemoteOutcome(reply.error || "The App UI outcome is unconfirmed.");
    }
    if (typeof reply.result?.error === "string") throw new AppCommandError(reply.result.error);
    return reply.result;
  }
  let output: string;
  try {
    if (context.appSsh) {
      const route = context.appSsh;
      if (!/^(?:[A-Za-z0-9][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(route.target)) throw new Error("Use a trusted OpenSSH alias for the App desktop.");
      // Only base64 enters the receiving shell, including Windows cmd/PowerShell.
      // Execute the public CLI there; never export this remote core's routing.
      const script = `const cfg=${JSON.stringify({ ...route, args })};
const {execFileSync}=require("node:child_process");
const env={...process.env,HC_SESSION:cfg.session||"default"};
const routing={HC_SOCKET:cfg.coreSocketPath,HC_TERMINAL_SOCKET:cfg.coreSocketPath,HC_TERMINAL_ID:undefined,HC_SCOPE:undefined,XDG_STATE_HOME:cfg.stateHome,XDG_CONFIG_HOME:cfg.configHome,XDG_RUNTIME_DIR:cfg.runtimeDir,HERDR_APP_HOME:cfg.appHome};
for(const [key,value] of Object.entries(routing)){if(value===undefined)delete env[key];else env[key]=value;}
try{process.stdout.write(execFileSync(cfg.appCli||(process.platform==="win32"?"herdr-app.exe":"herdr-app"),cfg.args,{encoding:"utf8",env,timeout:40000,maxBuffer:16*1024*1024,windowsHide:true,stdio:["ignore","pipe","pipe"]}));}
catch(error){if(error.stdout)process.stdout.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);process.exitCode=1;}`;
      const encoded = Buffer.from(script).toString("base64");
      output = execFileSync("ssh", [...sshOptions, route.target, `node -e "eval(Buffer.from('${encoded}','base64').toString())"`], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      const options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8", env: coreEnvironment(context), timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] };
      const program = context.appCli || defaultAppCliName();
      try { output = execFileSync(program, args, options); }
      catch (error) {
        // A program that did not start ran nothing, so looking for it elsewhere and repeating the call is safe.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const found = resolveAppCli(context.appCli);
        if (found === program) throw new Error(`The Herdr App command-line program "${program}" was not found. Set PI_HERDR_APP_CLI to its full path.`);
        output = execFileSync(found, args, options);
      }
    }
  } catch (error) {
    const stdout = (error as { stdout?: Buffer | string }).stdout?.toString();
    // A JSON rejection is a window verdict; a missing reply is not permission to replay.
    if (!stdout?.trim()) throw error;
    output = stdout;
  }
  const response = JSON.parse(output);
  if (!response || typeof response !== "object") throw new Error("Herdr App returned no structured response.");
  if (typeof response.error === "string") throw new AppCommandError(response.error);
  return response;
}

/** The authenticated controller exposes only this machine's narrow public UI surface. */
export function runAppProxy(context: HerdrContext, machine: string, args: string[]): any {
  if (context.backend !== "app" || !machine || machine.includes("/") || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Invalid App UI route.");
  if (args.length === 1 && args[0] === "ls") {
    const result = runApp(context, args);
    if (!Array.isArray(result.spaces)) throw new Error("Herdr App returned no spaces.");
    return { spaces: result.spaces.filter((space: AppSpace) => space.machine === machine) };
  }
  const allowed: Record<string, string[]> = {
    "space.new": ["folder", "name", "tab", "machine", "focus"],
    "tab.new": ["space", "folder", "name", "focus"],
    "tab.rename": ["id", "name"],
    "tab.close": ["id", "confirmed"],
    "space.close": ["id", "confirmed"],
    "terminal.park": ["terminal"],
  };
  if (args.length !== 3 || args[0] !== "do" || !Object.hasOwn(allowed, args[1])) throw new Error("This App UI command is not routed.");
  const input = JSON.parse(args[2]);
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed[args[1]].includes(key))) throw new Error("This App UI payload is not routed.");
  if (args[1] === "space.new") {
    if (input.machine !== machine) throw new Error("The workspace belongs to another machine.");
  } else {
    const id = input[args[1] === "tab.new" ? "space" : args[1] === "terminal.park" ? "terminal" : "id"];
    const prefix = `${machine}/`;
    if (typeof id !== "string" || !id.startsWith(prefix) || !id.slice(prefix.length) || id.slice(prefix.length).includes("/")) throw new Error("The UI handle belongs to another machine.");
  }
  try { return runApp(context, args); }
  catch (error) {
    // Preserve a window's structured validation verdict across the authenticated
    // channel; transport/authentication failures must never authorize replay.
    if (error instanceof AppCommandError) return { error: error.reply };
    throw error;
  }
}

/** Identify an SSH destination as this source terminal's desktop by its exact UI handles. */
export function discoverAppDesktop(context: HerdrContext, target: string): HerdrContext | undefined {
  const route = { target, ...(context.appSsh?.target === target && context.appSsh.session ? { session: context.appSsh.session } : {}) };
  const result = runApp({ ...context, appRoute: undefined, appSsh: route }, ["ls"]);
  if (!Array.isArray(result.spaces)) throw new Error("Herdr App returned no spaces.");
  const matches = (result.spaces as AppSpace[]).filter((space) => {
    const machine = space.machine;
    return typeof machine === "string" && !!machine && !machine.includes("/") && space.id === `${machine}/${context.workspaceId}` && Array.isArray(space.tabs) && space.tabs.some((tab) => tab.id === `${machine}/${context.tabId}` && Array.isArray(tab.terminals) && tab.terminals.some((terminal) => terminal.terminal === `${machine}/${context.paneId}`));
  });
  if (matches.length !== 1 || (context.appMachine && context.appMachine !== matches[0].machine)) return;
  return { ...context, appMachine: matches[0].machine!, ...(context.appRoute || context.appSsh ? {} : { appSsh: route }) };
}

/**
 * The machine under which the App lists this terminal. The App lists a WSL core's terminals as
 * `<machine>/<id>` and the desktop's own as plain IDs; the machine is known only from the listing,
 * by the terminal, tab and space IDs together. `PI_HERDR_APP_MACHINE` overrides (empty means the
 * App's own machine). An ambiguous or missing match, or a failing App, gives no machine.
 */
export function detectAppMachine(context: HerdrContext, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.PI_HERDR_APP_MACHINE !== undefined) return env.PI_HERDR_APP_MACHINE || undefined;
  if (context.appRoute || context.appSsh || !runningInWsl()) return undefined;
  try {
    const result = runApp(context, ["ls"]);
    if (!Array.isArray(result.spaces)) return undefined;
    const hosts = (space: AppSpace, prefix: string) => space.id === `${prefix}${context.workspaceId}` && Array.isArray(space.tabs) && space.tabs.some((tab) => tab.id === `${prefix}${context.tabId}` && Array.isArray(tab.terminals) && tab.terminals.some((terminal) => terminal.terminal === `${prefix}${context.paneId}`));
    const spaces = result.spaces as AppSpace[];
    if (spaces.some((space) => !space.machine && hosts(space, ""))) return undefined;
    const matches = spaces.filter((space) => typeof space.machine === "string" && !!space.machine && !space.machine.includes("/") && hosts(space, `${space.machine}/`));
    return matches.length === 1 ? matches[0].machine! : undefined;
  } catch { return undefined; }
}

/** Negotiate with the running window, not potentially stale CLI metadata. */
export function createAppItem(context: HerdrContext, command: "space.new" | "tab.new", args: Record<string, unknown>): any {
  try { return runApp(context, ["do", command, JSON.stringify({ ...args, focus: false })]); }
  catch (error) {
    // This exact validation rejects the request before any command runs. No other
    // error, disconnect or timeout can safely authorize a second creation.
    if (!(error instanceof AppCommandError) || !error.reply.startsWith(`${command}: unknown argument(s): focus; valid arguments: `)) throw error;
    return runApp(context, ["do", command, JSON.stringify(args)]);
  }
}

/** UI IDs are qualified; core IDs belong to the process's captured connection. */
function uiId(context: HerdrContext, id: string): string {
  if (!id || id.includes("/")) throw new Error("Expected an unqualified native core handle.");
  return context.appMachine ? `${context.appMachine}/${id}` : id;
}
function coreId(context: HerdrContext, value: unknown): string {
  if (typeof value !== "string") throw new Error("Herdr App returned no native handle.");
  const prefix = context.appMachine ? `${context.appMachine}/` : "";
  if (!value.startsWith(prefix)) throw new Error("Herdr App returned a handle for another machine.");
  const id = value.slice(prefix.length);
  if (!id || id.includes("/")) throw new Error("Herdr App returned a handle outside the connected machine.");
  return id;
}

export function appSpaces(context: HerdrContext): AppSpace[] {
  const result = runApp(context, ["ls"]);
  if (!Array.isArray(result.spaces)) throw new Error("Herdr App returned no spaces.");
  return (result.spaces as AppSpace[])
    .filter((space) => context.appMachine ? space.machine === context.appMachine : !space.machine)
    .map((space) => ({
      ...space, machine: undefined, id: coreId(context, space.id),
      tabs: space.tabs.map((tab) => ({
        ...tab, id: coreId(context, tab.id),
        terminals: tab.terminals.map((pane) => ({ terminal: coreId(context, pane.terminal), pane: coreId(context, pane.pane) })),
      })),
    }));
}

/** The names of this terminal's space and tab, for an arrival on another machine; numbered tab names are positions, not names. */
export function appPlacement(context: HerdrContext): ArrivalPlacement | undefined {
  if (context.backend !== "app") return undefined;
  const space = appSpaces(context).find((space) => space.id === context.workspaceId);
  if (typeof space?.name !== "string" || !space.name.trim()) return undefined;
  const tab = space.tabs.find((tab) => tab.id === context.tabId)?.name;
  return { space: space.name, ...(typeof tab === "string" && tab.trim() && !/^\d+$/.test(tab) ? { tab } : {}) };
}

/** Verify that the addressed window hosts this source terminal before routing a handoff. */
export function assertAppHost(context: HerdrContext): void {
  const matches = appSpaces(context).filter((space) => space.id === context.workspaceId && space.tabs.some((tab) => tab.id === context.tabId && tab.terminals.some((terminal) => terminal.terminal === context.paneId)));
  if (matches.length !== 1) throw new Error("The addressed Herdr App window does not uniquely host this terminal.");
}
export function appSpace(context: HerdrContext, id: string): AppSpace {
  const space = appSpaces(context).find((space) => !space.machine && space.id === id);
  if (!space) throw new Error("The addressed space is not in the connected Herdr App window.");
  return space;
}

/** Wait for parking's asynchronous core update before ending the terminal. */
export function parkAppTerminal(context: HerdrContext, terminal: string): void {
  const addressed = uiId(context, terminal);
  const result = runApp(context, ["do", "terminal.park", JSON.stringify({ terminal: addressed })]);
  if (result.pending !== true || result.terminal !== addressed) throw new Error("Herdr App did not acknowledge parking this terminal.");
  const deadline = Date.now() + 15_000;
  while (appSpaces(context).some((space) => space.tabs.some((tab) => tab.terminals.some((pane) => pane.terminal === terminal)))) {
    if (Date.now() >= deadline) throw new Error("Herdr App has not confirmed removing the terminal's pane; the core terminal is retained.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** Normalize a public creation result to Teleport's connection-bound location. */
export function appCreation(context: HerdrContext, result: any): any {
  const space = coreId(context, result.space);
  const tab = coreId(context, result.tab);
  const terminal = coreId(context, result.terminal);
  return {
    workspace: { workspace_id: space, pane_count: 1 },
    tab: { tab_id: tab, workspace_id: space },
    root_pane: { pane_id: terminal, tab_id: tab, workspace_id: space },
  };
}

/** UI operations shared by local and controller-backed App connections. */
export function runAppOperation(context: HerdrContext, args: string[]): any {
  const [kind, action] = args;
  const option = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}.`);
    return args[index + 1];
  };
  if (kind === "tab" && action === "create") return appCreation(context, createAppItem(context, "tab.new", { space: uiId(context, option("--workspace")), folder: option("--cwd"), name: option("--label") }));
  if (kind === "workspace" && action === "create") return appCreation(context, createAppItem(context, "space.new", { folder: option("--cwd"), name: option("--label"), tab: args.includes("--tab-label") ? option("--tab-label") : option("--label"), machine: context.appMachine || "" }));
  if ((kind === "tab" || kind === "workspace") && action === "close" && args.length === 3) return runApp(context, ["do", kind === "tab" ? "tab.close" : "space.close", JSON.stringify({ id: uiId(context, args[2]), confirmed: true })]);
  if (kind === "tab" && action === "rename" && args.length === 4) return runApp(context, ["do", "tab.rename", JSON.stringify({ id: uiId(context, args[2]), name: args[3] })]);
  if (kind === "workspace" && action === "get") {
    const space = appSpace(context, args[2]);
    return { workspace: { workspace_id: space.id, path: space.folder } };
  }
  if (kind === "pane" && action === "list") {
    const space = appSpace(context, option("--workspace"));
    return { panes: space.tabs.flatMap((tab) => tab.terminals.map((terminal) => ({ pane_id: terminal.terminal, tab_id: tab.id, workspace_id: space.id }))) };
  }
  throw new Error(`Herdr App operation is not implemented: ${args.slice(0, 2).join(" ")}.`);
}
