import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teleport from "./index.ts";
import { clearedFolderReport, folderReport, writeFolderReport } from "./folder-report.ts";

const osc = (url: string) => `\x1b]7;${url}?herdr-pid=${process.pid}\x1b\\`;

test("reports a Unix folder as an OSC 7 file URI with the host", () => {
  expect(folderReport("/root/dev/a b#c", { host: "box", windows: false })).toBe(osc("file://box/root/dev/a%20b%23c"));
});

test("reports a Windows folder with forward slashes after its drive", () => {
  expect(folderReport("C:\\Users\\me\\dev", { host: "ZinLaptop", windows: true })).toBe(osc("file://ZinLaptop/C:/Users/me/dev"));
});

test("reports UNC shares with the local host and an encoded path", () => {
  expect(folderReport("\\\\server\\share\\x", { host: "ZinLaptop", windows: true })).toBe(osc("file://ZinLaptop/%5C%5Cserver%5Cshare%5Cx"));
  expect(folderReport("\\\\server\\share", { host: "ZinLaptop", windows: true })).toBe(osc("file://ZinLaptop/%5C%5Cserver%5Cshare"));
  expect(folderReport("\\\\localhost\\C$\\Users\\me", { host: "ZinLaptop", windows: true })).toBe(osc("file://ZinLaptop/%5C%5Clocalhost%5CC%24%5CUsers%5Cme"));
  expect(folderReport("//localhost/C$/Users/me", { host: "ZinLaptop", windows: true })).toBe(osc("file://ZinLaptop/%5C%5Clocalhost%5CC%24%5CUsers%5Cme"));
  expect(folderReport("\\\\server\\share\\проект #1%", { host: "ZinLaptop", windows: true })).toBe(osc("file://ZinLaptop/%5C%5Cserver%5Cshare%5C%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82%20%231%25"));
});

test("identifies the reporting process for delayed listings and replay", () => {
  expect(folderReport("/src", { host: "box", windows: false })).toBe(`\x1b]7;file://box/src?herdr-pid=${process.pid}\x1b\\`);
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
beforeEach(() => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  root = mkdtempSync(resolve(".tmp/folder-report-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("HC_TERMINAL_ID", "");
  vi.stubEnv("HC_TERMINAL_SOCKET", "");
  vi.stubEnv("HC_SOCKET", "");
});
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

test("reports the process token issued by its owning core", async () => {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\teleport-test-${process.pid}-${Date.now()}` : join(root, "core.sock");
  const requests: unknown[] = [];
  const server = createServer((connection) => {
    let data = "";
    connection.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.slice(0, data.indexOf("\n")));
      requests.push(request);
      connection.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { token: "issued+token", in_front: null } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
  try {
    vi.stubEnv("HC_TERMINAL_ID", "t7");
    vi.stubEnv("HC_TERMINAL_SOCKET", socket);
    const fire = hooks();
    const writes = terminal();
    await fire("session_start", { reason: "startup" }, session("/src/main"));
    expect(requests).toMatchObject([{ method: "terminal.process", params: { terminal: "t7", pid: process.pid } }]);
    expect(writes).toEqual([folderReport("/src/main").replace("\x1b\\", "&herdr-token=issued%2Btoken\x1b\\")]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
test("a delayed token cannot restore a folder after the session quits", async () => {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\teleport-race-${process.pid}-${Date.now()}` : join(root, "race.sock");
  let reply!: () => void;
  let received!: () => void;
  const requested = new Promise<void>((resolve) => { received = resolve; });
  const server = createServer((connection) => {
    let data = "";
    connection.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.slice(0, data.indexOf("\n")));
      reply = () => connection.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { token: "late", in_front: null } })}\n`);
      received();
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
  try {
    vi.stubEnv("HC_TERMINAL_ID", "t7");
    vi.stubEnv("HC_TERMINAL_SOCKET", socket);
    const fire = hooks();
    const writes = terminal();
    const startup = fire("session_start", { reason: "startup" }, session("/src/old"));
    await requested;
    await fire("session_shutdown", { reason: "quit" }, session("/src/old"));
    reply();
    await startup;
    expect(writes).toEqual([clearedFolderReport]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("reports a token when a temporarily unavailable core recovers", async () => {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\teleport-retry-${process.pid}-${Date.now()}` : join(root, "retry.sock");
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      connection.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { token: "recovered" } })}\n`);
    });
  });
  try {
    vi.stubEnv("HC_TERMINAL_ID", "t7");
    vi.stubEnv("HC_TERMINAL_SOCKET", socket);
    const fire = hooks();
    const writes = terminal();
    await fire("session_start", { reason: "startup" }, session("/src/main"));
    expect(writes).toEqual([folderReport("/src/main")]);
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
    await vi.waitFor(() => expect(writes).toEqual([folderReport("/src/main"), folderReport("/src/main", { token: "recovered" })]), { timeout: 4000, interval: 25 });
    await fire("session_shutdown", { reason: "quit" }, session("/src/main"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 7000);
test("a retry from an old session cannot overwrite a newer session", async () => {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\teleport-retry-race-${process.pid}-${Date.now()}` : join(root, "retry-race.sock");
  let attempts = 0;
  let lateReply: (() => void) | undefined;
  const server = createServer((connection) => {
    let input = "";
    connection.on("data", (data) => {
      input += data.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.slice(0, input.indexOf("\n")));
      const attempt = ++attempts;
      const respond = (token: string | null) => connection.end(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { token } })}\n`);
      if (attempt === 1) respond(null);
      else if (attempt === 2) lateReply = () => respond("old");
      else respond("new");
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socket, resolve));
  try {
    vi.stubEnv("HC_TERMINAL_ID", "t7");
    vi.stubEnv("HC_TERMINAL_SOCKET", socket);
    const fire = hooks();
    const writes = terminal();
    await fire("session_start", { reason: "startup" }, session("/src/old"));
    await vi.waitFor(() => expect(lateReply).toBeDefined(), { timeout: 4000, interval: 25 });
    await fire("session_shutdown", { reason: "resume" }, session("/src/old"));
    await fire("session_start", { reason: "resume" }, session("/src/new"));
    lateReply!();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(writes).toEqual([folderReport("/src/old"), folderReport("/src/new", { token: "new" })]);
    await fire("session_shutdown", { reason: "quit" }, session("/src/new"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 7000);
test("an unavailable core still reports the folder without a process token", async () => {
  vi.stubEnv("HC_TERMINAL_ID", "t7");
  vi.stubEnv("HC_TERMINAL_SOCKET", process.platform === "win32" ? `\\\\.\\pipe\\missing-${process.pid}` : join(root, "missing.sock"));
  const fire = hooks();
  const writes = terminal();
  await fire("session_start", { reason: "startup" }, session("/src/main"));
  expect(writes).toEqual([folderReport("/src/main")]);
  await fire("session_shutdown", { reason: "quit" }, session("/src/main"));
});
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
