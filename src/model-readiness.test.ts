import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { getHerdrContext } from "./herdr.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teleport from "./index.ts";
import { extensionFile } from "./remote.ts";

vi.mock("./herdr.ts", async (original) => ({ ...await original<typeof import("./herdr.ts")>(), getHerdrContext: vi.fn() }));

test("a startup probe rejects a different fallback model before declaring readiness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teleport-model-"));
  const receipt = join(dir, "ready.json");
  const events = new Map<string, Function>();
  vi.stubEnv("PI_TELEPORT_PREFLIGHT", receipt);
  vi.stubEnv("PI_TELEPORT_EXPECTED_MODEL", JSON.stringify({ provider: "anthropic", id: "claude-sonnet-5-5" }));
  const ctx = {
    model: { provider: "writer", id: "writer" },
    modelRegistry: { getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, value: {} }) },
    sessionManager: { getSessionFile: () => "/owned/session.jsonl" },
  };
  try {
    teleport({ on: (name: string, fn: Function) => events.set(name, fn), registerCommand: () => {}, registerTool: () => {}, registerEntryRenderer: () => {}, getAllTools: () => [{ name: "teleport", sourceInfo: { path: extensionFile } }] } as unknown as ExtensionAPI);
    await events.get("resources_discover")!({}, ctx);
    const result = JSON.parse(readFileSync(receipt, "utf8"));
    expect(result.ok).toBe(false);
    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
});


test("a remote arrival with a fallback model reports failure and shuts down without committing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teleport-model-arrival-"));
  const events = new Map<string, Function>();
  let packet: any;
  const server = createServer((socket) => socket.once("data", (data) => { packet = JSON.parse(data.toString()); socket.end('{"ok":true}\n'); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const file = join(dir, "handoff.json");
  writeFileSync(file, JSON.stringify({ socket: `tcp://127.0.0.1:${port}`, token: "test-token", operationId: "owned", expectedModel: { provider: "anthropic", id: "claude-sonnet-5-5" }, execution: { sessionId: "session", toolCallId: "call", parentToolCallId: "call" } }));
  vi.stubEnv("PI_TELEPORT_HANDOFF", file);
  vi.mocked(getHerdrContext).mockReturnValue({ workspaceId: "space", tabId: "tab", paneId: "pane", session: "test" });
  const ctx = { model: { provider: "writer", id: "writer" }, modelRegistry: { getApiKeyAndHeaders: vi.fn() }, sessionManager: { getSessionId: () => "session", getBranch: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call" }] } }] }, ui: { notify: vi.fn() }, shutdown: vi.fn() };
  try {
    teleport({ on: (name: string, fn: Function) => events.set(name, fn), registerCommand: () => {}, registerTool: () => {}, registerEntryRenderer: () => {}, getAllTools: () => [{ name: "teleport", sourceInfo: { path: extensionFile } }] } as unknown as ExtensionAPI);
    await events.get("resources_discover")!({}, ctx);
    expect(packet).toMatchObject({ action: "failed", operationId: "owned", token: "test-token" });
    expect(ctx.shutdown).toHaveBeenCalledOnce();
    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); vi.resetAllMocks(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
