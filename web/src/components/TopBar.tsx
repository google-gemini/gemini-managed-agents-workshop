import { useState } from "react";
import type { Me, WorkshopMode } from "../types";
import {
  CompassIcon,
  ExternalIcon,
  GitHubIcon,
  KeyIcon,
  LockIcon,
  LogoutIcon,
  RefreshIcon,
  SlidesIcon,
} from "./Icons";

/** Masks email PII for hover titles (e.g. "p***@google.com"). */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.charAt(0)}***@${domain}`;
}

function modeBadge(mode: WorkshopMode): { label: string; className: string; title: string } {
  switch (mode) {
    case "solution":
      return {
        label: "Solution",
        className: "mode-badge mode-solution",
        title: "Running reference solution server",
      };
    case "configured":
      return {
        label: "Live",
        className: "mode-badge mode-live",
        title: "Starter workspace fully configured and live",
      };
    case "starter":
      return {
        label: "Starter",
        className: "mode-badge mode-starter",
        title: "Starter mode — follow Workshop Slides to complete Steps 1–4",
      };
  }
}

export function Avatar({ me, size }: { me: Pick<Me, "picture" | "givenName" | "name" | "login">; size: 22 | 32 }) {
  const [broken, setBroken] = useState(false);
  if (me.picture && !broken) {
    return (
      <img
        className={`avatar avatar-${size}`}
        src={me.picture}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  const initial = (me.givenName || me.name || me.login || "?").trim().charAt(0).toUpperCase();
  return (
    <span className={`avatar avatar-${size} avatar-fallback`} aria-hidden="true">
      {initial}
    </span>
  );
}

interface TopBarProps {
  me: Me;
  elevated: boolean;
  busy: boolean;
  vaultOpen: boolean;
  onOpenVault: () => void;
  onStartTour: () => void;
  onNewChat: () => void;
  onSignOut: () => void;
}

export function TopBar({
  me,
  elevated,
  busy,
  vaultOpen,
  onOpenVault,
  onStartTour,
  onNewChat,
  onSignOut,
}: TopBarProps) {
  const badge = modeBadge(me.workshopMode);
  const authLabel = me.authMode === "oauth" ? "OAuth" : "PAT → Vault";
  const sessionTitle = me.email
    ? `Signed in as @${me.login} (${maskEmail(me.email)}) · Cookie holds vault reference ID only`
    : `Signed in as @${me.login} · Cookie holds vault reference ID only`;

  return (
    <header className={`topbar${elevated ? " is-elevated" : ""}`}>
      <div className="topbar-left">
        <div className="session-pill" data-tour="session" title={sessionTitle}>
          <Avatar me={me} size={22} />
          <GitHubIcon size={14} className="session-gh" />
          <span className="session-login">@{me.login}</span>
          <span className="session-auth-badge">
            <LockIcon size={12} />
            {authLabel}
          </span>
        </div>
        <span className={badge.className} title={badge.title}>
          {badge.label}
        </span>
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className={`nav-pill${vaultOpen ? " is-active" : ""}`}
          data-tour="vault"
          aria-expanded={vaultOpen}
          onClick={onOpenVault}
          title="Inspect saved agent, MCP allowlist, and live Gemini Credential Vault"
        >
          <span className="live-dot on" aria-hidden="true" />
          <KeyIcon size={15} />
          <span className="hide-md">Vault &amp; Agent</span>
        </button>

        <button
          type="button"
          className="topbar-btn"
          onClick={onStartTour}
          title="Start 4-stop architecture spotlight tour"
        >
          <CompassIcon size={17} />
          <span className="hide-lg">Tour</span>
        </button>

        <a
          className="topbar-btn topbar-link"
          href="/slides"
          target="_blank"
          rel="noopener noreferrer"
          title="Open Workshop Slides in a new tab"
        >
          <SlidesIcon size={17} />
          <span className="hide-lg">Slides</span>
          <ExternalIcon size={13} className="hide-lg" />
        </a>

        <button
          type="button"
          className="topbar-btn"
          onClick={onNewChat}
          disabled={busy}
          title="Reset conversation and sandbox environment"
        >
          <RefreshIcon size={17} />
          <span className="hide-md">Reset Sandbox</span>
        </button>

        <button
          type="button"
          className="topbar-btn topbar-signout"
          data-tour="signout"
          onClick={onSignOut}
          title="Sign out, delete vault credential, and tear down Linux sandbox"
        >
          <LogoutIcon size={17} />
          <span className="hide-sm">Sign Out</span>
        </button>
      </div>
    </header>
  );
}
