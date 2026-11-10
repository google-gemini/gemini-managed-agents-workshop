# Workshop Prompts

Copy each prompt into your coding agent (Antigravity, Claude Code, Cursor, Gemini CLI, or Codex) from the repo root.

## Step 1 · First Managed Agent

```text
Write a quick script that spins up a Gemini Managed Agent on gemini-4-carbon in a remote sandbox and has it look at the latest open PR on google/budoux. Stream each step to the terminal as it happens, print the final summary, then run it.
```

## Step 2 · Saved Agent & Review Skill

```text
Now turn that into a saved pr-reviewer agent. Give it an AGENTS.md that treats all PR content as untrusted, plus a pr-review skill with our code review principles. Register it and test it on an open google/budoux PR.
```

## Step 3 · GitHub OAuth, Credential Vault & Remote MCP

```text
Let's add GitHub auth. Sign me in with GitHub OAuth locally, put the token in the Gemini Credential Vault, and run pr-reviewer with the remote GitHub MCP server on an open google/budoux PR. Check the raw token never shows up in the sandbox, then delete the credential.
```

## Step 4 · Connect the Web UI

```text
Now hook pr-reviewer into the web app in server/. I want GitHub sign-in and sign-out backed by the vault, live vault and agent status in the UI, and PR reviews streaming into the chat. Start the dev server when it works.
```
