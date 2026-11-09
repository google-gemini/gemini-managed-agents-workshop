// Step 4 Starter Stub: `GET /api/vault`, `POST /api/chat`, and `POST /api/chat/reset`.
//
// In Workshop Step 4 (see http://localhost:3000/slides and `.agents/skills/gemini-managed-agents/SKILL.md`):
//   1. Flip `WORKSHOP_MODE` to `"configured"`, `MCP_ENABLED` to `true`, and `CHAT_ALLOWLIST` to `TURN_ALLOWLIST_DOMAINS`.
//   2. Implement `GET /api/vault` (`router.get("/vault", ...)`) calling `gemini.listCredentials()` to return
//      sanitized credential metadata plus active agent, mounted skills, MCP, allowlist, and sandbox environment status.
//   3. Implement `POST /api/chat` (`router.post("/chat", ...)`) calling `gemini.streamInteraction(...)`
//      (or `new GoogleGenAI().interactions.create({ ..., stream: true })`) targeting `agent: cfg.agentId` (`"pr-reviewer"`),
//      attaching `req.session.credentialId` to `environment.network.allowlist` and the `github` `mcp_server` tool
//      (`https://api.githubcopilot.com/mcp/`), and piping frames through `new AgentStreamMapper()` (`./agentStream.ts`).

import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { buildAgentDefinition, DEFAULT_AGENT_DIR, inspectAgentFiles } from "./agentDefinition.ts";
import type { AppConfig } from "./config.ts";
import type { GeminiClient } from "./gemini.ts";
import { describeError, log } from "./log.ts";
import { chatLimiter } from "./security.ts";
import type { AgentSyncStatus, ChatState, StoredMessage, StoredStep, WorkshopMode } from "./types.ts";

export const WORKSHOP_MODE: WorkshopMode = "starter";
export const MCP_ENABLED = false;
export const CHAT_ALLOWLIST: readonly string[] = [];

const MAX_MESSAGE_CHARS = 4000;

function parseMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).message;
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/\r\n?/g, "\n").trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_MESSAGE_CHARS ? trimmed : null;
}

export interface CreateChatRouterOptions {
  cfg: AppConfig;
  gemini: GeminiClient;
  agentDir?: string;
  agentStatus?: AgentSyncStatus;
}

export function createChatRouter({
  cfg,
  gemini,
  agentDir = DEFAULT_AGENT_DIR,
  agentStatus = { synced: false, hash: null, skillFiles: [] },
}: CreateChatRouterOptions): Router {
  const router = Router();

  router.get("/vault", async (req: Request, res: Response) => {
    const inspected = await inspectAgentFiles(agentDir);
    let hash = agentStatus.hash;
    if (inspected.hasAgentsMd) {
      try {
        hash = (await buildAgentDefinition(cfg, agentDir)).hash;
      } catch {
        // ignore if agent bundle exceeds size limit
      }
    }

    // Step 4 TODO: query `await gemini.listCredentials()` and return sanitized vault rows.
    res.json({
      agentId: cfg.agentId,
      agentSynced: agentStatus.synced,
      agentHash: hash,
      skillFiles: inspected.files,
      agentModel: cfg.agentModel,
      mcpEnabled: MCP_ENABLED,
      allowlist: [...CHAT_ALLOWLIST],
      sessionCredentialId: req.session?.credentialId ?? null,
      sessionEnvironmentId: req.session?.chat?.environmentId ?? null,
      credentials: [],
    });
  });

  router.post("/chat", chatLimiter, async (req: Request, res: Response) => {
    const message = parseMessage(req.body);
    if (!message) return res.status(400).json({ error: "invalid_request" });
    if (!req.session.user || !req.session.credentialId) return res.status(401).json({ error: "unauthenticated" });

    const chat: ChatState = (req.session.chat ??= { messages: [] });
    chat.messages.push({ id: randomUUID(), role: "user", text: message, createdAt: Date.now() });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const starterStep: StoredStep = {
      id: "t0",
      kind: "thought",
      label: "Starter server ready — wire Steps 1–4 to connect Gemini Managed Agents",
      state: "done",
    };

    const guide = [
      "### Starter Server Connected",
      "",
      `Received your prompt: "${message.slice(0, 120)}${message.length > 120 ? "…" : ""}"`,
      "",
      "You are running in **starter mode**. Open [`/slides`](/slides) and pair with your coding agent (Antigravity, Claude Code, Cursor, Gemini CLI, or Codex) to build the 4 workshop steps:",
      "",
      "1. **Step 1 — First Managed Agent**: Create `pr-reviewer-basic` on `antigravity-preview-09-2026` and stream a PR inspection on `google/budoux`.",
      "2. **Step 2 — Custom Agent + Skill**: Create `agent/AGENTS.md` + `agent/skills/pr-review/SKILL.md` and register saved agent `pr-reviewer` via `bun run agent:sync`.",
      "3. **Step 3 — Credentials Vault + Remote MCP**: Store `GITHUB_TOKEN` in the write-only vault (`credentials.create`) and attach it to `network.allowlist` + `https://api.githubcopilot.com/mcp/`.",
      "4. **Step 4 — Wire the Web App**: Complete `server/auth.ts` and `server/chat.ts` (`GET /api/vault` + `POST /api/chat`) using `GeminiClient` and `AgentStreamMapper`.",
    ].join("\n");

    send("status", { text: "Starter mode" });
    send("step", { step: starterStep });
    send("text", { delta: guide });

    const assistantMsg: StoredMessage = {
      id: randomUUID(),
      role: "assistant",
      text: guide,
      createdAt: Date.now(),
      status: "completed",
      steps: [starterStep],
    };
    chat.messages.push(assistantMsg);

    send("done", { status: "completed" });
    res.end();
  });

  router.post("/chat/reset", (req: Request, res: Response) => {
    const environmentId = req.session.chat?.environmentId;
    req.session.chat = { messages: [] };
    if (environmentId) {
      gemini.deleteEnvironment(environmentId).catch((err) => log.warn("sandbox delete failed", { error: describeError(err) }));
    }
    res.status(204).end();
  });

  return router;
}
