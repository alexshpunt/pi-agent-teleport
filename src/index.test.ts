import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { prepareHerdrDestination } from "./core.ts";
import { runHerdr, isHerdrShell, type HerdrContext } from "./herdr.ts";
import teleport, { buildSourceTabCleanup, formatRemovedWorktree } from "./index.ts";
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
  test("opens a checkout as a workspace and uses its new root shell", () => {
    const path = checkout();
    vi.mocked(runHerdr).mockReturnValue(destination(path));
    vi.mocked(isHerdrShell).mockReturnValue(true);
    const prepared = prepareHerdrDestination(caller, path);
    expect(prepared.location.workspaceId).toBe("w2");
    expect(prepared.location.paneId).toBe("w2:p1");
    expect(runHerdr).toHaveBeenCalledTimes(1);
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
    const prepared = prepareHerdrDestination(caller, path, owned);
    expect(prepared.location.paneId).toBe("w2:p1");
    prepared.rollback();
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["tab", "close", "w2:t1"]);
  });

  test("never sends Pi into an existing user's pane", () => {
    const path = checkout();
    vi.mocked(runHerdr).mockImplementation((_context, args) => {
      if (args[0] === "worktree") return { ...destination(path), already_open: true };
      return { tab: { tab_id: "w2:t2", workspace_id: "w2" }, root_pane: { pane_id: "w2:p2", tab_id: "w2:t2", workspace_id: "w2" } };
    });
    const prepared = prepareHerdrDestination(caller, path);
    expect(prepared.location.paneId).toBe("w2:p2");
    expect(runHerdr).toHaveBeenCalledWith(caller, ["tab", "create", "--workspace", "w2", "--cwd", path, "--label", "Teleport", "--no-focus"]);
    prepared.rollback();
    expect(runHerdr).toHaveBeenLastCalledWith(caller, ["tab", "close", "w2:t2"]);
  });
});
describe("Herdr handoff", () => {
  test("closes the source tab without waiting for the old process to exit", () => {
    const cleanup = buildSourceTabCleanup("tab-123", 42, "/sessions/source.jsonl");

    expect(cleanup).toContain("herdr tab close 'tab-123'");
    expect(cleanup.indexOf("herdr tab close")).toBeLessThan(cleanup.indexOf("kill -0"));
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
