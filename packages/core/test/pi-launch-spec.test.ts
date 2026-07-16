import { describe, expect, it } from "vitest";
import { rawSha256 } from "../src/shared/canonical.js";
import {
  AgentLaunchSpecError,
  createAgentLaunchSpec,
  validateAgentLaunchSpec,
} from "../src/pi/launch-spec.js";
import { fixtureLaunchSpec, fixtureResource } from "./pi-managed-fixtures.js";

describe("immutable AgentLaunchSpec", () => {
  it("hashes every authority, model, budget, terminal, and resource binding", () => {
    const resource = fixtureResource("context", "ticket-context", "context/ticket.md", "bound context");
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
      resources: [resource],
    });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.identity)).toBe(true);
    expect(Object.isFrozen(spec.resources.entries)).toBe(true);
    expect(validateAgentLaunchSpec(structuredClone(spec))).toEqual(spec);

    const drifted = structuredClone(spec);
    drifted.model.id = "different-model";
    expect(() => validateAgentLaunchSpec(drifted)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "spec_hash", path: "/specHash" }),
    );
  });

  it("rejects resource content drift and terminal tools outside the allowlist", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _, ...draft } = structuredClone(valid);
    draft.resources.entries = [{
      kind: "context",
      id: "ticket-context",
      relativePath: "context/ticket.md",
      content: "changed bytes",
      sha256: rawSha256("different bytes"),
      sizeBytes: 13,
    }];
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "content_hash" }),
    );

    const invalidTerminal = structuredClone(draft);
    invalidTerminal.resources.entries = [];
    invalidTerminal.resources.setHash = valid.resources.setHash;
    invalidTerminal.terminal.toolName = "ambient_bash";
    expect(() => createAgentLaunchSpec(invalidTerminal)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "terminal_tool" }),
    );
  });

  it("rejects unsafe resource paths before anything is materialized", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _, ...draft } = structuredClone(valid);
    const content = "unsafe";
    draft.resources.entries = [{
      kind: "skill",
      id: "unsafe-skill",
      relativePath: "../SKILL.md",
      content,
      sha256: rawSha256(content),
      sizeBytes: Buffer.byteLength(content),
    }];
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "relative_path" }),
    );
  });
});
