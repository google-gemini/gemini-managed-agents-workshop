import "express-session";
import type { ChatState, PendingOAuth, SessionUser } from "./types.ts";

declare module "express-session" {
  interface SessionData {
    /** Present only after a verified GitHub OAuth or PAT sign-in. */
    user?: SessionUser;
    /** Sign-in timestamp (ms) — used for enforcing the absolute session lifetime. */
    createdAt?: number;
    /** Gemini Credential Vault ID holding this session's GitHub token (never the raw token). */
    credentialId?: string;
    /** Gemini Credential Vault ID holding this session's x-goog-api-key proxy credential. */
    geminiCredentialId?: string;
    /** Single-use in-flight GitHub OAuth + PKCE state. */
    oauth?: PendingOAuth;
    /** Multi-turn Managed Agent handles and bounded transcript. */
    chat?: ChatState;
  }
}
