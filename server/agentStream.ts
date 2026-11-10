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

// Maps raw Managed-Agent SSE frames (or @google/genai SDK SSE events) to sanitized browser events.
// Raw tool stdout/diffs are never forwarded in step payloads — only concise labels and clipped metadata.

import type { SseMessage } from "./gemini.ts";
import type { StepKind, StoredStep } from "./types.ts";

export type ClientEvent =
  | { type: "status"; text: string }
  | { type: "step"; step: StoredStep }
  | { type: "stepdone"; id: string; ok: boolean }
  | { type: "text"; delta: string };

type Json = Record<string, unknown>;

const MCP_TOOL_LABELS: Record<string, string> = {
  list_pull_requests: "GitHub MCP · Listing pull requests",
  get_pull_request: "GitHub MCP · Reading pull request",
  pull_request_read: "GitHub MCP · Reading pull request",
  get_pull_request_files: "GitHub MCP · Inspecting changed files",
  get_pull_request_diff: "GitHub MCP · Reading pull request diff",
  get_pull_request_comments: "GitHub MCP · Reading review comments",
  get_pull_request_reviews: "GitHub MCP · Reading PR reviews",
  get_pull_request_status: "GitHub MCP · Checking CI status",
  get_file_contents: "GitHub MCP · Reading repository file",
  list_commits: "GitHub MCP · Listing commits",
  search_pull_requests: "GitHub MCP · Searching pull requests",
  search_issues: "GitHub MCP · Searching issues & PRs",
  search_code: "GitHub MCP · Searching code",
  search_repositories: "GitHub MCP · Searching repositories",
};

const PR_SKILL_LABELS: Record<string, string> = {
  "clone-pr": "Checking out PR in sandbox",
  "detect-tests": "Detecting test runner",
  "run-tests": "Running test suite in sandbox",
};

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

export function describeCode(code: string): { kind: StepKind; label: string; detail?: string } {
  const skillMatch = /inspect_pr\.py["']?\s+(clone-pr|detect-tests|run-tests)([^\n;&|]*)/.exec(code);
  if (skillMatch) {
    const subcmd = skillMatch[1] ?? "";
    const rest = skillMatch[2] ?? "";
    const label = PR_SKILL_LABELS[subcmd] ?? "Running PR helper in sandbox";
    const repo = /--repo[=\s]+["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(rest)?.[1];
    const pr = /--pr[=\s]+["']?(\d+)/.exec(rest)?.[1];
    const dir = /--dir[=\s]+["']?(\/workspace[^\s"']*)/.exec(rest)?.[1];
    const parts = [repo && pr ? `${repo}#${pr}` : repo, !repo && dir ? dir : ""].filter(Boolean);
    const detail = parts.length > 0 ? clip(parts.join(" · "), 120) : undefined;
    return { kind: "code", label, ...(detail ? { detail } : {}) };
  }

  if (/\/\.agents\/(?:AGENTS\.md|skills\/)/.test(code)) {
    return { kind: "code", label: "Loading PR review skill" };
  }
  if (/\b(?:pytest|unittest|bun\s+test|npm\s+test|go\s+test|cargo\s+test)\b/.test(code)) {
    return { kind: "code", label: "Running tests in sandbox" };
  }
  if (/\bgit\s+(?:clone|fetch|checkout|diff|show|log|status)\b/.test(code)) {
    return { kind: "code", label: "Inspecting git repository" };
  }
  return { kind: "code", label: "Running command in sandbox" };
}

export function describeCall(
  type: string,
  args: Json,
  toolName?: string,
): { kind: StepKind; label: string; detail?: string } {
  if (type === "code_execution_call") {
    const cmd =
      typeof args.code === "string"
        ? args.code
        : typeof args.command === "string"
          ? args.command
          : JSON.stringify(args);
    return describeCode(cmd);
  }

  if (type === "google_search_call") {
    const queries = Array.isArray(args.queries) ? args.queries.filter((q): q is string => typeof q === "string") : [];
    const detail = clip(queries.join(" · "), 140);
    return { kind: "search", label: "Searching documentation", ...(detail ? { detail } : {}) };
  }

  if (type === "mcp_server_tool_call") {
    const rawName = toolName ?? (typeof args.name === "string" ? args.name : "");
    const normalized = rawName.replace(/^github[._-]/, "");
    const label =
      MCP_TOOL_LABELS[normalized] ??
      (normalized ? `GitHub MCP · ${normalized.replace(/_/g, " ")}` : "GitHub MCP · Calling tool");

    const owner = typeof args.owner === "string" ? args.owner : "";
    const repo = typeof args.repo === "string" ? args.repo : "";
    const prRaw = args.pullNumber ?? args.pull_number ?? args.number;
    const pr = typeof prRaw === "number" || typeof prRaw === "string" ? `#${prRaw}` : "";
    const filePath = typeof args.path === "string" ? args.path : "";
    const query = typeof args.query === "string" ? args.query : typeof args.q === "string" ? args.q : "";
    const repoRef = owner && repo ? `${owner}/${repo}${pr}` : repo ? `${repo}${pr}` : owner;
    const parts = [repoRef, filePath, query].filter(Boolean);
    const detail = parts.length > 0 ? clip(parts.join(" · "), 140) : undefined;
    return { kind: "mcp", label: clip(label, 80), ...(detail ? { detail } : {}) };
  }

  return { kind: "code", label: "Working in sandbox" };
}

/** Extracts a concise title from a streaming thought summary ("**Title**\n\nbody…"). */
export function thoughtTitle(text: string, final = false): string {
  const t = text.trimStart();
  if (t.startsWith("**")) {
    const m = /^\*\*([^*\n]{2,100})\*\*/.exec(t);
    return m?.[1] ? clip(m[1], 80) : "";
  }
  const newline = t.indexOf("\n");
  if (newline === -1 && !final) return "";
  const firstLine = (newline === -1 ? t : t.slice(0, newline)).replace(/[*#_`]/g, "").trim();
  return firstLine.length >= 3 ? clip(firstLine, 80) : "";
}

export class AgentStreamMapper {
  interactionId: string | undefined;
  environmentId: string | undefined;
  finalStatus: string | undefined;
  upstreamError: { message: string; code?: string } | undefined;
  text = "";
  readonly steps: StoredStep[] = [];

  readonly #stepTypes = new Map<number, string>();
  readonly #toolNames = new Map<number, string>();
  readonly #callIds = new Map<number, string>();
  readonly #resultCallIds = new Map<number, string>();
  readonly #emittedCalls = new Set<number>();
  readonly #stepIdByCallId = new Map<string, string>();
  readonly #thoughts = new Map<number, string>();

  /** Handles raw SSE frames yielded by GeminiClient.streamInteraction(). */
  handle(msg: SseMessage): ClientEvent[] {
    if (msg.data === "[DONE]") return [];
    let data: Json;
    try {
      data = asObject(JSON.parse(msg.data));
    } catch {
      return [];
    }
    const eventType = msg.event && msg.event !== "message" ? msg.event : typeof data.event_type === "string" ? data.event_type : "";
    return this.handleEvent(eventType, data);
  }

  /** Handles typed SSE events yielded by `@google/genai` `client.interactions.create({ stream: true })`. */
  handleSdkEvent(ev: { event_type: string }): ClientEvent[] {
    return this.handleEvent(ev.event_type, asObject(ev));
  }

  handleEvent(eventType: string, data: Json): ClientEvent[] {
    const out: ClientEvent[] = [];
    switch (eventType) {
      case "interaction.created": {
        const interaction = asObject(data.interaction);
        if (typeof interaction.id === "string") this.interactionId = interaction.id;
        if (typeof interaction.environment_id === "string") this.environmentId = interaction.environment_id;
        out.push({ type: "status", text: "Thinking" });
        break;
      }
      case "interaction.completed": {
        const interaction = asObject(data.interaction);
        if (typeof interaction.status === "string") this.finalStatus = interaction.status;
        if (typeof interaction.environment_id === "string") this.environmentId = interaction.environment_id;
        break;
      }
      case "step.start":
        this.#onStart(data, out);
        break;
      case "step.delta":
        this.#onDelta(data, out);
        break;
      case "step.stop":
        this.#onStop(data, out);
        break;
      case "error": {
        const err = asObject(data.error);
        this.upstreamError = {
          message: typeof err.message === "string" ? err.message.slice(0, 300) : "unknown error",
          ...(typeof err.code === "string" ? { code: err.code } : {}),
        };
        break;
      }
      default:
        break;
    }
    return out;
  }

  #onStart(data: Json, out: ClientEvent[]): void {
    const index = Number(data.index);
    const step = asObject(data.step);
    const type = typeof step.type === "string" ? step.type : "";
    this.#stepTypes.set(index, type);
    if (typeof step.name === "string") this.#toolNames.set(index, step.name);
    if (type === "thought") {
      out.push({ type: "status", text: "Thinking" });
    } else if (type === "model_output") {
      out.push({ type: "status", text: "Writing review" });
    } else if (type.endsWith("_call")) {
      if (typeof step.id === "string") this.#callIds.set(index, step.id);
      if (step.arguments && typeof step.arguments === "object") {
        this.#emitCall(index, type, asObject(step.arguments), out);
      }
    } else if (type.endsWith("_result")) {
      if (typeof step.call_id === "string") this.#resultCallIds.set(index, step.call_id);
      if ("is_error" in step || "exit_code" in step || "result" in step) {
        this.#emitResult(index, step, out);
      }
    }
  }

  #onDelta(data: Json, out: ClientEvent[]): void {
    const index = Number(data.index);
    const delta = asObject(data.delta);
    const deltaType = typeof delta.type === "string" ? delta.type : "";
    const stepType = this.#stepTypes.get(index) ?? "";
    if (typeof delta.name === "string" && !this.#toolNames.has(index)) this.#toolNames.set(index, delta.name);

    if (deltaType === "text") {
      if (stepType !== "thought" && typeof delta.text === "string" && delta.text) {
        this.text += delta.text;
        out.push({ type: "text", delta: delta.text });
      }
    } else if (deltaType === "thought_summary") {
      const contentObj = asObject(delta.content);
      const chunk = typeof contentObj.text === "string" ? contentObj.text : typeof delta.text === "string" ? delta.text : "";
      if (!chunk) return;
      const previous = this.#thoughts.get(index) ?? "";
      const full = previous + chunk;
      this.#thoughts.set(index, full);
      const title = thoughtTitle(full);
      if (title && title !== thoughtTitle(previous)) out.push({ type: "status", text: title });
    } else if (deltaType.endsWith("_call")) {
      if (typeof delta.id === "string" && !this.#callIds.has(index)) this.#callIds.set(index, delta.id);
      if (delta.arguments && typeof delta.arguments === "object") {
        this.#emitCall(index, deltaType, asObject(delta.arguments), out);
      }
    } else if (deltaType.endsWith("_result")) {
      if (typeof delta.call_id === "string" && !this.#resultCallIds.has(index)) {
        this.#resultCallIds.set(index, delta.call_id);
      }
      this.#emitResult(index, delta, out);
    }
  }

  #onStop(data: Json, out: ClientEvent[]): void {
    const index = Number(data.index);
    const type = this.#stepTypes.get(index) ?? "";
    if (type === "thought") {
      const title = thoughtTitle(this.#thoughts.get(index) ?? "", true);
      if (title) {
        const step: StoredStep = { id: `t${index}`, kind: "thought", label: title, state: "done" };
        this.steps.push(step);
        out.push({ type: "step", step: { ...step } });
      }
    } else if (type.endsWith("_call") && !this.#emittedCalls.has(index)) {
      this.#emitCall(index, type, {}, out);
    } else if (type.endsWith("_result")) {
      this.#emitResult(index, {}, out);
    }
  }

  #emitCall(index: number, type: string, args: Json, out: ClientEvent[]): void {
    if (this.#emittedCalls.has(index)) return;
    this.#emittedCalls.add(index);
    const desc = describeCall(type, args, this.#toolNames.get(index));
    const step: StoredStep = {
      id: `s${index}`,
      kind: desc.kind,
      label: desc.label,
      state: "running",
      ...(desc.detail ? { detail: desc.detail } : {}),
    };
    const callId = this.#callIds.get(index);
    if (callId) this.#stepIdByCallId.set(callId, step.id);
    this.steps.push(step);
    out.push({ type: "step", step: { ...step } });
    out.push({ type: "status", text: desc.label });
  }

  #emitResult(index: number, payload: Json, out: ClientEvent[]): void {
    const callId = this.#resultCallIds.get(index);
    const stepId = callId ? this.#stepIdByCallId.get(callId) : undefined;
    if (!stepId) return;
    const step = this.steps.find((s) => s.id === stepId);
    if (step && step.state !== "running") return;
    const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : 0;
    const ok = payload.is_error !== true && exitCode === 0;
    if (step) step.state = ok ? "done" : "error";
    out.push({ type: "stepdone", id: stepId, ok });
    out.push({ type: "status", text: "Thinking" });
  }

  /** Settles any steps still marked running when a turn finishes or is cancelled. */
  settleSteps(): void {
    for (const step of this.steps) if (step.state === "running") step.state = "done";
  }
}
