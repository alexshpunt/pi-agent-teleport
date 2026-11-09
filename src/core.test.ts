import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runHerdr, type HerdrContext } from "./herdr.ts";
import { createManagedWorktree, mergeMachineResources, readState, reconcileState, removeManagedWorktree, writeState } from "./core.ts";

vi.mock("./herdr.ts", async (original) => ({
  ...await original<typeof import("./herdr.ts")>(),
  runHerdr: vi.fn(),
  assertHerdrContext: vi.fn(),
  isHerdrShell: vi.fn(() => true),
}));

beforeEach(() => vi.clearAllMocks());
const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

const context: HerdrContext = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", session: "test", socketPath: "/test.sock" };
function repo() {
  mkdirSync(resolve(".tmp"), { recursive: true });
  const directory = mkdtempSync(resolve(".tmp/core-test-"));
  fixtures.push(directory);
  const root = join(directory, "repo");
  mkdirSync(root);
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "README"), "test");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

test("return preserves local ownership and accepts remote updates and deletions", () => {
  const resource = { id: "local", owner: "pi-agent-teleport" as const, kind: "git-worktree" as const, repo: "/repo", path: "/worktree", branch: "owned", createdAt: 1 };
  const original = { local: resource, removed: { ...resource, id: "removed", machine: "vps" }, updated: { ...resource, id: "updated", machine: "vps", path: "/old" } };
  const returned = { local: { ...resource, path: "/forged" }, updated: { ...resource, id: "updated", machine: "vps", path: "/new" } };
  expect(mergeMachineResources(original, returned, "vps")).toEqual({ local: resource, updated: returned.updated });
});
test("reconciliation never prunes or removes resources belonging to another machine", () => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  const stateDir = mkdtempSync(resolve(".tmp/machine-state-"));
  fixtures.push(stateDir);
  const state = readState(stateDir);
  state.machine = "vps";
  state.active = { cwd: "ssh://other/root/project", sessionFile: "/missing/on/this/host/session.jsonl" };
  state.resources.foreign = { id: "foreign", owner: "pi-agent-teleport", kind: "git-worktree", repo: "/source/repo", path: "/source/worktree", branch: "owned", createdAt: 1 };
  writeState(stateDir, state);
  expect(reconcileState(stateDir).resources.foreign).toEqual(state.resources.foreign);
  expect(readState(stateDir).active).toEqual(state.active);
  expect(() => removeManagedWorktree({ repo: "/source/repo", id: "foreign", stateDir })).toThrow("owning machine");
});
describe("managed worktrees", () => {
  test("creates a checkout at the requested relative path without contacting Herdr", () => {
    const root = repo();
    const managed = createManagedWorktree({ repo: root, branch: "owned", base: "main", path: "checkouts/owned", stateDir: join(root, ".state"), herdr: context });
    expect(managed.path).toBe(join(root, "checkouts", "owned"));
    expect(readState(join(root, ".state")).resources[managed.id]).toEqual(managed);
    expect(runHerdr).not.toHaveBeenCalled();
  });

  test("refuses a dirty legacy Herdr worktree and retains ownership", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    const managed = createManagedWorktree({ repo: root, branch: "owned", stateDir });
    managed.herdr = { ...context, workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1" };
    const state = readState(stateDir);
    state.resources[managed.id] = managed;
    writeState(stateDir, state);
    writeFileSync(join(managed.path, "dirty"), "keep me");
    expect(() => removeManagedWorktree({ repo: root, id: managed.id, stateDir })).toThrow();
    expect(readState(stateDir).resources[managed.id]).toEqual(managed);
    expect(runHerdr).not.toHaveBeenCalled();
  });

  test("removes only a worktree with matching durable ownership", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    const managed = createManagedWorktree({ repo: root, branch: "owned", stateDir });
    expect(readState(stateDir).resources[managed.id]?.path).toBe(managed.path);
    const removed = removeManagedWorktree({ repo: root, id: managed.id, stateDir });
    expect(removed).toEqual(managed);
    expect(readState(stateDir).resources[managed.id]).toBeUndefined();
    expect(() => execFileSync("git", ["show-ref", "--verify", `refs/heads/${managed.branch}`], { cwd: root })).toThrow();

    const foreign = join(root, "foreign");
    execFileSync("git", ["worktree", "add", "-b", "foreign", foreign], { cwd: root });
    expect(() => removeManagedWorktree({ repo: root, id: "missing", stateDir })).toThrow(/owned/);
  });

  test("startup reconciliation keeps the source for a merely prepared destination", () => {
    const root = repo();
    const stateDir = join(root, ".state-prepared");
    const sourceSession = join(root, "source.jsonl");
    const destinationSession = join(root, "destination.jsonl");
    writeFileSync(sourceSession, "source");
    writeFileSync(destinationSession, "destination");
    writeState(stateDir, { version: 1, history: [], resources: {}, transition: { id: "prepared", phase: "prepared", from: root, to: join(root, "next"), sourceSession, destinationSession, startedAt: 1 } });

    const state = reconcileState(stateDir);

    expect(state.active).toEqual({ cwd: root, sessionFile: sourceSession });
    expect(state.transition).toBeUndefined();
  });

  test("startup reconciliation records an interrupted move without inventing an active session", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    writeState(stateDir, { version: 1, active: { sessionFile: "/gone", cwd: root }, history: [], resources: {}, transition: { id: "x", phase: "prepared", from: root, to: join(root, "next"), sourceSession: "/gone", destinationSession: "/also-gone", startedAt: 1 } });
    const state = reconcileState(stateDir);
    expect(state.active).toBeUndefined();
    expect(state.transition).toBeUndefined();
    expect(state.history.at(-1)?.status).toBe("reconciled");
  });
});
