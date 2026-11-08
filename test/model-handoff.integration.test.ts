import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { assistantMessage, getToolResultText, PiIntegrationTest, testArtifactsDir, text, toolCall } from "pi-coding-agent-test";

test("local jump and return keep the selected virtual model and thinking level", async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".tmp/teleport-virtual-model-"));
  const source = join(root, "source"), target = join(root, "target"), agent = join(root, "agent");
  await Promise.all([source, target, agent].map((dir) => mkdir(dir)));
  const extension = join(root, "router.ts");
  await writeFile(extension, `
    import { Type } from "typebox";
    export default function (pi) {
      pi.registerVirtualModel({ provider: "scripted", id: "virtual", name: "virtual", thinkingLevels: ["off", "high"],
        route: (_request, ctx) => ({ model: ctx.modelRegistry.find("scripted", "scripted-model"), thinkingLevel: "off" }) });
      pi.on("session_start", async (_event, ctx) => {
        if (ctx.cwd === ${JSON.stringify(source)} && !process.env.PI_TELEPORT_PREFLIGHT) {
          const model = ctx.modelRegistry.find("scripted", "virtual");
          if (model && await pi.setModel(model)) pi.setThinkingLevel("high");
        } else if (ctx.cwd === ${JSON.stringify(target)} && !process.env.PI_TELEPORT_PREFLIGHT) {
          const model = ctx.modelRegistry.find("scripted", "scripted-model");
          if (model) await pi.setModel(model);
        }
      });
      pi.registerTool({ name: "selected_model", label: "Selected model", description: "Report the selected model", parameters: Type.Object({}),
        async execute(_id, _params, _signal, _update, ctx) { return { content: [{ type: "text", text: JSON.stringify({ provider: ctx.model?.provider, id: ctx.model?.id, thinking: ctx.thinkingLevel, cwd: ctx.cwd }) }] }; } });
    }
  `);
  const call = (id: string, name: string, args: Record<string, unknown>) => assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
  try {
    const result = await new PiIntegrationTest({
      testName: "teleport-virtual-model", artifactsDir: testArtifactsDir(import.meta.filename), cwd: source,
      extensions: [extension, resolve("src/index.ts")], tools: ["teleport", "selected_model"], rawMode: false,
      environment: { PI_CODING_AGENT_DIR: agent, HC_TERMINAL_ID: "", HERDR_ENV: "", HERDR_WORKSPACE_ID: "", HERDR_TAB_ID: "", HERDR_PANE_ID: "" },
      conversation: [call("before", "selected_model", {}), call("jump", "teleport", { action: "jump", target }), call("at-target", "selected_model", {}), call("back", "teleport", { action: "back" }), call("returned", "selected_model", {}), assistantMessage([text("Done")])],
      timeoutMs: 90_000,
    }).run("Move and return.");
    for (const [id, cwd] of [["before", source], ["at-target", target], ["returned", source]]) expect(JSON.parse(getToolResultText(result, id))).toEqual({ provider: "scripted", id: "virtual", thinking: "high", cwd });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 110_000);
