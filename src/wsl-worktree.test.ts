import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createManagedWorktree, readState, removeManagedWorktree } from "./core.ts";
import { wslDistro, wslRepo } from "../test/fixtures/wsl-repo.ts";

test.skipIf(!wslDistro).each(["wsl.localhost", "wsl$"])("Windows Pi manages an untrusted WSL worktree through %s", (server) => {
  const fixture = wslRepo(server);
  const globalConfig = () => execFileSync("git", ["config", "--global", "--list"], { encoding: "utf8" });
  const before = globalConfig();
  try {
    // Confirm this fixture reproduces the user's ownership boundary.
    expect(() => execFileSync("git", ["status", "--porcelain"], { cwd: fixture.repo, stdio: "pipe" })).toThrow();
    const stateDir = join(fixture.root, "state");
    const managed = createManagedWorktree({ repo: fixture.repo, branch: "owned", path: "../owned checkout", stateDir });
    expect(managed.path).toBe(join(fixture.root, "owned checkout"));
    expect(readState(stateDir).resources[managed.id]).toEqual(managed);
    expect(fixture.git(["branch", "--show-current"], fixture.linuxRepo + "/../owned checkout")).toBe("owned");
    // Linux Git must be able to use the checkout; no Windows-only metadata.
    expect(readFileSync(join(managed.path, ".git"), "utf8")).toContain("gitdir: /");

    // Exercise an absolute common-dir returned by Git from a linked source.
    const nested = createManagedWorktree({ repo: managed.path, branch: "nested", stateDir });
    removeManagedWorktree({ repo: managed.path, id: nested.id, stateDir });
    writeFileSync(join(managed.path, "dirty"), "keep me");
    expect(() => removeManagedWorktree({ repo: fixture.repo, id: managed.id, stateDir })).toThrow();
    expect(readState(stateDir).resources[managed.id]).toEqual(managed);
    unlinkSync(join(managed.path, "dirty"));
    removeManagedWorktree({ repo: fixture.repo, id: managed.id, stateDir });
    expect(existsSync(managed.path)).toBe(false);
    expect(readState(stateDir).resources).toEqual({});
    expect(fixture.git(["branch", "--list", "owned", "nested"])).toBe("");
    expect(globalConfig()).toBe(before);
  } finally { fixture.cleanup(); }
}, 30000);
