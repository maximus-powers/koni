import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compileProfileConfiguration } from "../src/compiler/configuration.js";
import { projectGraphSchemaDefinition } from "../src/compiler/graph-schema.js";
import {
  RULE_AUTHORITY_EVIDENCE_PROTOCOL,
  createProductionRuleDomainAdapter,
  createRuleAuthorityEvidence,
  ruleInputGraphSha256,
  rulePredicateEvidenceKey,
  type RuleAuthorityEvidence,
} from "../src/compiler/domain-adapter.js";
import { GraphExpressionEvaluator, type RuleDomainAdapter } from "../src/compiler/expressions.js";
import {
  parseProfilePackageManifest,
  type VerifiedProfileBaseline,
} from "../src/compiler/profile-package.js";
import { evaluateConfiguredRules } from "../src/compiler/rules.js";
import { applyReviewEffects } from "../src/compiler/run-program.js";
import type { CompiledConfiguration, ConfigurationObject } from "../src/contracts/configuration.js";
import {
  DERIVED_TICKET_PROTOCOL,
  type CompilerGraphNode,
  type CompilerGraphProjection,
  type DerivedTicketDefinition,
  type DerivedWorkflowStep,
} from "../src/contracts/rules.js";
import { GraphSchema, TypedGraph, type GraphNode } from "../src/graph/model.js";
import type { Sha256Digest } from "../src/shared/canonical.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];
const NOW = "2026-07-16T21:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("provider-free domain flows", () => {
  it("keeps expected-red research gates blocked until a typed passing verifier receipt exists", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const claim = node("claim-a", "claim", "Bounded claim", "active");
    const gate = node(
      "gate-a",
      "gate",
      "Deterministic gate",
      "draft",
      {
        assertion: "The bounded verifier passes",
        applicability: "Claim A under the fixture condition",
        capability: { name: "fixture.verifier", protocol_range: ">=1.0.0 <2.0.0" },
        command_result_contract: { result_protocol: "autoresearch.gate-result.v1" },
        oracle_semantics: {
          pass: "The typed verifier passed",
          fail: "The typed verifier failed",
          inconclusive: "The verifier could not discriminate",
          contract_error: "The result violated its typed contract",
        },
        failure_meaning: "Downstream work remains blocked",
        expected_red: true,
      },
      { applies_to: [claim.id] },
    );
    const asset = node(
      "asset-a",
      "asset",
      "Compatible verifier",
      "active",
      {
        capabilities: [{ name: "fixture.verifier", protocol_version: "1.2.0" }],
        gate_contracts: { [gate.id]: { command: ["node", "program/assets/verify.mjs"] } },
      },
      { validates: [gate.id] },
    );
    const graph = projection([claim, gate, asset]);
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);

    evaluator.bind("target", [gate.id]);

    expect(gate.spec.expected_red).toBe(true);
    expect(
      evaluator.evaluate({
        op: "gate_policy_has_selection",
        gate_policy: "research-capability-gates",
        gate_subject: "$target",
      }),
    ).toBe(true);
    expect(
      evaluator.evaluate({
        op: "gate_policy_satisfied",
        gate_policy: "research-capability-gates",
        gate_subject: "$target",
      }),
    ).toBe(false);
    const compiled = evaluateConfiguredRules(
      { configuration, graph },
      { ruleIds: ["readiness.gate-verdict"], adapter },
    );
    expect(compiled.ok, diagnostics(compiled)).toBe(true);
    if (compiled.ok) expect(compiled.value.facts).toEqual([]);
  });

  it("promotes only receipt-complete research evidence and invalidates stale or incomplete coverage", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const claim = node("claim-a", "claim", "Bounded claim", "active");
    const run = node("run-a", "run", "Empirical run", "active", {
      intent: "Measure the bounded outcome",
    });
    const experiment = node(
      "experiment-a",
      "experiment",
      "Bounded experiment",
      "active",
      {},
      {
        target_claims: [claim.id],
        runs: [run.id],
      },
    );
    const candidate = evidenceNode("evidence-a", claim.id, run.id, "receipt-run-a", "supported");
    const graph = projection([claim, experiment, run, candidate]);
    const evidence = runtimeEvidence(configuration, graph, new Map([[run.id, "receipt-run-a"]]));
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
      evidence,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);

    expect(evaluator.select("promoted-current-evidence")).toEqual([candidate.id]);

    const incomplete = {
      ...candidate,
      spec: { ...candidate.spec, receipt_refs: [] },
    };
    const incompleteGraph = projection([claim, experiment, run, incomplete]);
    const incompleteEvidence = runtimeEvidence(
      configuration,
      incompleteGraph,
      new Map([[run.id, "receipt-run-a"]]),
    );
    const incompleteAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: incompleteGraph,
      projectRoot: root,
      evidence: incompleteEvidence,
    });
    expect(
      new GraphExpressionEvaluator(configuration, incompleteGraph, incompleteAdapter).select(
        "promoted-current-evidence",
      ),
    ).toEqual([]);

    const unreviewed = {
      ...candidate,
      spec: Object.fromEntries(
        Object.entries(candidate.spec).filter(
          ([field]) => !["promotion_state", "promoted_by", "promotion_review_id"].includes(field),
        ),
      ),
    };
    const unreviewedGraph = projection([claim, experiment, run, unreviewed]);
    const unreviewedEvidence = runtimeEvidence(
      configuration,
      unreviewedGraph,
      new Map([[run.id, "receipt-run-a"]]),
    );
    const unreviewedAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: unreviewedGraph,
      projectRoot: root,
      evidence: unreviewedEvidence,
    });
    expect(
      new GraphExpressionEvaluator(configuration, unreviewedGraph, unreviewedAdapter).select(
        "promoted-current-evidence",
      ),
    ).toEqual([]);
  });

  it("lets only an authenticated passing review promote the authored research evidence candidate", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const claim = node("claim-review", "claim", "Reviewed claim", "active", {
      statement: "The bounded observation supports the claim under the fixture condition.",
      scope: "Only the provider-free fixture condition.",
      assumptions: ["The fixture input is representative only of its declared condition."],
      falsification: "A current typed receipt records a contradicted outcome.",
      evidence_standard:
        "Only current typed runtime receipts may support or contradict the scoped claim.",
      threat_model: ["Stale or incomplete receipt provenance must block promotion."],
    });
    const run = node("run-review", "run", "Reviewed run", "active", {
      intent: "Produce one bounded runtime observation.",
    });
    const experiment = node(
      "experiment-review",
      "experiment",
      "Reviewed experiment",
      "active",
      {
        objective: "Discriminate the bounded claim with a runtime observation.",
        target_claim_summary: "The reviewed claim under the fixture condition.",
        empirical_mode: "observation",
        execution_protocol: "Execute the provider-free fixture once and capture its typed result.",
        observable_outcome: "The typed fixture result distinguishes supported from contradicted.",
      },
      { target_claims: [claim.id], runs: [run.id] },
    );
    const reviewedShape = evidenceNode(
      "evidence-review",
      claim.id,
      run.id,
      "receipt-review",
      "supported",
    );
    const candidate = {
      ...reviewedShape,
      spec: Object.fromEntries(
        Object.entries(reviewedShape.spec).filter(
          ([field]) => !["promotion_state", "promoted_by", "promotion_review_id"].includes(field),
        ),
      ),
    };
    const graph = typedGraph(configuration, [claim, experiment, run, candidate]);
    const ticket = reviewTicket(configuration, claim.id);
    const step = ticket.workflow[0]!;

    await expect(
      applyReviewEffects({
        configuration,
        graph,
        ticket,
        step,
        reviewId: "attempt-review-unbound",
        actor: "lead",
        candidateNodeIds: [candidate.id],
        projectRoot: root,
      }),
    ).rejects.toMatchObject({ code: "review_effect_receipt_coverage" });
    expect(graph.node(candidate.id)?.spec.promotion_state).toBeUndefined();

    const evidence = runtimeEvidence(configuration, graph, new Map([[run.id, "receipt-review"]]));
    const applied = await applyReviewEffects({
      configuration,
      graph,
      ticket,
      step,
      reviewId: "attempt-review-passing",
      actor: "lead",
      candidateNodeIds: [candidate.id],
      projectRoot: root,
      evidence,
    });
    expect(applied.changes).toEqual([
      expect.objectContaining({ kind: "modified", nodeId: candidate.id }),
    ]);
    expect(applied.graph.node(candidate.id)?.spec).toMatchObject({
      promotion_state: "lead-promoted",
      promoted_by: "lead",
      promotion_review_id: "attempt-review-passing",
    });

    const replayEvidence = runtimeEvidence(
      configuration,
      applied.graph,
      new Map([[run.id, "receipt-review"]]),
    );
    const replayed = await applyReviewEffects({
      configuration,
      graph: applied.graph,
      ticket,
      step,
      reviewId: "attempt-review-recovered",
      actor: "lead",
      candidateNodeIds: [candidate.id],
      projectRoot: root,
      evidence: replayEvidence,
    });
    expect(replayed.changes).toEqual([
      expect.objectContaining({ kind: "modified", nodeId: candidate.id }),
    ]);
    expect(replayed.graph.node(candidate.id)?.spec).toMatchObject({
      promotion_state: "lead-promoted",
      promoted_by: "lead",
      promotion_review_id: "attempt-review-recovered",
    });

    const exactReplay = await applyReviewEffects({
      configuration,
      graph: replayed.graph,
      ticket,
      step,
      reviewId: "attempt-review-recovered",
      actor: "lead",
      candidateNodeIds: [candidate.id],
      projectRoot: root,
      evidence: runtimeEvidence(
        configuration,
        replayed.graph,
        new Map([[run.id, "receipt-review"]]),
      ),
    });
    expect(exactReplay.changes).toEqual([]);
    expect(exactReplay.graph.hash).toBe(replayed.graph.hash);
  });

  it("compiler-accepts a reviewed asset manifest and invalidates it only when bytes drift", async () => {
    const root = await temporaryRoot();
    const assetRoot = join(root, "program", "assets", "fixture-tool");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(join(assetRoot, "run.py"), "print('ready')\n");
    const configuration = structuredClone(compileProfile("research-profile"));
    const assetType = configuration.registries.node_types.asset as {
      filesystem_manifest?: Record<string, unknown>;
    };
    delete assetType.filesystem_manifest?.files_field;
    const asset = node("asset-reviewed", "asset", "Reviewed fixture tool", "active", {
      capabilities: [{ name: "fixture.tool", protocol_version: "1.0.0" }],
      implementation_plan: {
        root: "program/assets/fixture-tool",
        files: ["program/assets/fixture-tool/run.py"],
      },
      implementation: {
        kind: "script",
        entrypoints: ["program/assets/fixture-tool/run.py"],
      },
      source_strategy: "generated",
    });
    const graph = typedGraph(configuration, [asset]);
    const ticket = assetReviewTicket(configuration, asset.id);
    const applied = await applyReviewEffects({
      configuration,
      graph,
      ticket,
      step: ticket.workflow[0]!,
      reviewId: "attempt-asset-review",
      actor: "reviewer",
      candidateNodeIds: [asset.id],
      projectRoot: root,
    });

    expect(applied.changes).toEqual([
      expect.objectContaining({ kind: "modified", nodeId: asset.id }),
    ]);
    expect(applied.graph.node(asset.id)).toMatchObject({
      asset_manifest: {
        vendor_status: "vendored",
        implementation_status: "ready",
        content_hash: expect.stringMatching(/^sha256:/u),
        accepted_content_hash: expect.stringMatching(/^sha256:/u),
        implementation_errors: [],
      },
    });

    const currentAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: applied.graph,
      projectRoot: root,
    });
    const current = new GraphExpressionEvaluator(configuration, applied.graph, currentAdapter);
    current.bind("target", [asset.id]);
    expect(current.evaluate({ op: "filesystem_manifest_current" })).toBe(true);
    expect(
      current.evaluate({
        op: "field_equals",
        field: "asset_manifest.implementation_status",
        value: "ready",
      }),
    ).toBe(true);
    expect(
      current.evaluate({
        op: "field_equals",
        field: "asset_manifest.vendor_status",
        value: "vendored",
      }),
    ).toBe(true);

    await writeFile(join(assetRoot, "sibling.py"), "print('independent sibling')\n");
    const siblingAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: applied.graph,
      projectRoot: root,
    });
    const sibling = new GraphExpressionEvaluator(configuration, applied.graph, siblingAdapter);
    sibling.bind("target", [asset.id]);
    expect(sibling.evaluate({ op: "filesystem_manifest_current" })).toBe(true);

    await writeFile(join(assetRoot, "run.py"), "print('changed')\n");
    const staleAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: applied.graph,
      projectRoot: root,
    });
    const stale = new GraphExpressionEvaluator(configuration, applied.graph, staleAdapter);
    stale.bind("target", [asset.id]);
    expect(stale.evaluate({ op: "filesystem_manifest_current" })).toBe(false);
  });

  it("accepts research conclusions only with exact current citations, dispositions, and limitations", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("research-profile");
    const claimA = node("claim-a", "claim", "Supported claim", "active");
    const claimB = node("claim-b", "claim", "Unresolved claim", "active");
    const hypothesis = node(
      "hypothesis-a",
      "hypothesis",
      "Bounded hypothesis",
      "active",
      {
        hypothesis: "The bounded intervention improves the measured outcome",
      },
      { claims: [claimA.id, claimB.id] },
    );
    const runA = node("run-a", "run", "Supported run", "active", { intent: "Measure claim A" });
    const runB = node("run-b", "run", "Inconclusive run", "active", { intent: "Measure claim B" });
    const experimentA = node(
      "experiment-a",
      "experiment",
      "Experiment A",
      "active",
      {},
      {
        target_claims: [claimA.id],
        runs: [runA.id],
      },
    );
    const experimentB = node(
      "experiment-b",
      "experiment",
      "Experiment B",
      "active",
      {},
      {
        target_claims: [claimB.id],
        runs: [runB.id],
      },
    );
    const evidenceA = withRunCoverage(
      evidenceNode("evidence-a", claimA.id, runA.id, "receipt-run-a", "supported"),
      [
        [runA.id, "receipt-run-a", "supports"],
        [runB.id, "receipt-run-b", "neutral"],
      ],
    );
    const evidenceB = withRunCoverage(
      evidenceNode("evidence-b", claimB.id, runB.id, "receipt-run-b", "inconclusive"),
      [
        [runA.id, "receipt-run-a", "supports"],
        [runB.id, "receipt-run-b", "neutral"],
      ],
    );
    const report = node(
      "report-a",
      "report",
      "Reviewed conclusion",
      "active",
      {
        summary: "One bounded claim is supported and one remains unresolved.",
        synthesis: "The current promoted evidence supports only the measured slice.",
        conclusion: "Supported within the observed scope; the second claim is inconclusive.",
        claim_dispositions: { [claimA.id]: "supported", [claimB.id]: "inconclusive" },
        curated_evidence_refs: [evidenceA.id, evidenceB.id],
        conclusion_rationale: "The conclusion follows the two current typed runtime receipts.",
        limitations: ["The inconclusive claim is not promoted into a positive conclusion."],
        hypothesis_id: hypothesis.id,
        concluded_by: "lead",
        conclusion_review_id: "review-conclusion-a",
      },
      { cites: [evidenceA.id, evidenceB.id], summarizes: [hypothesis.id] },
    );
    const graph = projection([
      hypothesis,
      claimA,
      claimB,
      experimentA,
      experimentB,
      runA,
      runB,
      evidenceA,
      evidenceB,
      report,
    ]);
    const evidence = runtimeEvidence(
      configuration,
      graph,
      new Map([
        [runA.id, "receipt-run-a"],
        [runB.id, "receipt-run-b"],
      ]),
    );
    const adapter = await createProductionRuleDomainAdapter({
      configuration,
      graph,
      projectRoot: root,
      evidence,
    });
    const evaluator = new GraphExpressionEvaluator(configuration, graph, adapter);

    expect(evaluator.select("reviewed-conclusion-reports")).toEqual([report.id]);
    expect(report.spec.claim_dispositions).toEqual({
      [claimA.id]: "supported",
      [claimB.id]: "inconclusive",
    });
    expect(report.spec.limitations).toEqual([
      "The inconclusive claim is not promoted into a positive conclusion.",
    ]);

    const missingCitation = { ...report, edges: { ...report.edges, cites: [evidenceA.id] } };
    const staleGraph = projection([
      hypothesis,
      claimA,
      claimB,
      experimentA,
      experimentB,
      runA,
      runB,
      evidenceA,
      evidenceB,
      missingCitation,
    ]);
    const staleEvidence = runtimeEvidence(
      configuration,
      staleGraph,
      new Map([
        [runA.id, "receipt-run-a"],
        [runB.id, "receipt-run-b"],
      ]),
    );
    const staleAdapter = await createProductionRuleDomainAdapter({
      configuration,
      graph: staleGraph,
      projectRoot: root,
      evidence: staleEvidence,
    });
    expect(
      new GraphExpressionEvaluator(configuration, staleGraph, staleAdapter).select(
        "reviewed-conclusion-reports",
      ),
    ).toEqual([]);
  });

  it("emits software implementation only after symptom, causal diagnosis, and expected-red proof", () => {
    const configuration = compileProfile("coding-profile");
    const objective = node(
      "objective-a",
      "objective",
      "Repair bounded defect",
      "active",
      {
        outcome: "The bounded path returns the corrected result",
        work_kind: "bug_fix",
      },
      { systems: ["system-a"] },
    );
    const system = node("system-a", "system", "Bounded service", "active", {
      kind: "service",
      responsibility: "Return the bounded result",
      contract_required: false,
      contract_reason: "No compatibility boundary changes",
      owned_paths: ["src"],
    });
    const diagnostic = proofNode("proof-diagnostic", "prepared", "proof-expected-red", [
      "defect-a",
    ]);
    const implementationProof = proofNode("proof-regression", "prepared", "proof-expected-red", [
      "change-a",
    ]);
    const unresolved = node(
      "defect-a",
      "defect",
      "Early return",
      "unresolved",
      {
        expected_behavior: "The bounded condition is applied",
        observed_behavior: "The function returns before applying it",
        reproduction_signal: "The focused diagnostic returns the historical wrong value",
      },
      {
        concerns: [objective.id],
        manifests_in: [system.id],
        verified_by: [diagnostic.id],
      },
    );
    const change = node(
      "change-a",
      "change",
      "Repair early return",
      "planned",
      {
        approval_claim: "Apply the bounded condition before returning",
        proof_strategy: "red_green",
        risk_tier: "routine",
        risk_factors: ["bounded branch behavior"],
        owned_paths: ["src"],
      },
      {
        realizes: [objective.id],
        affects: [system.id],
        addresses: [unresolved.id],
        verified_by: [implementationProof.id],
      },
    );
    const adapter = alwaysCurrentSoftwareEvidence();
    const unresolvedGraph = projection([
      objective,
      system,
      unresolved,
      diagnostic,
      change,
      implementationProof,
    ]);
    const unresolvedEvaluator = new GraphExpressionEvaluator(
      configuration,
      unresolvedGraph,
      adapter,
    );
    expect(unresolvedEvaluator.select("implementation_ready_changes")).toEqual([]);

    const diagnosed = {
      ...unresolved,
      status: "diagnosed",
      spec: {
        ...unresolved.spec,
        root_cause: "The early return precedes the required bounded condition",
        causal_chain: [
          "input reaches branch",
          "early return skips condition",
          "wrong result escapes",
        ],
        ruled_out_alternatives: ["caller input is valid", "downstream formatting is not causal"],
      },
    };
    const diagnosedGraph = projection([
      objective,
      system,
      diagnosed,
      diagnostic,
      change,
      implementationProof,
    ]);
    const diagnosedEvaluator = new GraphExpressionEvaluator(configuration, diagnosedGraph, adapter);
    expect(diagnosedEvaluator.select("implementation_ready_changes")).toEqual([change.id]);
    const compiled = evaluateConfiguredRules(
      { configuration, graph: diagnosedGraph },
      { ruleIds: ["change.implement-red-green"], adapter },
    );
    expect(compiled.ok, diagnostics(compiled)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.tickets).toHaveLength(1);
    expect(compiled.value.tickets[0]?.target_node_ids).toEqual([change.id, implementationProof.id]);
    expect(compiled.value.tickets[0]?.scope.read_node_ids).toEqual(
      expect.arrayContaining([change.id, diagnosed.id, implementationProof.id]),
    );
  });

  it("keeps software closure blocked until regression, broader checks, and exact review coverage are current", async () => {
    const root = await temporaryRoot();
    const configuration = compileProfile("coding-profile");
    const objective = node("objective-a", "objective", "Ship bounded feature", "active", {
      outcome: "The bounded feature is available",
      work_kind: "general",
    });
    const change = node(
      "change-a",
      "change",
      "Implement bounded feature",
      "implemented",
      {
        approval_claim: "Expose the bounded feature",
        proof_strategy: "current_verification",
        risk_tier: "routine",
        risk_factors: ["bounded behavior"],
        owned_paths: ["src"],
      },
      { realizes: [objective.id] },
    );
    const proof = proofNode("proof-a", "passing", "proof-current-baseline", [change.id]);
    const baseGraph = projection([objective, change, proof]);

    const staleAdapter = await softwareAdapter(configuration, baseGraph, root, false);
    expect(
      new GraphExpressionEvaluator(configuration, baseGraph, staleAdapter).select(
        "delivery_ready_objectives",
      ),
    ).toEqual([]);

    const currentAdapter = await softwareAdapter(configuration, baseGraph, root, true);
    expect(
      new GraphExpressionEvaluator(configuration, baseGraph, currentAdapter).select(
        "delivery_ready_objectives",
      ),
    ).toEqual([objective.id]);

    const delivery = node(
      "delivery-a",
      "delivery",
      "Exact candidate",
      "candidate_ready",
      {
        target_branch: "refs/heads/main",
        summary: "The exact current closure is ready for operator merge",
      },
      { fulfills: [objective.id], includes: [change.id, proof.id], acknowledges: [] },
    );
    const closedGraph = projection([objective, change, proof, delivery]);
    const closedAdapter = await softwareAdapter(configuration, closedGraph, root, true);
    const closedEvaluator = new GraphExpressionEvaluator(configuration, closedGraph, closedAdapter);
    expect(closedEvaluator.select("current_candidate_deliveries")).toEqual([delivery.id]);
    const closed = evaluateConfiguredRules(
      { configuration, graph: closedGraph },
      { ruleIds: ["delivery.prepare"], adapter: closedAdapter },
    );
    expect(closed.ok, diagnostics(closed)).toBe(true);
    if (closed.ok) expect(closed.value.tickets).toEqual([]);

    const incompleteDelivery = { ...delivery, edges: { ...delivery.edges, includes: [change.id] } };
    const incompleteGraph = projection([objective, change, proof, incompleteDelivery]);
    const incompleteAdapter = await softwareAdapter(configuration, incompleteGraph, root, true);
    expect(
      new GraphExpressionEvaluator(configuration, incompleteGraph, incompleteAdapter).select(
        "current_candidate_deliveries",
      ),
    ).toEqual([]);
    const reopened = evaluateConfiguredRules(
      { configuration, graph: incompleteGraph },
      { ruleIds: ["delivery.prepare"], adapter: incompleteAdapter },
    );
    expect(reopened.ok, diagnostics(reopened)).toBe(true);
    if (reopened.ok) expect(reopened.value.tickets).toHaveLength(1);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "koni-domain-flow-"));
  temporaryRoots.push(root);
  return root;
}

function compileProfile(
  packageDirectory: "coding-profile" | "research-profile",
): CompiledConfiguration {
  const result = compileProfileConfiguration(readBaseline(packageDirectory));
  if (!result.ok) throw new Error(diagnostics(result));
  return result.value;
}

function readBaseline(packageDirectory: string): VerifiedProfileBaseline {
  const packageRoot = resolve(repositoryRoot, "packages", packageDirectory, "koni");
  const manifest = parseProfilePackageManifest(
    readFileSync(join(packageRoot, "profile-manifest.json"), "utf8"),
  );
  if (!manifest.ok) throw new Error(diagnostics(manifest));
  return { manifest: manifest.value, files: readTree(join(packageRoot, "baseline")) };
}

function readTree(root: string): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile())
        files.set(relative(root, candidate).split(sep).join("/"), readFileSync(candidate));
    }
  };
  visit(root);
  return files;
}

function projection(nodes: readonly CompilerGraphNode[]): CompilerGraphProjection {
  return { nodes: () => nodes, node: (id) => nodes.find((candidate) => candidate.id === id) };
}

function node(
  id: string,
  type: string,
  title: string,
  status: string,
  spec: ConfigurationObject = {},
  edges: Readonly<Record<string, readonly string[]>> = {},
): CompilerGraphNode {
  return { id, type, title, status, spec, edges };
}

function typedGraph(
  configuration: CompiledConfiguration,
  nodes: readonly CompilerGraphNode[],
): TypedGraph {
  const projected = projectGraphSchemaDefinition(configuration);
  if (!projected.ok) throw new Error(diagnostics(projected));
  const schema = new GraphSchema(projected.value);
  return new TypedGraph(
    schema,
    nodes.map((value): GraphNode => ({
      schema_version: "1.0",
      id: value.id,
      type: value.type,
      title: value.title,
      status: value.status,
      spec: structuredClone(value.spec) as GraphNode["spec"],
      edges: Object.fromEntries(
        Object.entries(value.edges).map(([relation, targets]) => [relation, [...targets]]),
      ),
      annotations: structuredClone(value.annotations ?? {}) as GraphNode["annotations"],
    })),
  );
}

function reviewTicket(
  configuration: CompiledConfiguration,
  claimId: string,
): DerivedTicketDefinition {
  const step: DerivedWorkflowStep = {
    id: "review",
    kind: "review",
    persona_id: "reviewer",
    depends_on: ["synthesize-evidence"],
    required: true,
    expected_outputs: ["Independent evidence promotion review"],
    graph_mutation: "forbidden",
    validation_action: "review",
    required_receipts: [],
    escalation_triggers: [],
    stop_conditions: [],
    validation_checks: [],
    context_sha256: configuration.configuration_sha256,
  };
  return {
    protocol: DERIVED_TICKET_PROTOCOL,
    id: "ticket-review-evidence",
    rule_id: "ticket.evidence-synthesis",
    rule_phase: "ticket_emission",
    rule_priority: 1,
    anchor_node_id: claimId,
    operation: "synthesize-evidence",
    operation_registry_id: "evidence-reports.node.synthesize-evidence",
    operation_dispatch_priority: 1,
    ranking_hints: [],
    title: "Review candidate evidence",
    target_node_ids: [claimId],
    scope: { read_node_ids: [claimId], write_node_ids: [claimId], read_paths: [], write_paths: [] },
    source_state_key: "candidate-authored",
    target_state_key: "candidate-reviewed",
    obligation_keys: ["evidence.review"],
    workflow_id: "synthesize-evidence",
    review_failure_reopen_from: "synthesize-evidence",
    workflow: [step],
    configuration_sha256: configuration.configuration_sha256,
    definition_sha256: configuration.configuration_sha256,
  };
}

function assetReviewTicket(
  configuration: CompiledConfiguration,
  assetId: string,
): DerivedTicketDefinition {
  const review = reviewTicket(configuration, assetId);
  return {
    ...review,
    id: "ticket-review-asset",
    rule_id: "ticket.implement-asset",
    anchor_node_id: assetId,
    operation: "implement-asset",
    operation_registry_id: "asset-resolution.asset.implement-asset",
    title: "Review implemented asset",
    target_node_ids: [assetId],
    scope: {
      read_node_ids: [assetId],
      write_node_ids: [assetId],
      read_paths: ["program/assets/fixture-tool"],
      write_paths: ["program/assets/fixture-tool"],
    },
    source_state_key: "asset-incomplete",
    target_state_key: "asset-ready",
    obligation_keys: ["asset.implementation"],
    workflow_id: "implement-asset",
  };
}

function evidenceNode(
  id: string,
  claimId: string,
  runId: string,
  receiptId: string,
  polarity: "supported" | "contradicted" | "inconclusive",
): CompilerGraphNode {
  return node(
    id,
    "evidence",
    `Evidence ${id}`,
    "active",
    {
      summary: `Current bounded observation for ${claimId}`,
      interpretation: `The typed result is ${polarity} within scope`,
      evidence_basis: "empirical_runtime",
      inference_scope: "bounded_empirical",
      polarity,
      confidence: polarity === "inconclusive" ? "low" : "high",
      scope: "Only the declared fixture population and condition",
      limitations: ["No claim beyond the measured condition"],
      receipt_refs: [receiptId],
      run_dispositions: {
        [runId]: {
          disposition:
            polarity === "supported"
              ? "supports"
              : polarity === "contradicted"
                ? "contradicts"
                : "neutral",
          receipt_id: receiptId,
          rationale: `The current typed receipt is ${polarity}`,
        },
      },
      promotion_state: "lead-promoted",
      promoted_by: "lead",
      promotion_review_id: `review-${id}`,
    },
    { [polarity === "contradicted" ? "contradicts" : "supports"]: [claimId], from_runs: [runId] },
  );
}

function withRunCoverage(
  candidate: CompilerGraphNode,
  runs: readonly (readonly [runId: string, receiptId: string, disposition: string])[],
): CompilerGraphNode {
  return {
    ...candidate,
    spec: {
      ...candidate.spec,
      receipt_refs: runs.map(([, receiptId]) => receiptId),
      run_dispositions: Object.fromEntries(
        runs.map(([runId, receiptId, disposition]) => [
          runId,
          {
            disposition,
            receipt_id: receiptId,
            rationale: `The current typed receipt records ${disposition}`,
          },
        ]),
      ),
    },
    edges: { ...candidate.edges, from_runs: runs.map(([runId]) => runId) },
  };
}

function runtimeEvidence(
  configuration: CompiledConfiguration,
  graph: CompilerGraphProjection,
  receipts: ReadonlyMap<string, string>,
): RuleAuthorityEvidence {
  const inputGraphSha256 = ruleInputGraphSha256(configuration, graph);
  const predicates: Record<
    Sha256Digest,
    import("../src/compiler/domain-adapter.js").RulePredicateEvidence
  > = {};
  for (const [runId, receiptId] of [...receipts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const leaf: ConfigurationObject = {
      op: "current_receipt",
      subject: "$covered_run",
      receipt_type: "runtime.receipt",
    };
    const bindings = { covered_run: [runId] };
    const key = rulePredicateEvidenceKey({
      configurationSha256: configuration.configuration_sha256,
      inputGraphSha256,
      leaf,
      subjectNodeId: runId,
      bindings,
    });
    predicates[key] = {
      key,
      result: true,
      recordedAt: NOW,
      sourceReceiptIds: [receiptId],
      leaf,
      subjectNodeId: runId,
      bindings,
    };
  }
  return createRuleAuthorityEvidence({
    protocol: RULE_AUTHORITY_EVIDENCE_PROTOCOL,
    configurationSha256: configuration.configuration_sha256,
    inputGraphSha256,
    predicates,
  });
}

function proofNode(
  id: string,
  status: string,
  baselineCheckId: string,
  verifies: readonly string[],
): CompilerGraphNode {
  return node(
    id,
    "proof",
    `Proof ${id}`,
    status,
    {
      purpose: "focused",
      command: ["node", `tests/${id}.mjs`],
      baseline_check_id: baselineCheckId,
      source_paths: [`tests/${id}.mjs`],
      covered_paths: ["src"],
      oracle_cases: [{ condition: "bounded fixture", claim: "observable behavior is correct" }],
      working_directory: ".",
      conditions: ["bounded fixture"],
      expected_signal: "the focused assertion passes",
      why: "This is the smallest repository-native proof seam",
    },
    { verifies },
  );
}

function alwaysCurrentSoftwareEvidence(): RuleDomainAdapter {
  return {
    evaluatePredicate(leaf) {
      if (leaf.op === "proof_preparation_current") return true;
      if (leaf.op === "check_passed") return true;
      return false;
    },
  };
}

async function softwareAdapter(
  configuration: CompiledConfiguration,
  graph: CompilerGraphProjection,
  projectRoot: string,
  checksCurrent: boolean,
): Promise<RuleDomainAdapter> {
  const production = await createProductionRuleDomainAdapter({ configuration, graph, projectRoot });
  return {
    ...(production.selectPolicy === undefined ? {} : { selectPolicy: production.selectPolicy }),
    evaluatePredicate(leaf, context) {
      if (leaf.op === "proof_preparation_current") return true;
      if (leaf.op === "check_passed") return checksCurrent;
      return production.evaluatePredicate?.(leaf, context);
    },
  };
}

function diagnostics(result: {
  diagnostics: readonly { path: string; code: string; message: string }[];
}): string {
  return result.diagnostics.map((item) => `${item.path}:${item.code}:${item.message}`).join("\n");
}
