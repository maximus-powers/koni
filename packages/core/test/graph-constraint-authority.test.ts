import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompiledConfiguration,
  CompiledConfigurationRegistries,
  ConfigurationObject,
} from "../src/contracts/configuration.js";
import { validateConfiguredGraphConstraints } from "../src/compiler/graph-constraints.js";
import { projectGraphSchemaDefinition } from "../src/compiler/graph-schema.js";
import {
  GraphSchema,
  GraphValidationError,
  TypedGraph,
  type GraphNode,
  type GraphNodeTypeDefinition,
} from "../src/graph/model.js";
import { canonicalHash } from "../src/shared/canonical.js";
import { minimalCompiledBehavior } from "./fixtures/compiled-behavior.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("field-level collection constraints", () => {
  it("validates nested subset_of, disjoint_from, and unique_by against root-node fields", async () => {
    const root = await projectRoot();
    const schema = new GraphSchema({ nodeTypes: [proofType()], edgeTypes: [] });
    expect(
      () =>
        new TypedGraph(
          schema,
          [
            proofNode("proof-a", {
              covered_paths: ["src/a.ts"],
              source_paths: ["tests/a.ts"],
              oracle_cases: [{ id: "focused", seam_paths: ["src/a.ts"] }],
            }),
          ],
          { projectRoot: root },
        ),
    ).not.toThrow();

    expect(
      () =>
        new TypedGraph(
          schema,
          [
            proofNode("proof-a", {
              covered_paths: ["src/a.ts"],
              source_paths: ["tests/a.ts"],
              oracle_cases: [{ id: "focused", seam_paths: ["src/missing.ts"] }],
            }),
          ],
          { projectRoot: root },
        ),
    ).toThrow(/must be a subset of root field spec\.covered_paths/u);

    expect(
      () =>
        new TypedGraph(
          schema,
          [
            proofNode("proof-a", {
              covered_paths: ["src"],
              source_paths: ["src/a.ts"],
              oracle_cases: [],
            }),
          ],
          { projectRoot: root },
        ),
    ).toThrow(/must be disjoint from root field spec\.covered_paths/u);

    expect(
      () =>
        new TypedGraph(
          schema,
          [
            proofNode("proof-a", {
              covered_paths: [],
              source_paths: [],
              oracle_cases: [
                { id: "same", seam_paths: [] },
                { id: "same", seam_paths: [] },
              ],
            }),
          ],
          { projectRoot: root },
        ),
    ).toThrow(/not unique by id/u);
  });

  it("rejects physical aliases and fails closed on symlinks", async () => {
    const root = await projectRoot();
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "src", "canonical.ts"), "export {};\n");
    await link(path.join(root, "src", "canonical.ts"), path.join(root, "tests", "hardlink.ts"));
    const schema = new GraphSchema({ nodeTypes: [proofType()], edgeTypes: [] });
    expect(
      () =>
        new TypedGraph(
          schema,
          [
            proofNode("proof-a", {
              covered_paths: ["src/canonical.ts"],
              source_paths: ["tests/hardlink.ts"],
              oracle_cases: [],
            }),
          ],
          { projectRoot: root },
        ),
    ).toThrow(/must be disjoint/u);

    await symlink("canonical.ts", path.join(root, "src", "alias.ts"));
    expect(
      () =>
        new TypedGraph(
          schema,
          [
            proofNode("proof-a", {
              covered_paths: ["src/canonical.ts"],
              source_paths: ["src/alias.ts"],
              oracle_cases: [],
            }),
          ],
          { projectRoot: root },
        ),
    ).toThrow(/could not safely compare/u);
  });

  it("rejects malformed collection-constraint declarations before graph execution", () => {
    expect(
      () =>
        new GraphSchema({
          nodeTypes: [
            {
              id: "bad",
              description: "Invalid declarations must never become executable.",
              statuses: ["active"],
              initial_status: "active",
              fields: {
                scalar: { type: "string" },
                wrong_target: { type: "list", items: { type: "path" }, subset_of: "spec.scalar" },
                missing_target: {
                  type: "list",
                  items: { type: "string" },
                  disjoint_from: "spec.missing",
                },
                identities: {
                  type: "list",
                  unique_by: "id",
                  items: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          ],
          edgeTypes: [],
        }),
    ).toThrowError(GraphValidationError);
  });
});

describe("configured whole-graph path_sets_disjoint authority", () => {
  it("rejects exact, ancestor, and hard-link overlap with bounded canonical diagnostics", async () => {
    const root = await projectRoot();
    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "canonical.ts"), "export {};\n");
    await link(path.join(root, "tests", "canonical.ts"), path.join(root, "tests", "hardlink.ts"));
    const configuration = configurationFixture();
    const schema = graphSchema(configuration);

    for (const pair of [
      ["tests/shared.ts", "tests/shared.ts"],
      ["tests/contracts", "tests/contracts/focused.ts"],
      ["tests/canonical.ts", "tests/hardlink.ts"],
    ] as const) {
      const graph = new TypedGraph(
        schema,
        [pathNode("proof-a", "proof", pair[0]), pathNode("proof-b", "proof", pair[1])],
        { projectRoot: root },
      );
      expect(() => validateConfiguredGraphConstraints(configuration, graph, root)).toThrow(
        /proof-source-paths-are-disjoint.*proof-a.*proof-b/u,
      );
    }
  });

  it("accepts disjoint paths and skips only a node's comparison with itself", async () => {
    const root = await projectRoot();
    const configuration = configurationFixture();
    const schema = graphSchema(configuration);
    const one = new TypedGraph(schema, [pathNode("proof-a", "proof", "tests/only.ts")], {
      projectRoot: root,
    });
    expect(() => validateConfiguredGraphConstraints(configuration, one, root)).not.toThrow();
    const two = new TypedGraph(
      schema,
      [pathNode("proof-a", "proof", "tests/a.ts"), pathNode("proof-b", "proof", "tests/b.ts")],
      { projectRoot: root },
    );
    expect(() => validateConfiguredGraphConstraints(configuration, two, root)).not.toThrow();
  });

  it("fails closed when a selector emits an undeclared type or a symlink cannot be compared", async () => {
    const root = await projectRoot();
    const configuration = configurationFixture({ selectorTypes: ["proof", "artifact"] });
    const schema = graphSchema(configuration);
    const undeclared = new TypedGraph(
      schema,
      [
        pathNode("proof-a", "proof", "tests/proof.ts"),
        pathNode("artifact-a", "artifact", "tests/artifact.ts"),
      ],
      { projectRoot: root },
    );
    expect(() => validateConfiguredGraphConstraints(configuration, undeclared, root)).toThrow(
      /selector returned undeclared node type artifact/u,
    );

    await mkdir(path.join(root, "tests"), { recursive: true });
    await writeFile(path.join(root, "tests", "canonical.ts"), "export {};\n");
    await symlink("canonical.ts", path.join(root, "tests", "alias.ts"));
    const regularConfiguration = configurationFixture();
    const symlinkGraph = new TypedGraph(
      graphSchema(regularConfiguration),
      [
        pathNode("proof-a", "proof", "tests/canonical.ts"),
        pathNode("proof-b", "proof", "tests/alias.ts"),
      ],
      { projectRoot: root },
    );
    expect(() =>
      validateConfiguredGraphConstraints(regularConfiguration, symlinkGraph, root),
    ).toThrow(/could not safely compare selected path authority/u);
  });

  it("rejects unsupported graph-constraint kinds during configuration projection", () => {
    const configuration = configurationFixture({ kind: "invented_constraint" });
    const result = projectGraphSchemaDefinition(configuration);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "graph_constraint.kind",
    );
  });
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-graph-authority-"));
  roots.push(root);
  return root;
}

function proofType(): GraphNodeTypeDefinition {
  return {
    id: "proof",
    description: "A proof with repository path authority.",
    statuses: ["active"],
    initial_status: "active",
    fields: {
      covered_paths: { type: "list", required: true, items: { type: "path" } },
      source_paths: {
        type: "list",
        required: true,
        items: { type: "path" },
        disjoint_from: "spec.covered_paths",
      },
      oracle_cases: {
        type: "list",
        required: true,
        unique_by: "id",
        items: {
          type: "object",
          additional_properties: false,
          properties: {
            id: { type: "string", required: true },
            seam_paths: {
              type: "list",
              required: true,
              items: { type: "path" },
              subset_of: "spec.covered_paths",
            },
          },
        },
      },
    },
  };
}

function proofNode(id: string, spec: GraphNode["spec"]): GraphNode {
  return {
    schema_version: "1.0",
    id,
    type: "proof",
    title: id,
    status: "active",
    spec,
    edges: {},
    annotations: {},
  };
}

function pathNode(id: string, type: "proof" | "artifact", sourcePath: string): GraphNode {
  return {
    schema_version: "1.0",
    id,
    type,
    title: id,
    status: "active",
    spec: { source_paths: [sourcePath] },
    edges: {},
    annotations: {},
  };
}

function graphSchema(configuration: CompiledConfiguration): GraphSchema {
  const projected = projectGraphSchemaDefinition(configuration);
  expect(projected.ok, JSON.stringify(projected.diagnostics, null, 2)).toBe(true);
  if (!projected.ok) throw new Error("fixture graph schema did not compile");
  return new GraphSchema(projected.value);
}

function configurationFixture(
  options: {
    kind?: string;
    selectorTypes?: readonly string[];
  } = {},
): CompiledConfiguration {
  const pathField = { type: "list", required: true, items: { type: "path" } } as const;
  const nodeType = (id: string): ConfigurationObject => ({
    id,
    description: `Path-bearing ${id} fixture.`,
    statuses: ["active"],
    initial_status: "active",
    fields: { source_paths: pathField },
  });
  const constraint: ConfigurationObject = {
    id: "proof-source-paths-are-disjoint",
    kind: options.kind ?? "path_sets_disjoint",
    left: {
      select: { nodes: { node_types: options.selectorTypes ?? ["proof"] } },
      node_types: ["proof"],
      field: "spec.source_paths",
    },
    right: {
      select: { nodes: { node_types: ["proof"] } },
      node_types: ["proof"],
      field: "spec.source_paths",
    },
    distinct_nodes: true,
  };
  const empty = Object.freeze(Object.create(null) as Record<string, ConfigurationObject>);
  const registries: CompiledConfigurationRegistries = {
    node_types: Object.freeze({ proof: nodeType("proof"), artifact: nodeType("artifact") }),
    queries: empty,
    graph_constraints: Object.freeze({ "proof-source-paths-are-disjoint": constraint }),
    gate_policies: empty,
    rules: empty,
    operations: empty,
    workflows: empty,
    actions: empty,
    checks: empty,
    personas: empty,
    reports: empty,
    views: empty,
    state_machines: empty,
    agents: empty,
  };
  const material = {
    protocol: "koni.compiled-configuration.v1" as const,
    schema_version: "2.0" as const,
    package: {
      name: "@koni/test-profile",
      version: "1.0.0",
      profile_id: "test",
      profile_version: "1.0.0",
      profile_lineage: "test@1",
    },
    baseline_bundle_sha256: canonicalHash("baseline"),
    effective_bundle_sha256: canonicalHash("effective"),
    profile: {},
    project: {},
    modules: {
      graph: [],
      rules: [],
      operations: [],
      workflows: [],
      actions: [],
      checks: [],
      personas: [],
      reports: [],
      cockpit: [],
      lifecycles: [],
    },
    run_type_order: [],
    run_types: {},
    agents: {},
    edge_types: [],
    behavior: minimalCompiledBehavior("test"),
    registries,
  };
  return Object.freeze({ ...material, configuration_sha256: canonicalHash(material) });
}
