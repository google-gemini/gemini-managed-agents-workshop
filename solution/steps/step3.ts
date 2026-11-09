// Step 3 Reference: Store GITHUB_TOKEN in the write-only Gemini Credential Vault and attach it to
// per-turn network.allowlist + GitHub Remote MCP (https://api.githubcopilot.com/mcp/).
// Run with: bun run solution/steps/step3.ts [owner/repo]

import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY?.trim();
const githubToken = process.env.GITHUB_TOKEN?.trim();
if (!apiKey || !githubToken) {
  console.error("Both GEMINI_API_KEY and GITHUB_TOKEN must be set in .env for Step 3.");
  process.exit(1);
}

const repo = process.argv[2] ?? "google/budoux";
const credentialId = "workshop-gh-pat";
const client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });

console.log(`Step 3: Storing GITHUB_TOKEN in Gemini Credential Vault as "${credentialId}" ...`);
await client.credentials.delete(credentialId).catch(() => undefined);
const cred = await client.credentials.create({
  id: credentialId,
  type: "bearer_token",
  token: githubToken,
});
console.log("Vault response (write-only, secret never returned):", {
  id: cred.id,
  type: cred.type,
  status: cred.status,
  create_time: cred.create_time,
});

let envId: string | undefined;
const thoughtSteps = new Set<number>();
try {
  const stream = await client.interactions.create({
    agent: "pr-reviewer",
    input:
      `Use the github MCP server to list open pull requests on ${repo}, pick the most recent open PR, ` +
      `run the pr-review skill in /workspace/pr on that PR, and run a short Python check inspecting os.environ ` +
      `and /proc/self/environ to confirm zero raw GitHub tokens (ghp_ / github_pat_ / gho_) exist inside the sandbox.`,
    environment: {
      type: "remote",
      network: {
        allowlist: [
          { domain: "github.com", credential: credentialId },
          { domain: "*.githubusercontent.com" },
          { domain: "api.github.com", credential: credentialId },
          { domain: "api.githubcopilot.com", credential: credentialId },
        ],
      },
    },
    tools: [
      { type: "code_execution" },
      { type: "google_search" },
      {
        type: "mcp_server",
        name: "github",
        url: "https://api.githubcopilot.com/mcp/",
        ...({ credential: credentialId } as Record<string, unknown>),
      },
    ],
    stream: true,
  });

  for await (const ev of stream) {
    if (ev.event_type === "interaction.created") {
      envId = (ev.interaction as { environment_id?: string } | undefined)?.environment_id;
      console.log(`[stream] interaction=${ev.interaction?.id} env=${envId}`);
    } else if (ev.event_type === "step.start") {
      const step = ev.step as { type?: string; name?: string } | undefined;
      if (step?.type === "thought" && typeof ev.index === "number") thoughtSteps.add(ev.index);
      if (step?.type === "mcp_server_tool_call") {
        console.log(`\n[mcp] github.${step.name ?? "tool"}`);
      } else if (step?.type === "code_execution_call") {
        console.log("\n[sandbox] running command in /workspace");
      }
    } else if (ev.event_type === "step.delta") {
      const delta = ev.delta as { type?: string; text?: string };
      if (delta.type === "text" && delta.text && (typeof ev.index !== "number" || !thoughtSteps.has(ev.index))) {
        process.stdout.write(delta.text);
      }
    }
  }
  console.log("\n");
} finally {
  await client.credentials.delete(credentialId).catch(() => undefined);
  if (envId) await client.environments.delete(envId).catch(() => undefined);
  console.log(`Cleaned up vault credential "${credentialId}"${envId ? ` and sandbox "${envId}"` : ""}.`);
}
