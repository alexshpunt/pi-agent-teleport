import { describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { confirmArrival, hasSessionProcess, parseTarget, qualifyLocation, relocateSession, requestController, UnknownRemoteOutcome, validateReady, waitForReceipt } from "./remote.ts";

async function withSocket(handler: (socket: Socket) => void, run: (socket: string) => Promise<void>) {
  mkdirSync(resolve(".tmp"), { recursive: true });
  const dir = mkdtempSync(resolve(".tmp/callback-"));
  const path = join(dir, "controller.sock");
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try { await run(path); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
}

test("a callback preserves structured success and carries its route token", async () => {
  await withSocket((socket) => socket.once("data", (data) => {
    expect(JSON.parse(data.toString())).toMatchObject({ action: "return", token: "private-route" });
    socket.end(`${JSON.stringify({ ok: true, destination: "/source" })}\n`);
  }), async (socket) => {
    expect(await requestController({ socket, token: "private-route" }, { action: "return" })).toEqual({ ok: true, destination: "/source" });
  });
});

test("a known callback refusal differs from an unknown disconnected outcome", async () => {
  await withSocket((socket) => socket.once("data", () => socket.end(`${JSON.stringify({ ok: false, error: "Destination refused" })}\n`)), async (socket) => {
    const error = await requestController({ socket, token: "route" }, { action: "return" }).catch((error) => error);
    expect(error.message).toBe("Destination refused");
    expect(error).not.toBeInstanceOf(UnknownRemoteOutcome);
  });
  await withSocket((socket) => socket.once("data", () => socket.end()), async (socket) => {
    await expect(requestController({ socket, token: "route" }, { action: "return" })).rejects.toBeInstanceOf(UnknownRemoteOutcome);
  });
});

test("a controller connection has no startup deadline", async () => {
  const deadline = vi.spyOn(Socket.prototype, "setTimeout");
  try {
    await withSocket((socket) => socket.once("data", () => {
      socket.end(`${JSON.stringify({ ok: true, destination: "/delayed-destination" })}\n`);
    }), async (socket) => {
      expect(await requestController({ socket, token: "route" }, { action: "return" }))
        .toEqual({ ok: true, destination: "/delayed-destination" });
    });
    expect(deadline).not.toHaveBeenCalled();
  } finally { deadline.mockRestore(); }
});

test("a lost readiness response cannot shut down an already committed arrival", async () => {
  let commitFile = "";
  await withSocket((socket) => socket.once("data", () => {
    writeFileSync(commitFile, JSON.stringify({ ok: true }));
    socket.end();
  }), async (socket) => {
    commitFile = join(dirname(socket), "committed.json");
    await expect(confirmArrival({ socket, token: "route", commitFile }, { sessionId: "session" })).resolves.toBeUndefined();
  });
});

test("a late readiness refusal cannot undo a durable commit", async () => {
  let requests = 0;
  await withSocket((socket) => socket.once("data", () => {
    requests++;
    socket.end(`${JSON.stringify({ ok: false, error: "Arrival already acknowledged" })}\n`);
  }), async (socket) => {
    const commitFile = join(dirname(socket), "committed.json");
    writeFileSync(commitFile, JSON.stringify({ ok: true }));
    await expect(confirmArrival({ socket, token: "route", commitFile }, { sessionId: "session" })).resolves.toBeUndefined();
    expect(requests).toBe(0);
  });
});
test("an uncommitted destination still rejects an explicit controller refusal", async () => {
  await withSocket((socket) => socket.once("data", () => socket.end(`${JSON.stringify({ ok: false, error: "Wrong session" })}\n`)), async (socket) => {
    await expect(confirmArrival({ socket, token: "route", commitFile: join(dirname(socket), "committed.json") }, { sessionId: "session" })).rejects.toBeInstanceOf(Error);
  });
});

test("a commit published during a late callback remains authoritative", async () => {
  let commitFile = "";
  await withSocket((socket) => socket.once("data", () => {
    writeFileSync(commitFile, JSON.stringify({ ok: true }));
    socket.end(`${JSON.stringify({ ok: false, error: "Arrival already acknowledged" })}\n`);
  }), async (socket) => {
    commitFile = join(dirname(socket), "committed.json");
    await expect(confirmArrival({ socket, token: "route", commitFile }, { sessionId: "session" })).resolves.toBeUndefined();
  });
});
test("a slow durable commit does not shut down an acknowledged destination", async () => {
  let received!: () => void;
  const request = new Promise<void>((resolve) => { received = resolve; });
  await withSocket((socket) => socket.once("data", () => {
    socket.end(`${JSON.stringify({ ok: true })}\n`);
    received();
  }), async (socket) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const commitFile = join(dirname(socket), "committed.json");
      let completed = false;
      const arrival = confirmArrival({ socket, token: "route", commitFile }, { sessionId: "session" }).then(() => { completed = true; });
      await request;
      // Let the real socket deliver its acknowledgement before advancing the startup clock.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(180_000);
      expect(completed).toBe(false);
      writeFileSync(commitFile, JSON.stringify({ ok: true }));
      await vi.advanceTimersByTimeAsync(100);
      await arrival;
      expect(completed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

test("a temporarily missing callback socket cannot kill a destination committed by process evidence", async () => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  const dir = mkdtempSync(resolve(".tmp/late-controller-"));
  try {
    const commitFile = join(dir, "committed.json");
    const arrival = confirmArrival({ socket: join(dir, "missing.sock"), token: "route", commitFile }, { sessionId: "session" });
    const result = arrival.then(() => true, () => false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(commitFile, JSON.stringify({ ok: true }));
    expect(await result).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed callback receipt cannot authorize a competing source continuation", async () => {
  await withSocket((socket) => socket.once("data", () => socket.end("invalid JSON\n")), async (socket) => {
    await expect(requestController({ socket, token: "route" }, { action: "return" })).rejects.toBeInstanceOf(UnknownRemoteOutcome);
  });
});
test("an unconfirmed durable receipt is never treated as a failed move safe to replay", async () => {
  mkdirSync(resolve(".tmp"), { recursive: true });
  const dir = mkdtempSync(resolve(".tmp/receipt-"));
  try {
    const path = join(dir, "result.json");
    vi.useFakeTimers();
    try {
      let settled = false;
      const receipt = waitForReceipt(path);
      const result = receipt.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(240_000);
      expect(settled).toBe(false);
      writeFileSync(path, JSON.stringify({ ok: true, destination: "/fixture-destination" }));
      await vi.advanceTimersByTimeAsync(100);
      await result;
      expect(await receipt).toEqual({ ok: true, destination: "/fixture-destination" });
    } finally { vi.useRealTimers(); }
    writeFileSync(path, JSON.stringify({ ok: false, uncertain: true, error: "Commit unconfirmed" }));
    await expect(waitForReceipt(path)).rejects.toBeInstanceOf(UnknownRemoteOutcome);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe("machine-qualified destinations", () => {
  test("keeps remote paths off the local filesystem", () => {
    expect(parseTarget("ssh://vps/root/project with spaces", "/local")).toEqual({ host: "vps", path: "/root/project with spaces" });
    expect(parseTarget("../other", "/local/project")).toEqual({ path: "/local/other" });
    expect(qualifyLocation("/root/project", "vps")).toBe("ssh://vps/root/project");
    expect(qualifyLocation("/root/project")).toBe("/root/project");
  });

  test.each(["ssh://-oProxyCommand=bad/root", "ssh://vps:22/root", "ssh://vps", "ssh://vps/", "ssh://vps/root\ncommand", "https://vps/root"])("rejects ambiguous or unsafe target %s", (target) => {
    expect(() => parseTarget(target, "/local")).toThrow();
  });

  test("treats a URL for the current machine as a local directory", () => {
    expect(parseTarget("ssh://vps/root/project", "/local", "vps")).toEqual({ path: "/root/project" });
  });
});

describe("session transfer", () => {
  const header = { type: "session", version: 3, id: "same-session", cwd: "/source", timestamp: "2026-10-18T00:00:00Z" };
  const entry = { type: "message", id: "entry", parentId: null, message: { role: "user", content: "conversation marker" } };
  const source = `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`;

  test("preserves identity and conversation while changing only the session cwd", () => {
    const lines = relocateSession(source, "same-session", "/destination").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ ...header, cwd: "/destination" }, entry]);
    expect(source).toContain('"cwd":"/source"');
  });

  test("refuses a different or malformed session before creating a destination", () => {
    expect(() => relocateSession(source, "other-session", "/destination")).toThrow("identity");
    expect(() => relocateSession("{}\n", "same-session", "/destination")).toThrow();
  });
});

test("native readiness still checks the exact PID and cwd when Pi replaces its argv", () => {
  const processes = [{ pid: 42, cwd: "/destination" }];
  expect(hasSessionProcess(processes, 42, "/destination", "/session.jsonl")).toBe(true);
  expect(hasSessionProcess(processes, 43, "/destination", "/session.jsonl")).toBe(false);
  expect(hasSessionProcess(processes, 42, "/other", "/session.jsonl")).toBe(false);
  expect(hasSessionProcess([{ ...processes[0], argv: ["pi", "--session", "/wrong.jsonl"] }], 42, "/destination", "/session.jsonl")).toBe(false);
});
describe("destination readiness", () => {
  const expected = { operationId: "operation", fingerprint: "current-code", sessionId: "session", cwd: "/destination", sessionFile: "/sessions/destination.jsonl", paneId: "w1:p1", agentDir: "/agent" };
  const ready = { ...expected, pid: 42 };

  test("requires the current Teleport, exact session, cwd, file and owned pane", () => {
    expect(() => validateReady(expected, ready)).not.toThrow();
    for (const field of ["operationId", "fingerprint", "sessionId", "cwd", "sessionFile", "paneId", "agentDir"] as const) {
      expect(() => validateReady(expected, { ...ready, [field]: "wrong" })).toThrow();
    }
    expect(() => validateReady(expected, { ...ready, pid: 0 })).toThrow();
  });
});
