export type StepKind = "mcp" | "code" | "search" | "thought";
export type StepState = "running" | "done" | "error";

export interface Step {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  state: StepState;
}

export type MessageStatus = "streaming" | "completed" | "stopped" | "error" | "incomplete";

export type TtsVoiceName = "Kore" | "Puck" | "Aoede" | "Charon" | "Fenrir";

export interface VoiceNoteMeta {
  audioUrl: string;
  mimeType: string;
  durationSec?: number;
  summaryText?: string;
  voice?: string;
  transcribing?: boolean;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: MessageStatus;
  steps?: Step[];
  liveStatus?: string;
  error?: string;
  voice?: VoiceNoteMeta;
}

export type WorkshopMode = "starter" | "solution" | "configured";

export interface Me {
  email: string;
  name: string;
  givenName: string;
  login: string;
  picture: string | null;
  provider: "github";
  authMode: "oauth" | "pat";
  csrfToken: string;
  messages: Message[];
  workshopMode: WorkshopMode;
}

export interface SignedOutMeta {
  error: "unauthenticated";
  workshopMode?: WorkshopMode;
  hasGithubOAuth?: boolean;
  hasGithubPat?: boolean;
}

export type SessionResult =
  | { authenticated: true; me: Me }
  | { authenticated: false; meta: SignedOutMeta };

export interface VaultCredential {
  id: string;
  type: string;
  status: string;
  create_time: string | null;
  isCurrentSession: boolean;
}

export interface VaultStatus {
  agentId: string;
  agentSynced: boolean;
  agentHash: string | null;
  skillFiles: string[];
  agentModel: string;
  mcpEnabled: boolean;
  allowlist: string[];
  sessionCredentialId: string | null;
  sessionEnvironmentId: string | null;
  credentials: VaultCredential[];
}

/** Server-sent events emitted by POST /api/chat and POST /api/chat/voice. */
export type ChatEvent =
  | { event: "status"; data: { text: string } }
  | { event: "step"; data: { step: Step } }
  | { event: "stepdone"; data: { id: string; ok: boolean } }
  | { event: "text"; data: { delta: string } }
  | {
      event: "user_voice";
      data: { messageId: string; audioUrl: string; mimeType: string; durationSec?: number };
    }
  | { event: "transcript"; data: { messageId: string; transcript: string } }
  | {
      event: "audio";
      data: { audioUrl: string; mimeType: string; voice?: string; summaryText?: string };
    }
  | { event: "error"; data: { code: string; message: string } }
  | {
      event: "done";
      data: {
        status: "completed" | "error" | "stopped" | "incomplete";
        environmentId?: string;
      };
    };
