import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Exercise startup beyond the former one-minute readiness limit. */
export default function slowDestination(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.cwd === process.env.TELEPORT_TEST_SLOW_DESTINATION) {
      await new Promise((resolve) => setTimeout(resolve, 62_000));
    }
  });
}
