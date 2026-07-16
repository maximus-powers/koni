export interface AuthorityGrant {
  protocol: "koni.authority-grant.v1";
  grantId: string;
  runId: string;
  ticketId?: string;
  stepId?: string;
  attemptId: string;
  sessionId: string;
  epoch: number;
  generation: number;
  allowedTools: readonly string[];
  readPaths: readonly string[];
  writePaths: readonly string[];
  expectedRevision: number;
  expectedStateHash: string;
  expiresAtMs?: number;
  revokedAtMs?: number;
}

export interface ToolCallBinding {
  grantId: string;
  runId: string;
  ticketId?: string;
  stepId?: string;
  attemptId: string;
  sessionId: string;
  epoch: number;
  generation: number;
  callId: string;
  tool: string;
  requestHash: string;
  expectedRevision: number;
  expectedStateHash: string;
}

export interface AuthoritySnapshot {
  revision: number;
  stateHash: string;
  generation: number;
  activeEpoch: number;
}

export interface DurableReplayRecord<Result> {
  grantId: string;
  epoch: number;
  generation: number;
  callId: string;
  requestHash: string;
  result: Result;
}

export type GrantDecision<Result> =
  | { kind: "accepted"; replayKey: string }
  | { kind: "replay"; result: Result };

export class GrantRejectedError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "GrantRejectedError";
    this.code = code;
  }
}

export class GrantLedger<Result> {
  readonly #replays = new Map<string, DurableReplayRecord<Result>>();

  public authorize(
    grant: AuthorityGrant,
    call: ToolCallBinding,
    snapshot: AuthoritySnapshot,
    nowMs: number,
  ): GrantDecision<Result> {
    validateIdentity(grant, call);
    if (grant.revokedAtMs !== undefined) {
      throw new GrantRejectedError("grant_revoked", "the assignment grant has been revoked");
    }
    if (grant.expiresAtMs !== undefined && nowMs >= grant.expiresAtMs) {
      throw new GrantRejectedError("grant_expired", "the assignment grant has expired");
    }
    if (!grant.allowedTools.includes(call.tool)) {
      throw new GrantRejectedError("tool_scope", `tool ${call.tool} is outside the assignment grant`);
    }
    if (snapshot.generation !== grant.generation || snapshot.generation !== call.generation) {
      throw new GrantRejectedError("stale_generation", "the run generation has changed");
    }
    if (snapshot.activeEpoch !== grant.epoch || snapshot.activeEpoch !== call.epoch) {
      throw new GrantRejectedError("stale_epoch", "the assignment epoch is no longer active");
    }
    if (
      snapshot.revision !== grant.expectedRevision ||
      snapshot.revision !== call.expectedRevision ||
      snapshot.stateHash !== grant.expectedStateHash ||
      snapshot.stateHash !== call.expectedStateHash
    ) {
      throw new GrantRejectedError("state_cas", "the expected workflow state is no longer current");
    }

    const replayKey = replayIdentity(call.grantId, call.epoch, call.generation, call.callId);
    const prior = this.#replays.get(replayKey);
    if (prior !== undefined) {
      if (prior.requestHash !== call.requestHash) {
        throw new GrantRejectedError(
          "call_id_reuse",
          "the call id was already used with a different request",
        );
      }
      return { kind: "replay", result: prior.result };
    }
    return { kind: "accepted", replayKey };
  }

  public commit(call: ToolCallBinding, result: Result): DurableReplayRecord<Result> {
    const key = replayIdentity(call.grantId, call.epoch, call.generation, call.callId);
    const prior = this.#replays.get(key);
    if (prior !== undefined) {
      if (prior.requestHash !== call.requestHash) {
        throw new GrantRejectedError(
          "call_id_reuse",
          "the call id was already committed with a different request",
        );
      }
      return prior;
    }
    const record: DurableReplayRecord<Result> = {
      grantId: call.grantId,
      epoch: call.epoch,
      generation: call.generation,
      callId: call.callId,
      requestHash: call.requestHash,
      result,
    };
    this.#replays.set(key, record);
    return record;
  }

  public restore(records: Iterable<DurableReplayRecord<Result>>): void {
    for (const record of records) {
      const key = replayIdentity(record.grantId, record.epoch, record.generation, record.callId);
      const prior = this.#replays.get(key);
      if (prior !== undefined && prior.requestHash !== record.requestHash) {
        throw new GrantRejectedError("replay_corrupt", `conflicting replay record ${key}`);
      }
      this.#replays.set(key, record);
    }
  }

  public records(): readonly DurableReplayRecord<Result>[] {
    return [...this.#replays.values()];
  }
}

function validateIdentity(grant: AuthorityGrant, call: ToolCallBinding): void {
  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ["grant", grant.grantId, call.grantId],
    ["run", grant.runId, call.runId],
    ["ticket", grant.ticketId, call.ticketId],
    ["step", grant.stepId, call.stepId],
    ["attempt", grant.attemptId, call.attemptId],
    ["session", grant.sessionId, call.sessionId],
  ];
  for (const [name, expected, actual] of pairs) {
    if (expected !== actual) {
      throw new GrantRejectedError("identity_mismatch", `${name} identity does not match the grant`);
    }
  }
}

function replayIdentity(grantId: string, epoch: number, generation: number, callId: string): string {
  return `${grantId}\u0000${epoch}\u0000${generation}\u0000${callId}`;
}
