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


