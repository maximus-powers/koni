const FIXED_PATTERNS: ReadonlyArray<RegExp> = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
];

const SENSITIVE_FIELD = "(?:access_token|refresh_token|authorization_code|code_verifier|device_auth_id)";
const STRUCTURED_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`(["']?${SENSITIVE_FIELD}["']?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, "giu"),
  new RegExp(`(["']?${SENSITIVE_FIELD}["']?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, "giu"),
  new RegExp(`(["']?${SENSITIVE_FIELD}["']?\\s*[:=]\\s*)[^\\s,;&}\\]]+`, "giu"),
];

export class SecretRedactor {
  private readonly secrets = new Set<string>();

  add(secret: unknown): void {
    if (typeof secret === "string" && secret.length >= 8) {
      this.secrets.add(secret);
    }
  }

  addCredential(value: unknown): void {
    if (!value || typeof value !== "object") {
      return;
    }
    const credential = value as Record<string, unknown>;
    this.add(credential["access"]);
    this.add(credential["refresh"]);
    this.add(credential["key"]);
  }

  redact(message: string): string {
    let redacted = message;
    for (const secret of this.secrets) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    for (const pattern of FIXED_PATTERNS) {
      redacted = redacted.replace(pattern, "[REDACTED]");
    }
    for (const pattern of STRUCTURED_SECRET_PATTERNS) {
      redacted = redacted.replace(pattern, "$1[REDACTED]");
    }
    return redacted;
  }
}
