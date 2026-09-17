import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";

const workspaces: string[] = [];
afterEach(async () => Promise.all(workspaces.splice(0).map((p) => rm(p, { recursive: true, force: true }))));

test("a real Pi process exposes stable empty teleport history", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "teleport-integration-"));
  workspaces.push(cwd);
  const result = await new PiIntegrationTest({
    testName: "teleport-history",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [join(dirname(import.meta.filename), "..", "src", "index.ts")],
    tools: ["teleport"],
    rawMode: false,
    conversation: [
      assistantMessage([toolCall({ id: "history", name: "teleport", arguments: { action: "history" } })], { stopReason: "toolUse" }),
      assistantMessage([text("History checked.")]),
    ],
  }).run("Check teleport history");
  expect(getToolExecution(result, "history").isError).toBe(false);
  expect(getToolResultText(result, "history")).toBe("Teleport history is empty.");
});

test("a failed queued teleport starts a new agent turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "teleport-empty-history-"));
  workspaces.push(cwd);
  const result = await new PiIntegrationTest({
    testName: "teleport-empty-history-continues",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [join(dirname(import.meta.filename), "..", "src", "index.ts")],
    tools: ["teleport"],
    rawMode: false,
    conversation: [
      assistantMessage([toolCall({ id: "back", name: "teleport", arguments: { action: "back" } })], { stopReason: "toolUse" }),
      assistantMessage([text("I continued after the teleport failed.")]),
    ],
  }).run("Return to the previous location");

  expect(getToolExecution(result, "back").isError).toBe(false);
  expect(result.providerRequests).toHaveLength(2);
  expect(result.terminalOutput).toContain("Teleport history is empty.");
});

test("a missing teleport destination is returned to the agent without ending the turn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "teleport-missing-destination-"));
  workspaces.push(cwd);
  const missing = join(cwd, "does-not-exist");
  const result = await new PiIntegrationTest({
    testName: "teleport-missing-destination",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [join(dirname(import.meta.filename), "..", "src", "index.ts")],
    tools: ["teleport"],
    rawMode: false,
    conversation: [
      assistantMessage([toolCall({ id: "missing", name: "teleport", arguments: { action: "jump", target: missing } })], { stopReason: "toolUse" }),
      assistantMessage([text("I will find the correct directory and retry.")]),
    ],
  }).run("Teleport to the requested directory");

  expect(getToolExecution(result, "missing").isError).toBe(true);
  expect(getToolResultText(result, "missing")).toContain(`Directory does not exist: ${missing}`);
  expect(getToolResultText(result, "missing")).toContain("Find the correct directory and retry teleport.");
});


