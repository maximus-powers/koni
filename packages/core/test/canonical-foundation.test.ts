import { describe, expect, it } from "vitest";
import {
  CanonicalEncodingError,
  canonicalEncode,
  canonicalHash,
  compareUtf8,
} from "../src/shared/canonical.js";
import { DiagnosticBag } from "../src/shared/diagnostics.js";

describe("canonical encoding", () => {
  it.each([
    [
      { b: 2, a: 1 },
      '{"a":1,"b":2}',
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    ],
    [
      [null, true, false, "π", { z: -7, a: [1, 2] }],
      '[null,true,false,"π",{"a":[1,2],"z":-7}]',
      "sha256:02c06e7d87e74726b891b598e29bc0c07ad159fb00f19d7817a7d6f93b25bf7b",
    ],
    [
      { "😀": "astral", "\ue000": "bmp" },
      '{"":"bmp","😀":"astral"}',
      "sha256:4874d36535a1b5dfdad7f2b3af83f87debd2f0795ae7d2d09447e17223c42dd0",
    ],
    [
      new Uint8Array([0, 1, 255]),
      "[0,1,255]",
      "sha256:41d30cae87b2949938e7b12346ec6346f4419b78f3a84bcb243b2dbc6706e824",
    ],
  ])("matches a frozen Rust normalized-hash vector", (value, encoded, digest) => {
    expect(canonicalEncode(value)).toBe(encoded);
    expect(canonicalHash(value)).toBe(digest);
  });

  it("sorts by UTF-8 bytes instead of JavaScript UTF-16 code units", () => {
    expect(["😀", "\ue000"].sort(compareUtf8)).toEqual(["\ue000", "😀"]);
  });

  it("preserves arrays and uses bigint for exact integers outside the safe range", () => {
    expect(canonicalEncode([3, 2, 1])).toBe("[3,2,1]");
    expect(canonicalEncode(18_446_744_073_709_551_615n)).toBe("18446744073709551615");
  });

  it.each([
    [Number.NaN, "canonical.non_finite_number"],
    [Number.POSITIVE_INFINITY, "canonical.non_finite_number"],
    [Number.MAX_SAFE_INTEGER + 1, "canonical.unsafe_integer"],
    [{ value: undefined }, "canonical.unsupported_type"],
    [[, 1], "canonical.sparse_array"],
    [new Date(0), "canonical.non_plain_object"],
    ["\ud800", "canonical.invalid_unicode"],
  ])("rejects a value that cannot cross the canonical boundary", (value, code) => {
    try {
      canonicalEncode(value);
      throw new Error("expected canonical encoding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalEncodingError);
      expect((error as CanonicalEncodingError).code).toBe(code);
    }
  });

  it("rejects cycles without rejecting a repeated acyclic value", () => {
    const shared = { value: 1 };
    expect(canonicalEncode([shared, shared])).toBe('[{"value":1},{"value":1}]');
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalEncode(cycle)).toThrow(/cycles/);
  });
});

describe("deterministic diagnostics", () => {
  it("sorts and deduplicates independently of discovery order", () => {
    const first = new DiagnosticBag();
    first.error("z.code", "/b", "second");
    first.error("a.code", "/a", "first");
    first.error("a.code", "/a", "first");
    const second = new DiagnosticBag();
    second.error("a.code", "/a", "first");
    second.error("z.code", "/b", "second");
    expect(first.sorted()).toEqual(second.sorted());
    expect(first.sorted()).toHaveLength(2);
  });
});
