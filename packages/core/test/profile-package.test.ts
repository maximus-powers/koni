import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProfileBaselineFile, ProfilePackageManifest } from "../src/contracts/profile-package.js";
import {
  computeProfileBundleSha256,
  parseProfilePackageManifest,
  validateProfilePackageManifest,
  verifyProfileBaseline,
} from "../src/compiler/profile-package.js";
import { rawSha256 } from "../src/shared/canonical.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("profile package manifests", () => {
  it.each([
    [
      "coding",
      "packages/coding-profile/koni/profile-manifest.json",
      "packages/coding-profile/koni/baseline",
      "sha256:850aedcdd53edeff41be7fcc8599b159b3516ac3772d5d8d3e22998d04ccade9",
      45,
    ],
    [
      "research",
      "packages/research-profile/koni/profile-manifest.json",
      "packages/research-profile/koni/baseline",
      "sha256:516ca34e79916431d44dd130201a4c84659df2bbf6f3dfd76b3d2c7d69f581f2",
      48,
    ],
  ])("validates and byte-verifies the frozen %s profile bundle", (_name, manifestPath, baselinePath, digest, count) => {
    const parsed = parseProfilePackageManifest(
      readFileSync(resolve(repositoryRoot, manifestPath), "utf8"),
    );
    expect(parsed.ok, parsed.diagnostics.map((item) => `${item.path}:${item.code}`).join(", ")).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.bundle_sha256).toBe(digest);
    expect(parsed.value.baseline.files).toHaveLength(count);
    const verified = verifyProfileBaseline(parsed.value, readTree(resolve(repositoryRoot, baselinePath)));
    expect(verified.ok, verified.diagnostics.map((item) => `${item.path}:${item.code}`).join(", ")).toBe(true);
  });

  it("hashes the exact sorted NUL-delimited bundle sequence", () => {
    const files: ProfileBaselineFile[] = [
      { path: "z.yaml", sha256: rawSha256("z"), size_bytes: 1, kind: "config" },
      { path: "a.yaml", sha256: rawSha256("a"), size_bytes: 1, kind: "config" },
    ];
    const expected = rawSha256(
      ["a.yaml", rawSha256("a"), "1", "config", "z.yaml", rawSha256("z"), "1", "config", ""].join("\0"),
    );
    expect(computeProfileBundleSha256(files)).toBe(expected);
  });

  it.each([
    ["unknown fields", (value: Record<string, unknown>) => { value.runtime = {}; }, "manifest.unknown_field"],
    [
      "path traversal",
      (value: Record<string, unknown>) => {
        baselineFiles(value)[0]!.path = "../outside";
      },
      "manifest.file_path",
    ],
    [
      "unsorted files",
      (value: Record<string, unknown>) => {
        baselineFiles(value).reverse();
      },
      "manifest.file_order",
    ],
    [
      "duplicate files",
      (value: Record<string, unknown>) => {
        baselineFiles(value)[1]!.path = baselineFiles(value)[0]!.path;
      },
      "manifest.duplicate_file",
    ],
    [
      "wrong bundle digest",
      (value: Record<string, unknown>) => {
        value.bundle_sha256 = rawSha256("wrong");
      },
      "manifest.bundle_hash",
    ],
    [
      "incompatible schema",
      (value: Record<string, unknown>) => {
        compatibility(value).profile_schema_range = ">=1.0.0 <2.0.0";
      },
      "manifest.incompatible",
    ],
  ])("fails closed for %s", (_name, mutate, expectedCode) => {
    const manifest = validSyntheticManifest();
    const value = structuredClone(manifest) as unknown as Record<string, unknown>;
    mutate(value);
    const validated = validateProfilePackageManifest(value);
    expect(validated.ok).toBe(false);
    expect(validated.diagnostics.map((item) => item.code)).toContain(expectedCode);
  });

  it("reports missing, extra, changed, and resized baseline files deterministically", () => {
    const manifest = validSyntheticManifest();
    const files = new Map<string, Uint8Array>([
      ["a.yaml", Buffer.from("changed")],
      ["extra.yaml", Buffer.from("extra")],
    ]);
    const verified = verifyProfileBaseline(manifest, files);
    expect(verified.ok).toBe(false);
    expect(verified.diagnostics.map((item) => item.code)).toEqual([
      "baseline.unexpected_file",
      "baseline.sha256",
      "baseline.size",
      "baseline.missing_file",
    ]);
  });
});

function validSyntheticManifest(): ProfilePackageManifest {
  const files: ProfileBaselineFile[] = [
    { path: "a.yaml", sha256: rawSha256("a"), size_bytes: 1, kind: "config" },
    { path: "b.yaml", sha256: rawSha256("b"), size_bytes: 1, kind: "config" },
  ];
  return {
    protocol: "koni.profile-package.v1",
    package: { name: "@koni/test-profile", version: "1.2.3" },
    profile: { id: "test", display_name: "Test", version: "1.2.3", lineage: "example.test" },
    compatibility: {
      core_api_range: ">=1.0.0 <2.0.0",
      profile_schema_range: ">=2.0.0 <3.0.0",
      pi_range: ">=0.80.10 <0.81.0",
    },
    baseline: { root: "./baseline", files },
    bundle_sha256: computeProfileBundleSha256(files),
  };
}

function baselineFiles(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const baseline = value.baseline as Record<string, unknown>;
  return baseline.files as Array<Record<string, unknown>>;
}

function compatibility(value: Record<string, unknown>): Record<string, unknown> {
  return value.compatibility as Record<string, unknown>;
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
