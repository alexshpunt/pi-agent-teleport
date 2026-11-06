import { beforeEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { getHerdrContext, sameHerdrConnection, assertHerdrContext, runHerdr, readHerdrPane } from "./herdr.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const app = { backend: "app" as const, paneId: "t7", workspaceId: "sp3", tabId: "tb4", session: "owned", stateHome: "/owned/state" };

test("a saved terminal socket pins core routing and is not a process lifetime scope", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ address: "t7", labels: { "herdr.space": "sp3", "herdr.tab": "tb4" }, state: "live" }));
  vi.stubEnv("HC_SOCKET", "/foreign/core.sock");
  vi.stubEnv("HC_SCOPE", "source-lifetime");
  try {
    const first = getHerdrContext({ HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/owned/core.sock", HC_SCOPE: "source-lifetime" })!;
    const second = getHerdrContext({ HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/owned/core.sock", HC_SCOPE: "other-lifetime" })!;
    const options = vi.mocked(execFileSync).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    // Do not dump the inherited environment when an assertion fails.
    expect(options.env.HC_SOCKET === "/owned/core.sock").toBe(true);
    expect(options.env.HC_SCOPE === undefined).toBe(true);
    expect(sameHerdrConnection(first, second)).toBe(true);
  } finally { vi.unstubAllEnvs(); }
});

test("a terminal cannot identify a caller after an explicit switch to another core", () => {
  expect(() => getHerdrContext({ HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: "/owned/core.sock", HC_SOCKET: "/foreign/core.sock" })).toThrow();
  expect(vi.mocked(execFileSync).mock.calls.length).toBe(0);
});

test("core commands never fall through to the legacy server", () => {
  expect(() => runHerdr(app, ["unsupported"])).toThrow();
  expect(execFileSync).not.toHaveBeenCalledWith("herdr", expect.anything(), expect.anything());
});

test("sending a launch command uses core input without forcing a blocked terminal", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ terminal: "t8", sent: true }));
  expect(runHerdr(app, ["pane", "run", "t8", "echo 'hello'"])).toEqual({ type: "ok" });
  expect(execFileSync).toHaveBeenCalledWith("hc", ["send", "t8", "echo 'hello'"], expect.objectContaining({ env: expect.objectContaining({ HC_SESSION: "owned" }) }));
});

test("closing an App terminal removes only its pane before killing and removing the core record", () => {
  vi.mocked(execFileSync).mockReturnValueOnce(JSON.stringify({ pending: true, terminal: "t8" })).mockReturnValueOnce(JSON.stringify({ spaces: [] })).mockReturnValue("{}");
  runHerdr(app, ["pane", "close", "t8"]);
  expect(vi.mocked(execFileSync).mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["herdr-app", ["do", "terminal.park", JSON.stringify({ terminal: "t8" })]], ["herdr-app", ["ls"]], ["hc", ["kill", "t8"]], ["hc", ["rm", "t8"]],
  ]);
});

test("core output reads the target terminal instead of a legacy pane", () => {
  vi.mocked(execFileSync).mockReturnValue("first\nlast\n");
  expect(readHerdrPane(app, "t8")).toBe("first\nlast");
  expect(execFileSync).toHaveBeenCalledWith("hc", ["read", "t8", "--lines", "80"], expect.objectContaining({ env: expect.objectContaining({ HC_SESSION: "owned" }) }));
});

test("core handles cannot inherit another session's XDG roots", () => {
  vi.mocked(execFileSync).mockReturnValue("{}");
  vi.stubEnv("XDG_RUNTIME_DIR", "/foreign/runtime");
  try {
    runHerdr(app, ["pane", "run", "t8", "true"]);
    const options = vi.mocked(execFileSync).mock.calls[0][2] as { env: NodeJS.ProcessEnv };
    expect(options.env.XDG_RUNTIME_DIR).toBeUndefined();
    expect(options.env.XDG_STATE_HOME).toBe("/owned/state");
  } finally { vi.unstubAllEnvs(); }
});

test("a core terminal resolves its own space and tab without using the focused pane", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ address: "t7", labels: { "herdr.space": "sp3", "herdr.tab": "tb4" }, state: "live" }));
  const context = getHerdrContext({ HC_TERMINAL_ID: "t7", HC_SESSION: "test-app", XDG_STATE_HOME: "/owned/state" });
  expect(context).toMatchObject({ backend: "app", paneId: "t7", workspaceId: "sp3", tabId: "tb4", session: "test-app" });
  assertHerdrContext(context!);
  expect(execFileSync).toHaveBeenCalledWith("hc", ["get", "t7"], expect.objectContaining({ env: expect.objectContaining({ HC_SESSION: "test-app", XDG_STATE_HOME: "/owned/state" }) }));
});

test("a hidden core worker cannot claim the app's focused workspace", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ address: "t7", labels: {}, state: "live" }));
  expect(() => getHerdrContext({ HC_TERMINAL_ID: "t7" })).toThrow();
});

test("persisted handles cannot cross core and legacy connections", () => {
  const legacy = { paneId: "t7", workspaceId: "sp3", tabId: "tb4", session: "default" };
  expect(sameHerdrConnection(legacy, { ...legacy, backend: "app" } as typeof legacy)).toBe(false);
});
