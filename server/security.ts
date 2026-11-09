// HTTP hardening: headers/CSP, method allowlist, host guard, rate limits, CSRF, auth guards.

import type { RequestHandler } from "express";
import helmet from "helmet";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { csrfSync } from "csrf-sync";
import { isLoopbackHostname } from "./config.ts";
import type { RemoteResources } from "./types.ts";

export function securityHeaders(isHttps: boolean): RequestHandler[] {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    // TODO(security): Vite CSS bundles load from 'self'; style-src allows React style={{...}} attributes while keeping script-src strictly 'self'.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "https://avatars.githubusercontent.com"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-src": ["'none'"],
    "frame-ancestors": ["'none'"],
  };
  if (isHttps) directives["upgrade-insecure-requests"] = [];

  return [
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives },
      strictTransportSecurity: isHttps ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      xFrameOptions: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
      crossOriginOpenerPolicy: { policy: "same-origin" },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
    (_req, res, next) => {
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()",
      );
      next();
    },
  ];
}

/**
 * Route-scoped CSP for /slides and /workshop ONLY.
 * TODO(security): slides/index.html is a static, self-contained offline deck whose slide engine
 * evaluates embedded slide builders and base64 data-URI fonts. All React app (/) and /api/* routes
 * keep strict script-src 'self'.
 */
export const slidesCsp: RequestHandler = (_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data: https://avatars.githubusercontent.com",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
  );
  next();
};

const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

/** Rejects TRACE, PUT, DELETE, OPTIONS, PATCH (same-origin SPA only). */
export const methodAllowlist: RequestHandler = (req, res, next) => {
  if (ALLOWED_METHODS.has(req.method)) return next();
  res.setHeader("Allow", "GET, HEAD, POST");
  res.status(405).end();
};

/**
 * Only serve the configured origin's Host (mitigates DNS rebinding). Loopback aliases
 * (127.0.0.1 vs localhost) redirect on GET/HEAD so session cookies and OAuth callbacks match.
 * TODO(security): behind a reverse proxy, ensure it preserves the validated Host header.
 */
export function hostGuard(baseUrl: string): RequestHandler {
  const expected = new URL(baseUrl);
  return (req, res, next) => {
    const host = req.headers.host ?? "";
    if (host === expected.host) return next();
    if ((req.method === "GET" || req.method === "HEAD") && isLoopbackHostname(expected.hostname)) {
      try {
        const actual = new URL(`http://${host}`);
        if (isLoopbackHostname(actual.hostname) && actual.port === expected.port) {
          return res.redirect(307, expected.origin + req.originalUrl);
        }
      } catch {
        // fall through to 421
      }
    }
    res.status(421).type("text/plain").send("Misdirected request");
  };
}

export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 60,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

export const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => (req.session?.user?.sub ? `user:${req.session.user.sub}` : ipKeyGenerator(req.ip ?? "127.0.0.1")),
  message: { error: "rate_limited" },
});

const csrf = csrfSync({
  getTokenFromRequest: (req) => {
    const value = req.headers["x-csrf-token"];
    return typeof value === "string" ? value : undefined;
  },
  errorConfig: { statusCode: 403, message: "Invalid CSRF token", code: "EBADCSRFTOKEN" },
});
export const csrfProtection = csrf.csrfSynchronisedProtection;
export const generateCsrfToken = csrf.generateToken;

export const requireAuth: RequestHandler = (req, res, next) => {
  if (req.session?.user && req.session.credentialId) return next();
  res.status(401).json({ error: "unauthenticated" });
};

export function absoluteTimeout(maxAgeMs: number, onExpire: (resources: RemoteResources) => void): RequestHandler {
  return (req, _res, next) => {
    const createdAt = req.session?.createdAt;
    if (!req.session?.user || typeof createdAt !== "number" || Date.now() - createdAt <= maxAgeMs) return next();
    const resources: RemoteResources = {
      credentialId: req.session.credentialId,
      environmentId: req.session.chat?.environmentId,
    };
    req.session.regenerate((err) => {
      if (err) return next(err);
      onExpire(resources);
      next();
    });
  };
}

/** Masks email PII for UI display ("jane.doe@example.com" -> "ja•••••@example.com"). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  const hidden = Math.min(6, Math.max(3, local.length - visible.length));
  return `${visible}${"•".repeat(hidden)}${email.slice(at)}`;
}
