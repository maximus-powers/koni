import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseProfileRetirementResource } from "../src/profile/semantic-retirement.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

describe("bundled inert-semantic retirements", () => {
  it.each([
    ["coding", "coding-profile", 10],
    ["research", "research-profile", 13],
  ])("authenticates the exact %s retirement operations", (_name, packageName, count) => {
    const resource = parseProfileRetirementResource(
      readFileSync(
        `${root}/packages/${packageName}/koni/migrations/retire-inert-semantics-v1.json`,
      ),
      "retire-inert-semantics-v1",
    );
    expect(resource.operations).toHaveLength(count);
    expect(resource.operations.some((operation) => operation.pointer === "/storage")).toBe(true);
    expect(
      resource.operations.some((operation) => operation.pointer === "/orchestration/running"),
    ).toBe(true);
    expect(
      resource.operations.some(
        (operation) => operation.pointer === "/orchestration/lease_stale_seconds",
      ),
    ).toBe(true);
    expect(
      resource.operations.some(
        (operation) => operation.pointer === "/orchestration/max_fixpoint_passes",
      ),
    ).toBe(true);
    expect(
      resource.operations.some((operation) => operation.pointer === "/planning/session_scope"),
    ).toBe(true);
    expect(
      resource.operations.some((operation) => operation.pointer === "/planning/graph_seed_stage"),
    ).toBe(true);
  });

  it("retires Research state aliases and the removed fixpoint recipe input by stable selectors", () => {
    const resource = parseProfileRetirementResource(
      readFileSync(
        `${root}/packages/research-profile/koni/migrations/retire-inert-semantics-v1.json`,
      ),
      "retire-inert-semantics-v1",
    );
    expect(
      resource.operations.some(
        (operation) => operation.pointer === "/change_control/awaiting_approval_state",
      ),
    ).toBe(true);
    expect(
      resource.operations.some(
        (operation) => operation.pointer === "/change_control/held_source_state",
      ),
    ).toBe(true);
    expect(resource.operations).toContainEqual({
      file: "actions/research.yaml",
      selectors: [
        { array_pointer: "/actions", key: "id", equals: "compile-full" },
        { array_pointer: "/recipe", key: "primitive", equals: "rules.evaluate" },
      ],
      pointer: "/max_passes_from",
    });
    expect(
      resource.operations
        .filter(
          (operation) =>
            operation.file === "rules/lifecycle.yaml" && operation.remove_selected_item === true,
        )
        .map((operation) => operation.selectors?.[0]?.equals),
    ).toEqual(["gate", "research"]);
  });
});
