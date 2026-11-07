import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

/** A deterministic local model; the real App terminals still own both Pi processes. */
export default function nativeAppProvider(pi: ExtensionAPI) {
  const root = process.env.PI_CODING_AGENT_DIR!;
  const { target } = JSON.parse(readFileSync(join(root, "native-app.json"), "utf8")) as { target: string };
  const side = process.cwd() === target ? "destination" : "source";
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(join(root, `started-${side}.json`), JSON.stringify({
      pid: process.pid, cwd: process.cwd(), entryPoint: process.argv[1], sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
    }));
  });
  pi.on("agent_settled", (_event, ctx) => {
    writeFileSync(join(root, `settled-${side}.json`), JSON.stringify({
      pid: process.pid, header: ctx.sessionManager.getHeader(), entries: ctx.sessionManager.getEntries(),
    }));
  });
  pi.registerProvider("native-app", {
    name: "Native App test provider", baseUrl: "http://native-app.invalid", apiKey: "local", api: "openai-completions",
    models: [{ id: "native-app-model", name: "Native App test model", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple: (model) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: side === "source"
          ? [{ type: "toolCall", id: "native-app-jump", name: "teleport", arguments: { action: "jump", target } }]
          : [{ type: "text", text: "Native destination continued." }],
        api: model.api, provider: model.provider, model: model.id,
        stopReason: side === "source" ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(async () => {
        // Let the observer prove native source ownership before the move can retire it.
        while (!existsSync(join(root, "go"))) await new Promise((resolve) => setTimeout(resolve, 25));
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      });
      return stream;
    },
  });
}
