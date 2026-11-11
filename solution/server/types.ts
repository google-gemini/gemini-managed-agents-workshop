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

export type StepKind = "mcp" | "code" | "search" | "thought";
export type StepState = "running" | "done" | "error";

export interface StoredStep {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  state: StepState;
}

export type MessageStatus = "completed" | "stopped" | "error" | "incomplete";

export interface VoiceNoteMeta {
  audioId: string;
  audioUrl: string;
  mimeType: string;
  durationSec?: number;
  summaryText?: string;
  voice?: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
  status?: MessageStatus;
  error?: string;
  steps?: StoredStep[];
  voice?: VoiceNoteMeta;
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
  geminiCredentialId?: string | undefined;
  environmentId?: string | undefined;
}

export interface AgentSyncStatus {
  synced: boolean;
  hash: string | null;
  skillFiles: string[];
}
