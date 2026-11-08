import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Explicitly loaded on disposable and destination processes. Never let the
// private startup command become a model prompt if Teleport failed to load.
export default function arrivalGuard(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!process.env.PI_TELEPORT_PREFLIGHT && !process.env.PI_TELEPORT_HANDOFF && !process.env.PI_TELEPORT_CONTINUATION) return;
    const commands = pi.getCommands().filter((command) => /^__teleport_arrival(?::\d+)?$/.test(command.name));
    const expected = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
    let valid = false;
    try { valid = commands.length === 1 && commands[0].name === "__teleport_arrival" && !!commands[0].sourceInfo?.path && realpathSync(commands[0].sourceInfo.path) === realpathSync(expected); } catch { /* Fail closed if either installation cannot be identified. */ }
    if (!valid) ctx.shutdown();
  });
  pi.on("input", (event, ctx) => {
    if ((!process.env.PI_TELEPORT_PREFLIGHT && !process.env.PI_TELEPORT_HANDOFF && !process.env.PI_TELEPORT_CONTINUATION) || event.text.trim() !== "/__teleport_arrival") return;
    ctx.shutdown();
    return { action: "handled" };
  });
}
