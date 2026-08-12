import type { TSchema } from "typebox";
import type {
  BoundAuthoritativeContext,
  KoniAuthorizedCompaction,
  KoniAttemptRecoveryState,
  KoniCompactionSnapshot,
  KoniAuthorizedMessage,
  KoniProviderRequestReservation,
  KoniProviderRequestReservationInput,
  KoniProviderRequestSettlement,
  KoniProviderRequestSettlementInput,
} from "./compaction.js";
import type { SelectedDynamicGraphContext } from "../graph/context-selector.js";
import type { AgentLaunchSpec } from "./launch-spec.js";
import type { ManagedSessionEvent, ManagedSessionOutcome } from "./managed-session.js";
import type { KoniRuntimeToolRejection, KoniToolName, KoniToolReceipt } from "./tool-catalog.js";
import type { Sha256Digest } from "../shared/canonical.js";

export const PI_ATTEMPT_PROCESS_PROTOCOL = "koni.pi-attempt-process.v1" as const;
// The largest catalog argument is a 16 MiB string. JSON may expand each byte to a six-byte escape,
// so 128 MiB preserves the complete compiler-authorized tool surface while remaining hard-bounded.
export const PI_ATTEMPT_PROCESS_MAX_FRAME_BYTES = 128 * 1024 * 1024;

export type PiAttemptProcessMode = "fresh" | "recover" | "planning_revision";

interface FrameBase {
  protocol: typeof PI_ATTEMPT_PROCESS_PROTOCOL;
  attemptId: string;
  specHash: string;
  sequence: number;
}

export interface LaunchAttemptFrame extends FrameBase {
  type: "launch";
  mode: PiAttemptProcessMode;
  /**
   * When true, the child constructs and persists the exact Pi session but cannot begin a
   * provider turn until the authority sends an explicit activation control. Production
   * authorities use this to durably bind the session file before any tokens can be spent.
   */
  deferActivation: boolean;
  spec: AgentLaunchSpec;
  terminalOutputSchema: TSchema;
  priorTranscriptSha256?: Sha256Digest;
}

export interface ActivateControlAttemptFrame extends FrameBase {
  type: "control";
  controlId: string;
  action: "activate";
  /** Parent-owned capability issued only after the exact session path is durably committed. */
  activationToken: string;
}

export interface MessageControlAttemptFrame extends FrameBase {
  type: "control";
  controlId: string;
  action: "message";
  message: KoniAuthorizedMessage;
}

export interface AbortControlAttemptFrame extends FrameBase {
  type: "control";
  controlId: string;
  action: "abort";
  reason: string;
}

export interface AuthorityResponseFrame extends FrameBase {
  type: "authority_response";
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  /** Bounded machine classification from the Rust-equivalent Core authority boundary. */
  errorCode?: string;
}

export type PiAttemptParentFrame =
  | LaunchAttemptFrame
  | ActivateControlAttemptFrame
  | MessageControlAttemptFrame
  | AbortControlAttemptFrame
  | AuthorityResponseFrame;

export interface ChildReadyFrame extends FrameBase {
  type: "ready";
  sessionFile: string;
}

export interface ChildEventFrame extends FrameBase {
  type: "event";
  event: ManagedSessionEvent;
}

export interface ChildOutcomeFrame extends FrameBase {
  type: "outcome";
  outcome: ManagedSessionOutcome;
}

export interface ChildControlResultFrame extends FrameBase {
  type: "control_result";
  controlId: string;
  ok: boolean;
  error?: string;
}

export type PiAuthorityRequest =
  | {
      operation: "invoke_tool";
      callId: string;
      name: KoniToolName;
      arguments: Record<string, unknown>;
    }
  | {
      operation: "reject_tool";
      callId: string;
      name: KoniToolName;
      arguments: Record<string, unknown>;
      rejection: KoniRuntimeToolRejection;
    }
  | { operation: "load_bound_context" }
  | { operation: "load_dynamic_graph_context" }
  | { operation: "load_compaction_snapshot" }
  | {
      operation: "authorize_compaction";
      record: Omit<KoniAuthorizedCompaction, "sequence" | "authorizationId">;
    }
  | { operation: "acquire_recovery_claim" }
  | { operation: "release_recovery_claim"; claimToken: string }
  | { operation: "reserve_provider_request"; request: KoniProviderRequestReservationInput }
  | { operation: "reconcile_provider_request"; settlement: KoniProviderRequestSettlementInput };

export type PiAuthorityResponseValue =
  | KoniToolReceipt
  | BoundAuthoritativeContext
  | SelectedDynamicGraphContext
  | KoniCompactionSnapshot
  | { authorizationId: string }
  | { claimToken: string; claimId: string; state: KoniAttemptRecoveryState }
  | { released: true }
  | KoniProviderRequestReservation
  | KoniProviderRequestSettlement;

export interface ChildAuthorityRequestFrame extends FrameBase {
  type: "authority_request";
  requestId: string;
  /** Required for every non-construction authority request after activation. */
  activationToken?: string;
  request: PiAuthorityRequest;
}

export interface ChildAuthorityCancelFrame extends FrameBase {
  type: "authority_cancel";
  requestId: string;
}

export interface ChildFatalFrame extends FrameBase {
  type: "fatal";
  error: string;
}

export type PiAttemptChildFrame =
  | ChildReadyFrame
  | ChildEventFrame
  | ChildOutcomeFrame
  | ChildControlResultFrame
  | ChildAuthorityRequestFrame
  | ChildAuthorityCancelFrame
  | ChildFatalFrame;

export class PiAttemptProcessProtocolError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PiAttemptProcessProtocolError";
    this.code = code;
  }
}

/** A strict byte-bounded newline decoder. Each line is one complete protocol frame. */
export class BoundedJsonLineDecoder {
  readonly #maximumBytes: number;
  #buffer = Buffer.alloc(0);

  public constructor(maximumBytes = PI_ATTEMPT_PROCESS_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new PiAttemptProcessProtocolError(
        "frame_bound",
        "frame bound must be a positive safe integer",
      );
    }
    this.#maximumBytes = maximumBytes;
  }

  public push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    const values: unknown[] = [];
    const incoming = Buffer.from(chunk);
    let offset = 0;
    for (;;) {
      const newline = incoming.indexOf(0x0a, offset);
      const end = newline < 0 ? incoming.byteLength : newline;
      const segment = incoming.subarray(offset, end);
      if (this.#buffer.byteLength + segment.byteLength > this.#maximumBytes) {
        throw new PiAttemptProcessProtocolError(
          "frame_too_large",
          "attempt-process frame exceeds its byte bound",
        );
      }
      if (segment.byteLength > 0) this.#buffer = Buffer.concat([this.#buffer, segment]);
      if (newline < 0) break;
      if (this.#buffer.byteLength === 0) {
        throw new PiAttemptProcessProtocolError(
          "empty_frame",
          "attempt-process protocol does not allow empty frames",
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#buffer));
      } catch {
        throw new PiAttemptProcessProtocolError(
          "invalid_json",
          "attempt-process frame is not valid JSON",
        );
      }
      values.push(value);
      this.#buffer = Buffer.alloc(0);
      offset = newline + 1;
      if (offset === incoming.byteLength) break;
    }
    return values;
  }

  public finish(): void {
    if (this.#buffer.byteLength !== 0) {
      throw new PiAttemptProcessProtocolError(
        "truncated_frame",
        "attempt-process channel ended with a partial frame",
      );
    }
  }
}

export function encodePiAttemptProcessFrame(
  frame: PiAttemptParentFrame | PiAttemptChildFrame,
): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (encoded.byteLength - 1 > PI_ATTEMPT_PROCESS_MAX_FRAME_BYTES) {
    throw new PiAttemptProcessProtocolError(
      "frame_too_large",
      "attempt-process frame exceeds its byte bound",
    );
  }
  return encoded;
}

export function parseParentFrame(value: unknown): PiAttemptParentFrame {
  const frame = validateBase(value);
  switch (frame.type) {
    case "launch":
      if (
        (frame.mode !== "fresh" &&
          frame.mode !== "recover" &&
          frame.mode !== "planning_revision") ||
        typeof frame.deferActivation !== "boolean" ||
        !isRecord(frame.spec) ||
        !isRecord(frame.terminalOutputSchema) ||
        (frame.mode === "planning_revision"
          ? !isDigest(frame.priorTranscriptSha256)
          : frame.priorTranscriptSha256 !== undefined)
      )
        failShape("launch frame is malformed");
      break;
    case "control":
      validateIdentifier(frame.controlId, "controlId");
      if (frame.action === "activate") {
        validateIdentifier(frame.activationToken, "activationToken");
      } else if (frame.action === "abort") validateBoundedString(frame.reason, "reason", 64 * 1024);
      else if (frame.action === "message" && isRecord(frame.message)) {
        validateBoundedString(frame.message.content, "message.content", 1024 * 1024);
      } else failShape("control frame is malformed");
      break;
    case "authority_response":
      validateIdentifier(frame.requestId, "requestId");
      if (typeof frame.ok !== "boolean") failShape("authority response ok must be boolean");
      if (!frame.ok) {
        validateBoundedString(frame.error, "error", 64 * 1024);
        if (frame.errorCode !== undefined) validateIdentifier(frame.errorCode, "errorCode");
      }
      break;
    default:
      throw new PiAttemptProcessProtocolError(
        "frame_type",
        `unsupported parent frame ${frame.type}`,
      );
  }
  return value as PiAttemptParentFrame;
}

export function parseChildFrame(value: unknown): PiAttemptChildFrame {
  const frame = validateBase(value);
  switch (frame.type) {
    case "ready":
      validateBoundedString(frame.sessionFile, "sessionFile", 16 * 1024);
      break;
    case "event":
      if (!isRecord(frame.event) || typeof frame.event.type !== "string")
        failShape("managed event is malformed");
      break;
    case "outcome":
      if (!isRecord(frame.outcome) || typeof frame.outcome.status !== "string")
        failShape("managed outcome is malformed");
      break;
    case "control_result":
      validateIdentifier(frame.controlId, "controlId");
      if (typeof frame.ok !== "boolean") failShape("control result ok must be boolean");
      if (!frame.ok) validateBoundedString(frame.error, "error", 64 * 1024);
      break;
    case "authority_request":
      validateIdentifier(frame.requestId, "requestId");
      if (frame.activationToken !== undefined)
        validateIdentifier(frame.activationToken, "activationToken");
      validateAuthorityRequest(frame.request);
      break;
    case "authority_cancel":
      validateIdentifier(frame.requestId, "requestId");
      break;
    case "fatal":
      validateBoundedString(frame.error, "error", 64 * 1024);
      break;
    default:
      throw new PiAttemptProcessProtocolError(
        "frame_type",
        `unsupported child frame ${frame.type}`,
      );
  }
  return value as PiAttemptChildFrame;
}

export function assertFrameBinding(
  frame: FrameBase,
  expected: { attemptId: string; specHash: string; nextSequence: number },
): void {
  if (frame.attemptId !== expected.attemptId || frame.specHash !== expected.specHash) {
    throw new PiAttemptProcessProtocolError(
      "frame_binding",
      "attempt-process frame crossed an immutable attempt boundary",
    );
  }
  if (frame.sequence !== expected.nextSequence) {
    throw new PiAttemptProcessProtocolError(
      "frame_sequence",
      `attempt-process frame sequence ${frame.sequence} did not equal ${expected.nextSequence}`,
    );
  }
}

function validateBase(value: unknown): FrameBase & { type: string } & Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PiAttemptProcessProtocolError(
      "frame_shape",
      "attempt-process frame must be an object",
    );
  }
  if (value.protocol !== PI_ATTEMPT_PROCESS_PROTOCOL) {
    throw new PiAttemptProcessProtocolError(
      "frame_protocol",
      "unsupported attempt-process protocol",
    );
  }
  for (const field of ["attemptId", "specHash", "type"] as const) {
    if (typeof value[field] !== "string" || Buffer.byteLength(value[field], "utf8") < 1) {
      throw new PiAttemptProcessProtocolError(
        "frame_shape",
        `attempt-process ${field} must be a nonempty string`,
      );
    }
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    throw new PiAttemptProcessProtocolError(
      "frame_sequence",
      "attempt-process sequence must be a positive safe integer",
    );
  }
  return value as unknown as FrameBase & { type: string } & Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAuthorityRequest(value: unknown): void {
  if (!isRecord(value) || typeof value.operation !== "string")
    failShape("authority request is malformed");
  switch (value.operation) {
    case "invoke_tool":
    case "reject_tool":
      // Pi/provider tool-call ids are opaque transport identities, not Koni-authored keys. OpenAI
      // Responses currently composes them as `call_<id>|fc_<id>`, so applying Koni's narrower
      // identifier grammar rejects an ordinary native Pi call before Rust/TS authority can inspect
      // it. Keep the value bounded and free of controls while preserving the provider identity
      // byte-for-byte for replay protection and transcript correlation.
      validateOpaqueIdentifier(value.callId, "callId");
      validateIdentifier(value.name, "tool name");
      if (!isRecord(value.arguments)) failShape("tool arguments must be an object");
      if (value.operation === "reject_tool" && !isRecord(value.rejection)) {
        failShape("tool rejection must be an object");
      }
      return;
    case "load_bound_context":
    case "load_dynamic_graph_context":
    case "load_compaction_snapshot":
    case "acquire_recovery_claim":
      return;
    case "authorize_compaction":
      if (!isRecord(value.record)) failShape("compaction authorization record is malformed");
      return;
    case "release_recovery_claim":
      validateIdentifier(value.claimToken, "claimToken");
      return;
    case "reserve_provider_request":
      validateProviderReservationInput(value.request);
      return;
    case "reconcile_provider_request":
      validateProviderSettlementInput(value.settlement);
      return;
    default:
      throw new PiAttemptProcessProtocolError(
        "authority_operation",
        "unsupported authority request operation",
      );
  }
}

function validateProviderReservationInput(value: unknown): void {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.api !== "string" ||
    Buffer.byteLength(value.api, "utf8") < 1 ||
    Buffer.byteLength(value.api, "utf8") > 256 ||
    typeof value.modelId !== "string" ||
    Buffer.byteLength(value.modelId, "utf8") < 1 ||
    Buffer.byteLength(value.modelId, "utf8") > 512 ||
    !isDigest(value.payloadSha256) ||
    !isPositiveSafeInteger(value.payloadSizeBytes) ||
    !isPositiveSafeInteger(value.prospectiveInputTokens) ||
    !isPositiveSafeInteger(value.reservedOutputTokens)
  )
    failShape("provider reservation request is malformed");
  if (value.serializedOutputCap !== undefined) {
    if (
      !isRecord(value.serializedOutputCap) ||
      typeof value.serializedOutputCap.path !== "string" ||
      !value.serializedOutputCap.path.startsWith("/") ||
      Buffer.byteLength(value.serializedOutputCap.path, "utf8") > 256 ||
      !isPositiveSafeInteger(value.serializedOutputCap.value) ||
      value.serializedOutputCap.value !== value.reservedOutputTokens
    )
      failShape("provider serialized output cap is malformed");
  }
}

function validateProviderSettlementInput(value: unknown): void {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.reservationId !== "string" ||
    typeof value.assistantEntryId !== "string" ||
    !isDigest(value.assistantEntrySha256) ||
    !isRecord(value.usage)
  )
    failShape("provider settlement request is malformed");
  validateIdentifier(value.reservationId, "reservationId");
  validateIdentifier(value.assistantEntryId, "assistantEntryId");
  const usage = value.usage;
  for (const field of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "newTokens",
    "allTokens",
  ] as const) {
    if (!Number.isSafeInteger(usage[field]) || Number(usage[field]) < 0) {
      failShape("provider settlement usage is malformed");
    }
  }
  if (
    usage.newTokens !== Number(usage.input) + Number(usage.output) ||
    usage.allTokens !== Number(usage.newTokens) + Number(usage.cacheRead) + Number(usage.cacheWrite)
  )
    failShape("provider settlement usage aggregates are inconsistent");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function validateIdentifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    failShape(`${name} is not a safe identifier`);
  }
}

function validateOpaqueIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    failShape(`${name} is not a bounded printable identifier`);
  }
}

function validateBoundedString(
  value: unknown,
  name: string,
  maximumBytes: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes("\u0000")
  ) {
    failShape(`${name} is empty, oversized, or contains NUL`);
  }
}

function failShape(message: string): never {
  throw new PiAttemptProcessProtocolError("frame_shape", message);
}
