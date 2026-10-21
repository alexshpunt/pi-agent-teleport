import { expect, test } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OUTCOME_TYPE, ownsExecution, registerTeleportOutput, type TeleportOutcome } from "./output.ts";

function fixture() {
  const entries: any[] = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "root" }] } }];
  let sessionId = "session";
  let onMessage: (event: any, ctx: ExtensionContext) => void = () => {};
  const ctx = { sessionManager: { getSessionId: () => sessionId, getBranch: () => entries } } as unknown as ExtensionContext;
  const publish = registerTeleportOutput({
    registerEntryRenderer: () => {},
    appendEntry: (customType: string, data: TeleportOutcome) => entries.push({ type: "custom", customType, data }),
    on: (_event: string, handler: typeof onMessage) => { onMessage = handler; },
  } as unknown as ExtensionAPI);
  return { ctx, entries, publish, onMessage, switchSession: (id: string) => { sessionId = id; } };
}
const outcome: TeleportOutcome = { sessionId: "session", toolCallId: "leaf", parentToolCallId: "root", status: "completed", text: "Agent teleported: source → destination" };

test("a hidden continuation publishes one display-only entry, even if its notification repeats", () => {
  const f = fixture();
  const event = { message: { role: "custom", customType: "pi-agent-teleport-continuation", display: false, content: "Full model continuation", details: { outcome } } };
  f.onMessage(event, f.ctx);
  f.onMessage(event, f.ctx);
  expect(f.entries.filter((entry) => entry.customType === OUTCOME_TYPE)).toEqual([{ type: "custom", customType: OUTCOME_TYPE, data: outcome }]);
});

test("an uncertain outcome can be displayed without creating a model continuation", () => {
  const f = fixture();
  f.publish(f.ctx, { ...outcome, status: "uncertain", text: "Inspect the handoff receipt before retrying." });
  expect(f.entries.at(-1).data.status).toBe("uncertain");
  expect(f.entries.filter((entry) => entry.type === "message")).toHaveLength(1);
});

test("a different session or abandoned branch never acquires a late result", () => {
  const f = fixture();
  f.switchSession("other-session");
  expect(ownsExecution(f.ctx, outcome)).toBe(false);
  f.publish(f.ctx, outcome);
  f.switchSession("session");
  f.entries.splice(0);
  expect(ownsExecution(f.ctx, outcome)).toBe(false);
  f.publish(f.ctx, outcome);
  expect(f.entries).toEqual([]);
});

test("a missing visible root is not guessed from the leaf execution ID", () => {
  const f = fixture();
  const unlinked = { ...outcome, parentToolCallId: undefined };
  expect(ownsExecution(f.ctx, unlinked)).toBe(false);
  f.publish(f.ctx, unlinked);
  expect(f.entries).toHaveLength(1);
});
