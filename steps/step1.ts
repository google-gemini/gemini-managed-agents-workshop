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

// Step 1 Reference: Create minimal saved agent "pr-reviewer-basic" and stream a PR review turn.
// Run with: bun --env-file=.env steps/step1.ts [owner/repo]

import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY in .env (copy .env.example to .env first).");
  process.exit(1);
}

const repo = process.argv[2] ?? "google/budoux";
const agentId = "pr-reviewer-basic";
const model = process.env.GEMINI_AGENT_MODEL ?? "gemini-4-carbon";
const client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });

console.log(`Step 1: Registering minimal saved agent "${agentId}" (${model}) ...`);
await client.agents.delete(agentId).catch(() => undefined);
await client.agents.create({
  id: agentId,
  description: "Minimal PR inspection agent",
  base_agent: "antigravity-preview-09-2026",
  agent_config: { type: "antigravity", model },
});

console.log(`Streaming interaction against https://github.com/${repo} ...\n`);

const stream = await client.interactions.create({
  agent: agentId,
  input:
    `Shallow-clone https://github.com/${repo}.git (--depth=1) into /workspace/repo, inspect the latest open ` +
    `pull request (via https://api.github.com/repos/${repo}/pulls?state=open&per_page=1), and summarize its changes.`,
  environment: "remote",
  stream: true,
});

let outputText = "";
let envId: string | undefined;
const thoughtSteps = new Set<number>();

for await (const ev of stream) {
  if (ev.event_type === "interaction.created") {
    envId = (ev.interaction as { environment_id?: string } | undefined)?.environment_id;
    console.log(`[interaction.created] id=${ev.interaction?.id} environment_id=${envId}`);
  } else if (ev.event_type === "step.start") {
    const stepType = (ev.step as { type?: string } | undefined)?.type ?? "unknown";
    if (stepType === "thought" && typeof ev.index === "number") thoughtSteps.add(ev.index);
    console.log(`[step] ${stepType}`);
  } else if (ev.event_type === "step.delta") {
    const delta = ev.delta as { type?: string; text?: string };
    if (delta.type === "text" && delta.text && (typeof ev.index !== "number" || !thoughtSteps.has(ev.index))) {
      outputText += delta.text;
    }
  } else if (ev.event_type === "interaction.completed") {
    envId = (ev.interaction as { environment_id?: string } | undefined)?.environment_id ?? envId;
  }
}

console.log(`\nFinal output:\n${outputText.trim()}\n`);
console.log(`environment_id: ${envId ?? "none"}`);

await client.agents.delete(agentId).catch(() => undefined);
if (envId) {
  await client.environments.delete(envId).catch(() => undefined);
  console.log(`Cleaned up sandbox environment ${envId}.`);
}
