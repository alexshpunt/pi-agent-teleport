import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { retireAppSource, retireSessionFile } from "./bridge.ts";
import { retireDesktopSource } from "./bridge.ts";
import { preserveHerdrSourceWorkspace } from "./core.ts";
import { assertHerdrContext, runHerdr } from "./herdr.ts";

vi.mock("./herdr.ts", async (original) => ({ ...await original<typeof import("./herdr.ts")>(), assertHerdrContext: vi.fn(), runHerdr: vi.fn() }));
vi.mock("./core.ts", async (original) => ({ ...await original<typeof import("./core.ts")>(), preserveHerdrSourceWorkspace: vi.fn() }));
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

test("a desktop return preserves its workspace before retiring the verified source", async () => {
  observe(40, [{ pid: 42, cwd: "/source", argv: ["pi", "--session", sessionFile] }]);
  await retireDesktopSource({ context, sourcePid: 42, cwd: "/source", sessionFile });
  expect(preserveHerdrSourceWorkspace).toHaveBeenCalledWith(context, "/source");
  expect(vi.mocked(runHerdr).mock.calls.at(-1)?.[1]).toEqual(["pane", "close", "t1"]);
  expect(existsSync(sessionFile)).toBe(true);
});

test("desktop cleanup completes when the source has exited and its pane is already gone", async () => {
  vi.mocked(assertHerdrContext).mockImplementation(() => { throw new Error("pane gone"); });
  await retireDesktopSource({ context, sourcePid: 42, cwd: "/source", sessionFile });
  expect(runHerdr).not.toHaveBeenCalled();
  expect(existsSync(sessionFile)).toBe(true);
});
test("desktop cleanup refuses an unverifiable pane while the source is alive", async () => {
  vi.mocked(assertHerdrContext).mockImplementation(() => { throw new Error("pane unavailable"); });
  vi.mocked(process.kill).mockReturnValue(true);
  await expect(retireDesktopSource({ context, sourcePid: 42, cwd: "/source", sessionFile })).rejects.toThrow();
  expect(runHerdr).not.toHaveBeenCalled();
  expect(existsSync(sessionFile)).toBe(true);
});
test("desktop arrival retirement notifies its return controller after closing the source", async () => {
  let packet: any;
  const server = createServer((socket) => socket.once("data", (data) => { packet = JSON.parse(data.toString()); socket.end('{"ok":true}\n'); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  observe(40, [{ pid: 42, cwd: "/source", argv: ["pi", "--session", sessionFile] }]);
  try {
    await retireAppSource({ context, sourcePid: 42, cwd: "/source", sessionFile, retireRoute: { socket: `tcp://127.0.0.1:${port}`, token: "secret", operationId: "operation" } });
    expect(packet).toEqual({ token: "secret", action: "app-retired", operationId: "operation" });
    expect(existsSync(sessionFile)).toBe(true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("a committed source transcript is removed after exit without contacting Herdr", async () => {
  const stat = lstatSync(sessionFile);
  await retireSessionFile({ sourcePid: 42, sessionFile, dev: stat.dev, ino: stat.ino });
  expect(existsSync(sessionFile)).toBe(false);
  expect(runHerdr).not.toHaveBeenCalled();
});

test("a committed source transcript is retained while its process remains alive", async () => {
  vi.useFakeTimers();
  vi.mocked(process.kill).mockReturnValue(true);
  const stat = lstatSync(sessionFile);
  const outcome = retireSessionFile({ sourcePid: 42, sessionFile, dev: stat.dev, ino: stat.ino }).then(() => false, () => true);
  await vi.advanceTimersByTimeAsync(5_100);
  expect(await outcome).toBe(true);
  expect(existsSync(sessionFile)).toBe(true);
  vi.useRealTimers();
});
test("a replacement transcript is retained", async () => {
  const stat = lstatSync(sessionFile);
  renameSync(sessionFile, join(fixture, "old.jsonl"));
  writeFileSync(sessionFile, "replacement");
  await expect(retireSessionFile({ sourcePid: 42, sessionFile, dev: stat.dev, ino: stat.ino })).rejects.toThrow();
  expect(existsSync(sessionFile)).toBe(true);
});
test("a verified exited source session is cleaned even if closing its pane fails", async () => {
  observe(40, [{ pid: 42, cwd: "/source", argv: ["pi", "--session", sessionFile] }]);
  vi.mocked(runHerdr).mockImplementation((_context, args) => {
    if (args[1] === "close") throw new Error("UI unavailable");
    return { process_info: { shell_pid: 10, foreground_process_group_id: 40, foreground_processes: [{ pid: 42, cwd: "/source", argv: ["pi", "--session", sessionFile] }] } };
  });
  const stat = lstatSync(sessionFile);
  await expect(cleanup()).rejects.toThrow();
  await retireSessionFile({ sourcePid: 42, sessionFile, dev: stat.dev, ino: stat.ino });
  expect(existsSync(sessionFile)).toBe(false);
});
test("App retirement verifies the source process before closing its pane", async () => {
  observe(40, [{ pid: 42, cwd: "/source", argv: ["pi", "--session", sessionFile] }]);
  await cleanup();
  expect(assertHerdrContext).toHaveBeenCalledWith(context);
  expect(vi.mocked(runHerdr).mock.calls.map(([, args]) => args)).toEqual([["pane", "process-info", "--pane", "t1"], ["pane", "close", "t1"]]);
  expect(existsSync(sessionFile)).toBe(true);
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
  expect(existsSync(sessionFile)).toBe(true);
});
