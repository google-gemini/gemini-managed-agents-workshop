# Gemini Managed Agents Workshop — GitHub PR Reviewer

40-minute hands-on workshop for AIE Code Summit. Start from this barebone starter (`main` branch) and pair with your coding agent to build a stateful GitHub Pull Request Reviewer using Gemini Managed Agents (`antigravity-preview-09-2026` + `gemini-4-carbon`), Custom Agents and Skills (`agents.create`), GitHub OAuth with the write-only Credentials Vault (`credentials.create`), and Remote GitHub MCP (`mcp_server`).

## Quickstart

1. Copy `.env.example` to `.env` and add your keys:
   ```bash
   cp .env.example .env
   ```
   - `GEMINI_API_KEY`: Gemini API key from Google AI Studio.
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: GitHub OAuth App (`https://github.com/settings/developers`, callback URL `http://localhost:3000/auth/github/callback`).

2. Install dependencies and start the starter server:
   ```bash
   bun install
   bun run dev
   ```

3. Open `http://localhost:3000/slides` for the workshop deck and `http://localhost:3000` for the web UI. Open your coding agent (Antigravity, Claude Code, Cursor, Gemini CLI, or Codex) in this directory and paste each prompt from `PROMPTS.md` (`AGENTS.md` and `.agents/skills/gemini-managed-agents/SKILL.md` give your coding agent full SDK context).

## Reference Solution

To inspect or run the completed implementation across all 4 steps, switch to the `solution` branch:

```bash
git checkout solution
```

## Commands

- `bun run dev`: Watch `web/` and run `server/index.ts` on `127.0.0.1:3000`
- `bun run build`: Build `web/` into `dist/web/`
- `bun run typecheck`: Typecheck backend, scripts, and frontend
- `bun test`: Run automated server and security tests
