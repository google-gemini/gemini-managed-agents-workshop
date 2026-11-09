import type { SignedOutMeta, WorkshopMode } from "../types";
import {
  CheckIcon,
  ErrorIcon,
  ExternalIcon,
  GitHubIcon,
  LockIcon,
  MergeIcon,
  ShieldIcon,
  SlidesIcon,
  TerminalIcon,
} from "./Icons";
import { Logo, Sparkle } from "./Logo";

// Only allow-listed codes are ever displayed; unknown values fall back to a safe generic message.
const NOTICES: Record<string, string> = {
  denied: "GitHub authorization was cancelled. RepoReview needs GitHub access to inspect pull requests.",
  failed: "Sign-in didn't complete. Please try again.",
  expired: "Sign-in took too long. Please try again.",
  not_allowed: "This GitHub account isn't on the allowed list for this RepoReview instance.",
  vault:
    "Your GitHub token couldn't be stored in the Gemini credential vault. Check GEMINI_API_KEY and server logs, then try again.",
  gemini_unconfigured:
    "GEMINI_API_KEY isn't set yet. Add GEMINI_API_KEY to .env and restart the workshop server.",
  github_unconfigured:
    "GitHub sign-in isn't configured yet. Add GITHUB_TOKEN (or GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET) to .env and restart.",
  unconfigured:
    "GitHub sign-in isn't configured yet. Add GITHUB_TOKEN (or GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET) to .env and restart.",
  pat_invalid: "The GITHUB_TOKEN in .env was rejected by GitHub. Verify the token and restart the server.",
  starter_todo:
    "Starter step incomplete — open Workshop Slides to wire up the Gemini Credential Vault in server/.",
  session_expired: "Your session ended. Sign in again to continue reviewing pull requests.",
};

const ASSURANCES = [
  {
    Icon: LockIcon,
    tone: "blue",
    title: "Zero-trust credential vault",
    text: "OAuth tokens and PATs go straight to Gemini's write-only Credentials API. Browser cookies hold only an opaque vault reference ID.",
  },
  {
    Icon: TerminalIcon,
    tone: "green",
    title: "Remote GitHub MCP + Linux sandbox",
    text: "Structured PR diffs arrive over GitHub MCP while untrusted PR tests execute inside an isolated Ubuntu container with no secrets in env or /proc.",
  },
  {
    Icon: ShieldIcon,
    tone: "purple",
    title: "One-click teardown on sign-out",
    text: "Signing out calls credentials.delete and environments.delete, revoking vault access and destroying the sandbox VM.",
  },
] as const;

function modeLabel(mode: WorkshopMode | undefined): { label: string; tone: string } | null {
  if (mode === "solution") return { label: "Solution", tone: "mode-solution" };
  if (mode === "configured") return { label: "Live", tone: "mode-live" };
  if (mode === "starter") return { label: "Starter", tone: "mode-starter" };
  return null;
}

function authSublabel(meta: SignedOutMeta | null): { badge: string; detail: string; ready: boolean } {
  if (meta?.hasGithubOAuth) {
    return {
      badge: "OAuth App detected",
      detail: "Redirects to GitHub OAuth → stores token directly in Gemini Vault",
      ready: true,
    };
  }
  if (meta?.hasGithubPat) {
    return {
      badge: ".env GITHUB_TOKEN detected",
      detail: "Instant one-click sign-in → seals PAT in Gemini Vault",
      ready: true,
    };
  }
  if (meta && meta.hasGithubOAuth === false && meta.hasGithubPat === false) {
    return {
      badge: "Auth not configured",
      detail: "Add GITHUB_TOKEN or GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET to .env",
      ready: false,
    };
  }
  return {
    badge: "GitHub → Gemini Vault",
    detail: "Supports GitHub OAuth App or local .env GITHUB_TOKEN",
    ready: true,
  };
}

interface SignInProps {
  notice: string | null;
  meta: SignedOutMeta | null;
}

export function SignIn({ notice, meta }: SignInProps) {
  const message = notice ? (NOTICES[notice] ?? NOTICES.failed) : null;
  const isInfo = notice === "session_expired";
  const auth = authSublabel(meta);
  const badge = modeLabel(meta?.workshopMode);

  return (
    <div className="signin">
      <div className="signin-bg" aria-hidden="true">
        <span className="orb orb-1" />
        <span className="orb orb-2" />
        <span className="orb orb-3" />
      </div>

      <header className="signin-header">
        <div className="signin-brand">
          <Logo />
          {badge && <span className={`mode-badge ${badge.tone}`}>{badge.label}</span>}
        </div>
        <a className="nav-pill" href="/slides" target="_blank" rel="noopener noreferrer">
          <SlidesIcon size={16} />
          <span>Workshop Slides &amp; Prompts</span>
          <ExternalIcon size={14} />
        </a>
      </header>

      <main className="signin-main">
        <section className="signin-hero" aria-labelledby="signin-title">
          <span className="eyebrow">
            <Sparkle size={14} />
            Powered by Gemini Managed Agents · Credentials API · GitHub MCP
          </span>
          <h1 id="signin-title" className="signin-title">
            Review GitHub PRs in an isolated sandbox,{" "}
            <span className="gradient-text">without exposing your token</span>
          </h1>
          <p className="signin-lede">
            Inspect live pull requests via Remote GitHub MCP, run untrusted test suites inside an ephemeral Ubuntu
            sandbox, and get structured engineering merge verdicts.
          </p>

          {message && (
            <div className={`alert${isInfo ? " alert-info" : ""}`} role={isInfo ? "status" : "alert"}>
              <ErrorIcon size={20} />
              <span>{message}</span>
            </div>
          )}

          <div className="signin-cta">
            <div className="signin-actions">
              <a className="github-btn" href="/auth/github">
                <GitHubIcon size={20} />
                <span>Sign in with GitHub</span>
              </a>
              <span className={`auth-detect${auth.ready ? " is-ready" : " is-warn"}`}>
                <span className="auth-detect-dot" aria-hidden="true" />
                {auth.badge}
              </span>
            </div>
            <p className="signin-sublabel">{auth.detail}</p>
          </div>

          <ul className="assurances">
            {ASSURANCES.map(({ Icon, tone, title, text }) => (
              <li key={title}>
                <span className={`assurance-icon tone-${tone}`}>
                  <Icon size={18} />
                </span>
                <span className="assurance-copy">
                  <strong>{title}</strong>
                  <span>{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <PreviewCard />
      </main>

      <footer className="signin-footer">
        AIE Code Summit Workshop · Tokens are stored write-only via{" "}
        <code>POST /v1beta/credentials</code> and never enter <code>/workspace</code>. Follow{" "}
        <a href="/slides" target="_blank" rel="noopener noreferrer">
          Workshop Slides
        </a>{" "}
        for guided steps.
      </footer>
    </div>
  );
}

/** Decorative stage preview of a live RepoReview PR triage turn. */
function PreviewCard() {
  return (
    <section className="preview" aria-hidden="true">
      <div className="preview-top">
        <Logo size={18} />
        <span className="scope-chip">
          <GitHubIcon size={14} />
          GitHub MCP
          <span className="scope-chip-sep">·</span>
          <LockIcon size={13} />
          Vault + Sandbox
        </span>
      </div>

      <div className="preview-thread">
        <div className="msg msg-user">
          <div className="bubble">
            Review the latest open PR on google/budoux and run its unit tests
          </div>
        </div>

        <div className="msg msg-assistant">
          <div className="msg-avatar">
            <Sparkle size={22} />
          </div>
          <div className="msg-body">
            <div className="preview-steps">
              <span className="preview-step is-mcp">
                <GitHubIcon size={13} />
                GitHub MCP · list_pull_requests
                <CheckIcon size={13} className="preview-step-ok" />
              </span>
              <span className="preview-step is-code">
                <TerminalIcon size={13} />
                Sandbox · inspect_pr.py --pr 1508 (60 passed)
                <CheckIcon size={13} className="preview-step-ok" />
              </span>
            </div>

            <div className="verdict-card">
              <div className="verdict-head">
                <span className="verdict-pill">
                  <MergeIcon size={14} />
                  Merge Verdict: Ready to Merge
                </span>
                <span className="verdict-pr">PR #1508 · +64 / -19</span>
              </div>
              <div className="md">
                <ul>
                  <li>
                    <strong>Summary:</strong> Uses exact 1D Newton LogitBoost step with one-sided KKT floor in{" "}
                    <code>scripts/train.py</code>.
                  </li>
                  <li>
                    <strong>Sandbox Tests:</strong> Cloned into <code>/workspace/pr</code> — <strong>60 passed</strong>{" "}
                    in 0.08s with zero regressions.
                  </li>
                  <li>
                    <strong>Risk &amp; Isolation:</strong> Low risk; verified zero GitHub secrets in container{" "}
                    <code>os.environ</code> or <code>/proc</code>.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="preview-composer">
        <span>Ask RepoReview to inspect a GitHub PR or run tests…</span>
        <span className="preview-send">
          <Sparkle size={16} />
        </span>
      </div>
    </section>
  );
}
