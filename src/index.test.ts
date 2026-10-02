import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { prepareHerdrDestination, preserveHerdrSourceWorkspace } from "./core.ts";
import { runHerdr, isHerdrShell, type HerdrContext } from "./herdr.ts";
import teleport, { buildSourcePaneCleanup, formatRemovedWorktree } from "./index.ts";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

vi.mock("./herdr.ts", async (original) => ({
  ...await original<typeof import("./herdr.ts")>(),
  runHerdr: vi.fn(),
  assertHerdrContext: vi.fn(),
  isHerdrShell: vi.fn(() => true),
}));
beforeEach(() => vi.resetAllMocks());
const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const caller: HerdrContext = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", session: "test" };
function checkout() {
  mkdirSync(resolve(".tmp"), { recursive: true });
  const path = mkdtempSync(resolve(".tmp/route-test-"));
  fixtures.push(path);
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
  return path;
}
function destination(path: string) {
  return {
    already_open: false,
    workspace: { workspace_id: "w2", pane_count: 1 },
    tab: { tab_id: "w2:t1", workspace_id: "w2" },
    root_pane: { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2" },
    worktree: { path },
  };
}
describe("Herdr destination routing", () => {
  test.each([undefined, "", "Fix login"])("names plain directory tabs from the session or destination (%s)", (name) => {
    const path = checkout();
    const folder = resolve(path, "notes");
    mkdirSync(folder);
    vi.mocked(runHerdr).mockReturnValue({ tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1" } });
    const prepared = prepareHerdrDestination(caller, folder, undefined, name);
    expect(runHerdr).toHaveBeenCalledWith(caller, ["tab", "create", "--workspace", "w1", "--cwd", folder, "--label", name || "notes", "--no-focus"]);
    prepared.rollback();
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["tab", "close", "w1:t2"]);
  });

  test("closes the new workspace if naming its root tab fails", () => {
    const path = checkout();
    vi.mocked(isHerdrShell).mockReturnValue(true);
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[1] === "rename") throw new Error("Rename failed");
      return destination(path);
    });
    expect(() => prepareHerdrDestination(caller, path, undefined, "Fix login")).toThrow("Rename failed");
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["workspace", "close", "w2"]);
  });
  test("opens a checkout as a workspace and uses its new root shell", () => {
    const path = checkout();
    vi.mocked(runHerdr).mockReturnValue(destination(path));
    vi.mocked(isHerdrShell).mockReturnValue(true);
    const prepared = prepareHerdrDestination(caller, path);
    expect(prepared.location.workspaceId).toBe("w2");
    expect(prepared.location.paneId).toBe("w2:p1");
    expect(runHerdr).toHaveBeenCalledTimes(2);
    expect(runHerdr).toHaveBeenCalledWith(caller, ["tab", "rename", "w2:t1", basename(path)]);
    expect(runHerdr).toHaveBeenCalledWith(caller, ["worktree", "open", "--cwd", path, "--path", path, "--no-focus"]);
    prepared.rollback();
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["workspace", "close", "w2"]);
  });

  test("reuses the idle shell from create without making a second tab", () => {
    const path = checkout();
    const opened = { ...destination(path), already_open: true };
    vi.mocked(runHerdr).mockReturnValue(opened);
    vi.mocked(isHerdrShell).mockReturnValue(true);
    const owned = { ...caller, workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p1", parentWorkspaceId: "w1" };
    const prepared = prepareHerdrDestination(caller, path, owned, "Вход — исправление");
    expect(prepared.location.paneId).toBe("w2:p1");
    expect(runHerdr).toHaveBeenCalledWith(caller, ["tab", "rename", "w2:t1", "Вход — исправление"]);
    prepared.rollback();
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["tab", "close", "w2:t1"]);
  });

  test("never sends Pi into an existing user's pane", () => {
    const path = checkout();
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[0] === "worktree") return { ...destination(path), already_open: true };
      return { tab: { tab_id: "w2:t2", workspace_id: "w2" }, root_pane: { pane_id: "w2:p2", tab_id: "w2:t2", workspace_id: "w2" } };
    });
    const prepared = prepareHerdrDestination(caller, path, undefined, "Fix login");
    expect(prepared.location.paneId).toBe("w2:p2");
    expect(runHerdr).toHaveBeenCalledWith(caller, ["tab", "create", "--workspace", "w2", "--cwd", path, "--label", "Fix login", "--no-focus"]);
    expect(runHerdr).not.toHaveBeenCalledWith(caller, expect.arrayContaining(["rename"]));
    prepared.rollback();
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["tab", "close", "w2:t2"]);
  });
});
describe("Herdr handoff", () => {
  test("closes only the source pane before waiting for the old process to exit", () => {
    const cleanup = buildSourcePaneCleanup("pane-123", 42, "/sessions/source.jsonl");
    expect(cleanup).toContain("herdr pane close 'pane-123'");
    expect(cleanup).not.toContain("herdr tab close");
    expect(cleanup.indexOf("herdr pane close")).toBeLessThan(cleanup.indexOf("kill -0"));
  });

  test("creates a background shell before removing the last source pane", () => {
    vi.mocked(runHerdr).mockReturnValue({ panes: [{ pane_id: caller.paneId, tab_id: caller.tabId, workspace_id: caller.workspaceId }] });
    preserveHerdrSourceWorkspace(caller, "/original");
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["tab", "create", "--workspace", "w1", "--cwd", "/original", "--label", "shell", "--no-focus"]);
  });

  test.each(["w1:t1", "w1:t2"])("keeps other panels in tab %s without adding a shell", (tabId) => {
    vi.mocked(runHerdr).mockReturnValue({ panes: [
      { pane_id: caller.paneId, tab_id: caller.tabId, workspace_id: "w1" },
      { pane_id: "w1:p2", tab_id: tabId, workspace_id: "w1" },
    ] });
    preserveHerdrSourceWorkspace(caller, "/original");
    expect(runHerdr).toHaveBeenCalledTimes(1);
  });

  test("does not treat a pane in another workspace as a source companion", () => {
    vi.mocked(runHerdr).mockReturnValue({ panes: [
      { pane_id: caller.paneId, workspace_id: "w1" },
      { pane_id: "w2:p1", workspace_id: "w2" },
    ] });
    preserveHerdrSourceWorkspace(caller, "/original");
    expect(runHerdr).toHaveBeenCalledTimes(2);
  });

  test("refuses cleanup when the source pane is missing", () => {
    vi.mocked(runHerdr).mockReturnValue({ panes: [] });
    expect(() => preserveHerdrSourceWorkspace(caller, "/original")).toThrow("source pane");
    expect(runHerdr).toHaveBeenCalledTimes(1);
  });

  test("does not continue cleanup if creating the replacement shell fails", () => {
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[0] === "tab") throw new Error("Shell creation failed");
      return { panes: [{ pane_id: caller.paneId, workspace_id: "w1" }] };
    });
    expect(() => preserveHerdrSourceWorkspace(caller, "/original")).toThrow("Shell creation failed");
  });
});

describe("worktree removal output", () => {
  test("does not call a removed history entry a missing argument after session reload", () => {
    let renderCall: ToolDefinition["renderCall"];
    teleport({
      registerTool: (definition: ToolDefinition) => { renderCall = definition.renderCall; },
      registerCommand: () => {},
      on: () => {},
    } as unknown as ExtensionAPI);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Parameters<NonNullable<ToolDefinition["renderCall"]>>[1];
    const context = { cwd: "/repo" } as Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
    expect(renderCall!({ action: "remove", resourceId: "removed" }, theme, context).render(120).join("\n")).not.toContain("resource required");
  });

  test("shows the path and branch instead of the internal resource id", () => {
    const text = formatRemovedWorktree({
      id: "internal-id",
      owner: "pi-agent-teleport",
      kind: "git-worktree",
      repo: "/repo",
      path: "/repo-worktrees/login-fix",
      branch: "fix/login",
      createdAt: 1,
    });

    expect(text).toBe("Removed worktree /repo-worktrees/login-fix\nBranch: fix/login");
    expect(text).not.toContain("internal-id");
  });
});
