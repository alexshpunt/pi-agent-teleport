import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// Run a separate Pi: the regression happens while Pi restores a persisted session.
test("a real Pi startup refuses a fallback model before the handoff can commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "teleport-model-fallback-"));
  const agent = join(root, "agent");
  const fs = await import("node:fs");
  fs.mkdirSync(agent);
  const source = join(dirname(import.meta.filename), "..");
  const cli = join(source, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  fs.mkdirSync(join(root, "sessions"), { recursive: true });
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendModelChange("missing-provider", "source-model");
  const session = manager.getSessionFile()!;
  writeFileSync(session, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: [join(source, "src/index.ts")], defaultProvider: "writer", defaultModel: "writer", quietStartup: true }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { writer: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test", models: [{ id: "writer", name: "writer", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] } } }));
  const receipt = join(root, "receipt.json");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEPORT_PREFLIGHT: receipt, PI_TELEPORT_EXPECTED_MODEL: JSON.stringify({ provider: "missing-provider", id: "source-model" }) };
  for (const key of Object.keys(env)) if (key.startsWith("HC_") || key.startsWith("HERDR_") || key === "PI_TELEPORT_HANDOFF" || key === "PI_TELEPORT_CONTINUATION") delete env[key];
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session", session], { cwd: root, env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { watcher.close(); reject(new Error(`Pi startup did not produce a receipt: ${stderr}`)); }, 30_000);
      const done = () => { if (existsSync(receipt)) { clearTimeout(timer); watcher.close(); resolve(); } };
      const watcher = watch(root, done);
      child.once("error", (error) => { clearTimeout(timer); watcher.close(); reject(error); });
      child.once("exit", (code) => { if (!existsSync(receipt)) { clearTimeout(timer); watcher.close(); reject(new Error(`Pi exited ${code}: ${stderr}`)); } });
      done();
    });
    const result = JSON.parse(readFileSync(receipt, "utf8"));
    expect(result.ok).toBe(false);
    expect(existsSync(session)).toBe(true);
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);
