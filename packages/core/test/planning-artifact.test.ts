import { describe, expect, it } from "vitest";
import {
  applyPlanningArtifactPatch,
  canonicalizePlanningGraphSeed,
  parsePlanningArtifact,
  type PlanningArtifact,
  type PlanningGraphSeedEdge,
} from "../src/compiler/planning-artifact.js";
import { canonicalHash } from "../src/shared/canonical.js";

describe("planning artifact revisions", () => {
  it("materializes a revision without rewriting unaffected plan domains", () => {
    const base = planningArtifactFixture();
    const revised = applyPlanningArtifactPatch(base, {
      baseRevision: 0,
      baseArtifactSha256: canonicalHash(base),
      full: { verification: "Use the exact composed verification seam." },
      graphSeed: {
        upsertNodes: [
          {
            key: "proof-main",
            type: "proof",
            title: "Composed proof",
            spec: { method: "composed" },
          },
        ],
      },
    });

    expect(revised.full.architecture).toBe(base.full.architecture);
    expect(revised.full.decisions).toBe(base.full.decisions);
    expect(revised.full.risk).toBe(base.full.risk);
    expect(revised.full.verification).not.toBe(base.full.verification);
    expect(revised.graphSeed.nodes.find((node) => node.key === "proof-main")?.title).toBe(
      "Composed proof",
    );
  });

  it("rejects a patch that does not name the exact base artifact hash", () => {
    const base = planningArtifactFixture();
    expect(() =>
      applyPlanningArtifactPatch(base, {
        baseRevision: 0,
        baseArtifactSha256: canonicalHash("another artifact"),
        full: { risk: "This patch is bound to the wrong checkpoint." },
      }),
    ).toThrow(/base artifact hash/u);
  });

  it("upserts and removes nodes only with their exact incident edge removals", () => {
    const base = planningArtifactFixture();
    const incident = edge("proof-main", "supports", "change-secondary");
    const revised = applyPlanningArtifactPatch(base, {
      baseRevision: 0,
      baseArtifactSha256: canonicalHash(base),
      graphSeed: {
        upsertNodes: [
          {
            key: "proof-main",
            type: "proof",
            title: "Updated proof",
            spec: { method: "runtime" },
          },
        ],
        removeNodeKeys: ["change-secondary"],
        removeEdges: [incident],
      },
    });

    expect(revised.graphSeed.nodes.map((node) => node.key)).toEqual(["proof-main"]);
    expect(revised.graphSeed.edges).toEqual([edge("$root", "requires", "proof-main")]);
  });

  it("rejects a node removal that would leave a dangling edge", () => {
    const base = planningArtifactFixture();
    expect(() =>
      applyPlanningArtifactPatch(base, {
        baseRevision: 0,
        baseArtifactSha256: canonicalHash(base),
        graphSeed: { removeNodeKeys: ["change-secondary"] },
      }),
    ).toThrow(/unknown local key|dangling/u);
  });

  it("rejects removal or replacement of protected root fields", () => {
    const base = planningArtifactFixture();
    expect(() =>
      applyPlanningArtifactPatch(
        base,
        {
          baseRevision: 0,
          baseArtifactSha256: canonicalHash(base),
          graphSeed: { removeRootSpecFields: ["objective"] },
        },
        { protectedRootSpecFields: ["objective"] },
      ),
    ).toThrow(/protected root field/u);
  });

  it("canonicalizes node, edge, and root field ordering", () => {
    const base = planningArtifactFixture();
    const canonical = canonicalizePlanningGraphSeed({
      rootSpec: { zeta: "last", alpha: "first" },
      nodes: [...base.graphSeed.nodes].reverse(),
      edges: [...base.graphSeed.edges].reverse(),
    });

    expect(Object.keys(canonical.rootSpec)).toEqual(["alpha", "zeta"]);
    expect(canonical.nodes.map((node) => node.key)).toEqual(["change-secondary", "proof-main"]);
    expect(canonical.edges).toEqual([
      edge("$root", "requires", "proof-main"),
      edge("proof-main", "supports", "change-secondary"),
    ]);
  });

  it("parses only a complete four-domain artifact", () => {
    const base = planningArtifactFixture();
    expect(parsePlanningArtifact(base)).toEqual(canonicalPlanningArtifact(base));
    const incomplete = structuredClone(base);
    delete (incomplete.full as Partial<PlanningArtifact["full"]>).verification;
    expect(() => parsePlanningArtifact(incomplete)).toThrow(/verification/u);
  });
});

function planningArtifactFixture(): PlanningArtifact {
  return {
    title: "Continuous planning",
    full: {
      architecture: "Keep one authenticated planning session.",
      decisions: "Store immutable revision checkpoints.",
      risk: "Reject stale or dangling patch operations.",
      verification: "Prove one attempt and session survive steering.",
    },
    concise: {
      architecture: [{ title: "One session", description: "Reuse the planner identity." }],
      decisions: [{ title: "Checkpoints", description: "Bind every validated revision." }],
      risk: [{ title: "Stale patches", description: "Require the exact base hash." }],
      verification: [{ title: "Continuity", description: "Inspect one transcript file." }],
    },
    graphSeed: {
      rootSpec: { objective: "immutable", work_kind: "general" },
      nodes: [
        {
          key: "proof-main",
          type: "proof",
          title: "Primary proof",
          spec: { method: "focused" },
        },
        {
          key: "change-secondary",
          type: "change",
          title: "Secondary change",
          spec: { scope: "bounded" },
        },
      ],
      edges: [
        edge("$root", "requires", "proof-main"),
        edge("proof-main", "supports", "change-secondary"),
      ],
    },
  };
}

function canonicalPlanningArtifact(artifact: PlanningArtifact): PlanningArtifact {
  return {
    ...structuredClone(artifact),
    graphSeed: canonicalizePlanningGraphSeed(artifact.graphSeed),
  };
}

function edge(source: string, relation: string, target: string): PlanningGraphSeedEdge {
  return { source, relation, target };
}
