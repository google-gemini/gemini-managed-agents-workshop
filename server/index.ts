/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
