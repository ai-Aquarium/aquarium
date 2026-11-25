import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installGracefulShutdown } from "./graceful-shutdown.mjs";

const servers: Server[] = [];
const sockets: Socket[] = [];
let shutdown: (() => void) | null = null;

afterEach(() => {
  if (shutdown) {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    shutdown = null;
  }
  for (const s of sockets.splice(0)) s.destroy();
  for (const srv of servers.splice(0)) if (srv.listening) srv.close();
});

function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end("ok"));
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0 });
    });
  });
}

function openSocket(port: number): Socket {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {}); // refused/reset is expected in these tests
  sockets.push(socket);
  return socket;
}

describe("installGracefulShutdown", () => {
  it("exits cleanly and refuses new connections when idle", async () => {
    const { server, port } = await listen();
    const onExit = vi.fn();
    shutdown = installGracefulShutdown(server, { drainMs: 50, killMs: 300, onExit });
    shutdown();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0));
    await expect(
      new Promise((_, reject) => {
        openSocket(port).on("error", reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("destroys a socket mid-request at the drain deadline, then exits 0", async () => {
    const { server, port } = await listen();
    const onExit = vi.fn();
    shutdown = installGracefulShutdown(server, { drainMs: 60, killMs: 2_000, onExit });
    // An unfinished request keeps the socket busy — closeIdleConnections
    // won't touch it; only the drain deadline can end it.
    const socket = openSocket(port);
    socket.write("GET / HTTP/1.1\r\nHost: x\r\n"); // no terminating CRLF
    const closed = new Promise<void>((r) => socket.on("close", () => r()));
    shutdown();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0), { timeout: 2_000 });
    await closed;
  });

  it("hard-exits non-zero if close() never resolves", async () => {
    const { server } = await listen();
    const onExit = vi.fn();
    // A close callback that never fires simulates the wedged drain.
    server.close = () => server;
    shutdown = installGracefulShutdown(server, { drainMs: 10_000, killMs: 60, onExit });
    shutdown();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(1), { timeout: 2_000 });
  });

  it("counts a second signal only once", async () => {
    const { server } = await listen();
    const onExit = vi.fn();
    shutdown = installGracefulShutdown(server, { drainMs: 50, killMs: 300, onExit });
    shutdown();
    shutdown();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });
});
