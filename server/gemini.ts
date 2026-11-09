// Thin REST client for the Gemini Managed Agents API (v1beta, x-goog-api-key auth).

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const SAFE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_SSE_BUFFER = 4 * 1024 * 1024;

export class GeminiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
    this.code = code;
  }
}

export interface SseMessage {
  event: string;
  data: string;
}

export interface CredentialSummary {
  id?: string;
  type?: string;
  status?: string;
  create_time?: string;
  update_time?: string;
}

function safeId(id: string, kind: string): string {
  if (!SAFE_ID.test(id)) throw new GeminiError(400, `Invalid ${kind} id`);
  return id;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toError(status: number, body: unknown): GeminiError {
  const err = (body as { error?: { message?: unknown; code?: unknown; status?: unknown } } | undefined)?.error;
  const message = typeof err?.message === "string" ? err.message.slice(0, 300) : `HTTP ${status}`;
  const code = typeof err?.code === "string" ? err.code : typeof err?.status === "string" ? err.status : undefined;
  return new GeminiError(status, message, code);
}

export class GeminiClient {
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#apiKey = apiKey.trim();
    this.#fetchImpl = fetchImpl;
  }

  get isConfigured(): boolean {
    return this.#apiKey.length > 0;
  }

  #ensureKey(): string {
    if (!this.#apiKey) {
      throw new GeminiError(503, "GEMINI_API_KEY is not configured in .env", "missing_api_key");
    }
    return this.#apiKey;
  }

  #headers(extra?: Record<string, string>): Record<string, string> {
    return { "Content-Type": "application/json", "x-goog-api-key": this.#ensureKey(), ...extra };
  }

  async #request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await this.#fetchImpl(API_BASE + path, {
      method,
      headers: this.#headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = parseJson(await res.text());
    if (!res.ok) throw toError(res.status, json);
    return json as T;
  }

  async #deleteIgnoringMissing(path: string): Promise<void> {
    if (!this.isConfigured) return;
    try {
      await this.#request("DELETE", path);
    } catch (err) {
      if (err instanceof GeminiError && err.status === 404) return;
      throw err;
    }
  }

  // ---- credentials (write-only vault: responses never contain the secret) ----

  async createOAuthCredential(input: {
    id: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    tokenUrl: string;
    scopes?: string[];
  }): Promise<void> {
    await this.#request(
      "POST",
      "/credentials",
      {
        id: safeId(input.id, "credential"),
        type: "oauth2",
        client_id: input.clientId,
        client_secret: input.clientSecret,
        refresh_token: input.refreshToken,
        token_url: input.tokenUrl,
        ...(input.scopes ? { scopes: input.scopes } : {}),
      },
      45_000,
    );
  }

  async createBearerCredential(input: { id: string; token: string }): Promise<void> {
    await this.#request(
      "POST",
      "/credentials",
      {
        id: safeId(input.id, "credential"),
        type: "bearer_token",
        token: input.token,
      },
      45_000,
    );
  }

  async deleteCredential(id: string): Promise<void> {
    await this.#deleteIgnoringMissing(`/credentials/${safeId(id, "credential")}`);
  }

  async listCredentials(pageToken?: string): Promise<{ credentials: CredentialSummary[]; nextPageToken?: string }> {
    const qs = new URLSearchParams({ page_size: "100" });
    if (pageToken) qs.set("page_token", pageToken);
    const res = await this.#request<{ credentials?: CredentialSummary[]; next_page_token?: string } | undefined>(
      "GET",
      `/credentials?${qs.toString()}`,
    );
    return { credentials: res?.credentials ?? [], nextPageToken: res?.next_page_token };
  }

  // ---- environments ----

  async deleteEnvironment(id: string): Promise<void> {
    await this.#deleteIgnoringMissing(`/environments/${safeId(id, "environment")}`);
  }

  // ---- agents ----

  async getAgent(id: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.#request<Record<string, unknown>>("GET", `/agents/${safeId(id, "agent")}`);
    } catch (err) {
      if (err instanceof GeminiError && err.status === 404) return null;
      throw err;
    }
  }

  async createAgent(definition: Record<string, unknown>): Promise<void> {
    await this.#request("POST", "/agents", definition, 60_000);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.#deleteIgnoringMissing(`/agents/${safeId(id, "agent")}`);
  }

  // ---- interactions ----

  async cancelInteraction(id: string): Promise<void> {
    if (!this.isConfigured) return;
    await this.#request("POST", `/interactions/${safeId(id, "interaction")}/cancel`, {}, 10_000);
  }

  /** Starts a streaming interaction and returns its parsed SSE messages. */
  async streamInteraction(body: Record<string, unknown>, signal: AbortSignal): Promise<AsyncGenerator<SseMessage>> {
    const res = await this.#fetchImpl(`${API_BASE}/interactions`, {
      method: "POST",
      headers: this.#headers({ Accept: "text/event-stream" }),
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
    if (!res.ok || !res.body) {
      throw toError(res.status, parseJson(await res.text().catch(() => "")));
    }
    return parseSse(res.body);
  }
}

/** Spec-compliant SSE parser (handles \n, \r\n, and \r line endings split across chunks). */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER) throw new GeminiError(502, "Upstream SSE line too long");

      let match: RegExpExecArray | null;
      while ((match = /\r\n|\r|\n/.exec(buffer)) !== null) {
        if (match[0] === "\r" && match.index === buffer.length - 1 && !done) break;
        const lineText = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (lineText === "") {
          if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
          event = "";
          data = [];
          continue;
        }
        if (lineText.startsWith(":")) continue;
        const colon = lineText.indexOf(":");
        const field = colon === -1 ? lineText : lineText.slice(0, colon);
        let fieldValue = colon === -1 ? "" : lineText.slice(colon + 1);
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
        if (field === "event") event = fieldValue;
        else if (field === "data") data.push(fieldValue);
      }

      if (done) {
        if (data.length > 0) yield { event: event || "message", data: data.join("\n") };
        finished = true;
        return;
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
