import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseProfilePackageManifest,
  verifyProfileBaseline,
} from "../src/compiler/profile-package.js";
import type { ProfilePackageManifest } from "../src/contracts/profile-package.js";
import { loadProfilePackage } from "../src/profile/install.js";

const fixtures = [
  {
    directory: "coding-0.7.0",
    bundleSha256: "sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e",
    targetDirectory: "coding-profile",
    targetBundleSha256: "sha256:e28d40177288d8eb51622a2b1523d0a415ba694efcb4e5227b2158ab87550a62",
  },
  {
    directory: "research-1.0.11",
    bundleSha256: "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
    targetDirectory: "research-profile",
    targetBundleSha256: "sha256:42944fa6eb6658ba1bd650228975c2dfeef1fc5fcfa319c551203226d1b1d9dd",
  },
] as const;

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

describe("prior profile release fixtures", () => {
  it.each(fixtures)(
    "$directory is the byte-exact authenticated schema-2 release",
    async (fixture) => {
      const packageRoot = path.join(
        import.meta.dirname,
        "fixtures",
        "profile-prior-releases",
        fixture.directory,
      );

      const parsed = parseProfilePackageManifest(
        await readFile(path.join(packageRoot, "koni", "profile-manifest.json"), "utf8"),
        { compatibility: { profileSchemaVersion: "2.0.0" } },
      );
      expect(parsed.ok, parsed.diagnostics.map(({ message }) => message).join("\n")).toBe(true);
      if (!parsed.ok) return;
      const verified = verifyProfileBaseline(
        parsed.value,
        readTree(path.join(packageRoot, "koni", "baseline")),
      );
      expect(verified.ok, verified.diagnostics.map(({ message }) => message).join("\n")).toBe(true);
      expect(parsed.value.bundle_sha256).toBe(fixture.bundleSha256);
      expect(parsed.value.migrations).toBeUndefined();
      await expect(loadProfilePackage(packageRoot)).rejects.toMatchObject({
        code: "manifest_invalid",
      });
    },
  );

  it.each(fixtures)("$directory is named exactly once by its target migration", async (fixture) => {
    const manifest = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "packages",
          fixture.targetDirectory,
          "koni",
          "profile-manifest.json",
        ),
        "utf8",
      ),
    ) as ProfilePackageManifest;

    const matchingMigrations = (manifest.migrations ?? []).filter((migration) =>
      migration.from_bundle_sha256.includes(fixture.bundleSha256),
    );

    expect(manifest.bundle_sha256).toBe(fixture.targetBundleSha256);
    expect(matchingMigrations).toHaveLength(1);
  });
});

function readTree(root: string): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile())
        files.set(
          path.relative(root, candidate).split(path.sep).join("/"),
          readFileSync(candidate),
        );
    }
  };
  visit(root);
  return files;
}
