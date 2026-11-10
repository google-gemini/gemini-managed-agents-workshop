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

// CLI script to bundle and sync `agent/` into saved Gemini Managed Agent `pr-reviewer`.
// Run with: bun run agent:sync

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
