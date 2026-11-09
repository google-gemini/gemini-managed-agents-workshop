import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import session from "express-session";
import createMemoryStore from "memorystore";

import { createApp as createStarterApp } from "../server/app.ts";
import { ConfigError, loadConfig } from "../server/config.ts";
import { GeminiClient as StarterGeminiClient } from "../server/gemini.ts";

import { buildAgentDefinition, syncAgent } from "../solution/server/agentDefinition.ts";
import { AgentStreamMapper } from "../solution/server/agentStream.ts";
import { createApp as createSolutionApp } from "../solution/server/app.ts";
import { loadConfig as loadSolutionConfig } from "../solution/server/config.ts";
import { GeminiClient as SolutionGeminiClient } from "../solution/server/gemini.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TMP_DIR = path.join(REPO_ROOT, "tmp", "test-fixtures");

const activeServers: Array<{ server: Server; stopStore: () => void }> = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const entry = activeServers.pop()!;
    entry.stopStore();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => undefined);
});

async function startTestServer(
  mode: "starter" | "solution",
  envOverrides: Record<string, string | undefined> = {},
  fetchMock?: typeof fetch,
) {
  const MemoryStore = createMemoryStore(session);
  const store = new MemoryStore({ checkPeriod: 60_000 });
  const baseEnv: Record<string, string | undefined> = {
    HOST: "127.0.0.1",
    PORT: "3000",
    SESSION_SECRET: "a".repeat(64),
    GEMINI_API_KEY: "test-gemini-key",
    GITHUB_TOKEN: "ghp_super_secret_workshop_token_12345",
    ...envOverrides,
  };

  if (mode === "starter") {
    const cfg = loadConfig(baseEnv);
    const gemini = new StarterGeminiClient(cfg.geminiApiKey, fetchMock);
    const tempApp = createStarterApp({ cfg, gemini, store, ...(fetchMock ? { fetchImpl: fetchMock } : {}) });
    const probe = await new Promise<Server>((resolve) => {
      const s = tempApp.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const boundCfg = loadConfig({
      ...baseEnv,
      PORT: String(port),
      APP_BASE_URL: `http://127.0.0.1:${port}`,
    });
    const app = createStarterApp({ cfg: boundCfg, gemini, store, ...(fetchMock ? { fetchImpl: fetchMock } : {}) });
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, "127.0.0.1", () => resolve(s));
    });
    activeServers.push({ server, stopStore: () => store.stopInterval() });
    return { baseUrl: `http://127.0.0.1:${port}` };
  }

  const probeCfg = loadSolutionConfig(baseEnv);
  const gemini = new SolutionGeminiClient(probeCfg.geminiApiKey, fetchMock);
  const probeApp = createSolutionApp({ cfg: probeCfg, gemini, store, ...(fetchMock ? { fetchImpl: fetchMock } : {}) });
  const probe = await new Promise<Server>((resolve) => {
    const s = probeApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const boundCfg = loadSolutionConfig({
    ...baseEnv,
    PORT: String(port),
    APP_BASE_URL: `http://127.0.0.1:${port}`,
  });
  const def = await buildAgentDefinition(boundCfg);
  const app = createSolutionApp({
    cfg: boundCfg,
    gemini,
    store,
    agentStatus: { synced: true, hash: def.hash, skillFiles: def.files },
    ...(fetchMock ? { fetchImpl: fetchMock } : {}),
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  activeServers.push({ server, stopStore: () => store.stopInterval() });
  return { baseUrl: `http://127.0.0.1:${port}` };
}

function cookiePair(res: Response): string {
  const raw = res.headers.getSetCookie?.()[0] ?? res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

describe("Configuration & Loopback Binding", () => {
  test("defaults to 127.0.0.1:3000 and rejects 0.0.0.0", () => {
    const cfg = loadConfig({ SESSION_SECRET: "s".repeat(48) });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3000);
    expect(cfg.agentId).toBe("pr-reviewer");
    expect(cfg.agentModel).toBe("gemini-3.8-flash");

    expect(() => loadConfig({ HOST: "0.0.0.0", SESSION_SECRET: "s".repeat(48) })).toThrow(ConfigError);
    expect(() => loadConfig({ APP_BASE_URL: "http://example.com:3000", SESSION_SECRET: "s".repeat(48) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ SESSION_SECRET: "too-short" })).toThrow(ConfigError);
  });
});

describe("Starter Server Contract & Security Hardening", () => {
  test("serves unauthenticated /api/me metadata, strict CSP on /, and route-scoped CSP on /slides", async () => {
    const { baseUrl } = await startTestServer("starter", {
      GITHUB_CLIENT_ID: undefined,
      GITHUB_CLIENT_SECRET: undefined,
      GITHUB_TOKEN: "ghp_pat_123",
    });

    const meRes = await fetch(`${baseUrl}/api/me`);
    expect(meRes.status).toBe(401);
    expect(meRes.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(meRes.headers.get("content-security-policy")).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(meRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(meRes.headers.get("x-frame-options")).toBe("DENY");
    expect(await meRes.json()).toEqual({
      error: "unauthenticated",
      workshopMode: "starter",
      hasGithubOAuth: false,
      hasGithubPat: true,
    });

    const slidesRes = await fetch(`${baseUrl}/slides`);
    expect([200, 503]).toContain(slidesRes.status);
    expect(slidesRes.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(slidesRes.headers.get("content-security-policy")).toContain("font-src 'self' data:");

    const putRes = await fetch(`${baseUrl}/api/me`, { method: "PUT" });
    expect(putRes.status).toBe(405);

    const badHost = await fetch(`${baseUrl}/api/me`, { headers: { Host: "evil.example.com" } });
    expect(badHost.status).toBe(421);
  });

  test("enforces CSRF on POST endpoints and streams friendly starter walkthrough in /api/chat", async () => {
    const { baseUrl } = await startTestServer("starter");

    const loginRes = await fetch(`${baseUrl}/auth/github`, { redirect: "manual" });
    expect(loginRes.status).toBe(303);
    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("SameSite=Lax");
    const cookie = cookiePair(loginRes);

    const meRes = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { csrfToken: string; workshopMode: string; email: string };
    expect(me.workshopMode).toBe("starter");
    expect(me.email).toContain("•");

    const noCsrf = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Review PR #1", timeZone: "UTC" }),
    });
    expect(noCsrf.status).toBe(403);

    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-csrf-token": me.csrfToken,
      },
      body: JSON.stringify({ message: "Review PR #1", timeZone: "UTC" }),
    });
    expect(chatRes.status).toBe(200);
    const sseText = await chatRes.text();
    expect(sseText).toContain("event: step");
    expect(sseText).toContain("Starter Server Connected");
    expect(sseText).toContain('event: done\ndata: {"status":"completed"}');
  });
});

describe("Solution Agent Definition, Python Skill & Stream Mapper", () => {
  test("bundles solution/agent/ with inline sources, omits url_context, and enforces size limits", async () => {
    const def = await buildAgentDefinition({ agentId: "pr-reviewer", agentModel: "gemini-3.8-flash" });
    expect(def.id).toBe("pr-reviewer");
    expect([...def.files].sort()).toEqual([
      "AGENTS.md",
      "skills/pr-review/SKILL.md",
      "skills/pr-review/scripts/inspect_pr.py",
    ]);
    const tools = def.body.tools as Array<{ type: string }>;
    expect(tools.map((t) => t.type)).toEqual(["code_execution", "google_search"]);

    const emptyDir = path.join(TMP_DIR, "empty-agent");
    await mkdir(emptyDir, { recursive: true });
    await expect(buildAgentDefinition({ agentId: "pr-reviewer", agentModel: "gemini-3.8-flash" }, emptyDir)).rejects.toThrow(
      "AGENTS.md is missing",
    );

    const hugeDir = path.join(TMP_DIR, "huge-agent");
    await mkdir(hugeDir, { recursive: true });
    await writeFile(path.join(hugeDir, "AGENTS.md"), "x".repeat(1024 * 1024 + 10));
    await expect(buildAgentDefinition({ agentId: "pr-reviewer", agentModel: "gemini-3.8-flash" }, hugeDir)).rejects.toThrow(
      "exceeds the 1 MB",
    );
  });

  test("inspect_pr.py detects and runs tests inside ./tmp and blocks path traversal", async () => {
    const sampleRepo = path.join(TMP_DIR, "sample-py-pr");
    await mkdir(path.join(sampleRepo, "tests"), { recursive: true });
    await writeFile(
      path.join(sampleRepo, "tests", "test_math.py"),
      "import unittest\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(2 + 2, 4)\n",
    );

    const scriptPath = path.join(REPO_ROOT, "solution/agent/skills/pr-review/scripts/inspect_pr.py");
    const runProc = Bun.spawnSync(["uv", "run", "python3", scriptPath, "run-tests", "--dir", sampleRepo, "--timeout", "15"], {
      cwd: REPO_ROOT,
    });
    expect(runProc.exitCode).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(runProc.stdout)) as { ok: boolean; exit_code: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.exit_code).toBe(0);

    const traversalProc = Bun.spawnSync(["uv", "run", "python3", scriptPath, "detect-tests", "--dir", "/etc"], {
      cwd: REPO_ROOT,
    });
    expect(traversalProc.exitCode).toBe(2);
  });

  test("AgentStreamMapper maps MCP calls, sandbox skill calls, thoughts, and text deltas cleanly", () => {
    const mapper = new AgentStreamMapper();

    expect(
      mapper.handle({
        event: "interaction.created",
        data: JSON.stringify({ interaction: { id: "int_1", environment_id: "env_42" } }),
      }),
    ).toEqual([{ type: "status", text: "Thinking" }]);

    mapper.handle({ event: "step.start", data: JSON.stringify({ index: 0, step: { type: "thought" } }) });
    const thoughtEvs = mapper.handle({
      event: "step.delta",
      data: JSON.stringify({ index: 0, delta: { type: "thought_summary", content: { text: "**Inspecting open PRs**\nChecking repo" } } }),
    });
    expect(thoughtEvs).toEqual([{ type: "status", text: "Inspecting open PRs" }]);
    const stopThought = mapper.handle({ event: "step.stop", data: JSON.stringify({ index: 0 }) });
    expect(stopThought[0]).toEqual({
      type: "step",
      step: { id: "t0", kind: "thought", label: "Inspecting open PRs", state: "done" },
    });

    const mcpEvents = mapper.handle({
      event: "step.start",
      data: JSON.stringify({
        index: 1,
        step: {
          type: "mcp_server_tool_call",
          id: "call_mcp_1",
          name: "get_pull_request_diff",
          arguments: { owner: "googleapis", repo: "js-genai", pullNumber: 99 },
        },
      }),
    });
    expect(mcpEvents[0]).toEqual({
      type: "step",
      step: {
        id: "s1",
        kind: "mcp",
        label: "GitHub MCP · Reading pull request diff",
        detail: "googleapis/js-genai#99",
        state: "running",
      },
    });

    const mcpDone = mapper.handle({
      event: "step.start",
      data: JSON.stringify({
        index: 2,
        step: { type: "mcp_server_tool_result", call_id: "call_mcp_1", is_error: false },
      }),
    });
    expect(mcpDone[0]).toEqual({ type: "stepdone", id: "s1", ok: true });

    const codeEvents = mapper.handle({
      event: "step.start",
      data: JSON.stringify({
        index: 3,
        step: {
          type: "code_execution_call",
          id: "call_code_1",
          arguments: {
            code: "python3 /.agents/skills/pr-review/scripts/inspect_pr.py clone-pr --repo googleapis/js-genai --pr 99 --dir /workspace/pr",
          },
        },
      }),
    });
    expect(codeEvents[0]).toEqual({
      type: "step",
      step: {
        id: "s3",
        kind: "code",
        label: "Checking out PR in sandbox",
        detail: "googleapis/js-genai#99",
        state: "running",
      },
    });

    mapper.handle({ event: "step.start", data: JSON.stringify({ index: 4, step: { type: "model_output" } }) });
    const textDelta = mapper.handle({
      event: "step.delta",
      data: JSON.stringify({ index: 4, delta: { type: "text", text: "### Merge Verdict\nAPPROVE" } }),
    });
    expect(textDelta).toEqual([{ type: "text", delta: "### Merge Verdict\nAPPROVE" }]);
    expect(mapper.interactionId).toBe("int_1");
    expect(mapper.environmentId).toBe("env_42");
  });
});

describe("Solution Server End-to-End Vault, OAuth/PAT Auth, SSE Chat & Teardown", () => {
  test("stores GitHub token in vault (zero raw token leakage), streams MCP+sandbox chat, and cleans up on logout", async () => {
    const vaultStore = new Map<string, { id: string; type: string; create_time: string }>();
    const deletedEnvs: string[] = [];
    const deletedCreds: string[] = [];
    let capturedInteractionBody: Record<string, unknown> | undefined;

    const mockFetch: typeof fetch = (async (input: Request | URL | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({
            id: 4242,
            login: "octoreviewer",
            name: "Octo Reviewer",
            email: "octo@example.com",
            avatar_url: "https://avatars.githubusercontent.com/u/4242",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { code_verifier?: string };
        expect(typeof body.code_verifier).toBe("string");
        return new Response(JSON.stringify({ access_token: "gho_oauth_token_secret_999" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/v1beta/credentials") && init?.method === "POST") {
        const payload = JSON.parse(String(init.body)) as { id: string; type: string; token: string };
        expect(payload.token.length).toBeGreaterThan(10);
        vaultStore.set(payload.id, {
          id: payload.id,
          type: payload.type,
          create_time: new Date().toISOString(),
        });
        return new Response(JSON.stringify({ id: payload.id, type: payload.type, status: "ACTIVE" }), { status: 200 });
      }

      if (url.includes("/v1beta/credentials?") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ credentials: [...vaultStore.values()] }), { status: 200 });
      }

      if (url.includes("/v1beta/credentials/") && init?.method === "DELETE") {
        const id = url.split("/credentials/")[1]!;
        deletedCreds.push(id);
        vaultStore.delete(id);
        return new Response("{}", { status: 200 });
      }

      if (url.includes("/v1beta/environments/") && init?.method === "DELETE") {
        deletedEnvs.push(url.split("/environments/")[1]!);
        return new Response("{}", { status: 200 });
      }

      if (url.endsWith("/v1beta/interactions") && init?.method === "POST") {
        capturedInteractionBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        const ssePayload = [
          `event: interaction.created\ndata: ${JSON.stringify({ interaction: { id: "int_turn_1", environment_id: "env_live_1" } })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({
            index: 0,
            step: {
              type: "mcp_server_tool_call",
              id: "c1",
              name: "list_pull_requests",
              arguments: { owner: "googleapis", repo: "js-genai" },
            },
          })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({
            index: 1,
            step: { type: "mcp_server_tool_result", call_id: "c1", is_error: false },
          })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({ index: 2, step: { type: "model_output" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ index: 2, delta: { type: "text", text: "Found 2 open PRs. **APPROVE**" } })}\n\n`,
          `event: interaction.completed\ndata: ${JSON.stringify({ interaction: { status: "completed", environment_id: "env_live_1" } })}\n\n`,
        ].join("");
        return new Response(ssePayload, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const { baseUrl } = await startTestServer("solution", {}, mockFetch);

    // 1. PAT sign-in -> stores secret in vault, never leaks token in /api/me or /api/vault
    const loginRes = await fetch(`${baseUrl}/auth/github`, { redirect: "manual" });
    expect(loginRes.status).toBe(303);
    const cookie = cookiePair(loginRes);

    const meRes = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
    expect(meRes.status).toBe(200);
    const meRaw = await meRes.text();
    expect(meRaw).not.toContain("ghp_super_secret_workshop_token_12345");
    const me = JSON.parse(meRaw) as {
      login: string;
      authMode: string;
      workshopMode: string;
      csrfToken: string;
    };
    expect(me.login).toBe("octoreviewer");
    expect(me.authMode).toBe("pat");
    expect(me.workshopMode).toBe("solution");

    // 2. Chat SSE turn attaches vault credential to both network.allowlist and github MCP server
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-csrf-token": me.csrfToken,
      },
      body: JSON.stringify({ message: "List open PRs on googleapis/js-genai", timeZone: "America/Los_Angeles" }),
    });
    expect(chatRes.status).toBe(200);
    const sseOut = await chatRes.text();
    expect(sseOut).toContain("GitHub MCP · Listing pull requests");
    expect(sseOut).toContain("Found 2 open PRs. **APPROVE**");
    expect(sseOut).toContain('"environmentId":"env_live_1"');

    expect(capturedInteractionBody?.agent).toBe("pr-reviewer");
    const tools = capturedInteractionBody?.tools as Array<Record<string, unknown>>;
    const mcpTool = tools.find((t) => t.type === "mcp_server");
    expect(mcpTool?.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(String(mcpTool?.credential)).toStartWith("review-s-");

    // 3. Vault inspector shows session credential + environmentId
    const vaultRes = await fetch(`${baseUrl}/api/vault`, { headers: { Cookie: cookie } });
    expect(vaultRes.status).toBe(200);
    const vault = (await vaultRes.json()) as {
      agentId: string;
      agentSynced: boolean;
      mcpEnabled: boolean;
      sessionCredentialId: string;
      sessionEnvironmentId: string;
      credentials: Array<{ id: string; isCurrentSession: boolean }>;
    };
    expect(vault.agentId).toBe("pr-reviewer");
    expect(vault.agentSynced).toBe(true);
    expect(vault.mcpEnabled).toBe(true);
    expect(vault.sessionEnvironmentId).toBe("env_live_1");
    expect(vault.credentials.some((c) => c.id === vault.sessionCredentialId && c.isCurrentSession)).toBe(true);

    // 4. Logout deletes BOTH vault credential and sandbox environment
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-csrf-token": me.csrfToken,
      },
    });
    expect(logoutRes.status).toBe(204);
    expect(deletedCreds).toContain(vault.sessionCredentialId);
    expect(deletedEnvs).toContain("env_live_1");

    // 5. Also verify syncAgent idempotency against GeminiClient
    const syncClient = new SolutionGeminiClient("test-key", (async (input: Request | URL | string, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith("/agents/pr-reviewer") && (!init?.method || init.method === "GET")) {
        return new Response("{}", { status: 404 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    const def = await buildAgentDefinition({ agentId: "pr-reviewer", agentModel: "gemini-3.8-flash" });
    expect(await syncAgent(syncClient, def)).toBe("created");
  });

  test("completes GitHub OAuth + PKCE callback flow cleanly", async () => {
    const mockFetch: typeof fetch = (async (input: Request | URL | string) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "gho_pkce_token_abc" }), { status: 200 });
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ id: 77, login: "pkce-dev", name: "PKCE Dev" }), { status: 200 });
      }
      if (url === "https://api.github.com/user/emails") {
        return new Response(JSON.stringify([{ email: "pkce@example.com", primary: true, verified: true }]), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ id: "cred", status: "ACTIVE" }), { status: 200 });
    }) as unknown as typeof fetch;

    const { baseUrl } = await startTestServer(
      "solution",
      { GITHUB_CLIENT_ID: "Iv1.testclient", GITHUB_CLIENT_SECRET: "secret123", GITHUB_TOKEN: undefined },
      mockFetch,
    );

    const startRes = await fetch(`${baseUrl}/auth/github`, { redirect: "manual" });
    expect(startRes.status).toBe(303);
    const location = new URL(startRes.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    const state = location.searchParams.get("state")!;
    const preCookie = cookiePair(startRes);

    const cbRes = await fetch(`${baseUrl}/auth/github/callback?code=test_auth_code&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: preCookie },
      redirect: "manual",
    });
    expect(cbRes.status).toBe(303);
    expect(cbRes.headers.get("location")).toBe("/");
    const authedCookie = cookiePair(cbRes);

    const meRes = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: authedCookie } });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { login: string; authMode: string };
    expect(me.login).toBe("pkce-dev");
    expect(me.authMode).toBe("oauth");
  });
});
