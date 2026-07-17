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
    expect(Object.isFrozen(spec.lineage)).toBe(true);
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

    const { specHash: _hash, ...parallelTerminal } = structuredClone(valid);
    parallelTerminal.tools[0]!.executionMode = "parallel";
    expect(() => createAgentLaunchSpec(parallelTerminal)).toThrowError(
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

  it("accepts Pi model identifiers with namespaces and rejects non-canonical workspace paths", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _, ...draft } = structuredClone(valid);
    draft.model.id = "provider/model-family:model";
    expect(createAgentLaunchSpec(draft).model.id).toBe("provider/model-family:model");

    draft.workspace.cwd = "/tmp/koni-workspace/../koni-workspace";
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "absolute_path" }),
    );
  });

  it("hash-binds a parent attempt/session/entry branch without enabling ambient Pi branching", () => {
    const branched = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-rework",
      attemptId: "attempt-rework",
      sessionId: "session-rework",
      lineage: {
        branchEpoch: 2,
        reason: "rework",
        parentAttemptId: "attempt-worker",
        parentSessionId: "session-worker",
        parentEntryId: "2a32e686-9c65-4b58-a0aa-1641cfb1796f",
      },
    });
    expect(branched.lineage).toEqual(expect.objectContaining({
      branchEpoch: 2,
      reason: "rework",
      parentAttemptId: "attempt-worker",
      parentSessionId: "session-worker",
    }));

    const { specHash: _hash, ...unpaired } = structuredClone(branched);
    delete unpaired.lineage.parentSessionId;
    expect(() => createAgentLaunchSpec(unpaired)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "lineage_parent" }),
    );
  });

  it("rejects a missing lineage with a typed launch-spec error", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, lineage: _lineage, ...missingLineage } = structuredClone(valid);
    expect(() => createAgentLaunchSpec(missingLineage as never)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({ code: "lineage", path: "/lineage" }),
    );
  });

  it("requires a bounded attempt transcript budget", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...draft } = structuredClone(valid);
    draft.budgets.transcript.maxBytes = 1024;
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "transcript_budget",
        path: "/budgets/transcript/maxBytes",
      }),
    );
  });

  it("hash-binds a positive repository-call budget when the compiler issues one", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...draft } = structuredClone(valid);
    draft.budgets.repositoryCalls = { max: 16 };
    const bounded = createAgentLaunchSpec(draft);
    expect(bounded.budgets.repositoryCalls).toEqual({ max: 16 });

    const { specHash: _boundedHash, ...invalid } = structuredClone(bounded);
    invalid.budgets.repositoryCalls = { max: 0 };
    expect(() => createAgentLaunchSpec(invalid)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "integer",
        path: "/budgets/repositoryCalls/max",
      }),
    );
  });

  it("hash-binds a bounded worst-case result size for every authority tool", () => {
    const valid = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const { specHash: _hash, ...draft } = structuredClone(valid);
    draft.tools[0]!.maxResultBytes = 1024;
    expect(() => createAgentLaunchSpec(draft)).toThrowError(
      expect.objectContaining<Partial<AgentLaunchSpecError>>({
        code: "tool_result_budget",
        path: "/tools/0/maxResultBytes",
      }),
    );
  });
});
