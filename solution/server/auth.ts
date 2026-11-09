// GitHub sign-in (OAuth 2.0 + PKCE S256, with instant GITHUB_TOKEN PAT fallback) and sign-out.
// Raw GitHub tokens are stored immediately in the write-only Gemini Credential Vault (`review-s-<hex>`)
// and are never persisted in session state, logged, or returned to the browser.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { CREDENTIAL_PREFIX, type AppConfig } from "./config.ts";
import type { GeminiClient } from "./gemini.ts";
import { cleanupRemoteResources } from "./janitor.ts";
import { describeError, log } from "./log.ts";
import type { AuthMode, RemoteResources, SessionUser } from "./types.ts";

const GITHUB_AUTH_ENDPOINT = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API = "https://api.github.com/user";
const GITHUB_SCOPES = ["read:user", "user:email", "repo"];
const OAUTH_TTL_MS = 10 * 60_000;

type AuthErrorCode = "denied" | "failed" | "expired" | "not_allowed" | "vault" | "github_unconfigured" | "gemini_unconfigured";

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f<>[\]]/g, "").trim().slice(0, 80);
}

function safePicture(value: unknown): string | null {
  if (typeof value !== "string" || value.length >= 500) return null;
  if (/^https:\/\/avatars\.githubusercontent\.com\/u\/[0-9]+(?:\?[A-Za-z0-9_=&-]+)?$/.test(value)) return value;
  return null;
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function save(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

interface GitHubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

interface GitHubEmailResponse {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

async function fetchGitHubProfile(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<{ sub: string; login: string; email: string; name: string; picture: string | null }> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Gemini-Managed-Agents-Workshop",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const userRes = await fetchImpl(GITHUB_USER_API, { headers, signal: AbortSignal.timeout(15_000) });
  if (!userRes.ok) throw new Error(`GitHub user API returned ${userRes.status}`);
  const profile = (await userRes.json()) as GitHubUserResponse;
  const login = typeof profile.login === "string" ? profile.login.trim() : "";
  if (!profile.id || !login) throw new Error("Invalid GitHub user payload");

  let email = typeof profile.email === "string" && profile.email.includes("@") ? profile.email.toLowerCase() : "";
  if (!email) {
    try {
      const emailsRes = await fetchImpl(`${GITHUB_USER_API}/emails`, { headers, signal: AbortSignal.timeout(10_000) });
      if (emailsRes.ok) {
        const list = (await emailsRes.json()) as GitHubEmailResponse[];
        const primary = Array.isArray(list)
          ? (list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified))
          : undefined;
        if (typeof primary?.email === "string") email = primary.email.toLowerCase();
      }
    } catch {
      // Fine-grained PATs without email permission fall back cleanly to noreply below.
    }
  }
  if (!email) email = `${login.toLowerCase()}@users.noreply.github.com`;

  const name = cleanName(profile.name) || login;
  return {
    sub: `gh:${profile.id}`,
    login,
    email,
    name,
    picture: safePicture(profile.avatar_url),
  };
}

export interface AuthDeps {
  cfg: AppConfig;
  gemini: GeminiClient;
  cookieName: string;
  fetchImpl?: typeof fetch;
}

export function createAuth({ cfg, gemini, cookieName, fetchImpl = fetch }: AuthDeps): {
  router: Router;
  logout: RequestHandler;
} {
  const router = Router();
  const fail = (res: Response, code: AuthErrorCode) => res.redirect(303, `/?auth_error=${code}`);

  async function completeVaultSignIn(
    req: Request,
    res: Response,
    token: string,
    authMode: AuthMode,
  ): Promise<void> {
    if (!gemini.isConfigured) {
      fail(res, "gemini_unconfigured");
      return;
    }

    let gh: Awaited<ReturnType<typeof fetchGitHubProfile>>;
    try {
      gh = await fetchGitHubProfile(token, fetchImpl);
    } catch (err) {
      log.warn("github profile verification failed", { error: describeError(err) });
      fail(res, "failed");
      return;
    }

    if (cfg.allowedEmails && !cfg.allowedEmails.has(gh.email) && !cfg.allowedEmails.has(gh.login.toLowerCase())) {
      log.warn("github sign-in rejected: account not in ALLOWED_EMAILS");
      fail(res, "not_allowed");
      return;
    }

    const credentialId = CREDENTIAL_PREFIX + randomBytes(12).toString("hex");
    try {
      await gemini.createBearerCredential({ id: credentialId, token });
    } catch (err) {
      log.error("could not store github credential in the Gemini vault", { error: describeError(err) });
      fail(res, "vault");
      return;
    }

    const previous: RemoteResources = {
      credentialId: req.session.credentialId,
      environmentId: req.session.chat?.environmentId,
    };
    const user: SessionUser = {
      provider: "github",
      authMode,
      sub: gh.sub,
      login: gh.login,
      email: gh.email,
      name: gh.name,
      givenName: gh.name.split(" ")[0] || gh.login,
      picture: gh.picture,
    };

    try {
      await regenerate(req);
      req.session.user = user;
      req.session.createdAt = Date.now();
      req.session.credentialId = credentialId;
      req.session.chat = { messages: [] };
      await save(req);
    } catch (err) {
      log.error("session setup failed", { error: describeError(err) });
      await gemini.deleteCredential(credentialId).catch(() => undefined);
      fail(res, "failed");
      return;
    }

    void cleanupRemoteResources(gemini, previous);
    log.info("user signed in", { provider: "github", authMode });
    res.redirect(303, "/");
  }

  router.get("/github", async (req, res, next) => {
    if (!gemini.isConfigured) return fail(res, "gemini_unconfigured");
    const forcePat = req.query.mode === "pat";

    if (!forcePat && cfg.githubClientId && cfg.githubClientSecret) {
      const state = randomToken();
      const codeVerifier = randomToken(48);
      const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
      req.session.oauth = { provider: "github", state, codeVerifier, createdAt: Date.now() };

      const params = new URLSearchParams({
        client_id: cfg.githubClientId,
        redirect_uri: cfg.githubRedirectUri,
        scope: GITHUB_SCOPES.join(" "),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      req.session.save((err) => {
        if (err) return next(err);
        res.redirect(303, `${GITHUB_AUTH_ENDPOINT}?${params.toString()}`);
      });
      return;
    }

    if (cfg.githubToken) {
      await completeVaultSignIn(req, res, cfg.githubToken, "pat");
      return;
    }

    fail(res, "github_unconfigured");
  });

  router.get("/github/callback", async (req, res) => {
    if (!cfg.githubClientId || !cfg.githubClientSecret) return fail(res, "github_unconfigured");
    const pending = req.session.oauth;
    delete req.session.oauth;
    const { code, state, error } = req.query as Record<string, unknown>;

    if (typeof error === "string") return fail(res, error === "access_denied" ? "denied" : "failed");
    if (
      !pending ||
      pending.provider !== "github" ||
      typeof code !== "string" ||
      typeof state !== "string" ||
      code.length > 2048
    ) {
      return fail(res, "failed");
    }
    if (Date.now() - pending.createdAt > OAUTH_TTL_MS) return fail(res, "expired");
    if (!safeEqual(state, pending.state)) return fail(res, "failed");

    let accessToken: string;
    try {
      const tokenRes = await fetchImpl(GITHUB_TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "Gemini-Managed-Agents-Workshop",
        },
        body: JSON.stringify({
          client_id: cfg.githubClientId,
          client_secret: cfg.githubClientSecret,
          code,
          redirect_uri: cfg.githubRedirectUri,
          code_verifier: pending.codeVerifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!tokenRes.ok) throw new Error(`GitHub token endpoint returned ${tokenRes.status}`);
      const tokenBody = (await tokenRes.json()) as { access_token?: unknown; error?: unknown };
      if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) {
        throw new Error(typeof tokenBody.error === "string" ? tokenBody.error : "missing access_token");
      }
      accessToken = tokenBody.access_token;
    } catch (err) {
      log.warn("github oauth code exchange failed", { error: describeError(err) });
      return fail(res, "failed");
    }

    await completeVaultSignIn(req, res, accessToken, "oauth");
  });

  const logout: RequestHandler = async (req, res) => {
    const resources: RemoteResources = {
      credentialId: req.session?.credentialId,
      environmentId: req.session?.chat?.environmentId,
    };
    await new Promise<void>((resolve) => (req.session ? req.session.destroy(() => resolve()) : resolve()));
    res.clearCookie(cookieName, { path: "/", httpOnly: true, sameSite: "lax", secure: cfg.isHttps });
    // TODO(security): Deleting the vault credential immediately revokes sandbox/MCP access; users can
    // also revoke the OAuth grant in https://github.com/settings/applications.
    await cleanupRemoteResources(gemini, resources);
    res.status(204).end();
  };

  return { router, logout };
}
