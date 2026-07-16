import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  compileProfileConfiguration,
  compileProjectConfiguration,
  type AuthenticatedProjectConfigurationSource,
} from "../src/compiler/configuration.js";
import {
  computeProfileBundleSha256,
  parseProfilePackageManifest,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import type {
  ProfileBaselineFile,
  ProfilePackageManifest,
} from "../src/contracts/profile-package.js";
import { rawSha256 } from "../src/shared/canonical.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("schema-2 configuration loader", () => {
  it.each([
    ["coding", "coding-profile", "software", 5, 10, 31],
    ["research", "research-profile", "research", 3, 13, 58],
  ])(
    "compiles the frozen %s profile into a complete immutable catalog",
    (_name, packageDirectory, profileId, runTypeCount, agentCount, edgeCount) => {
      const baseline = readBaseline(packageDirectory);
      const result = compileProfileConfiguration(baseline);
      expect(result.ok, diagnostics(result)).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.package.profile_id).toBe(profileId);
      expect(result.value.run_type_order).toHaveLength(runTypeCount);
      expect(Object.keys(result.value.agents)).toHaveLength(agentCount);
      expect(result.value.edge_types).toHaveLength(edgeCount);
      expect(result.value.baseline_bundle_sha256).toBe(baseline.manifest.bundle_sha256);
      expect(result.value.effective_bundle_sha256).toBe(baseline.manifest.bundle_sha256);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.profile)).toBe(true);
      expect(Object.isFrozen(result.value.registries.node_types)).toBe(true);
      expect(Object.isFrozen(result.value.run_types[result.value.run_type_order[0]!]?.document)).toBe(true);
    },
  );

  it("materializes constrained derived run types without mutating their source form", () => {
    const result = compileProfileConfiguration(readBaseline("coding-profile"));
    expect(result.ok, diagnostics(result)).toBe(true);
    if (!result.ok) {
      return;
    }
    const medium = result.value.run_types.medium!;
    const feature = result.value.run_types["new-feature"]!;
    expect(feature.extends).toBe("medium");
    expect(feature.ancestry).toEqual(["medium"]);
    expect(feature.source.extends).toBe("medium");
    expect(feature.source.overrides).toBeDefined();
    expect(feature.document.extends).toBeUndefined();
    expect(feature.document.overrides).toBeUndefined();
    expect(nested(feature.document, "orchestration", "max_parallel")).toBe(3);
    expect(nested(medium.document, "orchestration", "max_parallel")).toBe(3);
    expect(nested(feature.document, "intake", "order")).toEqual([
      "goal",
      "acceptance_examples",
      "non_goals",
    ]);
  });

  it("compiles authenticated editable project bytes independently of the frozen baseline", () => {
    const baseline = readBaseline("coding-profile");
    const original = compileProfileConfiguration(baseline);
    expect(original.ok, diagnostics(original)).toBe(true);
    const source = editYaml(toProjectSource(baseline), "project.yaml", (document) => {
      asRecord(document.project).title = "Local project title";
    });
    const edited = compileProjectConfiguration(source);
    expect(edited.ok, diagnostics(edited)).toBe(true);
    if (!original.ok || !edited.ok) {
      return;
    }
    expect(asRecord(edited.value.project.project).title).toBe("Local project title");
    expect(edited.value.baseline_bundle_sha256).toBe(original.value.baseline_bundle_sha256);
    expect(edited.value.effective_bundle_sha256).not.toBe(original.value.effective_bundle_sha256);
    expect(edited.value.configuration_sha256).not.toBe(original.value.configuration_sha256);
  });

  it("fails before parsing when effective bytes do not match their inventory", () => {
    const source = toProjectSource(readBaseline("coding-profile"));
    const contents = new Map(source.contents);
    contents.set("project.yaml", Buffer.from("schema_version: '2.0'\n"));
    const result = compileProjectConfiguration({ ...source, contents });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("project_files.hash_mismatch");
  });

  it.each([
    [
      "unknown profile fields",
      (source: AuthenticatedProjectConfigurationSource) =>
        editYaml(source, "profile.yaml", (document) => { document.ambient_runtime = {}; }),
      "configuration.unknown_field",
    ],
    [
      "unknown module fields",
      (source: AuthenticatedProjectConfigurationSource) =>
        editYaml(source, "graph.yaml", (document) => { document.hidden_payload = []; }),
      "configuration.unknown_field",
    ],
    [
      "duplicate registry ids",
      (source: AuthenticatedProjectConfigurationSource) =>
        editYaml(source, "graph.yaml", (document) => {
          const nodes = document.node_types as unknown[];
          nodes.push(structuredClone(nodes[0]));
        }),
      "configuration.duplicate_id",
    ],
    [
      "dangling agent references",
      (source: AuthenticatedProjectConfigurationSource) =>
        editYaml(source, "personas.yaml", (document) => {
          asRecord((document.personas as unknown[])[0]).agent = "absent-agent";
        }),
      "configuration.dangling_reference",
    ],
    [
      "array-style inheritance overrides",
      (source: AuthenticatedProjectConfigurationSource) =>
        editYaml(source, "run-types/bug-fix.yaml", (document) => {
          asRecord((document.overrides as unknown[])[0]).path = "/intake/order/0";
        }),
      "configuration.override_path",
    ],
  ])("fails closed for %s", (_name, mutate, code) => {
    const source = mutate(toProjectSource(readBaseline("coding-profile")));
    const result = compileProjectConfiguration(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(code);
  });

  it("rejects run type inheritance cycles deterministically", () => {
    let source = toProjectSource(readBaseline("coding-profile"));
    source = editYaml(source, "run-types/bug-fix.yaml", (document) => {
      document.extends = "new-feature";
    });
    source = editYaml(source, "run-types/new-feature.yaml", (document) => {
      document.extends = "bug-fix";
    });
    const result = compileProjectConfiguration(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("configuration.run_type_cycle");
  });

  it("rejects invalid UTF-8 even when the effective inventory authenticates it", () => {
    const source = replaceBytes(
      toProjectSource(readBaseline("coding-profile")),
      "project.yaml",
      Uint8Array.from([0xff, 0xfe, 0xfd]),
    );
    const result = compileProjectConfiguration(source);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("configuration.utf8");
  });
});

function readBaseline(packageDirectory: string): VerifiedProfileBaseline {
  const packageRoot = resolve(repositoryRoot, "packages", packageDirectory, "koni");
  const manifestResult = parseProfilePackageManifest(
    readFileSync(join(packageRoot, "profile-manifest.json"), "utf8"),
  );
  if (!manifestResult.ok) {
    throw new Error(diagnostics(manifestResult));
  }
  return { manifest: manifestResult.value, files: readTree(join(packageRoot, "baseline")) };
}

function toProjectSource(baseline: VerifiedProfileBaseline): AuthenticatedProjectConfigurationSource {
  return {
    manifest: structuredClone(baseline.manifest),
    files: structuredClone(baseline.manifest.baseline.files),
    contents: new Map([...baseline.files].map(([path, bytes]) => [path, Uint8Array.from(bytes)])),
  };
}

function editYaml(
  source: AuthenticatedProjectConfigurationSource,
  path: string,
  edit: (document: Record<string, unknown>) => void,
): AuthenticatedProjectConfigurationSource {
  const bytes = source.contents.get(path);
  if (bytes === undefined) {
    throw new Error(`missing fixture ${path}`);
  }
  const document = YAML.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
  edit(document);
  return replaceBytes(source, path, Buffer.from(YAML.stringify(document)));
}

function replaceBytes(
  source: AuthenticatedProjectConfigurationSource,
  path: string,
  bytes: Uint8Array,
): AuthenticatedProjectConfigurationSource {
  const contents = new Map(source.contents);
  contents.set(path, Uint8Array.from(bytes));
  const files = source.files.map((file): ProfileBaselineFile =>
    file.path === path
      ? { ...file, sha256: rawSha256(bytes), size_bytes: bytes.byteLength }
      : { ...file });
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { manifest: source.manifest, files, contents };
}

function readTree(root: string): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
      }
    }
  };
  visit(root);
  return files;
}

function nested(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    current = asRecord(current)[segment];
  }
  return current;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected record");
  }
  return value as Record<string, unknown>;
}

function diagnostics(result: { diagnostics: readonly { path: string; code: string; message: string }[] }): string {
  return result.diagnostics.map((item) => `${item.path}:${item.code}:${item.message}`).join("\n");
}
