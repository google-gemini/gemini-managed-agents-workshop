// Workshop starter server entry point: bun --env-file=.env server/index.ts

import session from "express-session";
import createMemoryStore from "memorystore";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig, type AppConfig } from "./config.ts";
import { describeError, log } from "./log.ts";

let cfg: AppConfig;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n  ✖ Configuration error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const MemoryStore = createMemoryStore(session);
const store = new MemoryStore({ checkPeriod: 15 * 60_000 });

const app = createApp({ cfg, store });
const server = app.listen(cfg.port, cfg.host, (err?: Error) => {
  if (err) {
    log.error("server failed to start", { error: describeError(err) });
    process.exit(1);
  }
  log.info(`PR Reviewer starter running at ${cfg.baseUrl}`, {
    listen: `${cfg.host}:${cfg.port}`,
    slides: `${cfg.baseUrl}/slides`,
  });
});

function shutdown(): void {
  store.stopInterval();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
