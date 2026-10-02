import { describe, expect, test, vi, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { assertHerdrContext, getHerdrContext, runHerdr } from "./herdr.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_TAB_ID: "w1:t1", HERDR_PANE_ID: "w1:p1", HERDR_SESSION: "test", HERDR_SOCKET_PATH: "/test.sock" };

describe("Herdr caller environment", () => {
  test("accepts the empty acknowledgement from pane run, but not an empty query", () => {
    const context = getHerdrContext(env)!;
    vi.mocked(execFileSync).mockReturnValue("");
    expect(runHerdr(context, ["pane", "run", "w2:p1", "printf ready"])).toEqual({ type: "ok" });
    expect(() => runHerdr(context, ["pane", "process-info", "--pane", "w2:p1"])).toThrow(/empty response/);
  });

  test("does not enable the CLI outside Herdr or with missing caller IDs", () => {
    expect(getHerdrContext({})).toBeUndefined();
    for (const key of ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"]) {
      expect(getHerdrContext({ ...env, [key]: "" })).toBeUndefined();
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test("pins CLI calls to the owning socket and checks the live caller", () => {
    const context = getHerdrContext(env)!;
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ result: { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } } }));
    assertHerdrContext(context);
    expect(execFileSync).toHaveBeenCalledWith("herdr", ["pane", "current", "--current"], expect.objectContaining({ env: expect.objectContaining(env) }));
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ result: { pane: { pane_id: "other", tab_id: "w1:t1", workspace_id: "w1" } } }));
    expect(() => assertHerdrContext(context)).toThrow(/no longer match/);
  });

  test("does not inherit another connection when using a named session", () => {
    const context = getHerdrContext({ ...env, HERDR_SOCKET_PATH: "" })!;
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ result: { type: "ok" } }));
    runHerdr(context, ["workspace", "list"]);
    const options = vi.mocked(execFileSync).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.HERDR_SOCKET_PATH).toBeUndefined();
    expect(options.env.HERDR_SESSION).toBe("test");
  });
});
