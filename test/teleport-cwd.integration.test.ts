import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage, getToolExecution, getToolResultText, PiIntegrationTest,
  testArtifactsDir, text, toolCall,
} from "pi-coding-agent-test";

const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

// Mutations in one Codemode invocation form a batch: use independent files.
const exerciseFiles = `
text(await tools.search({path: "shared.txt", query: '"target changed"'}));
text(await tools.diff({before: "shared.txt", after: "ops.txt"}));
text(await tools.replace({path: "ops.txt", start: "target ops", text: "edited ops"}));
text(await tools.insert({path: "insert.txt", anchor: "target insert", text: "inserted\\n"}));
text(await tools.undo({file: "undo.txt", change: "last"}));
text(await tools.copy({path: "copy-src.txt", target: "copied.txt"}));
text(await tools.move({path: "move-src.txt", target: "moved.txt"}));
text(await tools.write({path: "created.txt", content: "created marker"}));
text(await tools.delete({path: "remove.txt"}));
text(await tools.read({path: "target-only.txt"}));
`;
const initialFiles = (label: string) => ({
  "shared.txt": `${label} original\n`, "ops.txt": `${label} ops\n`,
  "insert.txt": `${label} insert\n`, "undo.txt": `${label} undo\n`,
  "copy-src.txt": `${label} copy\n`, "move-src.txt": `${label} move\n`,
  "remove.txt": `${label} remove\n`,
});
async function files(dir: string) {
  return Object.fromEntries(await Promise.all((await readdir(dir)).map(async (name) =>
    [name, await readFile(path.join(dir, name), "utf8")])));
}

test("batched jump and back move relative IDE file operations before the next response", async () => {
  await mkdir(path.resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/teleport-cwd-"));
  const source = path.join(root, "source"), target = path.join(root, "target"), agent = path.join(root, "agent");
  // Moving and returning must use this process's initial session directory.
  const sharedRunner = process.env.PI_INTEGRATION_TEST_RUNNER;
  delete process.env.PI_INTEGRATION_TEST_RUNNER;
  try {
    await Promise.all([source, target, agent].map((dir) => mkdir(dir)));
    for (const [dir, label] of [[source, "source"], [target, "target"]])
      for (const [name, content] of Object.entries(initialFiles(label)))
        await writeFile(path.join(dir, name), content);
    await writeFile(path.join(target, "target-only.txt"), "target-only-marker\n");
    const result = await new PiIntegrationTest({
      testName: "teleport-relative-cwd", artifactsDir: testArtifactsDir(import.meta.filename), cwd: source,
      extensions: [
        path.resolve("node_modules/pi-agent-ide/src/pi-agent-ide.ts"), path.resolve("src/index.ts"),
        "builtin:codemode",
      ],
      rawMode: false,
      tools: ["teleport", "bash", "read", "search", "replace", "insert", "write", "delete", "copy", "move", "diff", "undo", "codemode"],
      environment: {
        PI_CODING_AGENT_DIR: agent, PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1",
        HERDR_ENV: "", HERDR_WORKSPACE_ID: "", HERDR_TAB_ID: "", HERDR_PANE_ID: "",
      },
      conversation: [
        call("source-read", "read", { path: "shared.txt" }),
        assistantMessage([
          toolCall({ id: "jump", name: "teleport", arguments: { action: "jump", target } }),
          toolCall({ id: "companion", name: "codemode", arguments: {
            code: 'text(await tools.bash({command: "sleep 0.1; printf complete > companion.txt; pwd"}));',
          } }),
        ], { stopReason: "toolUse" }),
        call("target-pwd", "bash", { command: "pwd" }),
        call("target-read", "read", { path: "shared.txt" }),
        call("target-replace", "replace", { path: "shared.txt", start: "target original", text: "target changed" }),
        call("undo-prep", "replace", { path: "undo.txt", start: "target undo", text: "temporary edit" }),
        call("target-files", "codemode", { code: exerciseFiles }),
        assistantMessage([
          toolCall({ id: "back-companion", name: "bash", arguments: { command: "printf complete > back-companion.txt; pwd" } }),
          toolCall({ id: "back", name: "teleport", arguments: { action: "back" } }),
        ], { stopReason: "toolUse" }),
        call("source-pwd", "bash", { command: "pwd" }),
        call("returned-read", "read", { path: "shared.txt" }),
        call("source-replace", "replace", { path: "shared.txt", start: "source original", text: "source changed" }),
        assistantMessage([text("Done")]),
      ],
      timeoutMs: 90_000,
    }).run("Move to the target, change its files, then return and change the source file.");
    for (const id of ["source-read", "jump", "companion", "target-pwd", "target-read", "target-replace", "undo-prep", "target-files", "back", "back-companion", "source-pwd", "returned-read", "source-replace"])
      expect(getToolExecution(result, id).isError, id).toBe(false);
    for (const stopReason of ["error", "aborted"])
      expect(result.messages).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", stopReason }),
      ]));
    expect(getToolResultText(result, "target-pwd")).toContain(target);
    expect(getToolResultText(result, "target-read")).toContain("target original");
    expect(getToolResultText(result, "target-files")).toContain("target-only-marker");
    expect(getToolResultText(result, "target-files")).toContain("target changed");
    expect(getToolResultText(result, "source-pwd")).toContain(source);
    expect(getToolResultText(result, "returned-read")).toContain("source original");
    expect(await files(source)).toEqual({ ...initialFiles("source"), "shared.txt": "source changed\n", "companion.txt": "complete" });
    expect(await files(target)).toEqual({
      "shared.txt": "target changed\n", "ops.txt": "edited ops\n", "insert.txt": "target insert\ninserted\n",
      "undo.txt": "target undo\n", "copy-src.txt": "target copy\n", "copied.txt": "target copy\n",
      "moved.txt": "target move\n", "created.txt": "created marker", "target-only.txt": "target-only-marker\n",
      "back-companion.txt": "complete",
    });
  } finally {
    if (sharedRunner !== undefined) process.env.PI_INTEGRATION_TEST_RUNNER = sharedRunner;
    await rm(root, { recursive: true, force: true });
  }
}, 110_000);
