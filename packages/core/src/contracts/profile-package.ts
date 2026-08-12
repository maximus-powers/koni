import type { Sha256Digest } from "../shared/canonical.js";

export const PROFILE_PACKAGE_PROTOCOL = "koni.profile-package.v1" as const;
export const PROFILE_PACKAGE_BASELINE_ROOT = "./baseline" as const;
export const KONI_CORE_API_VERSION = "1.0.0" as const;
export const KONI_PROFILE_SCHEMA_VERSION = "3.0.0" as const;
export const KONI_PI_VERSION = "0.80.10" as const;

export type ProfileFileKind = "config" | "agent" | "skill" | "prompt" | "other";

export interface ProfilePackageIdentity {
  name: string;
  version: string;
}

export interface ProfileIdentity {
  id: string;
  display_name: string;
  version: string;
  lineage: string;
}

export interface ProfileCompatibility {
  core_api_range: string;
  profile_schema_range: string;
  pi_range: string;
}

export interface ProfileBaselineFile {
  path: string;
  sha256: Sha256Digest;
  size_bytes: number;
  kind: ProfileFileKind;
}

export interface ProfileBaseline {
  root: typeof PROFILE_PACKAGE_BASELINE_ROOT;
  files: readonly ProfileBaselineFile[];
}

export interface ProfileRetireYamlFieldsMigration {
  id: string;
  kind: "retire_yaml_fields";
  from_profile_range: string;
  from_bundle_sha256: readonly Sha256Digest[];
  path: string;
  sha256: Sha256Digest;
}

export type ProfileMigration = ProfileRetireYamlFieldsMigration;

export interface ProfilePackageManifest {
  protocol: typeof PROFILE_PACKAGE_PROTOCOL;
  package: ProfilePackageIdentity;
  profile: ProfileIdentity;
  compatibility: ProfileCompatibility;
  baseline: ProfileBaseline;
  bundle_sha256: Sha256Digest;
  migrations?: readonly ProfileMigration[];
}

export interface ProfileCompatibilityTarget {
  coreApiVersion: string;
  profileSchemaVersion: string;
  piVersion: string;
}

export const DEFAULT_PROFILE_COMPATIBILITY_TARGET: Readonly<ProfileCompatibilityTarget> =
  Object.freeze({
    coreApiVersion: KONI_CORE_API_VERSION,
    profileSchemaVersion: KONI_PROFILE_SCHEMA_VERSION,
    piVersion: KONI_PI_VERSION,
  });
