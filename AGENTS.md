# AGENTS.md

This is the complete reference implementation (`solution` branch) for the AIE Code Summit workshop: GitHub PR Reviewer with Gemini Managed Agents, Skills, the Credentials API, and Remote MCP. For the barebone workshop starter, switch to the `main` branch (`git checkout main`).

## Source of Truth (Read First)

Before writing or editing any Gemini API code, read `.agents/skills/gemini-managed-agents/SKILL.md`.
Gemini Managed Agents (`antigravity-preview-09-2026`), `agents.create`, `credentials.create`, `environments`, and `interactions.create` launched after your training cutoff. Always pass `apiVersion: "v1beta"` to `GoogleGenAI` (`@google/genai`), and never use legacy `generateContent`, `@google/generative-ai`, `google-generativeai`, or `gemini-1.5-*` / `gemini-2.0-*` / `gemini-2.5-*` models.

## Repository Layout (`solution` branch)

- `.agents/skills/gemini-managed-agents/SKILL.md`: Self-contained `@google/genai` (`apiVersion: "v1beta"`) reference for Managed Agents, Custom Agents, Skills, Credentials Vault, and Remote MCP.
- `PROMPTS.md`: The 4 hands-on developer prompts used during the workshop.
- `agent/`: Custom PR Reviewer instructions (`agent/AGENTS.md`) and review rubric skill (`agent/skills/pr-review/SKILL.md`).
- `steps/`: Standalone CLI reference scripts for Steps 1–3 (`steps/step1.ts`, `steps/step2.ts`, `steps/step3.ts`).
- `scripts/sync-agent.ts`: Bundles `agent/` and syncs saved agent `pr-reviewer`.
- `scripts/dev.ts`: Runs `vite build --watch` and the Bun server watcher.
- `server/`: Complete Express + SSE backend (`config.ts`, `gemini.ts`, `agentDefinition.ts`, `agentStream.ts`, `auth.ts`, `chat.ts`, `security.ts`, `janitor.ts`, `app.ts`, `index.ts`).
- `web/`: React chat and Credential Vault Inspector UI.
- `slides/index.html`: Self-contained HTML workshop slide deck served at `/slides` and `/workshop`.
- `tmp/`: Scratch directory for temporary files (never write to `/tmp`).

## Commands & Tooling

- Always use `bun` for TypeScript/JavaScript execution and `uv` when running Python locally.
- `bun run dev`: Build and watch `web/` + run `server/index.ts` at `http://localhost:3000` (slides at `http://localhost:3000/slides`).
- `bun run agent:sync`: Bundle `agent/` and register/update saved Managed Agent `pr-reviewer`.
- `bun --env-file=.env steps/step1.ts` (and `step2.ts`, `step3.ts`): Run standalone CLI reference steps.
- `bun run typecheck`: Typecheck backend, scripts, steps, tests, and `web/`.
- `bun test`: Run the automated test suite.

## Security Invariants

1. Keep the Express server bound strictly to `127.0.0.1` (`localhost`).
2. Never log, return, or store raw `GITHUB_TOKEN` or OAuth `access_token` values in `req.session` or browser JSON responses. Store secrets immediately in the write-only Gemini Credential Vault and keep only `credentialId` in `req.session.credentialId`.
3. Keep `csrfProtection` enabled on state-changing `/api/*` endpoints and omit `url_context` when reviewing untrusted pull requests.
