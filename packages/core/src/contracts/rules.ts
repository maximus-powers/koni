import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "./configuration.js";
import type { Sha256Digest } from "../shared/canonical.js";

export const RULE_EVALUATION_PROTOCOL = "koni.rule-evaluation.v1" as const;
export const DERIVED_FACT_PROTOCOL = "koni.derived-fact.v1" as const;
export const DERIVED_TICKET_PROTOCOL = "koni.derived-ticket.v1" as const;
export const GATE_POLICY_CONTEXT_PROTOCOL = "koni.gate-policy-context.v1" as const;
export const STATE_MACHINE_CATALOG_PROTOCOL = "koni.state-machine-catalog.v1" as const;

export type DerivationKind =
  | "obligation"
  | "projection"
  | "readiness"
  | "program_state"
  | "gate_request"
  | "check_request"
  | "barrier"
  | "warning";

/**
 * Minimal immutable graph view consumed by the declarative rule compiler.
 *
 * `fields` represents compiler-owned top-level projections such as
 * `readiness` and `obligations`. This keeps expression evaluation independent
 * of any particular graph storage class while preserving Rust's flattened
 * compiler-extension field semantics.
 */
export interface CompilerGraphNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly status: string;
  readonly spec: ConfigurationObject;
  readonly edges: Readonly<Record<string, readonly string[]>>;
  readonly annotations?: ConfigurationObject;
  readonly fields?: ConfigurationObject;
}

export interface CompilerGraphProjection {
  nodes(): readonly CompilerGraphNode[];
  node(id: string): CompilerGraphNode | undefined;
}

export interface DerivedFact {
  readonly protocol: typeof DERIVED_FACT_PROTOCOL;
  readonly id: string;
  readonly rule_id: string;
  readonly rule_phase: string;
  readonly rule_priority: number;
  readonly anchor_node_id: string;
  readonly ordinal: number;
  readonly kind: DerivationKind;
  readonly key?: string;
  readonly target?: string;
  readonly field?: string;
  readonly value?: ConfigurationValue;
  readonly severity?: string;
  readonly reason?: string;
  readonly args: ConfigurationObject;
  readonly fact_sha256: Sha256Digest;
}

export interface CompiledGatePolicyContext {
  readonly protocol: typeof GATE_POLICY_CONTEXT_PROTOCOL;
  readonly policy_id: string;
  readonly policy_contract_sha256: Sha256Digest;
  readonly gate_node_id: string;
  readonly winner_node_id?: string;
  readonly evaluation_target_node_ids: readonly string[];
  readonly ancestor_node_ids: readonly string[];
  readonly direct_gate_node_ids: readonly string[];
  readonly inherited_gate_node_ids: readonly string[];
  readonly applicable_gate_node_ids: readonly string[];
  readonly context_node_ids: readonly string[];
  readonly read_paths: readonly string[];
  readonly context_sha256: Sha256Digest;
}

export interface CompiledStateTransition {
  readonly id: string;
  readonly from: readonly string[];
  readonly to: string;
  /** Empty means every authenticated actor. */
  readonly actors: readonly string[];
  readonly transition_sha256: Sha256Digest;
}

export interface CompiledStateMachine {
  readonly id: string;
  readonly initial: string;
  readonly states: readonly string[];
  readonly terminal_states: readonly string[];
  readonly transitions: readonly CompiledStateTransition[];
  readonly machine_sha256: Sha256Digest;
}

export interface CompiledStateMachineCatalog {
  readonly protocol: typeof STATE_MACHINE_CATALOG_PROTOCOL;
  readonly configuration_sha256: Sha256Digest;
  readonly machines: Readonly<Record<string, CompiledStateMachine>>;
  readonly catalog_sha256: Sha256Digest;
}

export type DerivedWorkflowStepKind = "production" | "integration" | "review" | "agent" | "manual";

export type DerivedGraphMutationPolicy = "allowed" | "forbidden" | "required";

export interface DerivedWorkflowStep {
  readonly id: string;
  readonly kind: DerivedWorkflowStepKind;
  readonly persona_id: string;
  readonly depends_on: readonly string[];
  readonly required: boolean;
  /** Omitted when the step inherits the complete ticket scope. */
  readonly read_node_ids?: readonly string[];
  /** Omitted when the step inherits the complete ticket scope. */
  readonly write_node_ids?: readonly string[];
  /** Omitted when the step inherits the complete ticket path scope. */
  readonly read_paths?: readonly string[];
  /** Omitted when the step inherits the complete ticket path scope. */
  readonly write_paths?: readonly string[];
  readonly preserve_source_paths_from?: string;
  readonly expected_outputs: readonly string[];
  readonly graph_mutation: DerivedGraphMutationPolicy;
  readonly validation_action?: string;
  readonly required_receipts: readonly string[];
  readonly escalation_triggers: readonly string[];
  readonly stop_conditions: readonly string[];
  readonly validation_checks: readonly string[];
  readonly context_sha256: Sha256Digest;
}

export interface DerivedTicketScope {
  readonly read_node_ids: readonly string[];
  readonly write_node_ids: readonly string[];
  readonly read_paths: readonly string[];
  readonly write_paths: readonly string[];
}

/** Pure ticket definition. Durable status, attempts, and timestamps belong to reconciliation. */
export interface DerivedTicketDefinition {
  readonly protocol: typeof DERIVED_TICKET_PROTOCOL;
  readonly id: string;
  readonly rule_id: string;
  readonly rule_phase: string;
  readonly rule_priority: number;
  readonly anchor_node_id: string;
  readonly operation: string;
  readonly operation_registry_id: string;
  readonly operation_dispatch_priority: number;
  readonly ranking_hints: readonly string[];
  readonly title: string;
  readonly target_node_ids: readonly string[];
  readonly scope: DerivedTicketScope;
  readonly source_state_key: string;
  readonly target_state_key: string;
  readonly obligation_keys: readonly string[];
  readonly workflow_id?: string;
  /** Compiler-validated owner step reopened after one failed independent review. */
  readonly review_failure_reopen_from?: string;
  readonly workflow: readonly DerivedWorkflowStep[];
  readonly configuration_sha256: Sha256Digest;
  readonly definition_sha256: Sha256Digest;
}

export interface CompiledRuleEvaluationMaterial {
  readonly protocol: typeof RULE_EVALUATION_PROTOCOL;
  readonly configuration_sha256: Sha256Digest;
  readonly input_graph_sha256: Sha256Digest;
  readonly derived_graph_sha256: Sha256Digest;
  readonly facts: readonly DerivedFact[];
  readonly gate_policy_contexts: readonly CompiledGatePolicyContext[];
  readonly state_machine_catalog: CompiledStateMachineCatalog;
  readonly program_state: ConfigurationObject;
  readonly tickets: readonly DerivedTicketDefinition[];
}

export interface CompiledRuleEvaluation extends CompiledRuleEvaluationMaterial {
  readonly evaluation_sha256: Sha256Digest;
}

export interface RuleEvaluationInput {
  readonly configuration: CompiledConfiguration;
  readonly graph: CompilerGraphProjection;
}
