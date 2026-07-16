import { describe, expect, it } from "vitest";
import {
  GrantLedger,
  GrantRejectedError,
  type AuthorityGrant,
  type AuthoritySnapshot,
  type ToolCallBinding,
} from "../src/authority/grants.js";

const grant: AuthorityGrant = {
  protocol: "koni.authority-grant.v1",
  grantId: "grant-one",
  runId: "run-one",
  ticketId: "ticket-one",
  stepId: "implement",
  attemptId: "attempt-one",
  sessionId: "session-one",
  epoch: 2,
  generation: 3,
  allowedTools: ["koni_context", "koni_submit_and_compile"],
  readPaths: ["src"],
  writePaths: ["src/feature.ts"],
  expectedRevision: 7,
  expectedStateHash: "state-seven",
};

const call: ToolCallBinding = {
  grantId: "grant-one",
  runId: "run-one",
  ticketId: "ticket-one",
  stepId: "implement",
  attemptId: "attempt-one",
  sessionId: "session-one",
  epoch: 2,
  generation: 3,
  callId: "call-one",
  tool: "koni_context",
  requestHash: "request-one",
  expectedRevision: 7,
  expectedStateHash: "state-seven",
};

const snapshot: AuthoritySnapshot = {
  revision: 7,
  stateHash: "state-seven",
  generation: 3,
  activeEpoch: 2,
};

describe("grant ledger", () => {
  it("returns the exact durable result for an idempotent replay", () => {
    const ledger = new GrantLedger<{ ok: boolean }>();
    expect(ledger.authorize(grant, call, snapshot, 1)).toEqual({
      kind: "accepted",
      replayKey: "grant-one\u00002\u00003\u0000call-one",
    });
    ledger.commit(call, { ok: true });
    expect(ledger.authorize(grant, call, snapshot, 2)).toEqual({
      kind: "replay",
      result: { ok: true },
    });
  });

  it("rejects reuse of a call id with different arguments", () => {
    const ledger = new GrantLedger<string>();
    ledger.commit(call, "first");
    expect(() =>
      ledger.authorize(grant, { ...call, requestHash: "different" }, snapshot, 2),
    ).toThrowError(GrantRejectedError);
  });

  it.each([
    [{ ...snapshot, activeEpoch: 3 }, "stale_epoch"],
    [{ ...snapshot, generation: 4 }, "stale_generation"],
    [{ ...snapshot, revision: 8 }, "state_cas"],
    [{ ...snapshot, stateHash: "changed" }, "state_cas"],
  ] as const)("fails closed when authority changes", (changed, code) => {
    const ledger = new GrantLedger<string>();
    try {
      ledger.authorize(grant, call, changed, 1);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GrantRejectedError);
      expect((error as GrantRejectedError).code).toBe(code);
    }
  });

  it("rejects cross-session and out-of-scope calls", () => {
    const ledger = new GrantLedger<string>();
    expect(() =>
      ledger.authorize(grant, { ...call, sessionId: "other" }, snapshot, 1),
    ).toThrow(/session identity/);
    expect(() =>
      ledger.authorize(grant, { ...call, tool: "bash" }, snapshot, 1),
    ).toThrow(/outside the assignment grant/);
  });
});
