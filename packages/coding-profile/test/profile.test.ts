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

describe("coding profile registrar", () => {
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
    expect(PROFILE_DESCRIPTOR.package).toBe("@koni/coding-profile");
    expect(PROFILE_DESCRIPTOR.manifest_url).toMatch(/\/koni\/profile-manifest\.json$/);
    extensionHandlers.get("session_shutdown")?.();
    expect(eventHandlers.size).toBe(0);
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

  it("keeps obligation reasons complete instead of parsing prose as null YAML keys", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/rules.yaml"),
      "utf8",
    );
    const document = YAML.parse(source) as {
      rules: Array<{ id: string; derive?: Array<Record<string, unknown>> }>;
    };
    const obligations = document.rules.flatMap((rule) =>
      (rule.derive ?? [])
        .filter((entry) => entry.kind === "obligation")
        .map((entry) => ({ ruleId: rule.id, entry })),
    );

    expect(obligations.length).toBeGreaterThan(0);
    for (const { entry } of obligations) {
      expect(Object.keys(entry).sort()).toEqual(["key", "kind", "reason", "severity"]);
      expect(typeof entry.reason).toBe("string");
    }
    expect(obligations.find(({ ruleId }) => ruleId === "objective.plan-change")?.entry.reason).toBe(
      "Objective lacks a classified, proof-bound, risk-appropriate vertical change plan",
    );
    expect(obligations.find(({ ruleId }) => ruleId === "defect.diagnose")?.entry.reason).toBe(
      "Defect lacks confirmed root cause, causal chain, or ruled-out alternatives",
    );
  });

  it("keeps the shared Medium authoring example aligned with the shipped Coding defaults", async () => {
    const [runTypeSource, referenceSource] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/run-types/medium.yaml"), "utf8"),
      readFile(
        path.resolve(
          import.meta.dirname,
          "../koni/baseline/resources/skills/configure-koni/references/run-types.md",
        ),
        "utf8",
      ),
    ]);
    const codeFence = referenceSource.match(/```yaml\n([\s\S]*?)\n```/);
    expect(codeFence?.[1]).toBeDefined();

    const canonicalRoles = {
      planner: { model: "gpt-5.6-sol", thinking_level: "max" },
      lead: { model: "gpt-5.6-sol", thinking_level: "xhigh" },
      ticket_worker: { model: "gpt-5.6-terra", thinking_level: "high" },
      reviewer: { model: "gpt-5.6-sol", thinking_level: "max" },
    };
    const runType = YAML.parse(runTypeSource) as { agents: { roles: unknown } };
    const example = YAML.parse(codeFence![1]!) as { agents: { roles: unknown } };

    expect(runType.agents.roles).toEqual(canonicalRoles);
    expect(example.agents.roles).toEqual(canonicalRoles);
  });

  it("lets the compiler schedule default coding runs without automatic Lead provider gates", async () => {
    const runTypes = await Promise.all(
      ["small", "medium", "large"].map(async (id) => {
        const source = await readFile(
          path.resolve(import.meta.dirname, `../koni/baseline/run-types/${id}.yaml`),
          "utf8",
        );
        return YAML.parse(source) as {
          orchestration: { lead_action: string; lead_triggers: string[] };
        };
      }),
    );

    for (const runType of runTypes) {
      expect(runType.orchestration.lead_action).toBe("spawn-lead");
      expect(runType.orchestration.lead_triggers).toEqual([]);
    }
  });

  it("teaches the default implementer to turn search offsets into bounded product reads", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/baseline/agents/implementer.yaml"),
      "utf8",
    );
    const persona = YAML.parse(source) as { instructions: { text: string } };
    expect(persona.instructions.text).toContain("Never issue parallel");
    expect(persona.instructions.text).toContain(
      "whole-file reads across multiple nontrivial files",
    );
    expect(persona.instructions.text).toContain("returned `byteOffset`");
    expect(persona.instructions.text).toContain("read at most 32768 bytes");
  });

  it("separates proof support evidence from product coverage and writable proof source", async () => {
    const [
      graphSource,
      rulesSource,
      workflowsSource,
      checksSource,
      plannerSource,
      implementerSource,
    ] = await Promise.all([
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/graph.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/rules.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/workflows.yaml"), "utf8"),
      readFile(path.resolve(import.meta.dirname, "../koni/baseline/checks.yaml"), "utf8"),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/run-planner.yaml"),
        "utf8",
      ),
      readFile(
        path.resolve(import.meta.dirname, "../koni/baseline/agents/implementer.yaml"),
        "utf8",
      ),
    ]);
    const graph = YAML.parse(graphSource) as {
      node_types: Array<{
        id: string;
        fields: Record<string, { type: string; description?: string }>;
      }>;
    };
    const rules = YAML.parse(rulesSource) as {
      rules: Array<{
        id: string;
        emit?: { read_paths?: Array<{ field?: string }>; write_paths?: Array<{ field?: string }> };
      }>;
    };
    const workflows = YAML.parse(workflowsSource) as {
      workflows: Array<{
        id: string;
        steps: Array<{
          id: string;
          read_paths?: Array<{ field?: string }>;
          write_paths?: Array<{ field?: string }>;
        }>;
      }>;
    };
    const checks = YAML.parse(checksSource) as {
      checks: Array<{ id: string; graph_set?: Record<string, unknown> }>;
    };
    const proof = graph.node_types.find(({ id }) => id === "proof");
    expect(proof?.fields.support_paths).toMatchObject({ type: "list" });
    expect(proof?.fields.support_paths?.description).toContain("read-only repository files");

    const rule = rules.rules.find(({ id }) => id === "proof.prepare")?.emit;
    expect(rule?.read_paths?.map(({ field }) => field)).toContain("spec.support_paths");
    expect(rule?.write_paths?.map(({ field }) => field)).not.toContain("spec.support_paths");
    const step = workflows.workflows
      .find(({ id }) => id === "proof-preparation")
      ?.steps.find(({ id }) => id === "author-historical-baseline");
    expect(step?.read_paths?.map(({ field }) => field)).toContain("spec.support_paths");
    expect(step?.write_paths?.map(({ field }) => field)).not.toContain("spec.support_paths");

    for (const checkId of ["baseline-proof-set", "promotion-proof-set"]) {
      expect(checks.checks.find(({ id }) => id === checkId)?.graph_set?.support_paths_field).toBe(
        "spec.support_paths",
      );
    }
    const planner = YAML.parse(plannerSource) as { instructions: { text: string } };
    const implementer = YAML.parse(implementerSource) as { instructions: { text: string } };
    expect(planner.instructions.text).toContain("exact existing read-only `support_paths`");
    expect(planner.instructions.text).toContain("actual import/render");
    expect(planner.instructions.text).toContain("General observably empty");
    expect(planner.instructions.text).toContain("do not use `--silent`");
    expect(implementer.instructions.text).toContain(
      "Do not assume a familiar testing library is installed",
    );
    expect(implementer.instructions.text).toContain("not make all cases stop at the same import");
    expect(implementer.instructions.text).toContain("function-source string inspection");
    expect(implementer.instructions.text).toContain("only the exit-code envelope");
  });

  it("authorizes only the authenticated 0.7 release for inert-semantics retirement", async () => {
    const source = await readFile(
      path.resolve(import.meta.dirname, "../koni/profile-manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(source) as {
      migrations: Array<{ id: string; from_bundle_sha256: string[] }>;
    };
    const retirement = manifest.migrations.find(({ id }) => id === "retire-inert-semantics-v1");

    expect(retirement?.from_bundle_sha256).toEqual([
      "sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e",
    ]);
  });
});
