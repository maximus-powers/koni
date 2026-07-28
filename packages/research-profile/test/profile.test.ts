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
