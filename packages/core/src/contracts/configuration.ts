import type { Sha256Digest } from "../shared/canonical.js";

export const PROFILE_CONFIGURATION_SCHEMA_VERSION = "2.0" as const;
export const COMPILED_CONFIGURATION_PROTOCOL = "koni.compiled-configuration.v1" as const;

export const PROFILE_IMPORT_CATEGORIES = [
  "graph",
  "rules",
  "operations",
  "workflows",
  "actions",
  "checks",
  "personas",
  "reports",
  "cockpit",
  "lifecycles",
] as const;

export type ProfileImportCategory = (typeof PROFILE_IMPORT_CATEGORIES)[number];

export const CONFIGURATION_REGISTRY_KINDS = [
  "node_types",
  "queries",
  "graph_constraints",
  "gate_policies",
  "rules",
  "operations",
  "workflows",
  "actions",
  "checks",
  "personas",
  "reports",
  "views",
  "state_machines",
  "agents",
] as const;

export type ConfigurationRegistryKind = (typeof CONFIGURATION_REGISTRY_KINDS)[number];

export type ConfigurationScalar = null | boolean | number | string;
export type ConfigurationValue =
  | ConfigurationScalar
  | ConfigurationObject
  | readonly ConfigurationValue[];

export interface ConfigurationObject {
  readonly [key: string]: ConfigurationValue;
}

export interface CompiledProfileModule {
  readonly category: ProfileImportCategory;
  readonly path: string;
  readonly source_sha256: Sha256Digest;
  readonly module?: Readonly<{
    id: string;
    version: string;
  }>;
  /** The exact parsed module document, including an envelope when one was present. */
  readonly document: ConfigurationObject;
}

export interface CompiledAgentResource {
  readonly id: string;
  readonly path: string;
  readonly source_sha256: Sha256Digest;
  readonly document: ConfigurationObject;
}

export interface CompiledRunType {
  readonly id: string;
  readonly path: string;
  readonly extends?: string;
  readonly ancestry: readonly string[];
  /** Source form, retained for configuration UI and provenance. */
  readonly source: ConfigurationObject;
  /** Complete standalone behavior after constrained inheritance is resolved. */
  readonly document: ConfigurationObject;
  readonly sha256: Sha256Digest;
}

export type ConfigurationRegistry = Readonly<Record<string, ConfigurationObject>>;

export type CompiledConfigurationRegistries = Readonly<
  Record<ConfigurationRegistryKind, ConfigurationRegistry>
>;

export interface CompiledConfigurationMaterial {
  readonly protocol: typeof COMPILED_CONFIGURATION_PROTOCOL;
  readonly schema_version: typeof PROFILE_CONFIGURATION_SCHEMA_VERSION;
  readonly package: Readonly<{
    name: string;
    version: string;
    profile_id: string;
    profile_version: string;
    profile_lineage: string;
  }>;
  /** Frozen package baseline from which this editable project lineage began. */
  readonly baseline_bundle_sha256: Sha256Digest;
  /** Exact authenticated effective project inventory compiled for this snapshot. */
  readonly effective_bundle_sha256: Sha256Digest;
  readonly profile: ConfigurationObject;
  readonly project: ConfigurationObject;
  readonly modules: Readonly<
    Record<ProfileImportCategory, readonly CompiledProfileModule[]>
  >;
  readonly run_type_order: readonly string[];
  readonly run_types: Readonly<Record<string, CompiledRunType>>;
  readonly agents: Readonly<Record<string, CompiledAgentResource>>;
  readonly edge_types: readonly ConfigurationObject[];
  readonly registries: CompiledConfigurationRegistries;
}

/**
 * Fully validated configuration consumed by the authority boundary.
 *
 * No Map, Set, byte buffer, or caller-owned object survives compilation. The
 * complete object graph is recursively frozen and the digest covers every
 * field in `CompiledConfigurationMaterial`.
 */
export interface CompiledConfiguration extends CompiledConfigurationMaterial {
  readonly configuration_sha256: Sha256Digest;
}
