import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPlanningRepositoryPaths } from "../src/compiler/run-program.js";
import type {
  DerivedTicketDefinition,
  DerivedTicketScope,
  DerivedWorkflowStep,
} from "../src/contracts/rules.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("planning repository path validation", () => {
  it("accepts only an existing input or a same-step planned output", async () => {
    const root = await projectRoot();
    await mkdir(path.join(root, "fixtures"));
    await writeFile(path.join(root, "fixtures", "input.json"), "{}\n");

    await expect(
      assertPlanningRepositoryPaths(root, [
        definition("existing", 20, scope({ readPaths: ["fixtures/input.json"] })),
        definition(
          "planned",
          10,
          scope({ readPaths: ["generated/result.json"], writePaths: ["generated"] }),
          [
            step("materialize", [], {
              readPaths: ["generated/result.json"],
              writePaths: ["generated"],
            }),
          ],
        ),
      ]),
    ).resolves.toBeUndefined();

    await expect(
      assertPlanningRepositoryPaths(root, [
        definition("missing", 20, scope({ readPaths: ["fixtures/missing.json"] })),
      ]),
    ).rejects.toMatchObject({ code: "planning_repository_path" });
  });

  it("requires an earlier workflow step to create a missing input", async () => {
    const root = await projectRoot();
    const ticketScope = scope({
      readPaths: ["generated/result.json"],
      writePaths: ["generated"],
    });

    await expect(
      assertPlanningRepositoryPaths(root, [
        definition("ordered", 20, ticketScope, [
          step("produce", [], { writePaths: ["generated"] }),
          step("consume", ["produce"], { readPaths: ["generated/result.json"] }),
        ]),
      ]),
    ).resolves.toBeUndefined();

    await expect(
      assertPlanningRepositoryPaths(root, [
        definition("reversed", 20, ticketScope, [
          step("consume", [], { readPaths: ["generated/result.json"] }),
          step("produce", ["consume"], { writePaths: ["generated"] }),
        ]),
      ]),
    ).rejects.toMatchObject({ code: "planning_repository_path" });
  });

  it("uses the compiler ticket DAG for path-only producer-consumer authority", async () => {
    const root = await projectRoot();
    const producer = definition("producer", 20, scope({ writePaths: ["generated"] }), [
      step("produce", [], { writePaths: ["generated"] }),
    ]);
    const consumer = definition("consumer", 10, scope({ readPaths: ["generated/result.json"] }), [
      step("consume", [], { readPaths: ["generated/result.json"] }),
    ]);
    await expect(
      assertPlanningRepositoryPaths(root, [consumer, producer]),
    ).resolves.toBeUndefined();

    await expect(
      assertPlanningRepositoryPaths(root, [{ ...consumer, rule_priority: 30 }, producer]),
    ).rejects.toMatchObject({ code: "planning_repository_path" });
  });

  it("does not treat read-only review or narrowed-away ticket writes as producers", async () => {
    const root = await projectRoot();
    await expect(
      assertPlanningRepositoryPaths(root, [
        definition(
          "review-only",
          20,
          scope({ readPaths: ["generated/review.json"], writePaths: ["generated"] }),
          [
            step("review", [], {
              kind: "review",
              readPaths: ["generated/review.json"],
              writePaths: ["generated"],
            }),
          ],
        ),
      ]),
    ).rejects.toMatchObject({ code: "planning_repository_path" });

    const narrowedWriter = definition("narrowed-writer", 20, scope({ writePaths: ["generated"] }), [
      step("observe", [], { writePaths: [] }),
    ]);
    const consumer = definition("consumer", 10, scope({ readPaths: ["generated/result.json"] }), [
      step("consume", [], { readPaths: ["generated/result.json"] }),
    ]);
    await expect(
      assertPlanningRepositoryPaths(root, [consumer, narrowedWriter]),
    ).rejects.toMatchObject({ code: "planning_repository_path" });
  });

  it("fails closed for a symlinked planning input", async () => {
    const root = await projectRoot();
    await mkdir(path.join(root, "fixtures"));
    await writeFile(path.join(root, "outside.json"), "{}\n");
    await symlink("../outside.json", path.join(root, "fixtures", "alias.json"));

    await expect(
      assertPlanningRepositoryPaths(root, [
        definition("symlink", 20, scope({ readPaths: ["fixtures/alias.json"] })),
      ]),
    ).rejects.toMatchObject({ code: "planning_repository_path" });
  });
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-planning-paths-"));
  roots.push(root);
  return root;
}

function definition(
  id: string,
  priority: number,
  ticketScope: DerivedTicketScope,
  workflow: DerivedWorkflowStep[] = [],
): DerivedTicketDefinition {
  return {
    id,
    rule_priority: priority,
    operation_dispatch_priority: 0,
    operation_registry_id: `operation.${id}`,
    scope: ticketScope,
    workflow,
  } as unknown as DerivedTicketDefinition;
}

function scope(options: { readPaths?: string[]; writePaths?: string[] }): DerivedTicketScope {
  return {
    read_node_ids: [],
    write_node_ids: [],
    read_paths: options.readPaths ?? [],
    write_paths: options.writePaths ?? [],
  };
}

function step(
  id: string,
  dependsOn: string[],
  options: {
    kind?: DerivedWorkflowStep["kind"];
    readPaths?: string[];
    writePaths?: string[];
  },
): DerivedWorkflowStep {
  return {
    id,
    kind: options.kind ?? "production",
    depends_on: dependsOn,
    graph_mutation: options.kind === "review" ? "forbidden" : "allowed",
    read_paths: options.readPaths ?? [],
    write_paths: options.writePaths ?? [],
  } as unknown as DerivedWorkflowStep;
}
