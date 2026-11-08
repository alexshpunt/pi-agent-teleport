import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { appSpaces } from "./app.ts";
import { isHerdrShell, runHerdr, type HerdrContext } from "./herdr.ts";
import { createManagedWorktree, prepareHerdrDestination, readState, removeManagedWorktree } from "./core.ts";

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

test("App creates a real Git worktree and records its public space without legacy worktree commands", () => {
  const f = repo();
  const resource = createManagedWorktree({ repo: f.root, branch: "owned", base: "main", path: f.path, stateDir: f.stateDir, herdr: context });
  expect(existsSync(join(f.path, ".git"))).toBe(true);
  expect(resource.herdr).toMatchObject({ backend: "app", workspaceId: "sp2", tabId: "tb2", paneId: "t2", parentWorkspaceId: "sp1" });
  expect(readState(f.stateDir).resources[resource.id]).toEqual(resource);
  expect(vi.mocked(runHerdr).mock.calls.some(([, args]) => args[0] === "worktree")).toBe(false);
});

test("a failed App space creation leaves the Git checkout durably owned for recovery", () => {
  const f = repo();
  vi.mocked(runHerdr).mockImplementation(() => { throw new Error("Window unavailable"); });
  expect(() => createManagedWorktree({ repo: f.root, branch: "owned", path: f.path, stateDir: f.stateDir, herdr: context })).toThrow();
  const resources = Object.values(readState(f.stateDir).resources);
  expect(resources).toHaveLength(1);
  expect(resources[0].path).toBe(f.path);
  expect(existsSync(join(f.path, ".git"))).toBe(true);
});

test("an unconfirmed App space cannot be bypassed by removing the Git-only ownership record", () => {
  const f = repo();
  vi.mocked(runHerdr).mockImplementation(() => { throw new Error("Lost creation reply"); });
  expect(() => createManagedWorktree({ repo: f.root, branch: "owned", path: f.path, stateDir: f.stateDir, herdr: context })).toThrow();
  const resource = Object.values(readState(f.stateDir).resources)[0];
  vi.mocked(appSpaces).mockReturnValue([{ id: "unknown", folder: f.path, tabs: [{ id: "unknown-tab", terminals: [{ terminal: "t9", pane: "p9" }] }] }]);
  expect(() => removeManagedWorktree({ repo: f.root, id: resource.id, stateDir: f.stateDir, herdr: context })).toThrow();
  expect(existsSync(f.path)).toBe(true);
});

test("returning to an existing App checkout creates a new named tab rather than stealing its shell", () => {
  const f = repo();
  const destination = prepareHerdrDestination(context, f.root, undefined, "Session name");
  expect(destination.location.paneId).toBe("t2");
  expect(vi.mocked(runHerdr).mock.calls.map(([, args]) => args)).toEqual([["tab", "create", "--workspace", "sp1", "--cwd", f.root, "--label", "Session name", "--no-focus"]]);
});

test("removing an App worktree refuses additional terminals before touching Git or the UI", () => {
  const f = repo();
  const resource = createManagedWorktree({ repo: f.root, branch: "owned", path: f.path, stateDir: f.stateDir, herdr: context });
  vi.mocked(appSpaces).mockReturnValue([{ id: "sp2", folder: f.path, tabs: [{ id: "tb2", terminals: [{ terminal: "t2", pane: "p2" }, { terminal: "t3", pane: "p3" }] }] }]);
  vi.mocked(runHerdr).mockClear();
  expect(() => removeManagedWorktree({ repo: f.root, id: resource.id, stateDir: f.stateDir, herdr: context })).toThrow();
  expect(existsSync(f.path)).toBe(true);
  expect(vi.mocked(runHerdr).mock.calls.length).toBe(0);
});
