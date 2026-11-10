// Starter authentication stub: signs into a local preview session so the web UI boots immediately.
// In Step 4, replace with GitHub OAuth 2.0 + PKCE -> Gemini Credential Vault (`credentials.create`).

import { Router, type Request, type RequestHandler } from "express";
import type { AppConfig } from "./config.ts";
import type { SessionUser } from "./types.ts";

export interface AuthDeps {
  cfg: AppConfig;
  cookieName: string;
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function save(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

export function createAuth({ cfg, cookieName }: AuthDeps): { router: Router; logout: RequestHandler } {
  const router = Router();

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
    await new Promise<void>((resolve) => (req.session ? req.session.destroy(() => resolve()) : resolve()));
    res.clearCookie(cookieName, { path: "/", httpOnly: true, sameSite: "lax", secure: cfg.isHttps });
    res.status(204).end();
  };

  return { router, logout };
}
