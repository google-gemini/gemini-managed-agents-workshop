// Reference solution server entry point: bun --env-file=.env solution/server/index.ts

import session from "express-session";
import createMemoryStore from "memorystore";
import { buildAgentDefinition, syncAgent } from "./agentDefinition.ts";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig, type AppConfig } from "./config.ts";
import { GeminiClient } from "./gemini.ts";
import { startJanitor } from "./janitor.ts";
import { describeError, log } from "./log.ts";
import type { AgentSyncStatus } from "./types.ts";

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

const gemini = new GeminiClient(cfg.geminiApiKey);

// TODO(security): use an encrypted external session store (e.g. Redis over TLS) for multi-instance deployments.
const MemoryStore = createMemoryStore(session);
const store = new MemoryStore({ checkPeriod: 15 * 60_000 });

const agentStatus: AgentSyncStatus = { synced: false, hash: null, skillFiles: [] };

try {
  const definition = await buildAgentDefinition(cfg);
  agentStatus.hash = definition.hash;
  agentStatus.skillFiles = definition.files;
  if (gemini.isConfigured) {
    const result = await syncAgent(gemini, definition);
    agentStatus.synced = true;
    log.info(`managed agent ${definition.id}: ${result}`, { config: definition.hash, files: definition.fileCount });
  } else {
    log.warn("GEMINI_API_KEY is not set in .env; skipping startup agent sync until configured");
  }
} catch (err) {
  log.error("could not sync managed agent on startup", { error: describeError(err) });
}

const app = createApp({ cfg, gemini, store, agentStatus });
const server = app.listen(cfg.port, cfg.host, (err?: Error) => {
  if (err) {
    log.error("server failed to start", { error: describeError(err) });
    process.exit(1);
  }
  log.info(`PR Reviewer (solution) running at ${cfg.baseUrl}`, {
    listen: `${cfg.host}:${cfg.port}`,
    slides: `${cfg.baseUrl}/slides`,
  });
});

const stopJanitor = startJanitor(gemini, store);

function shutdown(): void {
  stopJanitor();
  store.stopInterval();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
