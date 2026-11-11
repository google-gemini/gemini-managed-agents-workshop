import type { ChatEvent, Me, SessionResult, SignedOutMeta, TtsVoiceName, VaultStatus } from "./types";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code?: string) {
    super(`HTTP ${status}${code ? ` (${code})` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

async function errorFrom(res: Response): Promise<HttpError> {
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // non-JSON error body
  }
  return new HttpError(res.status, code);
}

/** Fetches session state, returning SignedOutMeta when unauthenticated (401). */
export async function fetchSession(): Promise<SessionResult> {
  const res = await fetch("/api/me", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (res.status === 401) {
    let meta: SignedOutMeta = { error: "unauthenticated" };
    try {
      const body = (await res.json()) as Partial<SignedOutMeta>;
      meta = {
        error: "unauthenticated",
        ...(body.workshopMode ? { workshopMode: body.workshopMode } : {}),
        ...(typeof body.hasGithubOAuth === "boolean" ? { hasGithubOAuth: body.hasGithubOAuth } : {}),
        ...(typeof body.hasGithubPat === "boolean" ? { hasGithubPat: body.hasGithubPat } : {}),
      };
    } catch {
      // fallback to default unauthenticated meta
    }
    return { authenticated: false, meta };
  }
  if (!res.ok) throw await errorFrom(res);
  const me = (await res.json()) as Me;
  return { authenticated: true, me };
}

/** Returns null when not signed in (401). */
export async function fetchMe(): Promise<Me | null> {
  const session = await fetchSession();
  return session.authenticated ? session.me : null;
}

export async function fetchVault(): Promise<VaultStatus> {
  const res = await fetch("/api/vault", {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as VaultStatus;
}

function post(path: string, csrfToken: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify(body ?? {}),
    signal,
  });
}

export async function resetChat(csrfToken: string): Promise<void> {
  const res = await post("/api/chat/reset", csrfToken);
  if (!res.ok) throw await errorFrom(res);
}

/** Signs out server-side (revoking vault credential & sandbox), then reloads cleanly to "/". */
export async function signOut(csrfToken: string): Promise<void> {
  try {
    const res = await post("/api/auth/logout", csrfToken);
    if (res.status === 403) {
      const me = await fetchMe();
      if (me) await post("/api/auth/logout", me.csrfToken);
    }
  } finally {
    window.location.replace("/");
  }
}

async function consumeSse(res: Response, onEvent: (ev: ChatEvent) => void): Promise<void> {
  if (!res.ok || !res.body) throw await errorFrom(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // keep-alive comment
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length === 0) continue;
      try {
        onEvent({ event, data: JSON.parse(data.join("\n")) } as ChatEvent);
      } catch {
        // ignore malformed frames
      }
    }
  }
}

/** Streams one chat turn over SSE. Resolves when the server closes the stream. */
export async function streamChat(
  message: string,
  csrfToken: string,
  signal: AbortSignal,
  onEvent: (ev: ChatEvent) => void,
): Promise<void> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await post("/api/chat", csrfToken, { message, timeZone }, signal);
  await consumeSse(res, onEvent);
}

/** Uploads a recorded voice note to POST /api/chat/voice and streams the Managed Agent turn over SSE. */
export async function streamVoiceChat(
  audioBlob: Blob,
  opts: { mimeType: string; durationSec?: number; voice: TtsVoiceName },
  csrfToken: string,
  signal: AbortSignal,
  onEvent: (ev: ChatEvent) => void,
): Promise<void> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cleanMime = opts.mimeType.split(";", 1)[0]?.trim() || "audio/webm";
  const headers: Record<string, string> = {
    "Content-Type": cleanMime,
    "x-audio-mime": cleanMime,
    "x-time-zone": timeZone,
    "x-voice-name": opts.voice,
    "x-csrf-token": csrfToken,
  };
  if (opts.durationSec !== undefined && Number.isFinite(opts.durationSec)) {
    headers["x-audio-duration"] = String(Math.round(opts.durationSec * 10) / 10);
  }
  const res = await fetch("/api/chat/voice", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers,
    body: audioBlob,
    signal,
  });
  await consumeSse(res, onEvent);
}
