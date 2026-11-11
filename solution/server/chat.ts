// Chat endpoints: streams text & voice-note turns to the Gemini Managed Agent (`pr-reviewer`) over SSE.

import { randomBytes, randomUUID } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import { buildAgentDefinition, DEFAULT_AGENT_DIR, inspectAgentFiles, syncAgent } from "./agentDefinition.ts";
import { AgentStreamMapper, type ClientEvent } from "./agentStream.ts";
import {
  GEMINI_API_HOST,
  GEMINI_CREDENTIAL_PREFIX,
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
import { VoiceClipStore } from "./voiceStore.ts";

export const WORKSHOP_MODE: WorkshopMode = "solution";
export const MCP_ENABLED = true;
export const CHAT_ALLOWLIST: readonly string[] = TURN_ALLOWLIST_DOMAINS;

const MAX_MESSAGE_CHARS = 4000;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const MAX_STORED_MESSAGES = 40;
const MAX_STORED_TEXT = 24_000;
const TURN_TIMEOUT_MS = 6 * 60_000;
const HEARTBEAT_MS = 15_000;

const ALLOWED_VOICES = new Set(["Kore", "Puck", "Aoede", "Charon", "Fenrir"]);
const ALLOWED_AUDIO_MIMES: Record<string, { mimeType: string; ext: string }> = {
  "audio/webm": { mimeType: "audio/webm", ext: "webm" },
  "audio/mp4": { mimeType: "audio/mp4", ext: "m4a" },
  "audio/x-m4a": { mimeType: "audio/mp4", ext: "m4a" },
  "audio/ogg": { mimeType: "audio/ogg", ext: "ogg" },
  "audio/wav": { mimeType: "audio/wav", ext: "wav" },
  "audio/x-wav": { mimeType: "audio/wav", ext: "wav" },
  "audio/mpeg": { mimeType: "audio/mp3", ext: "mp3" },
  "audio/mp3": { mimeType: "audio/mp3", ext: "mp3" },
};

const ERROR_MESSAGES: Record<string, string> = {
  agent_unavailable:
    "Could not reach the Gemini Managed Agent (`pr-reviewer`). Check GEMINI_API_KEY and agent sync status.",
  agent_error: "The PR reviewer agent encountered an upstream error. Please try again.",
  timeout: "The review timed out after 6 minutes. Try targeting a single pull request.",
  voice_stage_failed: "Could not upload the voice note into the Managed Agent sandbox. Please try again.",
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

function parseAudioFormat(rawHeader: unknown): { mimeType: string; ext: string } | null {
  if (typeof rawHeader !== "string" || !rawHeader) return null;
  const base = rawHeader.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_AUDIO_MIMES[base] ?? null;
}

function parseVoiceName(rawHeader: unknown): string {
  if (typeof rawHeader !== "string") return "Kore";
  const trimmed = rawHeader.trim();
  return ALLOWED_VOICES.has(trimmed) ? trimmed : "Kore";
}

function parseDurationSec(rawHeader: unknown): number | undefined {
  if (typeof rawHeader !== "string") return undefined;
  const n = Number(rawHeader);
  return Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.round(n * 10) / 10 : undefined;
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

function buildAllowlist(credentialId: string, geminiCredentialId?: string): Array<Record<string, string>> {
  return [
    { domain: GITHUB_CLONE_HOST, credential: credentialId },
    { domain: GITHUB_RAW_HOST },
    { domain: GITHUB_API_HOST, credential: credentialId },
    { domain: GITHUB_MCP_HOST, credential: credentialId },
    {
      domain: GEMINI_API_HOST,
      ...(geminiCredentialId ? { credential: geminiCredentialId } : {}),
    },
  ];
}

export function buildInteraction(
  cfg: AppConfig,
  input: ChatInput,
  user: SessionUser,
  credentialId: string,
  chat: ChatState | null,
  geminiCredentialId?: string,
): Record<string, unknown> {
  const environment: Record<string, unknown> = {
    type: "remote",
    // Overrides base_environment.network for this turn, attaching the session's vault credentials
    // on the egress proxy so the sandbox VM never sees raw GitHub tokens or Gemini API keys.
    network: {
      allowlist: buildAllowlist(credentialId, geminiCredentialId),
    },
  };
  if (chat?.environmentId) environment.environment_id = chat.environmentId;

  const userText = input.message.replace(/\[\/?(?:context|voice_note)\]/gi, "(tag)");
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

function buildVoicePrompt(params: {
  turnId: string;
  ext: string;
  mimeType: string;
  voice: string;
}): {
  prompt: string;
  transcriptRelPath: string;
  replyAudioRelPath: string;
  replyMetaRelPath: string;
} {
  const inputRel = `workspace/voice/in-${params.turnId}.${params.ext}`;
  const transcriptRelPath = `workspace/voice/transcript-${params.turnId}.json`;
  const replyAudioRelPath = `workspace/voice/out-${params.turnId}.wav`;
  const replyMetaRelPath = `workspace/voice/out-${params.turnId}.json`;

  const prompt = [
    "[voice_note]",
    `input_audio: /${inputRel}`,
    `mime_type: ${params.mimeType}`,
    `transcript_out: /${transcriptRelPath}`,
    `reply_audio_out: /${replyAudioRelPath}`,
    `reply_meta_out: /${replyMetaRelPath}`,
    `voice: ${params.voice}`,
    "[/voice_note]",
    "",
    "The user sent a voice note in Voice Note Mode. Follow the Voice Note Workflow in /.agents/AGENTS.md and /.agents/skills/gemini-api-dev/SKILL.md:",
    `1. Run \`python3 /.agents/skills/gemini-api-dev/scripts/voice_notes.py transcribe --input /${inputRel} --mime-type ${params.mimeType} --output-json /${transcriptRelPath}\` to transcribe the user's voice note using \`gemini-3.5-transcribe\` in Smart Mode.`,
    "2. Execute the transcribed request thoroughly (using GitHub MCP and /.agents/skills/pr-review/SKILL.md when inspecting pull requests).",
    `3. Synthesize a concise 2-4 sentence spoken summary of your full answer (plain conversational prose, no markdown or raw URLs) using \`python3 /.agents/skills/gemini-api-dev/scripts/voice_notes.py speak --text "<spoken_summary>" --voice ${params.voice} --output /${replyAudioRelPath} --meta-json /${replyMetaRelPath}\`.`,
    "4. Output your complete written Markdown response as your final message.",
  ].join("\n");

  return { prompt, transcriptRelPath, replyAudioRelPath, replyMetaRelPath };
}

function pushMessage(chat: ChatState, message: StoredMessage): void {
  if (message.text.length > MAX_STORED_TEXT) message.text = `${message.text.slice(0, MAX_STORED_TEXT)}…`;
  chat.messages.push(message);
  if (chat.messages.length > MAX_STORED_MESSAGES) chat.messages.splice(0, chat.messages.length - MAX_STORED_MESSAGES);
}

function isStaleConversation(err: unknown): boolean {
  return err instanceof GeminiError && (err.status === 404 || err.status === 400);
}

const rawVoiceBody = express.raw({
  type: (req) => {
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    return ct.startsWith("audio/") || ct.startsWith("application/octet-stream");
  },
  limit: MAX_VOICE_BYTES,
});

export interface CreateChatRouterOptions {
  cfg: AppConfig;
  gemini: GeminiClient;
  agentDir?: string;
  agentStatus?: AgentSyncStatus;
  voiceStore?: VoiceClipStore;
}

export function createChatRouter({
  cfg,
  gemini,
  agentDir = DEFAULT_AGENT_DIR,
  agentStatus = { synced: false, hash: null, skillFiles: [] },
  voiceStore = new VoiceClipStore(),
}: CreateChatRouterOptions): Router {
  const router = Router();
  const inFlight = new Set<string>();
  let mcpToolUnsupported = false;

  function isMcpToolSchemaError(err: unknown): boolean {
    if (!(err instanceof GeminiError) || err.status !== 400) return false;
    const msg = err.message.toLowerCase();
    return msg.includes("credential") && msg.includes("tools");
  }

  function stripMcpTool(body: Record<string, unknown>): Record<string, unknown> {
    const rawTools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
    return {
      ...body,
      tools: rawTools.filter((t) => t.type !== "mcp_server"),
    };
  }

  async function openInteractionStream(body: Record<string, unknown>, signal: AbortSignal) {
    if (mcpToolUnsupported) {
      return gemini.streamInteraction(stripMcpTool(body), signal);
    }
    try {
      return await gemini.streamInteraction(body, signal);
    } catch (err) {
      if (!signal.aborted && isMcpToolSchemaError(err)) {
        mcpToolUnsupported = true;
        log.warn(
          "upstream interactions endpoint rejected mcp_server.credential; falling back to sandbox Vault egress proxy",
          { error: describeError(err) },
        );
        return gemini.streamInteraction(stripMcpTool(body), signal);
      }
      throw err;
    }
  }

  async function ensureGeminiCredential(req: Request): Promise<string | undefined> {
    if (req.session.geminiCredentialId) return req.session.geminiCredentialId;
    if (!gemini.isConfigured) return undefined;
    const id = GEMINI_CREDENTIAL_PREFIX + randomBytes(12).toString("hex");
    await gemini.createBearerCredential({
      id,
      token: cfg.geminiApiKey,
      headerName: "x-goog-api-key",
      prefix: "",
    });
    req.session.geminiCredentialId = id;
    return id;
  }

  async function stageAudioInSandbox(
    chat: ChatState,
    relPath: string,
    bytes: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
    onStatus?: (text: string) => void,
  ): Promise<string> {
    const createFreshEnv = async (): Promise<string> => {
      onStatus?.("Provisioning sandbox environment");
      try {
        const created = await gemini.bootstrapEnvironment(cfg.agentId, signal);
        chat.environmentId = created.id;
        return created.id;
      } catch (err) {
        if (err instanceof GeminiError && err.status === 404 && !signal.aborted) {
          const def = await buildAgentDefinition(cfg, agentDir);
          await syncAgent(gemini, def);
          agentStatus.synced = true;
          agentStatus.hash = def.hash;
          agentStatus.skillFiles = def.files;
          const retried = await gemini.bootstrapEnvironment(cfg.agentId, signal);
          chat.environmentId = retried.id;
          return retried.id;
        }
        throw err;
      }
    };

    let envId = chat.environmentId;
    if (!envId) {
      envId = await createFreshEnv();
    }

    onStatus?.("Staging voice note in sandbox");
    try {
      await gemini.uploadEnvironmentFile(envId, relPath, bytes, mimeType, signal);
      return envId;
    } catch (err) {
      if (err instanceof GeminiError && err.status === 404 && !signal.aborted) {
        delete chat.previousInteractionId;
        envId = await createFreshEnv();
        onStatus?.("Staging voice note in sandbox");
        await gemini.uploadEnvironmentFile(envId, relPath, bytes, mimeType, signal);
        return envId;
      }
      throw err;
    }
  }

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
            (c.id.startsWith("review-") ||
              c.id.startsWith("workshop-") ||
              c.id === req.session?.credentialId ||
              c.id === req.session?.geminiCredentialId),
        )
        .slice(0, 25)
        .map((c) => ({
          id: c.id ?? "",
          type: c.type ?? "bearer_token",
          status: c.status ?? "ACTIVE",
          create_time: c.create_time ?? null,
          isCurrentSession: Boolean(
            (req.session?.credentialId && c.id === req.session.credentialId) ||
              (req.session?.geminiCredentialId && c.id === req.session.geminiCredentialId),
          ),
        }));

      res.json({
        agentId: cfg.agentId,
        agentSynced: synced,
        agentHash: hash,
        skillFiles: inspected.files,
        agentModel: cfg.agentModel,
        mcpEnabled: MCP_ENABLED && !mcpToolUnsupported,
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

  router.get("/chat/voice/:audioId", (req: Request, res: Response) => {
    const audioId = typeof req.params.audioId === "string" ? req.params.audioId : "";
    const clip = voiceStore.get(req.sessionID, audioId);
    if (!clip) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200);
    res.setHeader("Content-Type", clip.mimeType);
    res.setHeader("Content-Length", String(clip.bytes.byteLength));
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Cache-Control", "private, no-store");
    res.end(Buffer.from(clip.bytes));
  });

  router.post("/chat", chatLimiter, async (req: Request, res: Response) => {
    const input = parseChatInput(req.body);
    if (!input) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    const user = req.session.user;
    const credentialId = req.session.credentialId;
    if (!user || !credentialId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const sid = req.sessionID;
    if (inFlight.has(sid)) {
      res.status(409).json({ error: "busy" });
      return;
    }
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

    try {
      const geminiCredId = await ensureGeminiCredential(req).catch(() => undefined);
      const runTurn = async (conversation: ChatState | null) => {
        mapper = new AgentStreamMapper();
        const stream = await openInteractionStream(
          buildInteraction(cfg, input, user, credentialId, conversation, geminiCredId),
          controller.signal,
        );
        for await (const message of stream) {
          for (const ev of mapper.handle(message)) forward(ev);
        }
      };

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

  router.post("/chat/voice", chatLimiter, rawVoiceBody, async (req: Request, res: Response) => {
    const user = req.session.user;
    const credentialId = req.session.credentialId;
    if (!user || !credentialId) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const bodyBuf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bodyBuf || bodyBuf.byteLength < 1 || bodyBuf.byteLength > MAX_VOICE_BYTES) {
      res.status(400).json({ error: "invalid_audio" });
      return;
    }

    const audioFormat = parseAudioFormat(req.headers["x-audio-mime"] ?? req.headers["content-type"]);
    if (!audioFormat) {
      res.status(400).json({ error: "unsupported_audio_mime" });
      return;
    }

    const timeZone = validTimeZone(req.headers["x-time-zone"]) ?? "UTC";
    const voiceName = parseVoiceName(req.headers["x-voice-name"]);
    const durationSec = parseDurationSec(req.headers["x-audio-duration"]);

    const sid = req.sessionID;
    if (inFlight.has(sid)) {
      res.status(409).json({ error: "busy" });
      return;
    }
    inFlight.add(sid);

    const audioBytes = new Uint8Array(bodyBuf.buffer, bodyBuf.byteOffset, bodyBuf.byteLength);
    const savedUserClip = voiceStore.put({
      sessionId: sid,
      bytes: audioBytes,
      mimeType: audioFormat.mimeType,
    });

    const chat: ChatState = (req.session.chat ??= { messages: [] });
    const userMessage: StoredMessage = {
      id: randomUUID(),
      role: "user",
      text: "Voice note",
      createdAt: Date.now(),
      voice: {
        audioId: savedUserClip.audioId,
        audioUrl: savedUserClip.audioUrl,
        mimeType: audioFormat.mimeType,
        ...(durationSec !== undefined ? { durationSec } : {}),
      },
    };
    pushMessage(chat, userMessage);

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

    send("user_voice", {
      messageId: userMessage.id,
      audioUrl: savedUserClip.audioUrl,
      mimeType: audioFormat.mimeType,
      ...(durationSec !== undefined ? { durationSec } : {}),
    });

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

    const turnId = randomBytes(8).toString("hex");
    const voicePaths = buildVoicePrompt({
      turnId,
      ext: audioFormat.ext,
      mimeType: audioFormat.mimeType,
      voice: voiceName,
    });

    let mapper = new AgentStreamMapper();
    let outcome: MessageStatus = "error";
    let errorCode: string | undefined;
    let assistantVoiceMeta: StoredMessage["voice"] | undefined;

    try {
      const geminiCredId = await ensureGeminiCredential(req);
      try {
        await stageAudioInSandbox(
          chat,
          `workspace/voice/in-${turnId}.${audioFormat.ext}`,
          audioBytes,
          audioFormat.mimeType,
          controller.signal,
          (text) => send("status", { text }),
        );
      } catch (stageErr) {
        if (!controller.signal.aborted) {
          log.error("voice note sandbox upload failed", { error: describeError(stageErr) });
          errorCode = "voice_stage_failed";
        }
        throw stageErr;
      }

      const stream = await openInteractionStream(
        buildInteraction(
          cfg,
          { message: voicePaths.prompt, timeZone },
          user,
          credentialId,
          chat,
          geminiCredId,
        ),
        controller.signal,
      );
      for await (const message of stream) {
        for (const ev of mapper.handle(message)) forward(ev);
      }

      if (mapper.upstreamError) {
        log.warn("agent reported an error on voice turn", {
          code: mapper.upstreamError.code,
          message: mapper.upstreamError.message,
        });
        outcome = "error";
        errorCode = "agent_error";
      } else if (mapper.finalStatus === "completed" || (!mapper.finalStatus && mapper.text)) {
        outcome = "completed";
      } else {
        outcome = mapper.finalStatus === "failed" ? "error" : "incomplete";
        if (outcome === "error") errorCode = "agent_error";
      }

      const activeEnvId = mapper.environmentId ?? chat.environmentId;
      if (activeEnvId && !controller.signal.aborted) {
        const [transcriptBytes, wavBytes, metaBytes] = await Promise.all([
          gemini.downloadEnvironmentFile(activeEnvId, voicePaths.transcriptRelPath, controller.signal).catch(() => null),
          gemini.downloadEnvironmentFile(activeEnvId, voicePaths.replyAudioRelPath, controller.signal).catch(() => null),
          gemini.downloadEnvironmentFile(activeEnvId, voicePaths.replyMetaRelPath, controller.signal).catch(() => null),
        ]);

        if (transcriptBytes) {
          try {
            const parsed = JSON.parse(new TextDecoder().decode(transcriptBytes)) as { transcript?: unknown };
            if (typeof parsed.transcript === "string" && parsed.transcript.trim()) {
              const cleaned = parsed.transcript.trim().slice(0, MAX_MESSAGE_CHARS);
              userMessage.text = cleaned;
              send("transcript", { messageId: userMessage.id, transcript: cleaned });
            }
          } catch {
            // ignore malformed transcript artifact
          }
        }

        if (wavBytes && wavBytes.byteLength > 44) {
          let summaryText: string | undefined;
          let resolvedVoice = voiceName;
          if (metaBytes) {
            try {
              const parsedMeta = JSON.parse(new TextDecoder().decode(metaBytes)) as {
                summary?: unknown;
                voice?: unknown;
              };
              if (typeof parsedMeta.summary === "string" && parsedMeta.summary.trim()) {
                summaryText = parsedMeta.summary.trim().slice(0, 2000);
              }
              if (typeof parsedMeta.voice === "string" && ALLOWED_VOICES.has(parsedMeta.voice)) {
                resolvedVoice = parsedMeta.voice;
              }
            } catch {
              // ignore optional metadata parse error
            }
          }

          const savedReply = voiceStore.put({
            sessionId: sid,
            bytes: wavBytes,
            mimeType: "audio/wav",
          });
          assistantVoiceMeta = {
            audioId: savedReply.audioId,
            audioUrl: savedReply.audioUrl,
            mimeType: "audio/wav",
            voice: resolvedVoice,
            ...(summaryText ? { summaryText } : {}),
          };
          send("audio", {
            audioUrl: savedReply.audioUrl,
            mimeType: "audio/wav",
            voice: resolvedVoice,
            ...(summaryText ? { summaryText } : {}),
          });
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        outcome = clientGone ? "stopped" : "error";
        if (timedOut) errorCode = "timeout";
        if (mapper.interactionId) {
          gemini.cancelInteraction(mapper.interactionId).catch(() => undefined);
        }
      } else {
        log.error("voice chat turn failed", { error: describeError(err) });
        outcome = "error";
        errorCode ??= "agent_unavailable";
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
        ...(assistantVoiceMeta ? { voice: assistantVoiceMeta } : {}),
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
    if (inFlight.has(req.sessionID)) {
      res.status(409).json({ error: "busy" });
      return;
    }
    const environmentId = req.session.chat?.environmentId;
    voiceStore.clearSession(req.sessionID);
    req.session.chat = { messages: [] };
    if (environmentId) {
      gemini.deleteEnvironment(environmentId).catch((err) => log.warn("sandbox delete failed", { error: describeError(err) }));
    }
    res.status(204).end();
  });

  return router;
}
