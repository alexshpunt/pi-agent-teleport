import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { retireAppSource } from "./bridge.ts";
import { assertHerdrContext, runHerdr } from "./herdr.ts";

vi.mock("./herdr.ts", async (original) => ({ ...await original<typeof import("./herdr.ts")>(), assertHerdrContext: vi.fn(), runHerdr: vi.fn() }));
const context = { backend: "app" as const, workspaceId: "sp1", tabId: "tb1", paneId: "t1", session: "isolated" };
let fixture: string;
let sessionFile: string;
beforeEach(() => {
  vi.resetAllMocks();
  mkdirSync(resolve(".tmp"), { recursive: true });
  fixture = mkdtempSync(resolve(".tmp/cleanup-"));
  sessionFile = join(fixture, "session.jsonl");
  writeFileSync(sessionFile, "source transcript");
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(fixture, { recursive: true, force: true }); });
const cleanup = () => retireAppSource({ context, sourcePid: 42, cwd: "/source", sessionFile });
function observe(group: number, processes: Array<{ pid: number; cwd: string; argv?: string[] }>) {
  vi.mocked(runHerdr).mockReturnValue({ process_info: { shell_pid: 10, foreground_process_group_id: group, foreground_processes: processes } });
}

test("App retirement verifies the source process before closing and deleting its transcript", async () => {
  observe(40, [{ pid: 42, cwd: "/source", argv: ["pi", "--session", sessionFile] }]);
  await cleanup();
  expect(assertHerdrContext).toHaveBeenCalledWith(context);
  expect(vi.mocked(runHerdr).mock.calls.map(([, args]) => args)).toEqual([["pane", "process-info", "--pane", "t1"], ["pane", "close", "t1"]]);
  expect(existsSync(sessionFile)).toBe(false);
});

test.each([
  { pid: 42, cwd: "/other" },
  { pid: 42, cwd: "/source", argv: ["pi", "--session", "/other.jsonl"] },
  { pid: 99, cwd: "/source" },
])("App retirement retains a pane and transcript occupied by another process: %j", async (process) => {
  observe(40, [process]);
  await expect(cleanup()).rejects.toThrow();
  expect(vi.mocked(runHerdr).mock.calls).toHaveLength(1);
  expect(existsSync(sessionFile)).toBe(true);
});

test("App retirement can close an idle shell only after its source process has exited", async () => {
  observe(10, [{ pid: 10, cwd: "/source" }]);
  await cleanup();
  expect(vi.mocked(runHerdr).mock.calls.at(-1)?.[1]).toEqual(["pane", "close", "t1"]);
  expect(existsSync(sessionFile)).toBe(false);
});
