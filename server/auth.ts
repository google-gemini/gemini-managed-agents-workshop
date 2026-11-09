// Step 4 Starter Stub: GitHub authentication -> write-only Gemini Credential Vault (`review-s-<hex>`).
//
// Currently signs you into a local starter preview session so the web UI boots immediately.
// In Workshop Step 4 (see http://localhost:3000/slides and `.agents/skills/gemini-managed-agents/SKILL.md`),
// replace the preview stub in `GET /github` and `GET /github/callback` so that:
//   1. GitHub OAuth + PKCE (when `cfg.githubClientId` & `cfg.githubClientSecret` are set) OR `cfg.githubToken`
//      verifies the user's profile via `https://api.github.com/user`.
//   2. The raw GitHub token is immediately written into the Gemini Credential Vault via
//      `await gemini.createBearerCredential({ id: CREDENTIAL_PREFIX + randomBytes(12).toString("hex"), token })`.
//   3. ONLY the opaque `credentialId` is stored in `req.session.credentialId` (never store or return the raw token!).

import { Router, type Request, type RequestHandler } from "express";
import type { AppConfig } from "./config.ts";
import type { GeminiClient } from "./gemini.ts";
import { cleanupRemoteResources } from "./janitor.ts";
import type { RemoteResources, SessionUser } from "./types.ts";

export interface AuthDeps {
  cfg: AppConfig;
  gemini: GeminiClient;
  cookieName: string;
  fetchImpl?: typeof fetch;
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function save(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

export function createAuth({ cfg, gemini, cookieName }: AuthDeps): { router: Router; logout: RequestHandler } {
  const router = Router();

  // TODO(workshop-step-4): Replace starter preview sign-in with GitHub OAuth + PKCE / GITHUB_TOKEN ->
  // `gemini.createBearerCredential({ id: credentialId, token })` so the egress proxy can authenticate
  // GitHub MCP and `git fetch` without exposing tokens to the sandbox or browser.
  router.get("/github", async (req, res, next) => {
    try {
      const user: SessionUser = {
        provider: "github",
        authMode: "pat",
        sub: "gh:starter-preview",
        login: "workshop-builder",
        email: "builder@users.noreply.github.com",
        name: "Workshop Builder",
        givenName: "Builder",
        picture: null,
      };
      await regenerate(req);
      req.session.user = user;
      req.session.createdAt = Date.now();
      req.session.credentialId = "starter-preview-not-in-vault";
      req.session.chat = { messages: [] };
      await save(req);
      res.redirect(303, "/");
    } catch (err) {
      next(err);
    }
  });

  router.get("/github/callback", (_req, res) => {
    res.redirect(303, "/?auth_error=github_unconfigured");
  });

  const logout: RequestHandler = async (req, res) => {
    const resources: RemoteResources = {
      credentialId: req.session?.credentialId,
      environmentId: req.session?.chat?.environmentId,
    };
    await new Promise<void>((resolve) => (req.session ? req.session.destroy(() => resolve()) : resolve()));
    res.clearCookie(cookieName, { path: "/", httpOnly: true, sameSite: "lax", secure: cfg.isHttps });
    await cleanupRemoteResources(gemini, resources);
    res.status(204).end();
  };

  return { router, logout };
}
