import { useLayoutEffect, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { SendIcon, StopIcon } from "./Icons";

/** Mirrors the server-side limit in server/chat.ts. */
export const MAX_MESSAGE_CHARS = 4000;
const MAX_INPUT_HEIGHT = 200;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

export function Composer({ value, onChange, onSend, onStop, busy, inputRef }: ComposerProps) {
  // Auto-grow via CSSOM (strict CSP safe).
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [value, inputRef]);

  const length = value.trim().length;
  const canSend = !busy && length > 0 && length <= MAX_MESSAGE_CHARS;
  const showCount = value.length > MAX_MESSAGE_CHARS * 0.9;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSend) onSend();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <div className={`composer-box${busy ? " is-busy" : ""}`}>
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={value}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder="Ask about any GitHub pull request…"
          aria-label="Message PR Reviewer"
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
      <p className="composer-note">
        {showCount ? (
          <span className="composer-count">
            {value.length.toLocaleString()} / {MAX_MESSAGE_CHARS.toLocaleString()}
          </span>
        ) : (
          "Gemini Managed Agents · GitHub MCP · Credentials API Vault"
        )}
      </p>
    </form>
  );
}
