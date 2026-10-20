import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assistantMessage, PiIntegrationTest, PiRun, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test.each(["direct", "nested"])("a queued %s failure stays with its originating execution and delivers full model data once", async (mode) => {
  const cwd = await mkdtemp(join(tmpdir(), "teleport-delayed-output-"));
  roots.push(cwd);
  const name = mode === "direct" ? "teleport" : "teleport_outer";
  const result = await new PiIntegrationTest({
    testName: `teleport-delayed-${mode}-failure`,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    environment: { ...process.env, HERDR_ENV: "", HERDR_PANE_ID: "", HERDR_TAB_ID: "", HERDR_WORKSPACE_ID: "" },
    extensions: [join(dirname(import.meta.filename), "..", "src", "index.ts"), join(dirname(import.meta.filename), "fixtures", "nested-teleport.ts")],
    tools: [name, "teleport", "teleport_inner"],
    rawMode: false,
    isolateUserResources: true,
    conversation: [
      assistantMessage([toolCall({ id: "move-root", name, arguments: mode === "direct" ? { action: "back" } : {} })], { stopReason: "toolUse" }),
      assistantMessage([text("Continued after the failed move.")]),
    ],
  }).run("Return to the previous location");
  const saved = await PiRun.open(result.artifacts.directory);
  const entries = saved.session!.trim().split("\n").map((line) => JSON.parse(line));
  const outcomes = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-agent-teleport-outcome");
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0].data).toMatchObject({
    sessionId: entries[0].id,
    toolCallId: mode === "direct" ? "move-root" : "move-root/1/1",
    parentToolCallId: "move-root",
    status: "failed",
    text: "Teleport failed: Teleport history is empty.",
  });
  const deliveries = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-agent-teleport-failure");
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].display).toBe(false);
  expect(deliveries[0].content).toContain("Continue the original task from the current location.");
  expect(result.providerRequests).toHaveLength(2);
  const request = JSON.stringify(result.providerRequests[1]);
  expect(request.match(/Teleport failed: Teleport history is empty\./g)).toHaveLength(1);
  expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
  expect(entries.indexOf(outcomes[0])).toBeGreaterThan(entries.findIndex((entry) => entry.type === "message" && entry.message.role === "toolResult"));
  expect(result.terminalOutput).toContain("Teleport failed: Teleport history is empty.");
});

test("local jump and nested back carry both outcomes into the same destination session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "teleport-roundtrip-"));
  const target = await mkdtemp(join(tmpdir(), "teleport-destination-"));
  roots.push(cwd, target);
  const capture = join(testArtifactsDir(import.meta.filename), "teleport-delayed-roundtrip", "native-final-session.jsonl");
  const result = await new PiIntegrationTest({
    testName: "teleport-delayed-roundtrip",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    environment: { ...process.env, HERDR_ENV: "", HERDR_PANE_ID: "", HERDR_TAB_ID: "", HERDR_WORKSPACE_ID: "", TELEPORT_TEST_CAPTURE: capture },
    extensions: [join(dirname(import.meta.filename), "..", "src", "index.ts"), join(dirname(import.meta.filename), "fixtures", "nested-teleport.ts"), join(dirname(import.meta.filename), "fixtures", "capture-session.ts")],
    tools: ["teleport", "teleport_outer", "teleport_inner"],
    rawMode: false,
    isolateUserResources: true,
    conversation: [
      assistantMessage([toolCall({ id: "outward", name: "teleport", arguments: { action: "jump", target } })], { stopReason: "toolUse" }),
      assistantMessage([toolCall({ id: "return-root", name: "teleport_outer", arguments: {} })], { stopReason: "toolUse" }),
      assistantMessage([text("Returned to the original directory.")]),
    ],
  }).run("Move to the destination and return");
  const entries = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const outcomes = entries.filter((entry) => entry.type === "custom" && entry.customType === "pi-agent-teleport-outcome");
  expect(entries[0].cwd).toBe(cwd);
  expect(outcomes.map((entry) => entry.data)).toEqual([
    expect.objectContaining({ sessionId: entries[0].id, toolCallId: "outward", parentToolCallId: "outward", status: "completed", text: `Agent teleported: ${cwd} → ${target}` }),
    expect.objectContaining({ sessionId: entries[0].id, toolCallId: "return-root/1/1", parentToolCallId: "return-root", status: "completed", text: `Agent teleported: ${target} → ${cwd}` }),
  ]);
  const continuations = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pi-agent-teleport-continuation");
  expect(continuations).toHaveLength(2);
  expect(continuations.every((entry) => entry.display === false)).toBe(true);
  expect(result.providerRequests).toHaveLength(3);
  expect(JSON.stringify(result.providerRequests[2]).match(/Continue the original task from the destination\./g)).toHaveLength(2);
  expect(entries.filter((entry) => entry.type === "message" && entry.message.role === "user")).toHaveLength(1);
});