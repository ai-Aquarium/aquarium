/**
 * Production server for agent-home — the same thing `next start` runs, plus
 * graceful shutdown (deploy/graceful-shutdown.mjs). `next start` waits on
 * `server.close()` in production, which hangs forever behind a live SSE
 * stream; here we own the http.Server and can bound the drain.
 *
 * Run by deploy/start.sh under systemd. HOST/PORT mirror the flags
 * `npm run start -- -H localhost -p 3100` used to pass.
 */
import { createServer } from "node:http";

import next from "next";

import { installGracefulShutdown } from "./graceful-shutdown.mjs";

const port = Number(process.env.PORT || 3100);
const hostname = process.env.HOST || "localhost";
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = createServer((req, res) => handle(req, res));
    installGracefulShutdown(server, {
      log: (...args) => console.log("[graceful-shutdown]", ...args),
    });
    server.listen(port, hostname, () => {
      console.log(`agent-home listening on http://${hostname}:${port}`);
    });
  })
  .catch((err) => {
    console.error("agent-home failed to start:", err);
    process.exit(1);
  });
