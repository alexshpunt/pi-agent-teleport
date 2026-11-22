import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { guardedLaunch, launchProgram } from "./herdr.ts";
import { buildSourcePaneCleanup } from "./index.ts";

const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const available = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"], { timeout: 5_000 }).status === 0;

test.skipIf(!available)("PowerShell launches Pi with literal session paths and handoff environment, then publishes a readable exit", () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport launch ' & $ [] "));
  fixtures.push(directory);
  const fixture = join(directory, "pi fixture.mjs");
  const output = join(directory, "arguments.json");
  const receipt = join(directory, "ready.json");
  const session = String.raw`C:\Users\O'Brien $user\work & [draft]\Вход session.jsonl`;
  const continuation = JSON.stringify({ target: session, back: false });
  writeFileSync(fixture, `import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({argv:process.argv.slice(3),continuation:process.env.PI_TELEPORT_CONTINUATION,agentDir:process.env.PI_CODING_AGENT_DIR})); process.exit(7);`);
  writeFileSync(receipt, JSON.stringify({ ok: true, pid: 1 }));
  const command = guardedLaunch([process.execPath, fixture, output, "--session", session], receipt, {
    PI_TELEPORT_CONTINUATION: continuation, PI_CODING_AGENT_DIR: directory,
  }, "win32");
  // Herdr sends one command line into the existing shell, not an argv vector.
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", command.replace(/^powershell.exe /, `${powershell} `)], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(existsSync(output), result.stderr).toBe(true);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ argv: ["--session", session], continuation, agentDir: directory });
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ ok: false, error: expect.any(String) });
  expect(existsSync(`${receipt}.exit.tmp`)).toBe(false);
});

test.skipIf(!available)("PowerShell reports a missing executable instead of leaving the handoff pending", () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport-exit-"));
  fixtures.push(directory);
  const receipt = join(directory, "ready.json");
  const command = guardedLaunch([join(directory, "missing-pi")], receipt, {}, "win32");
  spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", command.replace(/^powershell.exe /, `${powershell} `)], { encoding: "utf8", timeout: 10_000 });
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ ok: false, error: expect.any(String) });
});

test.skipIf(!available)("Windows pane cleanup leaves transcript cleanup to the independent worker", () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport cleanup ' & [] "));
  fixtures.push(directory);
  const session = join(directory, "source.jsonl");
  const output = join(directory, "pane.json");
  writeFileSync(session, "{}");
  // This stand-in records exactly the CLI arguments. No user pane is closed.
  const script = `function herdr { $args | ConvertTo-Json -Compress | Set-Content -LiteralPath '${output.replaceAll("'", "''")}'; if (-not [IO.File]::Exists('${session.replaceAll("'", "''")}')) { throw 'Source session removed before pane close' } }\n` +
    buildSourcePaneCleanup("pane-123", 2_147_483_647, session, "win32");
  execFileSync(powershell, ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 10_000 });
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(["pane", "close", "pane-123"]);
  expect(existsSync(session)).toBe(true);
});

test.skipIf(process.platform === "win32")("source cleanup retains the transcript while its process is still alive", () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport-cleanup-live-"));
  fixtures.push(directory);
  const session = join(directory, "source.jsonl");
  writeFileSync(session, "session");
  execFileSync("sh", ["-c", buildSourcePaneCleanup("test-pane", process.pid, session, "linux")], { timeout: 10_000 });
  expect(existsSync(session)).toBe(true);
}, 12_000);
const fishAvailable = spawnSync("fish", ["--version"], { timeout: 5_000 }).status === 0;
test.skipIf(!fishAvailable)("launching through fish preserves nested quotes and shell metacharacters", () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport-fish-'"));
  fixtures.push(directory);
  const fixture = join(directory, "pi.mjs");
  const output = join(directory, "args.json");
  const receipt = join(directory, "ready.json");
  const argument = "a'b \"$c\" & [] `literal` Вход";
  writeFileSync(fixture, `import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({argv:process.argv.slice(3),value:process.env.LAUNCH_VALUE}));`);
  const result = spawnSync("fish", ["-c", guardedLaunch([process.execPath, fixture, output, argument], receipt, { LAUNCH_VALUE: argument }, "linux")], { encoding: "utf8" });
  expect(existsSync(output), result.stderr).toBe(true);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ argv: [argument], value: argument });
  expect(JSON.parse(readFileSync(receipt, "utf8")).ok).toBe(false);
});

test("the typed launch command stays short and carries no session data", () => {
  // Interactive shells echo typed input one character at a time; the script lives in a file.
  const directory = mkdtempSync(join(tmpdir(), "teleport-short-"));
  fixtures.push(directory);
  const receipt = join(directory, "exited.json");
  const argv = ["pi", "--session", join(directory, "x".repeat(400), "session.jsonl")];
  const env = { PI_TELEPORT_HANDOFF: "y".repeat(400) };
  const windows = guardedLaunch(argv, receipt, env, "win32");
  expect(windows).toBe(`powershell.exe -NoLogo -NoProfile -Command "& ([ScriptBlock]::Create([IO.File]::ReadAllText('${join(directory, "launch.ps1")}')))"`);
  expect(readFileSync(join(directory, "launch.ps1"), "utf8")).toContain("y".repeat(400));
  expect(guardedLaunch(argv, receipt, env, "linux")).toBe(`sh ${join(directory, "launch.sh")}`);
  expect(readFileSync(join(directory, "launch.sh"), "utf8")).toContain("y".repeat(400));
});

test.skipIf(!fishAvailable || process.platform === "win32")("fish runs the plain launcher command", () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport-fish-plain-"));
  fixtures.push(directory);
  const fixture = join(directory, "pi.mjs");
  const output = join(directory, "args.json");
  const receipt = join(directory, "ready.json");
  writeFileSync(fixture, `import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));`);
  const command = guardedLaunch([process.execPath, fixture, output, "a'b $c"], receipt, {}, "linux");
  expect(command).toMatch(/^sh \//);
  const result = spawnSync("fish", ["-c", command], { encoding: "utf8" });
  expect(JSON.parse(readFileSync(output, "utf8")), result.stderr).toEqual(["a'b $c"]);
  expect(JSON.parse(readFileSync(receipt, "utf8")).ok).toBe(false);
});

/** Run a terminal program the way Herdr App starts it: an argv vector, not a typed line. */
function runProgram(argv: string[], meanwhile?: () => void): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
    meanwhile?.();
  });
}

test.skipIf(process.platform === "win32")("a Unix terminal program waits for the handoff before it starts Pi", async () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport-program-"));
  fixtures.push(directory);
  const fixture = join(directory, "pi.mjs");
  const output = join(directory, "args.json");
  const receipt = join(directory, "exited.json");
  const gate = join(directory, "handoff.json");
  writeFileSync(fixture, `import {existsSync, writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({argv: process.argv.slice(3), gate: existsSync(${JSON.stringify(gate)}), handoff: process.env.PI_TELEPORT_HANDOFF}));`);
  const argv = launchProgram([process.execPath, fixture, output, "a'b $c"], receipt, { PI_TELEPORT_HANDOFF: gate }, gate, "linux");
  expect(argv).toEqual(["sh", join(directory, "launch.sh")]);
  const result = await runProgram(argv, () => setTimeout(() => writeFileSync(gate, "{}"), 500));
  expect(JSON.parse(readFileSync(output, "utf8")), result.stderr).toEqual({ argv: ["a'b $c"], gate: true, handoff: gate });
  expect(JSON.parse(readFileSync(receipt, "utf8")).ok).toBe(false);
});

test.skipIf(process.platform === "win32")("a Unix terminal program does not start Pi for a rolled-back arrival", async () => {
  const parent = mkdtempSync(join(tmpdir(), "teleport-rollback-"));
  fixtures.push(parent);
  const directory = join(parent, "arrival");
  mkdirSync(directory);
  const output = join(parent, "started");
  const argv = launchProgram(["touch", output], join(directory, "exited.json"), {}, join(directory, "handoff.json"), "linux");
  const result = await runProgram(argv, () => setTimeout(() => rmSync(directory, { recursive: true, force: true }), 300));
  expect(result.code).toBe(1);
  expect(existsSync(output)).toBe(false);
});

test.skipIf(!available)("a Windows terminal program runs Pi from the launch script once the handoff exists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport program ' & $ [] "));
  fixtures.push(directory);
  const fixture = join(directory, "pi fixture.mjs");
  const output = join(directory, "arguments.json");
  const receipt = join(directory, "exited.json");
  const gate = join(directory, "handoff.json");
  const session = String.raw`C:\Users\O'Brien $user\work & [draft]\Вход session.jsonl`;
  writeFileSync(fixture, `import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify({argv: process.argv.slice(3), handoff: process.env.PI_TELEPORT_HANDOFF}));`);
  const argv = launchProgram([process.execPath, fixture, output, "--session", session], receipt, { PI_TELEPORT_HANDOFF: gate }, gate, "win32");
  expect(argv.slice(0, 4)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand"]);
  // pwsh stands in for powershell.exe off Windows.
  const result = await runProgram([powershell, ...argv.slice(1)], () => setTimeout(() => writeFileSync(gate, "{}"), 500));
  expect(JSON.parse(readFileSync(output, "utf8")), result.stderr).toEqual({ argv: ["--session", session], handoff: gate });
  expect(JSON.parse(readFileSync(receipt, "utf8")).ok).toBe(false);
}, 60_000);

test.skipIf(process.platform === "win32")("the Unix launcher preserves argument boundaries and publishes its exit", () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport-unix-'"));
  fixtures.push(directory);
  const fixture = join(directory, "pi.mjs");
  const output = join(directory, "args.json");
  const receipt = join(directory, "ready.json");
  writeFileSync(fixture, `import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); process.exit(9);`);
  execFileSync("sh", ["-c", guardedLaunch([process.execPath, fixture, output, "a'b $c & []"], receipt, {}, "linux")]);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(["a'b $c & []"]);
  expect(JSON.parse(readFileSync(receipt, "utf8")).ok).toBe(false);
});
