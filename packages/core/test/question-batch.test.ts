import { describe, expect, it } from "vitest";
import {
  QUESTION_BATCH_CAPABILITIES_PROTOCOL,
  QUESTION_BATCH_LIMITS,
  QUESTION_BATCH_PROTOCOL,
  QuestionBatchTransitionError,
  QuestionBatchValidationError,
  QuestionBatchVersionConflictError,
  assertQuestionBatchRecord,
  createQuestionBatch,
  legacySingleQuestionToBatch,
  projectQuestionBatchCapabilities,
  projectQuestionBatchResolution,
  queueQuestionBatchResume,
  reopenQuestionBatchForRevision,
  resolveQuestionBatch,
  reviseQuestionBatchAnswer,
  reviseQuestionBatchQuestions,
  saveQuestionBatchAnswer,
  type QuestionBatchQuestionInput,
  type QuestionBatchRecord,
} from "../src/state/question-batch.js";

const T0 = "2026-07-17T00:00:00.000Z";
const T1 = "2026-07-17T00:00:01.000Z";
const T2 = "2026-07-17T00:00:02.000Z";
const T3 = "2026-07-17T00:00:03.000Z";
const T4 = "2026-07-17T00:00:04.000Z";
const T5 = "2026-07-17T00:00:05.000Z";

describe("durable question batch state machine", () => {
  it("binds a planning question batch and its resolution to one planning revision", () => {
    const created = createQuestionBatch({
      id: "batch-planning-revision-one",
      attemptId: "attempt-plan",
      planningRevision: 1,
      questions: [question("question-planning")],
      createdAt: T0,
    });
    const answered = saveQuestionBatchAnswer(created, {
      expectedVersion: created.version,
      questionId: "question-planning",
      selectedOptionId: "question-planning.yes",
      savedAt: T1,
    });
    const queued = queueQuestionBatchResume(answered, {
      expectedVersion: answered.version,
      at: T2,
    });

    expect(created.planningRevision).toBe(1);
    expect(projectQuestionBatchCapabilities(created).planningRevision).toBe(1);
    expect(projectQuestionBatchResolution(queued).planningRevision).toBe(1);
    expect(() =>
      createQuestionBatch({
        id: "batch-invalid-planning-revision",
        attemptId: "attempt-plan",
        planningRevision: -1,
        questions: [question("question-invalid")],
        createdAt: T0,
      }),
    ).toThrow(/planningRevision/u);
  });

  it("binds ticket-scoped questions through capabilities and the sealed resolution", () => {
    const created = createQuestionBatch({
      id: "batch-scoped",
      attemptId: "attempt-one",
      scope: "ticket",
      ticketId: "ticket-one",
      questions: [question("question-one")],
      createdAt: T0,
    });
    const answered = saveQuestionBatchAnswer(created, {
      expectedVersion: created.version,
      questionId: "question-one",
      selectedOptionId: "question-one.yes",
      savedAt: T1,
    });
    const sealed = queueQuestionBatchResume(answered, {
      expectedVersion: answered.version,
      at: T2,
    });

    expect(projectQuestionBatchCapabilities(created)).toMatchObject({
      scope: "ticket",
      ticketId: "ticket-one",
    });
    expect(projectQuestionBatchResolution(sealed)).toMatchObject({
      scope: "ticket",
      ticketId: "ticket-one",
    });
    expect(() =>
      createQuestionBatch({
        id: "batch-invalid-scope",
        attemptId: "attempt-one",
        scope: "ticket",
        questions: [question("question-one")],
        createdAt: T0,
      }),
    ).toThrow(/ticketId.*required/u);
    expect(() =>
      createQuestionBatch({
        id: "batch-invalid-run-scope",
        attemptId: "attempt-one",
        scope: "run",
        ticketId: "ticket-one",
        questions: [question("question-one")],
        createdAt: T0,
      }),
    ).toThrow(/ticketId.*absent/u);
  });

  it("preserves one-to-eight ordered questions and their recommendations", () => {
    const questions = Array.from({ length: 8 }, (_, index) => question(`question-${index + 1}`));
    const batch = createQuestionBatch({
      id: "batch-one",
      attemptId: "attempt-one",
      questions,
      createdAt: T0,
    });

    expect(batch.protocol).toBe(QUESTION_BATCH_PROTOCOL);
    expect(batch.version).toBe(0);
    expect(batch.status).toBe("pending_answers");
    expect(batch.revisions).toHaveLength(1);
    expect(batch.revisions[0]!.questions.map(({ id }) => id)).toEqual(
      questions.map(({ id }) => id),
    );
    expect(batch.revisions[0]!.questions[0]!.recommendedOptionId).toBe("question-1.yes");

    const projection = projectQuestionBatchCapabilities(batch);
    expect(projection.protocol).toBe(QUESTION_BATCH_CAPABILITIES_PROTOCOL);
    expect(projection.pendingQuestionIds).toEqual(questions.map(({ id }) => id));
    expect(projection.actions.saveAnswer).toEqual({
      allowed: true,
      reason: "Unanswered questions may be saved.",
    });
    expect(projection.actions.queueResume).toEqual({
      allowed: false,
      reason: "8 questions still require a saved answer.",
    });
  });

  it("strictly rejects invalid counts, ids, options, recommendations, text, and timestamps", () => {
    expect(() =>
      createQuestionBatch({
        id: "batch-one",
        attemptId: "attempt-one",
        questions: [],
        createdAt: T0,
      }),
    ).toThrow(/must contain 1-8 ordered questions/u);
    expect(() =>
      createQuestionBatch({
        id: "batch-one",
        attemptId: "attempt-one",
        questions: Array.from({ length: 9 }, (_, index) => question(`q-${index}`)),
        createdAt: T0,
      }),
    ).toThrow(/must contain 1-8 ordered questions/u);
    expect(() =>
      createQuestionBatch({
        id: "unsafe/id",
        attemptId: "attempt-one",
        questions: [question("question-one")],
        createdAt: T0,
      }),
    ).toThrow(/safe nonempty identifier/u);
    expect(() =>
      createQuestionBatch({
        id: "batch-one",
        attemptId: "attempt-one",
        questions: [{ ...question("question-one"), options: [option("only")] }],
        createdAt: T0,
      }),
    ).toThrow(/must contain 2-8 options/u);
    expect(() =>
      createQuestionBatch({
        id: "batch-one",
        attemptId: "attempt-one",
        questions: [{ ...question("question-one"), recommendedOptionId: "missing" }],
        createdAt: T0,
      }),
    ).toThrow(/must identify one of this question's options/u);
    expect(() =>
      createQuestionBatch({
        id: "batch-one",
        attemptId: "attempt-one",
        questions: [{ ...question("question-one"), prompt: "bad\0prompt" }],
        createdAt: T0,
      }),
    ).toThrow(/meaningful scalar Unicode/u);
    expect(() =>
      createQuestionBatch({
        id: "batch-one",
        attemptId: "attempt-one",
        questions: [question("question-one")],
        createdAt: "July 17",
      }),
    ).toThrow(/canonical UTC ISO-8601/u);
  });

  it("saves notes with or without an option and requires explicit answer revision", () => {
    const original = batch();
    const first = saveQuestionBatchAnswer(original, {
      expectedVersion: 0,
      questionId: "question-one",
      selectedOptionId: "question-one.yes",
      notes: "Use the existing boundary.",
      savedAt: T1,
    });

    expect(original.version).toBe(0);
    expect(original.revisions[0]!.answers).toEqual({});
    expect(first.revisions[0]!.answers["question-one"]).toMatchObject({
      revision: 1,
      selectedOptionId: "question-one.yes",
      notes: "Use the existing boundary.",
    });
    expect(() =>
      saveQuestionBatchAnswer(first, {
        expectedVersion: 1,
        questionId: "question-one",
        notes: "Duplicate implicit overwrite",
        savedAt: T2,
      }),
    ).toThrow(/revise it explicitly/u);

    const revised = reviseQuestionBatchAnswer(first, {
      expectedVersion: 1,
      questionId: "question-one",
      notes: "None of the options; use a custom boundary.",
      savedAt: T2,
    });
    expect(revised.revisions[0]!.answers["question-one"]).toEqual({
      questionId: "question-one",
      revision: 2,
      notes: "None of the options; use a custom boundary.",
      savedAt: T2,
    });
    expect(projectQuestionBatchCapabilities(revised).questions[0]!.reviseAnswer.allowed).toBe(true);
  });

  it("enforces option, notes, and UTF-8 bounds at every save boundary", () => {
    const current = batch();
    expectTransitionCode(
      () =>
        saveQuestionBatchAnswer(current, {
          expectedVersion: 0,
          questionId: "question-one",
          selectedOptionId: "missing",
          savedAt: T1,
        }),
      "option_missing",
    );
    expectTransitionCode(
      () =>
        saveQuestionBatchAnswer(current, {
          expectedVersion: 0,
          questionId: "question-one",
          notes: "   ",
          savedAt: T1,
        }),
      "answer_empty",
    );

    const disallowsNotes = createQuestionBatch({
      id: "batch-no-notes",
      attemptId: "attempt-one",
      questions: [{ ...question("question-one"), allowsNotes: false }],
      createdAt: T0,
    });
    expectTransitionCode(
      () =>
        saveQuestionBatchAnswer(disallowsNotes, {
          expectedVersion: 0,
          questionId: "question-one",
          selectedOptionId: "question-one.no",
          notes: "not allowed",
          savedAt: T1,
        }),
      "notes_disallowed",
    );
    expect(() =>
      saveQuestionBatchAnswer(current, {
        expectedVersion: 0,
        questionId: "question-one",
        notes: "x".repeat(QUESTION_BATCH_LIMITS.notesBytes + 1),
        savedAt: T1,
      }),
    ).toThrow(QuestionBatchValidationError);
  });

  it("gates resume on all answers and separates sealing from successful resolution", () => {
    const initial = createQuestionBatch({
      id: "batch-two",
      attemptId: "attempt-one",
      questions: [question("question-one"), question("question-two")],
      createdAt: T0,
    });
    const one = saveQuestionBatchAnswer(initial, {
      expectedVersion: 0,
      questionId: "question-one",
      selectedOptionId: "question-one.yes",
      savedAt: T1,
    });
    expectTransitionCode(
      () => queueQuestionBatchResume(one, { expectedVersion: 1, at: T2 }),
      "answers_incomplete",
    );
    const two = saveQuestionBatchAnswer(one, {
      expectedVersion: 1,
      questionId: "question-two",
      notes: "A custom answer.",
      savedAt: T2,
    });
    const sealed = queueQuestionBatchResume(two, { expectedVersion: 2, at: T3 });
    expect(sealed.status).toBe("pending_resume");
    expect(sealed.pendingResumeAt).toBe(T3);
    expect(sealed.resolvedAt).toBeUndefined();
    expect(projectQuestionBatchCapabilities(sealed).actions).toMatchObject({
      reopenForRevision: { allowed: true },
      resolve: { allowed: true },
      saveAnswer: { allowed: false },
    });

    const resolution = projectQuestionBatchResolution(sealed);
    expect(resolution.answers).toEqual([
      {
        questionId: "question-one",
        prompt: "Prompt for question-one?",
        answerRevision: 1,
        selectedOptionId: "question-one.yes",
        selectedOptionLabel: "Yes",
      },
      {
        questionId: "question-two",
        prompt: "Prompt for question-two?",
        answerRevision: 1,
        notes: "A custom answer.",
      },
    ]);

    const resolved = resolveQuestionBatch(sealed, { expectedVersion: 3, at: T4 });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBe(T4);
    expect(projectQuestionBatchCapabilities(resolved).actions.resolve).toEqual({
      allowed: false,
      reason: "The batch is already resolved.",
    });
    expectTransitionCode(
      () =>
        reopenQuestionBatchForRevision(resolved, {
          expectedVersion: 4,
          at: T5,
        }),
      "state",
    );
  });

  it("supports an explicit reopen and revision before resume delivery", () => {
    const answered = saveQuestionBatchAnswer(batch(), {
      expectedVersion: 0,
      questionId: "question-one",
      selectedOptionId: "question-one.yes",
      savedAt: T1,
    });
    const sealed = queueQuestionBatchResume(answered, { expectedVersion: 1, at: T2 });
    const reopened = reopenQuestionBatchForRevision(sealed, { expectedVersion: 2, at: T3 });
    expect(reopened.status).toBe("pending_answers");
    expect(reopened.pendingResumeAt).toBeUndefined();
    const revised = reviseQuestionBatchAnswer(reopened, {
      expectedVersion: 3,
      questionId: "question-one",
      selectedOptionId: "question-one.no",
      notes: "Changed before delivery.",
      savedAt: T4,
    });
    const resealed = queueQuestionBatchResume(revised, { expectedVersion: 4, at: T5 });
    expect(projectQuestionBatchResolution(resealed).answers[0]).toMatchObject({
      answerRevision: 2,
      selectedOptionId: "question-one.no",
      notes: "Changed before delivery.",
    });
  });

  it("retains immutable question-set revisions and resets answers instead of guessing", () => {
    const answered = saveQuestionBatchAnswer(batch(), {
      expectedVersion: 0,
      questionId: "question-one",
      selectedOptionId: "question-one.yes",
      savedAt: T1,
    });
    const revised = reviseQuestionBatchQuestions(answered, {
      expectedVersion: 1,
      questions: [question("replacement")],
      reason: "The implementation discovery changed the decision boundary.",
      revisedAt: T2,
    });
    expect(revised.currentRevision).toBe(2);
    expect(revised.revisions).toHaveLength(2);
    expect(revised.revisions[0]!.answers["question-one"]?.selectedOptionId).toBe(
      "question-one.yes",
    );
    expect(revised.revisions[1]).toMatchObject({
      revision: 2,
      source: "native",
      reason: "The implementation discovery changed the decision boundary.",
      answers: {},
    });
    expect(projectQuestionBatchCapabilities(revised).pendingQuestionIds).toEqual(["replacement"]);
  });

  it("rejects stale writers and regressing durable timestamps", () => {
    const initial = batch();
    expect(() =>
      saveQuestionBatchAnswer(initial, {
        expectedVersion: 7,
        questionId: "question-one",
        notes: "stale",
        savedAt: T1,
      }),
    ).toThrow(QuestionBatchVersionConflictError);
    expectTransitionCode(
      () =>
        saveQuestionBatchAnswer(initial, {
          expectedVersion: 0,
          questionId: "question-one",
          notes: "backdated",
          savedAt: "2026-07-16T23:59:59.000Z",
        }),
      "timestamp_regression",
    );
  });

  it("treats prototype-shaped ids as ordinary durable keys", () => {
    const unusual = createQuestionBatch({
      id: "prototype-key-batch",
      attemptId: "attempt-one",
      questions: [question("constructor"), question("prototype")],
      createdAt: T0,
    });
    const first = saveQuestionBatchAnswer(unusual, {
      expectedVersion: 0,
      questionId: "constructor",
      selectedOptionId: "constructor.yes",
      savedAt: T1,
    });
    const second = saveQuestionBatchAnswer(first, {
      expectedVersion: 1,
      questionId: "prototype",
      selectedOptionId: "prototype.no",
      savedAt: T2,
    });
    const sealed = queueQuestionBatchResume(second, { expectedVersion: 2, at: T3 });
    expect(
      projectQuestionBatchResolution(sealed).answers.map((answer) => answer.questionId),
    ).toEqual(["constructor", "prototype"]);
  });

  it("validates persisted invariants instead of trusting typed callers", () => {
    const original = saveQuestionBatchAnswer(batch(), {
      expectedVersion: 0,
      questionId: "question-one",
      selectedOptionId: "question-one.yes",
      savedAt: T1,
    });
    const malformed = structuredClone(original);
    malformed.status = "pending_resume";
    expect(() => assertQuestionBatchRecord(malformed)).toThrow(/pendingResumeAt/u);

    const invalidRecommendation = structuredClone(original);
    invalidRecommendation.revisions[0]!.questions[0]!.recommendedOptionId = "missing";
    expect(() => assertQuestionBatchRecord(invalidRecommendation)).toThrow(/recommendedOptionId/u);

    const orphanAnswer = structuredClone(original);
    orphanAnswer.revisions[0]!.answers.orphan = {
      questionId: "orphan",
      revision: 1,
      notes: "orphan",
      savedAt: T1,
    };
    expect(() => assertQuestionBatchRecord(orphanAnswer)).toThrow(/does not belong/u);
  });

  it("maps unanswered and answered legacy questions, including one-option acknowledgements", () => {
    const legacy = {
      id: "legacy-question",
      attemptId: "legacy-attempt",
      prompt: "Proceed with the migration?",
      options: [option("acknowledge")],
      allowsNotes: true,
      askedAt: T0,
    };
    const pending = legacySingleQuestionToBatch(legacy);
    expect(pending).toMatchObject({
      id: "legacy-question",
      status: "pending_answers",
      currentRevision: 1,
    });
    expect(pending.revisions[0]).toMatchObject({ source: "legacy_single", answers: {} });

    const historical = legacySingleQuestionToBatch({
      ...legacy,
      answeredAt: T1,
      selectedOptionId: "acknowledge",
      notes: "Confirmed.",
    });
    expect(historical.status).toBe("resolved");
    expect(historical.pendingResumeAt).toBe(T1);
    expect(historical.resolvedAt).toBe(T1);
    expect(projectQuestionBatchResolution(historical).answers[0]).toMatchObject({
      selectedOptionId: "acknowledge",
      selectedOptionLabel: "Acknowledge",
      notes: "Confirmed.",
    });

    const recovering = legacySingleQuestionToBatch(
      {
        ...legacy,
        answeredAt: T1,
        notes: "No listed answer.",
      },
      { batchId: "legacy-batch", answeredState: "pending_resume" },
    );
    expect(recovering).toMatchObject({
      id: "legacy-batch",
      status: "pending_resume",
      pendingResumeAt: T1,
    });
    expect(recovering.resolvedAt).toBeUndefined();
  });

  it("rejects inconsistent or unsafe legacy records rather than silently changing them", () => {
    const legacy = {
      id: "legacy-question",
      attemptId: "legacy-attempt",
      prompt: "Proceed?",
      options: [option("acknowledge")],
      allowsNotes: true,
      askedAt: T0,
    };
    expect(() =>
      legacySingleQuestionToBatch({
        ...legacy,
        notes: "answer without answeredAt",
      }),
    ).toThrow(/unanswered legacy question/u);
    expect(() =>
      legacySingleQuestionToBatch({
        ...legacy,
        answeredAt: T1,
      }),
    ).toThrow(/requires an option or meaningful notes/u);
    expect(() =>
      legacySingleQuestionToBatch({
        ...legacy,
        allowsNotes: false,
        answeredAt: T1,
        notes: "not allowed",
      }),
    ).toThrow(/does not allow notes/u);
  });

  it("projects byte-for-byte deterministic capabilities from the same durable state", () => {
    const current = saveQuestionBatchAnswer(batch(), {
      expectedVersion: 0,
      questionId: "question-one",
      selectedOptionId: "question-one.no",
      savedAt: T1,
    });
    const first = projectQuestionBatchCapabilities(current);
    const second = projectQuestionBatchCapabilities(structuredClone(current));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.questions).toEqual([
      {
        questionId: "question-one",
        answered: true,
        recommendedOptionId: "question-one.yes",
        saveAnswer: {
          allowed: false,
          reason: "This question already has a saved answer; revise it explicitly.",
        },
        reviseAnswer: {
          allowed: true,
          reason: "This saved answer may be revised before the batch is sealed.",
        },
      },
    ]);
  });
});

function batch(): QuestionBatchRecord {
  return createQuestionBatch({
    id: "batch-one",
    attemptId: "attempt-one",
    questions: [question("question-one")],
    createdAt: T0,
  });
}

function question(id: string): QuestionBatchQuestionInput {
  return {
    id,
    prompt: `Prompt for ${id}?`,
    options: [option(`${id}.yes`, "Yes"), option(`${id}.no`, "No")],
    allowsNotes: true,
    recommendedOptionId: `${id}.yes`,
  };
}

function option(id: string, label = "Acknowledge") {
  return { id, label, description: `${label} option description.` };
}

function expectTransitionCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected question batch transition to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(QuestionBatchTransitionError);
    expect((error as QuestionBatchTransitionError).code).toBe(code);
  }
}
