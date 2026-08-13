import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ProfileBaselineFile,
  ProfileMigration,
  ProfilePackageManifest,
} from "../src/contracts/profile-package.js";
import {
  computeProfileBundleSha256,
  parseProfilePackageManifest,
  validateProfilePackageManifest,
  verifyProfileBaseline,
} from "../src/compiler/profile-package.js";
import { rawSha256 } from "../src/shared/canonical.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("profile package manifests", () => {
  it("assigns gate contracts and validates links only to compatible verifier assets", () => {
    const operations = readFileSync(
      resolve(repositoryRoot, "packages/research-profile/koni/baseline/operations/research.yaml"),
      "utf8",
    );
    expect(operations).toContain(
      "only when the target asset is capability-compatible with one or more research gates",
    );
  });

  it.each([
    [
      "coding",
      "packages/coding-profile/koni/profile-manifest.json",
      "packages/coding-profile/koni/baseline",
      "sha256:e296d085576e36f083ecfbb22ad011f36493db01282994789cd725c80d376f2a",
      27,
    ],
    [
      "research",
      "packages/research-profile/koni/profile-manifest.json",
      "packages/research-profile/koni/baseline",
      "sha256:add73d8b0bbe7bed13452e9692ad231de2f6427c162bb401a31a8e7a1c552caa",
      29,
    ],
  ])(
    "validates and byte-verifies the reviewed %s profile bundle",
    (_name, manifestPath, baselinePath, digest, count) => {
      const parsed = parseProfilePackageManifest(
        readFileSync(resolve(repositoryRoot, manifestPath), "utf8"),
      );
      expect(
        parsed.ok,
        parsed.diagnostics.map((item) => `${item.path}:${item.code}`).join(", "),
      ).toBe(true);
      if (!parsed.ok) {
        return;
      }
      expect(parsed.value.bundle_sha256).toBe(digest);
      expect(parsed.value.baseline.files).toHaveLength(count);
      const verified = verifyProfileBaseline(
        parsed.value,
        readTree(resolve(repositoryRoot, baselinePath)),
      );
      expect(
        verified.ok,
        verified.diagnostics.map((item) => `${item.path}:${item.code}`).join(", "),
      ).toBe(true);
    },
  );

  it("hashes the exact sorted NUL-delimited bundle sequence", () => {
    const files: ProfileBaselineFile[] = [
      { path: "z.yaml", sha256: rawSha256("z"), size_bytes: 1, kind: "config" },
      { path: "a.yaml", sha256: rawSha256("a"), size_bytes: 1, kind: "config" },
    ];
    const expected = rawSha256(
      ["a.yaml", rawSha256("a"), "1", "config", "z.yaml", rawSha256("z"), "1", "config", ""].join(
        "\0",
      ),
    );
    expect(computeProfileBundleSha256(files)).toBe(expected);
    expect(computeProfileBundleSha256(files, [])).toBe(expected);
  });

  it("accepts only authenticated declarative retirements and binds them into bundle identity", () => {
    const first = migrationFixture({
      id: "retire-orchestration-fields",
      path: "migrations/retire-orchestration-fields.json",
    });
    const second = migrationFixture({
      id: "retire-storage-fields",
      path: "migrations/retire-storage-fields.json",
    });
    const manifest = validSyntheticManifest([second, first]);
    const validated = validateProfilePackageManifest(manifest);
    expect(
      validated.ok,
      validated.diagnostics.map((item) => `${item.path}:${item.code}`).join(", "),
    ).toBe(true);
    expect(computeProfileBundleSha256(manifest.baseline.files, [first, second])).toBe(
      manifest.bundle_sha256,
    );
    expect(computeProfileBundleSha256(manifest.baseline.files, [second, first])).toBe(
      manifest.bundle_sha256,
    );
    expect(computeProfileBundleSha256(manifest.baseline.files)).not.toBe(manifest.bundle_sha256);
  });

  it.each([
    [
      "unknown fields",
      (value: Record<string, unknown>) => {
        value.runtime = {};
      },
      "manifest.unknown_field",
    ],
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
    [
      "executable migration kinds during the declarative transition",
      (value: Record<string, unknown>) => {
        value.migrations = [
          {
            id: "legacy-layout",
            kind: "javascript",
            from_profile_range: "<1.2.3",
            from_bundle_sha256: [rawSha256("old-bundle")],
            path: "migrations/legacy-layout.json",
            sha256: rawSha256("migration"),
          },
        ];
      },
      "manifest.migration_kind",
    ],
    [
      "unknown migration fields",
      (value: Record<string, unknown>) => {
        value.migrations = [{ ...migrationFixture(), command: "rm -rf /" }];
      },
      "manifest.unknown_field",
    ],
    [
      "empty migration source bundles",
      (value: Record<string, unknown>) => {
        value.migrations = [{ ...migrationFixture(), from_bundle_sha256: [] }];
      },
      "manifest.migration_source_count",
    ],
    [
      "unsorted migration source bundles",
      (value: Record<string, unknown>) => {
        const sourceDigests = [rawSha256("a"), rawSha256("z")].sort().reverse();
        value.migrations = [{ ...migrationFixture(), from_bundle_sha256: sourceDigests }];
      },
      "manifest.migration_source_order",
    ],
    [
      "duplicate migration source bundles",
      (value: Record<string, unknown>) => {
        const sourceDigest = rawSha256("old-bundle");
        value.migrations = [
          { ...migrationFixture(), from_bundle_sha256: [sourceDigest, sourceDigest] },
        ];
      },
      "manifest.duplicate_migration_source",
    ],
    [
      "unbounded migration version ranges",
      (value: Record<string, unknown>) => {
        value.migrations = [{ ...migrationFixture(), from_profile_range: "*" }];
      },
      "manifest.semver_range",
    ],
    [
      "unsafe migration paths",
      (value: Record<string, unknown>) => {
        value.migrations = [{ ...migrationFixture(), path: "../migration.json" }];
      },
      "manifest.migration_path",
    ],
    [
      "unsafe migration ids",
      (value: Record<string, unknown>) => {
        value.migrations = [{ ...migrationFixture(), id: "Run arbitrary code" }];
      },
      "manifest.migration_id",
    ],
    [
      "duplicate migration paths",
      (value: Record<string, unknown>) => {
        value.migrations = [migrationFixture({ id: "first" }), migrationFixture({ id: "second" })];
      },
      "manifest.duplicate_migration_path",
    ],
    [
      "duplicate migration ids",
      (value: Record<string, unknown>) => {
        value.migrations = [
          migrationFixture({ path: "migrations/first.json" }),
          migrationFixture({ path: "migrations/second.json" }),
        ];
      },
      "manifest.duplicate_migration",
    ],
    [
      "too many migrations",
      (value: Record<string, unknown>) => {
        value.migrations = Array.from({ length: 1_025 }, (_, index) =>
          migrationFixture({
            id: `retire-field-${index}`,
            path: `migrations/retire-field-${index}.json`,
          }),
        );
      },
      "manifest.migration_count",
    ],
    [
      "too many migration source bundles",
      (value: Record<string, unknown>) => {
        value.migrations = [
          {
            ...migrationFixture(),
            from_bundle_sha256: Array.from({ length: 1_025 }, (_, index) =>
              rawSha256(`old-${index}`),
            ).sort(),
          },
        ];
      },
      "manifest.migration_source_count",
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

function validSyntheticManifest(
  migrations: readonly ProfileMigration[] = [],
): ProfilePackageManifest {
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
      profile_schema_range: ">=3.0.0 <4.0.0",
      pi_range: ">=0.80.10 <0.81.0",
    },
    baseline: { root: "./baseline", files },
    bundle_sha256: computeProfileBundleSha256(files, migrations),
    ...(migrations.length === 0 ? {} : { migrations }),
  };
}

function migrationFixture(overrides: Partial<ProfileMigration> = {}): ProfileMigration {
  return {
    id: "retire-storage-fields",
    kind: "retire_yaml_fields",
    from_profile_range: ">=1.0.0 <2.0.0",
    from_bundle_sha256: [rawSha256("old-bundle")],
    path: "migrations/retire-storage-fields.json",
    sha256: rawSha256("migration"),
    ...overrides,
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
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
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
