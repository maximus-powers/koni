export type HostErrorCode =
  | "AUTHENTICATION_FAILED"
  | "BROKER_TIMEOUT"
  | "CANCELLED"
  | "CONFLICT"
  | "INTERNAL"
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "NOT_INITIALIZED"
  | "OUTPUT_LIMIT"
  | "PROTOCOL_ERROR"
  | "PROVIDER_ERROR"
  | "TERMINAL_RACE"
  | "UNSUPPORTED";

export type ProjectedFailureCode =
  | "provider_usage_limit"
  | "provider_authentication"
  | "provider_access_denied"
  | "provider_request_rejected"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_error"
  | "runtime_broker_timeout"
  | "runtime_credential_channel"
  | "runtime_output_limit"
  | "runtime_protocol_error"
  | "runtime_unsupported"
  | "runtime_internal";

export interface ProjectedFailure {
  code: ProjectedFailureCode;
  message: string;
  retryable: boolean;
}

const MAX_FAILURE_CLASSIFICATION_BYTES = 8 * 1024;

const PROVIDER_USAGE_LIMIT: ProjectedFailure = {
  code: "provider_usage_limit",
  message: "Your ChatGPT Codex usage limit has been reached. Wait for it to reset, then resume the run.",
  retryable: false,
};
const PROVIDER_AUTHENTICATION: ProjectedFailure = {
  code: "provider_authentication",
  message: "OpenAI Codex rejected the stored sign-in. Run koni auth login, then resume the run.",
  retryable: false,
};
const PROVIDER_ACCESS_DENIED: ProjectedFailure = {
  code: "provider_access_denied",
  message: "OpenAI Codex denied this account or model. Check ChatGPT subscription and model access, then retry.",
  retryable: false,
};
const PROVIDER_REQUEST_REJECTED: ProjectedFailure = {
  code: "provider_request_rejected",
  message: "OpenAI Codex rejected the request. Check the selected model and Koni runtime compatibility before retrying.",
  retryable: false,
};
const PROVIDER_RATE_LIMITED: ProjectedFailure = {
  code: "provider_rate_limited",
  message: "OpenAI Codex is temporarily rate-limiting requests. Retry after a short delay.",
  retryable: true,
};
const PROVIDER_UNAVAILABLE: ProjectedFailure = {
  code: "provider_unavailable",
  message: "OpenAI Codex is temporarily unavailable. Retry this turn.",
  retryable: true,
};
const PROVIDER_ERROR: ProjectedFailure = {
  code: "provider_error",
  message: "OpenAI Codex failed for an unclassified reason. Retry manually; if it repeats, reauthenticate and check service status.",
  retryable: false,
};
const RUNTIME_BROKER_TIMEOUT: ProjectedFailure = {
  code: "runtime_broker_timeout",
  message: "The compiler tool broker did not respond in time. Inspect the run state, then resume safely.",
  retryable: false,
};
const RUNTIME_CREDENTIAL_CHANNEL: ProjectedFailure = {
  code: "runtime_credential_channel",
  message: "The Pi runtime private credential channel is unavailable.",
  retryable: false,
};
const RUNTIME_OUTPUT_LIMIT: ProjectedFailure = {
  code: "runtime_output_limit",
  message:
    "The agent response was too large for this run's output allowance. Its transcript was preserved; start a larger run or revise the run-type limits before retrying.",
  retryable: false,
};
const RUNTIME_PROTOCOL_ERROR: ProjectedFailure = {
  code: "runtime_protocol_error",
  message: "The Pi runtime protocol failed closed. Restart Koni before resuming the run.",
  retryable: false,
};
const RUNTIME_UNSUPPORTED: ProjectedFailure = {
  code: "runtime_unsupported",
  message: "This Koni installation cannot run the requested Pi operation. Update Koni before retrying.",
  retryable: false,
};
const RUNTIME_INTERNAL: ProjectedFailure = {
  code: "runtime_internal",
  message: "The Pi runtime failed internally. Retry manually; if it repeats, inspect Koni diagnostics.",
  retryable: false,
};

function appendBounded(parts: string[], value: unknown, remaining: { bytes: number }): void {
  if (remaining.bytes <= 0) return;
  let text: string;
  try {
    if (typeof value === "string") text = value;
    else if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      text = String(value);
    } else {
      return;
    }
  } catch {
    return;
  }
  const bounded = Buffer.from(text, "utf8").subarray(0, remaining.bytes).toString("utf8");
  if (bounded.length > 0) {
    parts.push(bounded);
    remaining.bytes -= Buffer.byteLength(bounded, "utf8");
  }
}

/**
 * Extract only a bounded classification hint. The result is never returned,
 * logged, persisted, or attached to a public error; it may only select one
 * fixed tuple below. Property reads are guarded so hostile provider values
 * cannot make classification throw.
 */
function boundedFailureHint(raw: unknown): string {
  const parts: string[] = [];
  const remaining = { bytes: MAX_FAILURE_CLASSIFICATION_BYTES };
  appendBounded(parts, raw, remaining);
  if (remaining.bytes > 0 && (typeof raw === "object" || typeof raw === "function") && raw !== null) {
    for (const key of ["name", "message", "code", "status", "statusCode", "type", "cause"]) {
      try {
        appendBounded(parts, (raw as Record<string, unknown>)[key], remaining);
      } catch {
        // A proxy/getter is untrusted provider input. Ignore it and retain the
        // fixed, non-retryable fallback.
      }
      if (remaining.bytes <= 0) break;
    }
  }
  return parts.join("\n").toLowerCase();
}

function matches(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Project arbitrary provider text onto one fixed, secret-free protocol tuple. */
export function projectProviderFailure(raw: unknown): ProjectedFailure {
  const hint = boundedFailureHint(raw);
  if (
    matches(hint, [
      /chatgpt[^\n]{0,80}usage limit/u,
      /usage[_ -](?:limit[_ -]reached|not[_ -]included)/u,
      /insufficient[_ -]quota/u,
      /(?:monthly|quota|budget|billing)[^\n]{0,80}(?:exhausted|reached|exceeded|limit)/u,
      /(?:exhausted|reached|exceeded)[^\n]{0,80}(?:monthly|quota|budget|billing)/u,
    ])
  ) {
    return PROVIDER_USAGE_LIMIT;
  }
  if (
    matches(hint, [
      /(?:http|status|statuscode)[^\n]{0,20}401\b/u,
      /(?:^|\n)401(?:\n|$)/u,
      /\b401\s+(?:unauthorized|authentication)/u,
      /\bunauthori[sz]ed\b/u,
      /(?:missing|invalid|expired)[^\n]{0,48}(?:access |oauth |auth )?token/u,
      /oauth[^\n]{0,48}(?:refresh|authentication)[^\n]{0,48}(?:fail|invalid|expired|reject)/u,
      /no (?:provider )?credential/u,
    ])
  ) {
    return PROVIDER_AUTHENTICATION;
  }
  if (
    matches(hint, [
      /(?:http|status|statuscode)[^\n]{0,20}403\b/u,
      /(?:^|\n)403(?:\n|$)/u,
      /\b403\s+forbidden/u,
      /\bforbidden\b/u,
      /(?:model|account)[^\n]{0,48}(?:access|entitlement)[^\n]{0,48}(?:denied|missing|required)/u,
      /(?:access|entitlement)[^\n]{0,48}(?:denied|missing|required)/u,
    ])
  ) {
    return PROVIDER_ACCESS_DENIED;
  }
  if (
    matches(hint, [
      /(?:http|status|statuscode)[^\n]{0,20}(?:400|404|422)\b/u,
      /(?:^|\n)(?:400|404|422)(?:\n|$)/u,
      /\b(?:400|404|422)\s+(?:bad request|not found|unprocessable)/u,
      /invalid[_ -]request/u,
      /(?:invalid|unknown|unsupported)[^\n]{0,48}(?:request|model|parameter|field)/u,
      /context[_ -]window/u,
      /(?:maximum|max)[^\n]{0,32}context/u,
    ])
  ) {
    return PROVIDER_REQUEST_REJECTED;
  }
  if (
    matches(hint, [
      /(?:http|status|statuscode)[^\n]{0,20}429\b/u,
      /(?:^|\n)429(?:\n|$)/u,
      /\b429\s+(?:too many requests|rate limit)/u,
      /rate[_ -]limit/u,
      /too many requests/u,
    ])
  ) {
    return PROVIDER_RATE_LIMITED;
  }
  if (
    matches(hint, [
      /(?:http|status|statuscode)[^\n]{0,20}(?:5\d\d|524)\b/u,
      /(?:^|\n)(?:5\d\d|524)(?:\n|$)/u,
      /\b(?:5\d\d|524)\s+(?:server|service|gateway|timeout|overload)/u,
      /(?:service|provider|server)[^\n]{0,48}(?:unavailable|overload|internal error)/u,
      /internal server error/u,
      /(?:fetch|network|upstream|connection|socket|websocket)[^\n]{0,48}(?:fail|error|closed|reset|refused|timeout|timed out)/u,
      /(?:timeout|timed out|connection reset|socket hang up)/u,
      /(?:try|retry) again/u,
    ])
  ) {
    return PROVIDER_UNAVAILABLE;
  }
  return PROVIDER_ERROR;
}

/** Project host-authored failures without exposing an arbitrary exception message. */
export function projectRuntimeFailure(error: unknown): ProjectedFailure {
  if ((typeof error === "object" || typeof error === "function") && error !== null) {
    try {
      if (["EBADF", "EINVAL", "ENOTTY", "ERR_INVALID_FD_TYPE"].includes(
        String((error as Record<string, unknown>)["code"]),
      )) {
        return RUNTIME_CREDENTIAL_CHANNEL;
      }
    } catch {
      // Unknown exception properties never cross the fixed projection.
    }
  }
  if (error instanceof HostError) {
    if (error.code === "BROKER_TIMEOUT") return RUNTIME_BROKER_TIMEOUT;
    if (error.code === "OUTPUT_LIMIT") return RUNTIME_OUTPUT_LIMIT;
    if (error.code === "PROTOCOL_ERROR" || error.code === "TERMINAL_RACE") {
      return RUNTIME_PROTOCOL_ERROR;
    }
    if (error.code === "UNSUPPORTED") return RUNTIME_UNSUPPORTED;
  }
  return RUNTIME_INTERNAL;
}

export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: HostErrorCode,
    message: string,
    options: { retryable?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HostError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

export function toHostError(error: unknown): HostError {
  if (error instanceof HostError) {
    return error;
  }
  return new HostError("INTERNAL", errorMessage(error), { cause: error });
}
