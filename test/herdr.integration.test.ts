import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createManagedWorktree, prepareHerdrDestination, preserveHerdrSourceWorkspace, readState, removeManagedWorktree } from "../src/core.ts";
import { herdrLocation, runHerdr, type HerdrContext } from "../src/herdr.ts";
import { buildSourcePaneCleanup } from "../src/index.ts";

// Use a named server so no experiment can change the user's layout or focus.
let available = true;
try { execFileSync("herdr", ["--version"], { stdio: "ignore" }); } catch { available = false; }
let server: ChildProcess | undefined;
let directory: string;
let repo: string;
let context: HerdrContext;
const session = `teleport-test-${process.pid}`;
const env: NodeJS.ProcessEnv = { ...process.env, HERDR_SESSION: session };
delete env.HERDR_SOCKET_PATH;
delete env.HERDR_WORKSPACE_ID;
delete env.HERDR_TAB_ID;
delete env.HERDR_PANE_ID;

beforeAll(async () => {
  if (!available) return;
  mkdirSync(resolve(".tmp"), { recursive: true });
  directory = mkdtempSync(resolve(".tmp/herdr-test-"));
  repo = join(directory, "repo");
  mkdirSync(repo);
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README"), "fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  server = spawn("herdr", ["--session", session, "server"], { env, stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const response = JSON.parse(execFileSync("herdr", ["workspace", "create", "--cwd", repo, "--no-focus"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).result;
      context = herdrLocation({ workspaceId: "", tabId: "", paneId: "", session }, response);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

afterAll(() => {
  if (repo && existsSync(repo)) {
    // These checkouts belong only to this fixture, including Herdr's default paths.
    const paths = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    for (const path of paths.filter((path) => path !== repo)) execFileSync("git", ["worktree", "remove", "--force", path], { cwd: repo, stdio: "ignore" });
  }
  if (server) {
    execFileSync("herdr", ["server", "stop"], { env, stdio: "ignore" });
    server.kill();
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test.skipIf(!available)("Herdr creates, groups, reuses, reopens, and removes an owned checkout", async () => {
  const stateDir = join(directory, "state");
  const resource = createManagedWorktree({ repo, branch: "fix/login", path: join(directory, "login"), stateDir, herdr: context });
  expect(resource.herdr?.parentWorkspaceId).toBe(context.workspaceId);
  expect(readState(stateDir).resources[resource.id]).toEqual(resource);
  const workspace = runHerdr(context, ["workspace", "get", resource.herdr!.workspaceId]).workspace;
  expect(workspace.worktree.checkout_path).toBe(resource.path);
  expect(workspace.worktree.repo_root).toBe(repo);
  const prepared = prepareHerdrDestination(context, resource.path, resource.herdr, "Вход — исправление");
  expect(runHerdr(context, ["tab", "get", prepared.location.tabId]).tab.label).toBe("Вход — исправление");
  const unnamed = prepareHerdrDestination(context, resource.path, resource.herdr);
  expect(unnamed.location).toEqual(prepared.location);
  expect(runHerdr(context, ["tab", "get", unnamed.location.tabId]).tab.label).toBe("login");
  expect(prepared.location.paneId).toBe(resource.herdr!.paneId);
  expect(runHerdr(context, ["tab", "list", "--workspace", prepared.location.workspaceId]).tabs).toHaveLength(1);
  expect(runHerdr(context, ["pane", "run", prepared.location.paneId, "true"])).toEqual({ type: "ok" });
  // Simulate the source tab closing after back. The checkout remains on disk.
  runHerdr(context, ["tab", "close", prepared.location.tabId]);
  expect(existsSync(resource.path)).toBe(true);
  removeManagedWorktree({ repo, id: resource.id, stateDir, herdr: context });
  expect(existsSync(resource.path)).toBe(false);
  expect(readState(stateDir).resources[resource.id]).toBeUndefined();
  expect(runHerdr(context, ["workspace", "list"]).workspaces).toHaveLength(1);
  const source = createManagedWorktree({ repo, branch: "source", path: join(directory, "source"), stateDir, herdr: context });
  writeFileSync(join(source.path, "source-commit"), "only in this checkout\n");
  execFileSync("git", ["add", "."], { cwd: source.path });
  execFileSync("git", ["commit", "-m", "source commit"], { cwd: source.path, stdio: "ignore" });
  const fromLinked = createManagedWorktree({ repo: source.path, branch: "from-linked", stateDir, herdr: context });
  expect(fromLinked.path).not.toBe(join(directory, "source-from-linked"));
  expect(fromLinked.herdr?.parentWorkspaceId).toBe(context.workspaceId);
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: fromLinked.path, encoding: "utf8" })).toBe(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source.path, encoding: "utf8" }));
  removeManagedWorktree({ repo: source.path, id: fromLinked.id, stateDir, herdr: context });
  removeManagedWorktree({ repo, id: source.id, stateDir, herdr: context });
});

test.skipIf(!available).each(["last pane", "sibling pane", "sibling tab"])("source cleanup preserves the workspace and user focus with %s", (layout) => {
  const created = runHerdr(context, ["workspace", "create", "--cwd", repo, "--no-focus"]);
  const source = herdrLocation(context, created);
  let companionId: string | undefined;
  if (layout === "sibling pane") {
    companionId = runHerdr(context, ["pane", "split", source.paneId, "--direction", "right", "--cwd", repo, "--no-focus"]).pane.pane_id;
  } else if (layout === "sibling tab") {
    companionId = runHerdr(context, ["tab", "create", "--workspace", source.workspaceId, "--cwd", repo, "--no-focus"]).root_pane.pane_id;
  }
  const focus = () => runHerdr(context, ["workspace", "list"]).workspaces
    .filter((workspace: any) => workspace.focused)
    .map((workspace: any) => [workspace.workspace_id, workspace.active_tab_id,
      runHerdr(context, ["pane", "list", "--workspace", workspace.workspace_id]).panes
        .filter((pane: any) => pane.focused).map((pane: any) => pane.pane_id),
    ]);
  const before = focus();
  expect(before).toHaveLength(1);
  expect(before[0][0]).not.toBe(source.workspaceId);
  preserveHerdrSourceWorkspace(source, repo);
  execFileSync("sh", ["-c", buildSourcePaneCleanup(source.paneId, 2147483647, join(directory, "old-session.jsonl"))], { env, stdio: "ignore" });
  const remaining = runHerdr(context, ["pane", "list", "--workspace", source.workspaceId]).panes;
  expect(remaining).toHaveLength(1);
  expect(remaining[0].pane_id).not.toBe(source.paneId);
  if (companionId) expect(remaining[0].pane_id).toBe(companionId);
  else {
    expect(runHerdr(context, ["tab", "get", remaining[0].tab_id]).tab.label).toBe("shell");
    expect(remaining[0].cwd).toBe(repo);
  }
  expect(focus()).toEqual(before);
  runHerdr(context, ["workspace", "close", source.workspaceId]);
});
