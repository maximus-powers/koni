import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { type ExecutionPolicyBinding } from "../authority/execution-policy.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  ResolvedGateAutoEvaluationContextBinding,
  RunPipelineStageDefinition,
} from "../authority/run-engine.js";
import {
  LEAD_JUDGMENT_OUTPUT_PROTOCOL,
  type CompiledBehaviorIr,
  type CompiledLeadJudgmentBehavior,
  type CompiledRunStage,
  type CompiledRunTypeBehavior,
  type LeadJudgmentTrigger,
} from "../contracts/behavior.js";
import type { CompiledConfiguration, ConfigurationObject } from "../contracts/configuration.js";
import type {
  CompiledGatePolicyContext,
  DerivedTicketDefinition,
  DerivedWorkflowStep,
} from "../contracts/rules.js";
import { type TypedGraph } from "../graph/model.js";
import {
  piAgentCatalogFromCompiledConfiguration,
  resolvePiAgentConfiguration,
  type PiResolvedInventory,
  type ResolvedPiAgentConfiguration,
} from "../pi/agent-configuration.js";
import {
  MAX_RETAINED_TOOL_RECEIPTS,
  MAX_RETAINED_TOOL_RECEIPTS_BYTES,
  type KoniCompactionSnapshot,
} from "../pi/compaction.js";
import { type AgentLaunchSpec } from "../pi/launch-spec.js";
import { validateKoniToolReceipt } from "../pi/tool-catalog.js";
import {
  canonicalEncode,
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import { semanticQuestionPolicy } from "../state/question-policy.js";
import {
  leadJudgmentTicketBoard,
  type AgentAttemptRecord,
  type AttemptStatus,
  type RunRecord,
  type TicketExecutionControlRecord,
  type TicketRecord,
} from "../state/run-record.js";
import { type ReadyAssignment } from "../state/scheduler.js";
import { type CompiledChangeControl } from "./execution-semantics.js";
import { projectGatePolicyDefinitions } from "./graph-schema.js";
import { PLAN_DOMAINS } from "./planning-artifact.js";

import {
  approvedApplicationRequestContext,
  assertAllowedFields,
  assertExactFields,
  boundedText,
  compareText,
  deepFreeze,
  fail,
  humanize,
  isRecord,
  isWithinDirectory,
  normalizeResourcePath,
  optionalRecord,
  optionalSafeInteger,
  optionalString,
  requireValidation,
  requiredNonempty,
  requiredRecord,
  stringArray,
  withoutField,
} from "./run-check-execution.js";
import {
  leadJudgmentTerminalSchema,
  planningGraphSeedContract,
  planningPatchTerminalSchema,
  planningTerminalSchema,
} from "./run-graph-compilation.js";
import {
  MAX_PINNED_SKILL_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_FILE_BYTES,
  PINNED_CONFIGURATION_PROTOCOL,
  PLANNING_TERMINAL_INSTRUCTION,
  type AttemptDescriptor,
  type PinnedConfigurationArtifact,
  type PinnedConfigurationMaterial,
  type PinnedSkill,
  type PinnedSkillFile,
  type PlanningRevisionPreparationContext,
} from "./run-program-contracts.js";
import { answeredQuestionContext, requireThinkingLevel } from "./run-program-support.js";

export function loadedSkillResourceFromReceipt(
  record: Readonly<{ toolName: string; outcome: string }>,
  receipt: unknown,
  spec: Readonly<AgentLaunchSpec>,
): string | undefined {
  return loadedSkillResourceCheckpointFromReceipt(record, receipt, spec)?.identity;
}

export function loadedSkillResourceCheckpointFromReceipt(
  record: Readonly<{ toolName: string; outcome: string }>,
  receipt: unknown,
  spec: Readonly<AgentLaunchSpec>,
):
  | {
      identity: string;
      resource: NonNullable<KoniCompactionSnapshot["loadedResourceContents"]>[number];
    }
  | undefined {
  if (record.toolName !== "koni_read_resource" || record.outcome !== "accepted") return undefined;
  try {
    validateKoniToolReceipt(receipt);
  } catch {
    return undefined;
  }
  if (receipt.outcome !== "accepted") return undefined;
  const value = optionalRecord(receipt.value);
  const resource = spec.resources.entries.find(
    (entry) =>
      entry.kind === "skill" &&
      entry.id === value?.resourceId &&
      entry.relativePath === value.relativePath &&
      entry.sha256 === value.sha256,
  );
  if (
    resource === undefined ||
    value?.offsetChars !== 0 ||
    value.eof !== true ||
    value.nextOffsetChars !== value.totalChars ||
    typeof value.content !== "string" ||
    Array.from(value.content).length !== value.totalChars ||
    rawSha256(value.content) !== resource.sha256
  ) {
    return undefined;
  }
  return {
    identity: `${resource.relativePath} (${resource.sha256})`,
    resource: {
      relativePath: resource.relativePath,
      sha256: resource.sha256,
      content: value.content,
    },
  };
}

export function retainedToolReceiptCheckpoint(
  record: Readonly<{ toolName: string; outcome: string }>,
  receipt: unknown,
):
  | {
      key: string;
      receipt: NonNullable<KoniCompactionSnapshot["retainedToolReceipts"]>[number];
    }
  | undefined {
  try {
    validateKoniToolReceipt(receipt);
  } catch {
    return undefined;
  }
  if (record.outcome !== receipt.outcome) return undefined;
  const value = optionalRecord(receipt.value);
  let key: string | undefined;
  if (
    record.toolName === "koni_read_file" &&
    record.outcome === "accepted" &&
    typeof value?.path === "string" &&
    typeof value.content === "string" &&
    typeof value.sizeBytes === "number" &&
    value.offset === 0 &&
    value.nextOffset === value.sizeBytes &&
    value.eof === true &&
    Buffer.byteLength(value.content, "utf8") === value.sizeBytes &&
    isSha256Digest(value.sha256) &&
    rawSha256(value.content) === value.sha256
  ) {
    key = `file:${value.path}`;
  } else if (
    record.toolName === "koni_run_check" &&
    record.outcome === "accepted" &&
    typeof value?.checkId === "string"
  ) {
    key = `check:${value.checkId}`;
  } else if (record.outcome === "rejected") {
    key = `rejection:${record.toolName}`;
  }
  if (key === undefined) return undefined;
  const canonical = canonicalEncode(receipt);
  return {
    key,
    receipt: {
      receiptId: receipt.receiptId,
      toolName: record.toolName,
      outcome: receipt.outcome,
      sha256: rawSha256(canonical),
      canonical,
    },
  };
}

export function applyRetainedToolReceipt(
  retained: Map<string, NonNullable<KoniCompactionSnapshot["retainedToolReceipts"]>[number]>,
  shadowed: Set<string>,
  record: Readonly<{ toolName: string; outcome: string }>,
  receipt: unknown,
): void {
  const value = isRecord(receipt) ? optionalRecord(receipt.value) : undefined;
  if (record.outcome === "accepted") {
    const rejectionKey = `rejection:${record.toolName}`;
    shadowed.add(rejectionKey);
    retained.delete(rejectionKey);
    if (
      (record.toolName === "koni_read_file" ||
        record.toolName === "koni_write_file" ||
        record.toolName === "koni_edit_file") &&
      typeof value?.path === "string"
    ) {
      const fileKey = `file:${value.path}`;
      shadowed.add(fileKey);
      retained.delete(fileKey);
    }
    if (record.toolName === "koni_run_check" && typeof value?.checkId === "string") {
      for (const key of retained.keys()) {
        if (key.startsWith("file:")) retained.delete(key);
      }
      shadowed.add("file:*");
      const checkKey = `check:${value.checkId}`;
      shadowed.add(checkKey);
      retained.delete(checkKey);
    }
  }
  const checkpoint = retainedToolReceiptCheckpoint(record, receipt);
  if (checkpoint !== undefined) {
    shadowed.add(checkpoint.key);
    retained.set(checkpoint.key, checkpoint.receipt);
  }
}

export function selectRetainedToolReceipts(
  candidates: ReadonlyMap<
    string,
    NonNullable<KoniCompactionSnapshot["retainedToolReceipts"]>[number]
  >,
): NonNullable<KoniCompactionSnapshot["retainedToolReceipts"]> {
  const selected: NonNullable<KoniCompactionSnapshot["retainedToolReceipts"]>[number][] = [];
  let bytes = 0;
  const ordered = [...candidates.entries()].sort(([leftKey], [rightKey]) => {
    const leftPriority = leftKey.startsWith("file:") ? 1 : 0;
    const rightPriority = rightKey.startsWith("file:") ? 1 : 0;
    return leftPriority - rightPriority || compareText(leftKey, rightKey);
  });
  for (const [, receipt] of ordered) {
    const receiptBytes = Buffer.byteLength(receipt.canonical, "utf8");
    if (
      selected.length >= MAX_RETAINED_TOOL_RECEIPTS ||
      bytes + receiptBytes > MAX_RETAINED_TOOL_RECEIPTS_BYTES
    )
      continue;
    selected.push(receipt);
    bytes += receiptBytes;
  }
  return selected;
}

export function sameScopeContinuationPrompt(
  initialPrompt: string,
  lineage: Readonly<AgentLaunchSpec["lineage"]>,
  parentFailure?: string,
  compensatedValidationFailures: readonly string[] = [],
): string {
  const continuesSameScope = lineage.reason === "retry" || lineage.reason === "recovery";
  const authenticatedFork = lineage.conversationFork !== undefined && continuesSameScope;
  const boundedCompilerRecovery = compensatedValidationFailures.length > 0;
  if (!authenticatedFork && !boundedCompilerRecovery) return initialPrompt;
  const rejectionLedger = [...new Set(compensatedValidationFailures)].map(
    (failure, index) => `${index + 1}. ${failure}`,
  );
  if (!authenticatedFork) {
    return [
      initialPrompt,
      "This is a fresh same-scope compiler-recovery root because no safe authenticated conversation fork was available. No parent transcript is inherited; use only the current compiler-authenticated repository and graph context.",
      `Compiler-rejected outputs in this active bounded recovery chain (oldest to newest):\n${rejectionLedger.join("\n")}`,
      "Correct every listed contract failure in one complete submission. Do not regress an earlier correction while fixing the latest rejection.",
    ].join("\n\n");
  }
  return [
    initialPrompt,
    // "checks" deliberately absent from this list: assignment completion requires every configured
    // check receipt to be bound to the *current* attempt, so an agent that reuses inherited check
    // results produces zero valid receipts and fails completion. Reusing reads and decisions is
    // sound economy; reusing checks is a contract violation the compiler will reject.
    "This is an authenticated same-scope continuation. The inherited Pi conversation is the repository and execution ledger: reuse its successful reads, searches, and decisions instead of repeating them.",
    "An accepted inherited koni_read_resource receipt already satisfies skill loading for those immutable bytes. Reuse it and do not reload the same immutable resource after recovery or compaction.",
    "Configured checks are the exception to that reuse: a check receipt in inherited history belongs to the parent attempt and cannot satisfy this one. Re-run every configured check your step requires in this attempt, even when the inherited run passed.",
    "Discard any speculative reasoning from that failed turn; retain only authenticated repository results, compiler constraints, and the unfinished objective.",
    "The parent terminal or provider-error turn was not accepted output. A terminal-tool receipt visible in inherited history belongs to the parent attempt and is invalid for this attempt: do not answer that it was already submitted. Resolve the remaining action directly from the already-retained evidence and current objective, then invoke the required terminal tool exactly once in this attempt. Perform another repository call only when one specific missing fact makes correct completion impossible.",
    // The authority-classified cause of the parent's death is metadata the inherited transcript
    // never contains — without it, forks re-derived the failure from scratch or repeated it
    // (observed live: identical 40-turn loops across fork generations). Name it explicitly.
    ...(parentFailure === undefined
      ? []
      : [
          `The parent attempt ended for this authority-recorded reason: ${parentFailure}. Account for it directly instead of re-deriving it: an exhausted budget means finish minimal remaining work and submit immediately; a transient provider failure means your prior work is intact, so proceed straight to submission; a tool-contract rejection means correct that exact call rather than retrying variations.`,
          ...(parentFailure.includes("input token budget exceeded")
            ? [
                "Reuse exact repository results while their bytes remain visible in the inherited conversation. After compaction, reacquire only the specific repository bytes needed to continue; do not vary equivalent arguments merely to evade a duplicate rejection. A repository mutation or configured check can invalidate earlier reads, so refresh only the affected evidence.",
              ]
            : []),
        ]),
    ...(rejectionLedger.length === 0
      ? []
      : [
          `Compiler-rejected outputs in this active bounded recovery chain (oldest to newest):\n${rejectionLedger.join("\n")}`,
          "Correct every listed contract failure in one complete submission. Do not regress an earlier correction while fixing the latest rejection.",
        ]),
  ].join("\n\n");
}

export const COMPENSATED_VALIDATION_FAILURE_PREFIX =
  "Retired accepted output after a compensated validation";

export function activeCompensatedValidationFailures(
  run: Readonly<RunRecord>,
  assignment: Readonly<ReadyAssignment> | undefined,
): string[] {
  if (assignment === undefined) return [];
  const step = run.tickets[assignment.ticketId]?.steps.find(
    (candidate) => candidate.id === assignment.stepId,
  );
  if (step === undefined) return [];
  const failures: string[] = [];
  for (const attemptId of [...step.attemptIds].reverse()) {
    const attempt = run.attempts[attemptId];
    const failure = attempt?.error ?? attempt?.terminalSummary;
    if (
      attempt?.status !== "interrupted" ||
      failure === undefined ||
      !failure.startsWith(COMPENSATED_VALIDATION_FAILURE_PREFIX)
    ) {
      break;
    }
    failures.push(failure.slice(0, 400));
  }
  return failures.reverse();
}

export function createPinnedArtifact(
  runId: string,
  configuration: CompiledConfiguration,
  skills: Record<string, PinnedSkill>,
  resolvedPiAgents: Readonly<Record<string, ResolvedPiAgentConfiguration>>,
): PinnedConfigurationArtifact {
  const piAgents = Object.fromEntries(
    Object.entries(resolvedPiAgents)
      .sort(([left], [right]) => compareText(left, right))
      .map(([id, agent]) => [
        id,
        {
          skillIds: agent.resources.skills.map((skill) => skill.id).sort(compareText),
          context: agent.resources.context.map((resource) => resource.content),
          configurationSha256: agent.configurationSha256,
        },
      ]),
  );
  const material: PinnedConfigurationMaterial = {
    protocol: PINNED_CONFIGURATION_PROTOCOL,
    runId,
    configuration,
    skills,
    piAgents,
  };
  return deepFreeze({ ...structuredClone(material), artifactSha256: canonicalHash(material) });
}

export function validatePinnedArtifact(value: unknown): PinnedConfigurationArtifact {
  if (
    !isRecord(value) ||
    value.protocol !== PINNED_CONFIGURATION_PROTOCOL ||
    !isRecord(value.configuration) ||
    !isRecord(value.skills)
  ) {
    fail("pinned_configuration_shape", "pinned run configuration has an invalid shape");
  }
  const artifact = value as unknown as PinnedConfigurationArtifact;
  if (canonicalHash(withoutField(artifact, "artifactSha256")) !== artifact.artifactSha256) {
    fail(
      "pinned_configuration_hash",
      "pinned run configuration artifact hash does not match its bytes",
    );
  }
  const configuration = artifact.configuration;
  if (
    canonicalHash(withoutField(configuration, "configuration_sha256")) !==
    configuration.configuration_sha256
  ) {
    fail("configuration_hash", "pinned compiled configuration hash does not match its content");
  }
  for (const [id, skill] of Object.entries(artifact.skills)) {
    if (
      !isRecord(skill) ||
      skill.id !== id ||
      !isRecord(skill.files) ||
      !Object.hasOwn(skill.files, "SKILL.md")
    ) {
      fail("skill_hash", `pinned skill ${id} has an invalid package inventory`);
    }
    for (const [relativePath, rawFile] of Object.entries(skill.files)) {
      if (!isRecord(rawFile))
        fail("skill_hash", `pinned skill ${id}/${relativePath} has invalid metadata`);
      const file = rawFile as unknown as PinnedSkillFile;
      if (
        file.relativePath !== relativePath ||
        normalizeResourcePath(relativePath) !== relativePath ||
        typeof file.content !== "string" ||
        file.sizeBytes !== Buffer.byteLength(file.content, "utf8") ||
        rawSha256(file.content) !== file.sha256
      ) {
        fail("skill_hash", `pinned skill ${id}/${relativePath} does not match its content hash`);
      }
    }
  }
  if (artifact.piAgents !== undefined) {
    for (const [id, agent] of Object.entries(artifact.piAgents)) {
      if (
        !isRecord(agent) ||
        !Array.isArray(agent.skillIds) ||
        agent.skillIds.some(
          (skillId) => typeof skillId !== "string" || artifact.skills[skillId] === undefined,
        ) ||
        !Array.isArray(agent.context) ||
        agent.context.some((entry) => typeof entry !== "string") ||
        typeof agent.configurationSha256 !== "string" ||
        !isSha256Digest(agent.configurationSha256)
      ) {
        fail("pi_agent_resources", `pinned Pi resources for agent ${id} are invalid`);
      }
    }
  }
  return deepFreeze(structuredClone(artifact));
}

export function attachHistoricalBehavior(
  artifact: PinnedConfigurationArtifact,
  behavior: CompiledBehaviorIr,
): PinnedConfigurationArtifact {
  const configuration = structuredClone(artifact.configuration);
  // The projection is runtime-only. Keeping it non-enumerable preserves the authenticated legacy
  // configuration and wrapper digests while allowing every semantic consumer to use one typed IR.
  Object.defineProperty(configuration, "behavior", {
    value: behavior,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const projected = { ...artifact, configuration } as PinnedConfigurationArtifact;
  if (
    canonicalHash(withoutField(configuration, "configuration_sha256")) !==
      configuration.configuration_sha256 ||
    canonicalHash(withoutField(projected, "artifactSha256")) !== projected.artifactSha256
  ) {
    fail(
      "historical_behavior_hash",
      "runtime compatibility projection changed authenticated pinned bytes",
    );
  }
  return deepFreeze(projected);
}

export function assertPinnedMatchesRun(
  artifact: PinnedConfigurationArtifact,
  run: RunRecord,
): void {
  if (
    artifact.runId !== run.id ||
    artifact.configuration.configuration_sha256 !== run.compiledConfigHash
  ) {
    fail(
      "pinned_configuration_identity",
      "pinned configuration belongs to another run or compiler snapshot",
    );
  }
}

export function resolveRunPiAgents(
  configuration: CompiledConfiguration,
  inventory: PiResolvedInventory,
): Readonly<Record<string, ResolvedPiAgentConfiguration>> {
  const catalog = piAgentCatalogFromCompiledConfiguration(configuration);
  const output: Record<string, ResolvedPiAgentConfiguration> = Object.create(null) as Record<
    string,
    ResolvedPiAgentConfiguration
  >;
  for (const agentId of Object.keys(catalog).sort(compareText)) {
    output[agentId] = requireValidation(
      resolvePiAgentConfiguration({
        agentId,
        agents: catalog,
        inventory,
        extensionAdapters: {},
      }),
      "pi_agent_invalid",
      `Pi resources for agent ${agentId} are not executable`,
    );
  }
  return output;
}

export async function pinPiResolvedSkills(
  agents: Readonly<Record<string, ResolvedPiAgentConfiguration>>,
): Promise<Record<string, PinnedSkill>> {
  const selected = new Map<string, ResolvedPiAgentConfiguration["resources"]["skills"][number]>();
  for (const agent of Object.values(agents)) {
    for (const skill of agent.resources.skills) {
      const existing = selected.get(skill.id);
      if (existing !== undefined && existing.sha256 !== skill.sha256) {
        fail("skill_identity_collision", `Pi resolved different skills with id ${skill.id}`);
      }
      selected.set(skill.id, skill);
    }
  }
  const output: Record<string, PinnedSkill> = Object.create(null) as Record<string, PinnedSkill>;
  let totalFiles = 0;
  let totalBytes = 0;
  for (const [id, resource] of [...selected.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const skillRoot = path.dirname(resource.absolutePath);
    const metadata = await lstat(skillRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      fail("skill_directory", `skill ${id} is not a regular directory`);
    const canonical = await realpath(skillRoot);
    const files = await readSkillPackage(canonical, id);
    if (!Object.hasOwn(files, "SKILL.md")) fail("skill_file", `skill ${id} has no root SKILL.md`);
    totalFiles += Object.keys(files).length;
    totalBytes += Object.values(files).reduce((sum, file) => sum + file.sizeBytes, 0);
    if (totalFiles > MAX_SKILL_FILES || totalBytes > MAX_PINNED_SKILL_BYTES) {
      fail("skill_package_limit", "selected skill packages exceed the launch resource budget");
    }
    output[id] = { id, files };
  }
  return output;
}

export async function readSkillPackage(
  skillRoot: string,
  skillId: string,
): Promise<Record<string, PinnedSkillFile>> {
  const output: Record<string, PinnedSkillFile> = Object.create(null) as Record<
    string,
    PinnedSkillFile
  >;
  const walk = async (directory: string, segments: string[]): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (
        entry.name.length === 0 ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("\u0000") ||
        entry.name.includes("/") ||
        entry.name.includes("\\")
      )
        fail("skill_path", `skill ${skillId} contains an unsafe resource name`);
      const source = path.join(directory, entry.name);
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink())
        fail("skill_symlink", `skill ${skillId} contains a symbolic link`);
      if (metadata.isDirectory()) {
        await walk(source, [...segments, entry.name]);
        continue;
      }
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_SKILL_FILE_BYTES) {
        fail(
          "skill_file",
          `skill ${skillId} contains an empty, oversized, or non-regular resource`,
        );
      }
      const canonical = await realpath(source);
      if (!isWithinDirectory(skillRoot, canonical))
        fail("skill_escape", `skill ${skillId} resource escapes its package`);
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
          fail("skill_race", `skill ${skillId} changed while it was pinned`);
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (bytes.byteLength !== metadata.size)
        fail("skill_race", `skill ${skillId} changed while it was pinned`);
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes) || content.includes("\u0000")) {
        fail("skill_encoding", `skill ${skillId} resources must be non-NUL UTF-8 text`);
      }
      const relativePath = normalizeResourcePath([...segments, entry.name].join("/"));
      output[relativePath] = {
        relativePath,
        content,
        sha256: rawSha256(content),
        sizeBytes: bytes.byteLength,
      };
    }
  };
  await walk(skillRoot, []);
  return output;
}

export function parseRunOverrides(
  value: JsonValue | undefined,
  configuration: CompiledConfiguration,
): {
  maxParallel?: number;
  questionPolicy?: "none" | "some" | "many";
  instructions?: string;
  workingSpecOwner?: string;
  agents: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
  roles: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
} {
  const output: {
    maxParallel?: number;
    questionPolicy?: "none" | "some" | "many";
    instructions?: string;
    workingSpecOwner?: string;
    agents: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
    roles: Record<string, { provider?: string; model?: string; thinkingLevel?: string }>;
  } = {
    agents: Object.create(null) as Record<
      string,
      { provider?: string; model?: string; thinkingLevel?: string }
    >,
    roles: Object.create(null) as Record<
      string,
      { provider?: string; model?: string; thinkingLevel?: string }
    >,
  };
  if (value === undefined || value === null) return output;
  const source = requiredRecord(value, "run overrides");
  assertAllowedFields(
    source,
    ["maxParallel", "questionPolicy", "instructions", "workingSpecOwner", "agents", "roles"],
    "run overrides",
  );
  if (source.maxParallel !== undefined) {
    if (!Number.isSafeInteger(source.maxParallel) || (source.maxParallel as number) < 1)
      fail("override_parallel", "maxParallel must be at least one");
    output.maxParallel = source.maxParallel as number;
  }
  if (source.questionPolicy !== undefined) {
    if (!["none", "some", "many"].includes(String(source.questionPolicy)))
      fail("override_questions", "questionPolicy must be none, some, or many");
    output.questionPolicy = source.questionPolicy as "none" | "some" | "many";
  }
  if (source.instructions !== undefined)
    output.instructions = boundedText(source.instructions, "run instructions", 1024 * 1024);
  if (source.workingSpecOwner !== undefined) {
    output.workingSpecOwner = requiredNonempty(
      source.workingSpecOwner,
      "working-spec owner override",
    );
  }
  if (source.roles !== undefined) {
    const roles = requiredRecord(source.roles, "role overrides");
    const configuredRoles = new Set(
      Object.values(configuration.registries.personas)
        .map((persona) => optionalString(persona.model_role))
        .filter((role): role is string => role !== undefined),
    );
    for (const [roleId, raw] of Object.entries(roles)) {
      if (!configuredRoles.has(roleId)) fail("override_role", `unknown override role ${roleId}`);
      output.roles[roleId] = parseAgentSelection(raw, `role override ${roleId}`, roleId);
    }
  }
  if (source.agents !== undefined) {
    const agents = requiredRecord(source.agents, "agent overrides");
    for (const [personaId, raw] of Object.entries(agents)) {
      if (configuration.registries.personas[personaId] === undefined)
        fail("override_persona", `unknown override persona ${personaId}`);
      output.agents[personaId] = parseAgentSelection(raw, `agent override ${personaId}`, personaId);
    }
  }
  return output;
}

export function parseAgentSelection(
  value: unknown,
  label: string,
  identity: string,
): { provider?: string; model?: string; thinkingLevel?: string } {
  const item = requiredRecord(value, label);
  assertAllowedFields(item, ["provider", "model", "thinkingLevel"], label);
  const selected: { provider?: string; model?: string; thinkingLevel?: string } = {};
  if (item.provider !== undefined)
    selected.provider = boundedText(item.provider, `${identity} provider`, 256);
  if (item.model !== undefined) selected.model = boundedText(item.model, `${identity} model`, 512);
  if (item.thinkingLevel !== undefined) {
    selected.thinkingLevel = requireThinkingLevel(item.thinkingLevel, label);
  }
  return selected;
}

export function mergeAgentSelection(
  role: { provider?: string; model?: string; thinkingLevel?: string } | undefined,
  persona: { provider?: string; model?: string; thinkingLevel?: string } | undefined,
): { provider?: string; model?: string; thinkingLevel?: string } | undefined {
  if (role === undefined) return persona;
  if (persona === undefined) return role;
  return { ...role, ...persona };
}

export function resolveWorkingSpecOwner(
  configuration: CompiledConfiguration,
  runType: ConfigurationObject,
  explicitOverride: string | undefined,
): string {
  const runTypeOwner = optionalString(optionalRecord(runType.working_spec)?.owner);
  const changeControl = optionalRecord(configuration.profile.change_control);
  const profileOwner = optionalString(changeControl?.working_spec_owner);
  const explicit = [
    ...new Set(
      [explicitOverride, runTypeOwner, profileOwner].filter(
        (value): value is string => value !== undefined,
      ),
    ),
  ];
  if (explicit.length > 1) {
    fail(
      "working_spec_owner_ambiguous",
      "working-spec owner configuration resolves to conflicting personas",
    );
  }
  if (explicit.length === 1) {
    const owner = explicit[0]!;
    if (configuration.registries.personas[owner] === undefined) {
      fail(
        "working_spec_owner_invalid",
        `configured working-spec owner ${owner} is not exactly one managed persona`,
      );
    }
    return owner;
  }
  const leads = Object.entries(configuration.registries.personas)
    .filter(([, persona]) => optionalString(persona.model_role) === "lead")
    .map(([id]) => id)
    .sort(compareText);
  if (leads.length !== 1) {
    fail(
      "working_spec_owner_resolution",
      leads.length === 0
        ? "run creation requires exactly one managed persona with model_role lead"
        : `run creation found multiple managed lead personas: ${leads.join(", ")}`,
    );
  }
  return leads[0]!;
}

export function pipelineDefinition(document: ConfigurationObject): {
  order: string[];
  stages: ConfigurationObject;
} {
  const pipeline = requiredRecord(document.pipeline, "run pipeline");
  const stages = requiredRecord(pipeline.stages, "run pipeline stages");
  if (!Array.isArray(pipeline.order) || pipeline.order.length === 0)
    fail("pipeline_order", "run pipeline order is empty or invalid");
  const order = pipeline.order.map((item) => requiredNonempty(item, "pipeline stage id"));
  if (new Set(order).size !== order.length)
    fail("pipeline_order", "run pipeline contains duplicate stages");
  for (const id of order)
    if (!isRecord(stages[id])) fail("pipeline_stage", `run pipeline stage ${id} is missing`);
  return { order, stages: stages as ConfigurationObject };
}

export function projectPipelineDefinition(pipeline: {
  order: string[];
  stages: ConfigurationObject;
}): RunPipelineStageDefinition[] {
  return pipeline.order.map((id) => {
    const stage = requiredRecord(pipeline.stages[id], `pipeline stage ${id}`);
    const config = optionalRecord(stage.config);
    const kind = optionalString(stage.kind) ?? "unknown";
    return {
      id,
      title: optionalString(stage.title) ?? humanize(id),
      kind,
      automatic:
        config?.automatic === true ||
        config?.compiler_owned === true ||
        new Set([
          "initialize",
          "planning",
          "orchestration",
          "target_sync",
          "checkpoint",
          "agent_review",
        ]).has(kind),
    };
  });
}

export function projectCompiledPipelineDefinition(
  pipeline: readonly CompiledRunStage[],
): RunPipelineStageDefinition[] {
  const automaticallyDriven = new Set([
    "initialize",
    "planning",
    "orchestration",
    "target_sync",
    "checkpoint",
    "agent_review",
  ]);
  return pipeline.map((stage) => ({
    id: stage.id,
    title: stage.title,
    kind: stage.kind,
    automatic:
      stage.config.kind === "action"
        ? stage.config.automatic || stage.config.compilerOwned
        : automaticallyDriven.has(stage.kind),
  }));
}

export function pinnedLeadJudgmentBehavior(
  run: RunRecord,
  configuration: CompiledConfiguration,
): CompiledLeadJudgmentBehavior {
  return pinnedRunTypeBehavior(run, configuration).leadJudgment;
}

export function pinnedRunTypeBehavior(
  run: RunRecord,
  configuration: CompiledConfiguration,
): CompiledRunTypeBehavior {
  const compiledRunType = configuration.behavior.runTypes[run.runTypeId];
  if (compiledRunType === undefined) {
    fail("run_behavior", `pinned configuration has no behavior for run type ${run.runTypeId}`);
  }
  if (run.behavior !== undefined) {
    if (
      run.behavior.compiledBehaviorSha256 !== configuration.behavior.sha256 ||
      run.behavior.runType.id !== run.runTypeId ||
      run.behavior.runType.sha256 !== compiledRunType.sha256
    ) {
      fail("run_behavior_drift", "durable run behavior differs from the pinned configuration");
    }
    return run.behavior.runType;
  }
  // Imported pre-snapshot runs remain resumable from their complete immutable configuration
  // artifact. New runs always carry the smaller RunBehaviorSnapshot as well.
  return compiledRunType;
}

export function leadJudgmentStepId(trigger: LeadJudgmentTrigger): string {
  return trigger === "orchestration_entry" ? "lead-orchestration-entry" : "lead-compiler-deadlock";
}

export function leadTriggerForAttempt(
  attempt: Pick<AgentAttemptRecord, "stepId">,
): LeadJudgmentTrigger {
  if (attempt.stepId === "lead-orchestration-entry") return "orchestration_entry";
  if (attempt.stepId === "lead-compiler-deadlock") return "compiler_deadlock";
  fail("lead_trigger", `Lead attempt step ${attempt.stepId} does not encode a supported trigger`);
}

export function leadJudgmentAttempt(
  run: RunRecord,
  trigger: LeadJudgmentTrigger,
  behavior: CompiledLeadJudgmentBehavior,
  configuration: CompiledConfiguration,
): AttemptDescriptor {
  if (!behavior.triggers.includes(trigger)) {
    fail("lead_trigger", `Lead judgment behavior does not support trigger ${trigger}`);
  }
  const tickets = leadJudgmentTicketBoard(run).map((ticket) => {
    const newNodeAuthority = leadOperationNewNodeAuthority(configuration, ticket.operationId);
    return newNodeAuthority === undefined
      ? ticket
      : { ...ticket, scope: { ...ticket.scope, newNodeAuthority } };
  });
  const activeAttempts = Object.values(run.attempts)
    .filter((attempt) =>
      new Set<AttemptStatus>(["queued", "running", "waiting_question", "terminal_accepted"]).has(
        attempt.status,
      ),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .map((attempt) => ({
      id: attempt.id,
      ticketId: attempt.ticketId,
      stepId: attempt.stepId,
      personaId: attempt.personaId,
      status: attempt.status,
    }));
  const context = {
    protocol: "koni.attempt-context.v1",
    kind: "lead_judgment",
    trigger,
    judgment: {
      protocol: behavior.protocol,
      actionId: behavior.actionId,
      maxBoundariesPerAttempt: behavior.maxBoundariesPerAttempt,
    },
    run: {
      id: run.id,
      objective: run.objective,
      intake: run.intake,
      runTypeId: run.runTypeId,
      lifecycle: run.lifecycle.phase,
      pipelineStageId: run.currentPipelineStageId,
      graphRevision: run.graphRevision,
      graphHash: run.graphHash,
    },
    plan:
      run.plan === undefined
        ? undefined
        : {
            revision: run.plan.revision,
            status: run.plan.status,
            full: run.plan.full,
            concise: run.plan.concise,
          },
    questionPolicy:
      run.executionConfig?.semanticQuestionPolicy ??
      semanticQuestionPolicy(run.executionConfig?.questionPolicy ?? "some"),
    questionDefaultScope: run.executionConfig?.questionDefaultScope ?? "run",
    resolvedQuestions: answeredQuestionContext(run),
    unresolvedQuestions: Object.values(run.questions)
      .filter((question) => question.answeredAt === undefined)
      .sort((left, right) => compareText(left.id, right.id))
      .map((question) => ({
        id: question.id,
        scope: question.scope,
        ticketId: question.ticketId,
        prompt: question.prompt,
      })),
    ticketBoard: tickets,
    activeAttempts,
    requiredOutput: {
      protocol: behavior.terminal.protocol,
      disposition: behavior.terminal.dispositions,
      summary: "One concise, evidence-based readiness or blocker summary.",
    },
  };
  return {
    ticketId: "run-orchestration",
    stepId: leadJudgmentStepId(trigger),
    personaId: behavior.personaId,
    readPaths: [],
    writePaths: [],
    readNodeIds: [],
    writeNodeIds: [],
    graphMutation: "forbidden",
    initialPrompt: [
      behavior.prompt.trim(),
      trigger === "orchestration_entry"
        ? "Judge whether the approved run is ready to enter deterministic ticket orchestration."
        : "Judge the supplied compiler deadlock once; do not schedule, retry, poll, or mutate work.",
      "For dependency readiness, use the compiler-projected ticketBoard fields: only waitingOnDependencyIds establishes a current dependency wait; settledDependencyIds remains causal history and does not require a completed ticket status.",
      "When ticketBoard.scope.newNodeAuthority is present, it is compiler-issued creation authority distinct from existing-node write IDs. A missing node of a listed type is not by itself an authority gap; the eventual assignment remains constrained by its exact step and mutation contract.",
      "Judge a queued recovery or repair ticket from its own current objective, dependencies, and authority. A blocked source is the input to that closure path, not proof that the current recovery or repair ticket is unreachable.",
      "Treat each nonterminal ticket in the current ticketBoard as a compiler-derived current obligation. Do not infer that it is stale or redundant merely because a completed or cancelled ticket overlaps its target or scope.",
      `Finish with exactly one ${LEAD_JUDGMENT_OUTPUT_PROTOCOL} output: disposition proceed or blocked, plus a concise summary.`,
    ].join("\n\n"),
    context,
    terminalSchema: leadJudgmentTerminalSchema(),
    toolProfile: "lead_judgment",
  };
}

export function leadOperationNewNodeAuthority(
  configuration: CompiledConfiguration,
  operationId: string,
): { maxNewNodes: number; nodeTypes: string[] } | undefined {
  const operation = configuration.registries.operations[operationId];
  const maxNewNodes = optionalSafeInteger(operation?.max_new_nodes) ?? 0;
  const configuredTypes = operation?.allowed_new_node_types;
  if (maxNewNodes <= 0 || !Array.isArray(configuredTypes)) return undefined;
  const nodeTypes = [
    ...new Set(configuredTypes.filter((value): value is string => typeof value === "string")),
  ].sort(compareText);
  return nodeTypes.length === 0 ? undefined : { maxNewNodes, nodeTypes };
}

export function planningAttempt(
  run: RunRecord,
  runType: ConfigurationObject,
  configuration: CompiledConfiguration,
  revisionContext?: PlanningRevisionPreparationContext,
): AttemptDescriptor {
  const pipeline = pipelineDefinition(runType);
  const planning = pipeline.order.flatMap((id) => {
    const stage = requiredRecord(pipeline.stages[id], `pipeline stage ${id}`);
    if (stage.kind !== "planning") return [];
    const config = optionalRecord(stage.config) ?? {};
    return [
      {
        id,
        title: optionalString(stage.title) ?? id,
        persona: optionalString(config.agent) ?? "run-planner",
        prompt:
          optionalString(config.prompt) ?? "Produce the implementation-ready plan for this stage.",
      },
    ];
  });
  if (planning.length === 0) {
    fail(
      "planning_stage_missing",
      "this run type has no planning stage; the authority must use its direct-approval fast path",
    );
  }
  const personas = new Set(planning.map((stage) => stage.persona));
  if (personas.size !== 1)
    fail("planning_persona", "one managed planning session cannot impersonate multiple personas");
  const stageId = planning.at(-1)!.id;
  const graphSeedContract = planningGraphSeedContract(configuration);
  const latestSteering = run.plan?.steeringHistory.at(-1)?.instructions;
  const laterRevision =
    revisionContext?.binding.revision === undefined
      ? undefined
      : revisionContext.binding.revision > 0
        ? revisionContext
        : undefined;
  if (
    laterRevision !== undefined &&
    (laterRevision.currentArtifact === undefined || laterRevision.steering === undefined)
  ) {
    fail(
      "planning_revision_context",
      "later planning revision is missing its validated artifact or exact steering",
    );
  }
  const resolvedQuestions = answeredQuestionContext(run);
  const context = {
    protocol: "koni.attempt-context.v1",
    kind: "planning",
    run: { id: run.id, objective: run.objective, intake: run.intake, runTypeId: run.runTypeId },
    questionPolicy: run.executionConfig?.questionPolicy ?? "some",
    resolvedQuestions,
    stages: planning,
    instructions: run.executionConfig?.instructions ?? "",
    requiredOutput:
      laterRevision === undefined
        ? {
            title: "One 3-4 word operator-facing run name (3-60 characters).",
            full: PLAN_DOMAINS,
            concise: "Each domain is an independently authored list of {title, description} items.",
            graphSeed: graphSeedContract.context,
          }
        : {
            kind: "bounded_patch",
            baseRevision: laterRevision.binding.baseRevision,
            baseArtifactSha256: laterRevision.binding.priorCheckpointSha256,
            editableDomains: PLAN_DOMAINS,
            graphSeedOperations: [
              "setRootSpec",
              "removeRootSpecFields",
              "upsertNodes",
              "removeNodeKeys",
              "addEdges",
              "removeEdges",
            ],
          },
    ...(laterRevision === undefined
      ? {}
      : {
          currentValidatedArtifact: laterRevision.currentArtifact,
          planningRevision: laterRevision.binding,
          steering: laterRevision.steering,
        }),
  };
  return {
    ticketId: "run-planning",
    stepId: stageId,
    personaId: planning[0]!.persona,
    readPaths: ["."],
    writePaths: [],
    readNodeIds: [],
    writeNodeIds: [],
    graphMutation: "forbidden",
    initialPrompt:
      laterRevision === undefined
        ? [
            latestSteering === undefined
              ? `Plan this ${run.runTypeId} run: ${run.objective}`
              : [
                  `Revise the prior ${run.runTypeId} plan for this unchanged objective: ${run.objective}`,
                  "The prior accepted planning transcript is your starting point. Apply the operator steering exactly, preserve every unaffected sound decision, and do not repeat repository discovery unless one specific steering consequence cannot be resolved from retained evidence.",
                  `Operator steering for this revision:\n${latestSteering}`,
                ].join("\n\n"),
            "Complete every configured planning concern in one bounded shared session.",
            PLANNING_TERMINAL_INSTRUCTION,
            "The koni_submit_output arguments must contain four complete Markdown plans (architecture, decisions, risk, verification), four separately written concise title/description item lists for human approval, and the exact typed graph seed. Do not derive mini-plan headings by truncating the full prose.",
            'Required top-level shape (illustrative only; replace every ... with schema-valid content): {"title":"...","full":{"architecture":"...","decisions":"...","risk":"...","verification":"..."},"concise":{"architecture":[{"title":"...","description":"..."}],"decisions":[...],"risk":[...],"verification":[...]},"graphSeed":{"rootSpec":{...},"nodes":[...],"edges":[...]}}. All four full domains, all four concise domains, and graphSeed are required in the same first submission.',
            "After any validation error, correct every named field before retrying; never resubmit the same incomplete shape.",
            'Also emit a top-level "title": a concise 3-4 word name for this run, suitable as an operator dashboard row label. Do not restate the full objective.',
            "For graphSeed, reference the already-existing run objective only with the literal $root. rootSpec enriches that objective and never declares a node key. Every other edge endpoint must exactly equal a key declared in nodes; connect every declared node to $root and never invent a root alias from the objective title.",
          ].join("\n\n")
        : [
            "Continue this planning session. Apply the operator steering to the current compiler-valid plan.",
            PLANNING_TERMINAL_INSTRUCTION,
            "Preserve unchanged domains and graph elements. Submit only the bounded patch against the named base revision and artifact hash.",
            `Base revision: ${laterRevision.binding.baseRevision}\nBase artifact hash: ${laterRevision.binding.priorCheckpointSha256}`,
            `Operator steering for revision ${laterRevision.binding.revision}:\n${laterRevision.steering}`,
            `Resolved planning questions:\n${JSON.stringify(resolvedQuestions)}`,
            `Current compiler-valid planning artifact:\n${JSON.stringify(laterRevision.currentArtifact)}`,
            "Use the planning patch schema. Include only changed title, plan domains, concise review domains, or semantic graph operations. The compiler will preserve every omitted field and revalidate the complete materialized artifact.",
            "Within a patch, graphSeed may contain only setRootSpec, removeRootSpecFields, upsertNodes, removeNodeKeys, addEdges, and removeEdges. Never send the initial nodes/edges seed shape. Never add an unchanged edge again; use addEdges and removeEdges only for relations that actually change. Every newly upserted node key must either already exist or connect through addEdges to the retained graph in the same patch.",
          ].join("\n\n"),
    context,
    terminalSchema:
      laterRevision === undefined
        ? planningTerminalSchema(graphSeedContract.schema)
        : planningPatchTerminalSchema(),
  };
}

export function resolvePinnedGateAutoEvaluationContexts(input: {
  configuration: CompiledConfiguration;
  descriptorBoundary: "full" | "scoped";
  /** Ticket operation of the compiling descriptor; gate checks that do not apply to it are skipped. */
  operation?: string;
  subjectNodeIds: readonly string[];
  /** Gate nodes this descriptor is accountable for (target/write scope), when it has any. */
  ownedNodeIds?: readonly string[];
  contexts: readonly CompiledGatePolicyContext[];
}): ResolvedGateAutoEvaluationContextBinding[] {
  const projected = requireValidation(
    projectGatePolicyDefinitions(input.configuration),
    "gate_policy_invalid",
    "pinned gate policies did not compile",
  );
  const definitions = new Map(projected.map((policy) => [policy.id, policy] as const));
  const subjectIds = new Set(input.subjectNodeIds);
  const output: ResolvedGateAutoEvaluationContextBinding[] = [];
  const ownedIds = new Set(input.ownedNodeIds ?? []);
  const ownedGateBindings = new Set<ResolvedGateAutoEvaluationContextBinding>();
  for (const context of input.contexts) {
    if (canonicalHash(withoutField(context, "context_sha256")) !== context.context_sha256) {
      fail(
        "gate_policy_context_hash",
        `gate context ${context.gate_node_id} failed its compiler hash binding`,
      );
    }
    if (
      !subjectIds.has(context.gate_node_id) &&
      !context.evaluation_target_node_ids.some((id) => subjectIds.has(id))
    )
      continue;
    const rawPolicy = input.configuration.registries.gate_policies[context.policy_id];
    const definition = definitions.get(context.policy_id);
    if (
      rawPolicy === undefined ||
      definition === undefined ||
      definition.contractSha256 !== context.policy_contract_sha256
    ) {
      fail(
        "gate_policy_context_drift",
        `gate context ${context.context_sha256} differs from its pinned policy`,
      );
    }
    if (rawPolicy.auto_evaluate === undefined) continue;
    const auto = requiredRecord(
      rawPolicy.auto_evaluate,
      `gate policy ${context.policy_id} auto_evaluate`,
    );
    assertExactFields(
      auto,
      ["check", "boundaries"],
      `gate policy ${context.policy_id} auto_evaluate`,
    );
    const checkId = requiredNonempty(
      auto.check,
      `gate policy ${context.policy_id} auto-evaluate check`,
    );
    const boundaries = stringArray(
      auto.boundaries,
      `gate policy ${context.policy_id} auto-evaluate boundaries`,
    );
    if (
      new Set(boundaries).size !== boundaries.length ||
      boundaries.some((boundary) => boundary !== "full" && boundary !== "scoped")
    ) {
      fail(
        "gate_policy_auto_boundary",
        `gate policy ${context.policy_id} declares an invalid auto-evaluate boundary`,
      );
    }
    if (!boundaries.includes(input.descriptorBoundary)) continue;
    const checkDefinition = input.configuration.registries.checks[checkId];
    if (checkDefinition === undefined) {
      fail(
        "gate_policy_auto_check",
        `gate policy ${context.policy_id} references missing check ${checkId}`,
      );
    }
    // A gate auto-evaluation is an obligation of the operations its check applies to. A ticket
    // that merely reads or links the gate node (e.g. experiment design touching a gate) must not
    // fail its launch compile over it — the gate evaluates under its own applicable operation.
    const applies = stringArray(checkDefinition.applies_to, `${checkId} applies_to`);
    if (input.operation !== undefined && applies.length > 0 && !applies.includes(input.operation))
      continue;
    const material = {
      policyId: context.policy_id,
      policyContractSha256: context.policy_contract_sha256,
      checkId,
      boundary: input.descriptorBoundary,
      gateNodeId: context.gate_node_id,
      contextSha256: context.context_sha256,
      readPaths: Object.freeze([...new Set(context.read_paths)].sort(compareText)),
    } as const;
    const binding = deepFreeze({ ...material, sha256: canonicalHash(material) });
    output.push(binding);
    if (ownedIds.has(context.gate_node_id)) ownedGateBindings.add(binding);
  }
  // Sibling gates share an evaluation target, so a gate node reachable only through that shared
  // target rides along with the gate the ticket actually owns. Two contexts then declare the same
  // auto-evaluate check id, and the step's bare `validation_checks` entry can no longer name one
  // of them, which fails the entire check plan. When the ticket names gates outright those are its
  // obligation; a context matched only via a shared evaluation target belongs to its own gate's
  // ticket and is dropped here.
  const selected =
    ownedGateBindings.size > 0 ? output.filter((b) => ownedGateBindings.has(b)) : output;
  return selected.sort((left, right) =>
    compareText(`${left.policyId}\0${left.gateNodeId}`, `${right.policyId}\0${right.gateNodeId}`),
  );
}

export function portfolioGuidancePrompt(binding: ExecutionPolicyBinding): string {
  const guidance = binding.context.portfolioGuidance?.value;
  if (guidance === undefined) return "";
  return [
    `Portfolio guidance: prefer ${guidance.preferredCount} ${guidance.unit}.`,
    `Group when ${guidance.groupWhen}.`,
    `Split when ${guidance.splitWhen}.`,
    `Avoid ${guidance.avoid}.`,
  ].join(" ");
}

export function orderedReviewPredecessorStepIds(
  workflow: readonly Pick<DerivedWorkflowStep, "id" | "depends_on">[],
  reviewStep: Pick<DerivedWorkflowStep, "id" | "depends_on">,
): string[] {
  const byId = new Map(workflow.map((step) => [step.id, step]));
  const closure = new Set<string>();
  const visit = (stepId: string): void => {
    if (closure.has(stepId)) return;
    if (stepId === reviewStep.id) {
      fail("review_evidence_cycle", `review step ${reviewStep.id} depends on itself`);
    }
    const step = byId.get(stepId);
    if (step === undefined) {
      fail(
        "review_evidence_step",
        `review predecessor ${stepId} is absent from the compiled workflow`,
      );
    }
    for (const dependencyId of step.depends_on) visit(dependencyId);
    closure.add(stepId);
  };
  for (const predecessorStepId of reviewStep.depends_on) visit(predecessorStepId);
  return workflow.filter((step) => closure.has(step.id)).map((step) => step.id);
}

/** Every dependent step needs the exact accepted outputs that causally precede it. */
export function shouldAttachPredecessorExecution(
  step: Pick<DerivedWorkflowStep, "kind" | "depends_on">,
): boolean {
  return step.kind === "review" || step.depends_on.length > 0;
}

export interface ApprovedChangeObligationContext {
  readonly ticketId: string;
  readonly approvedApplicationSha256: Sha256Digest;
  readonly targetNodeIds: readonly string[];
  readonly summary: string;
  /** Reviewed structured application selection; request/reason diagnostic text is excluded. */
  readonly selectionSummary?: string;
  /** Selected proposal result only; aggregate request/reason text is contextual, not value authority. */
  readonly proposalResultSummary?: string;
  /** The application delta is accepted but its control workflow has not settled yet. */
  readonly inFlight?: true;
  readonly operatorSteering?: readonly string[];
  /** Later applications in the same authenticated source-correction lineage on shared targets. */
  readonly laterSourceCorrections?: readonly Readonly<{
    ticketId: string;
    approvedApplicationSha256: Sha256Digest;
    targetNodeIds: readonly string[];
    summary: string;
    /** Reviewed structured application selection; request/reason diagnostic text is excluded. */
    selectionSummary?: string;
    /** Selected proposal result only; request/reason diagnostic text is never value authority. */
    proposalResultSummary?: string;
  }>[];
}

export function approvedChangeValueAuthoritySummaries(
  authority: Pick<
    ApprovedChangeObligationContext,
    "summary" | "selectionSummary" | "proposalResultSummary"
  >,
): readonly string[] {
  const selected = [authority.selectionSummary, authority.proposalResultSummary].flatMap(
    (summary) => {
      const normalized = summary?.trim();
      return normalized === undefined || normalized.length === 0 ? [] : [normalized];
    },
  );
  return selected.length === 0 ? [authority.summary] : [...new Set(selected)];
}

export function approvedApplicationObligationSummary(
  run: Pick<RunRecord, "tickets">,
  ticket: Readonly<TicketRecord>,
): string | undefined {
  const request = approvedApplicationRequestContext(run, ticket);
  if (request === undefined) return undefined;
  const proposalResult =
    request.materialization.proposalTerminalProof.semanticResult.summary?.trim();
  return [
    `Approved request (${request.publication.requestSha256}): ${request.publication.summary}`,
    `Recorded reason: ${request.publication.reason}`,
    `Reviewed application selection: ${request.materialization.selectionSummary}`,
    ...(proposalResult === undefined || proposalResult.length === 0
      ? []
      : [`Hash-bound proposal result: ${proposalResult}`]),
  ].join("\n");
}

export function applicationForSourceProposal(
  run: Pick<RunRecord, "tickets">,
  sourceTicketId: string,
  proposalTicketId: string,
): Readonly<TicketRecord> | undefined {
  const proposal = run.tickets[proposalTicketId];
  const request = proposal?.executionControl?.proposalRequest;
  const disposition = proposal?.executionControl?.proposalDisposition;
  const applicationId =
    disposition?.kind === "application" ? disposition.applicationTicketId : undefined;
  const application = applicationId === undefined ? undefined : run.tickets[applicationId];
  if (
    proposal?.status !== "completed" ||
    request?.sourceTicketId !== sourceTicketId ||
    application === undefined ||
    application.executionControl?.controlTicketAuthority?.role !== "approved_application" ||
    application.executionControl?.sourceProposalTicketId !== proposalTicketId ||
    application.executionControl.approvedApplicationSha256 !== disposition?.authoritySha256
  ) {
    return undefined;
  }
  return application;
}

/** Later source-correction applications may replace values only on their shared target nodes. */
export function laterSourceCorrectionApplications(
  run: Pick<RunRecord, "tickets">,
): ReadonlyMap<string, readonly Readonly<TicketRecord>[]> {
  const laterByApplicationId = new Map<string, TicketRecord[]>();
  for (const source of Object.values(run.tickets)) {
    const lineage = (source.executionControl?.sourceCorrectionSeeds ?? []).flatMap((seed) => {
      if (seed.route !== "approved_application") return [];
      const proposal = run.tickets[seed.proposalTicketId];
      if (proposal?.executionControl?.proposalRequest?.requestSha256 !== seed.requestSha256) {
        return [];
      }
      const application = applicationForSourceProposal(run, source.id, seed.proposalTicketId);
      return application?.status === "completed" ? [application] : [];
    });
    const hold = source.executionControl?.sourceHold;
    if (hold !== undefined) {
      const proposal = run.tickets[hold.proposalTicketId];
      if (proposal?.executionControl?.proposalRequest?.requestSha256 === hold.requestSha256) {
        const application = applicationForSourceProposal(run, source.id, hold.proposalTicketId);
        if (
          application !== undefined &&
          application.status !== "proposed" &&
          application.status !== "cancelled" &&
          !lineage.some((candidate) => candidate.id === application.id)
        ) {
          lineage.push(application);
        }
      }
    }
    for (let index = 0; index < lineage.length; index += 1) {
      const application = lineage[index]!;
      const targets = new Set(application.targetNodeIds);
      for (let laterIndex = index + 1; laterIndex < lineage.length; laterIndex += 1) {
        const later = lineage[laterIndex]!;
        if (!later.targetNodeIds.some((nodeId) => targets.has(nodeId))) continue;
        const successors = laterByApplicationId.get(application.id) ?? [];
        if (!successors.some((candidate) => candidate.id === later.id)) successors.push(later);
        laterByApplicationId.set(application.id, successors);
      }
    }
  }
  return laterByApplicationId;
}

/** Preserve an approved semantic obligation after its control ticket has settled. */
export function approvedChangeObligationsForTargets(
  run: Pick<RunRecord, "tickets">,
  targetNodeIds: readonly string[],
): ApprovedChangeObligationContext[] {
  const targets = new Set(targetNodeIds);
  const laterByApplicationId = laterSourceCorrectionApplications(run);
  const obligations = Object.values(run.tickets)
    .filter(
      (ticket) =>
        ticket.status === "completed" &&
        ticket.executionControl?.controlTicketAuthority?.role === "approved_application" &&
        ticket.executionControl.approvedApplicationSha256 !== undefined &&
        ticket.targetNodeIds.some((nodeId) => targets.has(nodeId)),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .flatMap((ticket) => {
      const summary = approvedApplicationObligationSummary(run, ticket) ?? ticket.summary.trim();
      if (summary.length === 0) return [];
      const proposalResultSummary = approvedApplicationRequestContext(
        run,
        ticket,
      )?.materialization.proposalTerminalProof.semanticResult.summary?.trim();
      const selectionSummary = approvedApplicationRequestContext(
        run,
        ticket,
      )?.materialization.selectionSummary.trim();
      const laterSourceCorrections = (laterByApplicationId.get(ticket.id) ?? []).flatMap(
        (later) => {
          const laterSummary =
            approvedApplicationObligationSummary(run, later) ?? later.summary.trim();
          const proposalResultSummary = approvedApplicationRequestContext(
            run,
            later,
          )?.materialization.proposalTerminalProof.semanticResult.summary?.trim();
          const selectionSummary = approvedApplicationRequestContext(
            run,
            later,
          )?.materialization.selectionSummary.trim();
          const authoritySha256 = later.executionControl?.approvedApplicationSha256;
          return authoritySha256 === undefined || laterSummary.length === 0
            ? []
            : [
                {
                  ticketId: later.id,
                  approvedApplicationSha256: authoritySha256,
                  targetNodeIds: [...later.targetNodeIds],
                  summary: laterSummary,
                  ...(selectionSummary === undefined || selectionSummary.length === 0
                    ? {}
                    : { selectionSummary }),
                  ...(proposalResultSummary === undefined || proposalResultSummary.length === 0
                    ? {}
                    : { proposalResultSummary }),
                },
              ];
        },
      );
      return [
        {
          ticketId: ticket.id,
          approvedApplicationSha256: ticket.executionControl!.approvedApplicationSha256!,
          targetNodeIds: [...ticket.targetNodeIds],
          summary,
          ...(selectionSummary === undefined || selectionSummary.length === 0
            ? {}
            : { selectionSummary }),
          ...(proposalResultSummary === undefined || proposalResultSummary.length === 0
            ? {}
            : { proposalResultSummary }),
          ...(laterSourceCorrections.length === 0 ? {} : { laterSourceCorrections }),
        },
      ];
    });
  const remaining = new Map(obligations.map((obligation) => [obligation.ticketId, obligation]));
  const ordered: ApprovedChangeObligationContext[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(
        (candidate) =>
          ![...remaining.values()].some((predecessor) =>
            predecessor.laterSourceCorrections?.some(
              (later) => later.ticketId === candidate.ticketId,
            ),
          ),
      )
      .sort((left, right) => compareText(left.ticketId, right.ticketId));
    const next =
      ready[0] ??
      [...remaining.values()].sort((left, right) => compareText(left.ticketId, right.ticketId))[0]!;
    ordered.push(next);
    remaining.delete(next.ticketId);
  }
  return ordered;
}

/** Control proposals authorize later work; they do not themselves inherit settled application work. */
export function approvedChangeObligationsForAttempt(
  run: Pick<RunRecord, "tickets">,
  targetNodeIds: readonly string[],
  operationRole: CompiledChangeControl["role"],
): ApprovedChangeObligationContext[] {
  if (operationRole === "proposal") return [];
  const settled = approvedChangeObligationsForTargets(run, targetNodeIds);
  if (operationRole !== "ordinary") return settled;
  const targets = new Set(targetNodeIds);
  const inFlight = Object.values(run.tickets)
    .filter(
      (ticket) =>
        ticket.status !== "completed" &&
        ticket.executionControl?.controlTicketAuthority?.role === "approved_application" &&
        ticket.executionControl.approvedApplicationSha256 !== undefined &&
        ticket.targetNodeIds.some((nodeId) => targets.has(nodeId)),
    )
    .sort((left, right) => compareText(left.id, right.id))
    .flatMap((ticket) => {
      const sourceProposalId = ticket.executionControl?.sourceProposalTicketId;
      const sourceProposal =
        sourceProposalId === undefined ? undefined : run.tickets[sourceProposalId];
      const summary = approvedApplicationObligationSummary(run, ticket);
      const legacySummary = sourceProposal?.summary.trim() || ticket.summary.trim();
      const effectiveSummary = summary || legacySummary;
      if (effectiveSummary.length === 0) return [];
      const sourceControl = sourceProposal?.executionControl;
      const approvalSha256 = sourceControl?.proposalApprovalSha256;
      return [
        {
          ticketId: ticket.id,
          approvedApplicationSha256: ticket.executionControl!.approvedApplicationSha256!,
          targetNodeIds: [...ticket.targetNodeIds],
          summary: effectiveSummary,
          inFlight: true as const,
          ...(approvalSha256 === undefined
            ? {}
            : {
                operatorSteering: approvedProposalAuditSteering(
                  sourceControl?.proposalDecisionHistory ?? [],
                  approvalSha256,
                ),
              }),
        },
      ];
    });
  return [...settled, ...inFlight];
}

export function approvedChangeObligationInstructions(
  obligation: ApprovedChangeObligationContext,
  stepKind: DerivedWorkflowStep["kind"] = "production",
): string[] {
  const reviewBoundary =
    stepKind === "review"
      ? "Treat the complete approved request and operator steering as binding review criteria. If the current candidate does not satisfy them, reject it with a precise repair blocker so the compiler can reopen the source-owning implementation step. Do not edit files or graph nodes during independent review."
      : undefined;
  if (obligation.inFlight === true) {
    return [
      `In-flight approved-change obligation ${obligation.approvedApplicationSha256} from ${obligation.ticketId}: ${obligation.summary}`,
      ...(obligation.operatorSteering ?? []),
      ...(reviewBoundary === undefined
        ? [
            "The compiler is currently applying this exact approved request through the source-owning workflow. Treat its complete request and operator steering as binding input for the files and authored contract in this attempt; do not substitute repository neighbors, invent gate identities, or wait for the application control ticket to settle.",
          ]
        : [reviewBoundary]),
    ];
  }
  if ((obligation.laterSourceCorrections?.length ?? 0) > 0) {
    const later = obligation.laterSourceCorrections!;
    return [
      `Historical approved-change evidence ${obligation.approvedApplicationSha256} from ${obligation.ticketId}: ${obligation.summary}`,
      `Later compiler-authenticated source-correction applications on shared targets: ${later.map((correction) => `${correction.approvedApplicationSha256} from ${correction.ticketId}`).join(", ")}.`,
      "This historical obligation remains binding evidence, but do not treat an older exact value as current when the later correction directly replaces it on the same semantic field and target. Preserve every unaffected target, mechanism, relationship, input role, and outcome. A later target overlap alone does not erase this evidence.",
      ...(reviewBoundary === undefined
        ? [
            "Apply the newest explicit value for each directly replaced field. If the later correction does not explicitly replace a historical value, preserve that historical value or raise the smallest exact authority conflict; do not silently discard it.",
          ]
        : [reviewBoundary]),
    ];
  }
  return [
    `Durable approved-change obligation ${obligation.approvedApplicationSha256} from ${obligation.ticketId}: ${obligation.summary}`,
    "This authenticated obligation survives the completed control ticket. Before claiming it is satisfied, read every named target file available in this ticket's scope and compare the current argv element-by-element with the approved argv; omitted, reordered, or substituted secondary script arguments are material defects. Verify named implementation mechanisms literally (for example runpy versus subprocess) from file content, never from a filename or prior summary. Preserve its exact algorithms, argv shape, and bounded target semantics.",
    ...(reviewBoundary === undefined
      ? [
          "If the current graph or files do not satisfy it, repair them within this ticket's grant or raise the smallest upstream change request; do not silently substitute a different implementation.",
        ]
      : [reviewBoundary]),
  ];
}

/** Independent review observes a sealed candidate and can only return a typed verdict. */
export function effectiveAssignmentWriteScope(input: {
  readonly stepKind: DerivedWorkflowStep["kind"];
  readonly graphMutation: DerivedWorkflowStep["graph_mutation"];
  readonly writePaths: readonly string[];
  readonly writeNodeIds: readonly string[];
}): {
  graphMutation: DerivedWorkflowStep["graph_mutation"];
  writePaths: string[];
  writeNodeIds: string[];
} {
  if (input.stepKind === "review") {
    return { graphMutation: "forbidden", writePaths: [], writeNodeIds: [] };
  }
  return {
    graphMutation: input.graphMutation,
    writePaths: [...input.writePaths],
    writeNodeIds: [...input.writeNodeIds],
  };
}

/** Keep approved proposal selection and its independent review on their distinct stages. */
export function approvedProposalAttemptInstructions(input: {
  readonly approved: boolean;
  readonly proposalStepId: string | undefined;
  readonly stepId: string;
  readonly stepKind: DerivedWorkflowStep["kind"];
  readonly applicationOperations: readonly string[];
}): string[] {
  if (!input.approved || input.proposalStepId === undefined) return [];
  if (input.stepId === input.proposalStepId) {
    return [
      "This proposal-selection step is intentionally read-only. Empty graph and repository write scopes, graph_mutation forbidden, and maxNewNodes 0 do not block selecting an authorized changeApplication: this step records the bounded selection, and the separately materialized application ticket performs any approved mutation with its own compiler-derived authority.",
      "For this approved proposal, submit the exact authorized changeApplication when the request remains unsatisfied. Do not select no-op while the approved request remains unsatisfied; no-op is allowed only when the requested state is already satisfied in the current scoped graph.",
      "The complete hash-bound approved request and reason are carried independently into every application attempt. Keep changeApplication.summary concise: identify the selected operation, targets, and only the smallest disambiguating interpretation needed for review. The summary does not replace or narrow the original request, so do not copy every authored value, identifier, path, command, binding, or relationship into this bounded field.",
      ...(input.applicationOperations.length === 0
        ? []
        : [
            `Use changeApplication.operation ${input.applicationOperations.map((operation) => `\"${operation}\"`).join(" or ")}; do not use the proposal operation name as an application operation.`,
          ]),
    ];
  }
  if (input.stepKind !== "review") return [];
  return [
    "This is a pre-application review of the predecessor changeApplication selection. Validate that the selection is exactly bound to the approved request, stays within its control scope, and chooses an authorized application operation. Do not reject the selection merely because the requested state is still unsatisfied: no application ticket can be materialized until this review approves. Do not demand that this read-only proposal ticket produce the requested files or post-application gate verdicts. Approve a correctly bounded selection so the compiler can materialize the separate application ticket; reject only a defect in the selection or its approval binding.",
  ];
}

/** Surface append-only post-approval messages without misrepresenting them as revocation. */
export function approvedProposalAuditSteering(
  history: NonNullable<TicketExecutionControlRecord["proposalDecisionHistory"]>,
  approvalSha256: Sha256Digest,
): string[] {
  const approvalIndex = history.findIndex((event) => event.sha256 === approvalSha256);
  if (approvalIndex < 0) return [];
  return history.slice(approvalIndex + 1).flatMap((event) => {
    const message = event.message?.trim();
    return message === undefined || message.length === 0
      ? []
      : [`Operator audit-only steering after approval (does not revoke approval): ${message}`];
  });
}

/** Preserve the operator's exact correction when a rejected proposal reissues its source. */
export function rejectedSourceProposalInstructions(
  run: Pick<RunRecord, "tickets">,
  sourceTicketId: string,
): string[] {
  const rejections = Object.values(run.tickets)
    .filter((ticket) => {
      const control = ticket.executionControl;
      return (
        control?.proposalRequest?.sourceTicketId === sourceTicketId &&
        control.proposalDecision?.decision === "rejection" &&
        control.proposalDisposition?.kind === "rejected"
      );
    })
    .sort((left, right) => {
      const leftDecision = left.executionControl!.proposalDecision!;
      const rightDecision = right.executionControl!.proposalDecision!;
      return (
        leftDecision.recordedAt.localeCompare(rightDecision.recordedAt) ||
        compareText(left.id, right.id)
      );
    });
  if (rejections.length === 0) return [];
  return [
    ...rejections.map((ticket) => {
      const control = ticket.executionControl!;
      const request = control.proposalRequest!;
      const decision = control.proposalDecision!;
      return `Operator rejection ${decision.sha256} for prior upstream request ${ticket.id} (${request.requestSha256}): ${decision.message}`;
    }),
    "Treat that rejection as binding corrective evidence. Do not repeat the rejected upstream request from older diagnostics unless new compiler-authenticated evidence recorded after the rejection contradicts it; continue the source workflow under the operator's correction.",
  ];
}

export function exhaustedSourceProposalContexts(
  run: Pick<RunRecord, "tickets">,
  sourceTicketId: string,
) {
  return Object.values(run.tickets)
    .flatMap((ticket) => {
      const control = ticket.executionControl;
      const proof = control?.proposalReviewExhaustion;
      const authority = control?.controlTicketAuthority;
      const request = control?.proposalRequest;
      if (
        proof === undefined ||
        request?.sourceTicketId !== sourceTicketId ||
        authority?.role !== "proposal" ||
        authority.causal.role !== "proposal" ||
        authority.causal.publication.requestSha256 !== request.requestSha256 ||
        ticket.blocker === undefined
      ) {
        return [];
      }
      return [
        {
          proposalTicketId: ticket.id,
          proof: structuredClone(proof),
          request: structuredClone(authority.causal.publication),
          blocker: ticket.blocker,
        },
      ];
    })
    .sort((left, right) => compareText(left.proposalTicketId, right.proposalTicketId));
}

/** Preserve exact compiler-authenticated proposal-review findings on the reissued source. */
export function exhaustedSourceProposalInstructions(
  run: Pick<RunRecord, "tickets">,
  sourceTicketId: string,
): string[] {
  const contexts = exhaustedSourceProposalContexts(run, sourceTicketId);
  if (contexts.length === 0) return [];
  return [
    ...contexts.map(
      ({ proposalTicketId, proof, request, blocker }) =>
        `Compiler review exhaustion ${proof.sha256} returned upstream request ${proposalTicketId} (${request.requestSha256}) to this source. Original required state: ${request.summary}\n\nRecorded reason: ${request.reason}\n\nIndependent review blocker: ${blocker}`,
    ),
    "Treat each exhausted review as binding corrective evidence for the replacement request. Preserve valid candidate work, correct every named inconsistency in the source-authored request, and do not reissue the same contradictory or incomplete authority.",
  ];
}

/** The materialized application inherits every append-only clarification on its source approval. */
export function approvedApplicationAuditSteering(
  run: Pick<RunRecord, "tickets">,
  application: Pick<TicketRecord, "executionControl">,
): string[] {
  const sourceProposalTicketId = application.executionControl?.sourceProposalTicketId;
  if (sourceProposalTicketId === undefined) return [];
  const sourceControl = run.tickets[sourceProposalTicketId]?.executionControl;
  const approvalSha256 = sourceControl?.proposalApprovalSha256;
  if (approvalSha256 === undefined) return [];
  return approvedProposalAuditSteering(
    sourceControl?.proposalDecisionHistory ?? [],
    approvalSha256,
  );
}

/** Keep a graph-only application review from duplicating the source workflow's file review. */
export function approvedApplicationGraphOnlyReviewInstruction(input: {
  readonly operationRole: CompiledChangeControl["role"];
  readonly stepKind: DerivedWorkflowStep["kind"];
  readonly readPaths: readonly string[];
}): string | undefined {
  if (
    input.operationRole !== "application" ||
    input.stepKind !== "review" ||
    input.readPaths.length !== 0
  ) {
    return undefined;
  }
  return [
    "This is a graph-only application review: judge the exact scoped semantic delta and the ordered cumulative operator steering.",
    "The source-owning filesystem workflow independently reviews candidate bytes and publishes the compiler-owned asset manifest.",
    "Past diagnostic prose reports the state observed when it was recorded; it is not proof that inaccessible file bytes remain unchanged after a later source workflow or follow-up audit.",
    "Do not reject this graph application solely for alleged file contents you have no read grant to inspect, and do not demand duplicate filesystem proof from this control ticket.",
    "Do reject a graph defect, a missing route to the source-owning workflow, or a current scoped graph state that contradicts the latest cumulative steering.",
  ].join(" ");
}

/** A later run-plan ticket may not silently contradict an exact approved argv. */
export function assertApprovedChangeRuntimeObligations(
  run: Pick<RunRecord, "tickets">,
  graph: Pick<TypedGraph, "node">,
  writableNodeIds: readonly string[],
): void {
  const writable = new Set(writableNodeIds);
  const obligations = approvedChangeObligationsForTargets(run, writableNodeIds);
  for (const obligation of obligations) {
    const commandPattern = /([A-Za-z0-9][A-Za-z0-9._:-]*)\s*\(command=\[([^\]]*)\]\)/gu;
    const commandMatches = approvedChangeValueAuthoritySummaries(obligation).flatMap((summary) => [
      ...summary.matchAll(commandPattern),
    ]);
    for (const match of commandMatches) {
      const nodeId = match[1]!;
      if (!writable.has(nodeId) || !obligation.targetNodeIds.includes(nodeId)) continue;
      const node = graph.node(nodeId);
      if (node?.type !== "run") continue;
      let effectiveAuthority: Pick<
        ApprovedChangeObligationContext,
        "ticketId" | "targetNodeIds" | "summary" | "selectionSummary" | "proposalResultSummary"
      > = obligation;
      let effectiveMatch = match;
      const sameNodeCorrections = (obligation.laterSourceCorrections ?? []).filter((correction) =>
        correction.targetNodeIds.includes(nodeId),
      );
      for (const correction of sameNodeCorrections) {
        const replacements = approvedChangeValueAuthoritySummaries(correction)
          .flatMap((summary) => [...summary.matchAll(commandPattern)])
          .filter((candidate) => candidate[1] === nodeId);
        const uniqueReplacements = [
          ...new Map(replacements.map((candidate) => [candidate[2]!, candidate])).values(),
        ];
        if (uniqueReplacements.length === 1) {
          effectiveAuthority = correction;
          effectiveMatch = uniqueReplacements[0]!;
        }
      }
      const entrypointAuthorityTargetIds = [
        ...new Set([
          ...obligation.targetNodeIds,
          ...sameNodeCorrections.flatMap((correction) => correction.targetNodeIds),
          ...obligations.flatMap((candidate) =>
            candidate.targetNodeIds.includes(nodeId) &&
            candidate.laterSourceCorrections?.some(
              (correction) => correction.ticketId === obligation.ticketId,
            )
              ? candidate.targetNodeIds
              : [],
          ),
        ]),
      ];
      const entrypoints = entrypointAuthorityTargetIds.flatMap((targetNodeId) => {
        const target = graph.node(targetNodeId);
        if (target?.type !== "asset") return [];
        const implementation = optionalRecord(target.spec.implementation);
        return stringArray(
          implementation?.entrypoints,
          `asset ${targetNodeId} implementation entrypoints`,
        );
      });
      const rawArgv = [...effectiveMatch[2]!.matchAll(/'([^']*)'|"([^"]*)"/gu)].map(
        (token) => token[1] ?? token[2]!,
      );
      if (rawArgv.length === 0) {
        fail(
          "approved_change_obligation",
          `approved change ${effectiveAuthority.ticketId} carries an unreadable command for ${nodeId}`,
        );
      }
      const expectedArgv = rawArgv.map((argument) => {
        if (!argument.startsWith(".../")) return argument;
        const suffix = argument.slice(3);
        const candidates = [
          ...new Set(entrypoints.filter((entrypoint) => entrypoint.endsWith(suffix))),
        ];
        if (candidates.length !== 1) {
          fail(
            "approved_change_obligation",
            `approved change ${effectiveAuthority.ticketId} cannot resolve ${argument} to one target asset entrypoint`,
          );
        }
        return candidates[0]!;
      });
      const contract = optionalRecord(node.spec.runtime_contract);
      const command = contract?.command;
      if (
        !Array.isArray(command) ||
        command.some((argument) => typeof argument !== "string" || argument.trim().length === 0)
      ) {
        fail(
          "approved_change_obligation",
          `run ${nodeId} must carry one nonempty argv for approved change ${effectiveAuthority.ticketId}`,
        );
      }
      const actualArgv = command as string[];
      if (
        actualArgv.length !== expectedArgv.length ||
        actualArgv.some((argument, index) => argument !== expectedArgv[index])
      ) {
        fail(
          "approved_change_obligation",
          `run ${nodeId} must retain approved command ${JSON.stringify(expectedArgv)} from ${effectiveAuthority.ticketId}; received ${JSON.stringify(actualArgv)}`,
        );
      }
      const scientificInputs = Array.isArray(contract?.scientific_inputs)
        ? contract.scientific_inputs.flatMap((value) => {
            const input = optionalRecord(value);
            return typeof input?.path === "string" ? [input] : [];
          })
        : [];
      const scientificInputPaths = new Set(scientificInputs.map((input) => input.path as string));
      for (const argument of expectedArgv.slice(1)) {
        if (!argument.includes("/") || argument.startsWith("-")) continue;
        if (scientificInputPaths.has(argument)) continue;
        fail(
          "approved_change_obligation",
          `run ${nodeId} approved command path ${argument} must remain a scientific input under ${effectiveAuthority.ticketId}`,
        );
      }
      const roleAuthorities = [
        {
          ticketId: obligation.ticketId,
          targetNodeIds: obligation.targetNodeIds,
          summary: approvedChangeValueAuthoritySummaries(obligation).join("\n"),
        },
        ...(obligation.laterSourceCorrections ?? []).map((correction) => ({
          ticketId: correction.ticketId,
          targetNodeIds: correction.targetNodeIds,
          summary: approvedChangeValueAuthoritySummaries(correction).join("\n"),
        })),
      ].filter((authority) => authority.targetNodeIds.includes(nodeId));
      for (const roleAuthority of roleAuthorities) {
        if (!/no change to [^.]*scientific_inputs roles/iu.test(roleAuthority.summary)) continue;
        const roleClaims = [
          ...roleAuthority.summary.matchAll(
            /([A-Za-z0-9][A-Za-z0-9._:-]*)\s*\(command=\[([^\]]*)\]\)/gu,
          ),
        ].filter((candidate) => candidate[1] === nodeId);
        if (roleClaims.length === 0) continue;
        const roleGateVerifierPaths = new Set<string>();
        const roleEntrypoints = roleAuthority.targetNodeIds.flatMap((targetNodeId) => {
          const target = graph.node(targetNodeId);
          if (target?.type !== "asset") return [];
          const implementation = optionalRecord(target.spec.implementation);
          const assetEntrypoints = stringArray(
            implementation?.entrypoints,
            `asset ${targetNodeId} implementation entrypoints`,
          );
          const gateContracts = optionalRecord(target.spec.gate_contracts);
          for (const contractValue of Object.values(gateContracts ?? {})) {
            const gateContract = optionalRecord(contractValue);
            if (!Array.isArray(gateContract?.argv)) continue;
            for (const argument of gateContract.argv) {
              if (typeof argument === "string" && assetEntrypoints.includes(argument)) {
                roleGateVerifierPaths.add(argument);
              }
            }
          }
          return assetEntrypoints;
        });
        const roleArguments = new Set(
          roleClaims.flatMap((claim) =>
            [...claim[2]!.matchAll(/'([^']*)'|"([^"]*)"/gu)].map((token) => {
              const argument = token[1] ?? token[2]!;
              if (!argument.startsWith(".../")) return argument;
              const suffix = argument.slice(3);
              const candidates = [
                ...new Set(roleEntrypoints.filter((entrypoint) => entrypoint.endsWith(suffix))),
              ];
              if (candidates.length !== 1) {
                fail(
                  "approved_change_obligation",
                  `approved change ${roleAuthority.ticketId} cannot resolve ${argument} to one target asset entrypoint`,
                );
              }
              return candidates[0]!;
            }),
          ),
        );
        const protocolAdapterRequired = /protocol adapter/iu.test(roleAuthority.summary);
        for (const argument of expectedArgv.slice(1)) {
          if (!argument.includes("/") || argument.startsWith("-") || !roleArguments.has(argument)) {
            continue;
          }
          const requiredRole = roleGateVerifierPaths.has(argument)
            ? "verifier_contract"
            : protocolAdapterRequired
              ? "protocol_adapter"
              : undefined;
          if (requiredRole === undefined) continue;
          const input = scientificInputs.find((candidate) => candidate.path === argument);
          if (input?.role === requiredRole) continue;
          fail(
            "approved_change_obligation",
            `run ${nodeId} scientific input role for ${argument} must remain ${requiredRole} under ${roleAuthority.ticketId}`,
          );
        }
      }
    }
  }
}

export function shouldAssertApprovedChangeRuntimeObligations(
  step: Pick<DerivedWorkflowStep, "id" | "graph_mutation">,
): boolean {
  return step.id !== "diagnose" && step.graph_mutation !== "forbidden";
}

export function assertFailedReviewDoesNotContradictApprovedChangeRuntimeObligations(
  run: Pick<RunRecord, "tickets">,
  graph: Pick<TypedGraph, "node">,
  writableNodeIds: readonly string[],
  blocker: string,
): void {
  const obligations = approvedChangeObligationsForTargets(run, writableNodeIds);
  if (obligations.length === 0) return;
  try {
    assertApprovedChangeRuntimeObligations(run, graph, writableNodeIds);
  } catch {
    return;
  }
  const contradicted = obligations.find(
    (obligation) =>
      blocker.includes(obligation.ticketId) ||
      blocker.includes(obligation.approvedApplicationSha256),
  );
  if (contradicted === undefined) return;
  fail(
    "approved_change_review_contradiction",
    `failed review blocker contradicts satisfied approved change ${contradicted.ticketId}; review the current graph and durable obligation`,
  );
}

/**
 * Explain the compiler-owned filesystem acceptance boundary to asset reviewers.
 *
 * The manifest in the review graph describes the last accepted predecessor bytes. A later
 * workflow step may have changed the candidate files legitimately. The review verdict is the
 * authority that permits `applyReviewEffects` to derive and publish the new manifest, so requiring
 * that predecessor manifest to match before approval makes the atomic transition impossible.
 */
export function implementAssetReviewManifestInstruction(
  operation: string | undefined,
  stepKind: string,
): string | undefined {
  if (operation !== "implement-asset" || stepKind !== "review") return undefined;
  return [
    "Review the current scoped filesystem bytes as the candidate.",
    "A stale compiler-owned filesystem manifest is expected when an earlier workflow step changed those bytes; do not reject solely because its accepted hash describes predecessor bytes.",
    "If the current asset satisfies the review contract, approve it: after approval the compiler atomically derives and publishes the current manifest from the reviewed bytes.",
    "Reject only a defect in the current bytes or authored contract, and never author compiler-owned manifest fields yourself.",
  ].join(" ");
}

/** Keep implementation instructions honest about the exact compiled tool inventory. */
export function implementationWriteGrantInstructions(
  hasWriteGrant: boolean,
  validationCheckCount: number,
): readonly string[] {
  if (!hasWriteGrant) return [];
  const implementationBoundary =
    "This is an implementation attempt with a write grant. Reading alone does not satisfy it. Make the change with koni_write_file/koni_edit_file inside your write grant. Reserve a failed submission for a blocker that survives an actual implementation attempt (missing capability, contradictory contract, grant that cannot express the change), never for difficulty, uncertainty, or investigation you have not yet turned into an edit.";
  if (validationCheckCount === 0) {
    return [
      implementationBoundary,
      "No configured command proof is available in this attempt, so koni_run_check is intentionally absent. Inspect the exact authored bytes and authenticated causal evidence before submitting; do not treat the absence of an unconfigured check tool as a blocker when the requested file can be authored from that evidence.",
    ];
  }
  return [
    `${implementationBoundary} Run the configured proof with koni_run_check before you submit.`,
    "If the configured proof fails, that is normal iteration, not a blocker: read the failure, fix the edit, and run it again. Keep iterating until it passes or you have proven the objective is impossible within the grant. Do not stop after a single failing check.",
  ];
}

/** Keep recurring gate-provider repair attempts causal instead of merely descriptive. */
export function gateRepairInstruction(evidenceCount: number): string | undefined {
  if (evidenceCount === 0) return undefined;
  return [
    "Compiler-authenticated gateRepairEvidence is attached because current accepted gate receipts are nonpassing and this causal repair attempt was opened or reopened.",
    "expected_red describes an allowed initial check state; it does not make a current nonpassing receipt sufficient for downstream execution.",
    "Treat every attached diagnostic as an active repair obligation.",
    "Do not submit a no-op merely because files and manifests are current.",
    "Changing diagnostic wording, labels, or cause categories does not repair an unchanged nonpassing condition.",
    "Materially repair the cause within this grant; when the cause is outside this grant, raise the smallest upstream change request in this attempt instead of editing only its description.",
    "The application write scope is exactly its targetNodeIds. For a missing causal asset artifact, target the existing source-owning asset node or nodes visible in this attempt's causal scope, not merely the gate nodes that report the symptom.",
    "The attached commands[].result measurements are authenticated causal outputs. When they contain the exact regenerated hashes, paths, or other values required by the missing source artifact, use those exact values instead of demanding another execution of work the receipt already proves.",
    'An upstream change request is a successful handoff: submit it with status "completed", never status "failed".',
  ].join(" ");
}

/** Keep compatibility-scoped source repair causal when historical obligations describe pre-failure state. */
export function standaloneSupportRunAssetRepairInstruction(ruleId: string): string | undefined {
  if (ruleId !== "compiler.compatibility.standalone-support-run-asset-repair-scope") {
    return undefined;
  }
  return [
    "This compatibility ticket exists because a later compiler-authenticated standalone runtime failure supersedes older statements that the asset was already current, that only execution was missing, or that no source edit was requested.",
    "Do not use those pre-failure descriptions or an unchanged manifest as evidence that this repair can be a no-op.",
    "Preserve the authored thresholds, behavior scope, and output contract, but improve the source implementation that produces the failed measurements—for example its training procedure, optimizer, initialization, or other bounded implementation detail inside this write grant.",
    "The downstream standalone runtime rerun supplies validation after integration; the intentional absence of koni_run_check in this source-only attempt does not make a material source repair forbidden or unverifiable.",
  ].join(" ");
}

/** Keep a failed post-repair gate recheck moving toward the first writable cause. */
export function repairedProviderGateRecheckInstruction(
  operationRegistryId: string | undefined,
  sourceStateKey: string | undefined,
  stepId: string,
): string | undefined {
  if (
    operationRegistryId !== "gates.gate.run-gate" ||
    sourceStateKey !== "direct-scientific-gate-blocked-after-provider-repair" ||
    stepId !== "analyze"
  ) {
    return undefined;
  }
  return [
    "This is a compiler-created recheck after the selected gate provider completed repair.",
    "If the current accepted receipt passes, interpret it normally.",
    "If it remains nonpassing, diagnose the first unmet causal precondition; expected_red does not settle the current readiness obligation.",
    "Do not stop at receipt interpretation or another observation.",
    "Repair the cause within this grant, or when the cause is outside this grant, raise the smallest upstream change request in this attempt.",
  ].join(" ");
}

/** Keep a rejected configured check aligned with the operation's compiled change-control route. */
export function configuredCheckFailureInstructions(
  changeControl: CompiledChangeControl | undefined,
): string[] {
  if (changeControl?.role === "ordinary" && changeControl.allowUpstreamRequests) {
    return [
      'A required configured check whose result is rejected cannot satisfy this assignment by itself. If the exact blocker requires changing read-only causal authority outside this assignment, use the configured upstreamChangeRequest route instead of reporting the authority gap as a failed assignment. That handoff uses status "completed" with upstreamChangeRequest and does not claim that the rejected check passed. For a blocker within this assignment\'s authority, submit status "failed" with the exact check blocker unless you materially repair the cause and rerun that check successfully in this attempt.',
    ];
  }
  return [
    'A required configured check whose result is rejected cannot satisfy this assignment. Do not submit status "completed" after any required check returns accepted: false. Submit status "failed" with the exact check blocker unless you materially repair the cause and rerun that check successfully in this attempt.',
  ];
}

export function upstreamChangeRequestInstructions(
  changeControl: CompiledChangeControl | undefined,
  downstreamGraphPublicationStepIds: readonly string[] = [],
): string[] {
  if (changeControl?.role !== "ordinary" || !changeControl.allowUpstreamRequests) return [];
  const changeBoundary =
    downstreamGraphPublicationStepIds.length === 0
      ? "outside this step's write authority"
      : "outside this ticket's existing authority and its downstream publication steps";
  return [
    `This step has an explicit upstream-change route for work that the current workflow cannot satisfy. If satisfying the contract requires changing a read-only asset or another node ${changeBoundary}, do not fabricate an inline substitute, weaken the contract, or upsert that node. Submit status "completed" with summary and upstreamChangeRequest, and omit graphDelta. Exact shape: {"status":"completed","summary":"...","upstreamChangeRequest":{"targetNodeIds":["the-existing-causal-node-id"],"fulfillment":"planned_asset_repair","summary":"...","reason":"..."}}.`,
    "Target every existing causal node whose authored fields must change together for one internally consistent correction. Do not target unrelated context nodes or defer a currently evidenced companion correction merely because one node first exposed the defect.",
    "Carry the complete bounded desired state in upstreamChangeRequest.summary and reason: include every exact authored value, identifier, path, command, binding, and relationship the later application needs. Do not replace already-authored intent with a route-only synopsis or say the details exist elsewhere.",
    ...(downstreamGraphPublicationStepIds.length === 0
      ? []
      : [
          `A graph mutation forbidden in this step is not an upstream change when the authored update remains within this ticket's existing authority and a later graph-owning workflow step already publishes it. Complete the current repository or evidence work, state the exact pending semantic update in the summary and predecessor evidence, and let the configured downstream step publish it. Downstream graph-publication steps: ${downstreamGraphPublicationStepIds.join(", ")}.`,
        ]),
    'Use fulfillment "planned_asset_repair" only when the existing asset implementation workflow can satisfy the whole request by editing that asset\'s authored source files or contracts. Use "dynamic_scope_change" when fulfillment needs a new run or node, runtime execution/output, or authority beyond the existing asset source grant.',
    'Graph write authority does not make fields that derive this ticket\'s repository grant mutable during the active attempt. If accepted repository evidence contradicts a scope-bearing field, stop probing the rejected path and submit the upstreamChangeRequest without graphDelta; use fulfillment "dynamic_scope_change" for the correction even when the replacement path is already inside the issued grant.',
  ];
}

/** Identify later steps that can publish graph changes produced by the current workflow branch. */
export function downstreamGraphPublicationStepIds(
  definition: Pick<DerivedTicketDefinition, "workflow">,
  step: Pick<DerivedWorkflowStep, "id">,
): string[] {
  const byId = new Map(definition.workflow.map((candidate) => [candidate.id, candidate]));
  const dependsOnCurrent = (candidate: DerivedWorkflowStep): boolean => {
    const pending = [...candidate.depends_on];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const predecessorId = pending.pop()!;
      if (predecessorId === step.id) return true;
      if (visited.has(predecessorId)) continue;
      visited.add(predecessorId);
      const predecessor = byId.get(predecessorId);
      if (predecessor !== undefined) pending.push(...predecessor.depends_on);
    }
    return false;
  };
  return definition.workflow
    .filter(
      (candidate) =>
        candidate.kind !== "review" &&
        candidate.graph_mutation !== "forbidden" &&
        dependsOnCurrent(candidate),
    )
    .map((candidate) => candidate.id);
}

export function reviewVerdictInstructions(
  stepKind: DerivedWorkflowStep["kind"],
  changeControl: CompiledChangeControl | undefined,
): string[] {
  if (stepKind !== "review") return [];
  if (changeControl?.role === "ordinary" && changeControl.allowUpstreamRequests) {
    return [
      'Before choosing a verdict, classify every demanded repair by authority. If any material repair requires changing graph state, scope, contract, or another read-only resource outside the current producer grant, do not use status "failed" or reviewVerdict "rejected" and do not spend local rework on it. Use status "completed" with reviewVerdict "changes_requested" and the authorized upstreamChangeRequest. Use status "failed" with reviewVerdict "rejected" and a precise blocker only when every demanded repair is executable by the configured rework producer. Use status "completed" with reviewVerdict "approved" only when no material finding remains.',
    ];
  }
  return [
    'Return an explicit typed review verdict. This operation has no upstream-change output route. Use status "failed" with reviewVerdict "rejected" and a precise blocker when any material finding remains, including an exact outside-grant repair that requires separately configured authority. Use status "completed" with reviewVerdict "approved" only when no material finding remains.',
  ];
}
