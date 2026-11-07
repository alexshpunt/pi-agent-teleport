import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getHerdrContext } from "../../src/herdr.ts";

/** Deterministic inference only; both hosts run their real Pi, core and SSH processes. */
export default function roundtripProvider(pi: ExtensionAPI) {
  const root = process.env.PI_CODING_AGENT_DIR!;
  const plan = JSON.parse(readFileSync(join(root, "roundtrip.json"), "utf8")) as { actor: "local" | "remote"; target: string; marker: string };
  const preflight = Boolean(process.env.PI_TELEPORT_PREFLIGHT || process.env.PI_TELEPORT_PROBE);
  const side = plan.actor === "remote" ? "remote" : existsSync(join(root, "started-source.json")) ? "returned" : "source";
  pi.on("session_start", (_event, ctx) => {
    if (preflight) return;
    writeFileSync(join(root, `started-${side}.json`), JSON.stringify({
      pid: process.pid, cwd: process.cwd(), entryPoint: process.argv[1], executable: process.execPath,
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      context: getHerdrContext(),
    }));
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (preflight) return;
    writeFileSync(join(root, `settled-${side}.json`), JSON.stringify({
      pid: process.pid, header: ctx.sessionManager.getHeader(), entries: ctx.sessionManager.getEntries(),
    }));
  });
  let calls = 0;
  pi.registerProvider("native-roundtrip", {
    name: "Native round-trip fixture", baseUrl: "http://native-roundtrip.invalid", apiKey: "local", api: "openai-completions",
    models: [{ id: "roundtrip", name: "Native round-trip fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple: (model) => {
      if (preflight) throw new Error("Preflight must not request inference.");
      const stream = createAssistantMessageEventStream();
      const move = side !== "returned" && calls++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        content: move ? [{ type: "toolCall", id: `roundtrip-${side}`, name: "teleport",
          arguments: side === "source" ? { action: "jump", target: plan.target } : { action: "back" } }]
          : [{ type: "text", text: side === "returned" ? plan.marker : `Unexpected settled ${side}` }],
        api: model.api, provider: model.provider, model: model.id,
        stopReason: move ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(async () => {
        while (move && !existsSync(join(root, `go-${side}`))) await new Promise((resolve) => setTimeout(resolve, 25));
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      });
      return stream;
    },
  });
}
