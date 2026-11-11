// Session-isolated, bounded in-memory voice clip store for user recordings & synthesized TTS WAV summaries.

import { randomBytes } from "node:crypto";

const MAX_CLIPS_PER_SESSION = 24;
const MAX_GLOBAL_BYTES = 48 * 1024 * 1024;
const AUDIO_ID_PATTERN = /^[a-f0-9]{24}$/;

export interface StoredVoiceClip {
  audioId: string;
  sessionId: string;
  bytes: Uint8Array;
  mimeType: string;
  createdAt: number;
}

export class VoiceClipStore {
  readonly #clips = new Map<string, StoredVoiceClip>();
  readonly #bySession = new Map<string, string[]>();
  #totalBytes = 0;

  put(input: { sessionId: string; bytes: Uint8Array; mimeType: string }): { audioId: string; audioUrl: string } {
    const audioId = randomBytes(12).toString("hex");
    const copy = new Uint8Array(input.bytes);

    let sessionList = this.#bySession.get(input.sessionId);
    if (!sessionList) {
      sessionList = [];
      this.#bySession.set(input.sessionId, sessionList);
    }
    while (sessionList.length >= MAX_CLIPS_PER_SESSION) {
      const oldestId = sessionList.shift();
      if (oldestId) this.#deleteClip(oldestId);
    }

    while (this.#totalBytes + copy.byteLength > MAX_GLOBAL_BYTES && this.#clips.size > 0) {
      const oldestKey = this.#clips.keys().next().value;
      if (!oldestKey) break;
      this.#deleteClip(oldestKey);
    }

    const entry: StoredVoiceClip = {
      audioId,
      sessionId: input.sessionId,
      bytes: copy,
      mimeType: input.mimeType,
      createdAt: Date.now(),
    };
    this.#clips.set(audioId, entry);
    sessionList.push(audioId);
    this.#totalBytes += copy.byteLength;

    return { audioId, audioUrl: `/api/chat/voice/${audioId}` };
  }

  get(sessionId: string, audioId: string): StoredVoiceClip | null {
    if (!AUDIO_ID_PATTERN.test(audioId)) return null;
    const clip = this.#clips.get(audioId);
    if (!clip || clip.sessionId !== sessionId) return null;
    return clip;
  }

  clearSession(sessionId: string): void {
    const ids = this.#bySession.get(sessionId);
    if (!ids) return;
    for (const id of ids) {
      const existing = this.#clips.get(id);
      if (existing) {
        this.#totalBytes = Math.max(0, this.#totalBytes - existing.bytes.byteLength);
        this.#clips.delete(id);
      }
    }
    this.#bySession.delete(sessionId);
  }

  #deleteClip(audioId: string): void {
    const existing = this.#clips.get(audioId);
    if (!existing) return;
    this.#totalBytes = Math.max(0, this.#totalBytes - existing.bytes.byteLength);
    this.#clips.delete(audioId);
    const list = this.#bySession.get(existing.sessionId);
    if (list) {
      const idx = list.indexOf(audioId);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.#bySession.delete(existing.sessionId);
    }
  }
}
