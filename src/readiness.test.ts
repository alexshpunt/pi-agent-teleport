import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { guardedLaunch, readHerdrPane, runHerdr, type HerdrContext } from "./herdr.ts";
import { awaitHerdrArrival, preflightArguments, preflightSession, writeReadiness } from "./readiness.ts";

vi.mock("./herdr.ts", async (original) => ({ ...await original<typeof import("./herdr.ts")>(), runHerdr: vi.fn(), readHerdrPane: vi.fn() }));

describe("preflight arguments", () => {
  test("keep runtime flags and drop session selection, mode and prompts", () => {
    expect(preflightArguments([
      "--approve", "--extension", "./ext.ts", "--model", "fake/model", "--session", "/s.jsonl", "--mode", "json",
      "-c", "--name", "Fix login", "--thinking", "high", "--custom-flag", "value", "Do the task", "@notes.md",
    ])).toEqual(["--approve", "--extension", "./ext.ts", "--model", "fake/model", "--thinking", "high", "--custom-flag", "value"]);
  });

  test("drop a print prompt and everything after --", () => {
    expect(preflightArguments(["--no-extensions", "-e", "a.ts", "-p", "hello", "--", "--model", "x"])).toEqual(["--no-extensions", "-e", "a.ts"]);
  });
});

describe("Herdr arrival readiness", () => {
  const context: HerdrContext = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", session: "test" };
  let dir: string;
  let receipt: string;
  beforeEach(() => {
    vi.resetAllMocks();
    mkdirSync(resolve(".tmp"), { recursive: true });
    dir = mkdtempSync(resolve(".tmp/readiness-"));
    receipt = join(dir, "ready.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const shell = { process_info: { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [] } };
  const pi = { process_info: { shell_pid: 10, foreground_process_group_id: 20, foreground_processes: [{ pid: 20, cwd: "/target" }] } };

  test("keeps waiting for a live destination without an elapsed-time limit", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runHerdr).mockReturnValue(pi);
      let settled = false;
      const outcome = awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt).then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      writeReadiness(receipt, { ok: true, pid: 20, cwd: "/target", sessionFile: "/s.jsonl" });
      await vi.advanceTimersByTimeAsync(100);
      await outcome;
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  test("a shell awaiting launch does not become a failure after a grace period", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runHerdr).mockReturnValue(shell);
      let settled = false;
      const outcome = awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt).then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false);
      vi.mocked(runHerdr).mockReturnValue(pi);
      writeReadiness(receipt, { ok: true, pid: 20, cwd: "/target", sessionFile: "/s.jsonl" });
      await vi.advanceTimersByTimeAsync(100);
      await outcome;
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  test.each([true, false])("a launched process waits for startup even with an operation marker (%s)", async (matching) => {
    const marker = Buffer.from(JSON.stringify({ receipt: matching ? receipt : `${receipt}.other` })).toString("base64url");
    const child = spawn(process.execPath, ["-e", "process.title = 'pi'; console.log('started'); setInterval(() => {}, 1000)"], {
      cwd: dir, env: { ...process.env, PI_TELEPORT_CONTINUATION: marker }, stdio: ["ignore", "pipe", "ignore"],
    });
    await once(child.stdout!, "data");
    vi.useFakeTimers();
    try {
      vi.mocked(runHerdr).mockReturnValue({ process_info: { shell_pid: 10, foreground_process_group_id: child.pid, foreground_processes: [{ pid: child.pid, cwd: dir }] } });
      let completed = false;
      const arrival = awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt).then(() => { completed = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(false);
      writeReadiness(receipt, { ok: true, pid: child.pid!, cwd: dir, sessionFile: "/s.jsonl" });
      await vi.advanceTimersByTimeAsync(100);
      await arrival;
    } finally {
      vi.useRealTimers();
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  });
  test("preflight waits for its startup response without a deadline", async () => {
    const started = join(dir, "probe-started");
    const release = join(dir, "release-probe");
    const script = join(dir, "probe.cjs");
    writeFileSync(script, `
      const { existsSync, writeFileSync } = require("node:fs");
      process.stdin.once("data", () => {
        writeFileSync(process.env.PI_TELEPORT_PREFLIGHT, JSON.stringify({ ok: true, pid: process.pid, cwd: process.cwd(), sessionFile: "fixture-session" }));
        writeFileSync(${JSON.stringify(started)}, "");
        const timer = setInterval(() => {
          if (!existsSync(${JSON.stringify(release)})) return;
          clearInterval(timer);
          process.stdout.write(JSON.stringify({ type: "response", id: "teleport-preflight" }) + "\\n");
        }, 10);
      });
      process.stdin.on("end", () => process.exit(0));
    `);
    const argv = process.argv;
    let outcome: Promise<void> | undefined;
    let settled = false;
    vi.useFakeTimers();
    try {
      process.argv = [process.execPath, script];
      outcome = preflightSession({ target: dir, sessionText: JSON.stringify({ type: "session", version: 3, id: "fixture-session", cwd: dir }) + "\n" });
      process.argv = argv;
      outcome.then(() => { settled = true; }, () => { settled = true; });
      for (let attempt = 0; !existsSync(started) && attempt < 100; attempt++) await delay(10);
      expect(existsSync(started)).toBe(true);
      await vi.advanceTimersByTimeAsync(120_000);
      await delay(50);
      expect(settled).toBe(false);
      writeFileSync(release, "");
      await expect(outcome).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      process.argv = argv;
      writeFileSync(release, "");
      if (outcome) await outcome.catch(() => {});
      vi.useRealTimers();
    }
  });
  test("a transient Herdr observation error does not roll back a live destination", async () => {
    vi.mocked(runHerdr).mockImplementationOnce(() => { throw new Error("observation unavailable"); }).mockReturnValue(pi);
    writeReadiness(receipt, { ok: true, pid: 20, cwd: "/target", sessionFile: "/s.jsonl" });
    await expect(awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt)).resolves.toBeUndefined();
  });
  test("a command exiting before observation reports failure instead of waiting forever", async () => {
    vi.mocked(runHerdr).mockReturnValue(shell);
    vi.mocked(readHerdrPane).mockReturnValue("fixture-fast-exit");
    execFileSync("sh", ["-c", guardedLaunch(["sh", "-c", "exit 7"], receipt)]);
    expect(JSON.parse(readFileSync(receipt, "utf8")).ok).toBe(false);
    await expect(awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt)).rejects.toThrow("fixture-fast-exit");
  });

  test("reports the destination's own failure verbatim", async () => {
    vi.mocked(runHerdr).mockReturnValue(pi);
    writeReadiness(receipt, { ok: false, error: "fixture-destination-failure" });
    await expect(awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt)).rejects.toThrow("fixture-destination-failure");
  });

  test("reports terminal output when Pi exits before its verdict", async () => {
    vi.mocked(runHerdr).mockReturnValueOnce(pi).mockReturnValue(shell);
    vi.mocked(readHerdrPane).mockReturnValue("fixture-startup-error");
    await expect(awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt)).rejects.toThrow("fixture-startup-error");
    expect(readHerdrPane).toHaveBeenCalledWith(context, "w2:p1");
  });

  test("accepts only a ready verdict whose Pi runs in the pane", async () => {
    vi.mocked(runHerdr).mockReturnValue(pi);
    writeReadiness(receipt, { ok: true, pid: 20, cwd: "/target", sessionFile: "/s.jsonl" });
    await expect(awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt)).resolves.toBeUndefined();
    writeReadiness(receipt, { ok: true, pid: 99, cwd: "/target", sessionFile: "/s.jsonl" });
    await expect(awaitHerdrArrival(context, "w2:p1", "/s.jsonl", receipt)).rejects.toBeInstanceOf(Error);
  });
});
