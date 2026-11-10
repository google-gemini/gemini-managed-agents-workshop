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

import type { SignedOutMeta } from "../types";
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
import { Sparkle } from "./Logo";

// Only allow-listed codes are ever displayed; unknown values fall back to a safe generic message.
const NOTICES: Record<string, string> = {
  denied: "GitHub authorization was cancelled. GitHub access is needed to inspect pull requests.",
  failed: "Sign-in didn't complete. Please try again.",
  expired: "Sign-in took too long. Please try again.",
  not_allowed: "This GitHub account isn't on the allowed list for this instance.",
  vault:
    "Your GitHub token couldn't be stored in the Gemini credential vault. Check GEMINI_API_KEY and server logs, then try again.",
  gemini_unconfigured:
    "GEMINI_API_KEY isn't set yet. Add GEMINI_API_KEY to .env and restart the workshop server.",
  github_unconfigured:
    "GitHub OAuth isn't configured yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env and restart.",
  unconfigured:
    "GitHub OAuth isn't configured yet. Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env and restart.",
  pat_invalid: "The configured GitHub token was rejected by GitHub. Verify the token and restart the server.",
  starter_todo:
    "Starter step incomplete — open Workshop Slides to wire up the Gemini Credential Vault in server/.",
  session_expired: "Your session ended. Sign in again to continue reviewing pull requests.",
};

const ASSURANCES = [
  {
    Icon: LockIcon,
    tone: "blue",
    title: "Write-only Credentials API vault",
  },
  {
    Icon: TerminalIcon,
    tone: "green",
    title: "Remote GitHub MCP and Linux sandbox",
  },
  {
    Icon: ShieldIcon,
    tone: "purple",
    title: "Automatic vault and sandbox cleanup on sign-out",
  },
] as const;

function authStatus(meta: SignedOutMeta | null): { label: string; ready: boolean } {
  if (meta?.hasGithubOAuth || meta?.hasGithubPat) {
    return { label: "GitHub OAuth ready", ready: true };
  }
  if (meta && meta.hasGithubOAuth === false && meta.hasGithubPat === false) {
    return { label: "OAuth not configured", ready: false };
  }
  return { label: "GitHub OAuth ready", ready: true };
}

interface SignInProps {
  notice: string | null;
  meta: SignedOutMeta | null;
}

export function SignIn({ notice, meta }: SignInProps) {
  const message = notice ? (NOTICES[notice] ?? NOTICES.failed) : null;
  const isInfo = notice === "session_expired";
  const auth = authStatus(meta);

  return (
    <div className="signin">
      <header className="signin-header">
        <a className="nav-pill" href="/slides" target="_blank" rel="noopener noreferrer">
          <SlidesIcon size={16} />
          <span>Workshop Slides</span>
          <ExternalIcon size={14} />
        </a>
      </header>

      <main className="signin-main">
        <section className="signin-hero" aria-labelledby="signin-title">
          <h1 id="signin-title" className="signin-title">
            Review GitHub PRs in a sandbox
          </h1>
          <p className="signin-lede">
            Inspect pull requests via GitHub MCP and run tests without exposing your token.
          </p>

          {message && (
            <div className={`alert${isInfo ? " alert-info" : ""}`} role={isInfo ? "status" : "alert"}>
              <ErrorIcon size={20} />
              <span>{message}</span>
            </div>
          )}

          <div className="signin-actions">
            <a className="github-btn" href="/auth/github">
              <GitHubIcon size={20} />
              <span>Sign in with GitHub</span>
            </a>
            <span className={`auth-detect${auth.ready ? " is-ready" : " is-warn"}`}>
              <span className="auth-detect-dot" aria-hidden="true" />
              {auth.label}
            </span>
          </div>

          <ul className="assurances">
            {ASSURANCES.map(({ Icon, tone, title }) => (
              <li key={title}>
                <span className={`assurance-icon tone-${tone}`}>
                  <Icon size={17} />
                </span>
                <span className="assurance-title">{title}</span>
              </li>
            ))}
          </ul>
        </section>

        <PreviewCard />
      </main>
    </div>
  );
}

/** Decorative preview of a live PR review turn. */
function PreviewCard() {
  return (
    <section className="preview" aria-hidden="true">
      <div className="preview-top">
        <span className="preview-label">PR Review</span>
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
          <div className="bubble">Review the latest open PR on google/budoux</div>
        </div>

        <div className="msg msg-assistant">
          <div className="msg-avatar">
            <Sparkle size={20} />
          </div>
          <div className="msg-body">
            <div className="preview-steps">
              <span className="preview-step is-mcp">
                <GitHubIcon size={13} />
                GitHub MCP · list_pull_requests
                <CheckIcon size={13} className="preview-step-ok" />
              </span>
              <span className="preview-step is-mcp">
                <GitHubIcon size={13} />
                GitHub MCP · pull_request_read
                <CheckIcon size={13} className="preview-step-ok" />
              </span>
            </div>

            <div className="verdict-card">
              <div className="verdict-head">
                <span className="verdict-pill">
                  <MergeIcon size={14} />
                  APPROVE
                </span>
                <span className="verdict-pr">PR #1508</span>
              </div>
              <div className="md">
                <ul>
                  <li>
                    <strong>Summary:</strong> Exact 1D Newton LogitBoost update in <code>scripts/train.py</code>.
                  </li>
                  <li>
                    <strong>Findings:</strong> Clean bounds check and unit coverage; no blocking issues found.
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="preview-composer">
        <span>Ask about any GitHub PR…</span>
        <span className="preview-send">
          <Sparkle size={16} />
        </span>
      </div>
    </section>
  );
}
