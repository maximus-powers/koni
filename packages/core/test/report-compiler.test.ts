import { describe, expect, it } from "vitest";
import type { CompiledConfiguration } from "../src/contracts/configuration.js";
import { GraphSchema, TypedGraph } from "../src/graph/model.js";
import { compileConfiguredReports } from "../src/compiler/reports.js";
import type { RunRecord } from "../src/state/run-record.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

describe("deterministic configured reports", () => {
  it("publishes byte-stable JSON and Markdown ledgers from graph and ticket state", () => {
    const schema = new GraphSchema({
      nodeTypes: [
        {
          id: "claim",
          description: "A claim.",
          statuses: ["active", "satisfied"],
          initial_status: "active",
          fields: { statement: { type: "string", required: true } },
        },
        {
          id: "evidence",
          description: "Evidence for a claim.",
          statuses: ["active"],
          initial_status: "active",
          fields: {
            summary: { type: "string", required: true },
            polarity: { type: "string", required: true },
          },
        },
      ],
      edgeTypes: [
        { source: "evidence", relation: "supports", targets: ["claim"] },
        { source: "evidence", relation: "contradicts", targets: ["claim"] },
        { source: "evidence", relation: "informs", targets: ["claim"] },
      ],
    });
    const graph = new TypedGraph(schema, [
      {
        schema_version: "1.0",
        id: "claim-one",
        type: "claim",
        title: "Retrieval improves accuracy",
        status: "active",
        spec: { statement: "Bounded retrieval improves accuracy." },
        edges: {},
        annotations: {},
      },
      {
        schema_version: "1.0",
        id: "evidence-one",
        type: "evidence",
        title: "Evaluation delta",
        status: "active",
        spec: { summary: "Accuracy increased by two points.", polarity: "supports" },
        edges: { supports: ["claim-one"] },
        annotations: {},
      },
    ]);
    const configuration = fixtureConfiguration();
    const run = fixtureRun();

    const first = compileConfiguredReports({
      configuration,
      graph,
      run,
      compiledAt: "2026-07-16T00:00:00.000Z",
    });
    const second = compileConfiguredReports({
      configuration,
      graph,
      run,
      compiledAt: "2026-07-16T01:00:00.000Z",
    });

    expect(first.report.reportId).toBe(second.report.reportId);
    expect(first.report.bundleHash).toBe(second.report.bundleHash);
    expect(first.artifacts.map((artifact) => [artifact.path, Buffer.from(artifact.bytes).toString("utf8")]))
      .toEqual(second.artifacts.map((artifact) => [artifact.path, Buffer.from(artifact.bytes).toString("utf8")]));
    const claimJson = first.artifacts.find((artifact) =>
      artifact.ledgerId === "claim-evidence-ledger" && artifact.format === "json")!;
    const claimData = JSON.parse(Buffer.from(claimJson.bytes).toString("utf8")) as { rows: Array<Record<string, unknown>> };
    expect(claimData.rows).toEqual([{
      claim_id: "claim-one",
      statement: "Bounded retrieval improves accuracy.",
      support_count: 1,
    }]);
    const markdown = first.artifacts.find((artifact) =>
      artifact.ledgerId === "claim-evidence-ledger" && artifact.format === "markdown")!.bytes;
    const markdownText = Buffer.from(markdown).toString("utf8");
    expect(markdownText).toContain("# Claim Evidence Ledger");
    expect(markdownText).toContain("| claim | supports | statement |");
    expect(markdownText).toContain("| claim-one | 1 | Bounded retrieval improves accuracy. |");
    const ticketJson = first.artifacts.find((artifact) =>
      artifact.ledgerId === "ticket-ledger" && artifact.format === "json")!;
    expect(Buffer.from(ticketJson.bytes).toString("utf8")).toContain('"operation": "implement"');
  });
});

function fixtureConfiguration(): CompiledConfiguration {
  return {
    protocol: "koni.compiled-configuration.v1",
    schema_version: "2.0",
    package: {
      name: "@koni/research-profile",
      version: "1.0.0",
      profile_id: "research",
      profile_version: "1.0.0",
      profile_lineage: "koni.research",
    },
    baseline_bundle_sha256: SHA_A,
    effective_bundle_sha256: SHA_A,
    configuration_sha256: SHA_B,
    profile: { reporting: { bundle_kind: "research-ledger-bundle" } },
    project: {},
    modules: {
      graph: [], rules: [], operations: [], workflows: [], actions: [], checks: [],
      personas: [], reports: [], cockpit: [], lifecycles: [],
    },
    run_type_order: [],
    run_types: {},
    agents: {},
    edge_types: [
      { source: "evidence", relation: "supports", targets: ["claim"] },
      { source: "evidence", relation: "contradicts", targets: ["claim"] },
      { source: "evidence", relation: "informs", targets: ["claim"] },
    ],
    registries: {
      node_types: {
        claim: { id: "claim" },
        evidence: { id: "evidence" },
      },
      queries: {
        "active-claims": { id: "active-claims", node_types: ["claim"], status_excluding: ["satisfied"] },
      },
      graph_constraints: {},
      gate_policies: {},
      rules: {},
      operations: {},
      workflows: {},
      actions: {},
      checks: {},
      personas: {},
      reports: {
        "claim-evidence-ledger": {
          id: "claim-evidence-ledger",
          title: "Claim Evidence Ledger",
          formats: ["json", "markdown"],
          source: { query: "active-claims" },
          columns: [
            { id: "claim_id", title: "claim", value: "$row.id" },
            { id: "support_count", title: "supports", value: "$row.derived.support_count" },
            { id: "statement", value: "$row.spec.statement" },
          ],
          output: "program/reports/claim-evidence-ledger",
        },
        "ticket-ledger": {
          id: "ticket-ledger",
          title: "Ticket Ledger",
          formats: ["json", "markdown"],
          source: { tickets: "all" },
          columns: [
            { id: "ticket_id", value: "$row.id" },
            { id: "operation", value: "$row.operation" },
            { id: "status", value: "$row.status" },
          ],
          output: "program/reports/ticket-ledger",
        },
      },
      views: {},
      state_machines: {},
      agents: {},
    },
  } as CompiledConfiguration;
}

function fixtureRun(): RunRecord {
  return {
    id: "run-report",
    compiledConfigHash: SHA_B,
    tickets: {
      "ticket-one": {
        id: "ticket-one",
        operationId: "implement",
        title: "Implement retrieval",
        summary: "Implement the bounded change.",
        status: "completed",
        priority: 1,
        dependencyIds: [],
        targetNodeIds: ["claim-one"],
        readPaths: ["src"],
        writePaths: ["src"],
        steps: [],
        worktreePath: undefined,
        branch: undefined,
        blocker: undefined,
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    },
    attempts: {},
    checks: [],
  } as unknown as RunRecord;
}
