import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** Caller IDs and the CLI connection that owns them. */
export type HerdrContext = { workspaceId: string; tabId: string; paneId: string; session: string; socketPath?: string };
/** A workspace and its initial shell, recorded with the owning connection. */
export type HerdrLocation = HerdrContext;

/** Enable Herdr only inside a fully identified managed pane. */
export function getHerdrContext(env: NodeJS.ProcessEnv = process.env): HerdrContext | undefined {
  if (env.HERDR_ENV !== "1" || !env.HERDR_WORKSPACE_ID?.trim() || !env.HERDR_TAB_ID?.trim() || !env.HERDR_PANE_ID?.trim()) return;
  return { workspaceId: env.HERDR_WORKSPACE_ID, tabId: env.HERDR_TAB_ID, paneId: env.HERDR_PANE_ID, session: env.HERDR_SESSION || "default", ...(env.HERDR_SOCKET_PATH ? { socketPath: env.HERDR_SOCKET_PATH } : {}) };
}

/** Run the public CLI against the caller's connection, never the UI-focused session. */
export function runHerdr(context: HerdrContext, args: string[]): any {
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: context.workspaceId, HERDR_TAB_ID: context.tabId, HERDR_PANE_ID: context.paneId, HERDR_SESSION: context.session };
  if (context.socketPath) env.HERDR_SOCKET_PATH = context.socketPath;
  else delete env.HERDR_SOCKET_PATH;
  try {
    const response = JSON.parse(execFileSync("herdr", args, { encoding: "utf8", env, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }));
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
  const info = runHerdr(context, ["pane", "process-info", "--pane", paneId]).process_info;
  return !!info?.shell_pid && info.foreground_process_group_id === info.shell_pid;
}
