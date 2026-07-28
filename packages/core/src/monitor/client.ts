import { randomUUID } from "node:crypto";
import type { JsonValue, RpcEvent, RpcSuccess } from "../authority/protocol.js";
import {
  MAX_PLAN_REVISION_CODE_POINTS,
  MAX_PROPOSAL_MESSAGE_CODE_POINTS,
  MAX_QUESTION_NOTES_CODE_POINTS,
  type MonitorQuestion,
} from "./protocol.js";
import type { ControlProposalInspection } from "../control-center/protocol.js";

export interface MonitorAuthorityConnection {
  readonly revision: number;
  request(
    method: string,
    params?: JsonValue,
    options?: { expectedRevision?: number; idempotencyKey?: string },
  ): Promise<RpcSuccess>;
  onEvent(listener: (event: RpcEvent) => void): () => void;
  close(): void;
}

export type MonitorReadOnlyConnector = () => Promise<MonitorAuthorityConnection | undefined>;

export class MonitorDecisionConflictError extends Error {
  public constructor(
    message = "Koni changed while this decision was open. Review the refreshed item and confirm again.",
  ) {
    super(message);
    this.name = "MonitorDecisionConflictError";
  }
}

/**
 * Deliberately closed mutation surface for the compact companion. There is no public generic
 * request method and therefore no accidental route to steering, lifecycle, Git, or configuration.
 */
export class MonitorDecisionClient {
  readonly #connection: MonitorAuthorityConnection;
  readonly #idempotencyKey: (method: string) => string;

  public constructor(
    connection: MonitorAuthorityConnection,
    idempotencyKey: (method: string) => string = (method) => `monitor:${method}:${randomUUID()}`,
  ) {
    this.#connection = connection;
    this.#idempotencyKey = idempotencyKey;
  }

  public async answerQuestion(input: {
    runId: string;
    question: MonitorQuestion;
    selectedOptionId?: string;
    notes?: string;
  }): Promise<void> {
    const selected = input.selectedOptionId;
    if (
      selected !== undefined &&
      !input.question.options.some((option) => option.id === selected)
    ) {
      throw new Error("selected question option is not current");
    }
    const notes = normalizeDecisionText(input.notes, MAX_QUESTION_NOTES_CODE_POINTS, false);
    if (!input.question.allowsNotes && notes !== undefined) {
      throw new Error("this question does not allow notes");
    }
    if (selected === undefined && notes === undefined) {
      throw new Error("select an option or add notes before sending");
    }
    const saved = await this.#mutate(
      input.question.answerSaved ? "question.revise" : "question.answer",
      {
        runId: requiredIdentity(input.runId, "run"),
        questionId: requiredIdentity(input.question.id, "question"),
        ...(input.question.batchId === undefined || input.question.batchVersion === undefined
          ? {}
          : {
              batchId: requiredIdentity(input.question.batchId, "question batch"),
              expectedVersion: input.question.batchVersion,
            }),
        ...(selected === undefined ? {} : { selectedOptionId: selected }),
        ...(notes === undefined ? {} : { notes }),
      },
    );
    if (input.question.batchId !== undefined && input.question.resolvesBatchOnSubmit === true) {
      const result = asRecord(saved.result);
      const batchVersion = result?.batchVersion;
      if (
        typeof batchVersion !== "number" ||
        !Number.isSafeInteger(batchVersion) ||
        batchVersion < 0
      ) {
        throw new Error("authority did not return the saved question batch version");
      }
      await this.#mutate("question.resolve", {
        runId: requiredIdentity(input.runId, "run"),
        batchId: requiredIdentity(input.question.batchId, "question batch"),
        expectedVersion: batchVersion,
      });
    }
  }

  public async approvePlan(input: { runId: string }): Promise<void> {
    await this.#mutate("plan.approve", { runId: requiredIdentity(input.runId, "run") });
  }

  public async revisePlan(input: { runId: string; instructions: string }): Promise<void> {
    const instructions = normalizeDecisionText(
      input.instructions,
      MAX_PLAN_REVISION_CODE_POINTS,
      true,
    );
    if (instructions === undefined)
      throw new Error("add steering instructions before requesting a revised plan");
    await this.#mutate("plan.revise", {
      runId: requiredIdentity(input.runId, "run"),
      instructions,
    });
  }

  public async decideProposal(input: {
    runId: string;
    proposal: ControlProposalInspection;
    decision: "approval" | "rejection";
    message?: string;
  }): Promise<void> {
    if (
      input.proposal.runId !== input.runId ||
      input.proposal.status !== "proposed" ||
      input.proposal.disposition.kind !== "pending"
    )
      throw new Error("this change proposal is no longer awaiting a decision");
    const message = normalizeDecisionText(input.message, MAX_PROPOSAL_MESSAGE_CODE_POINTS, true);
    await this.#mutate("proposal.decide", {
      runId: requiredIdentity(input.runId, "run"),
      ticketId: requiredIdentity(input.proposal.ticketId, "proposal"),
      decision: input.decision,
      ...(message === undefined ? {} : { message }),
    });
  }

  async #mutate(
    method:
      | "question.answer"
      | "question.revise"
      | "question.resolve"
      | "plan.approve"
      | "plan.revise"
      | "proposal.decide",
    params: JsonValue,
  ): Promise<RpcSuccess> {
    try {
      return await this.#connection.request(method, params, {
        expectedRevision: this.#connection.revision,
        idempotencyKey: this.#idempotencyKey(method),
      });
    } catch (error) {
      if (isRevisionConflict(error)) throw new MonitorDecisionConflictError();
      throw error;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeDecisionText(
  value: string | undefined,
  maximum: number,
  multiline: boolean,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = multiline
    ? value.replace(/\r\n?/gu, "\n").trim()
    : value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  if ([...normalized].length > maximum)
    throw new Error(`decision text exceeds ${maximum} characters`);
  if (/[^\t\n\r\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/u.test(normalized)) {
    throw new Error("decision text contains unsupported control characters");
  }
  return normalized;
}

function requiredIdentity(value: string, label: string): string {
  if (value.length === 0 || [...value].length > 256 || /[\p{Control}]/u.test(value)) {
    throw new Error(`${label} identity is invalid`);
  }
  return value;
}

function isRevisionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /stale|revision|conflict|cas/iu.test(error.code)
  );
}
