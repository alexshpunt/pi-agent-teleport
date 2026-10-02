import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { assistantMessage, getToolExecution, getToolExecutionDetails, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";

test("a real Pi process uses ordinary Git when Herdr caller IDs are incomplete", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const fixture = await mkdtemp(resolve(".tmp/native-create-"));
  workspaces.push(fixture);
  const cwd = join(fixture, "repo");
  await mkdir(cwd);
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await writeFile(join(cwd, "README"), "fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  const path = join(fixture, "owned");
  const result = await new PiIntegrationTest({
    testName: "teleport-native-create",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    environment: { ...process.env, HERDR_ENV: "1", HERDR_WORKSPACE_ID: "invalid", HERDR_TAB_ID: "invalid", HERDR_PANE_ID: "" },
    extensions: [join(dirname(import.meta.filename), "..", "src", "index.ts")],
    tools: ["teleport"],
    rawMode: false,
    conversation: [
      assistantMessage([toolCall({ id: "create", name: "teleport", arguments: { action: "create", branch: "owned", path } })], { stopReason: "toolUse" }),
      assistantMessage([text("Worktree created.")]),
    ],
  }).run("Create an isolated worktree");
  expect(getToolExecution(result, "create").isError).toBe(false);
  const details = getToolExecutionDetails(getToolExecution(result, "create")) as { resource: { path: string; herdr?: unknown } };
  expect(details.resource.path).toBe(path);
  expect(details.resource.herdr).toBeUndefined();
  expect(getToolResultText(result, "create")).toContain(`Created worktree ${path}`);
  expect(execFileSync("git", ["branch", "--show-current"], { cwd: path, encoding: "utf8" }).trim()).toBe("owned");
});

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
  expect(getToolResultText(result, "history")).toBe("Teleport history is empty.\nManaged worktrees:\nnone");
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


