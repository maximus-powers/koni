import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStrictYaml, parseStrictYamlObject } from "../src/shared/yaml.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("strict YAML", () => {
  it.each([
    "profiles/research/profile.yaml",
    "crates/koni-cli/templates/software/profile.yaml",
    "reference/parity/normalization.yaml",
  ])("accepts the frozen profile/oracle fixture %s", (path) => {
    const parsed = parseStrictYamlObject(readFileSync(resolve(repositoryRoot, path), "utf8"));
    expect(parsed.ok, parsed.diagnostics.map((item) => item.code).join(", ")).toBe(true);
  });

  it.each([
    ["duplicate keys", "value: 1\nvalue: 2\n", "yaml.duplicate_key"],
    ["aliases", "base: &base {value: 1}\ncopy: *base\n", "yaml.anchor"],
    ["merge keys", "base: &base {value: 1}\ncopy: {<<: *base}\n", "yaml.anchor"],
    ["multiple documents", "value: 1\n---\nvalue: 2\n", "yaml.document_count"],
    ["custom tags", "value: !private opaque-secret-value\n", "yaml.tag"],
    ["unsafe keys", "__proto__: {polluted: true}\n", "yaml.unsafe_key"],
    ["unsafe integers", "value: 9007199254740992\n", "yaml.unsafe_integer"],
  ])("rejects %s before configuration validation", (_name, source, code) => {
    const parsed = parseStrictYaml(source);
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.map((item) => item.code)).toContain(code);
  });

  it("enforces byte, depth, node, and scalar budgets", () => {
    expect(parseStrictYaml("value: abc\n", { maxBytes: 2 }).ok).toBe(false);
    expect(parseStrictYaml("a:\n  b:\n    c: 1\n", { maxDepth: 1 }).ok).toBe(false);
    expect(parseStrictYaml("a: [1, 2, 3]\n", { maxNodes: 2 }).ok).toBe(false);
    expect(parseStrictYaml("value: abcdef\n", { maxScalarBytes: 3 }).ok).toBe(false);
  });

  it("never copies hostile source text into diagnostics", () => {
    const secret = "oauth-super-secret-value";
    const parsed = parseStrictYaml(`value: !private ${secret}\n`);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed.diagnostics)).not.toContain(secret);
  });
});
