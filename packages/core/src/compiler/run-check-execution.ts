import path from "node:path";
import { type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AuthorityGrant } from "../authority/grants.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  AgentCheckExecution,
  ResolvedAgentCheck,
  ResolvedAgentCheckCommand,
} from "../authority/run-engine.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type { CompilerGraphNode } from "../contracts/rules.js";
import { type DynamicGraphSelectionRequest } from "../graph/context-selector.js";
import {
  type TypedGraph,
  type ContextualRecordProvenance,
  type GraphContextualState,
  type GraphNode,
} from "../graph/model.js";
import { type AgentLaunchSpec } from "../pi/launch-spec.js";
import {
  canonicalHash,
  isSha256Digest,
  rawSha256,
  type Sha256Digest,
} from "../shared/canonical.js";
import type { CompilerDiagnostic, ValidationResult } from "../shared/diagnostics.js";
import {
  type ApprovedChangeMaterialization,
  type ChangeControlPublication,
} from "../state/change-control.js";
import {
  type AgentAttemptRecord,
  type AttemptStatus,
  type RunActivityRecord,
  type RunRecord,
  type TicketRecord,
} from "../state/run-record.js";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createPolicySelectionRuleDomainAdapter,
  createProductionRuleDomainAdapter,
  createRuleAuthorityEvidence,
  ruleInputGraphSha256,
  rulePredicateBindingNames,
  rulePredicateEvidenceKey,
  type RuleAuthorityEvidence,
  type RulePredicateEvidence,
} from "./domain-adapter.js";
import {
  compileExecutionSemanticCatalog,
  type CompiledExecutionSemanticCatalog,
} from "./execution-semantics.js";
import { GraphExpressionEvaluator } from "./expressions.js";

import {
  MAX_CONTEXT_BYTES,
  MAX_RUN_GRAPH_BYTES,
  NativeRunProgramError,
  type AttemptDescriptor,
  type GraphArtifact,
  type GraphNoteArtifact,
  type ProofPreparationReviewCandidate,
} from "./run-program-contracts.js";
export interface CompiledCheckCommandExecution {
  accepted: boolean;
  passed: boolean;
  infrastructureFailure?: string;
  value: JsonValue;
  evidence: ConfigurationObject;
}

/**
 * A configured nonzero exit is useful evidence only after the repository-native runner reached
 * the subject it was meant to evaluate. These signatures describe command, sandbox, dependency,
 * or test-collection failures that occur before a focused assertion can establish an honest red.
 * Keep this deliberately narrower than general test failures: semantic wrong-reason review still
 * belongs to the configured reviewer.
 */
export function commandInfrastructureFailure(
  stdout: string,
  stderr: string,
  declaredInputPaths: readonly string[] = [],
): string | undefined {
  const rawOutput = `${stdout}\n${stderr}`;
  const output = rawOutput.toLocaleLowerCase("en-US");
  const contains = (needle: string): boolean => output.includes(needle);
  let cause: string | undefined;
  if (contains("process.cwd failed") || contains("uv_cwd")) {
    cause = "the runtime could not resolve its working directory";
  } else if (contains("error: eperm:") && contains("operation not permitted")) {
    cause = "the runtime was denied a required sandbox resource";
  } else if (
    // A failed subprocess spawn happens before the test runner loads, so it can never be a
    // legitimate test result. Package managers also append generic child-exit wrappers such as
    // ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL after a runner has produced an admissible expected red;
    // the concrete spawn, command, dependency, and collection diagnostics below—not that wrapper
    // alone—determine whether execution failed before reaching the subject.
    contains("spawn eperm") ||
    contains("spawn eacces") ||
    contains("node_modules missing") ||
    /(?:^|\n)(?:sh|bash|zsh): [^\n]+: command not found(?:\n|$)/u.test(output) ||
    (contains("corepack") && (contains("eperm") || contains("eacces") || contains("cannot create")))
  ) {
    cause = "the check runner failed to launch (package-manager or subprocess spawn error)";
  } else if (
    contains("startup error") ||
    contains("getaddrinfo enotfound") ||
    contains("getaddrinfo eai_")
  ) {
    cause = "the configured runtime failed during startup";
  } else if (contains("invalid environment variables")) {
    cause = "the configured test environment was invalid";
  } else if (
    contains("tests  no tests") ||
    contains("no test files found") ||
    contains("no tests found") ||
    contains("your test suite must contain at least one test")
  ) {
    cause = "the configured test runner did not execute a test";
  } else if (
    contains("bad interpreter: no such file or directory") ||
    ((contains("/usr/bin/env:") || contains("env:")) && contains("no such file or directory"))
  ) {
    cause = "the configured command interpreter was unavailable";
  } else if (
    contains("err_module_not_found") ||
    contains("cannot find module") ||
    contains("cannot find package") ||
    contains("modulenotfounderror: no module named") ||
    contains("failed to resolve import") ||
    contains("failed to load url")
  ) {
    if (onlyDeclaredLocalModulesAreMissing(rawOutput, declaredInputPaths)) {
      cause = undefined;
    } else {
      cause = "the configured test graph could not load one of its modules";
    }
  }
  if (
    cause === undefined &&
    (contains("referenceerror: react is not defined") ||
      contains("objects are not valid as a react child") ||
      contains("element type is invalid:") ||
      contains("invalid hook call"))
  ) {
    cause = "the configured test harness failed before its focused assertions ran";
  }
  return cause === undefined
    ? undefined
    : `command infrastructure failed before producing an admissible expected result: ${cause}`;
}

/**
 * A red-green proof may intentionally import a not-yet-created local production source. That is
 * admissible only when the missing relative import resolves exactly to a compiler-declared input
 * path. Ambient packages, undeclared local files, ambiguous diagnostics, and mixed harness errors
 * remain infrastructure failures.
 */
export function onlyDeclaredLocalModulesAreMissing(
  output: string,
  declaredInputPaths: readonly string[],
): boolean {
  if (declaredInputPaths.length === 0) return false;
  const foldedOutput = output.toLocaleLowerCase("en-US");
  const missingModulePattern =
    /cannot find module\s+['"]([^'"]+)['"]\s+imported from\s+['"]([^'"]+)['"]/giu;
  const matches = [...output.matchAll(missingModulePattern)];
  if (matches.length === 0) return false;
  // Node/Vite attach ERR_MODULE_NOT_FOUND to both ambient dependency failures and an honest
  // not-yet-created relative production import. The exact specifier/importer proof below is the
  // authority boundary; the generic code marker alone must not override it.
  if (
    foldedOutput.includes("cannot find package") ||
    foldedOutput.includes("failed to resolve import")
  ) {
    return false;
  }

  const normalizedInputs = [
    ...new Set(declaredInputPaths.map((candidate) => candidate.replaceAll("\\", "/"))),
  ];
  const allowedSpecifiers = new Set<string>();
  for (const match of matches) {
    const specifier = match[1]!;
    const importer = match[2]!.replaceAll("\\", "/");
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
    const importerPath = normalizedInputs.find(
      (candidate) => importer === candidate || importer.endsWith(`/${candidate}`),
    );
    if (importerPath === undefined) return false;
    const unresolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(importerPath), specifier),
    );
    if (unresolved === ".." || unresolved.startsWith("../") || path.posix.isAbsolute(unresolved))
      return false;
    const declared = normalizedInputs.some(
      (candidate) =>
        candidate === unresolved ||
        stripModuleExtension(candidate) === stripModuleExtension(unresolved),
    );
    if (!declared) return false;
    allowedSpecifiers.add(specifier.toLocaleLowerCase("en-US"));
  }

  // Test reporters can echo a shortened form of the same causal error before the complete
  // specifier/importer diagnostic. Admit only an unmistakably truncated prefix of a module that
  // the complete diagnostics above already bound to an exact declared input. Any other unmatched
  // missing-module marker remains an infrastructure failure.
  const unmatchedOutput = output.replace(missingModulePattern, "");
  const unmatchedMarkerCount =
    unmatchedOutput.toLocaleLowerCase("en-US").match(/cannot find module/gu)?.length ?? 0;
  const truncatedEchoes = [
    ...unmatchedOutput.matchAll(/cannot find module\s+['"]([^'"\n]*?)(?:…|\.\.\.)/giu),
  ];
  if (
    truncatedEchoes.length !== unmatchedMarkerCount ||
    truncatedEchoes.some((match) => {
      const prefix = match[1]!.toLocaleLowerCase("en-US");
      return ![...allowedSpecifiers].some((specifier) => specifier.startsWith(prefix));
    })
  ) {
    return false;
  }

  const failedLoads = [...output.matchAll(/failed to load url\s+([^\s(]+)/giu)];
  return failedLoads.every((match) => allowedSpecifiers.has(match[1]!.toLocaleLowerCase("en-US")));
}

export function stripModuleExtension(value: string): string {
  return value.replace(/\.(?:[cm]?[jt]sx?|json)$/u, "");
}

export function formatResultSchemaLiteral(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return String(value);
  return encoded.length <= 120 ? encoded : `${encoded.slice(0, 117)}...`;
}

export function resultSchemaMismatchDiagnostics(schema: TSchema, result: unknown): string[] {
  const mismatches = new Map<string, { allowed: string[]; messages: string[] }>();
  for (const error of Value.Errors(schema, result)) {
    const instancePath = error.instancePath.length === 0 ? "/" : error.instancePath;
    const mismatch = mismatches.get(instancePath) ?? { allowed: [], messages: [] };
    if (error.keyword === "const") {
      mismatch.allowed.push(formatResultSchemaLiteral(error.params.allowedValue));
    } else if (error.keyword === "enum") {
      mismatch.allowed.push(
        ...error.params.allowedValues.map((value) => formatResultSchemaLiteral(value)),
      );
    } else if (error.keyword !== "anyOf") {
      mismatch.messages.push(error.message);
    }
    mismatches.set(instancePath, mismatch);
  }

  return [...mismatches.entries()].slice(0, 5).map(([instancePath, mismatch]) => {
    const allowed = [...new Set(mismatch.allowed)].slice(0, 10);
    if (allowed.length === 1)
      return `result schema mismatch at ${instancePath}: expected ${allowed[0]}`;
    if (allowed.length > 1)
      return `result schema mismatch at ${instancePath}: expected one of ${allowed.join(", ")}`;
    const message = [...new Set(mismatch.messages)][0] ?? "value is invalid";
    return `result schema mismatch at ${instancePath}: ${message}`;
  });
}

export function compileCheckCommandExecution(
  command: ResolvedAgentCheckCommand,
  execution: AgentCheckExecution,
  index: number,
  configuration: CompiledConfiguration,
  descriptor: AttemptDescriptor,
): CompiledCheckCommandExecution {
  if (
    execution.checkId !== command.checkId ||
    execution.definitionHash !== command.definitionHash ||
    execution.argv.length !== command.argv.length ||
    execution.argv[0] !== execution.resolvedExecutable ||
    canonicalHash(execution.argv.slice(1)) !== canonicalHash(command.argv.slice(1))
  )
    fail(
      "check_execution_identity",
      `check execution ${index} does not match its compiler-resolved command`,
    );
  const hasAttemptNumber = execution.attemptNumber !== undefined;
  const hasRetryAudit = execution.retryAuditSha256 !== undefined;
  if (hasAttemptNumber !== hasRetryAudit) {
    fail(
      "check_execution_retry",
      `check execution ${index} must bind attempt number and retry audit together`,
    );
  }
  if (
    hasAttemptNumber &&
    (!Number.isSafeInteger(execution.attemptNumber) ||
      execution.attemptNumber! < 1 ||
      execution.attemptNumber! > 3 ||
      !isSha256Digest(execution.retryAuditSha256))
  ) {
    fail("check_execution_retry", `check execution ${index} has invalid retry audit authority`);
  }
  if (
    !isIsoTimestamp(execution.startedAt) ||
    !isIsoTimestamp(execution.completedAt) ||
    Date.parse(execution.completedAt) < Date.parse(execution.startedAt)
  ) {
    fail("check_execution_time", `check execution ${index} has invalid authority timestamps`);
  }
  if (
    typeof execution.resolvedExecutable !== "string" ||
    !path.isAbsolute(execution.resolvedExecutable) ||
    execution.resolvedExecutable.includes("\u0000") ||
    !isSha256Digest(execution.environmentSha256) ||
    !isSha256Digest(execution.preManifestSha256) ||
    !isSha256Digest(execution.postManifestSha256) ||
    !isSha256Digest(execution.sandboxProfileSha256) ||
    typeof execution.sandboxKind !== "string" ||
    execution.sandboxKind.trim().length === 0
  )
    fail(
      "check_execution_authority",
      `check execution ${index} has invalid sandbox or environment provenance`,
    );
  if (
    Buffer.byteLength(execution.stdout, "utf8") > 16 * 1024 * 1024 ||
    Buffer.byteLength(execution.stderr, "utf8") > 16 * 1024 * 1024 ||
    execution.stdoutSizeBytes !== Buffer.byteLength(execution.stdout, "utf8") ||
    execution.stderrSizeBytes !== Buffer.byteLength(execution.stderr, "utf8") ||
    rawSha256(execution.stdout) !== execution.stdoutSha256 ||
    rawSha256(execution.stderr) !== execution.stderrSha256
  ) {
    fail(
      "check_execution_stream",
      `check execution ${index} stream bytes do not match their authority hashes`,
    );
  }
  const errors: string[] = [];
  const exitAccepted =
    execution.signal === null &&
    execution.exitCode !== null &&
    command.expectedExitCodes.includes(execution.exitCode);
  if (!exitAccepted)
    errors.push(
      `exit ${execution.exitCode ?? execution.signal ?? "unknown"} is outside the configured contract`,
    );
  const infrastructureFailure =
    execution.exitCode !== null && execution.exitCode !== 0
      ? commandInfrastructureFailure(execution.stdout, execution.stderr, command.inputPaths)
      : undefined;
  if (infrastructureFailure !== undefined) errors.push(infrastructureFailure);
  if (
    command.effect === "read_only" &&
    execution.preManifestSha256 !== execution.postManifestSha256
  ) {
    errors.push("read-only check changed the workspace manifest");
  }
  if (
    execution.resultSource.kind !== command.resultSource.kind ||
    (command.resultSource.kind === "file" &&
      execution.resultSource.path !== command.resultSource.path) ||
    !isSha256Digest(execution.resultSource.bytesSha256) ||
    !Number.isSafeInteger(execution.resultSource.sizeBytes) ||
    execution.resultSource.sizeBytes < 0
  )
    fail(
      "check_result_source",
      `check execution ${index} result source is not the compiler-resolved source`,
    );
  if (
    command.resultSource.kind === "stdout" &&
    (execution.resultSource.bytesSha256 !== execution.stdoutSha256 ||
      execution.resultSource.sizeBytes !== Buffer.byteLength(execution.stdout, "utf8"))
  )
    fail(
      "check_result_source",
      `check execution ${index} stdout result bytes are not authority-bound`,
    );
  const resultRequired =
    command.resultProtocol !== undefined ||
    command.resultSchema !== undefined ||
    command.requiredResultFields.length > 0 ||
    command.outputArtifactSelector !== undefined;
  let result = execution.resultSource.value;
  if (resultRequired && command.resultSource.kind === "stdout") {
    try {
      const parsed = JSON.parse(execution.stdout) as unknown;
      assertJsonValue(parsed, `${command.checkId} stdout result`);
      if (canonicalHash(parsed) !== canonicalHash(result))
        errors.push("authority-parsed stdout result differs from stdout bytes");
      result = parsed;
    } catch {
      errors.push("stdout is not one complete JSON result");
    }
  }
  const resultObject = isRecord(result) ? result : undefined;
  if (resultRequired && resultObject === undefined)
    errors.push("configured result must be an object");
  if (command.resultProtocol !== undefined && resultObject?.protocol !== command.resultProtocol) {
    errors.push(`result protocol is not ${command.resultProtocol}`);
  }
  for (const field of command.requiredResultFields) {
    if (resultObject?.[field] === undefined) errors.push(`result is missing ${field}`);
  }
  if (command.resultSchema !== undefined) {
    try {
      if (!Value.Check(command.resultSchema as TSchema, result)) {
        const diagnostics = resultSchemaMismatchDiagnostics(
          command.resultSchema as TSchema,
          result,
        );
        errors.push(
          ...(diagnostics.length > 0
            ? diagnostics
            : ["result does not match the configured schema"]),
        );
      }
    } catch {
      fail(
        "check_result_schema",
        `compiled result schema for ${command.checkId} is not executable`,
      );
    }
  }
  const definition = configuration.registries.checks[command.checkId];
  if (definition === undefined) {
    fail(
      "check_definition_drift",
      `check ${command.checkId} definition changed during result compilation`,
    );
  }
  const definitionCurrent =
    command.executionPolicy === undefined
      ? canonicalHash(definition) === command.definitionHash
      : (() => {
          const semantics = requireExecutionSemanticCatalog(configuration).checks[command.checkId];
          return (
            semantics !== undefined &&
            semantics.sha256 === command.definitionHash &&
            semantics.sha256 === command.executionPolicy.checkSha256
          );
        })();
  if (!definitionCurrent) {
    fail(
      "check_definition_drift",
      `check ${command.checkId} definition changed during result compilation`,
    );
  }
  validateDynamicCheckResult(definition, resultObject, descriptor, command, errors);
  const acceptance = optionalRecord(definition.result_acceptance);
  let semanticPassing = true;
  if (acceptance !== undefined) {
    const field = requiredNonempty(acceptance.field, `${command.checkId} result acceptance field`);
    const values = Array.isArray(acceptance.values) ? acceptance.values : [];
    semanticPassing =
      resultObject !== undefined &&
      values.some((value) => canonicalHash(value) === canonicalHash(resultObject[field] ?? null));
  }
  const outputFiles = validateCheckOutputFiles(
    execution.outputFiles,
    command,
    resultObject,
    errors,
  );
  const contractValid = errors.length === 0;
  const passed = contractValid && exitAccepted && semanticPassing;
  const accepted =
    contractValid && exitAccepted && (semanticPassing || command.allowNonpassingReceipt);
  const value: JsonValue = {
    checkId: command.checkId,
    accepted,
    passed,
    exitCode: execution.exitCode,
    signal: execution.signal,
    result,
    outputFiles,
    errors,
  };
  return {
    accepted,
    passed,
    ...(infrastructureFailure === undefined ? {} : { infrastructureFailure }),
    value,
    evidence: {
      checkId: command.checkId,
      definitionHash: command.definitionHash,
      commandSha256: canonicalHash(command),
      ...(execution.attemptNumber === undefined
        ? {}
        : {
            attemptNumber: execution.attemptNumber,
            retryAuditSha256: execution.retryAuditSha256!,
          }),
      argvSha256: canonicalHash(command.argv),
      resolvedExecutable: execution.resolvedExecutable,
      environmentSha256: execution.environmentSha256,
      sandboxKind: execution.sandboxKind,
      sandboxProfileSha256: execution.sandboxProfileSha256,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdoutSha256: execution.stdoutSha256,
      stderrSha256: execution.stderrSha256,
      preManifestSha256: execution.preManifestSha256,
      postManifestSha256: execution.postManifestSha256,
      resultSource: execution.resultSource,
      outputFiles: outputFiles,
      accepted,
      passed,
      errors,
    },
  };
}

export function validateDynamicCheckResult(
  definition: ConfigurationObject,
  result: Record<string, unknown> | undefined,
  descriptor: AttemptDescriptor,
  command: ResolvedAgentCheckCommand,
  errors: string[],
): void {
  if (result === undefined) return;
  const identityField = optionalString(definition.result_identity_field);
  if (identityField !== undefined) {
    const targets = descriptor.definition?.target_node_ids ?? [];
    if (targets.length !== 1 || result[identityField] !== targets[0]) {
      errors.push(`result ${identityField} is not the exact compiler target identity`);
    }
  }
  const dynamic = optionalRecord(definition.dynamic_result);
  const requiredKeys = optionalRecord(dynamic?.required_keys);
  if (requiredKeys !== undefined) {
    const source = optionalRecord(requiredKeys.source);
    const actualField = requiredNonempty(
      requiredKeys.actual_field,
      `${command.checkId} dynamic actual field`,
    );
    const root = descriptor.graph === undefined ? undefined : ticketCommandRoot(descriptor);
    const expected =
      source === undefined || root === undefined
        ? undefined
        : dynamicValuePath(
            root,
            requiredNonempty(source.field, `${command.checkId} required key source`),
            {},
          );
    const actual = result[actualField];
    if (
      !Array.isArray(expected) ||
      expected.some((item) => typeof item !== "string") ||
      !isRecord(actual)
    ) {
      errors.push("dynamic required-key contract could not be resolved");
    } else if ((expected as string[]).some((key) => actual[key] === undefined)) {
      errors.push(`result ${actualField} does not contain every compiler-required key`);
    }
  }
}

export function validateCheckOutputFiles(
  files: AgentCheckExecution["outputFiles"],
  command: ResolvedAgentCheckCommand,
  result: Record<string, unknown> | undefined,
  errors: string[],
): Array<{ path: string; sha256: Sha256Digest; sizeBytes: number }> {
  const output = files
    .map((file) => {
      const normalized = normalizeCheckPath(file.path, `${command.checkId} output artifact`);
      if (
        !isSha256Digest(file.sha256) ||
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0
      ) {
        fail(
          "check_output_file",
          `check ${command.checkId} has invalid authority output-file metadata`,
        );
      }
      if (command.effect !== "workspace_write")
        errors.push("read-only check reported output files");
      else
        assertPathInScopes(normalized, command.outputPaths, `${command.checkId} output artifact`);
      return { path: normalized, sha256: file.sha256, sizeBytes: file.sizeBytes };
    })
    .sort((left, right) => compareText(left.path, right.path));
  if (new Set(output.map((file) => file.path)).size !== output.length) {
    fail("check_output_file", `check ${command.checkId} reported duplicate output files`);
  }
  const selector = command.outputArtifactSelector;
  if (selector !== undefined) {
    const raw = result?.[selector.field];
    if (!Array.isArray(raw)) {
      errors.push(`result ${selector.field} is not an artifact list`);
    } else {
      const expected: string[] = [];
      for (const item of raw) {
        const pathValue =
          typeof item === "string" && selector.allowPathStrings
            ? item
            : isRecord(item)
              ? item[selector.pathField]
              : undefined;
        if (typeof pathValue !== "string") {
          errors.push(`result ${selector.field} contains an invalid artifact path`);
          continue;
        }
        expected.push(normalizeCheckPath(pathValue, `${command.checkId} result artifact`));
      }
      if (
        canonicalHash([...new Set(expected)].sort(compareText)) !==
        canonicalHash(output.map((file) => file.path))
      ) {
        errors.push("authority output-file inventory differs from the typed result artifacts");
      }
    }
  }
  return output;
}

export function ticketCommandRoot(descriptor: AttemptDescriptor): ConfigurationValue | undefined {
  if (descriptor.graph === undefined) return undefined;
  const ids = descriptor.definition?.target_node_ids ?? [];
  if (ids.length !== 1) return undefined;
  return descriptor.graph.node(ids[0]!)?.spec;
}

export async function evaluateRequestedGraphCheck(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  projectRoot: string,
  checkId: string,
  targetIds: readonly string[],
): Promise<boolean> {
  const definition = configuration.registries.checks[checkId];
  if (
    definition === undefined ||
    definition.kind !== "graph" ||
    definition.predicate === undefined ||
    targetIds.length === 0
  ) {
    return false;
  }
  const adapter = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot });
  const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);
  return [...new Set(targetIds)].every((id) =>
    evaluator.withBinding("target", [id], () => evaluator.evaluate(definition.predicate!)),
  );
}

export function mergeCheckRuleEvidence(input: {
  prior: RuleAuthorityEvidence | undefined;
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  descriptor: AttemptDescriptor;
  resolved: ResolvedAgentCheck;
  accepted: boolean;
  passed: boolean;
  evidenceId: string;
  recordedAt: string;
}): RuleAuthorityEvidence {
  const inputGraphSha256 = ruleInputGraphSha256(input.configuration, input.graph);
  const predicates = structuredClone(input.prior?.predicates ?? {}) as Record<
    Sha256Digest,
    import("./domain-adapter.js").RulePredicateEvidence
  >;
  const receiptTypes = new Set(input.resolved.commands.map((command) => command.receiptType));
  const gatePolicies = new Set(
    input.resolved.commands.flatMap((command) => {
      const source = optionalRecord(
        input.configuration.registries.checks[command.checkId]?.command_source,
      );
      const policy = optionalString(source?.gate_policy);
      return policy === undefined ? [] : [policy];
    }),
  );
  const leaves: Array<{ leaf: ConfigurationObject; result: boolean }> = [];
  collectEvidenceLeaves(
    input.configuration.registries,
    input.resolved,
    receiptTypes,
    gatePolicies,
    input.accepted,
    input.passed,
    leaves,
  );
  if (
    !leaves.some(
      (item) =>
        item.leaf.op === "check_passed" && item.leaf.check === input.resolved.requestedCheckId,
    )
  ) {
    leaves.push({
      leaf: { op: "check_passed", check: input.resolved.requestedCheckId },
      result: input.passed,
    });
  }
  const targets = evidenceSubjectNodeIds(
    input.configuration,
    input.graph,
    input.descriptor,
    input.resolved.requestedCheckId,
  );
  for (const subjectNodeId of [...new Set(targets)].sort(compareText)) {
    for (const { leaf, result } of leaves) {
      const bindings = Object.fromEntries(
        [...rulePredicateBindingNames(leaf)]
          .sort(compareText)
          .map((name) => [name, [subjectNodeId]]),
      );
      const key = rulePredicateEvidenceKey({
        configurationSha256: input.configuration.configuration_sha256,
        inputGraphSha256,
        leaf,
        subjectNodeId,
        bindings,
      });
      predicates[key] = {
        key,
        result,
        recordedAt: input.recordedAt,
        sourceReceiptIds: [input.evidenceId],
        leaf: structuredClone(leaf),
        subjectNodeId,
        bindings,
      };
    }
  }
  return createRuleAuthorityEvidence({
    protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
    configurationSha256: input.configuration.configuration_sha256,
    inputGraphSha256,
    predicates,
  });
}

export function collectProofPreparationLeaves(
  configuration: CompiledConfiguration,
): ConfigurationObject[] {
  const unique = new Map<Sha256Digest, ConfigurationObject>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.op === "proof_preparation_current") {
      const leaf = structuredClone(value) as ConfigurationObject;
      unique.set(canonicalHash(leaf), leaf);
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const registry of Object.values(configuration.registries)) visit(registry);
  return [...unique.values()].sort((left, right) =>
    compareText(canonicalHash(left), canonicalHash(right)),
  );
}

export function withRuleBindings<Value>(
  evaluator: GraphExpressionEvaluator,
  bindings: Readonly<Record<string, readonly string[]>>,
  evaluate: () => Value,
): Value {
  const entries = Object.entries(bindings).sort(([left], [right]) => compareText(left, right));
  const descend = (index: number): Value => {
    const entry = entries[index];
    if (entry === undefined) return evaluate();
    return evaluator.withBinding(entry[0], entry[1], () => descend(index + 1));
  };
  return descend(0);
}

export function allReviewCandidates(run: RunRecord): ProofPreparationReviewCandidate[] {
  const attemptOrder = new Map(Object.keys(run.attempts).map((id, index) => [id, index]));
  const candidates: ProofPreparationReviewCandidate[] = [];
  for (const ticket of Object.values(run.tickets)) {
    for (const step of ticket.steps.filter((candidate) => candidate.kind === "review")) {
      for (const attemptId of step.attemptIds) {
        const attempt = run.attempts[attemptId];
        if (attempt === undefined || attempt.ticketId !== ticket.id || attempt.stepId !== step.id)
          continue;
        candidates.push({
          ticket,
          step,
          attempt,
          attemptOrder: attemptOrder.get(attempt.id) ?? -1,
        });
      }
    }
  }
  return candidates.sort(
    (left, right) =>
      left.attemptOrder - right.attemptOrder || compareText(left.attempt.id, right.attempt.id),
  );
}

export function latestReviewCandidate(
  run: RunRecord,
  operationId: string,
  subjectId: string,
  attemptOrder: ReadonlyMap<string, number>,
): ProofPreparationReviewCandidate | undefined {
  const candidates: ProofPreparationReviewCandidate[] = [];
  for (const ticket of Object.values(run.tickets)) {
    if (ticket.operationId !== operationId || !ticket.targetNodeIds.includes(subjectId)) continue;
    for (const step of ticket.steps.filter((candidate) => candidate.kind === "review")) {
      for (const attemptId of step.attemptIds) {
        const attempt = run.attempts[attemptId];
        if (attempt === undefined || attempt.ticketId !== ticket.id || attempt.stepId !== step.id)
          continue;
        candidates.push({
          ticket,
          step,
          attempt,
          attemptOrder: attemptOrder.get(attempt.id) ?? -1,
        });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.attemptOrder - right.attemptOrder || compareText(left.attempt.id, right.attempt.id),
  );
  return candidates.at(-1);
}

/** Pure replay of configured compiler-owned review effects for one already-selected node. */
export function projectPassedReviewEffects(
  configuration: CompiledConfiguration,
  operationId: string,
  reviewed: GraphNode,
  reviewId: string,
  actor: string,
): GraphNode | undefined {
  const operation = configuration.registries.operations[operationId];
  if (operation === undefined || !Array.isArray(operation.review_effects)) return undefined;
  let current = structuredClone(reviewed);
  let applied = false;
  for (const rawEffect of operation.review_effects) {
    const effect = optionalRecord(rawEffect);
    const select = optionalRecord(effect?.select);
    if (effect?.verdict !== "passed" || select === undefined) continue;
    const nodeTypes = Array.isArray(select.node_types)
      ? new Set(select.node_types.filter((value): value is string => typeof value === "string"))
      : new Set<string>();
    if (
      (nodeTypes.size > 0 && !nodeTypes.has(current.type)) ||
      !predicateMatches(current, optionalRecord(select.predicate))
    )
      continue;
    const preconditions = Array.isArray(effect.preconditions) ? effect.preconditions : [];
    if (
      preconditions.some((value) => {
        const predicate = optionalRecord(value);
        return predicate === undefined || !predicateMatches(current, predicate);
      })
    )
      return undefined;
    const set = optionalRecord(effect.set);
    if (set === undefined) return undefined;
    for (const [field, value] of Object.entries(set)) {
      const resolved = resolveReviewEffectTokens(value, reviewId, actor);
      if (field === "status") current.status = requiredNonempty(resolved, "review effect status");
      else if (field.startsWith("spec."))
        setNestedSpec(current.spec, field.slice("spec.".length), resolved);
      else return undefined;
    }
    applied = true;
  }
  return applied ? current : undefined;
}

export function sourceByteEntries(value: unknown): Array<{
  path: string;
  kind: string;
  sizeBytes?: number;
  sha256?: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const entry = requiredRecord(item, "proof preparation source manifest entry");
    const projected: { path: string; kind: string; sizeBytes?: number; sha256?: string } = {
      path: requiredNonempty(entry.path, "proof preparation source path"),
      kind: requiredNonempty(entry.kind, "proof preparation source kind"),
    };
    if (typeof entry.sizeBytes === "number") projected.sizeBytes = entry.sizeBytes;
    if (typeof entry.sha256 === "string") projected.sha256 = entry.sha256;
    return projected;
  });
}

export function evidenceSubjectNodeIds(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  descriptor: AttemptDescriptor,
  requestedCheckId: string,
): string[] {
  const targets = descriptor.definition?.target_node_ids ?? descriptor.readNodeIds;
  const definition = configuration.registries.checks[requestedCheckId];
  const graphSet = optionalRecord(definition?.graph_set);
  if (definition?.kind !== "composite" || graphSet?.members === undefined) {
    return [...new Set(targets)].filter((id) => graph.node(id) !== undefined).sort(compareText);
  }
  const evaluator = new GraphExpressionEvaluator(configuration, graph);
  const memberTypes = new Set(
    stringArray(graphSet.member_node_types, `${requestedCheckId} member node types`),
  );
  const excluded = new Set(
    stringArray(graphSet.status_excluding, `${requestedCheckId} excluded statuses`),
  );
  return evaluator
    .withBinding("target", targets, () => evaluator.select(graphSet.members!))
    .filter((id) => {
      const node = graph.node(id);
      return (
        node !== undefined &&
        (memberTypes.size === 0 || memberTypes.has(node.type)) &&
        !excluded.has(node.status)
      );
    })
    .filter((id, index, values) => values.indexOf(id) === index)
    .sort(compareText);
}

export function collectEvidenceLeaves(
  value: unknown,
  resolved: ResolvedAgentCheck,
  receiptTypes: ReadonlySet<string>,
  gatePolicies: ReadonlySet<string>,
  accepted: boolean,
  passed: boolean,
  output: Array<{ leaf: ConfigurationObject; result: boolean }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value)
      collectEvidenceLeaves(item, resolved, receiptTypes, gatePolicies, accepted, passed, output);
    return;
  }
  if (!isRecord(value)) return;
  const op = value.op;
  if (op === "check_passed" && value.check === resolved.requestedCheckId) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: passed });
  } else if (op === "check_has_current_terminal" && value.check === resolved.requestedCheckId) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: accepted });
  } else if (
    op === "current_receipt" &&
    typeof value.receipt_type === "string" &&
    receiptTypes.has(value.receipt_type)
  ) {
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: accepted });
  } else if (
    (op === "gate_policy_has_current_terminal" || op === "gate_policy_satisfied") &&
    typeof value.gate_policy === "string" &&
    gatePolicies.has(value.gate_policy)
  ) {
    output.push({
      leaf: structuredClone(value) as ConfigurationObject,
      result: op === "gate_policy_satisfied" ? passed : accepted,
    });
  } else if (
    op === "gate_policy_receipt_refused" &&
    typeof value.gate_policy === "string" &&
    gatePolicies.has(value.gate_policy)
  ) {
    // A refused receipt (contract failure) is durably distinct from "never ran": evidence exists
    // with a false acceptance. Without this leaf that distinction is invisible to rules, and a
    // gate whose verifier cannot produce a valid receipt re-emits its run-gate ticket forever
    // while no operation with write access is ever told to repair the verifier.
    output.push({ leaf: structuredClone(value) as ConfigurationObject, result: !accepted });
  }
  for (const child of Object.values(value))
    collectEvidenceLeaves(child, resolved, receiptTypes, gatePolicies, accepted, passed, output);
}

export function runRuleEvidence(
  run: RunRecord,
  configurationSha256: Sha256Digest,
  inputGraphSha256: Sha256Digest,
): RuleAuthorityEvidence | undefined {
  const value = run.ruleAuthorityEvidence;
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.protocol !== RULE_AUTHORITY_EVIDENCE_PROTOCOL ||
    !isSha256Digest(value.configurationSha256) ||
    !isSha256Digest(value.inputGraphSha256) ||
    !isSha256Digest(value.evidenceSha256) ||
    !isRecord(value.predicates)
  ) {
    fail("rule_evidence_shape", "durable rule-authority evidence is malformed");
  }
  const { evidenceSha256, ...material } = structuredClone(value);
  if (canonicalHash(material) !== evidenceSha256)
    fail("rule_evidence_hash", "durable rule-authority evidence failed its integrity hash");
  if (
    value.configurationSha256 !== configurationSha256 ||
    value.inputGraphSha256 !== inputGraphSha256
  )
    return undefined;
  return value as unknown as RuleAuthorityEvidence;
}

/**
 * A configured receipt is recorded against the exact compiler graph observed by its command.
 * Later compiler work may add delivery metadata or advance lifecycle statuses without changing
 * the nodes, paths, or command bindings that the receipt actually authenticated. Re-running the
 * command in that case is wasteful and can create a circular proof ticket.
 *
 * Re-key each predicate independently only when its recursively resolved check scope is byte-for-
 * byte identical after ignoring status values that do not change composite membership. Anything
 * we cannot project exactly is dropped fail-closed. Semantic changes to a checked node, a selected
 * member, command source, or member set therefore still invalidate the receipt.
 */
export function rebindRuleEvidenceAcrossNonInterferingGraphChange(input: {
  configuration: CompiledConfiguration;
  before: TypedGraph;
  after: TypedGraph;
  evidence: RuleAuthorityEvidence | undefined;
}): RuleAuthorityEvidence | undefined {
  if (input.evidence === undefined) return undefined;
  const beforeSha256 = ruleInputGraphSha256(input.configuration, input.before);
  if (
    input.evidence.configurationSha256 !== input.configuration.configuration_sha256 ||
    input.evidence.inputGraphSha256 !== beforeSha256
  )
    return undefined;
  const afterSha256 = ruleInputGraphSha256(input.configuration, input.after);
  if (afterSha256 === beforeSha256) return input.evidence;
  const predicates: Record<Sha256Digest, RulePredicateEvidence> = Object.create(null) as Record<
    Sha256Digest,
    RulePredicateEvidence
  >;
  for (const evidence of Object.values(input.evidence.predicates)) {
    if (evidence.leaf === undefined) continue;
    const beforeScope = ruleEvidencePredicateGraphScopeSha256(
      input.configuration,
      input.before,
      evidence,
    );
    const afterScope = ruleEvidencePredicateGraphScopeSha256(
      input.configuration,
      input.after,
      evidence,
    );
    if (beforeScope === undefined || beforeScope !== afterScope) continue;
    const key = rulePredicateEvidenceKey({
      configurationSha256: input.configuration.configuration_sha256,
      inputGraphSha256: afterSha256,
      leaf: evidence.leaf,
      ...(evidence.subjectNodeId === undefined ? {} : { subjectNodeId: evidence.subjectNodeId }),
      bindings: evidence.bindings ?? {},
    });
    predicates[key] = { ...structuredClone(evidence), key };
  }
  if (Object.keys(predicates).length === 0) return undefined;
  return createRuleAuthorityEvidence({
    protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
    configurationSha256: input.configuration.configuration_sha256,
    inputGraphSha256: afterSha256,
    predicates,
  });
}

/** Compatibility name retained for callers compiled against the narrower first implementation. */
export function rebindRuleEvidenceAcrossStatusOnlyReviewEffects(input: {
  configuration: CompiledConfiguration;
  before: TypedGraph;
  after: TypedGraph;
  evidence: RuleAuthorityEvidence | undefined;
}): RuleAuthorityEvidence | undefined {
  return rebindRuleEvidenceAcrossNonInterferingGraphChange(input);
}

export function ruleEvidencePredicateGraphScopeSha256(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evidence: RulePredicateEvidence,
): Sha256Digest | undefined {
  const leaf = evidence.leaf;
  if (leaf === undefined) return undefined;
  const op = optionalString(leaf.op);
  if (
    op === "gate_policy_satisfied" ||
    op === "gate_policy_has_current_terminal" ||
    op === "gate_policy_receipt_refused"
  ) {
    const policyId = optionalString(leaf.gate_policy) ?? optionalString(leaf.policy);
    const gateId = evidence.subjectNodeId;
    const gateSubject = optionalString(leaf.gate_subject) ?? "$gate";
    const bindingName = /^\$([A-Za-z_][A-Za-z0-9_-]*)$/u.exec(gateSubject)?.[1];
    if (
      policyId === undefined ||
      gateId === undefined ||
      bindingName === undefined ||
      canonicalHash(evidence.bindings?.[bindingName] ?? []) !== canonicalHash([gateId])
    ) {
      return undefined;
    }
    try {
      const material = gatePolicyEvidenceGraphScopeMaterial(configuration, graph, policyId, gateId);
      return material === undefined ? undefined : canonicalHash({ op, material });
    } catch {
      return undefined;
    }
  }
  if (op === "check_passed" || op === "check_has_current_terminal") {
    const checkId = optionalString(leaf.check);
    if (checkId === undefined || evidence.subjectNodeId === undefined) return undefined;
    try {
      const evaluator = new GraphExpressionEvaluator(configuration, graph);
      const material = checkEvidenceGraphScopeMaterial(
        configuration,
        graph,
        evaluator,
        checkId,
        [evidence.subjectNodeId],
        [],
      );
      return material === undefined ? undefined : canonicalHash(material);
    } catch {
      return undefined;
    }
  }
  if (op !== "current_receipt") return undefined;
  const ids = new Set<string>();
  if (evidence.subjectNodeId !== undefined) ids.add(evidence.subjectNodeId);
  const bindings = evidence.bindings ?? {};
  for (const name of rulePredicateBindingNames(leaf)) {
    const bound = bindings[name];
    if (bound === undefined) return undefined;
    for (const id of bound) ids.add(id);
  }
  if (ids.size === 0) return undefined;
  const nodes = [...ids].sort(compareText).map((id) => {
    const node = graph.node(id);
    if (node === undefined) throw new Error(`evidence scope references missing node ${id}`);
    return graphNodeEvidenceMaterial(node);
  });
  return canonicalHash({ op, nodes });
}

export function checkEvidenceGraphScopeMaterial(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  evaluator: GraphExpressionEvaluator,
  checkId: string,
  subjectIds: readonly string[],
  stack: readonly string[],
): ConfigurationValue | undefined {
  if (stack.includes(checkId) || subjectIds.length === 0) return undefined;
  const definition = configuration.registries.checks[checkId];
  const kind = optionalString(definition?.kind);
  if (definition === undefined || kind === undefined || kind === "graph") return undefined;
  const subjects = [...new Set(subjectIds)].sort(compareText);
  if (kind === "command") {
    const commandSource = optionalRecord(definition.command_source);
    const gatePolicyId = optionalString(commandSource?.gate_policy);
    if (gatePolicyId !== undefined) {
      const scopes: ConfigurationValue[] = [];
      for (const gateId of subjects) {
        const scope = gatePolicyEvidenceGraphScopeMaterial(
          configuration,
          graph,
          gatePolicyId,
          gateId,
        );
        if (scope === undefined) return undefined;
        scopes.push(scope);
      }
      return { check: checkId, kind, gate_policy: gatePolicyId, scopes };
    }
    return {
      check: checkId,
      kind,
      subjects: subjects.map((id) => {
        const node = graph.node(id);
        if (node === undefined) throw new Error(`check scope references missing node ${id}`);
        return graphNodeEvidenceMaterial(node);
      }),
    };
  }
  if (kind !== "composite") return undefined;
  const set = optionalRecord(definition.graph_set);
  const selector = set?.members;
  if (set === undefined || selector === undefined) return undefined;
  const selected = evaluator.withBinding("target", subjects, () => evaluator.select(selector));
  const memberTypes = new Set(stringArray(set.member_node_types, `${checkId} member node types`));
  const excluded = new Set(stringArray(set.status_excluding, `${checkId} excluded statuses`));
  const members = selected
    .flatMap((id) => {
      const node = graph.node(id);
      if (
        node === undefined ||
        (memberTypes.size > 0 && !memberTypes.has(node.type)) ||
        excluded.has(node.status)
      ) {
        return [];
      }
      return [node];
    })
    .sort((left, right) => compareText(left.id, right.id));
  const configuredChild = optionalString(set.member_check);
  const childField = optionalString(set.member_check_field);
  const projectedMembers: ConfigurationValue[] = [];
  for (const node of members) {
    const childId =
      configuredChild ??
      (childField === undefined ? undefined : optionalString(graphNodeField(node, childField)));
    if (childId === undefined) return undefined;
    const child = checkEvidenceGraphScopeMaterial(
      configuration,
      graph,
      evaluator,
      childId,
      [node.id],
      [...stack, checkId],
    );
    if (child === undefined) return undefined;
    projectedMembers.push({ node: graphNodeEvidenceMaterial(node), child });
  }
  return { check: checkId, kind, members: projectedMembers };
}

/**
 * Exact graph footprint that can change one gate-policy command or the meaning of its verdict.
 *
 * The full graph is intentionally not included: unrelated research nodes may advance after a gate
 * passes. Candidate-pool membership, policy selection, applicability context, and every node the
 * compiled context exposes are included, so any relevant semantic change still invalidates the
 * receipt fail-closed.
 */
export function gatePolicyEvidenceGraphScopeMaterial(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  policyId: string,
  gateId: string,
): ConfigurationValue | undefined {
  const configured = configuration.registries.gate_policies[policyId];
  const gate = graph.node(gateId);
  if (configured === undefined || gate === undefined) return undefined;
  const evaluator = new GraphExpressionEvaluator(
    configuration,
    graph,
    createPolicySelectionRuleDomainAdapter(),
  );
  evaluator.bind("gate", [gateId]);
  const candidatePool = configured.candidate_pool;
  const evaluationTargets = optionalRecord(configured.evaluation_targets);
  if (candidatePool === undefined || evaluationTargets?.select === undefined) return undefined;
  const candidateIds = [...evaluator.select(candidatePool)];
  const winnerIds = [
    ...evaluator.select({
      policy_selection: { policy: policyId, gate: { ids: [gateId] }, result: "winner" },
    }),
  ];
  if (winnerIds.length > 1) return undefined;
  const targetIds = [...evaluator.select(evaluationTargets.select)];
  const selectApplicability = (
    result: "ancestors" | "direct_gates" | "inherited_gates" | "applicable_gates",
  ): string[] => [
    ...evaluator.select({
      policy_applicability: {
        policy: policyId,
        subject: { ids: targetIds },
        result,
      },
    }),
  ];
  const ancestors = selectApplicability("ancestors");
  const direct = selectApplicability("direct_gates");
  const inherited = selectApplicability("inherited_gates");
  const applicable = [...new Set([...direct, ...inherited])].sort(compareText);
  evaluator.bind("winner", winnerIds);
  evaluator.bind("candidate", winnerIds);
  evaluator.bind("target", targetIds);
  evaluator.bind("evaluation_targets", targetIds);
  evaluator.bind("ancestors", ancestors);
  evaluator.bind("direct_gates", direct);
  evaluator.bind("inherited_gates", inherited);
  evaluator.bind("applicable_gates", applicable);
  const context = optionalRecord(configured.context);
  const contextIds = context?.select === undefined ? [] : [...evaluator.select(context.select)];
  evaluator.bind("context", contextIds);
  const readPaths = new Set<string>();
  const configuredReadPaths = context?.read_paths;
  if (configuredReadPaths !== undefined && !Array.isArray(configuredReadPaths)) return undefined;
  for (const definition of (configuredReadPaths ?? []) as readonly ConfigurationValue[]) {
    if (typeof definition === "string") {
      readPaths.add(definition);
      continue;
    }
    const projected = optionalRecord(definition);
    const field = optionalString(projected?.field);
    if (projected?.select === undefined || field === undefined) return undefined;
    for (const nodeId of evaluator.select(projected.select)) {
      const value = evaluator.field(nodeId, field);
      if (typeof value === "string") readPaths.add(value);
      else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        for (const item of value) readPaths.add(item);
      } else if (value !== undefined) return undefined;
    }
  }
  const nodes = (ids: readonly string[]): ConfigurationValue[] =>
    [...new Set(ids)].sort(compareText).map((id) => {
      const node = graph.node(id);
      if (node === undefined) throw new Error(`gate policy scope references missing node ${id}`);
      return graphNodeEvidenceMaterial(node);
    });
  return {
    protocol: "koni.gate-policy-evidence-graph-scope.v1",
    policy_id: policyId,
    policy: structuredClone(configured),
    gate: graphNodeEvidenceMaterial(gate),
    candidates: nodes(candidateIds),
    winners: nodes(winnerIds),
    evaluation_targets: nodes(targetIds),
    ancestors: nodes(ancestors),
    direct_gates: nodes(direct),
    inherited_gates: nodes(inherited),
    applicable_gates: nodes(applicable),
    context_nodes: nodes(contextIds),
    read_paths: [...readPaths].sort(compareText),
  };
}

export function graphNodeEvidenceMaterial(node: CompilerGraphNode): ConfigurationObject {
  const { status: _status, ...material } = structuredClone(node);
  return material;
}

export function isIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function requiredToolString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    fail("tool_arguments", `${field} must be a nonempty safe string`);
  }
  return value;
}

export function optionalToolString(
  args: Record<string, unknown>,
  field: string,
): string | undefined {
  return args[field] === undefined ? undefined : requiredToolString(args, field);
}

export function optionalToolStringArray(
  args: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    fail("tool_arguments", `${field} must be an array of nonempty strings`);
  }
  return value as string[];
}

export function optionalToolInteger(
  args: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) fail("tool_arguments", `${field} must be an integer`);
  return value as number;
}

export function requiredToolInteger(args: Record<string, unknown>, field: string): number {
  const value = optionalToolInteger(args, field);
  if (value === undefined) fail("tool_arguments", `${field} is required`);
  return value;
}

export function dynamicRelationArcs(
  configuration: CompiledConfiguration,
  graph: TypedGraph,
): Array<{ from: string; relation: string; to: string }> {
  const arcs: Array<{ from: string; relation: string; to: string }> = [];
  for (const edge of graph.edges()) {
    arcs.push({ from: edge.source, relation: edge.relation, to: edge.target });
    const source = graph.node(edge.source);
    const target = graph.node(edge.target);
    const definition =
      source === undefined || target === undefined
        ? undefined
        : configuration.edge_types.find(
            (candidate) =>
              candidate.source === source.type &&
              candidate.relation === edge.relation &&
              Array.isArray(candidate.targets) &&
              candidate.targets.includes(target.type),
          );
    if (definition?.bidirectional === true && typeof definition.inverse === "string") {
      arcs.push({ from: edge.target, relation: definition.inverse, to: edge.source });
    }
  }
  return arcs.sort(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.relation, right.relation) ||
      compareText(left.to, right.to),
  );
}

export function parseDynamicGraphSelectionRequest(
  args: Record<string, unknown>,
): DynamicGraphSelectionRequest {
  const anchors = optionalToolStringArray(args, "anchors");
  const relations = optionalToolStringArray(args, "relations");
  const nodeTypes = optionalToolStringArray(args, "nodeTypes");
  const direction = optionalToolString(args, "direction");
  if (
    direction !== undefined &&
    direction !== "outgoing" &&
    direction !== "incoming" &&
    direction !== "both"
  ) {
    fail("graph_context_direction", `unsupported graph context direction ${direction}`);
  }
  const maxDepth = optionalToolInteger(args, "maxDepth") ?? 1;
  if (maxDepth < 0 || maxDepth > 16) {
    fail("graph_context_depth", "graph context depth must be between zero and sixteen");
  }
  return {
    ...(anchors === undefined ? {} : { anchors }),
    ...(relations === undefined ? {} : { relations }),
    ...(direction === undefined ? {} : { direction }),
    maxDepth,
    ...(nodeTypes === undefined ? {} : { nodeTypes }),
  };
}

export function normalizeReferencedPaths(
  values: readonly string[],
  grant: AuthorityGrant,
  label: string,
): string[] {
  const scopes = [...new Set([...grant.readPaths, ...grant.writePaths])];
  const output = new Set<string>();
  for (const value of values) {
    if (
      value !== "." &&
      (value.length === 0 ||
        value.length > 16 * 1024 ||
        value.startsWith("/") ||
        /^[A-Za-z]:\//u.test(value) ||
        value.includes("\\") ||
        value.includes("\u0000") ||
        value.split("/").some((part) => part === "" || part === "." || part === ".."))
    )
      fail(
        `${label.replaceAll(" ", "_")}_path`,
        `${label} path ${value} is not normalized and repository-relative`,
      );
    if (
      !scopes.some((scope) => scope === "." || value === scope || value.startsWith(`${scope}/`))
    ) {
      fail(
        `${label.replaceAll(" ", "_")}_scope`,
        `${label} path ${value} is outside this attempt's read/write scope`,
      );
    }
    output.add(value);
  }
  return [...output].sort(compareText);
}

export function contextualProvenance<Kind extends "owner_update" | "change_note">(
  kind: Kind,
  run: RunRecord,
  attempt: AgentAttemptRecord,
  spec: Readonly<AgentLaunchSpec>,
  semanticRevision: number,
  semanticHash: Sha256Digest,
  contextual: GraphContextualState,
  recordedAt: string,
): ContextualRecordProvenance & { kind: Kind } {
  return {
    kind,
    runId: run.id,
    generation: run.generation,
    ticketId: attempt.ticketId,
    stepId: attempt.stepId,
    attemptId: attempt.id,
    sessionId: attempt.sessionId,
    personaId: attempt.personaId,
    authorityGrantHash: spec.authority.grantHash,
    launchSpecHash: spec.specHash,
    authoritativeContextHash: spec.authority.authoritativeContextHash,
    semanticRevision,
    semanticHash,
    contextualRevision: contextual.revision,
    contextualHash: contextual.hash,
    lineage: structuredClone(spec.lineage),
    recordedAt,
  };
}

export function compatibleAttemptLineage(
  run: RunRecord,
  active: AgentAttemptRecord,
): { compatible: Set<string>; abandoned: Set<string> } {
  const abandonedStatuses = new Set<AttemptStatus>(["failed", "aborted", "interrupted"]);
  const abandoned = new Set(
    Object.values(run.attempts)
      .filter((attempt) => abandonedStatuses.has(attempt.status))
      .map((attempt) => attempt.id),
  );
  const ancestors = new Set<string>([active.id]);
  let cursor: AgentAttemptRecord | undefined = active;
  while (
    cursor?.lineage?.parentAttemptId !== undefined &&
    !ancestors.has(cursor.lineage.parentAttemptId)
  ) {
    ancestors.add(cursor.lineage.parentAttemptId);
    cursor = run.attempts[cursor.lineage.parentAttemptId];
  }
  const lineageGroup = (attempt: AgentAttemptRecord): string =>
    `${recoveredAttemptKind(run, attempt)}\u0000${attempt.ticketId}\u0000${attempt.stepId}`;
  const activeGroup = lineageGroup(active);
  const compatible = new Set<string>();
  for (const attempt of Object.values(run.attempts)) {
    if (abandoned.has(attempt.id)) continue;
    // Attempts for other ticket steps are independent linear histories, not sibling branches of
    // this attempt. Within the same history, only the active ancestry (plus unversioned legacy
    // roots) is compatible; completed sibling rework/retry branches remain excluded.
    if (
      lineageGroup(attempt) !== activeGroup ||
      ancestors.has(attempt.id) ||
      attempt.lineage === undefined
    ) {
      compatible.add(attempt.id);
    }
  }
  compatible.add(active.id);
  return { compatible, abandoned };
}

export function isGraphNoteKind(value: unknown): value is GraphNoteArtifact["kind"] {
  return (
    value === "observation" ||
    value === "implementation_detail" ||
    value === "rationale" ||
    value === "nit" ||
    value === "open_question"
  );
}

export function compilerActivity(
  run: RunRecord,
  message: string,
  salt: string,
  tone?: RunActivityRecord["tone"],
): RunActivityRecord {
  const at = new Date().toISOString();
  return {
    id: `activity-${digestBody(canonicalHash([run.id, run.revision, salt, message])).slice(0, 20)}`,
    at,
    kind: "compiler",
    message,
    ticketId: undefined,
    nodeId: undefined,
    ...(tone === undefined ? {} : { tone }),
  };
}

export function graphActivity(
  run: RunRecord,
  kind: Extract<RunActivityRecord["kind"], "graph_added" | "graph_modified" | "graph_deleted">,
  node: Pick<GraphNode, "id" | "type" | "title">,
  salt: string,
): RunActivityRecord {
  const verb = kind === "graph_added" ? "Added" : kind === "graph_deleted" ? "Deleted" : "Modified";
  return {
    id: `activity-${digestBody(canonicalHash([run.id, run.revision, salt, kind, node.id])).slice(0, 20)}`,
    at: new Date().toISOString(),
    kind,
    message: `${verb} ${node.type}: ${node.title}`,
    ticketId: salt.startsWith("TK-") ? salt : undefined,
    nodeId: node.id,
  };
}

export function boundedContext(value: unknown): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_CONTEXT_BYTES || content.includes("\u0000"))
    fail("context_size", "compiler-issued context is oversized or unsafe");
  return content;
}

export function graphArtifactPath(runId: string): string {
  return `runs/${runId}/program/graph.json`;
}
export function ticketDefinitionsPath(runId: string): string {
  return `runs/${runId}/program/ticket-definitions.json`;
}
export function pinnedConfigurationPath(runId: string): string {
  return `runs/${runId}/configuration/compiled.json`;
}
export function evaluationPath(runId: string, revision: number): string {
  return `runs/${runId}/program/evaluations/${revision}.json`;
}
export function graphNotePath(runId: string, noteId: string): string {
  return `runs/${runId}/program/notes/${noteId}.json`;
}

export function encodeRunGraphArtifact(value: GraphArtifact): Buffer {
  const bytes = encodeArtifact(value);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RUN_GRAPH_BYTES || bytes.includes(0)) {
    fail("graph_artifact_size", "completed run-graph artifact exceeds its durable byte bound");
  }
  return bytes;
}

export function encodeArtifact(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function requireValidation<Value>(
  result: ValidationResult<Value>,
  code: string,
  message: string,
): Value {
  if (!result.ok)
    throw new NativeRunProgramError(code, message, diagnosticLines(result.diagnostics));
  return result.value;
}

export function diagnosticLines(diagnostics: readonly CompilerDiagnostic[]): string[] {
  return diagnostics.map((item) => `${item.code} ${item.path}: ${item.message}`);
}

export function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail("shape", `${label} must be an object`);
  return value;
}

export function optionalRecord(value: unknown): ConfigurationObject | undefined {
  return value === undefined || value === null || !isRecord(value)
    ? undefined
    : (value as ConfigurationObject);
}

export function jsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  const record = requiredRecord(value, label);
  assertJsonValue(record, label);
  return structuredClone(record);
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key.length === 0 || key.includes("\u0000"))
        fail("json_key", `${label} contains an invalid key`);
      assertJsonValue(item, label);
    }
    return;
  }
  fail("json_value", `${label} contains a non-JSON value`);
}

export function assertExactFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  assertAllowedFields(record, allowed, label);
  for (const key of allowed)
    if (!Object.hasOwn(record, key)) fail("missing_field", `${label} is missing ${key}`);
}

export function assertAllowedFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(record))
    if (!accepted.has(key)) fail("unknown_field", `${label} contains unknown field ${key}`);
}

export function requiredNonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000"))
    fail("string", `${label} must be a nonempty safe string`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredNonempty(value, "configured string");
}

export function boundedText(value: unknown, label: string, maximum: number): string {
  const text = requiredNonempty(value, label);
  if (Buffer.byteLength(text, "utf8") > maximum)
    fail("text_size", `${label} exceeds ${maximum} UTF-8 bytes`);
  return text;
}

export function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  )
    fail("string_array", `${label} must contain strings`);
  return [...new Set(value as string[])].sort(compareText);
}

export function optionalSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function requireDigest(value: unknown, label: string): Sha256Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
    fail("digest", `${label} must be a sha256 digest`);
  return value as Sha256Digest;
}

export function withoutField(value: object, field: string): Record<string, unknown> {
  const cloned = structuredClone(value) as Record<string, unknown>;
  delete cloned[field];
  return cloned;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compareText(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function normalizeResourcePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  )
    fail("resource_path", `resource path ${value} is not a safe normalized relative path`);
  return value;
}

export function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function digestBody(value: Sha256Digest): string {
  return value.slice("sha256:".length);
}

export function humanize(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function shortOid(value: string): string {
  return value.slice(0, 12);
}

export function attemptWorkspace(
  run: RunRecord,
  kind: "planning" | "lead" | "ticket" | "verification" | "integration",
  ticketId: string,
): string {
  if (kind === "lead") return path.resolve(run.projectRoot);
  if (kind === "planning") {
    // The initial plan uses a detached checkout. Once approval has materialized the
    // permanent run workspace and retired that checkout, a plan revision must inspect
    // the current durable run state there rather than attempting to resurrect planning.
    if (run.git.run.status === "ready" && run.git.run.headOid !== undefined) {
      return path.resolve(run.git.run.worktree);
    }
    if (run.git.planning.status !== "ready") {
      fail("planning_workspace", "planning attempt has no ready detached checkout");
    }
    return path.resolve(run.git.planning.worktree);
  }
  if (kind === "verification") {
    if (run.git.run.status !== "ready" || run.git.run.headOid === undefined) {
      fail("run_workspace", "verification attempt has no approved run checkout");
    }
    return path.resolve(run.git.run.worktree);
  }
  const ticket = run.tickets[ticketId];
  if (ticket === undefined || ticket.gitCycleId === undefined) {
    fail("ticket_workspace", `ticket ${ticketId} has no authority-issued Git cycle`);
  }
  const cycle = run.git.ticketCycles[ticket.gitCycleId];
  if (
    cycle === undefined ||
    cycle.ticketId !== ticketId ||
    ticket.worktreePath !== cycle.worktree ||
    ticket.branch !== cycle.branchRef ||
    (cycle.status !== "active" && cycle.status !== "candidate")
  ) {
    fail("ticket_workspace", `ticket ${ticketId} Git cycle is missing, stale, or not executable`);
  }
  return path.resolve(cycle.worktree);
}

/**
 * Approved applications sometimes need to add a typed reference to an existing node that is not
 * yet connected to the write target. Preserve the exact write grant, but make nodes whose
 * repository paths are named verbatim in the original hash-bound request or its reviewed selection
 * eligible for dynamic read context. Terminal resolvers inherit the same provenance from their
 * source application so a failed application can be repaired without ambient graph visibility.
 */
export function approvedChangeContextReferencePaths(
  run: RunRecord,
  ticket: TicketRecord | undefined,
  graph: TypedGraph,
): readonly string[] {
  const summaries: string[] = [];
  const visited = new Set<string>();
  let current = ticket;
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    const control = current.executionControl;
    const causal = control?.controlTicketAuthority?.causal;
    const requestContext = approvedApplicationRequestContext(run, current);
    if (requestContext !== undefined) {
      summaries.push(
        requestContext.publication.summary,
        requestContext.publication.reason,
        requestContext.materialization.selectionSummary,
      );
    }
    const materializations = [
      control?.approvedMaterialization,
      ...(causal?.role === "approved_application" ? [causal.materialization] : []),
    ];
    for (const materialization of materializations) {
      if (materialization?.kind === "application") summaries.push(materialization.selectionSummary);
    }
    const sourceTicketId =
      control?.terminalRecovery?.sourceTicketId ?? control?.sourceProposalTicketId;
    current = sourceTicketId === undefined ? undefined : run.tickets[sourceTicketId];
  }
  if (summaries.length === 0) return [];

  const referenced = new Set<string>();
  for (const node of graph.nodes()) {
    for (const repositoryPath of graph.repositoryPaths(node.id)) {
      if (summaries.some((summary) => textMentionsExactRepositoryPath(summary, repositoryPath))) {
        referenced.add(repositoryPath);
      }
    }
  }
  return [...referenced].sort(compareText);
}

export function textMentionsExactRepositoryPath(text: string, repositoryPath: string): boolean {
  if (repositoryPath.length === 0) return false;
  const pathCharacter = /[A-Za-z0-9._/@+-]/u;
  for (let offset = 0; offset <= text.length - repositoryPath.length;) {
    const index = text.indexOf(repositoryPath, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : text[index - 1];
    const afterIndex = index + repositoryPath.length;
    const after = afterIndex >= text.length ? undefined : text[afterIndex];
    if (
      (before === undefined || !pathCharacter.test(before)) &&
      (after === undefined || !pathCharacter.test(after))
    ) {
      return true;
    }
    offset = index + repositoryPath.length;
  }
  return false;
}

export function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function fail(code: string, message: string, details: readonly string[] = []): never {
  throw new NativeRunProgramError(code, message, details);
}

/**
 * Koni binds whichever Pi provider the configuration names; it has no built-in vendor.
 *
 * Defaulting a missing provider to one vendor would silently execute a persona against a provider
 * the project never chose, and would hide the configuration gap behind an unrelated
 * `model_unavailable` failure on installations authenticated with a different provider.
 */
export function requiredPersonaProvider(provider: string | undefined, personaId: string): string {
  if (provider !== undefined && provider.trim().length > 0) return provider;
  return fail(
    "persona_provider",
    `persona ${personaId} has no configured provider; declare one on its agent resource, its persona, or the run-type role`,
  );
}

export function approvedApplicationRequestContext(
  run: Pick<RunRecord, "tickets">,
  ticket: Readonly<TicketRecord> | undefined,
):
  | Readonly<{
      proposal: TicketRecord;
      publication: ChangeControlPublication;
      materialization: Extract<ApprovedChangeMaterialization, { kind: "application" }>;
    }>
  | undefined {
  const control = ticket?.executionControl;
  const authority = control?.controlTicketAuthority;
  const causal = authority?.causal;
  const proposalId = control?.sourceProposalTicketId;
  const proposal = proposalId === undefined ? undefined : run.tickets[proposalId];
  const publication = proposalRequestPublicationForTicket(proposal);
  if (
    ticket === undefined ||
    proposal === undefined ||
    publication === undefined ||
    authority?.role !== "approved_application" ||
    causal?.role !== "approved_application" ||
    causal.materialization.kind !== "application" ||
    causal.materialization.proposalTicketId !== proposal.id ||
    causal.materialization.applicationTicketId !== ticket.id ||
    causal.materialization.requestSha256 !== publication.requestSha256 ||
    control?.approvedApplicationSha256 !== causal.materialization.authoritySha256
  ) {
    return undefined;
  }
  return { proposal, publication, materialization: causal.materialization };
}

export function predicateMatches(
  node: GraphNode,
  predicate: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (predicate === undefined) return true;
  const field = requiredNonempty(predicate.field, "effect predicate field");
  const operation = requiredNonempty(predicate.op, "effect predicate op");
  const value = graphField(node, field);
  if (operation === "equals")
    return canonicalHash(value ?? null) === canonicalHash(predicate.value ?? null);
  if (operation === "present") return value !== undefined;
  if (operation === "absent") return value === undefined;
  if (operation === "non_empty") return isNonemptyConfigurationValue(value);
  fail("review_effect_predicate", `unsupported review effect predicate ${operation}`);
}

export function resolveReviewEffectTokens(
  value: unknown,
  reviewId: string,
  actor: string,
): JsonValue {
  if (value === "$review.id") return reviewId;
  if (value === "$actor") return actor;
  if (typeof value === "string" && value.startsWith("$")) {
    fail("review_effect_token", `unknown review effect compiler token ${value}`);
  }
  if (Array.isArray(value))
    return value.map((item) => resolveReviewEffectTokens(item, reviewId, actor));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveReviewEffectTokens(item, reviewId, actor),
      ]),
    );
  }
  assertJsonValue(value, "review effect value");
  return value;
}

export function graphField(node: GraphNode, field: string): JsonValue | undefined {
  if (field === "status") return node.status;
  const segments = field.replace(/^spec\./u, "").split(".");
  let value: unknown = node.spec;
  for (const segment of segments) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value as JsonValue | undefined;
}

export function setNestedSpec(
  spec: Record<string, JsonValue>,
  field: string,
  value: JsonValue,
): void {
  const segments = field.split(".");
  let cursor: Record<string, JsonValue> = spec;
  for (const segment of segments.slice(0, -1)) {
    const child = cursor[segment];
    if (!isRecord(child)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, JsonValue>;
  }
  cursor[segments.at(-1)!] = structuredClone(value);
}

export function recoveredAttemptKind(
  run: RunRecord,
  attempt: AgentAttemptRecord,
): "planning" | "lead" | "ticket" | "verification" | "integration" {
  if (attempt.kind !== undefined) return attempt.kind;
  if (attempt.ticketId === "run-orchestration" && attempt.stepId.startsWith("lead-")) return "lead";
  if (attempt.ticketId === "run-planning") return "planning";
  if (attempt.ticketId === "run-verification") return "verification";
  if (run.tickets[attempt.ticketId]?.id.startsWith("TK-integration-") === true)
    return "integration";
  return "ticket";
}

export function requireExecutionSemanticCatalog(
  configuration: CompiledConfiguration,
): CompiledExecutionSemanticCatalog {
  try {
    return compileExecutionSemanticCatalog(configuration);
  } catch (error) {
    fail(
      "execution_semantics_invalid",
      error instanceof Error ? error.message : "pinned execution semantics did not compile",
    );
  }
}

export function graphNodeField(node: GraphNode, field: string): ConfigurationValue | undefined {
  return dynamicValuePath(graphNodeRoot(node), field, {});
}

export function dynamicValuePath(
  root: ConfigurationValue,
  field: string,
  variables: Readonly<Record<string, string>>,
): ConfigurationValue | undefined {
  const segments = field.replace(/^\$?\./u, "").match(/[^.[\]]+|\[[^\]]+\]/gu) ?? [];
  let current: ConfigurationValue | undefined = root;
  for (const raw of segments) {
    const bracket = raw.startsWith("[");
    let key = bracket ? raw.slice(1, -1).trim() : raw;
    if (key.startsWith("$")) key = variables[key.slice(1)] ?? "";
    else key = key.replace(/^(?:'|")|(?:'|")$/gu, "");
    if (key.length === 0) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[key];
    } else return undefined;
  }
  return current;
}

export function normalizeCheckPath(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === ".") return ".";
  if (
    trimmed.length === 0 ||
    trimmed.includes("\u0000") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("/") ||
    path.posix.normalize(trimmed) !== trimmed ||
    trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    fail("check_path", `${label} must be a normalized project-relative path`);
  return trimmed;
}

export function assertPathInScopes(value: string, scopes: readonly string[], label: string): void {
  const normalizedScopes = scopes.map((scope) => normalizeCheckPath(scope, `${label} scope`));
  if (
    !normalizedScopes.some(
      (scope) => scope === "." || value === scope || value.startsWith(`${scope}/`),
    )
  ) {
    fail("check_path_scope", `${label} ${value} is outside the exact compiler-issued path scope`);
  }
}

export function proposalRequestPublicationForTicket(
  ticket: Readonly<TicketRecord> | undefined,
): ChangeControlPublication | undefined {
  const control = ticket?.executionControl;
  const authority = control?.controlTicketAuthority;
  const causal = authority?.causal;
  const request = control?.proposalRequest;
  if (
    ticket === undefined ||
    request === undefined ||
    authority?.role !== "proposal" ||
    causal?.role !== "proposal" ||
    authority.ticketId !== ticket.id ||
    causal.publication.proposalTicketId !== ticket.id ||
    causal.publication.requestSha256 !== request.requestSha256 ||
    causal.publication.sourceTicketId !== request.sourceTicketId ||
    causal.publication.sourceStepId !== request.sourceStepId ||
    causal.publication.sourceOutputSha256 !== request.sourceOutputSha256
  ) {
    return undefined;
  }
  return causal.publication;
}

export function isNonemptyConfigurationValue(value: JsonValue | undefined): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

export function graphNodeRoot(node: GraphNode): ConfigurationObject {
  return {
    schema_version: node.schema_version,
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: node.spec,
    edges: node.edges,
    annotations: node.annotations,
  };
}
