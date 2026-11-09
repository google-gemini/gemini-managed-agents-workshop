# Gemini Managed Agents Workshop — GitHub PR Reviewer

40-minute hands-on workshop for **AIE Code Summit**: build a stateful, sandboxed **GitHub Pull Request Reviewer** using Gemini Managed Agents (`antigravity-preview-09-2026`), Custom Agent definitions + Skills (`agents.create`), the write-only Credentials Vault (`credentials.create`), and GitHub Remote MCP (`mcp_server`).

## Quickstart

1. Copy `.env.example` to `.env` and add your keys:
   ```bash
   cp .env.example .env
   ```
   - `GEMINI_API_KEY`: Gemini API key from Google AI Studio.
   - `GITHUB_TOKEN`: Fine-grained GitHub Personal Access Token (Pull requests: Read, Contents: Read, Metadata: Read) for Steps 1–3 CLI scripts and one-click local web sign-in.
   - Optional: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` for full multi-user GitHub OAuth + PKCE sign-in (`http://localhost:3000/auth/github/callback`).

2. Choose your mode:
   - **Attendee 4-Step Workshop (Starter)**:
     ```bash
     bun run dev
     ```
     Open `http://localhost:3000/slides` for the interactive workshop deck and `http://localhost:3000` for the web app. Point your coding agent (Antigravity, Claude Code, Cursor, Gemini CLI, or Codex) at this repository — `AGENTS.md` and `.agents/skills/gemini-managed-agents/SKILL.md` give it everything needed to build Steps 1–4.

   - **Live Demo / Reference Solution**:
     ```bash
     bun run solution
     ```
     Runs the complete reference implementation from `solution/` at `http://localhost:3000` (with slides at `http://localhost:3000/slides`).

## Workshop Steps

1. **Step 1 — First Managed Agent**: Create `pr-reviewer-basic` on `antigravity-preview-09-2026` and stream a PR inspection on `google/budoux` (`solution/steps/step1.ts`).
2. **Step 2 — Custom Agent + PR Review Skill**: Bundle `agent/AGENTS.md` and `agent/skills/pr-review/` via `agents.create` (`bun run agent:sync` / `solution/steps/step2.ts`).
3. **Step 3 — Zero-Leak Credentials Vault + Remote MCP**: Store `GITHUB_TOKEN` in the write-only Gemini Credential Vault, attach it to `network.allowlist` and `https://api.githubcopilot.com/mcp/`, and verify zero raw tokens exist in sandbox `os.environ` or `/proc` (`solution/steps/step3.ts`).
4. **Step 4 — Connect the Web App**: Wire `server/auth.ts` and `server/chat.ts` (`GET /api/vault` + `POST /api/chat`) to stream live MCP calls, sandbox test execution, and PR verdicts to the React UI.

## Useful Commands

- `bun run dev` — Watch `web/` + run starter server (`server/index.ts`) on `127.0.0.1:3000`
- `bun run solution` — Watch `web/` + run complete reference server (`solution/server/index.ts`)
- `bun run agent:sync` — Register/update saved agent `pr-reviewer` from `agent/`
- `bun run solution:sync` — Register/update saved agent `pr-reviewer` from `solution/agent/`
- `bun run typecheck` — Typecheck backend, scripts, solution, and frontend
- `bun run check:py` — Byte-compile the sandbox Python PR helper (`uv run python3 -m py_compile ...`)
- `bun test` — Run automated server, stream-mapper, vault, and security tests
