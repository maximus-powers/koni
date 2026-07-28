import { satisfies, valid, validRange } from "semver";
import {
  DEFAULT_PROFILE_COMPATIBILITY_TARGET,
  PROFILE_PACKAGE_BASELINE_ROOT,
  PROFILE_PACKAGE_PROTOCOL,
  type ProfileBaselineFile,
  type ProfileCompatibilityTarget,
  type ProfileFileKind,
  type ProfileMigration,
  type ProfilePackageManifest,
} from "../contracts/profile-package.js";
import {
  canonicalEncode,
  compareUtf8,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import {
  DiagnosticBag,
  pointer,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";
import { parseStrictYamlObject, type StrictYamlLimits } from "../shared/yaml.js";

const PROFILE_FILE_KINDS: ReadonlySet<ProfileFileKind> = new Set([
  "config",
  "agent",
  "skill",
  "prompt",
  "other",
]);
const MAX_MANIFEST_FILES = 16_384;
const MAX_MIGRATIONS = 1_024;
const MAX_MIGRATION_SOURCE_DIGESTS = 1_024;

export interface VerifiedProfileBaseline {
  manifest: ProfilePackageManifest;
  files: ReadonlyMap<string, Uint8Array>;
}

export function parseProfilePackageManifest(
  source: string,
  options: {
    compatibility?: Partial<ProfileCompatibilityTarget>;
    yamlLimits?: Partial<StrictYamlLimits>;
  } = {},
): ValidationResult<ProfilePackageManifest> {
  const parsed = parseStrictYamlObject(source, options.yamlLimits);
  if (!parsed.ok) {
    return parsed;
  }
  const validated = validateProfilePackageManifest(parsed.value, options.compatibility);
  if (!validated.ok) {
    const bag = new DiagnosticBag();
    bag.extend(parsed.diagnostics);
    bag.extend(validated.diagnostics);
    return validationFailure(bag.sorted());
  }
  const bag = new DiagnosticBag();
  bag.extend(parsed.diagnostics);
  bag.extend(validated.diagnostics);
  return validationSuccess(validated.value, bag.sorted());
}

export function validateProfilePackageManifest(
  value: unknown,
  targetOverrides: Partial<ProfileCompatibilityTarget> = {},
): ValidationResult<ProfilePackageManifest> {
  const bag = new DiagnosticBag();
  const root = expectRecord(
    value,
    "",
    ["protocol", "package", "profile", "compatibility", "baseline", "bundle_sha256", "migrations"],
    bag,
  );
  if (root === undefined) {
    return validationFailure(bag.sorted());
  }

  const protocol = requiredString(root, "protocol", "", bag);
  if (protocol !== undefined && protocol !== PROFILE_PACKAGE_PROTOCOL) {
    bag.error("manifest.protocol", "/protocol", "profile package protocol is not supported");
  }

  const packageRecord = expectRequiredRecord(root, "package", "", ["name", "version"], bag);
  const packageName =
    packageRecord === undefined
      ? undefined
      : requiredString(packageRecord, "name", "/package", bag);
  const packageVersion =
    packageRecord === undefined
      ? undefined
      : requiredString(packageRecord, "version", "/package", bag);
  if (packageName !== undefined && !isPackageName(packageName)) {
    bag.error("manifest.package_name", "/package/name", "package name is not a canonical npm name");
  }
  validateExactSemver(packageVersion, "/package/version", "manifest.package_version", bag);

  const profileRecord = expectRequiredRecord(
    root,
    "profile",
    "",
    ["id", "display_name", "version", "lineage"],
    bag,
  );
  const profileId =
    profileRecord === undefined ? undefined : requiredString(profileRecord, "id", "/profile", bag);
  const displayName =
    profileRecord === undefined
      ? undefined
      : requiredString(profileRecord, "display_name", "/profile", bag);
  const profileVersion =
    profileRecord === undefined
      ? undefined
      : requiredString(profileRecord, "version", "/profile", bag);
  const lineage =
    profileRecord === undefined
      ? undefined
      : requiredString(profileRecord, "lineage", "/profile", bag);
  if (profileId !== undefined && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(profileId)) {
    bag.error(
      "manifest.profile_id",
      "/profile/id",
      "profile id must be a lowercase kebab identifier",
    );
  }
  if (displayName !== undefined && !isDisplayName(displayName)) {
    bag.error(
      "manifest.display_name",
      "/profile/display_name",
      "profile display name is not valid",
    );
  }
  validateExactSemver(profileVersion, "/profile/version", "manifest.profile_version", bag);
  if (lineage !== undefined && !isLineage(lineage)) {
    bag.error(
      "manifest.lineage",
      "/profile/lineage",
      "profile lineage must be one stable dotted identifier",
    );
  }

  const compatibilityRecord = expectRequiredRecord(
    root,
    "compatibility",
    "",
    ["core_api_range", "profile_schema_range", "pi_range"],
    bag,
  );
  const coreRange =
    compatibilityRecord === undefined
      ? undefined
      : requiredString(compatibilityRecord, "core_api_range", "/compatibility", bag);
  const schemaRange =
    compatibilityRecord === undefined
      ? undefined
      : requiredString(compatibilityRecord, "profile_schema_range", "/compatibility", bag);
  const piRange =
    compatibilityRecord === undefined
      ? undefined
      : requiredString(compatibilityRecord, "pi_range", "/compatibility", bag);
  const target: ProfileCompatibilityTarget = {
    ...DEFAULT_PROFILE_COMPATIBILITY_TARGET,
    ...targetOverrides,
  };
  validateRange(coreRange, target.coreApiVersion, "/compatibility/core_api_range", "core API", bag);
  validateRange(
    schemaRange,
    target.profileSchemaVersion,
    "/compatibility/profile_schema_range",
    "profile schema",
    bag,
  );
  validateRange(piRange, target.piVersion, "/compatibility/pi_range", "Pi", bag);

  const baselineRecord = expectRequiredRecord(root, "baseline", "", ["root", "files"], bag);
  const baselineRoot =
    baselineRecord === undefined
      ? undefined
      : requiredString(baselineRecord, "root", "/baseline", bag);
  if (baselineRoot !== undefined && baselineRoot !== PROFILE_PACKAGE_BASELINE_ROOT) {
    bag.error("manifest.baseline_root", "/baseline/root", "baseline root must be ./baseline");
  }
  const files =
    baselineRecord === undefined
      ? undefined
      : validateFiles(baselineRecord.files, "/baseline/files", bag);

  const bundleHash = requiredString(root, "bundle_sha256", "", bag);
  if (bundleHash !== undefined && !isSha256Digest(bundleHash)) {
    bag.error("manifest.sha256", "/bundle_sha256", "bundle digest must be canonical SHA-256");
  }
  const migrations =
    root.migrations === undefined
      ? undefined
      : validateMigrations(root.migrations, "/migrations", bag);
  if (files !== undefined && bundleHash !== undefined && isSha256Digest(bundleHash)) {
    const expected = computeProfileBundleSha256(files, migrations ?? []);
    if (bundleHash !== expected) {
      bag.error(
        "manifest.bundle_hash",
        "/bundle_sha256",
        "bundle digest does not match the baseline manifest",
      );
    }
  }

  if (
    bag.hasErrors() ||
    protocol !== PROFILE_PACKAGE_PROTOCOL ||
    packageName === undefined ||
    packageVersion === undefined ||
    profileId === undefined ||
    displayName === undefined ||
    profileVersion === undefined ||
    lineage === undefined ||
    coreRange === undefined ||
    schemaRange === undefined ||
    piRange === undefined ||
    baselineRoot !== PROFILE_PACKAGE_BASELINE_ROOT ||
    files === undefined ||
    bundleHash === undefined ||
    !isSha256Digest(bundleHash)
  ) {
    return validationFailure(bag.sorted());
  }

  const manifest: ProfilePackageManifest = {
    protocol,
    package: { name: packageName, version: packageVersion },
    profile: { id: profileId, display_name: displayName, version: profileVersion, lineage },
    compatibility: {
      core_api_range: coreRange,
      profile_schema_range: schemaRange,
      pi_range: piRange,
    },
    baseline: { root: baselineRoot, files },
    bundle_sha256: bundleHash,
    ...(migrations === undefined ? {} : { migrations }),
  };
  return validationSuccess(manifest, bag.sorted());
}

export function computeProfileBundleSha256(
  files: readonly ProfileBaselineFile[],
  migrations: readonly ProfileMigration[] = [],
): Sha256Digest {
  const ordered = [...files].sort((left, right) => compareUtf8(left.path, right.path));
  const records = ordered.map(
    (file) => `${file.path}\u0000${file.sha256}\u0000${file.size_bytes}\u0000${file.kind}\u0000`,
  );
  if (migrations.length > 0) {
    records.push("koni.profile-migrations.v1\u0000");
    const migrationRecords = migrations
      .map((migration) => canonicalEncode(migration))
      .sort(compareUtf8);
    for (const migrationRecord of migrationRecords) {
      records.push(`${migrationRecord}\u0000`);
    }
  }
  return rawSha256(records.join(""));
}

export function verifyProfileBaseline(
  manifest: ProfilePackageManifest,
  actualFiles: ReadonlyMap<string, Uint8Array>,
): ValidationResult<VerifiedProfileBaseline> {
  const bag = new DiagnosticBag();
  const expected = new Map(manifest.baseline.files.map((file) => [file.path, file]));
  for (const file of manifest.baseline.files) {
    const bytes = actualFiles.get(file.path);
    const path = pointer("/baseline/files", file.path);
    if (bytes === undefined) {
      bag.error("baseline.missing_file", path, "baseline file is missing");
      continue;
    }
    if (bytes.byteLength !== file.size_bytes) {
      bag.error("baseline.size", path, "baseline file size does not match its manifest");
    }
    if (rawSha256(bytes) !== file.sha256) {
      bag.error("baseline.sha256", path, "baseline file digest does not match its manifest");
    }
  }
  for (const path of [...actualFiles.keys()].sort(compareUtf8)) {
    if (!expected.has(path)) {
      bag.error(
        "baseline.unexpected_file",
        "/baseline/files",
        "baseline contains an unmanifested file",
      );
    }
  }
  if (bag.hasErrors()) {
    return validationFailure(bag.sorted());
  }
  return validationSuccess({ manifest, files: actualFiles }, bag.sorted());
}

export function isNormalizedSafeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > 4_096 ||
    path.startsWith("/") ||
    path.startsWith("./") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    return false;
  }
  const components = path.split("/");
  return components.every(
    (component) => component.length > 0 && component !== "." && component !== "..",
  );
}

function validateFiles(
  value: unknown,
  path: string,
  bag: DiagnosticBag,
): ProfileBaselineFile[] | undefined {
  if (!Array.isArray(value)) {
    bag.error("manifest.field_type", path, "baseline files must be an array");
    return undefined;
  }
  if (value.length === 0 || value.length > MAX_MANIFEST_FILES) {
    bag.error("manifest.file_count", path, "baseline must contain a bounded nonempty file list");
  }
  const files: ProfileBaselineFile[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = pointer(path, index);
    const record = expectRecord(
      value[index],
      itemPath,
      ["path", "sha256", "size_bytes", "kind"],
      bag,
    );
    if (record === undefined) {
      continue;
    }
    const filePath = requiredString(record, "path", itemPath, bag);
    const digest = requiredString(record, "sha256", itemPath, bag);
    const size = requiredSafeInteger(record, "size_bytes", itemPath, bag);
    const kind = requiredString(record, "kind", itemPath, bag);
    if (filePath !== undefined && !isNormalizedSafeRelativePath(filePath)) {
      bag.error(
        "manifest.file_path",
        pointer(itemPath, "path"),
        "baseline path is not a normalized safe relative path",
      );
    }
    if (digest !== undefined && !isSha256Digest(digest)) {
      bag.error(
        "manifest.sha256",
        pointer(itemPath, "sha256"),
        "file digest must be canonical SHA-256",
      );
    }
    if (kind !== undefined && !PROFILE_FILE_KINDS.has(kind as ProfileFileKind)) {
      bag.error(
        "manifest.file_kind",
        pointer(itemPath, "kind"),
        "baseline file kind is not supported",
      );
    }
    if (
      filePath !== undefined &&
      isNormalizedSafeRelativePath(filePath) &&
      digest !== undefined &&
      isSha256Digest(digest) &&
      size !== undefined &&
      kind !== undefined &&
      PROFILE_FILE_KINDS.has(kind as ProfileFileKind)
    ) {
      files.push({
        path: filePath,
        sha256: digest,
        size_bytes: size,
        kind: kind as ProfileFileKind,
      });
    }
  }
  for (let index = 1; index < files.length; index += 1) {
    const previous = files[index - 1];
    const current = files[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const order = compareUtf8(previous.path, current.path);
    if (order === 0) {
      bag.error("manifest.duplicate_file", path, "baseline file paths must be unique");
    } else if (order > 0) {
      bag.error(
        "manifest.file_order",
        path,
        "baseline files must be sorted lexicographically by path",
      );
    }
  }
  return files;
}

function validateMigrations(
  value: unknown,
  path: string,
  bag: DiagnosticBag,
): ProfileMigration[] | undefined {
  if (!Array.isArray(value)) {
    bag.error("manifest.field_type", path, "migrations must be an array");
    return undefined;
  }
  if (value.length > MAX_MIGRATIONS) {
    bag.error("manifest.migration_count", path, "migration list exceeds the configured limit");
  }
  const migrations: ProfileMigration[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (let index = 0; index < Math.min(value.length, MAX_MIGRATIONS); index += 1) {
    const itemPath = pointer(path, index);
    const record = expectRecord(
      value[index],
      itemPath,
      ["id", "kind", "from_profile_range", "from_bundle_sha256", "path", "sha256"],
      bag,
    );
    if (record === undefined) {
      continue;
    }
    const id = requiredString(record, "id", itemPath, bag);
    const kind = requiredString(record, "kind", itemPath, bag);
    const from = requiredString(record, "from_profile_range", itemPath, bag);
    let fromBundles: Sha256Digest[] | undefined;
    if (!Object.hasOwn(record, "from_bundle_sha256")) {
      bag.error(
        "manifest.required_field",
        pointer(itemPath, "from_bundle_sha256"),
        "required manifest field is missing",
      );
    } else {
      fromBundles = validateSourceBundleDigests(
        record.from_bundle_sha256,
        pointer(itemPath, "from_bundle_sha256"),
        bag,
      );
    }
    const migrationPath = requiredString(record, "path", itemPath, bag);
    const digest = requiredString(record, "sha256", itemPath, bag);
    if (kind !== undefined && kind !== "retire_yaml_fields") {
      bag.error(
        "manifest.migration_kind",
        pointer(itemPath, "kind"),
        "only the declarative retire_yaml_fields migration kind is supported",
      );
    }
    validateRangeSyntax(from, pointer(itemPath, "from_profile_range"), bag);
    if (id !== undefined && !isMigrationId(id)) {
      bag.error(
        "manifest.migration_id",
        pointer(itemPath, "id"),
        "migration id must be a lowercase kebab identifier",
      );
    }
    if (id !== undefined) {
      if (ids.has(id)) {
        bag.error("manifest.duplicate_migration", path, "migration ids must be unique");
      }
      ids.add(id);
    }
    if (migrationPath !== undefined && !isNormalizedSafeRelativePath(migrationPath)) {
      bag.error(
        "manifest.migration_path",
        pointer(itemPath, "path"),
        "migration path is not a normalized safe relative path",
      );
    }
    if (migrationPath !== undefined) {
      if (paths.has(migrationPath)) {
        bag.error("manifest.duplicate_migration_path", path, "migration paths must be unique");
      }
      paths.add(migrationPath);
    }
    if (digest !== undefined && !isSha256Digest(digest)) {
      bag.error(
        "manifest.sha256",
        pointer(itemPath, "sha256"),
        "migration digest must be canonical SHA-256",
      );
    }
    if (
      from !== undefined &&
      validRange(from) !== null &&
      id !== undefined &&
      isMigrationId(id) &&
      kind === "retire_yaml_fields" &&
      fromBundles !== undefined &&
      fromBundles.length > 0 &&
      migrationPath !== undefined &&
      isNormalizedSafeRelativePath(migrationPath) &&
      digest !== undefined &&
      isSha256Digest(digest)
    ) {
      migrations.push({
        id,
        kind,
        from_profile_range: from,
        from_bundle_sha256: fromBundles,
        path: migrationPath,
        sha256: digest,
      });
    }
  }
  return migrations;
}

function validateSourceBundleDigests(
  value: unknown,
  path: string,
  bag: DiagnosticBag,
): Sha256Digest[] | undefined {
  if (!Array.isArray(value)) {
    bag.error("manifest.field_type", path, "migration source bundle digests must be an array");
    return undefined;
  }
  if (value.length === 0 || value.length > MAX_MIGRATION_SOURCE_DIGESTS) {
    bag.error(
      "manifest.migration_source_count",
      path,
      "migration source bundle digests must be a bounded nonempty list",
    );
  }
  const digests: Sha256Digest[] = [];
  for (let index = 0; index < Math.min(value.length, MAX_MIGRATION_SOURCE_DIGESTS); index += 1) {
    const digest = value[index];
    if (!isSha256Digest(digest)) {
      bag.error(
        "manifest.sha256",
        pointer(path, index),
        "migration source bundle digest must be canonical SHA-256",
      );
      continue;
    }
    digests.push(digest);
  }
  for (let index = 1; index < digests.length; index += 1) {
    const previous = digests[index - 1];
    const current = digests[index];
    if (previous === undefined || current === undefined) continue;
    const order = compareUtf8(previous, current);
    if (order === 0) {
      bag.error(
        "manifest.duplicate_migration_source",
        path,
        "migration source bundle digests must be unique",
      );
    } else if (order > 0) {
      bag.error(
        "manifest.migration_source_order",
        path,
        "migration source bundle digests must be sorted",
      );
    }
  }
  return digests;
}

function expectRequiredRecord(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  allowed: readonly string[],
  bag: DiagnosticBag,
): Record<string, unknown> | undefined {
  const path = pointer(parentPath, key);
  if (!Object.hasOwn(parent, key)) {
    bag.error("manifest.required_field", path, "required manifest field is missing");
    return undefined;
  }
  return expectRecord(parent[key], path, allowed, bag);
}

function expectRecord(
  value: unknown,
  path: string,
  allowed: readonly string[],
  bag: DiagnosticBag,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    bag.error("manifest.object", path, "manifest field must be an object");
    return undefined;
  }
  const allowedSet = new Set(allowed);
  const extras = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (extras.length > 0) {
    bag.error("manifest.unknown_field", path, "manifest object contains unsupported fields");
  }
  return value;
}

function requiredString(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  bag: DiagnosticBag,
): string | undefined {
  const path = pointer(parentPath, key);
  if (!Object.hasOwn(parent, key)) {
    bag.error("manifest.required_field", path, "required manifest field is missing");
    return undefined;
  }
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    bag.error("manifest.string", path, "manifest field must be a nonempty canonical string");
    return undefined;
  }
  return value;
}

function requiredSafeInteger(
  parent: Record<string, unknown>,
  key: string,
  parentPath: string,
  bag: DiagnosticBag,
): number | undefined {
  const path = pointer(parentPath, key);
  if (!Object.hasOwn(parent, key)) {
    bag.error("manifest.required_field", path, "required manifest field is missing");
    return undefined;
  }
  const value = parent[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    bag.error("manifest.size", path, "file size must be a nonnegative safe integer");
    return undefined;
  }
  return value;
}

function validateExactSemver(
  value: string | undefined,
  path: string,
  code: string,
  bag: DiagnosticBag,
): void {
  if (value !== undefined && valid(value) !== value) {
    bag.error(code, path, "version must be a canonical semantic version");
  }
}

function validateRange(
  range: string | undefined,
  target: string,
  path: string,
  label: string,
  bag: DiagnosticBag,
): void {
  if (!validateRangeSyntax(range, path, bag)) {
    return;
  }
  if (valid(target) === null || !satisfies(target, range as string)) {
    bag.error(
      "manifest.incompatible",
      path,
      `profile package is incompatible with the current ${label}`,
    );
  }
}

function validateRangeSyntax(range: string | undefined, path: string, bag: DiagnosticBag): boolean {
  if (range === undefined) {
    return false;
  }
  if (range === "*" || range.includes("||") || validRange(range) === null) {
    bag.error(
      "manifest.semver_range",
      path,
      "compatibility range must be one bounded semantic version range",
    );
    return false;
  }
  return true;
}

function isPackageName(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value)
  );
}

function isDisplayName(value: string): boolean {
  return value.length <= 120 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isLineage(value: string): boolean {
  return value.length <= 128 && /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value);
}

function isMigrationId(value: string): boolean {
  return value.length <= 128 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
