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

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import session from "express-session";
import createMemoryStore from "memorystore";

import { createApp } from "../server/app.ts";
import { ConfigError, loadConfig } from "../server/config.ts";

const activeServers: Array<{ server: Server; stopStore: () => void }> = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const entry = activeServers.pop()!;
    entry.stopStore();
    await new Promise<void>((resolve) => entry.server.close(() => resolve()));
  }
});

async function startTestServer(envOverrides: Record<string, string | undefined> = {}) {
  const MemoryStore = createMemoryStore(session);
  const store = new MemoryStore({ checkPeriod: 60_000 });
  const baseEnv: Record<string, string | undefined> = {
    HOST: "127.0.0.1",
    PORT: "3000",
    SESSION_SECRET: "a".repeat(64),
    GEMINI_API_KEY: "test-gemini-key",
    ...envOverrides,
  };

  const probeCfg = loadConfig(baseEnv);
  const probeApp = createApp({ cfg: probeCfg, store });
  const probe = await new Promise<Server>((resolve) => {
    const s = probeApp.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const boundCfg = loadConfig({
    ...baseEnv,
    PORT: String(port),
    APP_BASE_URL: `http://127.0.0.1:${port}`,
  });
  const app = createApp({ cfg: boundCfg, store });
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
    expect(cfg.agentModel).toBe("gemini-4-carbon");

    expect(() => loadConfig({ HOST: "0.0.0.0", SESSION_SECRET: "s".repeat(48) })).toThrow(ConfigError);
    expect(() => loadConfig({ APP_BASE_URL: "http://example.com:3000", SESSION_SECRET: "s".repeat(48) })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ SESSION_SECRET: "too-short" })).toThrow(ConfigError);
  });
});

describe("Starter Server Contract & Security Hardening", () => {
  test("serves unauthenticated /api/me metadata, strict CSP on /, and route-scoped CSP on /slides", async () => {
    const { baseUrl } = await startTestServer({
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

  test("enforces CSRF on POST endpoints and serves starter /api/vault, /api/chat SSE, and logout", async () => {
    const { baseUrl } = await startTestServer();

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

    const vaultRes = await fetch(`${baseUrl}/api/vault`, { headers: { Cookie: cookie } });
    expect(vaultRes.status).toBe(200);
    const vault = (await vaultRes.json()) as { agentId: string; agentSynced: boolean; credentials: unknown[] };
    expect(vault.agentId).toBe("pr-reviewer");
    expect(vault.agentSynced).toBe(false);
    expect(vault.credentials).toEqual([]);

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
    expect(sseText).toContain("PROMPTS.md");
    expect(sseText).toContain('event: done\ndata: {"status":"completed"}');

    const resetRes = await fetch(`${baseUrl}/api/chat/reset`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-csrf-token": me.csrfToken,
      },
    });
    expect(resetRes.status).toBe(204);

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "x-csrf-token": me.csrfToken,
      },
    });
    expect(logoutRes.status).toBe(204);
  });
});
