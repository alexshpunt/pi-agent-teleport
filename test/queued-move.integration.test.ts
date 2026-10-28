import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";

test("a pending move lets Pi deliver the full user queue at the source", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/queued-move-"));
  const source = join(root, "source"), target = join(root, "target"), agent = join(root, "agent");
  try {
    await Promise.all([source, target, agent].map((dir) => mkdir(dir)));
    await writeFile(join(agent, "settings.json"), JSON.stringify({ followUpMode: "all" }));
    const result = await new PiIntegrationTest({
      testName: "queued-move", artifactsDir: testArtifactsDir(import.meta.filename), cwd: source,
      extensions: [resolve("src/index.ts"), resolve("test/fixtures/queued-instructions.ts")],
      tools: ["teleport", "bash"], rawMode: false,
      environment: { PI_CODING_AGENT_DIR: agent, HERDR_ENV: "", HERDR_PANE_ID: "", HERDR_TAB_ID: "", HERDR_WORKSPACE_ID: "" },
      conversation: [
        assistantMessage([
          toolCall({ id: "jump", name: "teleport", arguments: { action: "jump", target } }),
          toolCall({ id: "companion", name: "bash", arguments: { command: "printf companion" } }),
        ], { stopReason: "toolUse" }),
        assistantMessage([toolCall({ id: "source-pwd", name: "bash", arguments: { command: "pwd" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Source turn complete")]),
        assistantMessage([text("Queued instructions processed")]),
        assistantMessage([toolCall({ id: "target-pwd", name: "bash", arguments: { command: "pwd" } })], { stopReason: "toolUse" }),
        assistantMessage([text("Done")]),
      ],
      timeoutMs: 25_000,
    }).run("Move after the queued user instructions have been processed");
    expect(getToolExecution(result, "target-pwd").isError).toBe(false);
    expect(getToolResultText(result, "source-pwd")).toContain(source);
    expect(getToolResultText(result, "target-pwd")).toContain(target);
    const queued = JSON.stringify(result.providerRequests[3]?.messages);
    expect(queued).toContain("first-queued-instruction");
    expect(queued).toContain("second-queued-instruction");
    expect(result.state?.cwd).toBe(target);
  } finally { await rm(root, { recursive: true, force: true }); }
});
