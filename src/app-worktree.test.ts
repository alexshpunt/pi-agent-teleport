import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { appSpaces } from "./app.ts";
import { isHerdrShell, runHerdr, type HerdrContext } from "./herdr.ts";
import { createManagedWorktree, prepareHerdrArrival, prepareHerdrDestination, readState, removeManagedWorktree, writeState } from "./core.ts";

vi.mock("./herdr.ts", async (original) => ({ ...await original<typeof import("./herdr.ts")>(), runHerdr: vi.fn(), assertHerdrContext: vi.fn(), isHerdrShell: vi.fn(() => true) }));
vi.mock("./app.ts", async (original) => ({ ...await original<typeof import("./app.ts")>(), appSpaces: vi.fn() }));
const fixtures: string[] = [];
const context: HerdrContext = { backend: "app", workspaceId: "sp1", tabId: "tb1", paneId: "t1", session: "isolated", coreSocketPath: "/owned/core.sock" };
beforeEach(() => vi.resetAllMocks());
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
function repo() {
  mkdirSync(resolve(".tmp"), { recursive: true });
  const fixture = mkdtempSync(resolve(".tmp/app-worktree-")); fixtures.push(fixture);
  const root = join(fixture, "repo"); mkdirSync(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Test");
  writeFileSync(join(root, "README"), "fixture"); git("add", "."); git("commit", "-m", "initial");
  const source = { id: "sp1", folder: root, tabs: [{ id: "tb1", terminals: [{ terminal: "t1", pane: "p1" }] }] };
  vi.mocked(appSpaces).mockReturnValue([source]);
  vi.mocked(runHerdr).mockImplementation((_context, args) => {
    if (args[0] === "worktree") throw new Error("No public App worktree API");
    return { workspace: { workspace_id: "sp2" }, tab: { tab_id: "tb2", workspace_id: "sp2" }, root_pane: { pane_id: "t2", tab_id: "tb2", workspace_id: "sp2" } };
  });
  vi.mocked(isHerdrShell).mockReturnValue(true);
  return { root, fixture, git, source, stateDir: join(fixture, "state"), path: join(fixture, "checkout") };
}

test("local worktree creation and legacy removal do not contact App", () => {
  const f = repo();
  vi.mocked(runHerdr).mockImplementation(() => { throw new Error("App unavailable"); });
  const resource = createManagedWorktree({ repo: f.root, branch: "owned", path: f.path, stateDir: f.stateDir, herdr: context });
  expect(existsSync(join(f.path, ".git"))).toBe(true);
  expect(runHerdr).not.toHaveBeenCalled();
  const state = readState(f.stateDir);
  state.resources[resource.id].herdr = { ...context, workspaceId: "old", tabId: "old-tab", paneId: "old-pane" };
  writeState(f.stateDir, state);
  removeManagedWorktree({ repo: f.root, id: resource.id, stateDir: f.stateDir });
  expect(existsSync(f.path)).toBe(false);
  expect(readState(f.stateDir).resources[resource.id]).toBeUndefined();
  expect(runHerdr).not.toHaveBeenCalled();
});

test("returning to an existing App checkout creates a new named tab rather than stealing its shell", () => {
  const f = repo();
  const destination = prepareHerdrDestination(context, f.root, undefined, "Session name");
  expect(destination.location.paneId).toBe("t2");
  expect(vi.mocked(runHerdr).mock.calls.map(([, args]) => args)).toEqual([["tab", "create", "--workspace", "sp1", "--cwd", f.root, "--label", "Session name", "--no-focus"]]);
});

test("removing a legacy checkout does not touch other App terminals", () => {
  const f = repo();
  const resource = createManagedWorktree({ repo: f.root, branch: "owned", path: f.path, stateDir: f.stateDir });
  const state = readState(f.stateDir);
  state.resources[resource.id].herdr = { ...context, workspaceId: "sp2", tabId: "tb2", paneId: "t2" };
  writeState(f.stateDir, state);
  vi.mocked(appSpaces).mockReturnValue([{ id: "sp2", folder: f.path, tabs: [{ id: "tb2", terminals: [{ terminal: "t2", pane: "p2" }, { terminal: "t3", pane: "p3" }] }] }]);
  removeManagedWorktree({ repo: f.root, id: resource.id, stateDir: f.stateDir, herdr: context });
  expect(existsSync(f.path)).toBe(false);
  expect(runHerdr).not.toHaveBeenCalled();
  expect(appSpaces).not.toHaveBeenCalled();
});

test("an arrival from another machine joins the destination space named like the source space, not one with the same folder", () => {
  const f = repo();
  vi.mocked(appSpaces).mockReturnValue([
    { id: "sp1", name: "herdr-app", folder: f.root, tabs: [{ id: "tb1", terminals: [{ terminal: "t1", pane: "p1" }] }] },
    { id: "sp7", name: "pi-agent-ide · LPT-1435 ssh-transfer flake", folder: "/elsewhere", tabs: [] },
  ]);
  prepareHerdrArrival(context, f.root, "fix-ssh-transfer", { space: "pi-agent-ide · LPT-1435 ssh-transfer flake", tab: "LPT-1435 flake" });
  expect(vi.mocked(runHerdr).mock.calls.map(([, args]) => args)).toEqual([["tab", "create", "--workspace", "sp7", "--cwd", f.root, "--label", "LPT-1435 flake", "--no-focus"]]);
});

test("an arrival creates the source space by name when the destination has none, and rolls it back whole", () => {
  const f = repo();
  const destination = prepareHerdrArrival(context, f.root, "fix-ssh-transfer", { space: "pi-agent-ide · LPT-1435 ssh-transfer flake" });
  expect(vi.mocked(runHerdr).mock.calls.map(([, args]) => args)).toEqual([["workspace", "create", "--cwd", f.root, "--label", "pi-agent-ide · LPT-1435 ssh-transfer flake", "--tab-label", "fix-ssh-transfer", "--no-focus"]]);
  expect(destination.rollbackArgs).toEqual(["workspace", "close", "sp2"]);
});
