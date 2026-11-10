import { useState } from "react";
import type { Me } from "../types";
import { LogoutIcon } from "./Icons";

/** Masks email PII for hover titles (e.g. "p***@google.com"). */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.charAt(0)}***@${domain}`;
}

export function Avatar({ me, size }: { me: Pick<Me, "picture" | "givenName" | "name" | "login">; size: 24 | 32 }) {
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
  vaultOpen: boolean;
  onOpenVault: () => void;
  onSignOut: () => void;
}

export function TopBar({ me, elevated, vaultOpen, onOpenVault, onSignOut }: TopBarProps) {
  const displayName = me.name || me.login;
  const userTitle = me.email ? `${displayName} (${maskEmail(me.email)})` : displayName;

  return (
    <header className={`topbar${elevated ? " is-elevated" : ""}`}>
      <div className="topbar-left">
        <button
          type="button"
          className={`agent-btn${vaultOpen ? " is-active" : ""}`}
          aria-expanded={vaultOpen}
          onClick={onOpenVault}
        >
          Agent
        </button>
      </div>

      <div className="topbar-right">
        <div className="user-profile" title={userTitle}>
          <Avatar me={me} size={24} />
          <span className="user-name">{displayName}</span>
        </div>

        <button
          type="button"
          className="icon-btn logout-btn"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
        >
          <LogoutIcon size={18} />
        </button>
      </div>
    </header>
  );
}
