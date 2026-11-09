import { createConnection, createServer } from "node:net";
import { expect, test } from "vitest";
import { listenController } from "./bridge.ts";

test("Windows controller listens on a loopback TCP port for a remote return", async () => {
  const server = createServer((socket) => socket.end("ok"));
  try {
    const endpoint = await listenController(server, "/unused", "win32");
    const address = new URL(endpoint);
    expect(address.protocol).toBe("tcp:");
    expect(address.hostname).toBe("127.0.0.1");
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ host: address.hostname, port: Number(address.port) });
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { text += chunk; });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    expect(reply).toBe("ok");
  } finally { server.close(); }
});
