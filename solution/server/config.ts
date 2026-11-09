import { randomBytes } from "node:crypto";

export const AGENT_ID = "pr-reviewer";
export const BASE_AGENT = "antigravity-preview-09-2026";
/** Only per-session credentials with this prefix are created or swept by the janitor. */
export const CREDENTIAL_PREFIX = "review-s-";

export const GITHUB_CLONE_HOST = "github.com";
export const GITHUB_RAW_HOST = "*.githubusercontent.com";
export const GITHUB_API_HOST = "api.github.com";
export const GITHUB_MCP_HOST = "api.githubcopilot.com";
export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

export const TURN_ALLOWLIST_DOMAINS = [
  GITHUB_CLONE_HOST,
  GITHUB_RAW_HOST,
  GITHUB_API_HOST,
  GITHUB_MCP_HOST,
] as const;

export const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface GeminiConfig {
  geminiApiKey: string;
  agentId: string;
  agentModel: string;
}

export interface AppConfig extends GeminiConfig {
  host: string;
  port: number;
  baseUrl: string;
  isHttps: boolean;
  githubRedirectUri: string;
  githubClientId?: string | undefined;
  githubClientSecret?: string | undefined;
  githubToken?: string | undefined;
  sessionSecret: string;
  allowedEmails: ReadonlySet<string> | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function readEnv(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = source[name]?.trim();
  return value ? value : undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function parseAgentModel(source: Record<string, string | undefined>): string {
  const agentModel = readEnv(source, "GEMINI_AGENT_MODEL") ?? "gemini-3.8-flash";
  if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(agentModel)) {
    throw new ConfigError("GEMINI_AGENT_MODEL has an invalid format.");
  }
  return agentModel;
}

/** Strict loader for CLI scripts (`bun run agent:sync`, `bun run solution:sync`) that require GEMINI_API_KEY. */
export function loadGeminiConfig(envSource: Record<string, string | undefined> = process.env): GeminiConfig {
  const geminiApiKey = readEnv(envSource, "GEMINI_API_KEY");
  if (!geminiApiKey) {
    throw new ConfigError("GEMINI_API_KEY is not set. Add your Gemini API key to .env (see .env.example).");
  }
  return { geminiApiKey, agentId: AGENT_ID, agentModel: parseAgentModel(envSource) };
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function parseHost(raw: string): string {
  if (raw !== "127.0.0.1" && raw !== "localhost") {
    throw new ConfigError("HOST must be 127.0.0.1 or localhost. Binding to 0.0.0.0 or public interfaces is forbidden.");
  }
  return raw;
}

/**
 * Secret resolution: SESSION_SECRET env -> (loopback only) ephemeral random 32-byte value.
 * Never uses a hardcoded literal fallback.
 */
function resolveSessionSecret(source: Record<string, string | undefined>, isLocal: boolean): string {
  const fromEnv = readEnv(source, "SESSION_SECRET");
  if (fromEnv) {
    if (fromEnv.length < 32) throw new ConfigError("SESSION_SECRET must be at least 32 characters long.");
    return fromEnv;
  }
  if (!isLocal) throw new ConfigError("SESSION_SECRET is required when APP_BASE_URL is not a localhost URL.");
  console.warn(
    "[config] WARNING: SESSION_SECRET is not set; generated an ephemeral random secret (instance-isolated).",
  );
  return randomBytes(32).toString("hex");
}

export function loadConfig(envSource: Record<string, string | undefined> = process.env): AppConfig {
  const geminiApiKey = readEnv(envSource, "GEMINI_API_KEY") ?? "";
  const agentModel = parseAgentModel(envSource);
  const host = parseHost(readEnv(envSource, "HOST") ?? "127.0.0.1");
  const port = parsePort(readEnv(envSource, "PORT") ?? "3000");

  let base: URL;
  try {
    base = new URL(readEnv(envSource, "APP_BASE_URL") ?? `http://localhost:${port}`);
  } catch {
    throw new ConfigError("APP_BASE_URL is not a valid URL.");
  }
  const isHttps = base.protocol === "https:";
  const isLocalHttp = base.protocol === "http:" && isLoopbackHostname(base.hostname);
  if (!isHttps && !isLocalHttp) {
    throw new ConfigError("APP_BASE_URL must use https, or plain http only on localhost / 127.0.0.1.");
  }

  const githubClientId = readEnv(envSource, "GITHUB_CLIENT_ID");
  const githubClientSecret = readEnv(envSource, "GITHUB_CLIENT_SECRET");
  if ((githubClientId && !githubClientSecret) || (!githubClientId && githubClientSecret)) {
    throw new ConfigError("Both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set together.");
  }
  const githubToken = readEnv(envSource, "GITHUB_TOKEN");

  // TODO(security): Optional MFA / organization-membership checks can be enforced at GitHub OAuth org level.
  const allowed = (readEnv(envSource, "ALLOWED_EMAILS") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  return {
    geminiApiKey,
    agentId: AGENT_ID,
    agentModel,
    host,
    port,
    baseUrl: base.origin,
    isHttps,
    githubRedirectUri: `${base.origin}/auth/github/callback`,
    githubClientId,
    githubClientSecret,
    githubToken,
    sessionSecret: resolveSessionSecret(envSource, isLocalHttp),
    allowedEmails: allowed.length > 0 ? new Set(allowed) : null,
  };
}
