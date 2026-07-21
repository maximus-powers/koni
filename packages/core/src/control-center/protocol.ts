import type { JsonValue } from "../authority/protocol.js";
import type { ConfigurationValue } from "../contracts/configuration.js";
import type { IntakeFieldKind } from "../contracts/behavior.js";
import type { TicketStatus } from "../state/run-record.js";
import { isSha256Digest, type Sha256Digest } from "../shared/canonical.js";
import {
  assertStageCapabilityCatalog,
  type StageCapabilityCatalog,
} from "../state/stage-capability.js";
import {
  CONFIG_DOCUMENT_CATALOG_PROTOCOL,
  CONFIG_DOCUMENT_DOMAINS,
  CONFIG_DOCUMENT_MUTATION_PROTOCOL,
  CONFIG_DOCUMENT_SOURCE_PROTOCOL,
  CONFIG_LEGACY_MIGRATION_PREVIEW_PROTOCOL,
  CONFIG_LEGACY_MIGRATION_RESULT_PROTOCOL,
  CONFIG_RESOURCE_KINDS,
  CONFIG_RUN_TYPE_TEMPLATES_PROTOCOL,
  type ConfigDocumentCatalog,
  type ConfigDocumentDomain,
  type ConfigDocumentMutationResult,
  type ConfigDocumentSource,
  type ConfigDocumentSummary,
  type ConfigLegacyMigrationPreview,
  type ConfigLegacyMigrationResult,
  type ConfigResourceKind,
  type ConfigRunTypeTemplates,
} from "../authority/config-documents.js";

export type {
  ConfigDocumentCatalog,
  ConfigDocumentDomain,
  ConfigDocumentMutationResult,
  ConfigDocumentSource,
  ConfigDocumentSummary,
  ConfigLegacyMigrationPreview,
  ConfigLegacyMigrationResult,
  ConfigResourceKind,
  ConfigRunTypeTemplate,
  ConfigRunTypeTemplates,
} from "../authority/config-documents.js";

export const CONTROL_CATALOG_PROTOCOL = "koni.control-catalog.v1" as const;
export const CONFIG_CATALOG_PROTOCOL = "koni.config-catalog.v1" as const;
export const CONFIG_SNAPSHOT_PROTOCOL = "koni.config-snapshot.v1" as const;
export const PROFILE_CONFLICT_CATALOG_PROTOCOL = "koni.profile-upstream-conflict-catalog.v1" as const;
export const PROFILE_CONFLICT_INSPECTION_PROTOCOL = "koni.profile-upstream-conflict-inspection.v1" as const;
export const RUN_DELETION_PREVIEW_PROTOCOL = "koni.run-deletion-preview.v1" as const;
export const RUN_MERGE_PREVIEW_PROTOCOL = "koni.run-merge-preview.v1" as const;
export const RUN_ATTEMPT_LINEAGE_PROTOCOL = "koni.run-attempt-lineage.v1" as const;

export type ControlProposalDisposition =
  | { kind: "pending" }
  | { kind: "rejected" }
  | { kind: "no_op"; summary?: string }
  | { kind: "application"; applicationTicketId: string; applicationStatus: TicketStatus };

export interface ControlProposalDecision {
  decision: "approval" | "rejection";
  authoritySha256: Sha256Digest;
  message?: string;
  actor: string;
  decidedAt: string;
}

/** Bounded authority-owned projection used by every operator surface. */
export interface ControlProposalInspection {
  runId: string;
  ticketId: string;
  sourceTicketId: string;
  status: TicketStatus;
  title: string;
  summary: string;
  targetNodeIds: readonly string[];
  createdAt: string;
  decision?: ControlProposalDecision;
  disposition: ControlProposalDisposition;
}

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ControlThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Read-only projection of Pi's ordinary ModelRegistry, injected by the host. */
export interface ControlModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  /** Exact Pi-supported choices for this model; selectors must never invent another value. */
  thinkingLevels: readonly ControlThinkingLevel[];
  available: boolean;
  /** Human-readable explanation for a visible model that autonomous attempts cannot select. */
  unavailableReason?: string;
}

export interface ControlStageOption {
  id: string;
  title: string;
  kind: string;
  /** False means the stage stays visible in the flow but is muted for this run type. */
  included: boolean;
}

export interface ControlRoleDefault {
  id: string;
  title: string;
  provider: string;
  model: string;
  thinkingLevel: ControlThinkingLevel;
}

export interface ControlIntakeOption {
  value: string;
  label: string;
  description?: string;
}

export interface ControlIntakeField {
  id: string;
  label: string;
  description: string;
  kind: IntakeFieldKind;
  required: boolean;
  default?: ConfigurationValue;
  options: readonly ControlIntakeOption[];
}

export interface ControlRunTypeOption {
  id: string;
  title: string;
  description: string;
  questionPolicy: "none" | "some" | "many";
  maxParallel: number;
  startMode: "planning" | "work";
  /** Explicit configured field that becomes the durable run objective. */
  objectiveFieldId: string;
  intake: readonly ControlIntakeField[];
  questionDefaultScope: "run" | "ticket";
  /** Applies after approval, never before intake/planning/review. */
  autoStart: boolean;
  runCardSections: readonly string[];
  stages: readonly ControlStageOption[];
  roles: readonly ControlRoleDefault[];
}

/**
 * Authority-composed launch cards. This is presentation data only: run.create re-resolves and
 * validates every selected value against the current effective configuration.
 */
export interface ControlCatalog {
  protocol: typeof CONTROL_CATALOG_PROTOCOL;
  /** Compiler-validated project default; it must name one of `runTypes`. */
  defaultRunTypeId: string;
  runTypes: readonly ControlRunTypeOption[];
}

export type ConfigFieldKind =
  | "text"
  | "multiline"
  | "integer"
  | "boolean"
  | "select"
  | "model"
  | "thinking"
  | "string_list";

export interface ConfigFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface ConfigFieldDefinition {
  /** Opaque semantic address understood only by config.get/config.update. Never shown as a path. */
  key: string;
  label: string;
  description: string;
  kind: ConfigFieldKind;
  options?: readonly ConfigFieldOption[];
  minimum?: number;
  maximum?: number;
}

/**
 * Authority-authored recipe for adding one semantic resource to a configuration section.
 * The template identity is opaque; the control center only presents its human copy.
 */
export interface ConfigResourceCreateOption {
  id: string;
  title: string;
  description: string;
  nameLabel: string;
  suggestedName: string;
}

export interface ConfigResourceDefinition {
  id: string;
  title: string;
  description: string;
  /** Optional semantic tree relation used only for guided presentation. */
  parentId?: string;
  depth?: number;
  canDuplicate?: boolean;
  canDelete?: boolean;
  /** Recipes for resources that may be created beneath this resource. */
  createOptions?: readonly ConfigResourceCreateOption[];
  fields: readonly ConfigFieldDefinition[];
}

export interface ConfigSectionDefinition {
  id: string;
  title: string;
  description: string;
  /** Recipes for top-level resources that may be created in this domain. */
  createOptions?: readonly ConfigResourceCreateOption[];
  resources: readonly ConfigResourceDefinition[];
}

export interface ConfigCatalog {
  protocol: typeof CONFIG_CATALOG_PROTOCOL;
  sections: readonly ConfigSectionDefinition[];
}

/** Hidden CAS material is round-tripped but never rendered to the operator. */
export interface ConfigSnapshot {
  protocol: typeof CONFIG_SNAPSHOT_PROTOCOL;
  cas: JsonValue;
  values: Readonly<Record<string, JsonValue>>;
}

export interface ControlProfileConflict {
  path: string;
  title: string;
  domain: string;
  reason: "modified" | "deleted" | "orphaned";
  currentSha256: Sha256Digest | null;
  upstreamSha256: Sha256Digest | null;
}

export interface ControlProfileConflictCatalog {
  protocol: typeof PROFILE_CONFLICT_CATALOG_PROTOCOL;
  lifecycleGeneration: number;
  profileVersion: string;
  conflicts: readonly ControlProfileConflict[];
}

export interface ControlProfileConflictInspection {
  protocol: typeof PROFILE_CONFLICT_INSPECTION_PROTOCOL;
  lifecycleGeneration: number;
  conflict: ControlProfileConflict;
  currentText: string | null;
  upstreamText: string | null;
}

export interface ControlRunDeletionPreview {
  protocol: typeof RUN_DELETION_PREVIEW_PROTOCOL;
  runId: string;
  objective: string;
  phase: string;
  targetRef: string;
  ownedWorktrees: number;
  ownedBranches: number;
  liveAgents: number;
  dirtyWorktreeWarnings: readonly string[];
  blockers: readonly string[];
  canPreserveBranches: boolean;
  canDeleteOwnedBranches: boolean;
  previewToken: Sha256Digest;
}

export interface ControlRunMergePreview {
  protocol: typeof RUN_MERGE_PREVIEW_PROTOCOL;
  runId: string;
  objective: string;
  phase: string;
  targetRef: string;
  targetAdvanced: boolean;
  resyncState: "current" | "required" | "unavailable";
  completedTickets: number;
  totalTickets: number;
  blockers: readonly string[];
  canAuthorize: boolean;
  previewToken: Sha256Digest;
}

export type ControlAttemptLineageReason =
  | "initial"
  | "retry"
  | "rework"
  | "review"
  | "recovery"
  | "integration";

export type ControlAttemptLineageStatus =
  | "queued"
  | "running"
  | "waiting_question"
  | "terminal_accepted"
  | "completed"
  | "failed"
  | "aborted"
  | "interrupted";

export interface ControlAttemptLineageEntry {
  attemptId: string;
  persona: string;
  ticket: string;
  step: string;
  status: ControlAttemptLineageStatus;
  reason: ControlAttemptLineageReason;
  branchEpoch: number;
  parentAttemptId?: string;
  childAttemptIds: readonly string[];
  activeLeaf: boolean;
}

/** Authority-authenticated semantic attempt tree. Opaque identities are never operator copy. */
export interface ControlRunAttemptLineage {
  protocol: typeof RUN_ATTEMPT_LINEAGE_PROTOCOL;
  runId: string;
  runRevision: number;
  attempts: readonly ControlAttemptLineageEntry[];
}

export function parseControlCatalog(value: unknown): ControlCatalog {
  const root = requiredRecord(value, "control catalog");
  if (root.protocol !== CONTROL_CATALOG_PROTOCOL || !Array.isArray(root.runTypes)) {
    throw new Error("authority returned an unsupported control catalog");
  }
  const defaultRunTypeId = requiredText(root.defaultRunTypeId, "default run type id");
  const ids = new Set<string>();
  const runTypes = root.runTypes.map((item, index): ControlRunTypeOption => {
    const row = requiredRecord(item, `run type ${index + 1}`);
    const id = requiredText(row.id, "run type id");
    if (ids.has(id)) throw new Error(`authority returned duplicate run type ${id}`);
    ids.add(id);
    const questionPolicy = row.questionPolicy;
    if (questionPolicy !== "none" && questionPolicy !== "some" && questionPolicy !== "many") {
      throw new Error(`authority returned an invalid question policy for ${id}`);
    }
    const maxParallel = row.maxParallel;
    if (!Number.isSafeInteger(maxParallel) || typeof maxParallel !== "number" || maxParallel < 1) {
      throw new Error(`authority returned invalid parallelism for ${id}`);
    }
    if (row.startMode !== "planning" && row.startMode !== "work") {
      throw new Error(`authority returned an invalid start mode for ${id}`);
    }
    if (!Array.isArray(row.stages) || !Array.isArray(row.roles) || !Array.isArray(row.intake) || !Array.isArray(row.runCardSections)) {
      throw new Error(`authority returned incomplete launch defaults for ${id}`);
    }
    if (row.questionDefaultScope !== "run" && row.questionDefaultScope !== "ticket") {
      throw new Error(`authority returned invalid question scope for ${id}`);
    }
    if (typeof row.autoStart !== "boolean") throw new Error(`authority returned invalid auto-start policy for ${id}`);
    const intake = row.intake.map((field, fieldIndex) => parseControlIntakeField(field, fieldIndex));
    const objectiveFieldId = requiredText(row.objectiveFieldId, "objective field id");
    if (!intake.some((field) => field.id === objectiveFieldId && field.required && (field.kind === "string" || field.kind === "text"))) {
      throw new Error(`authority objective field ${objectiveFieldId} is not a required text intake field for ${id}`);
    }
    return {
      id,
      title: requiredText(row.title, "run type title"),
      description: requiredText(row.description, "run type description"),
      questionPolicy,
      maxParallel,
      startMode: row.startMode,
      objectiveFieldId,
      intake,
      questionDefaultScope: row.questionDefaultScope,
      autoStart: row.autoStart,
      runCardSections: row.runCardSections.map((section, sectionIndex) => requiredText(section, `run-card section ${sectionIndex + 1}`)),
      stages: row.stages.map((stage, stageIndex) => {
        const record = requiredRecord(stage, `stage ${stageIndex + 1}`);
        if (typeof record.included !== "boolean") throw new Error("authority returned an invalid stage inclusion");
        return {
          id: requiredText(record.id, "stage id"),
          title: requiredText(record.title, "stage title"),
          kind: requiredText(record.kind, "stage kind"),
          included: record.included,
        };
      }),
      roles: row.roles.map((role, roleIndex) => {
        const record = requiredRecord(role, `agent role ${roleIndex + 1}`);
        const thinkingLevel = record.thinkingLevel;
        if (!THINKING_LEVELS.includes(thinkingLevel as ControlThinkingLevel)) {
          throw new Error("authority returned an unsupported role thinking level");
        }
        return {
          id: requiredText(record.id, "agent role id"),
          title: requiredText(record.title, "agent role title"),
          provider: requiredText(record.provider, "agent role provider"),
          model: requiredText(record.model, "agent role model"),
          thinkingLevel: thinkingLevel as ControlThinkingLevel,
        };
      }),
    };
  });
  if (runTypes.length === 0) throw new Error("project has no runnable run types");
  if (!ids.has(defaultRunTypeId)) {
    throw new Error(`authority default run type ${defaultRunTypeId} is not in the compiled run type catalog`);
  }
  return { protocol: CONTROL_CATALOG_PROTOCOL, defaultRunTypeId, runTypes };
}

function parseControlIntakeField(value: unknown, index: number): ControlIntakeField {
  const row = requiredRecord(value, `intake field ${index + 1}`);
  const kinds = ["string", "text", "path", "boolean", "integer", "number", "choice", "multi_choice", "json"] as const;
  if (!kinds.includes(row.kind as (typeof kinds)[number])) throw new Error("authority returned unsupported intake field kind");
  if (typeof row.required !== "boolean" || !Array.isArray(row.options)) throw new Error("authority returned invalid intake field metadata");
  const options = row.options.map((option, optionIndex) => {
    const candidate = requiredRecord(option, `intake option ${optionIndex + 1}`);
    return {
      value: requiredText(candidate.value, "intake option value"),
      label: requiredText(candidate.label, "intake option label"),
      ...(candidate.description === undefined ? {} : { description: requiredText(candidate.description, "intake option description") }),
    };
  });
  return {
    id: requiredText(row.id, "intake field id"),
    label: requiredText(row.label, "intake field label"),
    description: typeof row.description === "string" ? row.description : "",
    kind: row.kind as IntakeFieldKind,
    required: row.required,
    ...(row.default === undefined ? {} : { default: structuredClone(row.default) as ConfigurationValue }),
    options,
  };
}

export function parseConfigCatalog(value: unknown): ConfigCatalog {
  const root = requiredRecord(value, "configuration catalog");
  if (root.protocol !== CONFIG_CATALOG_PROTOCOL || !Array.isArray(root.sections)) {
    throw new Error("authority returned an unsupported configuration catalog");
  }
  return {
    protocol: CONFIG_CATALOG_PROTOCOL,
    sections: root.sections.map((section, sectionIndex) => {
      const row = requiredRecord(section, `configuration section ${sectionIndex + 1}`);
      if (!Array.isArray(row.resources)) throw new Error("configuration section has no resource list");
      return {
        id: requiredText(row.id, "configuration section id"),
        title: requiredText(row.title, "configuration section title"),
        description: requiredText(row.description, "configuration section description"),
        ...(row.createOptions === undefined ? {} : {
          createOptions: parseCreateOptions(row.createOptions, "configuration section"),
        }),
        resources: row.resources.map((resource, resourceIndex) => {
          const record = requiredRecord(resource, `configuration resource ${resourceIndex + 1}`);
          if (!Array.isArray(record.fields)) throw new Error("configuration resource has no field list");
          const depth = optionalSafeNumber(record.depth, "configuration resource depth");
          if (depth !== undefined && depth < 0) throw new Error("configuration resource depth is invalid");
          if (record.canDuplicate !== undefined && typeof record.canDuplicate !== "boolean") {
            throw new Error("configuration resource duplicate capability is invalid");
          }
          if (record.canDelete !== undefined && typeof record.canDelete !== "boolean") {
            throw new Error("configuration resource delete capability is invalid");
          }
          return {
            id: requiredText(record.id, "configuration resource id"),
            title: requiredText(record.title, "configuration resource title"),
            description: requiredText(record.description, "configuration resource description"),
            ...(typeof record.parentId === "string" ? { parentId: requiredText(record.parentId, "configuration resource parent") } : {}),
            ...(depth === undefined ? {} : { depth }),
            ...(record.canDuplicate === undefined ? {} : { canDuplicate: record.canDuplicate }),
            ...(record.canDelete === undefined ? {} : { canDelete: record.canDelete }),
            ...(record.createOptions === undefined ? {} : {
              createOptions: parseCreateOptions(record.createOptions, "configuration resource"),
            }),
            fields: record.fields.map(parseConfigField),
          };
        }),
      };
    }),
  };
}

function parseCreateOptions(value: unknown, label: string): ConfigResourceCreateOption[] {
  if (!Array.isArray(value)) throw new Error(`${label} create options are invalid`);
  return value.map((option, index) => {
    const row = requiredRecord(option, `${label} create option ${index + 1}`);
    return {
      id: requiredText(row.id, "configuration create option id"),
      title: requiredText(row.title, "configuration create option title"),
      description: requiredText(row.description, "configuration create option description"),
      nameLabel: requiredText(row.nameLabel, "configuration create option name label"),
      suggestedName: requiredText(row.suggestedName, "configuration create option suggested name"),
    };
  });
}

export function parseConfigSnapshot(value: unknown): ConfigSnapshot {
  const root = requiredRecord(value, "configuration snapshot");
  if (root.protocol !== CONFIG_SNAPSHOT_PROTOCOL || root.cas === undefined) {
    throw new Error("authority returned an unsupported configuration snapshot");
  }
  const values = requiredRecord(root.values, "configuration values");
  return {
    protocol: CONFIG_SNAPSHOT_PROTOCOL,
    cas: structuredClone(root.cas as JsonValue),
    values: structuredClone(values) as Record<string, JsonValue>,
  };
}

export function parseProfileConflictCatalog(value: unknown): ControlProfileConflictCatalog {
  const root = requiredRecord(value, "upstream conflict catalog");
  if (root.protocol !== PROFILE_CONFLICT_CATALOG_PROTOCOL ||
      !Number.isSafeInteger(root.lifecycleGeneration) || typeof root.profileVersion !== "string" ||
      !Array.isArray(root.conflicts)) {
    throw new Error("authority returned an unsupported upstream conflict catalog");
  }
  return {
    protocol: PROFILE_CONFLICT_CATALOG_PROTOCOL,
    lifecycleGeneration: root.lifecycleGeneration as number,
    profileVersion: requiredText(root.profileVersion, "profile version"),
    conflicts: root.conflicts.map(parseProfileConflict),
  };
}

export function parseProfileConflictInspection(value: unknown): ControlProfileConflictInspection {
  const root = requiredRecord(value, "upstream conflict inspection");
  if (root.protocol !== PROFILE_CONFLICT_INSPECTION_PROTOCOL ||
      !Number.isSafeInteger(root.lifecycleGeneration) ||
      (root.currentText !== null && typeof root.currentText !== "string") ||
      (root.upstreamText !== null && typeof root.upstreamText !== "string")) {
    throw new Error("authority returned an unsupported upstream conflict inspection");
  }
  return {
    protocol: PROFILE_CONFLICT_INSPECTION_PROTOCOL,
    lifecycleGeneration: root.lifecycleGeneration as number,
    conflict: parseProfileConflict(root.conflict),
    currentText: root.currentText as string | null,
    upstreamText: root.upstreamText as string | null,
  };
}

export function parseRunDeletionPreview(value: unknown): ControlRunDeletionPreview {
  const root = requiredRecord(value, "run deletion preview");
  if (
    root.protocol !== RUN_DELETION_PREVIEW_PROTOCOL ||
    typeof root.canPreserveBranches !== "boolean" ||
    typeof root.canDeleteOwnedBranches !== "boolean" ||
    !isSha256Digest(root.previewToken)
  ) {
    throw new Error("authority returned an unsupported run deletion preview");
  }
  return {
    protocol: RUN_DELETION_PREVIEW_PROTOCOL,
    runId: requiredText(root.runId, "deletion preview run id"),
    objective: requiredText(root.objective, "deletion preview objective"),
    phase: requiredText(root.phase, "deletion preview phase"),
    targetRef: requiredText(root.targetRef, "deletion preview target"),
    ownedWorktrees: nonnegativeSafeNumber(root.ownedWorktrees, "owned worktree count"),
    ownedBranches: nonnegativeSafeNumber(root.ownedBranches, "owned branch count"),
    liveAgents: nonnegativeSafeNumber(root.liveAgents, "live agent count"),
    dirtyWorktreeWarnings: textArray(root.dirtyWorktreeWarnings, "dirty worktree warnings"),
    blockers: textArray(root.blockers, "deletion blockers"),
    canPreserveBranches: root.canPreserveBranches,
    canDeleteOwnedBranches: root.canDeleteOwnedBranches,
    previewToken: root.previewToken,
  };
}

export function parseRunMergePreview(value: unknown): ControlRunMergePreview {
  const root = requiredRecord(value, "run merge preview");
  if (
    root.protocol !== RUN_MERGE_PREVIEW_PROTOCOL ||
    typeof root.targetAdvanced !== "boolean" ||
    (root.resyncState !== "current" && root.resyncState !== "required" && root.resyncState !== "unavailable") ||
    typeof root.canAuthorize !== "boolean" ||
    !isSha256Digest(root.previewToken)
  ) {
    throw new Error("authority returned an unsupported run merge preview");
  }
  return {
    protocol: RUN_MERGE_PREVIEW_PROTOCOL,
    runId: requiredText(root.runId, "merge preview run id"),
    objective: requiredText(root.objective, "merge preview objective"),
    phase: requiredText(root.phase, "merge preview phase"),
    targetRef: requiredText(root.targetRef, "merge preview target"),
    targetAdvanced: root.targetAdvanced,
    resyncState: root.resyncState,
    completedTickets: nonnegativeSafeNumber(root.completedTickets, "completed ticket count"),
    totalTickets: nonnegativeSafeNumber(root.totalTickets, "total ticket count"),
    blockers: textArray(root.blockers, "merge blockers"),
    canAuthorize: root.canAuthorize,
    previewToken: root.previewToken,
  };
}

export function parseControlProposalInspection(value: unknown): ControlProposalInspection {
  const root = requiredRecord(value, "proposal inspection");
  assertExactFields(root, [
    "runId", "ticketId", "sourceTicketId", "status", "title", "summary",
    "targetNodeIds", "createdAt", "decision", "disposition",
  ], "proposal inspection");
  const status = proposalTicketStatus(root.status, "proposal ticket status");
  const targetNodeIds = boundedIdentityArray(root.targetNodeIds, "proposal target node", 256);
  const disposition = parseProposalDisposition(root.disposition);
  const decision = root.decision === undefined ? undefined : parseProposalDecision(root.decision);
  if (decision?.decision === "rejection" && disposition.kind !== "rejected") {
    throw new Error("authority returned a rejected proposal decision without a rejected disposition");
  }
  if (disposition.kind === "rejected" && decision?.decision !== "rejection") {
    throw new Error("authority returned a rejected proposal disposition without its durable decision");
  }
  if (decision?.decision === "approval" && disposition.kind === "rejected") {
    throw new Error("authority returned an approved proposal with a rejected disposition");
  }
  if ((disposition.kind === "no_op" || disposition.kind === "application") && decision?.decision !== "approval") {
    throw new Error("authority returned an applied proposal disposition without its durable approval");
  }
  return {
    runId: boundedRequiredText(root.runId, "proposal run id", 256),
    ticketId: boundedRequiredText(root.ticketId, "proposal ticket id", 256),
    sourceTicketId: boundedRequiredText(root.sourceTicketId, "proposal source ticket id", 256),
    status,
    title: boundedRequiredText(root.title, "proposal title", 4_096),
    summary: boundedRequiredText(root.summary, "proposal summary", 32_768),
    targetNodeIds,
    createdAt: requiredTimestamp(root.createdAt, "proposal creation time"),
    ...(decision === undefined ? {} : { decision }),
    disposition,
  };
}

function parseProposalDecision(value: unknown): ControlProposalDecision {
  const row = requiredRecord(value, "proposal decision");
  assertExactFields(row, ["decision", "authoritySha256", "message", "actor", "decidedAt"], "proposal decision");
  if (row.decision !== "approval" && row.decision !== "rejection") {
    throw new Error("authority returned an invalid proposal decision");
  }
  if (!isSha256Digest(row.authoritySha256)) {
    throw new Error("authority returned an invalid proposal decision digest");
  }
  return {
    decision: row.decision,
    authoritySha256: row.authoritySha256,
    ...(row.message === undefined
      ? {}
      : { message: boundedRequiredText(row.message, "proposal decision message", 8_000) }),
    actor: boundedRequiredText(row.actor, "proposal decision actor", 256),
    decidedAt: requiredTimestamp(row.decidedAt, "proposal decision time"),
  };
}

function parseProposalDisposition(value: unknown): ControlProposalDisposition {
  const row = requiredRecord(value, "proposal disposition");
  if (row.kind === "pending" || row.kind === "rejected") {
    assertExactFields(row, ["kind"], "proposal disposition");
    return { kind: row.kind };
  }
  if (row.kind === "no_op") {
    assertExactFields(row, ["kind", "summary"], "proposal disposition");
    return {
      kind: "no_op",
      ...(row.summary === undefined
        ? {}
        : { summary: boundedRequiredText(row.summary, "proposal no-op summary", 32_768) }),
    };
  }
  if (row.kind === "application") {
    assertExactFields(row, ["kind", "applicationTicketId", "applicationStatus"], "proposal disposition");
    return {
      kind: "application",
      applicationTicketId: boundedRequiredText(row.applicationTicketId, "proposal application ticket id", 256),
      applicationStatus: proposalTicketStatus(row.applicationStatus, "proposal application status"),
    };
  }
  throw new Error("authority returned an invalid proposal disposition");
}

/** Reuse the canonical validator so the control center cannot reinterpret action authority. */
export function parseStageCapabilityCatalog(value: unknown): StageCapabilityCatalog {
  assertStageCapabilityCatalog(value);
  return structuredClone(value);
}

export function parseRunAttemptLineage(value: unknown): ControlRunAttemptLineage {
  const root = requiredRecord(value, "run attempt lineage");
  if (
    root.protocol !== RUN_ATTEMPT_LINEAGE_PROTOCOL ||
    !Number.isSafeInteger(root.runRevision) ||
    (root.runRevision as number) < 0 ||
    !Array.isArray(root.attempts)
  ) {
    throw new Error("authority returned an unsupported run attempt lineage");
  }
  const attemptIds = new Set<string>();
  const attempts = root.attempts.map((value, index): ControlAttemptLineageEntry => {
    const row = requiredRecord(value, `attempt lineage row ${index + 1}`);
    const attemptId = requiredText(row.attemptId, "attempt lineage identity");
    if (attemptIds.has(attemptId)) throw new Error("authority returned duplicate attempt lineage identity");
    attemptIds.add(attemptId);
    if (
      !ATTEMPT_LINEAGE_STATUSES.has(String(row.status) as ControlAttemptLineageStatus) ||
      !ATTEMPT_LINEAGE_REASONS.has(String(row.reason) as ControlAttemptLineageReason) ||
      !Number.isSafeInteger(row.branchEpoch) ||
      (row.branchEpoch as number) < 0 ||
      typeof row.activeLeaf !== "boolean" ||
      !Array.isArray(row.childAttemptIds)
    ) {
      throw new Error("authority returned an invalid attempt lineage row");
    }
    return {
      attemptId,
      persona: requiredText(row.persona, "attempt lineage persona"),
      ticket: requiredText(row.ticket, "attempt lineage ticket"),
      step: requiredText(row.step, "attempt lineage step"),
      status: row.status as ControlAttemptLineageStatus,
      reason: row.reason as ControlAttemptLineageReason,
      branchEpoch: row.branchEpoch as number,
      ...(row.parentAttemptId === undefined
        ? {}
        : { parentAttemptId: requiredText(row.parentAttemptId, "parent attempt identity") }),
      childAttemptIds: row.childAttemptIds.map((child, childIndex) =>
        requiredText(child, `child attempt identity ${childIndex + 1}`)),
      activeLeaf: row.activeLeaf,
    };
  });
  // Ticket-scoped projections intentionally retain authenticated relationship identities even
  // when the related row is outside the requested scope. Presentation resolves only visible
  // semantic labels and never renders those opaque identities.
  return {
    protocol: RUN_ATTEMPT_LINEAGE_PROTOCOL,
    runId: requiredText(root.runId, "attempt lineage run id"),
    runRevision: root.runRevision as number,
    attempts,
  };
}

export function parseConfigDocumentCatalog(value: unknown): ConfigDocumentCatalog {
  const root = requiredRecord(value, "configuration document catalog");
  const profile = requiredRecord(root.profile, "configuration profile");
  if (
    root.protocol !== CONFIG_DOCUMENT_CATALOG_PROTOCOL ||
    !isSha256Digest(root.catalogToken) ||
    typeof root.valid !== "boolean" ||
    !Array.isArray(root.diagnostics) ||
    !Array.isArray(root.documents)
  ) throw new Error("authority returned an unsupported configuration document catalog");
  const documents = root.documents.map(parseConfigDocumentSummary);
  const ids = new Set<string>();
  for (const document of documents) {
    if (ids.has(document.id)) throw new Error("authority returned duplicate configuration document identity");
    ids.add(document.id);
  }
  return {
    protocol: CONFIG_DOCUMENT_CATALOG_PROTOCOL,
    catalogToken: root.catalogToken,
    profile: {
      id: requiredText(profile.id, "configuration profile identity"),
      version: requiredText(profile.version, "configuration profile version"),
    },
    valid: root.valid,
    diagnostics: textArray(root.diagnostics, "configuration diagnostics"),
    documents,
  };
}

export function parseConfigDocumentSource(value: unknown): ConfigDocumentSource {
  const root = requiredRecord(value, "configuration document source");
  if (
    root.protocol !== CONFIG_DOCUMENT_SOURCE_PROTOCOL ||
    !isSha256Digest(root.catalogToken) ||
    typeof root.source !== "string"
  ) throw new Error("authority returned an unsupported configuration document source");
  return {
    protocol: CONFIG_DOCUMENT_SOURCE_PROTOCOL,
    catalogToken: root.catalogToken,
    document: parseConfigDocumentSummary(root.document),
    source: root.source,
  };
}

export function parseConfigDocumentMutation(value: unknown): ConfigDocumentMutationResult {
  const root = requiredRecord(value, "configuration document mutation");
  if (root.protocol !== CONFIG_DOCUMENT_MUTATION_PROTOCOL) {
    throw new Error("authority returned an unsupported configuration mutation");
  }
  return {
    protocol: CONFIG_DOCUMENT_MUTATION_PROTOCOL,
    changedDocuments: nonnegativeSafeNumber(root.changedDocuments, "changed configuration document count"),
    catalog: parseConfigDocumentCatalog(root.catalog),
  };
}

export function parseConfigRunTypeTemplates(value: unknown): ConfigRunTypeTemplates {
  const root = requiredRecord(value, "run type templates");
  if (
    root.protocol !== CONFIG_RUN_TYPE_TEMPLATES_PROTOCOL ||
    !isSha256Digest(root.catalogToken) ||
    !Array.isArray(root.templates)
  ) throw new Error("authority returned unsupported run type templates");
  return {
    protocol: CONFIG_RUN_TYPE_TEMPLATES_PROTOCOL,
    catalogToken: root.catalogToken,
    templates: root.templates.map((value, index) => {
      const row = requiredRecord(value, `run type template ${index + 1}`);
      return {
        id: requiredText(row.id, "run type template identity"),
        title: requiredText(row.title, "run type template title"),
        description: requiredText(row.description, "run type template description"),
      };
    }),
  };
}

export function parseConfigLegacyMigrationPreview(value: unknown): ConfigLegacyMigrationPreview {
  const root = requiredRecord(value, "legacy migration preview");
  if (
    root.protocol !== CONFIG_LEGACY_MIGRATION_PREVIEW_PROTOCOL ||
    !isSha256Digest(root.previewToken) ||
    (root.sourceKind !== "codex_schema1" && root.sourceKind !== "unmanaged_koni") ||
    typeof root.requiresRunBarrier !== "boolean" ||
    root.sourceRetained !== true
  ) throw new Error("authority returned an unsupported legacy migration preview");
  return {
    protocol: CONFIG_LEGACY_MIGRATION_PREVIEW_PROTOCOL,
    previewToken: root.previewToken,
    migrationId: requiredText(root.migrationId, "legacy migration identity"),
    sourceKind: root.sourceKind,
    profileVersion: requiredText(root.profileVersion, "legacy migration profile version"),
    configurationFiles: nonnegativeSafeNumber(root.configurationFiles, "legacy configuration file count"),
    externalAgents: nonnegativeSafeNumber(root.externalAgents, "external agent count"),
    runs: nonnegativeSafeNumber(root.runs, "legacy run count"),
    requiresRunBarrier: root.requiresRunBarrier,
    sourceRetained: true,
  };
}

export function parseConfigLegacyMigrationResult(value: unknown): ConfigLegacyMigrationResult {
  const root = requiredRecord(value, "legacy migration result");
  if (root.protocol !== CONFIG_LEGACY_MIGRATION_RESULT_PROTOCOL || root.sourceRetained !== true) {
    throw new Error("authority returned an unsupported legacy migration result");
  }
  return {
    protocol: CONFIG_LEGACY_MIGRATION_RESULT_PROTOCOL,
    migrationId: requiredText(root.migrationId, "legacy migration identity"),
    sourceRetained: true,
    catalog: parseConfigDocumentCatalog(root.catalog),
  };
}

function parseConfigDocumentSummary(value: unknown): ConfigDocumentSummary {
  const row = requiredRecord(value, "configuration document");
  const capabilities = requiredRecord(row.capabilities, "configuration document capabilities");
  if (
    !CONFIG_DOCUMENT_DOMAINS.includes(row.domain as ConfigDocumentDomain) ||
    !CONFIG_RESOURCE_KINDS.includes(row.kind as ConfigResourceKind) ||
    !Array.isArray(row.resourceKinds) ||
    !row.resourceKinds.every((kind) => CONFIG_RESOURCE_KINDS.includes(kind as ConfigResourceKind)) ||
    (row.format !== "yaml" && row.format !== "toml" && row.format !== "markdown") ||
    !Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) < 0 ||
    !isSha256Digest(row.sourceToken) ||
    capabilities.read !== true ||
    typeof capabilities.update !== "boolean" ||
    typeof capabilities.rename !== "boolean" ||
    typeof capabilities.delete !== "boolean" ||
    (capabilities.reason !== undefined && typeof capabilities.reason !== "string")
  ) throw new Error("authority returned an invalid configuration document");
  return {
    id: requiredText(row.id, "configuration document identity"),
    title: requiredText(row.title, "configuration document title"),
    domain: row.domain as ConfigDocumentDomain,
    kind: row.kind as ConfigResourceKind,
    resourceKinds: row.resourceKinds as ConfigResourceKind[],
    format: row.format,
    sizeBytes: row.sizeBytes as number,
    sourceToken: row.sourceToken,
    capabilities: {
      read: true,
      update: capabilities.update as boolean,
      rename: capabilities.rename as boolean,
      delete: capabilities.delete as boolean,
      ...(typeof capabilities.reason === "string" ? { reason: capabilities.reason } : {}),
    },
  };
}

const ATTEMPT_LINEAGE_STATUSES = new Set<ControlAttemptLineageStatus>([
  "queued", "running", "waiting_question", "terminal_accepted", "completed", "failed", "aborted", "interrupted",
]);

const ATTEMPT_LINEAGE_REASONS = new Set<ControlAttemptLineageReason>([
  "initial", "retry", "rework", "review", "recovery", "integration",
]);

const PROPOSAL_TICKET_STATUSES = new Set<TicketStatus>([
  "proposed", "todo", "ready", "running", "review", "blocked", "completed", "failed", "cancelled",
]);

function proposalTicketStatus(value: unknown, label: string): TicketStatus {
  if (typeof value !== "string" || !PROPOSAL_TICKET_STATUSES.has(value as TicketStatus)) {
    throw new Error(`${label} is invalid`);
  }
  return value as TicketStatus;
}

function assertExactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const fields = new Set(allowed);
  if (Object.keys(value).some((field) => !fields.has(field))) {
    throw new Error(`authority returned an unsupported ${label} field`);
  }
}

function boundedRequiredText(value: unknown, label: string, maximum: number): string {
  const text = requiredText(value, label);
  if ([...text].length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function boundedIdentityArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} list is invalid`);
  const parsed = value.map((item, index) => boundedRequiredText(item, `${label} ${index + 1}`, 256));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} list contains duplicates`);
  return parsed;
}

function requiredTimestamp(value: unknown, label: string): string {
  const timestamp = boundedRequiredText(value, label, 64);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} is invalid`);
  return timestamp;
}

function parseProfileConflict(value: unknown): ControlProfileConflict {
  const row = requiredRecord(value, "upstream conflict");
  if (!new Set(["modified", "deleted", "orphaned"]).has(String(row.reason)) ||
      (row.currentSha256 !== null && !isSha256Digest(row.currentSha256)) ||
      (row.upstreamSha256 !== null && !isSha256Digest(row.upstreamSha256))) {
    throw new Error("authority returned an invalid upstream conflict");
  }
  return {
    path: requiredText(row.path, "upstream conflict path"),
    title: requiredText(row.title, "upstream conflict title"),
    domain: requiredText(row.domain, "upstream conflict domain"),
    reason: row.reason as ControlProfileConflict["reason"],
    currentSha256: row.currentSha256 as Sha256Digest | null,
    upstreamSha256: row.upstreamSha256 as Sha256Digest | null,
  };
}

function parseConfigField(value: unknown, index: number): ConfigFieldDefinition {
  const row = requiredRecord(value, `configuration field ${index + 1}`);
  const kind = row.kind;
  if (!new Set<ConfigFieldKind>([
    "text", "multiline", "integer", "boolean", "select", "model", "thinking", "string_list",
  ]).has(kind as ConfigFieldKind)) throw new Error("configuration field has an unsupported kind");
  const options = row.options;
  if (options !== undefined && !Array.isArray(options)) throw new Error("configuration field options are invalid");
  const minimum = optionalSafeNumber(row.minimum, "configuration field minimum");
  const maximum = optionalSafeNumber(row.maximum, "configuration field maximum");
  return {
    key: requiredText(row.key, "configuration field key"),
    label: requiredText(row.label, "configuration field label"),
    description: requiredText(row.description, "configuration field description"),
    kind: kind as ConfigFieldKind,
    ...(options === undefined ? {} : {
      options: options.map((option, optionIndex) => {
        const item = requiredRecord(option, `configuration field option ${optionIndex + 1}`);
        return {
          value: requiredText(item.value, "configuration option value"),
          label: requiredText(item.label, "configuration option label"),
          ...(typeof item.description === "string" ? { description: item.description } : {}),
        };
      }),
    }),
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is missing`);
  return value;
}

function optionalSafeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${label} is invalid`);
  return value;
}

function nonnegativeSafeNumber(value: unknown, label: string): number {
  const parsed = optionalSafeNumber(value, label);
  if (parsed === undefined || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} are invalid`);
  return value.map((item, index) => requiredText(item, `${label} ${index + 1}`));
}
