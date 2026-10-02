import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assertHerdrContext, isHerdrShell, runHerdr, type HerdrContext } from "./herdr.ts";
import { createManagedWorktree, readState, reconcileState, removeManagedWorktree, writeState } from "./core.ts";

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
function opened(path: string, branch: string) {
  return {
    workspace: { workspace_id: "w2" },
    tab: { tab_id: "w2:t1", workspace_id: "w2" },
    root_pane: { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
    worktree: { path, branch, is_linked_worktree: true },
  };
}
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

describe("managed worktrees", () => {
  test("lets Herdr choose the path and saves its workspace and shell IDs", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    const path = join(root, "herdr-checkouts", "owned");
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[1] === "list") return { source: { source_workspace_id: "w1" } };
      expect(args).toEqual(["worktree", "create", "--cwd", root, "--branch", "owned", "--base", "main", "--no-focus"]);
      execFileSync("git", ["worktree", "add", "-b", "owned", path, "main"], { cwd: root });
      return opened(path, "owned");
    });
    const managed = createManagedWorktree({ repo: root, branch: "owned", base: "main", stateDir, herdr: context });
    expect(assertHerdrContext).toHaveBeenCalledWith(context);
    expect(managed.path).toBe(path);
    expect(managed.herdr).toEqual({ ...context, workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", parentWorkspaceId: "w1" });
    expect(readState(stateDir).resources[managed.id]).toEqual(managed);
  });

  test("passes an explicit relative path to Herdr relative to the repository", () => {
    const root = repo();
    const path = join(root, "checkouts", "owned");
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[1] === "list") return { source: { source_workspace_id: "w1" } };
      expect(args).toContain(path);
      execFileSync("git", ["worktree", "add", "-b", "owned", path], { cwd: root });
      return opened(path, "owned");
    });
    expect(createManagedWorktree({ repo: root, branch: "owned", path: "checkouts/owned", stateDir: join(root, ".state"), herdr: context }).path).toBe(path);
  });

  test("does not fall back to Git when Herdr creation fails", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    vi.mocked(runHerdr).mockImplementation(() => { throw new Error("Herdr unavailable"); });
    expect(() => createManagedWorktree({ repo: root, branch: "owned", stateDir, herdr: context })).toThrow("Herdr unavailable");
    expect(Object.keys(readState(stateDir).resources)).toEqual([]);
    expect(execFileSync("git", ["branch", "--list", "owned"], { cwd: root, encoding: "utf8" }).trim()).toBe("");
  });

  test("removes a closed Herdr checkout through its reopened workspace", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    const managed = createManagedWorktree({ repo: root, branch: "owned", stateDir });
    managed.herdr = { ...context, workspaceId: "gone", tabId: "gone:t1", paneId: "gone:p1", parentWorkspaceId: "w1" };
    const state = readState(stateDir);
    state.resources[managed.id] = managed;
    writeState(stateDir, state);
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[0] === "worktree" && args[1] === "open") return { ...opened(managed.path, managed.branch), already_open: false };
      if (args[0] === "pane" && args[1] === "list") return { panes: [{ pane_id: "w2:p1" }] };
      expect(args).toEqual(["worktree", "remove", "--workspace", "w2"]);
      execFileSync("git", ["worktree", "remove", managed.path], { cwd: root });
      return {};
    });
    removeManagedWorktree({ repo: root, id: managed.id, stateDir, herdr: context });
    expect(readState(stateDir).resources[managed.id]).toBeUndefined();
    expect(runHerdr).toHaveBeenCalledWith(context, ["worktree", "open", "--cwd", root, "--path", managed.path, "--no-focus"]);
  });

  test("refuses dirty and foreign-session Herdr checkouts without deleting them", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    const managed = createManagedWorktree({ repo: root, branch: "owned", stateDir });
    managed.herdr = { ...context, workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", parentWorkspaceId: "w1" };
    const state = readState(stateDir);
    state.resources[managed.id] = managed;
    writeState(stateDir, state);
    writeFileSync(join(managed.path, "dirty"), "keep me");
    expect(() => removeManagedWorktree({ repo: root, id: managed.id, stateDir, herdr: context })).toThrow(/dirty/);
    expect(runHerdr).not.toHaveBeenCalled();
    expect(() => removeManagedWorktree({ repo: root, id: managed.id, stateDir, herdr: { ...context, socketPath: "/other.sock" } })).toThrow(/Herdr session/);
    expect(readState(stateDir).resources[managed.id]).toEqual(managed);
  });
  test("keeps the returned checkout owned if the parent workspace lookup fails", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    const path = join(root, "owned");
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[1] === "list") throw new Error("lookup failed");
      execFileSync("git", ["worktree", "add", "-b", "owned", path], { cwd: root, stdio: "ignore" });
      return opened(path, "owned");
    });
    expect(() => createManagedWorktree({ repo: root, branch: "owned", stateDir, herdr: context })).toThrow("lookup failed");
    expect(Object.values(readState(stateDir).resources)).toMatchObject([{ path, herdr: { workspaceId: "w2", paneId: "w2:p1" } }]);
  });

  test("keeps ownership when an occupied workspace or CLI removal blocks cleanup", () => {
    const root = repo();
    const stateDir = join(root, ".state");
    const managed = createManagedWorktree({ repo: root, branch: "owned", stateDir });
    const state = readState(stateDir);
    state.resources[managed.id].herdr = { ...context, workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", parentWorkspaceId: "w1" };
    writeState(stateDir, state);
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[1] === "open") return { ...opened(managed.path, "owned"), already_open: true };
      if (args[1] === "list") return { panes: [{ pane_id: "w2:p1" }] };
      throw new Error("removal failed");
    });
    vi.mocked(isHerdrShell).mockReturnValue(false);
    expect(() => removeManagedWorktree({ repo: root, id: managed.id, stateDir, herdr: context })).toThrow(/occupied/);
    vi.mocked(isHerdrShell).mockReturnValue(true);
    expect(() => removeManagedWorktree({ repo: root, id: managed.id, stateDir, herdr: context })).toThrow("removal failed");
    expect(readState(stateDir).resources[managed.id]?.path).toBe(managed.path);
    expect(execFileSync("git", ["branch", "--list", "owned"], { cwd: root, encoding: "utf8" }).trim()).toBe("+ owned");
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
