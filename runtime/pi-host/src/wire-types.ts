import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type RuntimeThinkingLevel = ThinkingLevel;

export interface RuntimeModelRef {
  provider: string;
  model: string;
  thinking_level: RuntimeThinkingLevel;
  input_capabilities?: string[];
  context_window: number | null;
}

export interface RuntimeModelDescriptor {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  context_window: number;
  max_tokens: number;
  thinking_levels: RuntimeThinkingLevel[];
}

export interface RuntimeHostMetadata {
  host_version: string;
  pi_sdk_version: string;
  provider: string;
  ambient_resources: false;
  ambient_credentials: false;
  tools: "compiler-brokered-only";
}

export interface RuntimeSessionRef {
  runtime: string;
  protocol_version: number;
  provider: string;
  model: string;
  session_id: string;
}

export interface RuntimeUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RuntimeSessionStart {
  session_id: string;
  run_id: string;
  agent_id: string;
  attempt: number;
  model: RuntimeModelRef;
  instructions: string;
  tools?: RuntimeToolDefinition[];
  terminal_boundary_tools?: string[];
  context_completion_required?: boolean;
  credential_lease: string;
}

export type RuntimeInput =
  | { kind: "text"; text: string }
  | { kind: "image"; media_type: string; sha256: string; data_base64: string };

export interface RuntimeTurnRequest {
  turn_id: string;
  input: RuntimeInput[];
  output_schema: Record<string, unknown> | null;
  output_token_budget: number | null;
}

export type RuntimeControl =
  | { control: "steer"; text: string }
  | { control: "follow_up"; text: string }
  | { control: "cancel"; reason: string };

export type OAuthProviderWire = "open-ai-codex";
export type OAuthLoginFlowWire = "browser_pkce" | "device_code";

export type CredentialBrokerRequest =
  | { request: "status"; provider: OAuthProviderWire }
  | { request: "begin_login"; provider: OAuthProviderWire; preferred_flow: OAuthLoginFlowWire }
  | { request: "acquire_lease"; provider: OAuthProviderWire; session_id: string }
  | { request: "logout"; provider: OAuthProviderWire };

export type OAuthStatusWire =
  | { status: "signed_out" }
  | {
      status: "login_pending";
      flow: OAuthLoginFlowWire;
      verification_uri: string | null;
      user_code: string | null;
      expires_at: string;
    }
  | { status: "signed_in"; account_label: string | null; expires_at: string | null }
  | { status: "reauthentication_required"; reason: string };

export type CredentialBrokerResponse =
  | { response: "status"; provider: OAuthProviderWire; status: OAuthStatusWire }
  | { response: "login_started"; provider: OAuthProviderWire; status: OAuthStatusWire }
  | {
      response: "lease_granted";
      provider: OAuthProviderWire;
      lease_id: string;
      expires_at: string | null;
    }
  | { response: "logged_out"; provider: OAuthProviderWire }
  | { response: "denied"; code: string; message: string };

export type RuntimeCommand =
  | { command: "list_models" }
  | { command: "metadata" }
  | { command: "start_session"; request: RuntimeSessionStart }
  | { command: "start_turn"; request: RuntimeTurnRequest }
  | { command: "control"; control: RuntimeControl }
  | { command: "authenticate"; credential_lease: string; request: CredentialBrokerRequest }
  | { command: "shutdown" };

export type RuntimeResponse =
  | { kind: "accepted" }
  | { kind: "models"; models: RuntimeModelDescriptor[] }
  | { kind: "metadata"; metadata: RuntimeHostMetadata }
  | { kind: "session_started"; session: RuntimeSessionRef }
  | { kind: "authentication"; response: CredentialBrokerResponse }
  | { kind: "rejected"; code: string; message: string; retryable: boolean };

export type AgentToolOutcome =
  | { status: "success"; value: unknown }
  | { status: "error"; code: string; message: string; retryable: boolean }
  | { status: "terminate"; value: unknown };

export interface AgentToolCallWire {
  call_id: string;
  name: string;
  arguments?: unknown;
}

export type OAuthInteractionWire =
  | { interaction: "auth_url"; url: string; instructions: string | null }
  | {
      interaction: "device_code";
      user_code: string;
      verification_uri: string;
      interval_seconds: number | null;
      expires_in_seconds: number | null;
    }
  | { interaction: "progress"; message: string };

export type RuntimeEvent =
  | { event: "turn_started"; turn_id: string }
  | { event: "message_delta"; turn_id: string; message_id: string; text: string }
  | { event: "message_completed"; turn_id: string; message_id: string; role: string; content: unknown }
  | { event: "tool_started"; turn_id: string; call_id: string; name: string }
  | { event: "tool_updated"; turn_id: string; call_id: string; update: unknown }
  | {
      event: "tool_rejected";
      turn_id: string;
      call_id: string;
      name: string;
      code:
        | "pi_tool_validation"
        | "pi_tool_truncated"
        | "pi_tool_arguments_too_large"
        | "pi_tool_stale_after_retryable_error"
        | "pi_tool_stale_after_context_delivery"
        | "pi_tool_context_already_issued";
      message: string;
    }
  | { event: "tool_completed"; turn_id: string; call_id: string; outcome: AgentToolOutcome }
  | { event: "usage"; turn_id: string; usage: RuntimeUsage }
  | { event: "retry"; turn_id: string; attempt: number; delay_ms: number; reason: string }
  | {
      event: "compaction";
      turn_id: string;
      source_message_ids: string[];
      summary_sha256: string;
    }
  | { event: "turn_completed"; turn_id: string; stop_reason: string; usage: RuntimeUsage }
  | {
      event: "runtime_error";
      turn_id: string | null;
      code: string;
      message: string;
      retryable: boolean;
    }
  | { event: "authentication"; interaction: OAuthInteractionWire };

interface PiFrameHeader {
  protocol_version: 1;
  session_id: string;
  sequence: number;
}

export type PiFrame =
  | (PiFrameHeader & { frame: "request"; request_id: string; command: RuntimeCommand })
  | (PiFrameHeader & { frame: "response"; request_id: string; response: RuntimeResponse })
  | (PiFrameHeader & { frame: "event"; event: RuntimeEvent })
  | (PiFrameHeader & { frame: "tool_call"; call: AgentToolCallWire })
  | (PiFrameHeader & { frame: "tool_result"; call_id: string; outcome: AgentToolOutcome });
