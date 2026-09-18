import { describe, expect, test } from "vitest";
import { buildSourceTabCleanup, formatRemovedWorktree } from "./index.ts";

describe("Herdr handoff", () => {
  test("closes the source tab without waiting for the old process to exit", () => {
    const cleanup = buildSourceTabCleanup("tab-123", 42, "/sessions/source.jsonl");

    expect(cleanup).toContain("herdr tab close 'tab-123'");
    expect(cleanup.indexOf("herdr tab close")).toBeLessThan(cleanup.indexOf("kill -0"));
  });
});

describe("worktree removal output", () => {
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
