export const PI_RESOURCE_BINDINGS_PROTOCOL = "koni.pi-resource-bindings.v1" as const;

export type PiResourceKind = "extension" | "skill" | "prompt";
export type PiResourceIntegration =
  "skills_only" | "interactive_only" | "explicit_tools" | "not_recommended";

/** Exact, non-glob selectors authored by the project. */
export interface PiResourceSelection {
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  /** Koni-owned compatibility adapter ids, never community extension exports. */
  readonly tools: readonly string[];
}

export interface OptionalPiResourceBinding {
  readonly id: string;
  readonly package: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly integration: PiResourceIntegration;
  readonly resources: readonly PiResourceKind[];
  readonly select: PiResourceSelection;
  readonly stages: readonly string[];
  readonly personas: readonly string[];
  readonly requiresNetwork: boolean;
  readonly rationale: string;
}

export interface PiResourceBindingCatalog {
  readonly protocol: typeof PI_RESOURCE_BINDINGS_PROTOCOL;
  readonly bindings: readonly OptionalPiResourceBinding[];
}
