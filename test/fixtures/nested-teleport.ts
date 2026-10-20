import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function nestedTeleport(pi: ExtensionAPI) {
  for (const name of ["teleport_outer", "teleport_inner"]) {
    pi.registerTool({
      name,
      label: name,
      description: "Exercise nested Teleport execution ownership.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _onUpdate, ctx) {
        const outcome = await ctx.executeTool(name === "teleport_outer" ? "teleport_inner" : "teleport", name === "teleport_inner" ? { action: "back" } : {}, { signal });
        return outcome.result;
      },
    });
  }
}
