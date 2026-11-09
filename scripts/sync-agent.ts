// Step 2 Starter Stub: Bundle `agent/AGENTS.md` + `agent/skills/pr-review/` and register saved agent `pr-reviewer`.
// Run with: bun run agent:sync

import { inspectAgentFiles } from "../server/agentDefinition.ts";

const { files, hasAgentsMd } = await inspectAgentFiles();

console.log("──────────────────────────────────────────────────────────────");
console.log("  Workshop Step 2 — Custom Agent Sync (`scripts/sync-agent.ts`)");
console.log("──────────────────────────────────────────────────────────────");
console.log(`  Files currently in ./agent: ${files.length > 0 ? files.join(", ") : "(none yet)"}`);
console.log("");
if (!hasAgentsMd) {
  console.log("  Next step: Open http://localhost:3000/slides (Step 2) and ask your coding agent");
  console.log("  to author `agent/AGENTS.md` + `agent/skills/pr-review/SKILL.md` and wire");
  console.log("  `buildAgentDefinition` + `syncAgent` (or `client.agents.create`) here.");
} else {
  console.log("  `agent/AGENTS.md` detected! Wire `loadGeminiConfig()`, `buildAgentDefinition()`,");
  console.log("  and `syncAgent()` from `../server/agentDefinition.ts` (see `.agents/skills/gemini-managed-agents/SKILL.md`).");
}
console.log("──────────────────────────────────────────────────────────────");
