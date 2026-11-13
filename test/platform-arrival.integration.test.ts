import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

test("a real Pi restores the destination shell after a Windows arrival", async () => {
  const root = mkdtempSync(join(tmpdir(), "teleport-platform-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const source = join(dirname(import.meta.filename), "..");
  const cli = join(source, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const observed = join(root, "observed.json");
  const observer = join(root, "observer.mjs");
  writeFileSync(observer, `import { writeFileSync } from 'node:fs'; export default pi => pi.on('before_agent_start', () => { writeFileSync(${JSON.stringify(observed)}, JSON.stringify(pi.getActiveTools())); });`);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: [join(source, "src/index.ts"), observer], defaultProvider: "fixture", defaultModel: "model", quietStartup: true }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test", models: [{ id: "model", name: "model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] } } }));
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "system", content: "", toolsAdded: [], timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "move", name: "teleport", arguments: { action: "jump", target: "/destination" } }], api: "openai-completions", provider: "fixture", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
  const session = manager.getSessionFile()!;
  writeFileSync(session, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const commitFile = join(root, "committed.json");
  writeFileSync(commitFile, JSON.stringify({ ok: true }));
  const handoff = join(root, "handoff.json");
  writeFileSync(handoff, JSON.stringify({ sourcePlatform: "win32", sourceBashHidden: true, commitFile, execution: { sessionId: manager.getSessionId(), toolCallId: "move", parentToolCallId: "move" }, expectedModel: { provider: "fixture", id: "model", thinkingLevel: "off" } }));
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEPORT_HANDOFF: handoff, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "tab", HERDR_PANE_ID: "pane" };
  for (const key of Object.keys(env)) if (key.startsWith("HC_") || key === "PI_TELEPORT_CONTINUATION") delete env[key];
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session", session], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (part) => { output += part; });
  child.stderr.on("data", (part) => { output += part; });
  child.stdin.on("error", () => {});
  child.stdin.write(JSON.stringify({ type: "prompt", message: "/__teleport_arrival" }) + "\n");
  try {
    const deadline = Date.now() + 30_000;
    while (!existsSync(observed) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!existsSync(observed)) throw new Error(`Arrival did not start a turn: ${output}`);
    expect(JSON.parse(readFileSync(observed, "utf8"))).toContain("bash");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
