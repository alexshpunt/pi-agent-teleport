import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { preflightSession } from "../src/readiness.ts";

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
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
    writer: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test", models: [model("writer")] },
    "missing-provider": { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "$TELEPORT_TEST_MISSING_KEY", authHeader: true, models: [model("source-model")] },
  } }));
  const receipt = join(root, "receipt.json");
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEPORT_PREFLIGHT: receipt, PI_TELEPORT_EXPECTED_MODEL: JSON.stringify({ provider: "missing-provider", id: "source-model", thinkingLevel: "off" }) };
  for (const key of Object.keys(env)) if (key.startsWith("HC_") || key.startsWith("HERDR_") || key === "PI_TELEPORT_HANDOFF" || key === "PI_TELEPORT_CONTINUATION") delete env[key];
  delete env.TELEPORT_TEST_MISSING_KEY;
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--session", session], { cwd: root, env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (part: string) => { stderr += part; });
  child.stdin.write(JSON.stringify({ type: "prompt", message: "/__teleport_arrival" }) + "\n");
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

test("a startup probe without Teleport does not send its private command to a model", async () => {
  const root = mkdtempSync(join(tmpdir(), "teleport-guard-"));
  const fs = await import("node:fs");
  const { createServer } = await import("node:http");
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const agent = join(root, "agent");
  fs.mkdirSync(agent);
  const source = join(dirname(import.meta.filename), "..");
  const cli = join(source, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendModelChange("fixture", "model");
  const sessionText = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "model", quietStartup: true }));
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test", models: [{ id: "model", name: "model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] } } }));
  const session = join(root, "session.jsonl");
  writeFileSync(session, sessionText);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEPORT_PREFLIGHT: join(root, "receipt.json") };
  const child = spawn(process.execPath, [cli, "--extension", join(source, "src/arrival-guard.ts"), "--mode", "rpc", "--session", session], { cwd: root, env, stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.on("error", () => {});
  child.stdin.write(JSON.stringify({ type: "prompt", message: "/__teleport_arrival" }) + "\n");
  try {
    const exited = await Promise.race([new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))]);
    expect(exited).toBe(true);
    expect(requests).toBe(0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

test("a local preflight restores the selected model and thinking level even when the session records another model", async () => {
  const root = mkdtempSync(join(tmpdir(), "teleport-selected-model-"));
  const agent = join(root, "agent");
  const fs = await import("node:fs");
  fs.mkdirSync(agent);
  const source = join(dirname(import.meta.filename), "..");
  const cli = join(source, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const router = join(root, "router.mjs");
  const observer = join(root, "observer.mjs");
  const observation = join(root, "observed.json");
  writeFileSync(observer, `import { writeFileSync } from "node:fs"; export default (pi) => { pi.on("resources_discover", async (_event, ctx) => { const model = ctx.modelRegistry.find("fixture", "other-model"); if (model) await pi.setModel(model); }); pi.on("session_shutdown", (_event, ctx) => { writeFileSync(${JSON.stringify(observation)}, JSON.stringify({ provider: ctx.model?.provider, id: ctx.model?.id, thinking: pi.getThinkingLevel() })); }); };`);
  writeFileSync(router, `export default (pi) => { for (const provider of ["fixture", "router"]) pi.registerVirtualModel({ provider, id: "virtual", name: "virtual", thinkingLevels: ["off", "high"], route: (_request, ctx) => ({ model: ctx.modelRegistry.find("fixture", "source-model"), thinkingLevel: "high" }) }); };`);
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendModelChange("fixture", "other-model");
  const sessionText = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ extensions: [router, join(source, "src/index.ts"), observer], defaultProvider: "fixture", defaultModel: "other-model", quietStartup: true }));
  const model = (id: string) => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 });
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "test", models: [model("source-model"), model("other-model")] } } }));
  const previousArgv = process.argv;
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  try {
    process.argv = [process.execPath, cli];
    process.env.PI_CODING_AGENT_DIR = agent;
    process.env.PI_OFFLINE = "1";
    await expect(preflightSession({ target: root, sessionText, expectedModel: { provider: "fixture", id: "source-model", thinkingLevel: "high" } })).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({ provider: "fixture", id: "source-model", thinking: "high" });
    await expect(preflightSession({ target: root, sessionText, expectedModel: { provider: "fixture", id: "virtual", thinkingLevel: "high" } })).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({ provider: "fixture", id: "virtual", thinking: "high" });
    await expect(preflightSession({ target: root, sessionText, expectedModel: { provider: "router", id: "virtual", thinkingLevel: "high" } })).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(observation, "utf8"))).toEqual({ provider: "router", id: "virtual", thinking: "high" });
  } finally {
    process.argv = previousArgv;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);