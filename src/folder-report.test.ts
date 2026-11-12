import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teleport from "./index.ts";
import { clearedFolderReport, folderReport, writeFolderReport } from "./folder-report.ts";

test("reports a Unix folder as an OSC 7 file URI with the host", () => {
  expect(folderReport("/root/dev/a b#c", { host: "box", windows: false })).toBe("\x1b]7;file://box/root/dev/a%20b%23c\x1b\\");
});

test("reports a Windows folder with forward slashes after its drive", () => {
  expect(folderReport("C:\\Users\\me\\dev", { host: "ZinLaptop", windows: true })).toBe("\x1b]7;file://ZinLaptop/C:/Users/me/dev\x1b\\");
});

test("keeps a UNC share's server as the host", () => {
  expect(folderReport("\\\\server\\share\\x", { host: "ZinLaptop", windows: true })).toBe("\x1b]7;file://server/share/x\x1b\\");
});

test("writes only from the TUI to a terminal", () => {
  const write = vi.fn();
  writeFolderReport("tui", "seq", { isTTY: true, write } as unknown as NodeJS.WriteStream);
  writeFolderReport("rpc", "seq", { isTTY: true, write } as unknown as NodeJS.WriteStream);
  writeFolderReport("print", "seq", { isTTY: true, write } as unknown as NodeJS.WriteStream);
  writeFolderReport("tui", "seq", { isTTY: false, write } as unknown as NodeJS.WriteStream);
  expect(write.mock.calls).toEqual([["seq"]]);
});

let root: string;
beforeEach(() => { mkdirSync(resolve(".tmp"), { recursive: true }); root = mkdtempSync(resolve(".tmp/folder-report-")); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent")); });
const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
  else delete (process.stdout as { isTTY?: boolean }).isTTY;
  rmSync(root, { recursive: true, force: true });
});

function hooks() {
  const events = new Map<string, Function[]>();
  teleport({
    on: (name: string, fn: Function) => events.set(name, [...events.get(name) ?? [], fn]),
    registerCommand: () => {}, registerTool: () => {}, registerEntryRenderer: () => {}, registerMessageRenderer: () => {},
  } as unknown as ExtensionAPI);
  return async (name: string, event: unknown, ctx: unknown) => { for (const fn of events.get(name) ?? []) await fn(event, ctx); };
}

function terminal() {
  const writes: string[] = [];
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stdout.write);
  return writes;
}

const session = (cwd: string, mode = "tui") => ({ mode, cwd, sessionManager: { getSessionId: () => "s" }, ui: { notify: () => {} } });

test("each session start reports its folder, and only quitting clears it", async () => {
  const fire = hooks();
  const writes = terminal();
  await fire("session_start", { reason: "startup" }, session("/src/main"));
  await fire("session_shutdown", { reason: "resume" }, session("/src/main"));
  await fire("session_start", { reason: "resume" }, session("/src/feature"));
  await fire("session_shutdown", { reason: "quit" }, session("/src/feature"));
  expect(writes).toEqual([folderReport("/src/main"), folderReport("/src/feature"), clearedFolderReport]);
});

test("a destination readiness check and non-interactive modes report nothing", async () => {
  const fire = hooks();
  const writes = terminal();
  await fire("session_start", { reason: "startup" }, session("/src/main", "print"));
  await fire("session_shutdown", { reason: "quit" }, session("/src/main", "rpc"));
  vi.stubEnv("PI_TELEPORT_PREFLIGHT", join(root, "verdict.json"));
  await fire("session_start", { reason: "startup" }, session("/src/main"));
  await fire("session_shutdown", { reason: "quit" }, session("/src/main"));
  expect(writes).toEqual([]);
});
