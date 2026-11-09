// CLI script to bundle and sync `solution/agent/` into saved Gemini Managed Agent `pr-reviewer`.
// Run with: bun run solution:sync

import { buildAgentDefinition, syncAgent } from "../server/agentDefinition.ts";
import { ConfigError, loadGeminiConfig } from "../server/config.ts";
import { GeminiClient } from "../server/gemini.ts";

try {
  const cfg = loadGeminiConfig();
  const client = new GeminiClient(cfg.geminiApiKey);
  const definition = await buildAgentDefinition(cfg);
  const force = process.argv.includes("--force");
  const result = await syncAgent(client, definition, { force });
  console.log(
    `✔ Managed agent "${definition.id}" ${result} (hash=${definition.hash}, files=${definition.files.join(", ")})`,
  );
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
  throw err;
}
