import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import teleport from "./index.ts";
import { readState } from "./core.ts";
import { getHerdrContext } from "./herdr.ts";
import { probeRemote, remoteMachine, startRemoteMove, UnknownRemoteOutcome } from "./remote.ts";

vi.mock("./herdr.ts", async (original) => ({ ...await original<typeof import("./herdr.ts")>(), getHerdrContext: vi.fn(), assertHerdrContext: vi.fn() }));
vi.mock("./remote.ts", async (original) => ({ ...await original<typeof import("./remote.ts")>(), probeRemote: vi.fn(), remoteMachine: vi.fn(), startRemoteMove: vi.fn() }));
let root: string;
beforeEach(() => { vi.resetAllMocks(); mkdirSync(resolve(".tmp"), { recursive: true }); root = mkdtempSync(resolve(".tmp/deferred-")); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent")); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const header = { type: "session", version: 3, id: "owned-session", cwd: root };
  const entries: any[] = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "root" }] } }];
  const file = join(root, "source.jsonl");
  writeFileSync(file, JSON.stringify(header) + "\n");
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  let tool: ToolDefinition;
  let command = "";
  const messages: any[] = [];
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => header.id, getHeader: () => header, getSessionFile: () => file, getSessionName: () => undefined, getEntries: () => entries, getBranch: () => entries },
    ui: { notify: vi.fn() }, isIdle: () => true, switchSession: vi.fn(async () => ({ cancelled: true })), shutdown: vi.fn(),
  };
  teleport({
    on: (name: string, fn: Function) => { events.set(name, fn); },
    registerCommand: (name: string, definition: any) => { commands.set(name, definition); },
    registerTool: (definition: ToolDefinition) => { tool = definition; }, registerEntryRenderer: () => {},
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendUserMessage: (text: string) => { command = text; },
    sendMessage: (message: any) => { messages.push(message); events.get("message_end")!({ message: { ...message, role: "custom" } }, ctx); },
  } as unknown as ExtensionAPI);
  await events.get("session_start")!({}, ctx);
  async function queue(target: string) {
    await events.get("tool_execution_start")!({ toolCallId: "root", toolName: "teleport" }, ctx);
    const receipt = await tool!.execute("root", { action: "jump", target }, undefined, undefined, ctx as any);
    await events.get("tool_execution_end")!({ toolCallId: "root" }, ctx);
    await events.get("agent_settled")!({}, ctx);
    expect(receipt.content[0]).toMatchObject({ text: expect.stringContaining("queued") });
    await commands.get("__teleport_internal").handler(command.split(" ")[1], ctx);
  }
  return { ctx, file, entries, messages, queue, stateDir: join(root, "agent", "teleport", header.id) };
}

test.each([true, false])("an uncertain remote outcome keeps its fence and does not wake a competing model (%s)", async (uncertain) => {
  vi.mocked(getHerdrContext).mockReturnValue({ paneId: "pane", workspaceId: "workspace", tabId: "tab", session: "test" });
  vi.mocked(remoteMachine).mockReturnValue({ machine: "worker", remoteSession: "worker-session" });
  vi.mocked(probeRemote).mockReturnValue({ fingerprint: "same", worker: "/remote/bridge.ts", agentDir: "/remote/agent", version: "1.3.0" });
  vi.mocked(startRemoteMove).mockRejectedValue(uncertain ? new UnknownRemoteOutcome("Inspect the commit receipt.") : new Error("Destination refused readiness."));
  const f = await fixture();
  await f.queue("ssh://worker/target");
  expect(readFileSync(f.file, "utf8")).toContain("owned-session");
  expect(f.ctx.shutdown).not.toHaveBeenCalled();
  expect(!!readState(f.stateDir).pendingRemote).toBe(uncertain);
  expect(f.messages).toHaveLength(uncertain ? 0 : 1);
  expect(f.entries.at(-1).data).toMatchObject({ sessionId: "owned-session", toolCallId: "root", parentToolCallId: "root", status: uncertain ? "uncertain" : "failed" });
  expect(vi.mocked(startRemoteMove).mock.calls[0][0].execution).toEqual({ sessionId: "owned-session", toolCallId: "root", parentToolCallId: "root" });
});

test("a cancelled local switch retains the source and reports failure rather than completion", async () => {
  const f = await fixture();
  const target = join(root, "target");
  mkdirSync(target);
  await f.queue(target);
  expect(readFileSync(f.file, "utf8")).toContain("owned-session");
  expect(readState(f.stateDir).transition).toBeUndefined();
  expect(f.entries.at(-1).data).toMatchObject({ parentToolCallId: "root", status: "failed", text: "Teleport failed: Teleport was cancelled." });
  expect(f.messages).toHaveLength(1);
});
