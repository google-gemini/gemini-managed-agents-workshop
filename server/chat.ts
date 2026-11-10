// Starter chat & vault routes (`GET /api/vault`, `POST /api/chat`, `POST /api/chat/reset`).
// Wire `pr-reviewer`, Gemini Credential Vault status, and SSE streaming here in Step 4.

import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { AppConfig } from "./config.ts";
import { chatLimiter } from "./security.ts";
import type { ChatState, StoredMessage, StoredStep, WorkshopMode } from "./types.ts";

export const WORKSHOP_MODE: WorkshopMode = "starter";

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
}

export function createChatRouter({ cfg }: CreateChatRouterOptions): Router {
  const router = Router();

  router.get("/vault", (req: Request, res: Response) => {
    res.json({
      agentId: cfg.agentId,
      agentSynced: false,
      agentHash: null,
      skillFiles: [],
      agentModel: cfg.agentModel,
      mcpEnabled: false,
      allowlist: [],
      sessionCredentialId: req.session?.credentialId ?? null,
      sessionEnvironmentId: req.session?.chat?.environmentId ?? null,
      credentials: [],
    });
  });

  router.post("/chat", chatLimiter, (req: Request, res: Response) => {
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
      label: "Starter server ready — follow PROMPTS.md and /slides to build Steps 1–4",
      state: "done",
    };

    const guide = [
      "### Starter Server Connected",
      "",
      `Received your prompt: "${message.slice(0, 120)}${message.length > 120 ? "…" : ""}"`,
      "",
      "This server is running in starter mode. Open [`/slides`](/slides) and copy the prompts from `PROMPTS.md` into your coding agent to build and connect the `pr-reviewer` Gemini Managed Agent.",
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
    req.session.chat = { messages: [] };
    res.status(204).end();
  });

  return router;
}
