import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "packages/core/src");
const defaultLineLimit = 2_500;

const runProgramValueExports = [
  "applyReviewEffects",
  "approvedApplicationAuditSteering",
  "approvedApplicationGraphOnlyReviewInstruction",
  "approvedChangeObligationInstructions",
  "approvedChangeObligationsForAttempt",
  "approvedChangeObligationsForTargets",
  "approvedProposalAttemptInstructions",
  "approvedProposalAuditSteering",
  "assertApprovedChangeRuntimeObligations",
  "assertAssetGateContractsBoundToGraph",
  "assertAssetImplementationObligationsPreserved",
  "assertFailedReviewDoesNotContradictApprovedChangeRuntimeObligations",
  "assertPlanningRepositoryPaths",
  "assertRunPlanObligationsPreserved",
  "assertRunPlanUsesRepositoryOwnedArgv",
  "assertTicketDefinitionStable",
  "assetImplementationFallbackEligible",
  "assetImplementationFilesMaterialized",
  "commandInfrastructureFailure",
  "configuredCheckFailureInstructions",
  "currentNonpassingGateRepairEvidenceRequests",
  "downstreamGraphPublicationStepIds",
  "effectiveAssignmentWriteScope",
  "exhaustedSourceProposalInstructions",
  "existingStandaloneSupportRunForUpstreamRequest",
  "experimentBoundaryBlockedGateProviderNodeIds",
  "gatePolicyCommandSubjectIds",
  "gateProviderRepairScopeFallback",
  "gateRepairEvidenceTargetNodeIds",
  "gateRepairInstruction",
  "generatedAssetImplementationReadPaths",
  "generatedAssetRepairTicketId",
  "graphDeltaReviewCandidateNodeIds",
  "hasExistingAssetImplementationTicket",
  "hasManifestScopedDirectGateRecheck",
  "implementAssetReviewManifestInstruction",
  "implementationWriteGrantInstructions",
  "loadedSkillResourceFromReceipt",
  "manifestScopedDirectGateRechecks",
  "orderedReviewPredecessorStepIds",
  "pendingPlannedAssetRepairRequestForNode",
  "plannedAssetRepairHistoryForAttempt",
  "plannedAssetRepairProposalTargetNodeIds",
  "plannedAssetRepairRequestForNode",
  "plannedAssetRepairRequestsForNode",
  "rebindRuleEvidenceAcrossNonInterferingGraphChange",
  "rebindRuleEvidenceAcrossStatusOnlyReviewEffects",
  "reconcileNeverStartedTicketNodeScope",
  "recurringAssetHasUnaddressedGateFailure",
  "recurringAssetHasUnaddressedStandaloneRunFailure",
  "recurringAssetRequiresReissue",
  "recurringAssetReviewReworkPending",
  "refreshHeldSourceTicketGrant",
  "refreshSettledRecurringAssetTicketGrant",
  "rejectedSourceProposalInstructions",
  "remapPlanningSeedGateContractKeys",
  "reopenCompletedRecurringAssetTicket",
  "repairedProviderBlockedDirectGateNodeIds",
  "repairedProviderDirectGateReadNodeIds",
  "repairedProviderGateRecheckInstruction",
  "replaceGateRunDefinitionsWithManifestRechecks",
  "researchConstitutionRunPlanFallback",
  "researchRunContractScopeFallback",
  "researchStandaloneSupportRunFallback",
  "resolveConfiguredOperationReference",
  "resolvePinnedGateAutoEvaluationContexts",
  "restoreSettledRecurringAssetTicket",
  "reviewVerdictInstructions",
  "routablePlannedAssetRepairProposalIds",
  "routePlannedAssetRepairProposals",
  "routeSupersededGateRunProposals",
  "scientificRunTicketDefinitions",
  "shouldAssertApprovedChangeRuntimeObligations",
  "shouldAttachCurrentGateRepairEvidence",
  "shouldAttachPredecessorExecution",
  "standaloneSupportRunAllowsEmptyScientificInputs",
  "standaloneSupportRunAssetNodeIds",
  "standaloneSupportRunAssetRepairInstruction",
  "standaloneSupportRunAssetRepairScopeFallback",
  "standaloneSupportRunGateNodeIds",
  "ticketBoardApplicableTicketDefinitions",
  "ticketCreatedNodeIds",
  "upstreamChangeRequestInstructions",
  "verificationActionableTicketDefinitions",
].sort();

const runProgramTypeExports = [
  "ApprovedChangeObligationContext",
  "AssignmentTerminalPolicyProjection",
  "AssignmentTerminalPolicyRetainedReceipt",
  "AssignmentTerminalPolicySourceCommand",
  "AssignmentTerminalPolicySourceManifestPair",
  "AssignmentTerminalReplayCompilation",
  "AssignmentTerminalValidationCheckPolicy",
  "CurrentNonpassingGateRepairEvidenceRequest",
  "NativeRuleAuthorityEvidenceRequest",
  "NativeRunCompilerProgramOptions",
  "PlannedAssetRepairHistoryEntry",
  "PlannedAssetRepairRequest",
].sort();

const runProgramClassExports = ["NativeRunCompilerProgram", "NativeRunProgramError"].sort();
const intendedRunProgramExports = [
  ...runProgramValueExports,
  ...runProgramTypeExports,
  ...runProgramClassExports,
].sort();

const grandfatheredLineLimits = new Map([
  ["packages/core/src/authority/run-engine.ts", 19_864],
  ["packages/core/src/compiler/configuration.ts", 2_749],
  ["packages/core/src/compiler/run-program.ts", 13_139],
  ["packages/core/src/control-center/component.ts", 4_433],
  ["packages/core/src/control-center/controller.ts", 5_957],
  ["packages/core/src/git/lifecycle.ts", 4_517],
  ["packages/core/src/pi/attempt-process-supervisor.ts", 2_584],
  ["packages/core/src/pi/managed-session.ts", 3_799],
  ["packages/core/src/state/run-record.ts", 6_134],
]);

const forbiddenFacadeImports = new Map([
  ["packages/core/src/authority/action-execution.ts", "./run-engine.js"],
  ["packages/core/src/authority/config-documents.ts", "./run-engine.js"],
  ["packages/core/src/authority/configured-lifecycle.ts", "./run-engine.js"],
  ["packages/core/src/authority/execution-policy.ts", "./run-engine.js"],
  ["packages/core/src/authority/monitor-methods.ts", "./run-engine.js"],
  ["packages/core/src/authority/monitor-projection.ts", "./run-engine.js"],
  ["packages/core/src/authority/run-engine-check-dispatch.ts", "./run-engine.js"],
  ["packages/core/src/authority/run-engine-contracts.ts", "./run-engine.js"],
  ["packages/core/src/authority/run-engine-execution.ts", "./run-engine.js"],
  ["packages/core/src/authority/run-engine-preparation.ts", "./run-engine.js"],
  ["packages/core/src/authority/run-engine-recovery.ts", "./run-engine.js"],
  ["packages/core/src/authority/run-engine-rpc.ts", "./run-engine.js"],
  ["packages/core/src/authority/run-engine-shared.ts", "./run-engine.js"],
  ["packages/core/src/compiler/action-recipes.ts", "./run-program.js"],
  ["packages/core/src/compiler/configuration-values.ts", "./configuration.js"],
  ["packages/core/src/compiler/run-attempt-guidance.ts", "./run-program.js"],
  ["packages/core/src/compiler/run-check-execution.ts", "./run-program.js"],
  ["packages/core/src/compiler/run-check-resolution.ts", "./run-program.js"],
  ["packages/core/src/compiler/run-graph-compilation.ts", "./run-program.js"],
  ["packages/core/src/compiler/run-program-contracts.ts", "./run-program.js"],
  ["packages/core/src/compiler/run-program-support.ts", "./run-program.js"],
  ["packages/core/src/compiler/execution-semantics.ts", "./run-program.js"],
  ["packages/core/src/compiler/graph-constraints.ts", "./run-program.js"],
  ["packages/core/src/compiler/ticket-dependencies.ts", "./run-program.js"],
  ["packages/core/src/control-center/controller-fields.ts", "./controller.js"],
  ["packages/core/src/git/lifecycle-errors.ts", "./lifecycle.js"],
  ["packages/core/src/git/lifecycle-namespace.ts", "./lifecycle.js"],
  ["packages/core/src/git/lifecycle-validation.ts", "./lifecycle.js"],
  ["packages/core/src/pi/interactive-tools.ts", "./managed-session.js"],
  ["packages/core/src/pi/attempt-process-sources.ts", "./attempt-process-supervisor.js"],
  ["packages/core/src/pi/managed-session-contracts.ts", "./managed-session.js"],
  ["packages/core/src/pi/managed-session-runtime.ts", "./managed-session.js"],
  ["packages/core/src/pi/tool-renderer.ts", "./managed-session.js"],
  ["packages/core/src/pi/transcript-page.ts", "./managed-session.js"],
  ["packages/core/src/state/run-record-archive.ts", "./run-record.js"],
  ["packages/core/src/state/run-record-contracts.ts", "./run-record.js"],
  ["packages/core/src/state/run-record-validation.ts", "./run-record.js"],
]);

test("production TypeScript modules stay within their architecture budgets", async () => {
  const violations = [];
  for (const absolutePath of await listTypeScriptFiles(sourceRoot)) {
    const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
    const contents = await readFile(absolutePath, "utf8");
    const lineCount = contents.endsWith("\n")
      ? contents.slice(0, -1).split("\n").length
      : contents.split("\n").length;
    const limit = grandfatheredLineLimits.get(relativePath) ?? defaultLineLimit;
    if (lineCount > limit) {
      violations.push(`${relativePath}: ${lineCount} lines exceeds ${limit}`);
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("extracted leaf modules do not import their owning facade", async () => {
  const violations = [];
  for (const [relativePath, forbiddenImport] of forbiddenFacadeImports) {
    const contents = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    if (
      contents.includes(`from "${forbiddenImport}"`) ||
      contents.includes(`from '${forbiddenImport}'`)
    ) {
      violations.push(`${relativePath}: imports ${forbiddenImport}`);
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("run compiler facade and package root preserve the reviewed export surface", () => {
  const configPath = path.join(repositoryRoot, "packages/core/tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const program = ts.createProgram(config.fileNames, config.options);
  const checker = program.getTypeChecker();
  const runProgramExports = moduleExports(
    program,
    checker,
    "packages/core/src/compiler/run-program.ts",
  );
  const packageRootExports = moduleExports(program, checker, "packages/core/src/index.ts");

  assert.deepEqual([...runProgramExports.keys()].sort(), intendedRunProgramExports);
  assert.deepEqual(
    exportsWithIdentity(runProgramExports, checker, "value"),
    runProgramValueExports,
  );
  assert.deepEqual(exportsWithIdentity(runProgramExports, checker, "type"), runProgramTypeExports);
  assert.deepEqual(
    exportsWithIdentity(runProgramExports, checker, "class"),
    runProgramClassExports,
  );

  const runProgramFamilyAtPackageRoot = [...packageRootExports.entries()]
    .filter(([, symbol]) => symbolComesFromRunProgramFamily(resolveAlias(symbol, checker)))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(runProgramFamilyAtPackageRoot, intendedRunProgramExports);

  for (const name of intendedRunProgramExports) {
    assert.strictEqual(
      resolveAlias(packageRootExports.get(name), checker),
      resolveAlias(runProgramExports.get(name), checker),
      `${name} must preserve its run-program symbol identity at the package root`,
    );
  }
});

function moduleExports(program, checker, relativePath) {
  const sourceFile = program.getSourceFile(path.join(repositoryRoot, relativePath));
  assert.ok(sourceFile, `missing source file ${relativePath}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert.ok(moduleSymbol, `missing module symbol ${relativePath}`);
  return new Map(
    checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol]),
  );
}

function exportsWithIdentity(exports, checker, identity) {
  return [...exports.entries()]
    .filter(([, symbol]) => {
      const flags = resolveAlias(symbol, checker).flags;
      const hasValue = Boolean(flags & ts.SymbolFlags.Value);
      const hasType = Boolean(flags & ts.SymbolFlags.Type);
      if (identity === "class") return hasValue && hasType;
      if (identity === "value") return hasValue && !hasType;
      return hasType && !hasValue;
    })
    .map(([name]) => name)
    .sort();
}

function resolveAlias(symbol, checker) {
  assert.ok(symbol, "missing expected export symbol");
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolComesFromRunProgramFamily(symbol) {
  return Boolean(
    symbol.declarations?.some((declaration) =>
      /\/compiler\/run-(?:attempt-guidance|check-execution|check-resolution|graph-compilation|program(?:-contracts|-support)?)\.ts$/u.test(
        declaration.getSourceFile().fileName,
      ),
    ),
  );
}

async function listTypeScriptFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listTypeScriptFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      output.push(absolutePath);
    }
  }
  return output.sort();
}
