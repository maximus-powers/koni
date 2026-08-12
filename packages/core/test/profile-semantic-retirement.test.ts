import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  parseProfileRetirementResource,
  planProfileRetirement,
  ProfileRetirementError,
} from "../src/profile/semantic-retirement.js";
import { rawSha256 } from "../src/shared/canonical.js";

const sourceBundleSha256 = rawSha256("source-bundle");
const targetBundleSha256 = rawSha256("target-bundle");

describe("declarative profile semantic retirements", () => {
  it("removes only exact fields while preserving project values, comments, and order", () => {
    const resourceBytes = resource([
      {
        file: "actions/research.yaml",
        selectors: [
          { array_pointer: "/actions", key: "id", equals: "compile-full" },
          { array_pointer: "/recipe", key: "primitive", equals: "rules.evaluate" },
        ],
        pointer: "/max_passes_from",
      },
      { file: "profile.yaml", pointer: "/orchestration/max_fixpoint_passes" },
      { file: "profile.yaml", pointer: "/storage" },
    ]);
    const sourceProfile = bytes(`profile: research
storage:
  backend: filesystem
orchestration:
  max_fixpoint_passes: 8
  max_parallel: 4
`);
    const projectProfile = bytes(`# project heading
profile: research
storage:
  # arbitrary old project value must be archived
  backend: project-custom
orchestration:
  max_fixpoint_passes: 13
  max_parallel: 9 # keep this
project_only: true
`);
    const targetProfile = bytes(`profile: research
orchestration:
  max_parallel: 4
`);
    const sourceActions = bytes(`actions:
  - id: compile-full
    recipe:
      - primitive: rules.evaluate
        max_passes_from: orchestration.max_fixpoint_passes
        mode: full
`);
    const projectActions = bytes(`actions:
  - id: compile-full
    recipe:
      - primitive: rules.evaluate
        # project kept a custom legacy path
        max_passes_from: custom.limit
        mode: full
`);
    const targetActions = bytes(`actions:
  - id: compile-full
    recipe:
      - primitive: rules.evaluate
        mode: full
`);

    const plan = planProfileRetirement({
      resourceBytes,
      expectedId: "retire-inert-fields-v1",
      sourceBundleSha256,
      targetBundleSha256,
      sourceBaselineFiles: new Map([
        ["actions/research.yaml", sourceActions],
        ["profile.yaml", sourceProfile],
      ]),
      projectFiles: new Map([
        ["actions/research.yaml", projectActions],
        ["profile.yaml", projectProfile],
      ]),
      targetBaselineFiles: new Map([
        ["actions/research.yaml", targetActions],
        ["profile.yaml", targetProfile],
      ]),
    });

    expect(plan.preview.operations.map((operation) => [operation.file, operation.pointer])).toEqual(
      [
        ["actions/research.yaml", "/max_passes_from"],
        ["profile.yaml", "/orchestration/max_fixpoint_passes"],
        ["profile.yaml", "/storage"],
      ],
    );
    expect(plan.preview.operations[0]!.project).toMatchObject({
      present: true,
      value: "custom.limit",
    });
    expect(plan.preview.operations[2]!.project).toMatchObject({
      present: true,
      value: { backend: "project-custom" },
    });
    expect(plan.preview.archives).toEqual([
      {
        file: "actions/research.yaml",
        projectSha256: rawSha256(projectActions),
        sizeBytes: projectActions.byteLength,
      },
      {
        file: "profile.yaml",
        projectSha256: rawSha256(projectProfile),
        sizeBytes: projectProfile.byteLength,
      },
    ]);
    expect(rawSha256(plan.archivedProjectFiles.get("profile.yaml")!)).toBe(
      rawSha256(projectProfile),
    );

    const profileText = new TextDecoder().decode(plan.changedProjectFiles.get("profile.yaml"));
    expect(profileText).toContain("# project heading");
    expect(profileText).toContain("max_parallel: 9 # keep this");
    expect(YAML.parse(profileText)).toEqual({
      profile: "research",
      orchestration: { max_parallel: 9 },
      project_only: true,
    });
    const actionsText = new TextDecoder().decode(
      plan.changedProjectFiles.get("actions/research.yaml"),
    );
    expect(YAML.parse(actionsText).actions[0].recipe[0]).toEqual({
      primitive: "rules.evaluate",
      mode: "full",
    });
  });

  it("records an already-absent project value without inventing a write", () => {
    const resourceBytes = resource([{ file: "profile.yaml", pointer: "/storage" }]);
    const plan = planProfileRetirement({
      resourceBytes,
      expectedId: "retire-inert-fields-v1",
      sourceBundleSha256,
      targetBundleSha256,
      sourceBaselineFiles: new Map([
        ["profile.yaml", bytes("storage:\n  backend: filesystem\nkeep: true\n")],
      ]),
      projectFiles: new Map([["profile.yaml", bytes("keep: project\n")]]),
      targetBaselineFiles: new Map([["profile.yaml", bytes("keep: true\n")]]),
    });
    expect(plan.preview.operations[0]!.project).toEqual({ present: false, valueSha256: null });
    expect(plan.changedProjectFiles.size).toBe(0);
    expect(plan.archivedProjectFiles.has("profile.yaml")).toBe(true);
  });

  it("removes one exact selected array item without disturbing neighboring project entries", () => {
    const operation = {
      file: "rules/lifecycle.yaml",
      selectors: [{ array_pointer: "/state_machines", key: "id", equals: "gate" }],
      remove_selected_item: true,
    };
    const source = bytes(`state_machines:
- id: gate
  initial: pending
  states: [pending, complete]
- id: ticket
  initial: queued
  states: [queued, closed]
`);
    const project = bytes(`# keep project lifecycle notes
state_machines:
- id: gate # retired because it had no runtime binding
  initial: pending
  states: [pending, ready, complete]
- id: ticket
  initial: queued
  states: [queued, closed] # keep custom ticket states
`);
    const target = bytes(`state_machines:
- id: ticket
  initial: queued
  states: [queued, closed]
`);
    const plan = planProfileRetirement({
      resourceBytes: resource([operation]),
      expectedId: "retire-inert-fields-v1",
      sourceBundleSha256,
      targetBundleSha256,
      sourceBaselineFiles: new Map([["rules/lifecycle.yaml", source]]),
      projectFiles: new Map([["rules/lifecycle.yaml", project]]),
      targetBaselineFiles: new Map([["rules/lifecycle.yaml", target]]),
    });

    expect(plan.preview.operations[0]).toMatchObject({
      file: "rules/lifecycle.yaml",
      pointer: "",
      project: { present: true },
      target: { present: false },
    });
    const transformed = new TextDecoder().decode(
      plan.changedProjectFiles.get("rules/lifecycle.yaml"),
    );
    expect(transformed).toContain("# keep project lifecycle notes");
    expect(transformed).toContain("# keep custom ticket states");
    expect(YAML.parse(transformed).state_machines).toEqual([
      {
        id: "ticket",
        initial: "queued",
        states: ["queued", "closed"],
      },
    ]);
  });

  it("fails closed when source or target semantics do not match the declaration", () => {
    const resourceBytes = resource([{ file: "profile.yaml", pointer: "/storage" }]);
    const common = {
      resourceBytes,
      expectedId: "retire-inert-fields-v1",
      sourceBundleSha256,
      targetBundleSha256,
      projectFiles: new Map<string, Uint8Array | undefined>(),
    };
    expect(() =>
      planProfileRetirement({
        ...common,
        sourceBaselineFiles: new Map([["profile.yaml", bytes("keep: true\n")]]),
        targetBaselineFiles: new Map([["profile.yaml", bytes("keep: true\n")]]),
      }),
    ).toThrowError(expect.objectContaining({ code: "retirement_source_absent" }));
    expect(() =>
      planProfileRetirement({
        ...common,
        sourceBaselineFiles: new Map([["profile.yaml", bytes("storage: old\n")]]),
        targetBaselineFiles: new Map([["profile.yaml", bytes("storage: still-here\n")]]),
      }),
    ).toThrowError(expect.objectContaining({ code: "retirement_target_present" }));
  });

  it("rejects executable, ambiguous, duplicate, overlapping, and noncanonical declarations", () => {
    expect(() =>
      parseProfileRetirementResource(
        bytes(
          JSON.stringify({
            protocol: "koni.profile-retirement.v1",
            id: "retire-inert-fields-v1",
            operations: [{ file: "profile.yaml", pointer: "/storage", command: "rm -rf" }],
          }),
        ),
      ),
    ).toThrowError(expect.objectContaining({ code: "retirement_unknown_field" }));
    expect(() =>
      parseProfileRetirementResource(
        bytes(`{
      "protocol":"koni.profile-retirement.v1",
      "id":"retire-inert-fields-v1",
      "id":"shadowed",
      "operations":[{"file":"profile.yaml","pointer":"/storage"}]
    }`),
      ),
    ).toThrowError(expect.objectContaining({ code: "retirement_resource_json" }));
    expect(() =>
      parseProfileRetirementResource(
        resource([
          { file: "profile.yaml", pointer: "/storage" },
          { file: "profile.yaml", pointer: "/storage/backend" },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "retirement_operation_overlap" }));
    expect(() =>
      parseProfileRetirementResource(
        resource([
          { file: "profile.yaml", pointer: "/storage" },
          { file: "profile.yaml", pointer: "/storage" },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "retirement_operation_duplicate" }));
    expect(() =>
      parseProfileRetirementResource(
        resource([{ file: "profile.yaml", pointer: "/items/0/value" }]),
      ),
    ).toThrowError(expect.objectContaining({ code: "retirement_pointer" }));
    expect(() =>
      parseProfileRetirementResource(
        resource([{ file: "profile.yaml", remove_selected_item: true }]),
      ),
    ).toThrowError(expect.objectContaining({ code: "retirement_selected_item" }));
    expect(() =>
      parseProfileRetirementResource(
        resource([
          {
            file: "profile.yaml",
            selectors: [{ array_pointer: "/items", key: "id", equals: "old" }],
            pointer: "/value",
            remove_selected_item: true,
          },
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: "retirement_pointer" }));

    const selectorResource = resource([
      {
        file: "actions.yaml",
        selectors: [{ array_pointer: "/actions", key: "id", equals: "same" }],
        pointer: "/old",
      },
    ]);
    expect(() =>
      planProfileRetirement({
        resourceBytes: selectorResource,
        expectedId: "retire-inert-fields-v1",
        sourceBundleSha256,
        targetBundleSha256,
        sourceBaselineFiles: new Map([
          ["actions.yaml", bytes("actions:\n  - {id: same, old: one}\n  - {id: same, old: two}\n")],
        ]),
        projectFiles: new Map(),
        targetBaselineFiles: new Map([["actions.yaml", bytes("actions:\n  - {id: same}\n")]]),
      }),
    ).toThrowError(expect.objectContaining({ code: "retirement_selector_ambiguous" }));
  });
});

function resource(operations: unknown[]): Uint8Array {
  return bytes(
    JSON.stringify(
      {
        protocol: "koni.profile-retirement.v1",
        id: "retire-inert-fields-v1",
        operations,
      },
      null,
      2,
    ),
  );
}

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

// Keep the imported error type anchored in this test's public-contract surface.
void ProfileRetirementError;
