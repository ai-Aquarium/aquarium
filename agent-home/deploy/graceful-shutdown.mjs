/**
 * Graceful shutdown for the agent-home production server.
 *
 * `next start` catches SIGTERM/SIGINT and calls `server.close()` — which
 * stops *new* connections but then waits for every existing one to end on
 * its own. A live chat's SSE stream (or any long poll / upgraded socket)
 * never ends, so the unit hung until systemd's 90 s SIGKILL every restart.
 *
 * This is the same shape with a drain deadline: stop accepting, close idle
 * keep-alives immediately, give in-flight requests `drainMs` to finish, then
 * destroy whatever is still open (streams, slow polls) and exit. `killMs` is
 * the last-resort exit if `server.close()` never resolves anyway.
 */
/**
 * @param {import("node:http").Server} server
 * @param {{ drainMs?: number, killMs?: number, onExit?: (code: number) => void, log?: (...args: unknown[]) => void }} [opts]
 */
export function installGracefulShutdown(
  server,
  {
    drainMs = 10_000,
    killMs = 15_000,
    onExit = (code) => process.exit(code),
    log = () => {},
  } = {},
) {
  // Every socket the server holds: ordinary, keep-alive and upgraded. A
  // socket removes itself on close so the set only holds live ones.
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  server.on("connection", track);
  server.on("secureConnection", track);
  server.on("upgrade", (_req, socket) => track(socket));

  let closing = false;
  const shutdown = () => {
    if (closing) return; // duplicate signals (SIGINT then SIGTERM) count once
    closing = true;
    log("shutdown: stop accepting, drain for", drainMs, "ms");
    const kill = setTimeout(() => {
      log("shutdown: hard exit,", sockets.size, "socket(s) still open");
      onExit(1);
    }, killMs);
    kill.unref();
    // Drain deadline: whatever is still open after this is a stream or a
    // request that would rather outlive the restart — cut it.
    const drain = setTimeout(() => {
      log("shutdown: drain over, closing", sockets.size, "socket(s)");
      for (const socket of sockets) socket.destroy();
    }, drainMs);
    drain.unref();
    server.close((err) => {
      clearTimeout(drain);
      clearTimeout(kill);
      if (err) {
        log("shutdown: close error", err);
        return onExit(1);
      }
      log("shutdown: clean");
      onExit(0);
    });
    // Idle keep-alive sockets can go right now; in-flight requests keep their
    // drain window. (Node >= 18.2; guard for older runtimes.)
    server.closeIdleConnections?.();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return shutdown;
}
