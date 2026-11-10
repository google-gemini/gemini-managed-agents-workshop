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

// Step 3 Reference: Authenticate via GitHub OAuth (PKCE), store the access token in the write-only
// Gemini Credential Vault, and attach it to per-turn network.allowlist + Remote GitHub MCP.
// Run with: bun --env-file=.env steps/step3.ts [owner/repo]

import { createHash, randomBytes } from "node:crypto";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("GEMINI_API_KEY must be set in .env for Step 3.");
  process.exit(1);
}

async function acquireGitHubOAuthToken(): Promise<string> {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
    console.error("Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env (callback: http://localhost:3000/auth/github/callback).");
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? "3000");
  const redirectUri = `http://localhost:${port}/auth/github/callback`;
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", "read:user user:email repo");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log(`\nOpen this URL in your browser to authorize GitHub OAuth:\n  ${authUrl.toString()}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/github/callback") return new Response("Not Found", { status: 404 });
        const returnedCode = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        setTimeout(() => server.stop(), 50);
        if (!returnedCode || returnedState !== state) {
          reject(new Error("GitHub OAuth state mismatch or authorization denied."));
          return new Response("Authorization failed. Return to your terminal.", { status: 400 });
        }
        resolve(returnedCode);
        return new Response("GitHub OAuth complete! You can close this tab and return to your terminal.");
      },
    });
  });

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!tokenJson.access_token) {
    throw new Error(`OAuth token exchange failed: ${tokenJson.error_description ?? tokenRes.status}`);
  }
  return tokenJson.access_token;
}

const repo = process.argv[2] ?? "google/budoux";
const credentialId = "workshop-gh-oauth";
const client = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });

const githubAccessToken = await acquireGitHubOAuthToken();
console.log(`Step 3: Storing GitHub OAuth token in Gemini Credential Vault as "${credentialId}" ...`);
await client.credentials.delete(credentialId).catch(() => undefined);
const cred = await client.credentials.create({
  id: credentialId,
  type: "bearer_token",
  token: githubAccessToken,
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
      `Use the github MCP server to list open pull requests on ${repo}, read the diff of the newest open PR, ` +
      `review it using the pr-review skill, and verify in Python (os.environ and /proc/self/environ) ` +
      `that zero raw GitHub tokens exist inside the sandbox.`,
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
        console.log("\n[sandbox] verifying environment isolation");
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
