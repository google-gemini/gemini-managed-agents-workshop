# Gemini Managed Agents Workshop — GitHub PR Reviewer (Solution)

Complete reference implementation (`solution` branch) for the 40-minute AIE Code Summit workshop. It builds a stateful GitHub Pull Request Reviewer using Gemini Managed Agents (`antigravity-preview-09-2026` + `gemini-4-carbon`), Custom Agents and Skills (`agents.create`), GitHub OAuth with the write-only Credentials Vault (`credentials.create`), and Remote GitHub MCP (`mcp_server`).

To start from the barebone workshop starter instead, switch to the `main` branch:

```bash
git checkout main
```

## Setup

1. Copy `.env.example` to `.env` and add your keys:
   ```bash
   cp .env.example .env
   ```
   - `GEMINI_API_KEY`: Gemini API key from Google AI Studio.
   - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: GitHub OAuth App (`https://github.com/settings/developers`, callback URL `http://localhost:3000/auth/github/callback`).

2. Install dependencies and start the server:
   ```bash
   bun install
   bun run dev
   ```
   Open `http://localhost:3000` for the web app and `http://localhost:3000/slides` for the workshop slide deck. The 4 workshop prompts are in `PROMPTS.md`.

## Reference Steps

- Step 1 (`steps/step1.ts`): Run a Managed Agent in a remote sandbox and stream a PR summary on `google/budoux`.
- Step 2 (`steps/step2.ts` and `agent/`): Register saved agent `pr-reviewer` with `agent/AGENTS.md` and `agent/skills/pr-review/SKILL.md`.
- Step 3 (`steps/step3.ts`): Authenticate with GitHub OAuth, store the token in the Gemini Credential Vault, and review an open PR via Remote GitHub MCP.
- Step 4 (`server/`): Full Express backend wiring GitHub OAuth + Vault sign-in/sign-out, live `GET /api/vault` status, and `POST /api/chat` SSE streaming into `web/`.

## Commands

- `bun run dev`: Watch `web/` and run `server/index.ts` on `127.0.0.1:3000`
- `bun run agent:sync`: Register or update saved agent `pr-reviewer` from `agent/`
- `bun --env-file=.env steps/step1.ts`: Run Step 1 CLI reference (`step2.ts`, `step3.ts` for Steps 2–3)
- `bun run build`: Build `web/` into `dist/web/`
- `bun run typecheck`: Typecheck backend, steps, scripts, tests, and frontend
- `bun test`: Run automated server, stream-mapper, vault, and security tests

## License & Disclaimer

Licensed under the Apache-2.0 License. This is not an officially supported Google product. See [LICENSE](LICENSE) for the full license text.
