import { createHash } from "node:crypto";

export const SHA256_PREFIX = "sha256:" as const;

export type Sha256Digest = `${typeof SHA256_PREFIX}${string}`;

export class CanonicalEncodingError extends Error {
  public readonly code: string;
  public readonly path: string;

  public constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "CanonicalEncodingError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Encode the JSON-compatible value using Koni's frozen Rust-oracle ordering.
 *
 * Object keys use UTF-8 byte order (Rust `String::cmp`), arrays retain their
 * order, and unsupported JavaScript values fail instead of being omitted.
 * `Uint8Array` follows Serde's `Vec<u8>` representation as an array of bytes.
 */
export function canonicalEncode(value: unknown): string {
  return encodeCanonical(value, "$", new Set<object>());
}

export function canonicalHash(value: unknown): Sha256Digest {
  return rawSha256(canonicalEncode(value));
}

export function rawSha256(value: string | Uint8Array): Sha256Digest {
  const digest = createHash("sha256").update(value).digest("hex");
  return `${SHA256_PREFIX}${digest}`;
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function encodeCanonical(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      ensureUnicodeScalarString(value, path);
      return JSON.stringify(value);
    case "number":
      return encodeNumber(value, path);
    case "bigint":
      return value.toString(10);
    case "object":
      break;
    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalEncodingError(
        "canonical.unsupported_type",
        path,
        "canonical values may contain only JSON data, byte arrays, or bigint integers",
      );
    default: {
      throw new CanonicalEncodingError(
        "canonical.unsupported_type",
        path,
        "canonical value has an unsupported runtime type",
      );
    }
  }

  if (ancestors.has(value)) {
    throw new CanonicalEncodingError(
      "canonical.cycle",
      path,
      "canonical values must not contain cycles",
    );
  }
  ancestors.add(value);
  try {
    if (value instanceof Uint8Array) {
      return `[${[...value].join(",")}]`;
    }
    if (Array.isArray(value)) {
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalEncodingError(
            "canonical.sparse_array",
            `${path}[${index}]`,
            "canonical arrays must not contain holes",
          );
        }
        encoded.push(encodeCanonical(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${encoded.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalEncodingError(
        "canonical.non_plain_object",
        path,
        "canonical objects must be plain records",
      );
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    const encoded = keys.map((key) => {
      ensureUnicodeScalarString(key, path);
      return `${JSON.stringify(key)}:${encodeCanonical(record[key], childPath(path, key), ancestors)}`;
    });
    return `{${encoded.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function encodeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalEncodingError(
      "canonical.non_finite_number",
      path,
      "canonical numbers must be finite",
    );
  }
  if (Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalEncodingError(
        "canonical.unsafe_integer",
        path,
        "integers outside JavaScript's exact range must be represented as bigint",
      );
    }
    return Object.is(value, -0) ? "0" : value.toString(10);
  }

  // Serde JSON uses Ryu's compact formatting with scientific notation below
  // 1e-5 and from 1e16. JavaScript provides the same shortest round-tripping
  // significand; normalize only the notation boundary.
  const absolute = Math.abs(value);
  if (absolute < 1e-5 || absolute >= 1e16) {
    return value.toExponential();
  }
  return value.toString();
}

function ensureUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalEncodingError(
          "canonical.invalid_unicode",
          path,
          "canonical strings must contain valid Unicode scalar values",
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalEncodingError(
        "canonical.invalid_unicode",
        path,
        "canonical strings must contain valid Unicode scalar values",
      );
    }
  }
}

function childPath(parent: string, key: string): string {
  const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
  return parent === "$" ? `$/${escaped}` : `${parent}/${escaped}`;
}
