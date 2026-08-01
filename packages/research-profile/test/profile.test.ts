import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import registerProfile, {
  KONI_PROFILE_AVAILABLE_EVENT,
  KONI_PROFILE_DISCOVER_EVENT,
  PROFILE_DESCRIPTOR,
} from "../extensions/profile.js";

describe("research profile registrar", () => {
  it("announces the immutable descriptor on discovery and session start", () => {
    const extensionHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const eventHandlers = new Map<string, (...arguments_: unknown[]) => unknown>();
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const pi = {
      events: {
        on(event: string, handler: (...arguments_: unknown[]) => unknown) {
          eventHandlers.set(event, handler);
          return () => eventHandlers.delete(event);
        },
        emit(event: string, payload: unknown) {
          emitted.push({ event, payload });
        },
      },
      on(event: string, handler: (...arguments_: unknown[]) => unknown) {
        extensionHandlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;

    registerProfile(pi);
    expect([...eventHandlers]).toHaveLength(1);
    expect([...extensionHandlers]).toHaveLength(2);
    eventHandlers.get(KONI_PROFILE_DISCOVER_EVENT)?.();
    extensionHandlers.get("session_start")?.();

    expect(emitted).toEqual([
      { event: KONI_PROFILE_AVAILABLE_EVENT, payload: PROFILE_DESCRIPTOR },
      { event: KONI_PROFILE_AVAILABLE_EVENT, payload: PROFILE_DESCRIPTOR },
    ]);
    expect(PROFILE_DESCRIPTOR.package).toBe("@koni/research-profile");
    expect(PROFILE_DESCRIPTOR.manifest_url).toMatch(/\/koni\/profile-manifest\.json$/);
    extensionHandlers.get("session_shutdown")?.();
    expect(eventHandlers.size).toBe(0);
  });

  it("defines every node for agents with a nonempty semantic description", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/graph/nodes.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      node_types: Array<{ id: string; description?: string }>;
    };
    expect(document.node_types.length).toBeGreaterThan(0);
    expect(
      document.node_types.filter(
        ({ description }) => typeof description !== "string" || description.trim() === "",
      ),
    ).toEqual([]);
  });

  it("stores each reciprocal research fact once through canonical bidirectional edges", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/graph/edges.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      edge_types: Array<{
        source: string;
        relation: string;
        targets: string[];
        bidirectional?: boolean;
        inverse?: string;
      }>;
    };
    expect(document.edge_types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "experiment",
          relation: "target_claims",
          targets: ["claim"],
          bidirectional: true,
          inverse: "tested_by",
        }),
        expect.objectContaining({
          source: "ablation",
          relation: "target_claims",
          targets: ["claim"],
          bidirectional: true,
          inverse: "tested_by",
        }),
        expect.objectContaining({
          source: "gate",
          relation: "applies_to",
          bidirectional: true,
          inverse: "gates",
        }),
      ]),
    );
    expect(
      document.edge_types.some(({ relation }) => relation === "tested_by" || relation === "gates"),
    ).toBe(false);

    const instructions = await readFile(
      path.resolve(
        import.meta.dirname,
        "../koni/baseline/resources/skills/model-koni-work/references/empirical-research.md",
      ),
      "utf8",
    );
    expect(instructions).toContain(
      "Store one canonical `target_claims` fact with inverse `tested_by`",
    );
    expect(instructions).toContain("one canonical `gate.applies_to` fact with inverse `gates`");
  });

  it("makes every optional Pi binding selectable in the guided editor before enablement", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/resources/pi-packages.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      bindings: Array<{
        enabled: boolean;
        select?: { skills?: unknown; prompts?: unknown; tools?: unknown };
      }>;
    };
    expect(document.bindings.length).toBeGreaterThan(0);
    expect(
      document.bindings.every(
        (binding) =>
          binding.enabled === false &&
          Array.isArray(binding.select?.skills) &&
          Array.isArray(binding.select?.prompts) &&
          Array.isArray(binding.select?.tools),
      ),
    ).toBe(true);
  });

  it("gives missing-gate asset planning deterministic access to the active asset portfolio", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{
        id: string;
        emit?: {
          target_nodes?: unknown;
          read_scope?: unknown;
          write_scope?: unknown;
        };
      }>;
    };
    const rule = document.rules.find(({ id }) => id === "ticket.plan-build-asset");

    expect(rule?.emit).toMatchObject({
      target_nodes: { union: ["$target", "active-assets"] },
      read_scope: { union: ["$target", "active-assets"] },
      write_scope: { union: ["$target", "active-assets"] },
    });
  });

  it("waits for a complete gate inventory before implementing capability assets", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{
        id: string;
        when?: unknown;
        emit?: {
          read_scope?: unknown;
          write_scope?: unknown;
        };
      }>;
    };
    const rule = document.rules.find(({ id }) => id === "ticket.implement-asset");
    const conditions = (rule?.when as { all?: unknown[] } | undefined)?.all ?? [];
    const inventoryCondition = conditions.find(
      (condition) =>
        typeof condition === "object" &&
        condition !== null &&
        "any" in condition &&
        Array.isArray(condition.any) &&
        condition.any.some(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            "for_all" in candidate &&
            (candidate.for_all as { select?: unknown }).select === "gate-required-nodes",
        ),
    ) as
      | {
          any: Array<{
            not?: unknown;
            for_all?: {
              select?: unknown;
              bind?: unknown;
              satisfies?: unknown;
            };
          }>;
        }
      | undefined;

    expect(inventoryCondition?.any[0]).toEqual({
      not: {
        op: "field_present",
        field: "spec.capabilities",
      },
    });
    expect(inventoryCondition?.any[1]?.for_all).toMatchObject({
      select: "gate-required-nodes",
      bind: "gate_subject",
      satisfies: {
        all: expect.any(Array),
      },
    });
    expect(rule?.emit).toMatchObject({
      read_scope: {
        union: ["$target", "gate-evaluation-subjects"],
      },
      write_scope: "$target",
    });
  });

  it("limits synthesized gates to experiment boundaries with the reusable verifier inventory", async () => {
    const ruleSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const ruleDocument = YAML.parse(ruleSource) as {
      queries: Array<{
        id: string;
        node_types?: string[];
      }>;
      rules: Array<{
        id: string;
        emit?: {
          read_scope?: unknown;
          write_scope?: unknown;
        };
      }>;
    };
    const rule = ruleDocument.rules.find(({ id }) => id === "ticket.define-gate");
    const gateRequiredNodes = ruleDocument.queries.find(
      ({ id }) => id === "gate-required-nodes",
    );

    expect(gateRequiredNodes?.node_types).toEqual(["experiment"]);
    expect(rule?.emit).toMatchObject({
      read_scope: {
        union: ["$target", "active-assets", "gate-evaluation-subjects"],
      },
      write_scope: "$target",
    });

    const agentSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/gate-designer.yaml"),
      "utf8",
    );
    const agent = YAML.parse(agentSource) as {
      instructions: {
        text: string;
      };
    };
    expect(agent.instructions.text).toContain(
      "Capability names identify reusable verifier interfaces",
    );
    expect(agent.instructions.text).toContain(
      "per-gate or per-target capability name",
    );
  });

  it("keeps asset payload mutation under one implementation owner", async () => {
    const workflowSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
      "utf8",
    );
    const workflowDocument = YAML.parse(workflowSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{
          id: string;
          persona: string;
          depends_on: string[];
        }>;
      }>;
    };
    const workflow = workflowDocument.workflows.find(({ id }) => id === "implement-asset");

    expect(workflow?.steps.map(({ id }) => id)).not.toContain("inspect-contracts");
    expect(workflow?.steps[0]).toMatchObject({
      id: "implement",
      persona: "asset-builder",
      depends_on: [],
    });
    expect(workflow?.steps.find(({ id }) => id === "verify")?.persona).toBe("asset-builder");

    const integratorSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/integrator.yaml"),
      "utf8",
    );
    const integrator = YAML.parse(integratorSource) as {
      capabilities: {
        workspace_access: string;
        commands: string;
      };
    };
    expect(integrator.capabilities).toMatchObject({
      workspace_access: "read_only",
      commands: "read_only",
    });
  });

  it("keeps semantic gate contracts distinct from the executable result envelope", async () => {
    const reviewerSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/reviewer.yaml"),
      "utf8",
    );
    const reviewer = YAML.parse(reviewerSource) as { instructions: { text: string } };
    expect(reviewer.instructions.text).toContain(
      "passed|failed|inconclusive",
    );
    expect(reviewer.instructions.text).toContain(
      "Do not require the executable adapter to emit",
    );

    const plannerSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
      "utf8",
    );
    const planner = YAML.parse(plannerSource) as { instructions: { text: string } };
    expect(planner.instructions.text).toContain(
      "executable verdict vocabulary",
    );
    expect(planner.instructions.text).toContain("`passed|failed|inconclusive`");
  });

  it("requires Python gate contracts to bind the executable they actually verify", async () => {
    const assetBuilderSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/asset-builder.yaml"),
      "utf8",
    );
    const assetBuilder = YAML.parse(assetBuilderSource) as { instructions: { text: string } };
    expect(assetBuilder.instructions.text).toContain(
      "A Python verifier with a `python3` shebang must declare `python3`",
    );
    expect(assetBuilder.instructions.text).toContain(
      "Treat an unavailable executable as an implementation failure",
    );

    const reviewerSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/reviewer.yaml"),
      "utf8",
    );
    const reviewer = YAML.parse(reviewerSource) as { instructions: { text: string } };
    expect(reviewer.instructions.text).toContain(
      "Reject a gate contract whose declared executable was not resolved",
    );

    for (const agent of ["run-planner", "gate-designer"]) {
      const source = await readFile(
        path.resolve(import.meta.dirname, `../koni/baseline/agents/${agent}.yaml`),
        "utf8",
      );
      const parsed = YAML.parse(source) as { instructions: { text: string } };
      expect(parsed.instructions.text).toContain(
        "Python command contracts must use `python3`",
      );
    }
  });

  it("gives every node-creating operation an explicit positive bound", async () => {
    const operationSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/operations/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(operationSource) as {
      operations: Array<{
        id: string;
        allowed_new_node_types?: string[];
        max_new_nodes?: number;
      }>;
    };
    const unbounded = document.operations
      .filter((operation) => (operation.allowed_new_node_types?.length ?? 0) > 0)
      .filter((operation) => operation.max_new_nodes === undefined || operation.max_new_nodes < 1)
      .map((operation) => operation.id);

    expect(unbounded).toEqual([]);
  });

  it("keeps the automatic report action inside the compiler-owned report boundary", async () => {
    const actionSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/actions/research.yaml"),
      "utf8",
    );
    const document = YAML.parse(actionSource) as {
      actions: Array<{
        id: string;
        params?: Record<string, { required?: boolean }>;
        recipe: Array<{ primitive: string }>;
      }>;
    };
    const report = document.actions.find(({ id }) => id === "report");

    expect(Object.values(report?.params ?? {}).some(({ required }) => required === true)).toBe(
      false,
    );
    expect(report?.recipe.map(({ primitive }) => primitive)).toEqual([
      "project.validate",
      "report.render",
    ]);
  });

  it("does not make optional related work a deterministic formulation barrier", async () => {
    const ruleSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules/research.yaml"),
      "utf8",
    );
    const ruleDocument = YAML.parse(ruleSource) as {
      rules: Array<{
        id: string;
        when?: unknown;
        emit?: { obligations?: string[] };
      }>;
    };
    const formulation = ruleDocument.rules.find(({ id }) => id === "ticket.formulation");
    const experimentPortfolio = ruleDocument.rules.find(
      ({ id }) => id === "ticket.experiment-portfolio",
    );

    expect(formulation?.when).toEqual({
      op: "edge_count",
      relation: "claims",
      exact: 0,
    });
    expect(formulation?.emit?.obligations).toEqual(["hypothesis.claims"]);
    expect(JSON.stringify(experimentPortfolio?.when)).not.toContain('"literature"');

    const workflowSource = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/workflows/research.yaml"),
      "utf8",
    );
    const workflowDocument = YAML.parse(workflowSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{ id: string; expected_output: string }>;
      }>;
    };
    const drill = workflowDocument.workflows.find(({ id }) => id === "drill-hypothesis");
    expect(drill?.steps.find(({ id }) => id === "map-related-work")?.expected_output).toContain(
      "bounded no-op",
    );
    expect(drill?.steps.find(({ id }) => id === "integrate")?.expected_output).toContain(
      "optional",
    );
  });

  it("authorizes only the authenticated 1.0.11 release for inert-semantics retirement", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/profile-manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(source) as {
      migrations: Array<{ id: string; from_bundle_sha256: string[] }>;
    };
    const retirement = manifest.migrations.find(({ id }) => id === "retire-inert-semantics-v1");

    expect(retirement?.from_bundle_sha256).toEqual([
      "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
    ]);
  });
});
