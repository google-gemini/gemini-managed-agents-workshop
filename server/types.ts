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

// Shared server-side types matching web/src/types.ts.

export type AuthProvider = "github";
export type AuthMode = "oauth" | "pat";
export type WorkshopMode = "starter" | "solution" | "configured";

export interface SessionUser {
  provider: AuthProvider;
  authMode: AuthMode;
  sub: string;
  login: string;
  email: string;
  name: string;
  givenName: string;
  picture: string | null;
}

export type StepKind = "mcp" | "code" | "tool" | "search" | "thought";
export type StepState = "running" | "done" | "error";

export interface StoredStep {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  state: StepState;
}

export type MessageStatus = "completed" | "stopped" | "error" | "incomplete";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  status?: MessageStatus;
  error?: string;
  steps?: StoredStep[];
}

export interface ChatState {
  previousInteractionId?: string;
  environmentId?: string;
  messages: StoredMessage[];
}

export interface PendingOAuth {
  provider: AuthProvider;
  state: string;
  codeVerifier: string;
  createdAt: number;
}

export interface RemoteResources {
  credentialId?: string | undefined;
  environmentId?: string | undefined;
}
