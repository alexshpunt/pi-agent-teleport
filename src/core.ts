import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertHerdrContext, herdrLocation, isHerdrShell, runHerdr, sameHerdrConnection, type HerdrContext, type HerdrLocation } from "./herdr.ts";

export const STATE_VERSION = 1 as const;
export type Location = { cwd: string; sessionFile: string; herdr?: HerdrLocation };
export type HistoryEntry = { from: string; to: string; at: number; status: "completed" | "reconciled"; fromHerdr?: HerdrLocation; toHerdr?: HerdrLocation };
export type Resource = { id: string; owner: "pi-agent-teleport"; kind: "git-worktree"; repo: string; path: string; branch: string; createdAt: number; herdr?: HerdrLocation & { parentWorkspaceId?: string } };
export type Transition = { id: string; phase: "prepared" | "destination-started"; from: string; to: string; sourceSession: string; destinationSession: string; startedAt: number };
export type TeleportState = { version: 1; active?: Location; history: HistoryEntry[]; resources: Record<string, Resource>; transition?: Transition };

const emptyState = (): TeleportState => ({ version: STATE_VERSION, history: [], resources: {} });
const stateFile = (dir: string) => join(dir, "state.json");

/** Read Teleport's versioned durable state. Unknown versions are rejected. */
export function readState(dir: string): TeleportState {
  if (!existsSync(stateFile(dir))) return emptyState();
  const value = JSON.parse(readFileSync(stateFile(dir), "utf8")) as TeleportState;
  if (value.version !== STATE_VERSION) throw new Error(`Unsupported Teleport state version: ${String(value.version)}`);
  return value;
}

/** Atomically persist Teleport state. */
export function writeState(dir: string, state: TeleportState): void {
  mkdirSync(dir, { recursive: true });
  const temporary = `${stateFile(dir)}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile(dir));
}

/** Repair interrupted transitions using only files that can be observed safely. */
export function reconcileState(dir: string): TeleportState {
  const state = readState(dir);
  if (state.transition) {
    const t = state.transition;
    const destinationExists = existsSync(t.destinationSession);
    const sourceExists = existsSync(t.sourceSession);
    state.active = t.phase === "destination-started" && destinationExists
      ? { cwd: t.to, sessionFile: t.destinationSession }
      : sourceExists
        ? { cwd: t.from, sessionFile: t.sourceSession }
        : destinationExists
          ? { cwd: t.to, sessionFile: t.destinationSession }
          : undefined;
    state.history.push({ from: t.from, to: state.active?.cwd ?? t.to, at: Date.now(), status: "reconciled" });
    delete state.transition;
  }
  if (state.active && !existsSync(state.active.sessionFile)) delete state.active;
  for (const [id, resource] of Object.entries(state.resources)) if (!existsSync(resource.path)) delete state.resources[id];
  writeState(dir, state);
  return state;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function canonical(path: string): string { return existsSync(path) ? realpathSync(path) : resolve(path); }
function primaryRepo(repo: string): string {
  const first = git(repo, ["worktree", "list", "--porcelain"]).split("\n")[0];
  if (!first?.startsWith("worktree ")) throw new Error("Git did not return a primary checkout.");
  return canonical(first.slice("worktree ".length));
}

/** Prepare a checkout workspace without stealing an existing user's pane. */
export function prepareHerdrDestination(context: HerdrContext, target: string, owned?: Resource["herdr"]): { location: HerdrLocation; rollback: () => void } {
  assertHerdrContext(context);
  let checkout = false;
  try { checkout = canonical(git(target, ["rev-parse", "--show-toplevel"])) === canonical(target); } catch { /* Plain directories use the current workspace. */ }
  if (checkout) {
    const opened = runHerdr(context, ["worktree", "open", "--cwd", primaryRepo(target), "--path", target, "--no-focus"]);
    const location = herdrLocation(context, opened, target);
    const ownShell = owned && sameHerdrConnection(context, owned) && owned.paneId === location.paneId && opened.workspace.pane_count === 1;
    if ((!opened.already_open || ownShell) && isHerdrShell(context, location.paneId)) {
      return { location, rollback: () => { runHerdr(context, opened.already_open ? ["tab", "close", location.tabId] : ["workspace", "close", location.workspaceId]); } };
    }
    const tab = runHerdr(context, ["tab", "create", "--workspace", location.workspaceId, "--cwd", target, "--label", "Teleport", "--no-focus"]);
    const next = herdrLocation(context, { ...tab, workspace: opened.workspace });
    return { location: next, rollback: () => { runHerdr(context, ["tab", "close", next.tabId]); } };
  }
  const tab = runHerdr(context, ["tab", "create", "--workspace", context.workspaceId, "--cwd", target, "--label", "Teleport", "--no-focus"]);
  const location = herdrLocation(context, { ...tab, workspace: { workspace_id: context.workspaceId } });
  return { location, rollback: () => { runHerdr(context, ["tab", "close", location.tabId]); } };
}
/** Create a linked checkout with Git or Herdr, then save its actual path and ownership. */
export function createManagedWorktree(input: { repo: string; branch: string; base?: string; path?: string; stateDir: string; herdr?: HerdrContext }): Resource {
  const repo = canonical(input.repo);
  git(repo, ["rev-parse", "--show-toplevel"]);
  git(repo, ["check-ref-format", "--branch", input.branch]);
  if (git(repo, ["branch", "--list", input.branch])) throw new Error(`Branch already exists: ${input.branch}`);
  const id = randomUUID();
  const requestedPath = input.path ? resolve(repo, input.path) : undefined;
  if (requestedPath && existsSync(requestedPath)) throw new Error(`Worktree path already exists: ${requestedPath}`);
  let path: string;
  let herdr: Resource["herdr"];
  if (input.herdr) {
    assertHerdrContext(input.herdr);
    const parent = primaryRepo(repo);
    const args = ["worktree", "create", "--cwd", parent, "--branch", input.branch];
    args.push("--base", input.base ?? git(repo, ["rev-parse", "HEAD"]));
    if (requestedPath) args.push("--path", requestedPath);
    args.push("--no-focus");
    const result = runHerdr(input.herdr, args);
    if (!result.worktree?.path || !result.worktree.is_linked_worktree || result.worktree.branch !== input.branch) throw new Error("Herdr did not create the requested linked worktree.");
    path = canonical(result.worktree.path);
    herdr = herdrLocation(input.herdr, result, requestedPath ?? path);
  } else {
    path = requestedPath ?? join(dirname(repo), `${basename(repo)}-${input.branch.replace(/[^A-Za-z0-9._-]/g, "-")}`);
    if (existsSync(path)) throw new Error(`Worktree path already exists: ${path}`);
  }
  const resource: Resource = { id, owner: "pi-agent-teleport", kind: "git-worktree", repo, path, branch: input.branch, createdAt: Date.now(), ...(herdr ? { herdr } : {}) };
  const state = readState(input.stateDir);
  state.resources[id] = resource;
  writeState(input.stateDir, state);
  if (input.herdr && resource.herdr) {
    // Save ownership before the follow-up lookup, so a CLI read failure cannot orphan the checkout.
    const parentWorkspaceId = runHerdr(input.herdr, ["worktree", "list", "--cwd", primaryRepo(repo)]).source?.source_workspace_id;
    if (!parentWorkspaceId) throw new Error(`Created worktree ${path}, but Herdr returned no parent workspace ID. Recover with resourceId: ${id}.`);
    resource.herdr.parentWorkspaceId = parentWorkspaceId;
    writeState(input.stateDir, state);
  } else {
    try { git(repo, ["worktree", "add", "-b", input.branch, path, input.base ?? "HEAD"]); }
    catch (error) { delete state.resources[id]; writeState(input.stateDir, state); throw error; }
  }
  return resource;
}

/** Remove a clean Teleport-owned worktree. Foreign, dirty, and mismatched paths are refused. */
export function removeManagedWorktree(input: { repo: string; id: string; stateDir: string; herdr?: HerdrContext }): Resource {
  const state = readState(input.stateDir);
  const resource = state.resources[input.id];
  if (!resource || resource.owner !== "pi-agent-teleport") throw new Error(`Resource ${input.id} is not owned by Teleport.`);
  if (canonical(input.repo) !== resource.repo) throw new Error("The owning repository does not match.");
  if (resource.herdr && (!input.herdr || !sameHerdrConnection(input.herdr, resource.herdr))) throw new Error("Return to the owning Herdr session before removing this worktree.");
  if (!existsSync(resource.path)) {
    delete state.resources[input.id];
    writeState(input.stateDir, state);
    return resource;
  }
  const common = canonical(resolve(resource.path, git(resource.path, ["rev-parse", "--git-common-dir"])));
  const expected = canonical(resolve(resource.repo, git(resource.repo, ["rev-parse", "--git-common-dir"])));
  if (common !== expected) throw new Error("The worktree no longer belongs to the recorded repository.");
  if (git(resource.path, ["status", "--porcelain"])) throw new Error("Refusing to remove a dirty managed worktree.");
  if (resource.herdr && input.herdr) {
    assertHerdrContext(input.herdr);
    const opened = runHerdr(input.herdr, ["worktree", "open", "--cwd", primaryRepo(resource.repo), "--path", resource.path, "--no-focus"]);
    const location = herdrLocation(input.herdr, opened, resource.path);
    resource.herdr = { ...location, parentWorkspaceId: resource.herdr.parentWorkspaceId };
    writeState(input.stateDir, state);
    const panes = runHerdr(input.herdr, ["pane", "list", "--workspace", location.workspaceId]).panes;
    if (!Array.isArray(panes) || panes.length !== 1 || panes[0].pane_id !== location.paneId || !isHerdrShell(input.herdr, location.paneId)) throw new Error("Refusing to remove an occupied Herdr workspace. Return with back and close other panes first.");
    runHerdr(input.herdr, ["worktree", "remove", "--workspace", location.workspaceId]);
  } else {
    git(resource.repo, ["worktree", "remove", resource.path]);
  }
  try { git(resource.repo, ["branch", "-d", resource.branch]); } catch { /* Preserve unmerged branches. */ }
  delete state.resources[input.id];
  writeState(input.stateDir, state);
  return resource;
}
