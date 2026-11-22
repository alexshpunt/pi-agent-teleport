import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { destinationAlive } from "./bridge.ts";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: vi.fn() }));
const location = { backend: "app" as const, workspaceId: "sp1", tabId: "tb1", paneId: "t131", session: "default" };
const gone = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
beforeEach(() => { vi.resetAllMocks(); vi.spyOn(process, "kill").mockReturnValue(true); });
afterEach(() => vi.restoreAllMocks());

test("a destination is alive while its Pi runs in its live terminal", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ address: "t131", state: "live" }));
  expect(destinationAlive(location, 4242)).toBe(true);
  expect(vi.mocked(execFileSync).mock.calls[0]?.slice(0, 2)).toEqual(["hc", ["get", "t131"]]);
});

test("a destination ends when its Pi exits, even if a login shell keeps the terminal", () => {
  vi.mocked(process.kill).mockImplementation(gone);
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ address: "t131", state: "live" }));
  expect(destinationAlive(location, 4242)).toBe(false);
});

test("a destination ends when its core reports the terminal finished or removed", () => {
  vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify({ address: "t131", state: "finished" }));
  expect(destinationAlive(location, 4242)).toBe(false);
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("Command failed: hc get t131"), { status: 3, stderr: 'error: no terminal "t131"\nhint: see `hc ls --all`\n' }); });
  expect(destinationAlive(location, 4242)).toBe(false);
});

test("an unobservable destination is not reported as ended", () => {
  vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error("Command failed: hc get t131"), { status: 1, stderr: "error: core is not running\n" }); });
  expect(() => destinationAlive(location, 4242)).toThrow();
});
