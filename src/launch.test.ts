import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { guardedLaunch } from "./herdr.ts";
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

test.skipIf(!available)("Windows source cleanup closes the source pane before removing its literal session file", () => {
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
  expect(existsSync(session)).toBe(false);
});

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
