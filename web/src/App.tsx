import { useCallback, useEffect, useState } from "react";
import { fetchSession } from "./api";
import { ChatView } from "./components/ChatView";
import { Sparkle } from "./components/Logo";
import { SignIn } from "./components/SignIn";
import type { Me, SignedOutMeta } from "./types";

type AppState =
  | { phase: "loading" }
  | { phase: "signedOut"; notice: string | null; meta: SignedOutMeta | null }
  | { phase: "ready"; me: Me }
  | { phase: "offline" };

const AUTH_ERRORS = new Set([
  "denied",
  "failed",
  "expired",
  "not_allowed",
  "vault",
  "gemini_unconfigured",
  "github_unconfigured",
  "unconfigured",
  "pat_invalid",
  "starter_todo",
]);

/** Reads ?auth_error=… once (allow-listed, never rendered raw) and strips it from the URL bar. */
function takeAuthError(): string | null {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("auth_error");
  if (code === null) return null;
  url.searchParams.delete("auth_error");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return AUTH_ERRORS.has(code) ? code : "failed";
}

// Module scope so it runs once even under React StrictMode double-mounting.
const initialAuthError = takeAuthError();

export function App() {
  const [state, setState] = useState<AppState>({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const result = await fetchSession();
      if (result.authenticated) {
        setState({ phase: "ready", me: result.me });
      } else {
        setState({ phase: "signedOut", notice: initialAuthError, meta: result.meta });
      }
    } catch {
      setState({ phase: "offline" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Unmounting ChatView drops every piece of client-side conversation state.
  const onSessionExpired = useCallback(() => {
    setState({ phase: "signedOut", notice: "session_expired", meta: null });
  }, []);

  switch (state.phase) {
    case "loading":
      return (
        <div className="boot" aria-busy="true" aria-label="Loading RepoReview">
          <Sparkle size={44} className="boot-spark" />
        </div>
      );
    case "offline":
      return (
        <div className="boot">
          <div className="boot-card" role="alert">
            <Sparkle size={36} />
            <h1>Can't reach RepoReview</h1>
            <p>The workshop server didn't respond. Make sure it's running, then try again.</p>
            <button type="button" className="btn btn-filled" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      );
    case "signedOut":
      return <SignIn notice={state.notice} meta={state.meta} />;
    case "ready":
      return <ChatView me={state.me} onSessionExpired={onSessionExpired} />;
  }
}
