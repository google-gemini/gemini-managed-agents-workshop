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

// Chat endpoints: streams a Gemini Managed Agent PR-review turn to the browser as sanitized SSE.

import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { buildAgentDefinition, DEFAULT_AGENT_DIR, inspectAgentFiles } from "./agentDefinition.ts";
import { AgentStreamMapper, type ClientEvent } from "./agentStream.ts";
import {
  GITHUB_API_HOST,
  GITHUB_CLONE_HOST,
  GITHUB_MCP_HOST,
  GITHUB_MCP_URL,
  GITHUB_RAW_HOST,
  TURN_ALLOWLIST_DOMAINS,
  type AppConfig,
} from "./config.ts";
import { GeminiError, type GeminiClient } from "./gemini.ts";
import { describeError, log } from "./log.ts";
import { chatLimiter } from "./security.ts";
import type { AgentSyncStatus, ChatState, MessageStatus, SessionUser, StoredMessage, WorkshopMode } from "./types.ts";

export const WORKSHOP_MODE: WorkshopMode = "solution";
export const MCP_ENABLED = true;
export const CHAT_ALLOWLIST: readonly string[] = TURN_ALLOWLIST_DOMAINS;

const MAX_MESSAGE_CHARS = 4000;
const MAX_STORED_MESSAGES = 40;
const MAX_STORED_TEXT = 24_000;
const TURN_TIMEOUT_MS = 6 * 60_000;
const HEARTBEAT_MS = 15_000;

const ERROR_MESSAGES: Record<string, string> = {
  agent_unavailable:
    "Could not reach the Gemini Managed Agent (`pr-reviewer`). Check GEMINI_API_KEY and agent sync status.",
  agent_error: "The PR reviewer agent encountered an upstream error. Please try again.",
  timeout: "The review timed out after 6 minutes. Try targeting a single pull request.",
};

interface ChatInput {
  message: string;
  timeZone: string;
}

function validTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

function parseChatInput(body: unknown): ChatInput | null {
  if (!body || typeof body !== "object") return null;
  const { message, timeZone } = body as Record<string, unknown>;
  if (typeof message !== "string") return null;
  const text = message.replace(/\r\n?/g, "\n").trim();
  if (text.length < 1 || text.length > MAX_MESSAGE_CHARS) return null;
  return { message: text, timeZone: validTimeZone(timeZone) ?? "UTC" };
}

export function contextBlock(user: SessionUser, timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const offset = (parts.timeZoneName ?? "GMT").replace("GMT", "UTC");
  return [
    "[context]",
    `now: ${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${offset === "UTC" ? "UTC+00:00" : offset})`,
    `time_zone: ${timeZone}`,
    `github_user: @${user.login} (${user.name})`,
    "[/context]",
  ].join("\n");
}

export function buildInteraction(
  cfg: AppConfig,
  input: ChatInput,
  user: SessionUser,
  credentialId: string,
  chat: ChatState | null,
): Record<string, unknown> {
  const environment: Record<string, unknown> = {
    type: "remote",
    // Overrides base_environment.network for this turn, attaching the session's vault credential
    // on the egress proxy so the sandbox VM never sees the raw GitHub token.
    network: {
      allowlist: [
        { domain: GITHUB_CLONE_HOST, credential: credentialId },
        { domain: GITHUB_RAW_HOST },
        { domain: GITHUB_API_HOST, credential: credentialId },
        { domain: GITHUB_MCP_HOST, credential: credentialId },
      ],
    },
  };
  if (chat?.environmentId) environment.environment_id = chat.environmentId;

  const userText = input.message.replace(/\[\/?context\]/gi, "(context)");
  const body: Record<string, unknown> = {
    agent: cfg.agentId,
    input: [{ type: "text", text: `${contextBlock(user, input.timeZone)}\n\n${userText}` }],
    environment,
    tools: [
      { type: "code_execution" },
      { type: "google_search" },
      {
        type: "mcp_server",
        name: "github",
        url: GITHUB_MCP_URL,
        credential: credentialId,
      },
    ],
  };
  if (chat?.previousInteractionId) body.previous_interaction_id = chat.previousInteractionId;
  return body;
}

function pushMessage(chat: ChatState, message: StoredMessage): void {
  if (message.text.length > MAX_STORED_TEXT) message.text = `${message.text.slice(0, MAX_STORED_TEXT)}…`;
  chat.messages.push(message);
  if (chat.messages.length > MAX_STORED_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_STORED_MESSAGES);
}

function isStaleConversation(err: unknown): boolean {
  return err instanceof GeminiError && (err.status === 404 || err.status === 400);
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
  const inFlight = new Set<string>();

  router.get("/vault", async (req: Request, res: Response) => {
    try {
      const inspected = await inspectAgentFiles(agentDir);
      let hash = agentStatus.hash;
      if (inspected.hasAgentsMd) {
        try {
          const def = await buildAgentDefinition(cfg, agentDir);
          hash = def.hash;
        } catch {
          // keep previous hash if file exceeds limit
        }
      }

      let synced = agentStatus.synced;
      if (!synced && gemini.isConfigured && inspected.hasAgentsMd) {
        const remoteAgent = await gemini.getAgent(cfg.agentId).catch(() => null);
        if (remoteAgent) {
          synced = true;
          agentStatus.synced = true;
        }
      }

      const rawCreds = gemini.isConfigured ? (await gemini.listCredentials()).credentials : [];
      const visibleCreds = rawCreds
        .filter(
          (c) =>
            typeof c.id === "string" &&
            (c.id.startsWith("review-") || c.id.startsWith("workshop-") || c.id === req.session?.credentialId),
        )
        .slice(0, 25)
        .map((c) => ({
          id: c.id ?? "",
          type: c.type ?? "bearer_token",
          status: c.status ?? "ACTIVE",
          create_time: c.create_time ?? null,
          update_time: c.update_time ?? null,
          isCurrentSession: Boolean(req.session?.credentialId && c.id === req.session.credentialId),
        }));

      res.json({
        agentId: cfg.agentId,
        agentSynced: synced,
        agentHash: hash,
        skillFiles: inspected.files,
        agentModel: cfg.agentModel,
        mcpEnabled: MCP_ENABLED,
        allowlist: [...CHAT_ALLOWLIST],
        sessionCredentialId: req.session?.credentialId ?? null,
        sessionEnvironmentId: req.session?.chat?.environmentId ?? null,
        credentials: visibleCreds,
      });
    } catch (err) {
      log.warn("vault inspection failed", { error: describeError(err) });
      res.status(502).json({ error: "vault_unavailable" });
    }
  });

  router.post("/chat", chatLimiter, async (req: Request, res: Response) => {
    const input = parseChatInput(req.body);
    if (!input) return res.status(400).json({ error: "invalid_request" });
    const user = req.session.user;
    const credentialId = req.session.credentialId;
    if (!user || !credentialId) return res.status(401).json({ error: "unauthenticated" });

    const sid = req.sessionID;
    if (inFlight.has(sid)) return res.status(409).json({ error: "busy" });
    inFlight.add(sid);

    const chat: ChatState = (req.session.chat ??= { messages: [] });
    pushMessage(chat, { id: randomUUID(), role: "user", text: input.message, createdAt: Date.now() });

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const forward = (ev: ClientEvent) => {
      if (ev.type === "status") send("status", { text: ev.text });
      else if (ev.type === "step") send("step", { step: ev.step });
      else if (ev.type === "stepdone") send("stepdone", { id: ev.id, ok: ev.ok });
      else send("text", { delta: ev.delta });
    };

    const controller = new AbortController();
    let clientGone = false;
    let timedOut = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, HEARTBEAT_MS);
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TURN_TIMEOUT_MS);

    let mapper = new AgentStreamMapper();
    let outcome: MessageStatus = "error";
    let errorCode: string | undefined;

    const runTurn = async (conversation: ChatState | null) => {
      mapper = new AgentStreamMapper();
      const stream = await gemini.streamInteraction(
        buildInteraction(cfg, input, user, credentialId, conversation),
        controller.signal,
      );
      for await (const message of stream) {
        for (const ev of mapper.handle(message)) forward(ev);
      }
    };

    try {
      try {
        await runTurn(chat);
      } catch (err) {
        const hadState = Boolean(chat.environmentId || chat.previousInteractionId);
        if (hadState && !mapper.interactionId && !controller.signal.aborted && isStaleConversation(err)) {
          log.warn("conversation state rejected upstream; starting fresh sandbox", { error: describeError(err) });
          delete chat.environmentId;
          delete chat.previousInteractionId;
          send("status", { text: "Starting a fresh sandbox" });
          await runTurn(null);
        } else {
          throw err;
        }
      }
      if (mapper.upstreamError) {
        log.warn("agent reported an error", { code: mapper.upstreamError.code, message: mapper.upstreamError.message });
        outcome = "error";
        errorCode = "agent_error";
      } else if (mapper.finalStatus === "completed" || (!mapper.finalStatus && mapper.text)) {
        outcome = "completed";
      } else {
        outcome = mapper.finalStatus === "failed" ? "error" : "incomplete";
        if (outcome === "error") errorCode = "agent_error";
      }
    } catch (err) {
      if (controller.signal.aborted) {
        outcome = clientGone ? "stopped" : "error";
        if (timedOut) errorCode = "timeout";
        if (mapper.interactionId) {
          gemini.cancelInteraction(mapper.interactionId).catch(() => undefined);
        }
      } else {
        log.error("chat turn failed", { error: describeError(err) });
        outcome = "error";
        errorCode = "agent_unavailable";
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      mapper.settleSteps();
      if (mapper.environmentId) chat.environmentId = mapper.environmentId;
      if (outcome === "completed" && mapper.interactionId) chat.previousInteractionId = mapper.interactionId;
      const errorMessage = outcome === "error" ? ERROR_MESSAGES[errorCode ?? "agent_error"] : undefined;
      pushMessage(chat, {
        id: randomUUID(),
        role: "assistant",
        text: mapper.text,
        createdAt: Date.now(),
        status: outcome,
        ...(errorMessage ? { error: errorMessage } : {}),
        steps: mapper.steps.slice(-40),
      });
      if (errorMessage) send("error", { code: errorCode ?? "agent_error", message: errorMessage });
      send("done", {
        status: outcome,
        ...(chat.environmentId ? { environmentId: chat.environmentId } : {}),
      });
      inFlight.delete(sid);
      res.end();
    }
  });

  router.post("/chat/reset", (req: Request, res: Response) => {
    if (inFlight.has(req.sessionID)) return res.status(409).json({ error: "busy" });
    const environmentId = req.session.chat?.environmentId;
    req.session.chat = { messages: [] };
    if (environmentId) {
      gemini.deleteEnvironment(environmentId).catch((err) => log.warn("sandbox delete failed", { error: describeError(err) }));
    }
    res.status(204).end();
  });

  return router;
}
