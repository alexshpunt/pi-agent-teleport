import { execFileSync } from "node:child_process";
import { coreEnvironment, type HerdrContext } from "./herdr.ts";

export type AppSpace = { id: string; name?: string; folder?: string; machine?: string | null; tabs: Array<{ id: string; name?: string; terminals: Array<{ terminal: string; pane: string }> }> };
class AppCommandError extends Error {
  readonly reply: string;
  constructor(reply: string) { super(reply); this.reply = reply; }
}

/** Use the public window CLI, never the private layout document. */
export function runApp(context: HerdrContext, args: string[]): any {
  let output: string;
  try {
    output = execFileSync(context.appCli || (process.platform === "win32" ? "herdr-app.exe" : "herdr-app"), args, { encoding: "utf8", env: coreEnvironment(context), timeout: 40_000, stdio: ["ignore", "pipe", "pipe"] });
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

export function appSpaces(context: HerdrContext): AppSpace[] {
  const result = runApp(context, ["ls"]);
  if (!Array.isArray(result.spaces)) throw new Error("Herdr App returned no spaces.");
  return result.spaces;
}

export function appSpace(context: HerdrContext, id: string): AppSpace {
  const space = appSpaces(context).find((space) => !space.machine && space.id === id);
  if (!space) throw new Error("The addressed space is not in the connected Herdr App window.");
  return space;
}

/** Wait for parking's asynchronous core update before ending the terminal. */
export function parkAppTerminal(context: HerdrContext, terminal: string): void {
  const result = runApp(context, ["do", "terminal.park", JSON.stringify({ terminal })]);
  if (result.pending !== true || result.terminal !== terminal) throw new Error("Herdr App did not acknowledge parking this terminal.");
  const deadline = Date.now() + 15_000;
  while (appSpaces(context).some((space) => space.tabs.some((tab) => tab.terminals.some((pane) => pane.terminal === terminal)))) {
    if (Date.now() >= deadline) throw new Error("Herdr App has not confirmed removing the terminal's pane; the core terminal is retained.");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** Normalize a public creation result to Teleport's connection-bound location. */
export function appCreation(result: any): any {
  if (typeof result.space !== "string" || typeof result.tab !== "string" || typeof result.terminal !== "string") throw new Error("Herdr App returned no matching space, tab and terminal.");
  return {
    workspace: { workspace_id: result.space, pane_count: 1 },
    tab: { tab_id: result.tab, workspace_id: result.space },
    root_pane: { pane_id: result.terminal, tab_id: result.tab, workspace_id: result.space },
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
  if (kind === "tab" && action === "create") return appCreation(createAppItem(context, "tab.new", { space: option("--workspace"), folder: option("--cwd"), name: option("--label") }));
  if (kind === "workspace" && action === "create") return appCreation(createAppItem(context, "space.new", { folder: option("--cwd"), name: option("--label"), tab: option("--label"), machine: "" }));
  if ((kind === "tab" || kind === "workspace") && action === "close" && args.length === 3) return runApp(context, ["do", kind === "tab" ? "tab.close" : "space.close", JSON.stringify({ id: args[2], confirmed: true })]);
  if (kind === "tab" && action === "rename" && args.length === 4) return runApp(context, ["do", "tab.rename", JSON.stringify({ id: args[2], name: args[3] })]);
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
