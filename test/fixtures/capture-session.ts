import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function captureSession(pi: ExtensionAPI) {
  pi.on("agent_settled", (_event, ctx) => {
    const path = process.env.TELEPORT_TEST_CAPTURE;
    if (path) writeFileSync(path, [ctx.sessionManager.getHeader(), ...ctx.sessionManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  });
}
