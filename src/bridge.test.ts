import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { abortArrival, commitArrival, stageArrival } from "./bridge.ts";
import { readState, writeState } from "./core.ts";
import { runHerdr } from "./herdr.ts";
import { runtimeFingerprint } from "./remote.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock("./herdr.ts", async (original) => ({ ...await original<typeof import("./herdr.ts")>(), runHerdr: vi.fn() }));
const fixtures: string[] = [];
let originalAgentDir: string | undefined;
beforeEach(() => { originalAgentDir = process.env.PI_CODING_AGENT_DIR; vi.clearAllMocks(); });
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  fixtures.splice(0).forEach((path) => fs.rmSync(path, { recursive: true, force: true }));
});

function arrival(configure?: (input: Parameters<typeof stageArrival>[0], stateDir: string) => void) {
  fs.mkdirSync(resolve(".tmp"), { recursive: true });
  const root = fs.mkdtempSync(resolve(".tmp/arrival-"));
  fixtures.push(root);
  const cwd = join(root, "plain-directory");
  fs.mkdirSync(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  vi.mocked(runHerdr).mockImplementation((_context, args) => {
    if (args[0] === "workspace" && args[1] === "create") return {
      workspace: { workspace_id: "w2" }, tab: { tab_id: "w2:t1", workspace_id: "w2" }, root_pane: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "w2:t1" },
    };
    return { type: "ok" };
  });
  const sessionId = `test-${randomUUID()}`;
  const stateDir = join(process.env.PI_CODING_AGENT_DIR, "teleport", sessionId);
  const previous = readState(stateDir);
  previous.history.push({ from: "/earlier", to: "/source", at: 1, status: "completed" });
  writeState(stateDir, previous);
  const input: Parameters<typeof stageArrival>[0] = {
    operationId: randomUUID(), sessionId,
    sessionText: JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: "/source" }) + "\n",
    path: cwd, state: previous, connection: { session: "test", workspaceId: "", paneId: "", tabId: "" },
    callback: { socket: "/private/controller.sock", token: "private-token" }, fingerprint: runtimeFingerprint(), from: "/source", to: cwd,
  };
  configure?.(input, stateDir);
  const prepared = stageArrival(input);
  return { prepared, stateDir, previous };
}

test("an arrival does not publish completed history before destination readiness", () => {
  const { prepared, stateDir, previous } = arrival();
  expect(readState(stateDir)).toEqual(previous);
  abortArrival(prepared);
  expect(readState(stateDir)).toEqual(previous);
});

test("a marker-publication failure restores the exact prior state before removing the destination", async () => {
  const { prepared, stateDir, previous } = arrival();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fs.writeFileSync).mockImplementation(((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(path).includes("/committed.json.")) throw new Error("Disk full publishing commit marker");
    return (actual.writeFileSync as (...args: unknown[]) => void)(path, ...args);
  }) as typeof fs.writeFileSync);
  expect(() => commitArrival(prepared)).toThrow("Disk full");
  expect(readState(stateDir).active?.sessionFile).toBe(prepared.sessionFile);
  abortArrival(prepared);
  expect(readState(stateDir)).toEqual(previous);
  expect(fs.existsSync(prepared.dir)).toBe(false);
  vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync);
});

test("authenticated recovery can replace only the exact unchanged dormant source", () => {
  const { prepared, stateDir, previous } = arrival((input, stateDir) => {
    const source = join(stateDir, "retained-source.jsonl");
    fs.writeFileSync(source, input.sessionText);
    const operationId = randomUUID();
    input.state.active = { cwd: "/source", sessionFile: source };
    input.state.pendingRemote = { id: operationId, receipt: "/private/receipt.json" };
    writeState(stateDir, input.state);
    input.dormantSource = { operationId, sessionFile: source, cwd: "/source", snapshot: input.sessionText };
  });
  expect(fs.existsSync(previous.active!.sessionFile)).toBe(true);
  expect(readState(stateDir)).toEqual(previous);
  abortArrival(prepared);
  expect(fs.existsSync(previous.active!.sessionFile)).toBe(true);
});

test("a changed retained source cannot be replaced during return recovery", () => {
  expect(() => arrival((input, stateDir) => {
    const source = join(stateDir, "retained-source.jsonl");
    fs.writeFileSync(source, input.sessionText + "changed conversation\n");
    const operationId = randomUUID();
    input.state.active = { cwd: "/source", sessionFile: source };
    input.state.pendingRemote = { id: operationId, receipt: "/private/receipt.json" };
    writeState(stateDir, input.state);
    input.dormantSource = { operationId, sessionFile: source, cwd: "/source", snapshot: input.sessionText };
  })).toThrow("already has a resumable copy");
  expect(runHerdr).not.toHaveBeenCalled();
});
test("a committed arrival cannot be rolled back", () => {
  const { prepared, stateDir } = arrival();
  commitArrival(prepared);
  expect(readState(stateDir).active?.sessionFile).toBe(prepared.sessionFile);
  expect(() => abortArrival(prepared)).toThrow("already committed");
  expect(fs.existsSync(prepared.sessionFile)).toBe(true);
});
