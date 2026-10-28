import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Simulate user messages arriving while the move\'s sibling tool is running. */
export default function queuedInstructions(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", async (event) => {
    if (event.toolCallId !== "companion") return;
    pi.sendUserMessage("first-queued-instruction", { deliverAs: "followUp" });
    pi.sendUserMessage("second-queued-instruction", { deliverAs: "followUp" });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
}
