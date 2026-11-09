import { expect, test } from "vitest";
import { getHerdrContext, runCore } from "../src/herdr.ts";
import { startCoreWorker } from "../src/remote.ts";

test.runIf(process.env.HC_TERMINAL_ID)("a background worker is owned by core rather than its calling terminal", () => {
  const context = getHerdrContext();
  expect(context).toBeDefined();
  const worker = startCoreWorker(context!, process.cwd(), [process.execPath, "test/fixtures/core-worker.mjs"]);
  try {
    const terminal = runCore(context!, ["get", worker.address]);
    expect(terminal.state).toBe("live");
    expect(terminal.parent).toBeNull();
  } finally {
    try { runCore(context!, ["kill", worker.address]); }
    catch (error) {
      const list = runCore(context!, ["ls", "--all", "--json"]);
      if (list.terminals.some((terminal: { address: string }) => terminal.address === worker.address)) throw error;
    }
  }
});
