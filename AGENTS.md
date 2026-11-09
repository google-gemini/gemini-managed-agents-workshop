# AGENTS.md

Welcome! You are assisting a developer attending the 40-minute AIE Code Summit workshop: Building a GitHub PR Reviewer with Gemini Managed Agents, Skills, the Credentials API, and Remote MCP.

## Source of Truth (Read First)

Before writing or editing any Gemini API code, read `.agents/skills/gemini-managed-agents/SKILL.md`.
Gemini Managed Agents (`antigravity-preview-09-2026`), `agents.create`, `credentials.create`, `environments`, and `interactions.create` launched after your training cutoff. Never use legacy `generateContent`, `@google/generative-ai`, `google-generativeai`, or `gemini-1.5-*` / `gemini-2.0-*` / `gemini-2.5-*` models.

## Strict Workshop Rule on `solution/`

Do NOT read, inspect, list, or copy files from `solution/` unless the user explicitly asks to compare with the reference solution or catch up to a later step. Let the developer build Steps 1 through 4 in the root workspace (`agent/`, `scripts/`, and `server/`).

## Repository Layout

- `.agents/skills/gemini-managed-agents/SKILL.md`: Authoritative SDK (`@google/genai` v3.0.0) and REST helper (`./server/gemini.ts`) reference.
- `agent/`: Custom PR Reviewer instructions (`agent/AGENTS.md`) and on-demand skill (`agent/skills/pr-review/SKILL.md` + scripts) created in Step 2.
- `scripts/dev.ts`: Runs `vite build --watch` and the Bun server watcher.
- `scripts/sync-agent.ts`: Step 2 CLI script to bundle and register `agent/` as saved agent `pr-reviewer`.
- `server/`: Express + SSE backend bound to `127.0.0.1`. Core plumbing (`config.ts`, `gemini.ts`, `agentDefinition.ts`, `agentStream.ts`, `security.ts`, `janitor.ts`, `app.ts`, `index.ts`) is ready; wire `server/auth.ts` and `server/chat.ts` in Step 4.
- `web/`: React chat and Credential Vault Inspector UI.
- `slides/`: Self-contained HTML workshop slide deck served at `/slides` and `/workshop`.
- `tmp/`: Scratch directory for temporary scripts or test outputs (never write to `/tmp`).

## Commands & Tooling

- Always use `bun` for TypeScript/JavaScript execution and `uv` when running Python locally. Do not run `bun install` unless adding a requested package (`node_modules` is pre-installed).
- `bun run dev`: Build and watch `web/` + run `server/index.ts` at `http://localhost:3000` (slides at `http://localhost:3000/slides`).
- `bun run agent:sync`: Sync `agent/` into the saved Managed Agent `pr-reviewer`.
- `bun run typecheck`: Typecheck `server/`, `scripts/`, and `web/`.
- `bun test`: Run the Bun test suite.

## Security Invariants

1. Keep the Express server bound strictly to `127.0.0.1` (`localhost`).
2. Never log, return, or store raw `GITHUB_TOKEN` or OAuth `access_token` values in `req.session` or browser JSON responses. Store secrets immediately in the write-only Gemini Credential Vault (`credentials.create` / `gemini.createBearerCredential`) and keep only the `credentialId` in `req.session.credentialId`.
3. Keep `csrfProtection` enabled on all state-changing `/api/*` endpoints and omit `url_context` when reviewing untrusted pull requests.
