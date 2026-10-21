import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Actual leaf execution and its visible root, captured from Pi execution events. */
export type TeleportExecution = { sessionId: string; toolCallId: string; parentToolCallId?: string };
/** Display data is separate from the full continuation delivered to the model. */
export type TeleportOutcome = TeleportExecution & { status: "completed" | "failed" | "uncertain"; text: string };
export const OUTCOME_TYPE = "pi-agent-teleport-outcome";

/** Never attach a late result to a different session or an abandoned branch. */
export function ownsExecution(ctx: ExtensionContext, execution: TeleportExecution): boolean {
  return execution.sessionId === ctx.sessionManager.getSessionId() && !!execution.parentToolCallId && ctx.sessionManager.getBranch().some((entry) =>
    entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "toolCall" && block.id === execution.parentToolCallId),
  );
}

/** Register durable linked presentation and return an idle-safe, display-only publisher. */
export function registerTeleportOutput(pi: ExtensionAPI): (ctx: ExtensionContext, outcome: TeleportOutcome) => void {
  const publish = (ctx: ExtensionContext, outcome: TeleportOutcome) => {
    if (!ownsExecution(ctx, outcome)) return;
    const exists = ctx.sessionManager.getBranch().some((entry) => {
      if (entry.type !== "custom" || entry.customType !== OUTCOME_TYPE) return false;
      const saved = entry.data as TeleportOutcome | undefined;
      return saved?.sessionId === outcome.sessionId && saved.toolCallId === outcome.toolCallId && saved.status === outcome.status;
    });
    if (!exists) pi.appendEntry(OUTCOME_TYPE, outcome);
  };
  pi.registerEntryRenderer<TeleportOutcome>(OUTCOME_TYPE, (entry, _options, theme) => {
    if (!entry.data) return;
    const { status, text } = entry.data;
    const color = status === "completed" ? "success" : status === "failed" ? "error" : "warning";
    return new Text(theme.fg(color, `${status === "completed" ? "✓" : status === "failed" ? "✗" : "?"} ${text}`), 0, 0);
  });
  // A replacement session has a new extension runtime. Observe its hidden
  // delivery there, rather than calling the retired source's captured pi API.
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "custom" || !["pi-agent-teleport-continuation", "pi-agent-teleport-failure"].includes(message.customType)) return;
    const outcome = (message.details as { outcome?: TeleportOutcome } | undefined)?.outcome;
    if (outcome) publish(ctx, outcome);
  });
  return publish;
}
