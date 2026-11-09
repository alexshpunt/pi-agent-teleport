import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startSessionCleanup } from "./remote.ts";

test("detached session cleanup survives the source and needs no Herdr connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "teleport-session-cleanup-"));
  const sessionFile = join(directory, "source.jsonl");
  writeFileSync(sessionFile, "source");
  const source = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "ignore" });
  try {
    await startSessionCleanup(sessionFile, source.pid!, directory, directory);
    const [id] = readdirSync(join(directory, "cleanup"));
    const result = join(directory, "cleanup", id, "result.json");
    const deadline = Date.now() + 10_000;
    while (!existsSync(result) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(result)).toBe(true);
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ ok: true });
    expect(existsSync(sessionFile)).toBe(false);
  } finally {
    if (source.exitCode === null) source.kill();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
