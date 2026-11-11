import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fetchMe, HttpError, resetChat, signOut, streamChat, streamVoiceChat } from "../api";
import type { ChatEvent, Me, Message, MessageStatus, Step, TtsVoiceName } from "../types";
import { Composer } from "./Composer";
import { GuidedTour, hasSeenTour, markTourSeen, TOUR_STOPS } from "./GuidedTour";
import {
  ExpandIcon,
  ExternalIcon,
  GitHubIcon,
  MergeIcon,
  ShieldIcon,
  SlidesIcon,
  TerminalIcon,
} from "./Icons";
import { AssistantMessage, UserMessage } from "./MessageView";
import { TopBar } from "./TopBar";
import { VaultDrawer } from "./VaultDrawer";

const STAGE_SUGGESTIONS = [
  {
    tag: "MCP + Sandbox Verdict",
    text: "Review the latest open pull request on google/budoux, run its unit tests in the sandbox, and give a merge verdict",
    Icon: MergeIcon,
  },
  {
    tag: "Bugfix Smoke Test",
    text: "List open PRs on ChromeDevTools/chrome-devtools-mcp via GitHub MCP and smoke-test the newest bugfix PR",
    Icon: GitHubIcon,
  },
  {
    tag: "Go Unit Suite",
    text: "Inspect the newest open PR on google-gemini/gemini-api-cli and verify its Go unit tests pass in /workspace",
    Icon: TerminalIcon,
  },
  {
    tag: "Zero-Secret Proof",
    text: "Verify your sandbox security: call api.github.com/user, then check os.environ and /proc to prove no GitHub token is inside the container",
    Icon: ShieldIcon,
  },
] as const;

/** SSE events are applied in small batches so fast token streams don't re-render markdown per chunk. */
const FLUSH_MS = 40;

function settle(steps: Step[] | undefined): Step[] | undefined {
  return steps?.map((s): Step => (s.state === "running" ? { ...s, state: "done" } : s));
}

function applyEvent(m: Message, ev: ChatEvent): Message {
  switch (ev.event) {
    case "status":
      return { ...m, liveStatus: ev.data.text };
    case "step": {
      const step = ev.data.step;
      const steps = m.steps ?? [];
      const i = steps.findIndex((s) => s.id === step.id);
      return { ...m, steps: i === -1 ? [...steps, step] : steps.map((s, j) => (j === i ? step : s)) };
    }
    case "stepdone": {
      const { id, ok } = ev.data;
      return {
        ...m,
        steps: (m.steps ?? []).map((s): Step => (s.id === id ? { ...s, state: ok ? "done" : "error" } : s)),
      };
    }
    case "text":
      return { ...m, text: m.text + ev.data.delta };
    case "audio":
      return {
        ...m,
        voice: {
          audioUrl: ev.data.audioUrl,
          mimeType: ev.data.mimeType,
          ...(ev.data.voice ? { voice: ev.data.voice } : {}),
          ...(ev.data.summaryText ? { summaryText: ev.data.summaryText } : {}),
        },
      };
    case "error":
      return { ...m, error: ev.data.message };
    case "done":
      return { ...m, status: ev.data.status, liveStatus: undefined, steps: settle(m.steps) };
    default:
      return m;
  }
}

function isRetryable(m: Message): boolean {
  return m.status === "error" || m.status === "stopped" || m.status === "incomplete";
}

function describeFailure(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 409) return "Another review is still running. Wait for it to finish, then try again.";
    if (err.status === 429) return "Rate limit reached. Wait a few seconds, then try again.";
    if (err.status === 400 || err.status === 413) return "That prompt couldn't be sent. Keep it under 4,000 characters.";
    if (err.status === 403) return "The request was blocked for security reasons. Reload the page and try again.";
    return "RepoReview's server ran into a problem. Check server logs and try again.";
  }
  return "Couldn't reach RepoReview's server. Make sure it's running, then try again.";
}

async function withCsrf<T>(tokenRef: { current: string }, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(tokenRef.current);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 403 && err.code === "csrf")) throw err;
    const fresh = await fetchMe();
    if (!fresh) throw new HttpError(401, "unauthenticated");
    tokenRef.current = fresh.csrfToken;
    return call(tokenRef.current);
  }
}

function focusIfDesktop(el: HTMLTextAreaElement | null): void {
  if (el && window.matchMedia("(pointer: fine)").matches) el.focus();
}

function Welcome({
  name,
  disabled,
  onPick,
}: {
  name: string;
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div className="welcome">
      <h1 className="welcome-title">
        <span className="gradient-text">Ready to review, {name}</span>
      </h1>
      <p className="welcome-sub">Pick a live repository triage prompt or paste any GitHub PR</p>
      <div className="suggestions" data-tour="steps">
        {STAGE_SUGGESTIONS.map(({ tag, text, Icon }) => (
          <button key={text} type="button" className="suggestion" disabled={disabled} onClick={() => onPick(text)}>
            <div className="suggestion-top">
              <span className="suggestion-tag">{tag}</span>
              <span className="suggestion-text">{text}</span>
            </div>
            <span className="suggestion-icon">
              <Icon size={19} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface ChatViewProps {
  me: Me;
  onSessionExpired: () => void;
}

export function ChatView({ me, onSessionExpired }: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>(() => me.messages ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [elevated, setElevated] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [vaultOpen, setVaultOpen] = useState(false);
  const [activeEnvId, setActiveEnvId] = useState<string | null>(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceName, setVoiceName] = useState<TtsVoiceName>("Kore");
  const [autoPlayVoice, setAutoPlayVoice] = useState(true);
  const [autoPlayTargetId, setAutoPlayTargetId] = useState<string | null>(null);
  const lastVoiceTurnRef = useRef<{ blob: Blob; mimeType: string; durationSec: number } | null>(null);
  const blobUrlsRef = useRef<string[]>([]);

  // Auto-open the 4-stop spotlight tour once on first sign-in in solution or configured mode.
  const [tourActive, setTourActive] = useState<boolean>(() => {
    const autoEligible = me.workshopMode === "solution" || me.workshopMode === "configured";
    return autoEligible && !hasSeenTour();
  });
  const [tourStep, setTourStep] = useState(0);

  const csrfRef = useRef(me.csrfToken);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(messages);
  const expiredRef = useRef(onSessionExpired);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    expiredRef.current = onSessionExpired;
  }, [onSessionExpired]);
  useEffect(() => {
    return () => {
      for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
      blobUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!tourActive) focusIfDesktop(inputRef.current);
    return () => abortRef.current?.abort();
  }, [tourActive]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleTourStepChange = useCallback((nextIndex: number) => {
    const clamped = Math.max(0, Math.min(TOUR_STOPS.length - 1, nextIndex));
    const nextStop = TOUR_STOPS[clamped];
    setTourStep(clamped);
    // Automatically open VaultDrawer on Stop 2 ("vault") and close it when leaving Stop 2.
    setVaultOpen(nextStop?.id === "vault");
  }, []);

  const handleStartTour = useCallback(() => {
    setVaultOpen(false);
    setTourStep(0);
    setTourActive(true);
  }, []);

  const handleCloseTour = useCallback(() => {
    markTourSeen();
    setTourActive(false);
    if (TOUR_STOPS[tourStep]?.id === "vault") {
      setVaultOpen(false);
    }
    focusIfDesktop(inputRef.current);
  }, [tourStep]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinnedRef.current = bottom;
    setAtBottom(bottom);
    setElevated(el.scrollTop > 2);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setAnnouncement("");

    const botId = crypto.randomUUID();
    pinnedRef.current = true;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", text },
      { id: botId, role: "assistant", text: "", status: "streaming", steps: [], liveStatus: "Connecting to agent" },
    ]);
    focusIfDesktop(inputRef.current);

    const update = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === botId ? fn(m) : m)));
    const finish = (patch: Partial<Message>) =>
      update((m) => ({ ...m, ...patch, liveStatus: undefined, steps: settle(m.steps) }));

    let queue: ChatEvent[] = [];
    let timer: number | undefined;
    const flush = () => {
      window.clearTimeout(timer);
      timer = undefined;
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      update((m) => batch.reduce(applyEvent, m));
    };

    const outcome: { status: MessageStatus | null } = { status: null };
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await withCsrf(csrfRef, (token) =>
        streamChat(text, token, controller.signal, (ev) => {
          if (ev.event === "done") {
            outcome.status = ev.data.status;
            if (ev.data.environmentId) setActiveEnvId(ev.data.environmentId);
          }
          queue.push(ev);
          timer ??= window.setTimeout(flush, FLUSH_MS);
        }),
      );
      flush();
      if (outcome.status === null) {
        finish({ status: "error", error: "The connection closed before the review finished." });
      }
      setAnnouncement(outcome.status === "completed" ? "Review ready" : "Response ended");
    } catch (err) {
      flush();
      if (controller.signal.aborted) {
        finish({ status: "stopped" });
        setAnnouncement("Review stopped");
      } else if (err instanceof HttpError && err.status === 401) {
        expiredRef.current();
      } else {
        finish({ status: "error", error: describeFailure(err) });
        setAnnouncement("Something went wrong");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const sendVoice = useCallback(
    async (blob: Blob, mimeType: string, durationSec: number) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setNotice(null);
      setAnnouncement("");
      lastVoiceTurnRef.current = { blob, mimeType, durationSec };

      const localUrl = URL.createObjectURL(blob);
      blobUrlsRef.current.push(localUrl);

      const localUserId = crypto.randomUUID();
      const botId = crypto.randomUUID();
      setAutoPlayTargetId(botId);
      pinnedRef.current = true;

      setMessages((prev) => [
        ...prev,
        {
          id: localUserId,
          role: "user",
          text: "Voice note",
          voice: {
            audioUrl: localUrl,
            mimeType,
            durationSec,
            transcribing: true,
          },
        },
        {
          id: botId,
          role: "assistant",
          text: "",
          status: "streaming",
          steps: [],
          liveStatus: "Staging voice note in sandbox",
        },
      ]);

      const updateAssistant = (fn: (m: Message) => Message) =>
        setMessages((prev) => prev.map((m) => (m.id === botId ? fn(m) : m)));
      const updateUser = (fn: (m: Message) => Message) =>
        setMessages((prev) => prev.map((m) => (m.id === localUserId ? fn(m) : m)));
      const finish = (patch: Partial<Message>) => {
        updateUser((m) => (m.voice ? { ...m, voice: { ...m.voice, transcribing: false } } : m));
        updateAssistant((m) => ({ ...m, ...patch, liveStatus: undefined, steps: settle(m.steps) }));
      };

      let queue: ChatEvent[] = [];
      let timer: number | undefined;
      const flush = () => {
        window.clearTimeout(timer);
        timer = undefined;
        if (queue.length === 0) return;
        const batch = queue;
        queue = [];
        updateAssistant((m) => batch.reduce(applyEvent, m));
      };

      const outcome: { status: MessageStatus | null } = { status: null };
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await withCsrf(csrfRef, (token) =>
          streamVoiceChat(blob, { mimeType, durationSec, voice: voiceName }, token, controller.signal, (ev) => {
            if (ev.event === "user_voice") {
              updateUser((m) => ({
                ...m,
                voice: {
                  audioUrl: ev.data.audioUrl,
                  mimeType: ev.data.mimeType,
                  durationSec: ev.data.durationSec ?? m.voice?.durationSec,
                  transcribing: m.voice?.transcribing ?? true,
                },
              }));
              return;
            }
            if (ev.event === "transcript") {
              updateUser((m) => ({
                ...m,
                text: ev.data.transcript,
                ...(m.voice ? { voice: { ...m.voice, transcribing: false } } : {}),
              }));
              return;
            }
            if (ev.event === "done") {
              outcome.status = ev.data.status;
              if (ev.data.environmentId) setActiveEnvId(ev.data.environmentId);
              updateUser((m) => (m.voice ? { ...m, voice: { ...m.voice, transcribing: false } } : m));
            }
            queue.push(ev);
            timer ??= window.setTimeout(flush, FLUSH_MS);
          }),
        );
        flush();
        if (outcome.status === null) {
          finish({ status: "error", error: "The connection closed before the voice review finished." });
        }
        setAnnouncement(outcome.status === "completed" ? "Voice summary and review ready" : "Response ended");
      } catch (err) {
        flush();
        if (controller.signal.aborted) {
          finish({ status: "stopped" });
          setAnnouncement("Review stopped");
        } else if (err instanceof HttpError && err.status === 401) {
          expiredRef.current();
        } else {
          finish({ status: "error", error: describeFailure(err) });
          setAnnouncement("Something went wrong");
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    },
    [voiceName],
  );

  const submitDraft = useCallback(() => {
    if (!draft.trim() || busyRef.current) return;
    setDraft("");
    lastVoiceTurnRef.current = null;
    void send(draft);
  }, [draft, send]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const retryLast = useCallback(() => {
    const lastUser = messagesRef.current.findLast((m) => m.role === "user");
    if (!lastUser) return;
    if (lastUser.voice && lastVoiceTurnRef.current && (!lastUser.text || lastUser.text === "Voice note")) {
      const { blob, mimeType, durationSec } = lastVoiceTurnRef.current;
      void sendVoice(blob, mimeType, durationSec);
      return;
    }
    void send(lastUser.text);
  }, [send, sendVoice]);

  const newChat = useCallback(async () => {
    if (busyRef.current) return;
    try {
      await withCsrf(csrfRef, (token) => resetChat(token));
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        expiredRef.current();
        return;
      }
      setNotice(
        err instanceof HttpError && err.status === 409
          ? "Wait for the active review to finish first."
          : "Couldn't reset the sandbox. Please try again.",
      );
      return;
    }
    for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
    blobUrlsRef.current = [];
    lastVoiceTurnRef.current = null;
    setAutoPlayTargetId(null);
    pinnedRef.current = true;
    setAtBottom(true);
    setElevated(false);
    setMessages([]);
    setActiveEnvId(null);
    setNotice("Conversation and sandbox reset");
    setAnnouncement("Conversation and sandbox reset");
    focusIfDesktop(inputRef.current);
  }, []);

  const handleSignOut = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setDraft("");
    setActiveEnvId(null);
    setVaultOpen(false);
    setTourActive(false);
    void signOut(csrfRef.current);
  }, []);

  const lastIndex = messages.length - 1;
  const lastAssistantIndex = messages.findLastIndex((m) => m.role === "assistant");
  const displayName = me.givenName || me.name || me.login;

  return (
    <div className="chat">
      <TopBar
        me={me}
        elevated={elevated}
        busy={busy}
        vaultOpen={vaultOpen}
        onOpenVault={() => setVaultOpen((v) => !v)}
        onStartTour={handleStartTour}
        onNewChat={() => void newChat()}
        onSignOut={handleSignOut}
      />

      {me.workshopMode === "starter" && (
        <div className="starter-banner" role="region" aria-label="Workshop starter status">
          <SlidesIcon size={16} />
          <span>
            Starter workspace running — follow Steps 1–4 in{" "}
            <a href="/slides" target="_blank" rel="noopener noreferrer">
              /slides <ExternalIcon size={12} />
            </a>{" "}
            to connect your saved agent, Vault credential, and GitHub MCP.
          </span>
        </div>
      )}

      <main className="chat-main">
        <div ref={scrollRef} className="scroller" onScroll={onScroll}>
          {messages.length === 0 ? (
            <Welcome name={displayName} disabled={busy} onPick={(text) => void send(text)} />
          ) : (
            <div className="thread" role="log" aria-label="PR Review Conversation" aria-live="off">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <UserMessage key={m.id} message={m} />
                ) : (
                  <AssistantMessage
                    key={m.id}
                    message={m}
                    isTourTarget={i === lastAssistantIndex}
                    autoPlayVoice={autoPlayVoice && m.id === autoPlayTargetId}
                    onRetry={i === lastIndex && !busy && isRetryable(m) ? retryLast : undefined}
                  />
                ),
              )}
            </div>
          )}
        </div>
        {!atBottom && messages.length > 0 && (
          <button
            type="button"
            className="jump"
            onClick={scrollToBottom}
            aria-label="Scroll to the latest message"
          >
            <ExpandIcon size={22} />
          </button>
        )}
      </main>

      <div className="composer-dock">
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={submitDraft}
          onSendVoice={(blob, mimeType, durationSec) => void sendVoice(blob, mimeType, durationSec)}
          onStop={stop}
          onErrorNotice={setNotice}
          busy={busy}
          voiceMode={voiceMode}
          onVoiceModeChange={setVoiceMode}
          voiceName={voiceName}
          onVoiceNameChange={setVoiceName}
          autoPlayVoice={autoPlayVoice}
          onAutoPlayVoiceChange={setAutoPlayVoice}
          inputRef={inputRef}
        />
      </div>

      <VaultDrawer
        open={vaultOpen}
        tourActive={tourActive}
        activeEnvOverride={activeEnvId}
        onClose={() => setVaultOpen(false)}
      />

      <GuidedTour
        active={tourActive}
        stepIndex={tourStep}
        onStepChange={handleTourStepChange}
        onClose={handleCloseTour}
      />

      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
