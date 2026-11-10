/*
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
    /** Single-use in-flight GitHub OAuth + PKCE state. */
    oauth?: PendingOAuth;
    /** Multi-turn Managed Agent handles and bounded transcript. */
    chat?: ChatState;
  }
}
