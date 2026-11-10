# AGENTS.md

You are assisting a developer attending the 40-minute AIE Code Summit workshop: Building a GitHub PR Reviewer with Gemini Managed Agents, Skills, the Credentials API, and Remote MCP.

## Source of Truth (Read First)

Before writing or editing any Gemini API code, read `.agents/skills/gemini-managed-agents/SKILL.md`.
Gemini Managed Agents (`antigravity-preview-09-2026`), `agents.create`, `credentials.create`, `environments`, and `interactions.create` launched after your training cutoff. Always use `@google/genai` with `apiVersion: "v1beta"` (`new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" })`). Never use legacy `generateContent`, `@google/generative-ai`, `google-generativeai`, or `gemini-1.5-*` / `gemini-2.0-*` / `gemini-2.5-*` models.

## Barebone Starter Layout (`main` branch)

This `main` branch ships only the frontend UI and a minimal Express server shell—no Managed Agent scripts, agent files, or Gemini wrappers exist yet. You will build them step by step with the developer:

- `.agents/skills/gemini-managed-agents/SKILL.md`: Self-contained `@google/genai` (`apiVersion: "v1beta"`) reference.
- `PROMPTS.md`: Copy-pasteable developer prompts for Steps 1–4.
- `web/`: React chat UI and Credential Vault Inspector (`web/src/api.ts`, `web/src/types.ts`). Already complete; do not break its API contract.
- `server/`: Minimal Express shell bound to `127.0.0.1:3000`:
  - `config.ts`, `types.ts`, `session.d.ts`, `log.ts`, `security.ts`: Loopback config, session types, CSP, rate limiters, and `csrfProtection`.
  - `auth.ts`: Local starter preview sign-in stub (`GET /auth/github`, `GET /auth/github/callback`, `POST /api/auth/logout`).
  - `chat.ts`: Starter stubs for `GET /api/vault`, `POST /api/chat`, and `POST /api/chat/reset`.
  - `app.ts` & `index.ts`: Express app wiring (`GET /api/me`, `/slides`, static `dist/web/`).
- `slides/index.html`: Self-contained workshop slide deck served at `/slides` and `/workshop`.
- `scripts/dev.ts`: Runs `vite build --watch` and `bun --watch --env-file=.env server/index.ts`.
- `tmp/`: Local scratch directory for temporary files (never write to `/tmp`).

## Web UI API & SSE Contract (Step 4)

When wiring the saved `pr-reviewer` agent and Gemini Credential Vault into `server/` in Step 4, `web/` expects these exact routes and shapes (also flip `WORKSHOP_MODE` in `server/chat.ts` to `"configured"`):

1. `GET /auth/github` & `GET /auth/github/callback`:
   - Run GitHub OAuth 2.0 + PKCE S256 (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, callback `http://localhost:3000/auth/github/callback` via `cfg.githubRedirectUri`, scopes `read:user user:email repo`; optionally support `GITHUB_TOKEN` fallback if set).
   - Verify the user via `https://api.github.com/user` (and `/user/emails` fallback if `email` is null).
   - Store the GitHub token in the write-only Gemini Credential Vault via `ai.credentials.create({ id, type: "bearer_token", token })` (use prefix `CREDENTIAL_PREFIX`, e.g. `review-s-<hex>`).
   - Save ONLY `credentialId` in `req.session.credentialId` plus `req.session.user` (`SessionUser`)—never store, log, or return the raw GitHub token. Redirect `303` to `/` (or `/?auth_error=denied|failed|expired|vault|github_unconfigured|gemini_unconfigured` on error).

2. `POST /api/auth/logout`:
   - Destroy `req.session`, clear the session cookie, and delete both `credentialId` (`ai.credentials.delete(credentialId)`) and any active `req.session.chat?.environmentId` (`ai.environments.delete(environmentId)`). Respond `204`.

3. `GET /api/vault`:
   - Return JSON matching `VaultStatus`:
     ```json
     {
       "agentId": "pr-reviewer",
       "agentSynced": true,
       "agentHash": "<sha256-prefix-or-null>",
       "skillFiles": ["AGENTS.md", "skills/pr-review/SKILL.md"],
       "agentModel": "gemini-4-carbon",
       "mcpEnabled": true,
       "allowlist": ["github.com", "*.githubusercontent.com", "api.github.com", "api.githubcopilot.com"],
       "sessionCredentialId": "review-s-...",
       "sessionEnvironmentId": "env_...",
       "credentials": [
         {
           "id": "review-s-...",
           "type": "bearer_token",
           "status": "ACTIVE",
           "create_time": "2026-...",
           "update_time": null,
           "isCurrentSession": true
         }
       ]
     }
     ```

4. `POST /api/chat` (`{ message, timeZone? }`):
   - Stream `Content-Type: text/event-stream; charset=utf-8` (`event: <type>\ndata: <json>\n\n`) from `ai.interactions.create({ agent: "pr-reviewer", ..., stream: true })`, attaching `req.session.credentialId` to `environment.network.allowlist` (`github.com`, `api.github.com`, `api.githubcopilot.com`, plus unauthenticated `*.githubusercontent.com`) and the Remote GitHub MCP tool (`{ type: "mcp_server", name: "github", url: "https://api.githubcopilot.com/mcp/", credential: credentialId }`).
   - Emit SSE events consumed by `web/src/api.ts`:
     - `event: status` -> `{ "text": "Thinking" }`
     - `event: step` -> `{ "step": { "id": "s1", "kind": "thought" | "mcp" | "code" | "tool" | "search", "label": "...", "detail": "...", "state": "running" | "done" } }`
     - `event: stepdone` -> `{ "id": "s1", "ok": true }`
     - `event: text` -> `{ "delta": "markdown chunk" }` (accumulate from non-`thought` `step.delta` text events)
     - `event: error` -> `{ "code": "agent_error", "message": "..." }`
     - `event: done` -> `{ "status": "completed" | "error" | "stopped" | "incomplete", "environmentId": "env_..." }`
   - Persist `previousInteractionId` (`interaction.id` passed as `previous_interaction_id` on follow-up turns), `environmentId` (`interaction.environment_id`), and `messages` in `req.session.chat`.
   - On `POST /api/chat/reset`, clear `req.session.chat` and delete any active `environmentId` (`ai.environments.delete(environmentId)`).

## Commands & Security Rules

- Always use `bun` for TypeScript/JavaScript and `uv` for Python. `node_modules` is pre-installed when `bun install` has been run.
- `bun run dev`: Build and watch `web/` + run `server/index.ts` at `http://localhost:3000` (slides at `http://localhost:3000/slides`).
- `bun run typecheck`: Typecheck backend, scripts, steps, tests, and `web/`.
- `bun test`: Run the Bun test suite (`tests/server.test.ts`).
- Keep Express bound strictly to `127.0.0.1` (`localhost`), keep `csrfProtection` enabled on state-changing `/api/*` routes, never leak raw tokens outside the Gemini Credential Vault, and omit `url_context` when reviewing untrusted PR content.
