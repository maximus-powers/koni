import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { satisfies, valid, validRange } from "semver";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type { CompilerGraphNode, CompilerGraphProjection } from "../contracts/rules.js";
import { canonicalHash, compareUtf8, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import {
  GraphExpressionEvaluator,
  type RuleDomainAdapter,
  type RuleDomainContext,
} from "./expressions.js";

export const RULE_AUTHORITY_EVIDENCE_PROTOCOL = "koni.rule-authority-evidence.v1" as const;

const MAX_MANIFEST_FILES = 50_000;
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;

export interface RulePredicateEvidence {
  key: Sha256Digest;
  result: boolean;
  recordedAt: string;
  sourceReceiptIds: readonly string[];
  /** Exact current receipt status. Gate satisfaction compares it with the compiled policy set. */
  receiptStatus?: string;
  /** Authenticated semantic identity used by composed coverage predicates. */
  leaf?: ConfigurationObject;
  subjectNodeId?: string;
  bindings?: Readonly<Record<string, readonly string[]>>;
}

export interface RuleAuthorityEvidenceMaterial {
  protocol: typeof RULE_AUTHORITY_EVIDENCE_PROTOCOL;
  configurationSha256: Sha256Digest;
  inputGraphSha256: Sha256Digest;
  predicates: Readonly<Record<Sha256Digest, RulePredicateEvidence>>;
}

export interface RuleAuthorityEvidence extends RuleAuthorityEvidenceMaterial {
  evidenceSha256: Sha256Digest;
}

export interface ProductionRuleDomainAdapterOptions {
  configuration: CompiledConfiguration;
  graph: CompilerGraphProjection;
  projectRoot: string;
  evidence?: RuleAuthorityEvidence;
}

export interface FilesystemManifestAcceptance {
  outputField: string;
  manifest: ConfigurationObject;
  blockingErrors: readonly string[];
}

export interface RulePredicateEvidenceKeyInput {
  configurationSha256: Sha256Digest;
  inputGraphSha256: Sha256Digest;
  leaf: ConfigurationObject;
  subjectNodeId?: string;
  bindings: Readonly<Record<string, readonly string[]>>;
}

/**
 * The exact normalized input-graph digest used by the expression VM and by authority evidence.
 *
 * Callers must not hash a storage graph directly: storage-only fields such as `schema_version`
 * are intentionally absent from the compiler projection. This helper is the single public bridge
 * for constructing an evidence envelope before a compiler pass.
 */
export function ruleInputGraphSha256(
  configuration: CompiledConfiguration,
  graph: CompilerGraphProjection,
): Sha256Digest {
  return new GraphExpressionEvaluator(configuration, graph).inputGraphSha256;
}

/**
 * Exact key an authority evidence store signs for one dynamic rule predicate.
 *
 * Graph-only checks, filesystem currentness, and deterministic gate selection are deliberately
 * evaluated locally and never consume an assertion. Receipt/command/review predicates return
 * false unless this exact key is present in an authenticated evidence snapshot.
 */
export function rulePredicateEvidenceKey(input: RulePredicateEvidenceKeyInput): Sha256Digest {
  const referencedBindings = rulePredicateBindingNames(input.leaf);
  return canonicalHash({
    protocol: "koni.rule-predicate-evidence-key.v1",
    configurationSha256: input.configurationSha256,
    inputGraphSha256: input.inputGraphSha256,
    leaf: input.leaf,
    subjectNodeId: input.subjectNodeId ?? null,
    bindings: Object.fromEntries(
      Object.entries(input.bindings)
        .filter(([name]) => referencedBindings.has(name))
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([name, ids]) => [name, [...new Set(ids)].sort(compareUtf8)]),
    ),
  });
}

/** Binding identities that can affect one leaf's meaning; unrelated outer-loop bindings are omitted. */
export function rulePredicateBindingNames(leaf: ConfigurationObject): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_-]*)$/u.exec(value.trim());
      if (match !== null) names.add(match[1]!);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) for (const item of Object.values(value)) visit(item);
  };
  visit(leaf);
  return names;
}

export function createRuleAuthorityEvidence(
  material: RuleAuthorityEvidenceMaterial,
): RuleAuthorityEvidence {
  validateEvidenceMaterial(material);
  return deepFreeze({
    ...structuredClone(material),
    evidenceSha256: canonicalHash(material),
  });
}

/** Build the deterministic/local half of the rule domain before one compiler pass begins. */
export async function createProductionRuleDomainAdapter(
  options: ProductionRuleDomainAdapterOptions,
): Promise<RuleDomainAdapter> {
  const projectRoot = await canonicalProjectRoot(options.projectRoot);
  const inputGraphSha256 = ruleInputGraphSha256(options.configuration, options.graph);
  const evidence = validateEvidence(
    options.evidence,
    options.configuration.configuration_sha256,
    inputGraphSha256,
  );
  const pathSnapshot = await snapshotConfiguredPaths(options.configuration, projectRoot);
  const manifestSnapshot = await snapshotFilesystemManifests(
    options.configuration,
    options.graph,
    projectRoot,
  );
  const checkStack = new Set<string>();

  const adapter: RuleDomainAdapter = {
    selectPolicy(selector, context) {
      if (isRecord(selector.policy_applicability)) {
        return selectPolicyApplicability(selector.policy_applicability, context);
      }
      if (isRecord(selector.policy_selection)) {
        return selectPolicySelection(selector.policy_selection, context);
      }
      return undefined;
    },
    evaluatePredicate(leaf, context) {
      const op = stringValue(leaf.op);
      switch (op) {
        case "check_passed": {
          const checkId = stringValue(leaf.check);
          const check = context.configuration.registries.checks[checkId];
          if (check === undefined) return false;
          if (check.kind !== "graph")
            return evidenceResult(evidence, leaf, context, inputGraphSha256);
          if (checkStack.has(checkId) || check.predicate === undefined) return false;
          checkStack.add(checkId);
          try {
            return context.evaluate(check.predicate);
          } finally {
            checkStack.delete(checkId);
          }
        }
        case "path_exists": {
          const raw = optionalString(leaf.value) ?? optionalString(leaf.path);
          const normalized = raw === undefined ? undefined : normalizedRelativePath(raw);
          return normalized !== undefined && pathSnapshot.get(normalized) === true;
        }
        case "filesystem_manifest_current": {
          const subject = context.subject;
          if (subject === undefined) return false;
          const expected = manifestSnapshot.get(subject.id);
          const definition = context.configuration.registries.node_types[subject.type];
          const outputField = optionalString(
            recordValue(definition?.filesystem_manifest)?.output_field,
          );
          const actual = outputField === undefined ? undefined : nodeField(subject, outputField);
          return (
            expected !== undefined &&
            actual !== undefined &&
            canonicalHash(actual) === canonicalHash(expected)
          );
        }
        case "gate_policy_compatible": {
          const gate = boundNode(context, optionalString(leaf.gate_subject) ?? "$gate");
          return (
            gate !== undefined &&
            context.subject !== undefined &&
            candidateCompatible(policy(context, leaf), gate, context.subject) !== undefined
          );
        }
        case "gate_policy_has_selection": {
          const gate = boundNode(context, optionalString(leaf.gate_subject) ?? "$gate");
          return (
            gate !== undefined &&
            gateSelection(policy(context, leaf), gate, context).winner !== undefined
          );
        }
        case "gate_policy_selected": {
          const gate = boundNode(context, optionalString(leaf.gate_subject) ?? "$gate");
          return (
            gate !== undefined &&
            context.subject !== undefined &&
            gateSelection(policy(context, leaf), gate, context).winner?.id === context.subject.id
          );
        }
        case "gate_policy_candidate_count": {
          const gate = boundNode(context, optionalString(leaf.gate_subject) ?? "$gate");
          const count =
            gate === undefined
              ? 0
              : gateSelection(policy(context, leaf), gate, context).compatible.length;
          return countMatches(count, leaf);
        }
        case "gate_policy_command_available": {
          const gate = boundNode(context, optionalString(leaf.gate_subject) ?? "$gate");
          return gate !== undefined && gateCommandAvailable(policy(context, leaf), gate, context);
        }
        case "gate_policy_evaluation_targets_ready": {
          const gate = boundNode(context, optionalString(leaf.gate_subject) ?? "$gate");
          return gate !== undefined && gateTargetsReady(policy(context, leaf), gate, context);
        }
        case "gate_policy_execution_ready": {
          const gate = boundNode(context, optionalString(leaf.gate_subject) ?? "$gate");
          if (gate === undefined) return false;
          const selected = gateSelection(policy(context, leaf), gate, context).winner;
          const predicate = policy(context, leaf).execution_ready;
          return (
            selected !== undefined &&
            predicate !== undefined &&
            context.withBinding("gate", [gate.id], () =>
              context.withBinding("winner", [selected.id], () =>
                context.withBinding("candidate", [selected.id], () => context.evaluate(predicate)),
              ),
            )
          );
        }
        case "gate_policy_satisfied":
          return gatePolicyReceiptSatisfied(
            evidence,
            policy(context, leaf),
            leaf,
            context,
            inputGraphSha256,
          );
        case "gate_policy_has_current_terminal":
        case "current_receipt":
        case "proof_preparation_current":
        case "check_has_current_terminal":
          return evidenceResult(evidence, leaf, context, inputGraphSha256);
        case "receipt_coverage_current":
          return receiptCoverageCurrent(evidence, leaf, context);
        case "review_effect_coverage_current":
          return reviewEffectCoverageCurrent(leaf, context);
        default:
          return undefined;
      }
    },
  };
  return adapter;
}

function evidenceResult(
  evidence: RuleAuthorityEvidence | undefined,
  leaf: ConfigurationObject,
  context: RuleDomainContext,
  inputGraphSha256: Sha256Digest,
): boolean {
  return predicateEvidence(evidence, leaf, context, inputGraphSha256)?.result === true;
}

function predicateEvidence(
  evidence: RuleAuthorityEvidence | undefined,
  leaf: ConfigurationObject,
  context: RuleDomainContext,
  inputGraphSha256: Sha256Digest,
): RulePredicateEvidence | undefined {
  if (evidence === undefined) return undefined;
  const key = rulePredicateEvidenceKey({
    configurationSha256: context.configuration.configuration_sha256,
    inputGraphSha256,
    leaf,
    ...(context.subject === undefined ? {} : { subjectNodeId: context.subject.id }),
    bindings: context.bindings,
  });
  return evidence.predicates[key];
}

function gatePolicyReceiptSatisfied(
  evidence: RuleAuthorityEvidence | undefined,
  configured: ConfigurationObject,
  leaf: ConfigurationObject,
  context: RuleDomainContext,
  inputGraphSha256: Sha256Digest,
): boolean {
  const current = predicateEvidence(evidence, leaf, context, inputGraphSha256);
  if (current?.result !== true) return false;
  // Compatibility for existing durable evidence: its true result historically meant "passed".
  const status = current.receiptStatus ?? "passed";
  return stringArray(configured.passing_receipt_statuses).includes(status);
}

function receiptCoverageCurrent(
  evidence: RuleAuthorityEvidence | undefined,
  leaf: ConfigurationObject,
  context: RuleDomainContext,
): boolean {
  try {
    if (evidence === undefined || context.subject === undefined) return false;
    const operationId = stringValue(leaf.receipt_coverage);
    const operation = context.configuration.registries.operations[operationId];
    const contract = recordValue(operation?.receipt_coverage);
    if (
      contract === undefined ||
      !stringArray(contract.candidate_node_types).includes(context.subject.type)
    )
      return false;
    if (leaf.coverage_targets === undefined) return false;
    const coverageTargets = context.select(leaf.coverage_targets);
    const requiredDefinition = requiredRecord(
      contract.required_nodes,
      "receipt coverage required nodes",
    );
    const required = new Set(
      context.withBinding("coverage_target", coverageTargets, () =>
        context.select({
          traverse: {
            from: "$coverage_target",
            ...(requiredDefinition.relation === undefined
              ? {}
              : { relation: requiredDefinition.relation }),
            ...(requiredDefinition.relations === undefined
              ? {}
              : { relations: requiredDefinition.relations }),
            direction: requiredDefinition.direction ?? "outgoing",
            min_depth: requiredDefinition.min_depth ?? 1,
            max_depth: requiredDefinition.max_depth ?? 1,
            node_types: requiredDefinition.node_types ?? [],
          },
        }),
      ),
    );
    if (required.size === 0) return false;
    const relation = stringValue(contract.candidate_link_relation);
    const linkedValues = context.subject.edges[relation] ?? [];
    const linked = strictStringSet(linkedValues);
    if (linked === undefined || !isSubsetOf(required, linked)) return false;
    if (contract.coverage === "exact" && !setsEqual(required, linked)) return false;
    const nodesToBind = new Set([...required, ...linked]);
    const expectedReceipts = new Map<string, string>();
    for (const nodeId of nodesToBind) {
      const receipt = latestReceiptEvidence(evidence, nodeId, stringValue(contract.receipt_type));
      if (receipt === undefined || receipt.result !== true || receipt.sourceReceiptIds.length !== 1)
        return false;
      expectedReceipts.set(nodeId, receipt.sourceReceiptIds[0]!);
    }
    const dispositionPath = stringValue(contract.disposition_map_path);
    const dispositions = recordValue(nodeField(context.subject, dispositionPath));
    if (dispositions === undefined || !setsEqual(new Set(Object.keys(dispositions)), linked))
      return false;
    const disposition = requiredRecord(contract.disposition, "receipt coverage disposition");
    const allowed = new Set(stringArray(disposition.allowed_values));
    for (const nodeId of linked) {
      const entry = recordValue(dispositions[nodeId]);
      if (entry === undefined) return false;
      const value = valueAtConfiguredPath(entry, stringValue(disposition.value_path));
      const receiptId = valueAtConfiguredPath(entry, stringValue(disposition.receipt_id_path));
      const rationale = valueAtConfiguredPath(entry, stringValue(disposition.rationale_path));
      if (
        typeof value !== "string" ||
        !allowed.has(value) ||
        receiptId !== expectedReceipts.get(nodeId) ||
        typeof rationale !== "string" ||
        rationale.trim().length === 0
      )
        return false;
    }
    const receiptRefsPath = optionalString(contract.receipt_refs_path);
    if (receiptRefsPath !== undefined) {
      const raw = nodeField(context.subject, receiptRefsPath);
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) return false;
      const refs = strictStringSet(raw as string[]);
      const expected = new Set([...linked].map((id) => expectedReceipts.get(id)!));
      if (refs === undefined || !setsEqual(refs, expected)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function reviewEffectCoverageCurrent(
  leaf: ConfigurationObject,
  context: RuleDomainContext,
): boolean {
  try {
    const candidate = context.subject;
    if (candidate === undefined) return false;
    const operation =
      context.configuration.registries.operations[stringValue(leaf.review_operation)];
    const effects = arrayValue(operation?.review_effects);
    const effect = effects
      .map((value) => recordValue(value))
      .find((value) => value?.id === leaf.review_effect);
    if (effect === undefined) return false;
    const select = requiredRecord(effect.select, "review effect selector");
    if (
      !stringArray(select.node_types).includes(candidate.type) ||
      leaf.coverage_targets === undefined
    )
      return false;
    const targets = context.select(leaf.coverage_targets);
    return context.withBinding("target", targets, () =>
      context.withBinding("candidate", [candidate.id], () =>
        arrayValue(effect.coverage).every((rawCoverage) => {
          const coverage = requiredRecord(rawCoverage, "review effect coverage");
          const actual = requiredRecord(coverage.actual, "review effect coverage actual");
          if (coverage.required === undefined) return false;
          const required = new Set(context.select(coverage.required));
          const observed = reviewCoverageActual(candidate, actual);
          return observed !== undefined && setsEqual(required, observed);
        }),
      ),
    );
  } catch {
    return false;
  }
}

function latestReceiptEvidence(
  evidence: RuleAuthorityEvidence,
  subjectNodeId: string,
  receiptType: string,
): RulePredicateEvidence | undefined {
  return Object.values(evidence.predicates)
    .filter(
      (entry) =>
        entry.subjectNodeId === subjectNodeId &&
        entry.leaf?.op === "current_receipt" &&
        entry.leaf.receipt_type === receiptType,
    )
    .sort(
      (left, right) =>
        right.recordedAt.localeCompare(left.recordedAt) || compareUtf8(right.key, left.key),
    )[0];
}

function reviewCoverageActual(
  candidate: CompilerGraphNode,
  actual: ConfigurationObject,
): Set<string> | undefined {
  const kind = optionalString(actual.kind);
  if (kind === "outgoing_relation") {
    const relation = optionalString(actual.relation);
    return relation === undefined ? undefined : strictStringSet(candidate.edges[relation] ?? []);
  }
  const field = optionalString(actual.field);
  if (field === undefined) return undefined;
  const value = nodeField(candidate, field);
  if (kind === "field_value")
    return typeof value === "string" ? strictStringSet([value]) : undefined;
  if (kind === "field_values") {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? strictStringSet(value)
      : undefined;
  }
  if (kind === "object_keys") {
    const object = recordValue(value);
    if (object === undefined) return undefined;
    const allowed = arrayValue(actual.allowed_values);
    if (
      allowed.length > 0 &&
      Object.values(object).some(
        (item) => !allowed.some((candidate) => canonicalHash(candidate) === canonicalHash(item)),
      )
    )
      return undefined;
    return strictStringSet(Object.keys(object));
  }
  return undefined;
}

function strictStringSet(values: readonly string[]): Set<string> | undefined {
  if (values.some((value) => value.trim().length === 0)) return undefined;
  const output = new Set(values);
  return output.size === values.length ? output : undefined;
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function isSubsetOf(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  return [...subset].every((value) => superset.has(value));
}

function valueAtConfiguredPath(
  root: ConfigurationObject,
  field: string,
): ConfigurationValue | undefined {
  let current: ConfigurationValue = root;
  for (const segment of field.replace(/^spec\./u, "").split(".")) {
    if (!isRecord(current) || current[segment] === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function validateEvidence(
  evidence: RuleAuthorityEvidence | undefined,
  configurationSha256: Sha256Digest,
  inputGraphSha256: Sha256Digest,
): RuleAuthorityEvidence | undefined {
  if (evidence === undefined) return undefined;
  const { evidenceSha256, ...material } = structuredClone(evidence);
  validateEvidenceMaterial(material);
  if (
    evidenceSha256 !== canonicalHash(material) ||
    material.configurationSha256 !== configurationSha256 ||
    material.inputGraphSha256 !== inputGraphSha256
  )
    throw new Error(
      "rule authority evidence does not match this compiler graph/configuration snapshot",
    );
  return deepFreeze(structuredClone(evidence));
}

function validateEvidenceMaterial(material: RuleAuthorityEvidenceMaterial): void {
  if (
    material.protocol !== RULE_AUTHORITY_EVIDENCE_PROTOCOL ||
    !isDigest(material.configurationSha256) ||
    !isDigest(material.inputGraphSha256) ||
    !isPlainRecord(material.predicates)
  )
    throw new Error("rule authority evidence has an invalid envelope");
  for (const [key, unknownValue] of Object.entries(material.predicates)) {
    if (!isPlainRecord(unknownValue)) {
      throw new Error(`rule authority predicate evidence ${key} is invalid`);
    }
    const value = unknownValue as unknown as RulePredicateEvidence;
    if (
      !isDigest(key) ||
      value.key !== key ||
      typeof value.result !== "boolean" ||
      !isIsoTimestamp(value.recordedAt) ||
      !Array.isArray(value.sourceReceiptIds) ||
      value.sourceReceiptIds.some((id) => typeof id !== "string" || id.trim().length === 0) ||
      (value.receiptStatus !== undefined &&
        (typeof value.receiptStatus !== "string" ||
          value.receiptStatus.trim().length === 0 ||
          value.receiptStatus.trim() !== value.receiptStatus)) ||
      (value.leaf !== undefined && !isPlainRecord(value.leaf)) ||
      (value.subjectNodeId !== undefined &&
        (typeof value.subjectNodeId !== "string" || value.subjectNodeId.trim().length === 0)) ||
      (value.bindings !== undefined &&
        (!isPlainRecord(value.bindings) ||
          Object.values(value.bindings).some(
            (ids) =>
              !Array.isArray(ids) ||
              ids.some((id) => typeof id !== "string" || id.trim().length === 0),
          )))
    )
      throw new Error(`rule authority predicate evidence ${key} is invalid`);
  }
}

function selectPolicyApplicability(
  envelope: ConfigurationObject,
  context: RuleDomainContext,
): readonly string[] {
  const configured = context.configuration.registries.gate_policies[stringValue(envelope.policy)];
  if (configured === undefined) throw new Error("unknown configured gate policy");
  const subjects = context.select(requiredValue(envelope.subject, "policy applicability subject"));
  const applicability = requiredRecord(configured.applicability, "gate applicability");
  const classOrder = stringArray(applicability.context_class_order);
  const classIndex = new Map(classOrder.map((name, index) => [name, index]));
  const classes = requiredRecord(applicability.context_classes, "gate applicability classes");
  const classFor = (node: CompilerGraphNode): number | undefined => {
    const matches = Object.entries(classes)
      .flatMap(([name, raw]) => {
        const nodeTypes = stringArray(recordValue(recordValue(raw)?.nodes)?.node_types);
        return nodeTypes.includes(node.type) ? [classIndex.get(name)] : [];
      })
      .filter((value): value is number => value !== undefined);
    if (matches.length > 1)
      throw new Error(`node ${node.id} belongs to multiple gate applicability classes`);
    return matches[0];
  };
  const allIds = context.select({ nodes: {} });
  const allNodes = allIds.flatMap((id) => {
    const node = context.node(id);
    return node === undefined ? [] : [node];
  });
  const incoming = new Map<string, string[]>();
  for (const node of allNodes) {
    for (const targets of Object.values(node.edges)) {
      for (const target of targets) {
        const values = incoming.get(target) ?? [];
        values.push(node.id);
        incoming.set(target, values);
      }
    }
  }
  const direct = new Set<string>();
  const inherited = new Set<string>();
  const ancestorsAll = new Set<string>();
  const contextAll = new Set<string>();
  const enabled = new Set(context.select(requiredValue(configured.gate_subjects, "gate subjects")));
  for (const subjectId of subjects) {
    const subject = context.node(subjectId);
    if (subject === undefined)
      throw new Error(`gate applicability subject ${subjectId} is missing`);
    const startClass = classFor(subject);
    if (startClass === undefined)
      throw new Error(`gate applicability subject ${subjectId} has no context class`);
    const ancestors = new Set<string>();
    const seen = new Set<string>([subjectId]);
    const queue: Array<{ id: string; classIndex: number }> = [
      { id: subjectId, classIndex: startClass },
    ];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = context.node(current.id)!;
      const neighbors = new Set<string>([
        ...Object.values(node.edges).flat(),
        ...(incoming.get(current.id) ?? []),
      ]);
      for (const neighborId of [...neighbors].sort(compareUtf8)) {
        if (seen.has(neighborId)) continue;
        const neighbor = context.node(neighborId);
        const neighborClass = neighbor === undefined ? undefined : classFor(neighbor);
        if (neighborClass === undefined || neighborClass >= current.classIndex) continue;
        seen.add(neighborId);
        ancestors.add(neighborId);
        queue.push({ id: neighborId, classIndex: neighborClass });
      }
    }
    for (const id of ancestors) ancestorsAll.add(id);
    context.withBinding("subject", [subjectId], () =>
      context.withBinding("ancestors", [...ancestors], () => {
        for (const id of context.select(
          requiredValue(applicability.direct_gates, "direct gate selector"),
        )) {
          if (enabled.has(id)) direct.add(id);
        }
        for (const id of context.select(
          requiredValue(applicability.inherited_gates, "inherited gate selector"),
        )) {
          if (enabled.has(id)) inherited.add(id);
        }
        for (const id of context.select(
          requiredValue(applicability.context, "gate context selector"),
        ))
          contextAll.add(id);
      }),
    );
  }
  const result = optionalString(envelope.result) ?? "applicable_gates";
  if (result === "direct_gates") return sorted(direct);
  if (result === "inherited_gates") return sorted(inherited);
  if (result === "ancestors") return sorted(ancestorsAll);
  if (result === "context") return sorted(contextAll);
  if (result === "applicable_gates") return sorted(new Set([...direct, ...inherited]));
  throw new Error(`unsupported gate applicability result ${result}`);
}

function selectPolicySelection(
  envelope: ConfigurationObject,
  context: RuleDomainContext,
): readonly string[] {
  const configured = context.configuration.registries.gate_policies[stringValue(envelope.policy)];
  if (configured === undefined) throw new Error("unknown configured gate policy");
  const gateIds = context.select(requiredValue(envelope.gate, "policy selection gate"));
  const output = new Set<string>();
  for (const gateId of gateIds) {
    const gate = context.node(gateId);
    if (gate === undefined) throw new Error(`gate selection subject ${gateId} is missing`);
    const selection = gateSelection(configured, gate, context);
    if (envelope.result === "compatible") {
      for (const candidate of selection.compatible) output.add(candidate.id);
    } else if (selection.winner !== undefined) output.add(selection.winner.id);
  }
  return sorted(output);
}

function policy(context: RuleDomainContext, leaf: ConfigurationObject): ConfigurationObject {
  const id = optionalString(leaf.gate_policy) ?? optionalString(leaf.policy);
  const configured =
    id === undefined ? undefined : context.configuration.registries.gate_policies[id];
  if (configured === undefined) throw new Error(`unknown configured gate policy ${id ?? ""}`);
  return configured;
}

function gateSelection(
  configured: ConfigurationObject,
  gate: CompilerGraphNode,
  context: RuleDomainContext,
): { compatible: CompilerGraphNode[]; winner?: CompilerGraphNode } {
  if (!stringArray(configured.gate_node_types).includes(gate.type)) return { compatible: [] };
  const candidates = context
    .select(requiredValue(configured.candidate_pool, "gate candidate pool"))
    .flatMap((id) => {
      const node = context.node(id);
      return node === undefined ? [] : [node];
    });
  const selection = requiredRecord(configured.selection, "gate selection");
  const ranks = arrayValue(selection.ranks);
  const compatible = candidates
    .flatMap((candidate) => {
      const capability = candidateCompatible(configured, gate, candidate);
      if (capability === undefined) return [];
      const rank = firstMatchingRank(ranks, candidate, gate);
      return [{ candidate, rank }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        compareScalar(
          nodeField(
            left.candidate,
            optionalString(recordValue(selection.tie_break)?.field) ?? "id",
          ),
          nodeField(
            right.candidate,
            optionalString(recordValue(selection.tie_break)?.field) ?? "id",
          ),
        ) ||
        compareUtf8(left.candidate.id, right.candidate.id),
    );
  return {
    compatible: compatible.map((item) => item.candidate),
    ...(compatible[0] === undefined ? {} : { winner: compatible[0].candidate }),
  };
}

function candidateCompatible(
  configured: ConfigurationObject,
  gate: CompilerGraphNode,
  candidate: CompilerGraphNode,
): ConfigurationObject | undefined {
  if (!stringArray(configured.candidate_node_types).includes(candidate.type)) return undefined;
  const capability = requiredRecord(configured.capability, "gate capability");
  const requiredName = firstStringField(gate, stringArray(capability.required_name_fields));
  const requiredVersion = firstStringField(
    gate,
    stringArray(capability.required_version_req_fields),
  );
  if (
    requiredName === undefined ||
    requiredVersion === undefined ||
    validRange(requiredVersion) === null
  )
    return undefined;
  for (const field of stringArray(capability.provider_collection_fields)) {
    const collection = nodeField(candidate, field);
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!isRecord(item)) continue;
      const name = firstObjectString(item, stringArray(capability.provider_name_fields));
      const version = firstObjectString(item, stringArray(capability.provider_version_fields));
      if (
        name === requiredName &&
        version !== undefined &&
        valid(version) !== null &&
        satisfies(version, requiredVersion)
      )
        return item;
    }
  }
  return undefined;
}

function firstMatchingRank(
  ranks: readonly ConfigurationValue[],
  candidate: CompilerGraphNode,
  gate: CompilerGraphNode,
): number {
  for (const [index, raw] of ranks.entries()) {
    const rank = recordValue(raw);
    if (rank !== undefined && rankMatches(rank, candidate, gate)) return index;
  }
  return ranks.length;
}

function rankMatches(
  rank: ConfigurationObject,
  candidate: CompilerGraphNode,
  gate: CompilerGraphNode,
): boolean {
  const kind = optionalString(rank.kind);
  const fields = stringArray(rank.fields);
  if (kind === "compatible") return true;
  if (kind === "edge_contains_gate") {
    return stringArray(rank.relations).some((relation) =>
      (candidate.edges[relation] ?? []).includes(gate.id),
    );
  }
  if (kind === "field_equals_gate_id") {
    return fields.some((field) => nodeField(candidate, field) === gate.id);
  }
  if (kind === "map_has_gate_key" || kind === "merged_map_has_gate_key") {
    return fields.some((field) =>
      fieldValues(candidate, field).some(
        (value) => isRecord(value) && Object.hasOwn(value, gate.id),
      ),
    );
  }
  if (kind === "merged_map_value_equals") {
    return fields.some((field) =>
      fieldValues(candidate, field).some(
        (value) => isRecord(value) && canonicalHash(value[gate.id]) === canonicalHash(rank.value),
      ),
    );
  }
  return false;
}

function gateTargetsReady(
  configured: ConfigurationObject,
  gate: CompilerGraphNode,
  context: RuleDomainContext,
): boolean {
  const target = requiredRecord(configured.evaluation_targets, "gate evaluation targets");
  const ids = context.withBinding("gate", [gate.id], () =>
    context.select(requiredValue(target.select, "gate target selector")),
  );
  const cardinality = optionalString(target.cardinality) ?? "exactly_one";
  if (cardinality === "exactly_one") return ids.length === 1;
  if (cardinality === "one_or_more") return ids.length >= 1;
  if (cardinality === "zero_or_one") return ids.length <= 1;
  return false;
}

function gateCommandAvailable(
  configured: ConfigurationObject,
  gate: CompilerGraphNode,
  context: RuleDomainContext,
): boolean {
  if (!gateTargetsReady(configured, gate, context)) return false;
  const winner = gateSelection(configured, gate, context).winner;
  if (winner === undefined) return false;
  const auto = recordValue(configured.auto_evaluate);
  const checkId = optionalString(auto?.check);
  const check =
    checkId === undefined ? undefined : context.configuration.registries.checks[checkId];
  const source = recordValue(check?.command_source);
  const field = optionalString(source?.field);
  if (field === undefined) return false;
  const command = dynamicNodeField(winner, field, { "gate.id": gate.id });
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((item) => typeof item === "string" && item.length > 0)
  );
}

async function snapshotConfiguredPaths(
  configuration: CompiledConfiguration,
  projectRoot: string,
): Promise<Map<string, boolean>> {
  const requested = new Set<string>();
  collectPathPredicates(configuration.registries, requested);
  const output = new Map<string, boolean>();
  for (const relative of [...requested].sort(compareUtf8)) {
    output.set(relative, await safePathExists(projectRoot, relative));
  }
  return output;
}

function collectPathPredicates(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPathPredicates(item, output);
    return;
  }
  if (!isRecord(value)) return;
  if (value.op === "path_exists") {
    const raw = optionalString(value.value) ?? optionalString(value.path);
    const normalized = raw === undefined ? undefined : normalizedRelativePath(raw);
    if (normalized !== undefined) output.add(normalized);
  }
  for (const child of Object.values(value)) collectPathPredicates(child, output);
}

async function snapshotFilesystemManifests(
  configuration: CompiledConfiguration,
  graph: CompilerGraphProjection,
  projectRoot: string,
): Promise<Map<string, ConfigurationValue>> {
  const output = new Map<string, ConfigurationValue>();
  for (const node of graph.nodes()) {
    const definition = recordValue(
      configuration.registries.node_types[node.type]?.filesystem_manifest,
    );
    if (definition !== undefined)
      output.set(node.id, await deriveFilesystemManifest(node, definition, projectRoot));
  }
  return output;
}

/**
 * Compile the exact filesystem projection that a successful scoped review may accept.
 *
 * The content hash is derived from repository bytes and the authored node contract. The caller
 * remains responsible for proving that the review owns this node and for publishing the returned
 * compiler-owned field through graph CAS.
 */
export async function prepareFilesystemManifestAcceptance(
  configuration: CompiledConfiguration,
  node: CompilerGraphNode,
  projectRoot: string,
): Promise<FilesystemManifestAcceptance | undefined> {
  const canonicalRoot = await canonicalProjectRoot(projectRoot);
  const definition = recordValue(
    configuration.registries.node_types[node.type]?.filesystem_manifest,
  );
  if (definition === undefined) return undefined;
  const projected = await deriveFilesystemManifest(node, definition, canonicalRoot);
  const acceptanceError = "filesystem content hash requires scoped compiler acceptance";
  const blockingErrors = stringArray(projected.implementation_errors).filter(
    (error) => error !== acceptanceError,
  );
  if (blockingErrors.length > 0) {
    return {
      outputField: stringValue(definition.output_field),
      manifest: projected,
      blockingErrors,
    };
  }
  const contentHash = stringValue(projected.content_hash);
  const { hash: _priorHash, ...projectedWithoutHash } = projected;
  const material: ConfigurationObject = {
    ...projectedWithoutHash,
    accepted_content_hash: contentHash,
    implementation_status: "ready",
    implementation_errors: [],
  };
  return {
    outputField: stringValue(definition.output_field),
    manifest: { ...material, hash: canonicalHash(material) },
    blockingErrors: [],
  };
}

async function deriveFilesystemManifest(
  node: CompilerGraphNode,
  definition: ConfigurationObject,
  projectRoot: string,
): Promise<ConfigurationObject> {
  const errors = new Set<string>();
  const rootField = stringValue(definition.root_field);
  const rawRoot = optionalString(nodeField(node, rootField));
  const relativeRoot = rawRoot === undefined ? undefined : normalizedRelativePath(rawRoot);
  if (relativeRoot === undefined)
    errors.add(`${rootField} must be a nonempty project-relative path`);
  const prefixes = stringArray(definition.allowed_root_prefixes).flatMap((item) => {
    const normalized = normalizedRelativePath(item);
    return normalized === undefined ? [] : [normalized];
  });
  if (
    relativeRoot !== undefined &&
    prefixes.length > 0 &&
    !prefixes.some((prefix) => relativeRoot === prefix || relativeRoot.startsWith(`${prefix}/`))
  ) {
    errors.add(`filesystem root ${relativeRoot} is outside configured root prefixes`);
  }
  const scan = recordValue(definition.scan) ?? {};
  const rows: ConfigurationObject[] = [];
  if (relativeRoot !== undefined && errors.size === 0) {
    const root = path.join(projectRoot, ...relativeRoot.split("/"));
    if (!(await safePathExists(projectRoot, relativeRoot))) {
      errors.add(`filesystem root does not exist: ${relativeRoot}`);
    } else {
      const inferredFilesField = rootField.endsWith(".root")
        ? `${rootField.slice(0, -".root".length)}.files`
        : undefined;
      // Older durable Research runs predate the explicit files_field compiler option but already
      // carry the same implementation_plan.files contract. Honor that existing exact boundary so
      // a core upgrade can resume them without rehashing unrelated siblings under the shared root.
      const filesField =
        optionalString(definition.files_field) ??
        (inferredFilesField !== undefined && nodeField(node, inferredFilesField) !== undefined
          ? inferredFilesField
          : undefined);
      if (filesField === undefined) {
        await scanManifestRoot(root, relativeRoot, scan, rows, errors);
      } else {
        await scanManifestFiles(
          projectRoot,
          root,
          relativeRoot,
          nodeField(node, filesField),
          filesField,
          scan,
          rows,
          errors,
        );
      }
    }
  }
  rows.sort((left, right) => compareUtf8(String(left.path), String(right.path)));
  const contractField = stringValue(definition.implementation_contract_field);
  const contract = nodeField(node, contractField);
  if (!isRecord(contract)) errors.add(`${contractField} must be a mapping`);
  const kindField = stringValue(definition.implementation_kind_field);
  const implementationKind = optionalString(nodeField(node, kindField));
  if (implementationKind === undefined) errors.add(`${kindField} is required`);
  const entrypointField = stringValue(definition.implementation_entrypoints_field);
  const rawEntrypoints = nodeField(node, entrypointField);
  const entrypointPaths = Array.isArray(rawEntrypoints)
    ? rawEntrypoints.flatMap((item) => (typeof item === "string" ? [item] : []))
    : [];
  if (entrypointPaths.length === 0) errors.add(`${entrypointField} must be a nonempty list`);
  const inventory = new Map(rows.map((row) => [String(row.path), row]));
  const entrypoints: ConfigurationObject[] = [];
  for (const raw of [...new Set(entrypointPaths)].sort(compareUtf8)) {
    const normalized = normalizedRelativePath(raw);
    if (
      normalized === undefined ||
      relativeRoot === undefined ||
      !(normalized === relativeRoot || normalized.startsWith(`${relativeRoot}/`)) ||
      !inventory.has(normalized)
    ) {
      errors.add(`implementation entrypoint is invalid or missing: ${raw}`);
    } else {
      entrypoints.push(inventory.get(normalized)!);
    }
  }
  const contractFields = Object.fromEntries(
    stringArray(definition.contract_fields)
      .sort(compareUtf8)
      .map((field) => [field, nodeField(node, field) ?? null]),
  );
  const source = deriveSource(node, definition, rows, relativeRoot);
  if (source.vendorStatus !== "vendored")
    errors.add(`filesystem vendor status is not ready: ${source.vendorStatus}`);
  const contentHash = canonicalHash({
    root: relativeRoot ?? null,
    source: source.source,
    external: source.external,
    vendor_status: source.vendorStatus,
    implementation_kind: implementationKind ?? null,
    implementation_contract_hash: isRecord(contract) ? canonicalHash(contract) : null,
    contract_fields_hash: canonicalHash(contractFields),
    entrypoints,
    files: rows,
  });
  const outputField = stringValue(definition.output_field);
  const prior = recordValue(nodeField(node, outputField));
  const accepted = optionalString(prior?.accepted_content_hash);
  if (errors.size === 0 && accepted !== contentHash)
    errors.add("filesystem content hash requires scoped compiler acceptance");
  const material: ConfigurationObject = {
    schema_version: "1.0",
    root: relativeRoot ?? null,
    source: source.source,
    external: source.external,
    vendor_status: source.vendorStatus,
    implementation_status: errors.size === 0 ? "ready" : "incomplete",
    implementation_kind: implementationKind ?? null,
    implementation_contract_hash: isRecord(contract) ? canonicalHash(contract) : null,
    contract_fields_hash: canonicalHash(contractFields),
    content_hash: contentHash,
    accepted_content_hash: accepted ?? null,
    entrypoint_count: entrypoints.length,
    file_count: rows.length,
    implementation_errors: [...errors].sort(compareUtf8),
    entrypoints,
    files: rows,
  };
  return { ...material, hash: canonicalHash(material) };
}

/**
 * Inventory only the files owned by this manifest contract.
 *
 * Multiple assets may intentionally share a workspace root. Hashing every sibling under that
 * root makes a disjoint asset integration invalidate all previously accepted assets and causes
 * deterministic tickets to be reissued forever. An explicit files field is the compiler-owned
 * independence boundary: additions outside it are unrelated, while any owned-byte drift still
 * invalidates the acceptance hash.
 */
async function scanManifestFiles(
  projectRoot: string,
  root: string,
  relativeRoot: string,
  configuredFiles: ConfigurationValue | undefined,
  filesField: string,
  scan: ConfigurationObject,
  rows: ConfigurationObject[],
  errors: Set<string>,
): Promise<void> {
  if (
    !Array.isArray(configuredFiles) ||
    configuredFiles.length === 0 ||
    configuredFiles.some((item) => typeof item !== "string")
  ) {
    errors.add(`${filesField} must be a nonempty list of project-relative files`);
    return;
  }
  const rootReal = await realpath(root);
  let totalBytes = 0;
  for (const raw of [...new Set(configuredFiles as string[])].sort(compareUtf8)) {
    const normalized = normalizedRelativePath(raw);
    if (
      normalized === undefined ||
      !(normalized === relativeRoot || normalized.startsWith(`${relativeRoot}/`))
    ) {
      errors.add(`filesystem planned file is outside ${relativeRoot}: ${raw}`);
      continue;
    }
    const relativeParts = normalized
      .slice(relativeRoot.length)
      .replace(/^\/+/u, "")
      .split("/")
      .filter(Boolean);
    if (relativeParts.length === 0 || manifestIgnored(relativeParts, scan)) {
      errors.add(`filesystem planned file is excluded or not a file: ${raw}`);
      continue;
    }
    const absolute = path.join(projectRoot, ...normalized.split("/"));
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        errors.add(`filesystem planned file is not a regular file: ${normalized}`);
        continue;
      }
      const resolved = await realpath(absolute);
      const relativeToRoot = path.relative(rootReal, resolved);
      if (
        relativeToRoot === "" ||
        relativeToRoot === ".." ||
        relativeToRoot.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRoot)
      ) {
        errors.add(`filesystem planned file escapes its configured root: ${normalized}`);
        continue;
      }
      if (rows.length >= MAX_MANIFEST_FILES || totalBytes + metadata.size > MAX_MANIFEST_BYTES) {
        errors.add("filesystem inventory exceeds its bounded file or byte limit");
        return;
      }
      const bytes = await readFile(resolved);
      totalBytes += bytes.byteLength;
      rows.push({
        path: normalized,
        bytes: bytes.byteLength,
        sha256: rawSha256(bytes),
      });
    } catch {
      errors.add(`filesystem planned file is missing or unreadable: ${normalized}`);
    }
  }
}

async function scanManifestRoot(
  root: string,
  relativeRoot: string,
  scan: ConfigurationObject,
  rows: ConfigurationObject[],
  errors: Set<string>,
): Promise<void> {
  let totalBytes = 0;
  const walk = async (directory: string, relative: string[]): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const parts = [...relative, entry.name];
      if (manifestIgnored(parts, scan)) continue;
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) {
        errors.add(`filesystem inventory rejects symlink: ${[relativeRoot, ...parts].join("/")}`);
        continue;
      }
      if (metadata.isDirectory()) {
        await walk(child, parts);
        continue;
      }
      if (!metadata.isFile()) continue;
      if (rows.length >= MAX_MANIFEST_FILES || totalBytes + metadata.size > MAX_MANIFEST_BYTES) {
        errors.add("filesystem inventory exceeds its bounded file or byte limit");
        return;
      }
      const bytes = await readFile(child);
      totalBytes += bytes.byteLength;
      rows.push({
        path: [relativeRoot, ...parts].join("/"),
        bytes: bytes.byteLength,
        sha256: rawSha256(bytes),
      });
    }
  };
  await walk(root, []);
}

function manifestIgnored(parts: string[], scan: ConfigurationObject): boolean {
  const file = parts.at(-1) ?? "";
  if (stringArray(scan.ignored_file_names).includes(file)) return true;
  if (parts.some((part) => stringArray(scan.ignored_path_components).includes(part))) return true;
  if (
    stringArray(scan.ignored_suffixes).some((suffix) =>
      file.toLowerCase().endsWith(suffix.toLowerCase()),
    )
  )
    return true;
  const relative = parts.join("/");
  return stringArray(scan.ignored_path_prefixes).some(
    (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
  );
}

function deriveSource(
  node: CompilerGraphNode,
  definition: ConfigurationObject,
  rows: readonly ConfigurationObject[],
  relativeRoot: string | undefined,
): { source: string; external: boolean; vendorStatus: string } {
  const policy = recordValue(definition.source);
  if (policy === undefined)
    return {
      source: "unspecified",
      external: false,
      vendorStatus: rows.length === 0 ? "missing" : "vendored",
    };
  const source =
    optionalString(nodeField(node, stringValue(policy.field))) ??
    optionalString(policy.unspecified_value) ??
    "unspecified";
  const external = stringArray(policy.external_values).some(
    (item) => item.toLowerCase() === source.toLowerCase(),
  );
  const vendor = recordValue(policy.vendor);
  if (vendor === undefined)
    return { source, external, vendorStatus: rows.length === 0 ? "missing" : "vendored" };
  if (
    stringArray(vendor.blocked_reason_fields).some(
      (field) => optionalString(nodeField(node, field)) !== undefined,
    )
  ) {
    return { source, external, vendorStatus: "blocked" };
  }
  const expected = stringArray(vendor.path_fields).flatMap((field) => {
    const value = nodeField(node, field);
    if (typeof value === "string") return [value];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  });
  const inventory = new Set(rows.map((row) => String(row.path)));
  if (expected.length === 0)
    return { source, external, vendorStatus: rows.length === 0 ? "missing" : "vendored" };
  for (const raw of expected) {
    const normalized = normalizedRelativePath(raw);
    if (
      normalized === undefined ||
      relativeRoot === undefined ||
      !(normalized === relativeRoot || normalized.startsWith(`${relativeRoot}/`))
    )
      return { source, external, vendorStatus: "invalid_path" };
    if (!inventory.has(normalized)) return { source, external, vendorStatus: "missing" };
  }
  return { source, external, vendorStatus: "vendored" };
}

async function canonicalProjectRoot(root: string): Promise<string> {
  const canonical = await realpath(root);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("rule project root is not a regular directory");
  return canonical;
}

async function safePathExists(root: string, relative: string): Promise<boolean> {
  const normalized = normalizedRelativePath(relative);
  if (normalized === undefined) return false;
  let current = root;
  for (const segment of normalized.split("/")) {
    current = path.join(current, segment);
    const metadata = await lstat(current).catch(() => undefined);
    if (metadata === undefined || metadata.isSymbolicLink()) return false;
  }
  const canonical = await realpath(current).catch(() => undefined);
  return canonical !== undefined && isWithin(root, canonical);
}

function normalizedRelativePath(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\u0000") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("/") ||
    path.posix.normalize(trimmed) !== trimmed ||
    trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    return undefined;
  return trimmed;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function nodeField(node: CompilerGraphNode, field: string): ConfigurationValue | undefined {
  if (field === "id") return node.id;
  const { fields: _embeddedFields, ...material } = node as unknown as ConfigurationObject;
  const root: ConfigurationObject = {
    ...material,
    ...(node.fields ?? {}),
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: node.spec,
    edges: node.edges,
    ...(node.annotations === undefined ? {} : { annotations: node.annotations }),
  };
  let current: ConfigurationValue = root;
  for (const segment of field.replace(/^\$?\./u, "").split(".")) {
    if (!isRecord(current) || current[segment] === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function dynamicNodeField(
  node: CompilerGraphNode,
  field: string,
  variables: Readonly<Record<string, string>>,
): ConfigurationValue | undefined {
  let rendered = field;
  for (const [name, value] of Object.entries(variables))
    rendered = rendered.replaceAll(`$${name}`, value);
  const segments = rendered.replace(/^\$?\./u, "").match(/[^.[\]]+/gu) ?? [];
  let current: ConfigurationValue = {
    ...(node.fields ?? {}),
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: node.spec,
    edges: node.edges,
  };
  for (const segment of segments) {
    if (!isRecord(current) || current[segment] === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function fieldValues(node: CompilerGraphNode, field: string): ConfigurationValue[] {
  const segments = field.replace(/^\$?\./u, "").split(".");
  let values: ConfigurationValue[] = [
    {
      ...(node.fields ?? {}),
      id: node.id,
      type: node.type,
      title: node.title,
      status: node.status,
      spec: node.spec,
      edges: node.edges,
    },
  ];
  for (const segment of segments) {
    values = values.flatMap((value) => {
      if (segment === "*") return isRecord(value) ? Object.values(value) : [];
      return isRecord(value) && value[segment] !== undefined ? [value[segment]] : [];
    });
  }
  return values;
}

function firstStringField(node: CompilerGraphNode, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = nodeField(node, field);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function firstObjectString(
  object: ConfigurationObject,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = object[field];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function boundNode(context: RuleDomainContext, binding: string): CompilerGraphNode | undefined {
  const name = binding.replace(/^\$/u, "");
  const id = context.bindings[name]?.[0];
  return id === undefined ? undefined : context.node(id);
}

function countMatches(count: number, leaf: ConfigurationObject): boolean {
  if (typeof leaf.exact === "number" && count !== leaf.exact) return false;
  if (typeof leaf.min === "number" && count < leaf.min) return false;
  if (typeof leaf.max === "number" && count > leaf.max) return false;
  return true;
}

function compareScalar(
  left: ConfigurationValue | undefined,
  right: ConfigurationValue | undefined,
): number {
  if (
    (typeof left !== "string" && typeof left !== "number" && typeof left !== "boolean") ||
    (typeof right !== "string" && typeof right !== "number" && typeof right !== "boolean")
  )
    return 0;
  return compareUtf8(String(left), String(right));
}

function requiredValue(value: ConfigurationValue | undefined, label: string): ConfigurationValue {
  if (value === undefined) throw new Error(`${label} is missing`);
  return value;
}

function requiredRecord(value: ConfigurationValue | undefined, label: string): ConfigurationObject {
  const record = recordValue(value);
  if (record === undefined) throw new Error(`${label} must be a mapping`);
  return record;
}

function recordValue(value: unknown): ConfigurationObject | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("configured value must be a nonempty string");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function arrayValue(value: unknown): readonly ConfigurationValue[] {
  return Array.isArray(value) ? (value as readonly ConfigurationValue[]) : [];
}

function sorted(values: Set<string>): string[] {
  return [...values].sort(compareUtf8);
}

function isRecord(value: unknown): value is Record<string, ConfigurationValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
