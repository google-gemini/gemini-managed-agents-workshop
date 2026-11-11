// Express application wiring for the Solution server (`solution/server/`).

import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import session, { type Store } from "express-session";
import { DEFAULT_AGENT_DIR } from "./agentDefinition.ts";
import { createAuth } from "./auth.ts";
import { createChatRouter, WORKSHOP_MODE } from "./chat.ts";
import { ABSOLUTE_TIMEOUT_MS, IDLE_TIMEOUT_MS, type AppConfig } from "./config.ts";
import type { GeminiClient } from "./gemini.ts";
import { cleanupRemoteResources } from "./janitor.ts";
import { describeError, log } from "./log.ts";
import {
  absoluteTimeout,
  apiLimiter,
  authLimiter,
  csrfProtection,
  generateCsrfToken,
  globalLimiter,
  hostGuard,
  maskEmail,
  methodAllowlist,
  noStore,
  requireAuth,
  securityHeaders,
  slidesCsp,
} from "./security.ts";
import type { AgentSyncStatus } from "./types.ts";
import { VoiceClipStore } from "./voiceStore.ts";

// solution/server/ sits two levels below repo root.
const DIST_DIR = fileURLToPath(new URL("../../dist/web/", import.meta.url));
const INDEX_HTML = path.join(DIST_DIR, "index.html");
const SLIDES_HTML = fileURLToPath(new URL("../../slides/index.html", import.meta.url));

export function sessionCookieName(cfg: AppConfig): string {
  // TODO(security): __Host- requires Secure + HTTPS. On plain-http localhost we use an unprefixed
  // HttpOnly, SameSite=Lax cookie; HTTPS deployments automatically switch to __Host-review.sid.
  return cfg.isHttps ? "__Host-review.sid" : "review.sid";
}

const requestLogger: RequestHandler = (req, res, next) => {
  const started = performance.now();
  const { method, path: requestPath } = req;
  res.on("finish", () => {
    log.info(`${method} ${requestPath}`, { status: res.statusCode, ms: Math.round(performance.now() - started) });
  });
  next();
};

export interface CreateAppOptions {
  cfg: AppConfig;
  gemini: GeminiClient;
  store: Store;
  agentDir?: string;
  agentStatus?: AgentSyncStatus;
  fetchImpl?: typeof fetch;
}

export function createApp({
  cfg,
  gemini,
  store,
  agentDir = DEFAULT_AGENT_DIR,
  agentStatus = { synced: false, hash: null, skillFiles: [] },
  fetchImpl,
}: CreateAppOptions) {
  const app = express();
  const cookieName = sessionCookieName(cfg);
  const voiceStore = new VoiceClipStore();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  // TODO(security): when deployed behind a TLS-terminating reverse proxy, match its hop count.
  if (cfg.isHttps) app.set("trust proxy", "loopback");

  app.use(requestLogger);
  app.use(hostGuard(cfg.baseUrl));
  app.use(methodAllowlist);
  app.use(securityHeaders(cfg.isHttps));
  app.use(globalLimiter);

  app.use(
    "/assets",
    express.static(path.join(DIST_DIR, "assets"), { index: false, immutable: true, maxAge: "1y", fallthrough: false }),
  );
  app.get("/favicon.svg", (_req, res, next) => {
    res.sendFile(path.join(DIST_DIR, "favicon.svg"), { maxAge: "1d" }, (err) => (err ? next() : undefined));
  });
  app.get("/favicon.ico", (_req, res) => {
    res.redirect(302, "/favicon.svg");
  });

  // Serve self-contained workshop presentation deck at /slides and /workshop with route-scoped CSP.
  const serveSlides: RequestHandler = (_req, res) => {
    res.sendFile(SLIDES_HTML, { cacheControl: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) {
        res
          .status(503)
          .type("text/plain")
          .send("Workshop slides (slides/index.html) are not built yet. Refresh in a moment.");
      }
    });
  };
  app.get("/slides", noStore, slidesCsp, serveSlides);
  app.get("/workshop", noStore, slidesCsp, serveSlides);

  app.use(
    session({
      name: cookieName,
      secret: cfg.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      unset: "destroy",
      cookie: { httpOnly: true, sameSite: "lax", secure: cfg.isHttps, maxAge: IDLE_TIMEOUT_MS, path: "/" },
    }),
  );
  app.use(
    absoluteTimeout(ABSOLUTE_TIMEOUT_MS, (resources, expiredSid) => {
      if (expiredSid) voiceStore.clearSession(expiredSid);
      void cleanupRemoteResources(gemini, resources);
    }),
  );

  const serveSpa: RequestHandler = (_req, res) => {
    res.sendFile(INDEX_HTML, { cacheControl: false, lastModified: false }, (err) => {
      if (err && !res.headersSent) {
        res.status(503).type("text/plain").send("Web UI is still building (dist/web/index.html). Run: bun run build");
      }
    });
  };
  app.get("/", noStore, serveSpa);

  const auth = createAuth({ cfg, gemini, cookieName, voiceStore, ...(fetchImpl ? { fetchImpl } : {}) });
  app.use("/auth", noStore, authLimiter, auth.router);

  const api = Router();

  api.get("/me", (req, res) => {
    const user = req.session?.user;
    const credentialId = req.session?.credentialId;
    if (!user || !credentialId) {
      res.status(401).json({
        error: "unauthenticated",
        workshopMode: WORKSHOP_MODE,
        hasGithubOAuth: Boolean(cfg.githubClientId && cfg.githubClientSecret),
        hasGithubPat: Boolean(cfg.githubToken),
      });
      return;
    }

    res.json({
      email: maskEmail(user.email),
      name: user.name,
      givenName: user.givenName,
      login: user.login,
      picture: user.picture,
      provider: "github",
      authMode: user.authMode,
      csrfToken: generateCsrfToken(req),
      messages: req.session.chat?.messages ?? [],
      workshopMode: WORKSHOP_MODE,
    });
  });

  api.get("/workshop/comments", (_req, res) => {
    res.json({ comments: [] });
  });

  api.post("/auth/logout", auth.logout);
  api.use(requireAuth);

  api.use(createChatRouter({ cfg, gemini, agentDir, agentStatus, voiceStore }));

  app.use(
    "/api",
    noStore,
    apiLimiter,
    express.json({ limit: "16kb", strict: true, type: "application/json" }),
    csrfProtection,
    api,
  );

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const e = err as { status?: unknown; statusCode?: unknown; code?: unknown };
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
    if (e.code === "EBADCSRFTOKEN") {
      log.warn("csrf token rejected", { path: req.path });
    } else if (status >= 500) {
      log.error("unhandled error", { path: req.path, error: describeError(err) });
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    const code =
      e.code === "EBADCSRFTOKEN"
        ? "csrf"
        : status === 404
          ? "not_found"
          : status === 413
            ? "too_large"
            : status < 500
              ? "bad_request"
              : "internal";
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: code });
  };
  app.use(errorHandler);

  return app;
}
