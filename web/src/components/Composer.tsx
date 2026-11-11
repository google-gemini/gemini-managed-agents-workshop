import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { TtsVoiceName } from "../types";
import { CloseIcon, KeyboardIcon, MicIcon, SendIcon, StopIcon, VolumeIcon } from "./Icons";

/** Mirrors the server-side limit in server/chat.ts. */
export const MAX_MESSAGE_CHARS = 4000;
const MAX_INPUT_HEIGHT = 200;
const VOICES: readonly TtsVoiceName[] = ["Kore", "Puck", "Aoede", "Charon", "Fenrir"];
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

function pickSupportedMime(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

function formatTimer(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onSendVoice: (blob: Blob, mimeType: string, durationSec: number) => void;
  onStop: () => void;
  onErrorNotice: (msg: string) => void;
  busy: boolean;
  voiceMode: boolean;
  onVoiceModeChange: (enabled: boolean) => void;
  voiceName: TtsVoiceName;
  onVoiceNameChange: (voice: TtsVoiceName) => void;
  autoPlayVoice: boolean;
  onAutoPlayVoiceChange: (enabled: boolean) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function Composer({
  value,
  onChange,
  onSend,
  onSendVoice,
  onStop,
  onErrorNotice,
  busy,
  voiceMode,
  onVoiceModeChange,
  voiceName,
  onVoiceNameChange,
  autoPlayVoice,
  onAutoPlayVoiceChange,
  inputRef,
}: ComposerProps) {
  const voiceSelectId = useId();
  const [recording, setRecording] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(12).fill(0.18));

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const discardRef = useRef(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Auto-grow textarea via CSSOM (strict CSP safe).
  useLayoutEffect(() => {
    if (voiceMode) return;
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [value, voiceMode, inputRef]);

  const teardownMedia = useCallback(() => {
    window.clearInterval(timerRef.current);
    timerRef.current = undefined;
    if (rafRef.current !== undefined) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    recorderRef.current = null;
    setRecording(false);
    setElapsedSec(0);
    setLevels(Array(12).fill(0.18));
  }, []);

  useEffect(() => {
    return () => teardownMedia();
  }, [teardownMedia]);

  const startRecording = useCallback(async () => {
    if (busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onErrorNotice("Microphone recording isn't supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      discardRef.current = false;

      const preferredMime = pickSupportedMime();
      const recorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      startedAtRef.current = performance.now();
      setRecording(true);
      setElapsedSec(0);

      timerRef.current = window.setInterval(() => {
        setElapsedSec((performance.now() - startedAtRef.current) / 1000);
      }, 200);

      // Optional live level meter (respects reduced motion in CSS).
      try {
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        const bins = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(bins);
          const next = Array.from({ length: 12 }, (_, idx) => {
            const raw = bins[idx * 2] ?? 0;
            return Math.max(0.16, Math.min(1, raw / 210));
          });
          setLevels(next);
          rafRef.current = window.requestAnimationFrame(tick);
        };
        rafRef.current = window.requestAnimationFrame(tick);
      } catch {
        // AudioContext meter is purely cosmetic; recording proceeds without it.
      }

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = () => {
        const durationSec = Math.max(0.4, (performance.now() - startedAtRef.current) / 1000);
        const shouldDiscard = discardRef.current;
        const actualMime = recorder.mimeType || preferredMime || "audio/webm";
        const collected = chunksRef.current;
        chunksRef.current = [];
        teardownMedia();

        if (shouldDiscard) return;
        const blob = new Blob(collected, { type: actualMime });
        if (blob.size < 64) {
          onErrorNotice("That voice note was empty. Try recording a slightly longer message.");
          return;
        }
        onSendVoice(blob, actualMime, durationSec);
      };

      recorder.start(250);
    } catch {
      teardownMedia();
      onErrorNotice("Microphone access was blocked. Allow microphone permission for localhost and try again.");
    }
  }, [busy, recording, onErrorNotice, onSendVoice, teardownMedia]);

  const finishAndSendRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    discardRef.current = false;
    rec.stop();
  }, []);

  const cancelRecording = useCallback(() => {
    const rec = recorderRef.current;
    discardRef.current = true;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    } else {
      teardownMedia();
    }
  }, [teardownMedia]);

  const switchMode = (nextVoiceMode: boolean) => {
    if (recording) cancelRecording();
    onVoiceModeChange(nextVoiceMode);
  };

  const length = value.trim().length;
  const canSend = !busy && length > 0 && length <= MAX_MESSAGE_CHARS;
  const showCount = !voiceMode && value.length > MAX_MESSAGE_CHARS * 0.9;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!voiceMode && canSend) onSend();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-toolbar" role="group" aria-label="Input mode and voice settings">
        <div className="mode-switch">
          <button
            type="button"
            className={`mode-switch-btn${!voiceMode ? " is-selected" : ""}`}
            aria-pressed={!voiceMode}
            disabled={busy}
            onClick={() => switchMode(false)}
          >
            <KeyboardIcon size={15} />
            <span>Text</span>
          </button>
          <button
            type="button"
            className={`mode-switch-btn${voiceMode ? " is-selected" : ""}`}
            aria-pressed={voiceMode}
            disabled={busy}
            onClick={() => switchMode(true)}
          >
            <MicIcon size={15} />
            <span>Voice Note</span>
          </button>
        </div>

        {voiceMode && (
          <div className="voice-controls">
            <label htmlFor={voiceSelectId} className="voice-select-label">
              <VolumeIcon size={14} />
              <span>Voice</span>
            </label>
            <select
              id={voiceSelectId}
              className="voice-select"
              value={voiceName}
              disabled={busy || recording}
              onChange={(e) => onVoiceNameChange(e.target.value as TtsVoiceName)}
            >
              {VOICES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>

            <button
              type="button"
              className={`voice-autoplay-btn${autoPlayVoice ? " is-on" : ""}`}
              aria-pressed={autoPlayVoice}
              onClick={() => onAutoPlayVoiceChange(!autoPlayVoice)}
            >
              <span>Auto-play: {autoPlayVoice ? "On" : "Off"}</span>
            </button>
          </div>
        )}
      </div>

      {voiceMode ? (
        <div className={`composer-box composer-voice-box${recording ? " is-recording" : ""}${busy ? " is-busy" : ""}`}>
          {recording ? (
            <>
              <button
                type="button"
                className="voice-cancel-btn"
                onClick={cancelRecording}
                aria-label="Discard voice recording"
                title="Cancel recording"
              >
                <CloseIcon size={18} />
                <span>Cancel</span>
              </button>

              <div className="voice-live-track" aria-live="off">
                <span className="rec-dot" aria-hidden="true" />
                <span className="voice-rec-timer">{formatTimer(elapsedSec)}</span>
                <div className="voice-meter" aria-hidden="true">
                  {levels.map((lvl, idx) => (
                    <span
                      key={idx}
                      className="voice-meter-bar"
                      style={{ transform: `scaleY(${lvl.toFixed(2)})` }}
                    />
                  ))}
                </div>
              </div>

              <button
                type="button"
                className="voice-send-pill"
                onClick={finishAndSendRecording}
                aria-label="Stop recording and send voice note"
              >
                <SendIcon size={17} />
                <span>Send voice</span>
              </button>
            </>
          ) : busy ? (
            <>
              <div className="voice-idle-prompt">
                <MicIcon size={18} />
                <span>Managed Agent is processing your voice note in sandbox…</span>
              </div>
              <button type="button" className="composer-btn is-stop" onClick={onStop} aria-label="Stop response" title="Stop">
                <StopIcon size={20} />
              </button>
            </>
          ) : (
            <>
              <div className="voice-idle-prompt">
                <MicIcon size={18} />
                <span>Speak a PR review prompt — transcribed with Gemini 3.5 Smart Mode &amp; replied via Flash-Lite TTS</span>
              </div>
              <button
                type="button"
                className="voice-record-pill"
                onClick={() => void startRecording()}
                aria-label="Start recording voice note"
              >
                <MicIcon size={18} />
                <span>Record</span>
              </button>
            </>
          )}
        </div>
      ) : (
        <div className={`composer-box${busy ? " is-busy" : ""}`}>
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
            value={value}
            maxLength={MAX_MESSAGE_CHARS}
            placeholder="Ask RepoReview to inspect a GitHub PR, run tests in /workspace, or give a merge verdict…"
            aria-label="Message RepoReview"
            autoComplete="off"
            spellCheck
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button type="button" className="composer-btn is-stop" onClick={onStop} aria-label="Stop response" title="Stop">
              <StopIcon size={20} />
            </button>
          ) : (
            <button type="submit" className="composer-btn" disabled={!canSend} aria-label="Send message" title="Send">
              <SendIcon size={20} />
            </button>
          )}
        </div>
      )}

      <p className="composer-note">
        {showCount ? (
          <span className="composer-count">
            {value.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
          </span>
        ) : voiceMode ? (
          "Voice Note Mode · Gemini 3.5 Smart Transcribe + Gemini 3.8 Flash-Lite TTS executed inside Sandbox via Vault Proxy."
        ) : (
          "Powered by Gemini Managed Agents · Remote GitHub MCP + Isolated Linux Sandbox · Token stays in Vault."
        )}
      </p>
    </form>
  );
}
