import type { ConfigurationObject, ConfigurationValue } from "./configuration.js";
import type { Sha256Digest } from "../shared/canonical.js";
import type { GitBehaviorPolicy } from "../git/behavior-policy.js";

export const COMPILED_BEHAVIOR_PROTOCOL = "koni.compiled-behavior.v1" as const;
export const ACTION_CATALOG_PROTOCOL = "koni.action-catalog.v1" as const;
export const ACTION_EXECUTION_PLAN_PROTOCOL = "koni.action-execution-plan.v1" as const;
export const ACTION_EXECUTION_JOURNAL_PROTOCOL = "koni.action-execution-journal.v1" as const;
export const LEAD_JUDGMENT_PROTOCOL = "koni.lead-judgment.v1" as const;
export const LEAD_JUDGMENT_OUTPUT_PROTOCOL = "koni.lead-judgment-output.v1" as const;

export const LEAD_JUDGMENT_TRIGGERS = ["orchestration_entry", "compiler_deadlock"] as const;
export type LeadJudgmentTrigger = (typeof LEAD_JUDGMENT_TRIGGERS)[number];

export const INTAKE_FIELD_KINDS = [
  "string", "text", "path", "boolean", "integer", "number", "choice", "multi_choice", "json",
] as const;
export type IntakeFieldKind = (typeof INTAKE_FIELD_KINDS)[number];

export interface CompiledIntakeOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface CompiledIntakeField {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: IntakeFieldKind;
  readonly required: boolean;
  readonly default?: ConfigurationValue;
  readonly options: readonly CompiledIntakeOption[];
}

export const RUN_STAGE_KINDS = [
  "action",
  "planning",
  "approval",
  "initialize",
  "orchestration",
  "target_sync",
  "checkpoint",
  "agent_review",
  "promotion",
] as const;
export type RunStageKind = (typeof RUN_STAGE_KINDS)[number];

export type CompiledStageConfig =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "action"; action: string; compilerOwned: boolean; automatic: boolean }>
  | Readonly<{ kind: "agent"; persona: string; prompt: string }>
  | Readonly<{ kind: "checkpoint"; checkpoint: string }>;

export interface CompiledRunStage {
  readonly id: string;
  readonly title: string;
  readonly kind: RunStageKind;
  readonly config: CompiledStageConfig;
}

export interface CompiledQuestionBehavior {
  readonly policy: "autonomous" | "high_impact_only" | "interactive";
  readonly presentation: "none" | "some" | "many";
  readonly defaultScope: "run" | "ticket";
  /** The ask tool remains available; policy decides automatic recommendation vs durable pause. */
  readonly toolAvailable: true;
}

export interface CompiledTokenPolicy {
  readonly metric: "new_tokens";
  readonly limit: number;
  readonly synthesisReserve: number;
  readonly synthesisThreshold: number;
  readonly onExhausted: "force_synthesis";
}

export interface CompiledPlanningBehavior {
  readonly maxRepositoryToolCalls: number;
  readonly tokenPolicy: CompiledTokenPolicy;
}

/** Operator-configured environment preparation for freshly materialized run/ticket worktrees. */
export interface CompiledWorkspaceBehavior {
  readonly bootstrap: Readonly<{
    argv: readonly string[];
    timeoutMs: number;
  }>;
}

export interface CompiledAgentRoleBehavior {
  readonly id: string;
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface CompiledLeadJudgmentBehavior {
  readonly protocol: typeof LEAD_JUDGMENT_PROTOCOL;
  readonly actionId: string;
  readonly personaId: string;
  readonly roleId: string;
  readonly prompt: string;
  readonly triggers: readonly LeadJudgmentTrigger[];
  readonly maxBoundariesPerAttempt: 1;
  readonly terminal: Readonly<{
    protocol: typeof LEAD_JUDGMENT_OUTPUT_PROTOCOL;
    dispositions: readonly ["proceed", "blocked"];
  }>;
}

export interface LeadJudgmentOutput {
  readonly protocol: typeof LEAD_JUDGMENT_OUTPUT_PROTOCOL;
  readonly disposition: "proceed" | "blocked";
  readonly summary: string;
}

export interface CompiledRunTypeBehavior {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly intake: readonly CompiledIntakeField[];
  readonly objectiveFieldId: string;
  readonly pipeline: readonly CompiledRunStage[];
  readonly questions: CompiledQuestionBehavior;
  readonly runCardSections: readonly string[];
  readonly roles: readonly CompiledAgentRoleBehavior[];
  /** One bounded qualitative gate; deterministic ticket scheduling remains authority-owned. */
  readonly leadJudgment: CompiledLeadJudgmentBehavior;
  /** Exact validated Git semantics pinned with every run; no runtime YAML re-interpretation. */
  readonly git: GitBehaviorPolicy;
  readonly autoStart: boolean;
  readonly maxParallel: number;
  readonly actionSelectors: Readonly<{
    compile: string;
    lead: string;
    report: string;
  }>;
  readonly planning?: CompiledPlanningBehavior;
  readonly planningInstructions: string;
  readonly workspace?: CompiledWorkspaceBehavior;
  readonly sha256: Sha256Digest;
}

export type ActionParameterType = "string" | "ticket_id" | "path" | "json" | "boolean" | "integer" | "number";

export interface CompiledActionParameter {
  readonly id: string;
  readonly type: ActionParameterType;
  readonly required: boolean;
  readonly description: string;
  readonly default?: ConfigurationValue;
}

export interface CompiledActionStep {
  readonly id: string;
  readonly primitive: string;
  readonly arguments: ConfigurationObject;
}

export interface CompiledActionDefinition {
  readonly id: string;
  readonly actor: "compiler" | "lead";
  readonly aliases: readonly string[];
  readonly parameters: readonly CompiledActionParameter[];
  readonly allowedTicketStates: readonly string[];
  readonly checkout: "none" | "main" | "ticket";
  readonly recipe: readonly CompiledActionStep[];
  readonly compensation: readonly CompiledActionStep[];
  readonly recovery?: string;
  readonly sha256: Sha256Digest;
}

export interface CompiledActionCatalog {
  readonly protocol: typeof ACTION_CATALOG_PROTOCOL;
  readonly actions: Readonly<Record<string, CompiledActionDefinition>>;
  readonly aliases: Readonly<Record<string, string>>;
  readonly sha256: Sha256Digest;
}

export interface CompiledBehaviorIr {
  readonly protocol: typeof COMPILED_BEHAVIOR_PROTOCOL;
  readonly profile: Readonly<{
    id: string;
    initialization: Readonly<{
      rootNodeType: string;
      goalField: string;
      planningContextField: string;
      planningSeedOperation: string;
      rootStatus: string;
    }>;
    orchestration: Readonly<{
      maxParallel: number;
      maxBoundariesPerLead: 1;
      disjointScopeParallelism: boolean;
    }>;
    reportingBundleKind?: string;
  }>;
  readonly defaultRunTypeId: string;
  readonly runTypeOrder: readonly string[];
  readonly runTypes: Readonly<Record<string, CompiledRunTypeBehavior>>;
  readonly actions: CompiledActionCatalog;
  readonly sha256: Sha256Digest;
}

export interface ActionInvocationContext {
  readonly runId?: string;
  readonly ticketId?: string;
  readonly ticketState?: string;
  readonly checkout: "none" | "main" | "ticket";
  readonly values?: ConfigurationObject;
}

export interface PreparedActionStep extends CompiledActionStep {
  readonly arguments: ConfigurationObject;
}

export interface ActionExecutionPlan {
  readonly protocol: typeof ACTION_EXECUTION_PLAN_PROTOCOL;
  readonly invocationId: string;
  readonly catalogSha256: Sha256Digest;
  readonly actionId: string;
  readonly actionSha256: Sha256Digest;
  readonly actor: "compiler" | "lead";
  readonly context: ActionInvocationContext;
  readonly parameters: ConfigurationObject;
  readonly recipe: readonly PreparedActionStep[];
  readonly compensation: readonly PreparedActionStep[];
  readonly recovery?: string;
  readonly sha256: Sha256Digest;
}

export interface ActionExecutionJournalStep {
  readonly stepId: string;
  readonly primitive: string;
  readonly phase: "recipe" | "compensation";
  readonly status: "completed" | "failed";
  readonly output?: ConfigurationValue;
  readonly error?: string;
}

export interface ActionExecutionJournal {
  readonly protocol: typeof ACTION_EXECUTION_JOURNAL_PROTOCOL;
  readonly planSha256: Sha256Digest;
  readonly invocationId: string;
  readonly catalogSha256: Sha256Digest;
  readonly actionId: string;
  readonly actionSha256: Sha256Digest;
  readonly contextSha256: Sha256Digest;
  readonly status:
    | "running"
    | "compensating"
    | "completed"
    | "failed"
    | "compensated"
    | "compensation_failed"
    | "recovery_required";
  readonly recoveryActionId?: string;
  readonly steps: readonly ActionExecutionJournalStep[];
  readonly sha256: Sha256Digest;
}

export interface ActionPrimitiveHost {
  execute(input: Readonly<{
    invocationId: string;
    planSha256: Sha256Digest;
    /** Stable host deduplication key; replay after effect-before-journal crash must return once. */
    effectKey: string;
    actionId: string;
    actor: "compiler" | "lead";
    phase: "recipe" | "compensation";
    step: PreparedActionStep;
    context: ActionInvocationContext;
  }>): Promise<ConfigurationValue>;
}
