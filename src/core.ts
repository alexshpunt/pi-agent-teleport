import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const STATE_VERSION = 1 as const;
export type Location = { cwd: string; sessionFile: string };
export type HistoryEntry = { from: string; to: string; at: number; status: "completed" | "reconciled" };
export type Resource = { id: string; owner: "pi-agent-teleport"; kind: "git-worktree"; repo: string; path: string; branch: string; createdAt: number };
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
    state.active = destinationExists ? { cwd: t.to, sessionFile: t.destinationSession } : sourceExists ? { cwd: t.from, sessionFile: t.sourceSession } : undefined;
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

/** Create a linked Git worktree and publish ownership before returning it. */
export function createManagedWorktree(input: { repo: string; branch: string; base?: string; path?: string; stateDir: string }): Resource {
  const repo = canonical(input.repo);
  git(repo, ["rev-parse", "--show-toplevel"]);
  const id = randomUUID();
  const path = resolve(input.path ?? join(dirname(repo), `${basename(repo)}-${input.branch.replace(/[^A-Za-z0-9._-]/g, "-")}`));
  if (existsSync(path)) throw new Error(`Worktree path already exists: ${path}`);
  const resource: Resource = { id, owner: "pi-agent-teleport", kind: "git-worktree", repo, path, branch: input.branch, createdAt: Date.now() };
  const state = readState(input.stateDir);
  state.resources[id] = resource;
  writeState(input.stateDir, state);
  try { git(repo, ["worktree", "add", "-b", input.branch, path, input.base ?? "HEAD"]); }
  catch (error) { delete state.resources[id]; writeState(input.stateDir, state); throw error; }
  return resource;
}

/** Remove a clean Teleport-owned worktree. Foreign, dirty, and mismatched paths are refused. */
export function removeManagedWorktree(input: { repo: string; id: string; stateDir: string }): void {
  const state = readState(input.stateDir);
  const resource = state.resources[input.id];
  if (!resource || resource.owner !== "pi-agent-teleport") throw new Error(`Resource ${input.id} is not owned by Teleport.`);
  if (canonical(input.repo) !== resource.repo) throw new Error("The owning repository does not match.");
  if (!existsSync(resource.path)) { delete state.resources[input.id]; writeState(input.stateDir, state); return; }
  const common = canonical(resolve(resource.path, git(resource.path, ["rev-parse", "--git-common-dir"])));
  const expected = canonical(resolve(resource.repo, git(resource.repo, ["rev-parse", "--git-common-dir"])));
  if (common !== expected) throw new Error("The worktree no longer belongs to the recorded repository.");
  if (git(resource.path, ["status", "--porcelain"])) throw new Error("Refusing to remove a dirty managed worktree.");
  git(resource.repo, ["worktree", "remove", resource.path]);
  delete state.resources[input.id];
  writeState(input.stateDir, state);
}
