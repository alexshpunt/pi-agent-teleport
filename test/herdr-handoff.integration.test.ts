import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";
import { shellQuote } from "../src/remote.ts";
import { herdrLocation, runHerdr, type HerdrContext } from "../src/herdr.ts";

// A named server keeps every pane, tab and process away from the user's own Herdr session.
let available = true;
try { execFileSync("herdr", ["--version"], { stdio: "ignore" }); } catch { available = false; }
const fixtures = join(dirname(import.meta.filename), "fixtures");
const session = `teleport-handoff-${process.pid}`;
let server: ChildProcess | undefined;
let directory: string;
let agentDir: string;
let source: string;
let broken: string;
let good: string;
let slow: string;
let caller: HerdrContext;

/** Inherit the test environment without any handle to the user's live Herdr server. */
function isolated(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "PI_TELEPORT_CONTINUATION", "PI_TELEPORT_HANDOFF"]) delete env[name];
  return { ...env, ...extra };
}

beforeAll(async () => {
  if (!available) return;
  directory = realpathSync(mkdtempSync(join(tmpdir(), "teleport-handoff-")));
  agentDir = join(directory, "agent");
  source = join(directory, "source");
  broken = join(directory, "broken");
  good = join(directory, "good");
  slow = join(directory, "slow");
  for (const path of [agentDir, source, broken, good, slow]) mkdirSync(path);
  // Destination Pi processes load only this Teleport and a local model.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    extensions: [join(fixtures, "..", "..", "src", "index.ts"), join(fixtures, "canned-provider.ts"), join(fixtures, "broken-destination.ts"), join(fixtures, "slow-destination.ts")],
    defaultProvider: "canned", defaultModel: "canned-model", quietStartup: true,
  }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const cli = join(fixtures, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`, { mode: 0o700 });
  // Login profiles may replace PATH and the agent directory. Keep the real Pi
  // installation under test without loading the user's shell configuration.
  const shell = join(bin, "shell");
  writeFileSync(shell, `#!/bin/sh\nexport PATH=${shellQuote(`${bin}:${process.env.PATH}`)}\nexec /bin/bash --noprofile --norc -i\n`, { mode: 0o700 });
  const env = isolated({ SHELL: shell, PATH: `${bin}:${process.env.PATH}`, HERDR_SESSION: session, PI_CODING_AGENT_DIR: agentDir, TELEPORT_TEST_BROKEN_DESTINATION: broken, TELEPORT_TEST_SLOW_DESTINATION: slow });
  server = spawn("herdr", ["--session", session, "server"], { env, stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const response = JSON.parse(execFileSync("herdr", ["workspace", "create", "--cwd", source, "--no-focus"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).result;
      caller = herdrLocation({ workspaceId: "", tabId: "", paneId: "", session }, response);
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

afterAll(() => {
  if (server) {
    try { execFileSync("herdr", ["server", "stop"], { env: isolated({ HERDR_SESSION: session }), stdio: "ignore" }); } catch { /* The server may already be gone. */ }
    server.kill();
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

/** The state directory of the most recent source session. */
function stateDir(): string | undefined {
  const root = join(agentDir, "teleport");
  if (!existsSync(root)) return;
  return readdirSync(root).map((id) => join(root, id)).filter((path) => existsSync(join(path, "state.json")))
    .sort((a, b) => statSync(join(b, "state.json")).mtimeMs - statSync(join(a, "state.json")).mtimeMs)[0];
}
function teleportState(): any {
  const dir = stateDir();
  return dir ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) : undefined;
}
const panes = () => runHerdr(caller, ["pane", "list"]).panes as Array<{ pane_id: string; cwd?: string }>;
function sourceRun(testName: string, target: string, conversation: ReturnType<typeof assistantMessage>[]) {
  const tab = runHerdr(caller, ["tab", "create", "--workspace", caller.workspaceId, "--cwd", source, "--no-focus"]);
  caller = herdrLocation(caller, { ...tab, workspace: { workspace_id: caller.workspaceId } });
  // Each source needs its own process, environment and Herdr identity, not the shared runner's.
  const sharedRunner = process.env.PI_INTEGRATION_TEST_RUNNER;
  delete process.env.PI_INTEGRATION_TEST_RUNNER;
  return new PiIntegrationTest({
    testName,
    timeoutMs: 100_000,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: source,
    // The scripted source believes it runs in the isolated server's source pane.
    environment: isolated({ HERDR_ENV: "1", HERDR_SESSION: session, HERDR_WORKSPACE_ID: caller.workspaceId, HERDR_TAB_ID: caller.tabId, HERDR_PANE_ID: caller.paneId, PI_CODING_AGENT_DIR: agentDir }),
    extensions: [join(fixtures, "..", "..", "src", "index.ts")],
    tools: ["teleport"],
    rawMode: false,
    conversation: [assistantMessage([toolCall({ id: "outward", name: "teleport", arguments: { action: "jump", target } })], { stopReason: "toolUse" }), ...conversation],
  }).run(`Move this session to ${target}`).finally(() => {
    if (sharedRunner !== undefined) process.env.PI_INTEGRATION_TEST_RUNNER = sharedRunner;
  });
}

test.skipIf(!available)("a Herdr destination that dies during startup is rolled back and the source gets its exact output", async () => {
  const result = await sourceRun("herdr-broken-destination", broken, [assistantMessage([text("Staying at the source.")])]);
  expect(result.providerRequests).toHaveLength(2);
  const failure = JSON.stringify(result.providerRequests[1]);
  expect(teleportState().history).toEqual([]);
  expect(failure).toContain("destination boom: database lock held by another process");
  expect(teleportState()).toMatchObject({ active: { cwd: source } });
  expect(teleportState().transition).toBeUndefined();
  expect(panes().map((pane) => pane.pane_id)).toContain(caller.paneId);
  expect(panes().some((pane) => pane.cwd === broken)).toBe(false);
}, 120_000);

test.skipIf(!available)("a Herdr destination taking longer than a minute still commits and continues once", async () => {
  await sourceRun("herdr-slow-destination", slow, [assistantMessage([text("Unreachable source turn.")])]).catch(() => undefined);
  const deadline = Date.now() + 30_000;
  let state: any;
  let entries: any[] = [];
  while (Date.now() < deadline) {
    state = teleportState();
    const file = state?.active?.sessionFile;
    if (state?.active?.cwd === slow && file && existsSync(file)) {
      entries = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      if (entries.some((entry) => entry.message?.role === "assistant" && entry.message.content?.some((item: any) => item.text === "Continuing at the destination."))) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(state?.active?.cwd).toBe(slow);
  expect(state.transition).toBeUndefined();
  expect(entries.filter((entry) => entry.customType === "pi-agent-teleport-continuation")).toHaveLength(1);
  expect(entries.filter((entry) => entry.message?.role === "assistant" && entry.message.content?.some((item: any) => item.text === "Continuing at the destination."))).toHaveLength(1);
  expect(panes().some((pane) => pane.pane_id === state.active.herdr.paneId && pane.cwd === slow)).toBe(true);
}, 120_000);
test.skipIf(!available)("a ready Herdr destination commits, continues the task and retires the source", async () => {
  // The source retires itself after commit, so the harness never sees a second request.
  await sourceRun("herdr-good-destination", good, [assistantMessage([text("Unreachable source turn.")])]).catch(() => undefined);
  const deadline = Date.now() + 60_000;
  let destination: string | undefined;
  while (Date.now() < deadline) {
    const state = teleportState();
    destination = state?.active?.sessionFile;
    if (state?.active?.cwd === good && destination && readFileSync(destination, "utf8").includes("Continuing at the destination.")) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const state = teleportState();
  expect(state.transition).toBeUndefined();
  expect(state.active).toMatchObject({ cwd: good });
  expect(state.history.at(-1)).toMatchObject({ from: source, to: good, status: "completed" });
  const transcript = readFileSync(destination!, "utf8");
  expect(transcript).toContain("pi-agent-teleport-continuation");
  expect(transcript).toContain("Continuing at the destination.");
  const arrival = panes().find((pane) => pane.pane_id === state.active.herdr.paneId);
  expect(arrival?.cwd).toBe(good);
  expect(runHerdr(caller, ["pane", "process-info", "--pane", arrival!.pane_id]).process_info.foreground_processes.some((process: { name?: string }) => process.name === "pi" || process.name === "node")).toBe(true);
  // The readiness receipt is removed once the destination is committed.
  expect(readdirSync(join(stateDir()!, "readiness"))).toEqual([]);
}, 120_000);
