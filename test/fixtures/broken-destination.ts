import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Simulate a destination where Pi dies during session startup, as a broken project setup would. */
export default function brokenDestination(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.cwd !== process.env.TELEPORT_TEST_BROKEN_DESTINATION) return;
    console.error("destination boom: database lock held by another process");
    process.exit(3);
  });
}
