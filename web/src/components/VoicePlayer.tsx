import { useEffect, useId, useRef, useState } from "react";
import { MicIcon, PauseIcon, PlayIcon, VolumeIcon } from "./Icons";

function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

interface VoicePlayerProps {
  audioUrl: string;
  variant: "user" | "assistant";
  durationHintSec?: number | undefined;
  voiceName?: string | undefined;
  summaryText?: string | undefined;
  autoPlay?: boolean | undefined;
}

export function VoicePlayer({
  audioUrl,
  variant,
  durationHintSec,
  voiceName,
  summaryText,
  autoPlay = false,
}: VoicePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const autoPlayedRef = useRef<string | null>(null);
  const detailsId = useId();
  const sliderId = useId();

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number>(durationHintSec && durationHintSec > 0 ? durationHintSec : 0);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    if (durationHintSec && durationHintSec > 0) setDuration(durationHintSec);
  }, [audioUrl, durationHintSec]);

  useEffect(() => {
    if (!autoPlay || !audioUrl || autoPlayedRef.current === audioUrl) return;
    autoPlayedRef.current = audioUrl;
    const el = audioRef.current;
    if (!el) return;
    el.play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
  }, [autoPlay, audioUrl]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  const syncDuration = () => {
    const el = audioRef.current;
    if (!el) return;
    if (Number.isFinite(el.duration) && el.duration > 0) {
      setDuration(el.duration);
    }
  };

  const maxSec = duration > 0 ? duration : Math.max(currentTime, 1);
  const badgeTitle =
    variant === "assistant"
      ? `Voice Summary · Gemini 3.8 Flash-Lite TTS${voiceName ? ` (${voiceName})` : ""}`
      : "Voice Note";

  return (
    <div className={`voice-card voice-card-${variant}${playing ? " is-playing" : ""}`}>
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        aria-details={summaryText ? detailsId : undefined}
        onLoadedMetadata={syncDuration}
        onDurationChange={syncDuration}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
      />

      <div className="voice-card-row">
        <button
          type="button"
          className="voice-play-btn"
          onClick={togglePlay}
          aria-label={
            playing
              ? variant === "assistant"
                ? "Pause voice summary"
                : "Pause voice note"
              : variant === "assistant"
                ? "Play voice summary"
                : "Play voice note"
          }
        >
          {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>

        <div className="voice-track-col">
          <div className="voice-meta-row">
            <span className="voice-badge">
              {variant === "assistant" ? <VolumeIcon size={13} /> : <MicIcon size={13} />}
              <span>{badgeTitle}</span>
            </span>
            <span className="voice-time">
              {formatClock(currentTime)}
              {duration > 0 ? ` / ${formatClock(duration)}` : ""}
            </span>
          </div>

          <label htmlFor={sliderId} className="sr-only">
            {variant === "assistant" ? "Seek voice summary" : "Seek voice note"}
          </label>
          <input
            id={sliderId}
            type="range"
            className="voice-slider"
            min={0}
            max={maxSec}
            step={0.05}
            value={Math.min(currentTime, maxSec)}
            onChange={(e) => {
              const next = Number(e.target.value);
              setCurrentTime(next);
              if (audioRef.current) audioRef.current.currentTime = next;
            }}
          />
        </div>
      </div>

      {summaryText && (
        <details id={detailsId} className="voice-summary-details">
          <summary className="voice-summary-toggle">View spoken summary transcript</summary>
          <p className="voice-summary-body">{summaryText}</p>
        </details>
      )}
    </div>
  );
}

