import { useCallback, useEffect, useRef, useState } from "react";
import { fetchVault } from "../api";
import type { VaultCredential, VaultStatus } from "../types";
import {
  CheckIcon,
  CloseIcon,
  CodeIcon,
  FolderIcon,
  GitHubIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  RefreshIcon,
  ShieldIcon,
} from "./Icons";

const POLL_MS = 4000;

function ago(iso: string | null, now: number): string {
  if (!iso) return "just now";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "just now";
  const s = Math.max(0, Math.round((now - parsed) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

interface VaultDrawerProps {
  open: boolean;
  tourActive: boolean;
  activeEnvOverride: string | null;
  onClose: () => void;
}

export function VaultDrawer({ open, tourActive, activeEnvOverride, onClose }: VaultDrawerProps) {
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const seenRef = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchVault();
      const ids = new Set((data.credentials ?? []).map((c) => c.id));
      if (seenRef.current) {
        setFresh(new Set([...ids].filter((id) => !seenRef.current!.has(id))));
      }
      seenRef.current = ids;
      setVault(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, load]);

  useEffect(() => {
    if (!open || tourActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, tourActive, onClose]);

  if (!open) return null;

  const creds: VaultCredential[] = vault?.credentials ?? [];
  const skillFiles = vault?.skillFiles ?? [];
  const allowlist = vault?.allowlist ?? [];
  const environmentId = vault?.sessionEnvironmentId || activeEnvOverride;

  return (
    <div className="drawer-layer" role="dialog" aria-modal={!tourActive} aria-labelledby="vault-drawer-title">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="drawer-panel">
        <header className="drawer-header">
          <div className="drawer-title-wrap">
            <span className={`live-dot${!error ? " on" : ""}`} aria-hidden="true" />
            <div>
              <h2 id="vault-drawer-title" className="drawer-title">
                Live Architecture &amp; Credential Vault
              </h2>
              <p className="drawer-subtitle">
                {error ? "Could not reach /api/vault" : "Live state · polling GET /api/vault every 4s"}
              </p>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close Vault inspector" title="Close">
            <CloseIcon size={20} />
          </button>
        </header>

        <div className="drawer-body">
          {/* 1. Agent Harness Card */}
          <section className="inspector-card">
            <div className="inspector-card-head">
              <span className="inspector-card-title">
                <CodeIcon size={16} />
                Agent Harness
              </span>
              <span className={`status-pill ${vault?.agentSynced ? "is-ok" : "is-pending"}`}>
                {vault?.agentSynced ? "Synced" : "Pending sync"}
              </span>
            </div>

            <div className="kv-grid">
              <div className="kv-item">
                <span className="kv-label">agentId</span>
                <code className="kv-val">{vault?.agentId || "pr-reviewer"}</code>
              </div>
              <div className="kv-item">
                <span className="kv-label">agentModel</span>
                <code className="kv-val">{vault?.agentModel || "gemini-3.8-flash"}</code>
              </div>
              <div className="kv-item">
                <span className="kv-label">agentHash</span>
                <code className="kv-val" title={vault?.agentHash ?? undefined}>
                  {vault?.agentHash ? vault.agentHash.slice(0, 12) : "—"}
                </code>
              </div>
            </div>

            <div className="sub-section">
              <span className="sub-label">
                <FolderIcon size={14} />
                Mounted skillFiles in sandbox
              </span>
              {skillFiles.length > 0 ? (
                <div className="file-chips">
                  {skillFiles.map((file) => (
                    <code key={file} className="file-chip">
                      {file}
                    </code>
                  ))}
                </div>
              ) : (
                <p className="empty-inline">
                  No skill files mounted yet. Run <code>bun run agent:sync</code> in Step 2.
                </p>
              )}
            </div>
          </section>

          {/* 2. Network & MCP Card */}
          <section className="inspector-card">
            <div className="inspector-card-head">
              <span className="inspector-card-title">
                <GlobeIcon size={16} />
                Network &amp; Remote MCP
              </span>
              <span className={`status-pill ${vault?.mcpEnabled ? "is-mcp" : "is-pending"}`}>
                {vault?.mcpEnabled ? "GitHub MCP Active" : "MCP Disabled"}
              </span>
            </div>

            <div className="kv-grid kv-grid-2">
              <div className="kv-item">
                <span className="kv-label">Remote MCP Server</span>
                <code className="kv-val">
                  {vault?.mcpEnabled ? "https://api.githubcopilot.com/mcp/" : "not attached"}
                </code>
              </div>
              <div className="kv-item">
                <span className="kv-label">Active Sandbox VM</span>
                <code className="kv-val">{environmentId || "created on first turn"}</code>
              </div>
            </div>

            <div className="sub-section">
              <span className="sub-label">
                <ShieldIcon size={14} />
                Sandbox egress allowlist
              </span>
              {allowlist.length > 0 ? (
                <div className="host-chips">
                  {allowlist.map((host) => (
                    <span key={host} className="host-chip">
                      <GitHubIcon size={12} />
                      <code>{host}</code>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="empty-inline">No egress hosts configured yet.</p>
              )}
            </div>
          </section>

          {/* 3. Live GET /v1beta/credentials Table */}
          <section className="inspector-card inspector-vault-card">
            <div className="vault-table-bar">
              <div className="vault-table-heading">
                <KeyIcon size={15} />
                <code>GET /v1beta/credentials</code>
              </div>
              <div className="vault-table-actions">
                <span className="vault-count">
                  {vault ? `${creds.length} active` : "loading…"}
                </span>
                <button
                  type="button"
                  className="vault-refresh-btn"
                  onClick={() => void load()}
                  disabled={loading}
                  title="Refresh credential list"
                >
                  <RefreshIcon size={14} />
                  <span>Refresh</span>
                </button>
              </div>
            </div>

            <div className="vault-table-wrap">
              <table className="vault-table">
                <thead>
                  <tr>
                    <th>id</th>
                    <th>type</th>
                    <th>status</th>
                    <th>created</th>
                    <th>secret</th>
                  </tr>
                </thead>
                <tbody>
                  {creds.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="vault-empty-cell">
                        {error
                          ? "Unable to query the Gemini Credential Vault. Check server logs."
                          : "No credentials stored yet. Complete Vault wiring or sign in to create one."}
                      </td>
                    </tr>
                  ) : (
                    creds.map((c) => (
                      <tr
                        key={c.id}
                        className={`${c.isCurrentSession ? "is-mine" : ""}${fresh.has(c.id) ? " is-fresh" : ""}`}
                      >
                        <td className="vault-id-cell">
                          <code className="vault-id-code" title={c.id}>
                            {c.id.length > 14 ? `${c.id.slice(0, 9)}…${c.id.slice(-3)}` : c.id}
                          </code>
                          {c.isCurrentSession && <span className="this-session-pill">session</span>}
                        </td>
                        <td>
                          <span className={`type-chip ${c.type === "oauth2" ? "is-oauth" : "is-bearer"}`}>
                            {c.type}
                          </span>
                        </td>
                        <td>
                          <span className="vault-status-cell">
                            <CheckIcon size={14} />
                            {c.status}
                          </span>
                        </td>
                        <td className="vault-age-cell">{ago(c.create_time, now)}</td>
                        <td>
                          <span className="never-returned-pill">
                            <LockIcon size={12} />
                            never returned
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="vault-callout">
              <LockIcon size={15} />
              <span>
                <strong>Write-only by design:</strong> Gemini never returns raw token values on{" "}
                <code>create</code>, <code>get</code>, or <code>list</code> — and the sandbox VM has zero secrets in{" "}
                <code>os.environ</code> or <code>/proc</code>.
              </span>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
