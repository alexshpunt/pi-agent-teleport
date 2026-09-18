import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createManagedWorktree, readState, reconcileState, removeManagedWorktree, writeState } from "./core.ts";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "teleport-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "README"), "test");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

describe("managed worktrees", () => {
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
