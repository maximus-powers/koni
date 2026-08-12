export const QUESTION_BATCH_PROTOCOL = "koni.question-batch.v1" as const;
export const QUESTION_BATCH_REVISION_PROTOCOL = "koni.question-batch-revision.v1" as const;
export const QUESTION_BATCH_CAPABILITIES_PROTOCOL = "koni.question-batch-capabilities.v1" as const;
export const QUESTION_BATCH_RESOLUTION_PROTOCOL = "koni.question-batch-resolution.v1" as const;

export const QUESTION_BATCH_LIMITS = Object.freeze({
  questions: 8,
  options: 8,
  revisions: 64,
  idBytes: 128,
  promptBytes: 1024 * 1024,
  optionLabelBytes: 16 * 1024,
  optionDescriptionBytes: 64 * 1024,
  notesBytes: 64 * 1024,
  revisionReasonBytes: 64 * 1024,
  timestampBytes: 64,
});

export type QuestionBatchStatus = "pending_answers" | "pending_resume" | "resolved";
export type QuestionBatchRevisionSource = "native" | "legacy_single";

export interface QuestionBatchOptionRecord {
  id: string;
  label: string;
  description: string;
}

export interface QuestionBatchQuestionRecord {
  id: string;
  prompt: string;
  options: QuestionBatchOptionRecord[];
  allowsNotes: boolean;
  /** Required on current records; absent only on questions created before policy-aware batches. */
  impact?: "routine" | "high_impact";
  recommendedOptionId?: string;
}

export interface QuestionBatchAnswerRecord {
  questionId: string;
  revision: number;
  selectedOptionId?: string;
  notes?: string;
  /** Absent only on historical answers, which retain operator-authored compatibility semantics. */
  source?: "operator" | "configured_recommendation";
  savedAt: string;
}

/**
 * One immutable question-set revision plus its explicitly versioned saved answers.
 * Creating a later revision never mutates or erases the earlier audit record.
 */
export interface QuestionBatchRevisionRecord {
  protocol: typeof QUESTION_BATCH_REVISION_PROTOCOL;
  revision: number;
  source: QuestionBatchRevisionSource;
  createdAt: string;
  reason?: string;
  questions: QuestionBatchQuestionRecord[];
  answers: Record<string, QuestionBatchAnswerRecord>;
}

/**
 * Durable, CAS-friendly authority state for one ordered group of questions.
 *
 * `pending_resume` is intentionally distinct from `resolved`: the former means
 * every answer is sealed and ready to deliver, while the latter proves the
 * authority completed the resume/continuation boundary.
 */
export interface QuestionBatchRecord {
  protocol: typeof QUESTION_BATCH_PROTOCOL;
  id: string;
  attemptId: string;
  /** Active continuous-planning revision; absent for legacy and non-planning batches. */
  planningRevision?: number;
  /** Absent only on batches created before compiler-authored question scoping. */
  scope?: "run" | "ticket";
  /** Present exactly when `scope` is `ticket`. */
  ticketId?: string;
  version: number;
  status: QuestionBatchStatus;
  currentRevision: number;
  revisions: QuestionBatchRevisionRecord[];
  createdAt: string;
  updatedAt: string;
  pendingResumeAt?: string;
  resolvedAt?: string;
}

export interface QuestionBatchQuestionInput {
  id: string;
  prompt: string;
  options: QuestionBatchOptionRecord[];
  allowsNotes: boolean;
  impact?: "routine" | "high_impact";
  recommendedOptionId?: string;
}

export interface CreateQuestionBatchInput {
  id: string;
  attemptId: string;
  planningRevision?: number;
  scope?: "run" | "ticket";
  ticketId?: string;
  questions: QuestionBatchQuestionInput[];
  createdAt: string;
}

export interface SaveQuestionBatchAnswerInput {
  expectedVersion: number;
  questionId: string;
  selectedOptionId?: string;
  notes?: string;
  source?: "operator" | "configured_recommendation";
  savedAt: string;
}

export interface ReviseQuestionBatchQuestionsInput {
  expectedVersion: number;
  questions: QuestionBatchQuestionInput[];
  reason: string;
  revisedAt: string;
}

export interface QuestionBatchTransitionInput {
  expectedVersion: number;
  at: string;
}

export interface QuestionBatchCapability {
  allowed: boolean;
  reason: string;
}

export interface QuestionBatchQuestionCapabilities {
  questionId: string;
  answered: boolean;
  impact?: "routine" | "high_impact";
  recommendedOptionId?: string;
  saveAnswer: QuestionBatchCapability;
  reviseAnswer: QuestionBatchCapability;
}

export interface QuestionBatchCapabilities {
  protocol: typeof QUESTION_BATCH_CAPABILITIES_PROTOCOL;
  batchId: string;
  planningRevision?: number;
  scope?: "run" | "ticket";
  ticketId?: string;
  batchVersion: number;
  status: QuestionBatchStatus;
  currentRevision: number;
  answeredCount: number;
  totalCount: number;
  pendingQuestionIds: string[];
  questions: QuestionBatchQuestionCapabilities[];
  actions: {
    saveAnswer: QuestionBatchCapability;
    reviseAnswer: QuestionBatchCapability;
    reviseQuestions: QuestionBatchCapability;
    queueResume: QuestionBatchCapability;
    reopenForRevision: QuestionBatchCapability;
    resolve: QuestionBatchCapability;
  };
}

export interface QuestionBatchResolutionAnswer {
  questionId: string;
  prompt: string;
  answerRevision: number;
  selectedOptionId?: string;
  selectedOptionLabel?: string;
  notes?: string;
  source?: "operator" | "configured_recommendation";
}

export interface QuestionBatchResolution {
  protocol: typeof QUESTION_BATCH_RESOLUTION_PROTOCOL;
  batchId: string;
  attemptId: string;
  planningRevision?: number;
  scope?: "run" | "ticket";
  ticketId?: string;
  batchVersion: number;
  questionRevision: number;
  answers: QuestionBatchResolutionAnswer[];
}

/** The exact historical single-question shape accepted by the compatibility adapter. */
export interface LegacySingleQuestionRecord {
  id: string;
  attemptId: string;
  prompt: string;
  options: QuestionBatchOptionRecord[];
  allowsNotes: boolean;
  askedAt: string;
  answeredAt?: string;
  selectedOptionId?: string;
  notes?: string;
}

export interface LegacySingleQuestionMappingOptions {
  batchId?: string;
  /**
   * Historical answered questions normally already resumed, so `resolved` is
   * the safe default. Recovery code may explicitly preserve an undelivered
   * answer as `pending_resume`.
   */
  answeredState?: "pending_resume" | "resolved";
}

export class QuestionBatchValidationError extends Error {
  public readonly path: string;

  public constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "QuestionBatchValidationError";
    this.path = path;
  }
}

export class QuestionBatchTransitionError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "QuestionBatchTransitionError";
    this.code = code;
  }
}

export class QuestionBatchVersionConflictError extends QuestionBatchTransitionError {
  public constructor(expected: number, actual: number) {
    super(
      "version_conflict",
      `question batch version conflict: expected ${expected}, found ${actual}`,
    );
    this.name = "QuestionBatchVersionConflictError";
  }
}

export function createQuestionBatch(input: CreateQuestionBatchInput): QuestionBatchRecord {
  const createdAt = normalizeTimestamp(input.createdAt, "$.createdAt");
  const scope = normalizeScope(input.scope, input.ticketId, "$");
  const record: QuestionBatchRecord = {
    protocol: QUESTION_BATCH_PROTOCOL,
    id: normalizeId(input.id, "$.id"),
    attemptId: normalizeId(input.attemptId, "$.attemptId"),
    ...(input.planningRevision === undefined
      ? {}
      : { planningRevision: normalizePlanningRevision(input.planningRevision) }),
    ...scope,
    version: 0,
    status: "pending_answers",
    currentRevision: 1,
    revisions: [
      {
        protocol: QUESTION_BATCH_REVISION_PROTOCOL,
        revision: 1,
        source: "native",
        createdAt,
        questions: normalizeQuestions(input.questions, "$.revisions[0].questions", false),
        answers: {},
      },
    ],
    createdAt,
    updatedAt: createdAt,
  };
  assertQuestionBatchRecord(record);
  return record;
}

/** Save an answer for an unanswered question. Existing answers require the explicit revise action. */
export function saveQuestionBatchAnswer(
  current: QuestionBatchRecord,
  input: SaveQuestionBatchAnswerInput,
): QuestionBatchRecord {
  const next = prepareMutation(current, input.expectedVersion, input.savedAt);
  requireStatus(next, "pending_answers", "save_answer");
  const revision = activeRevision(next);
  const question = requireQuestion(revision, input.questionId);
  if (hasAnswer(revision, question.id)) {
    throw new QuestionBatchTransitionError(
      "answer_exists",
      `question ${question.id} already has a saved answer; revise it explicitly`,
    );
  }
  putAnswer(revision, question.id, normalizeAnswer(question, input, 1));
  finishMutation(next, input.savedAt);
  return next;
}

/** Replace one saved answer while retaining its monotonically increasing answer revision. */
export function reviseQuestionBatchAnswer(
  current: QuestionBatchRecord,
  input: SaveQuestionBatchAnswerInput,
): QuestionBatchRecord {
  const next = prepareMutation(current, input.expectedVersion, input.savedAt);
  requireStatus(next, "pending_answers", "revise_answer");
  const revision = activeRevision(next);
  const question = requireQuestion(revision, input.questionId);
  const previous = answerFor(revision, question.id);
  if (previous === undefined) {
    throw new QuestionBatchTransitionError(
      "answer_missing",
      `question ${question.id} has no saved answer to revise`,
    );
  }
  putAnswer(revision, question.id, normalizeAnswer(question, input, previous.revision + 1));
  finishMutation(next, input.savedAt);
  return next;
}

/**
 * Replace the complete active question set with a new immutable revision.
 * Answers never carry across implicitly because changed wording/options may alter their meaning.
 */
export function reviseQuestionBatchQuestions(
  current: QuestionBatchRecord,
  input: ReviseQuestionBatchQuestionsInput,
): QuestionBatchRecord {
  const next = prepareMutation(current, input.expectedVersion, input.revisedAt);
  requireStatus(next, "pending_answers", "revise_questions");
  if (next.revisions.length >= QUESTION_BATCH_LIMITS.revisions) {
    throw new QuestionBatchTransitionError(
      "revision_limit",
      "question batch revision limit reached",
    );
  }
  const revision = next.currentRevision + 1;
  next.revisions.push({
    protocol: QUESTION_BATCH_REVISION_PROTOCOL,
    revision,
    source: "native",
    createdAt: normalizeTimestamp(input.revisedAt, "$.revisedAt"),
    reason: normalizeText(input.reason, "$.reason", QUESTION_BATCH_LIMITS.revisionReasonBytes),
    questions: normalizeQuestions(input.questions, "$.questions", false),
    answers: {},
  });
  next.currentRevision = revision;
  finishMutation(next, input.revisedAt);
  return next;
}

/** Seal an all-answered batch for authority delivery without claiming delivery already happened. */
export function queueQuestionBatchResume(
  current: QuestionBatchRecord,
  input: QuestionBatchTransitionInput,
): QuestionBatchRecord {
  const next = prepareMutation(current, input.expectedVersion, input.at);
  requireStatus(next, "pending_answers", "queue_resume");
  requireAllAnswered(next);
  next.status = "pending_resume";
  next.pendingResumeAt = normalizeTimestamp(input.at, "$.at");
  finishMutation(next, input.at);
  return next;
}

/** Return a sealed-but-undelivered batch to editing before changing an answer or question set. */
export function reopenQuestionBatchForRevision(
  current: QuestionBatchRecord,
  input: QuestionBatchTransitionInput,
): QuestionBatchRecord {
  const next = prepareMutation(current, input.expectedVersion, input.at);
  requireStatus(next, "pending_resume", "reopen_for_revision");
  next.status = "pending_answers";
  delete next.pendingResumeAt;
  finishMutation(next, input.at);
  return next;
}

/** Mark the batch resolved only after the authority has completed the resume/continuation boundary. */
export function resolveQuestionBatch(
  current: QuestionBatchRecord,
  input: QuestionBatchTransitionInput,
): QuestionBatchRecord {
  const next = prepareMutation(current, input.expectedVersion, input.at);
  requireStatus(next, "pending_resume", "resolve");
  requireAllAnswered(next);
  next.status = "resolved";
  next.resolvedAt = normalizeTimestamp(input.at, "$.at");
  finishMutation(next, input.at);
  return next;
}

/** A stable, ordered answer envelope suitable for the authority-to-session resume payload. */
export function projectQuestionBatchResolution(
  current: QuestionBatchRecord,
): QuestionBatchResolution {
  assertQuestionBatchRecord(current);
  if (current.status !== "pending_resume" && current.status !== "resolved") {
    throw new QuestionBatchTransitionError(
      "resolution_unavailable",
      "question batch answers are not sealed for resume",
    );
  }
  requireAllAnswered(current);
  const revision = activeRevision(current);
  return {
    protocol: QUESTION_BATCH_RESOLUTION_PROTOCOL,
    batchId: current.id,
    attemptId: current.attemptId,
    ...(current.planningRevision === undefined
      ? {}
      : { planningRevision: current.planningRevision }),
    ...(current.scope === undefined ? {} : { scope: current.scope }),
    ...(current.ticketId === undefined ? {} : { ticketId: current.ticketId }),
    batchVersion: current.version,
    questionRevision: revision.revision,
    answers: revision.questions.map((question) => {
      const answer = answerFor(revision, question.id)!;
      const selected =
        answer.selectedOptionId === undefined
          ? undefined
          : question.options.find((option) => option.id === answer.selectedOptionId);
      return {
        questionId: question.id,
        prompt: question.prompt,
        answerRevision: answer.revision,
        ...(answer.selectedOptionId === undefined
          ? {}
          : { selectedOptionId: answer.selectedOptionId }),
        ...(selected === undefined ? {} : { selectedOptionLabel: selected.label }),
        ...(answer.notes === undefined ? {} : { notes: answer.notes }),
        ...(answer.source === undefined ? {} : { source: answer.source }),
      };
    }),
  };
}

/** Derive all UI/operator actions from durable state; no wall clock or ambient state is consulted. */
export function projectQuestionBatchCapabilities(
  current: QuestionBatchRecord,
): QuestionBatchCapabilities {
  assertQuestionBatchRecord(current);
  const revision = activeRevision(current);
  const pendingQuestionIds = revision.questions
    .filter((question) => !hasAnswer(revision, question.id))
    .map((question) => question.id);
  const answeredCount = revision.questions.length - pendingQuestionIds.length;
  const pendingCount = pendingQuestionIds.length;

  const acceptsAnswers = current.status === "pending_answers";
  const saveAnswer =
    acceptsAnswers && pendingCount > 0
      ? allowed("Unanswered questions may be saved.")
      : denied(
          current.status !== "pending_answers"
            ? stateReason(current.status, "save answers")
            : "Every question already has a saved answer; revise an answer or queue resume.",
        );
  const reviseAnswer =
    acceptsAnswers && answeredCount > 0
      ? allowed("Saved answers may be revised explicitly before the batch is sealed.")
      : denied(
          current.status !== "pending_answers"
            ? stateReason(current.status, "revise answers")
            : "No question has a saved answer to revise.",
        );
  const reviseQuestions = acceptsAnswers
    ? allowed("The active question set may be replaced by an explicit revision.")
    : denied(stateReason(current.status, "revise the question set"));
  const queueResume =
    acceptsAnswers && pendingCount === 0
      ? allowed("All questions have saved answers; the batch may be queued for resume.")
      : denied(
          current.status !== "pending_answers"
            ? stateReason(current.status, "queue resume")
            : `${pendingCount} ${pendingCount === 1 ? "question still requires" : "questions still require"} a saved answer.`,
        );
  const reopenForRevision =
    current.status === "pending_resume"
      ? allowed("The sealed answers may be reopened for an explicit revision before delivery.")
      : denied(
          current.status === "resolved"
            ? "A resolved batch cannot be reopened."
            : "The batch is already open for answers and revisions.",
        );
  const resolve =
    current.status === "pending_resume" && pendingCount === 0
      ? allowed("The sealed answers may be marked resolved after successful resume delivery.")
      : denied(
          current.status === "resolved"
            ? "The batch is already resolved."
            : current.status === "pending_answers"
              ? "Queue the all-answered batch for resume before resolving it."
              : "Every question must have a saved answer before resolution.",
        );

  return {
    protocol: QUESTION_BATCH_CAPABILITIES_PROTOCOL,
    batchId: current.id,
    ...(current.planningRevision === undefined
      ? {}
      : { planningRevision: current.planningRevision }),
    ...(current.scope === undefined ? {} : { scope: current.scope }),
    ...(current.ticketId === undefined ? {} : { ticketId: current.ticketId }),
    batchVersion: current.version,
    status: current.status,
    currentRevision: current.currentRevision,
    answeredCount,
    totalCount: revision.questions.length,
    pendingQuestionIds,
    questions: revision.questions.map((question) => {
      const answered = hasAnswer(revision, question.id);
      return {
        questionId: question.id,
        answered,
        ...(question.impact === undefined ? {} : { impact: question.impact }),
        ...(question.recommendedOptionId === undefined
          ? {}
          : { recommendedOptionId: question.recommendedOptionId }),
        saveAnswer:
          acceptsAnswers && !answered
            ? allowed("This question is unanswered and the batch accepts answers.")
            : denied(
                !acceptsAnswers
                  ? stateReason(current.status, "save this answer")
                  : "This question already has a saved answer; revise it explicitly.",
              ),
        reviseAnswer:
          acceptsAnswers && answered
            ? allowed("This saved answer may be revised before the batch is sealed.")
            : denied(
                !acceptsAnswers
                  ? stateReason(current.status, "revise this answer")
                  : "This question has no saved answer to revise.",
              ),
      };
    }),
    actions: {
      saveAnswer,
      reviseAnswer,
      reviseQuestions,
      queueResume,
      reopenForRevision,
      resolve,
    },
  };
}

/** Map one historical question without pretending an answered legacy record is still editable. */
export function legacySingleQuestionToBatch(
  legacy: LegacySingleQuestionRecord,
  options: LegacySingleQuestionMappingOptions = {},
): QuestionBatchRecord {
  if (!isRecord(legacy)) fail("$", "legacy question must be a record");
  const questionId = normalizeId(legacy.id, "$.id");
  const attemptId = normalizeId(legacy.attemptId, "$.attemptId");
  const askedAt = normalizeTimestamp(legacy.askedAt, "$.askedAt");
  const question = normalizeQuestion(
    {
      id: questionId,
      prompt: legacy.prompt,
      options: legacy.options,
      allowsNotes: legacy.allowsNotes,
    },
    "$.question",
    true,
  );
  const answered = legacy.answeredAt !== undefined;
  if (!answered && (legacy.selectedOptionId !== undefined || meaningful(legacy.notes))) {
    fail("$", "an unanswered legacy question cannot contain a saved answer");
  }
  const answeredAt = answered ? normalizeTimestamp(legacy.answeredAt, "$.answeredAt") : undefined;
  const answer =
    answeredAt === undefined
      ? undefined
      : normalizeAnswer(
          question,
          {
            expectedVersion: 0,
            questionId,
            ...(legacy.selectedOptionId === undefined
              ? {}
              : { selectedOptionId: legacy.selectedOptionId }),
            ...(legacy.notes === undefined ? {} : { notes: legacy.notes }),
            savedAt: answeredAt,
          },
          1,
        );
  const answeredState = options.answeredState ?? "resolved";
  const status: QuestionBatchStatus = answer === undefined ? "pending_answers" : answeredState;
  const record: QuestionBatchRecord = {
    protocol: QUESTION_BATCH_PROTOCOL,
    id: normalizeId(options.batchId ?? questionId, "$.batchId"),
    attemptId,
    version: 0,
    status,
    currentRevision: 1,
    revisions: [
      {
        protocol: QUESTION_BATCH_REVISION_PROTOCOL,
        revision: 1,
        source: "legacy_single",
        createdAt: askedAt,
        questions: [question],
        answers: answer === undefined ? {} : { [questionId]: answer },
      },
    ],
    createdAt: askedAt,
    updatedAt: answeredAt ?? askedAt,
    ...(answer === undefined ? {} : { pendingResumeAt: answeredAt! }),
    ...(status === "resolved" ? { resolvedAt: answeredAt! } : {}),
  };
  assertQuestionBatchRecord(record);
  return record;
}

export function assertQuestionBatchRecord(value: unknown): asserts value is QuestionBatchRecord {
  if (!isRecord(value) || value.protocol !== QUESTION_BATCH_PROTOCOL) {
    fail("$.protocol", "question batch protocol is missing or unsupported");
  }
  normalizeId(value.id, "$.id");
  normalizeId(value.attemptId, "$.attemptId");
  if (value.planningRevision !== undefined) normalizePlanningRevision(value.planningRevision);
  normalizeScope(value.scope, value.ticketId, "$");
  if (!isNonnegativeInteger(value.version)) fail("$.version", "must be a nonnegative safe integer");
  if (
    value.status !== "pending_answers" &&
    value.status !== "pending_resume" &&
    value.status !== "resolved"
  ) {
    fail("$.status", "must be pending_answers, pending_resume, or resolved");
  }
  const createdAt = normalizeTimestamp(value.createdAt, "$.createdAt");
  const updatedAt = normalizeTimestamp(value.updatedAt, "$.updatedAt");
  if (timestampMs(updatedAt) < timestampMs(createdAt))
    fail("$.updatedAt", "must not predate createdAt");
  if (
    !Array.isArray(value.revisions) ||
    value.revisions.length < 1 ||
    value.revisions.length > QUESTION_BATCH_LIMITS.revisions
  ) {
    fail("$.revisions", `must contain 1-${QUESTION_BATCH_LIMITS.revisions} revisions`);
  }
  if (
    !isPositiveInteger(value.currentRevision) ||
    value.currentRevision !== value.revisions.length
  ) {
    fail("$.currentRevision", "must identify the final sequential revision");
  }
  for (let index = 0; index < value.revisions.length; index += 1) {
    assertRevision(value.revisions[index], index, createdAt, updatedAt);
  }
  const revisions = value.revisions as QuestionBatchRevisionRecord[];
  if (value.version < revisions.length - 1) {
    fail("$.version", "cannot be lower than the number of question-set revisions applied");
  }
  for (let index = 1; index < revisions.length; index += 1) {
    const previous = revisions[index - 1]!;
    const current = revisions[index]!;
    if (timestampMs(current.createdAt) < timestampMs(previous.createdAt)) {
      fail(`$.revisions[${index}].createdAt`, "question-set revisions must be chronological");
    }
    for (const answer of Object.values(previous.answers)) {
      if (timestampMs(answer.savedAt) > timestampMs(current.createdAt)) {
        fail(
          `$.revisions[${index - 1}].answers.${answer.questionId}.savedAt`,
          "a superseded revision cannot be answered after its successor was created",
        );
      }
    }
  }
  const active = value.revisions[value.revisions.length - 1] as QuestionBatchRevisionRecord;
  const allAnswered = active.questions.every((question) => hasAnswer(active, question.id));
  if (value.status === "pending_answers") {
    if (value.pendingResumeAt !== undefined || value.resolvedAt !== undefined) {
      fail("$", "pending_answers cannot carry resume or resolution timestamps");
    }
  } else {
    if (!allAnswered)
      fail("$.status", `${value.status} requires every active question to be answered`);
    const pendingResumeAt = normalizeTimestamp(value.pendingResumeAt, "$.pendingResumeAt");
    if (
      timestampMs(pendingResumeAt) < timestampMs(active.createdAt) ||
      timestampMs(pendingResumeAt) > timestampMs(updatedAt)
    ) {
      fail("$.pendingResumeAt", "must fall between the active revision and updatedAt");
    }
    if (value.status === "pending_resume") {
      if (value.resolvedAt !== undefined) fail("$.resolvedAt", "pending_resume cannot be resolved");
    } else {
      const resolvedAt = normalizeTimestamp(value.resolvedAt, "$.resolvedAt");
      if (
        timestampMs(resolvedAt) < timestampMs(pendingResumeAt) ||
        timestampMs(resolvedAt) > timestampMs(updatedAt)
      ) {
        fail("$.resolvedAt", "must fall between pendingResumeAt and updatedAt");
      }
    }
  }
}

function assertRevision(
  value: unknown,
  index: number,
  batchCreatedAt: string,
  batchUpdatedAt: string,
): asserts value is QuestionBatchRevisionRecord {
  const path = `$.revisions[${index}]`;
  if (!isRecord(value) || value.protocol !== QUESTION_BATCH_REVISION_PROTOCOL) {
    fail(`${path}.protocol`, "question batch revision protocol is missing or unsupported");
  }
  if (value.revision !== index + 1)
    fail(`${path}.revision`, "revisions must be sequential and one-based");
  if (value.source !== "native" && value.source !== "legacy_single") {
    fail(`${path}.source`, "must be native or legacy_single");
  }
  const createdAt = normalizeTimestamp(value.createdAt, `${path}.createdAt`);
  if (
    timestampMs(createdAt) < timestampMs(batchCreatedAt) ||
    timestampMs(createdAt) > timestampMs(batchUpdatedAt)
  ) {
    fail(`${path}.createdAt`, "must fall within the batch lifetime");
  }
  if (index === 0 && createdAt !== batchCreatedAt) {
    fail(`${path}.createdAt`, "the first revision must match batch createdAt");
  }
  if (value.reason !== undefined) {
    normalizeText(value.reason, `${path}.reason`, QUESTION_BATCH_LIMITS.revisionReasonBytes);
  } else if (index > 0) {
    fail(`${path}.reason`, "later question-set revisions require an explicit reason");
  }
  if (index === 0 && value.reason !== undefined) {
    fail(`${path}.reason`, "the initial question-set revision cannot have a revision reason");
  }
  const questions = normalizeQuestions(
    value.questions,
    `${path}.questions`,
    value.source === "legacy_single",
  );
  if (value.source === "legacy_single" && (index !== 0 || questions.length !== 1)) {
    fail(path, "legacy_single is valid only for the initial one-question revision");
  }
  if (!isRecord(value.answers)) fail(`${path}.answers`, "must be a question-id keyed record");
  const questionById = new Map(questions.map((question) => [question.id, question] as const));
  for (const [questionId, answer] of Object.entries(value.answers)) {
    const question = questionById.get(questionId);
    if (question === undefined)
      fail(`${path}.answers.${questionId}`, "does not belong to this revision");
    assertAnswer(answer, question, `${path}.answers.${questionId}`, createdAt, batchUpdatedAt);
  }
}

function assertAnswer(
  value: unknown,
  question: QuestionBatchQuestionRecord,
  path: string,
  revisionCreatedAt: string,
  batchUpdatedAt: string,
): asserts value is QuestionBatchAnswerRecord {
  if (!isRecord(value) || value.questionId !== question.id || !isPositiveInteger(value.revision)) {
    fail(path, "answer identity or revision is invalid");
  }
  const selectedOptionId =
    value.selectedOptionId === undefined
      ? undefined
      : normalizeId(value.selectedOptionId, `${path}.selectedOptionId`);
  if (
    selectedOptionId !== undefined &&
    !question.options.some((option) => option.id === selectedOptionId)
  ) {
    fail(`${path}.selectedOptionId`, "does not identify a question option");
  }
  const notes =
    value.notes === undefined
      ? undefined
      : normalizeText(value.notes, `${path}.notes`, QUESTION_BATCH_LIMITS.notesBytes);
  if (notes !== undefined && !question.allowsNotes)
    fail(`${path}.notes`, "question does not allow notes");
  if (selectedOptionId === undefined && notes === undefined) {
    fail(path, "must choose an option or provide meaningful notes");
  }
  if (
    value.source !== undefined &&
    value.source !== "operator" &&
    value.source !== "configured_recommendation"
  )
    fail(`${path}.source`, "must be operator or configured_recommendation");
  if (
    value.source === "configured_recommendation" &&
    (question.recommendedOptionId === undefined ||
      selectedOptionId !== question.recommendedOptionId ||
      notes !== undefined)
  )
    fail(
      path,
      "configured recommendation answers must select the exact recommendation without notes",
    );
  const savedAt = normalizeTimestamp(value.savedAt, `${path}.savedAt`);
  if (
    timestampMs(savedAt) < timestampMs(revisionCreatedAt) ||
    timestampMs(savedAt) > timestampMs(batchUpdatedAt)
  ) {
    fail(`${path}.savedAt`, "must fall between revision creation and batch updatedAt");
  }
}

function prepareMutation(
  current: QuestionBatchRecord,
  expectedVersion: number,
  at: string,
): QuestionBatchRecord {
  assertQuestionBatchRecord(current);
  if (!isNonnegativeInteger(expectedVersion)) {
    throw new QuestionBatchTransitionError(
      "version_invalid",
      "expectedVersion must be a nonnegative integer",
    );
  }
  if (current.version !== expectedVersion) {
    throw new QuestionBatchVersionConflictError(expectedVersion, current.version);
  }
  const timestamp = normalizeTimestamp(at, "$.at");
  if (timestampMs(timestamp) < timestampMs(current.updatedAt)) {
    throw new QuestionBatchTransitionError(
      "timestamp_regression",
      "mutation timestamp predates updatedAt",
    );
  }
  if (current.version === Number.MAX_SAFE_INTEGER) {
    throw new QuestionBatchTransitionError(
      "version_exhausted",
      "question batch version is exhausted",
    );
  }
  return structuredClone(current);
}

function finishMutation(next: QuestionBatchRecord, at: string): void {
  next.version += 1;
  next.updatedAt = normalizeTimestamp(at, "$.at");
  assertQuestionBatchRecord(next);
}

function normalizeQuestions(
  value: unknown,
  path: string,
  allowLegacyOneOption: boolean,
): QuestionBatchQuestionRecord[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > QUESTION_BATCH_LIMITS.questions) {
    fail(path, `must contain 1-${QUESTION_BATCH_LIMITS.questions} ordered questions`);
  }
  const ids = new Set<string>();
  return value.map((question, index) => {
    const normalized = normalizeQuestion(question, `${path}[${index}]`, allowLegacyOneOption);
    if (ids.has(normalized.id))
      fail(`${path}[${index}].id`, "question ids must be unique within a revision");
    ids.add(normalized.id);
    return normalized;
  });
}

function normalizeQuestion(
  value: unknown,
  path: string,
  allowLegacyOneOption: boolean,
): QuestionBatchQuestionRecord {
  if (!isRecord(value)) fail(path, "question must be a record");
  const id = normalizeId(value.id, `${path}.id`);
  const prompt = normalizeText(value.prompt, `${path}.prompt`, QUESTION_BATCH_LIMITS.promptBytes);
  if (typeof value.allowsNotes !== "boolean") fail(`${path}.allowsNotes`, "must be a boolean");
  const minimumOptions = allowLegacyOneOption ? 1 : 2;
  if (
    !Array.isArray(value.options) ||
    value.options.length < minimumOptions ||
    value.options.length > QUESTION_BATCH_LIMITS.options
  ) {
    fail(
      `${path}.options`,
      `must contain ${minimumOptions}-${QUESTION_BATCH_LIMITS.options} options`,
    );
  }
  const optionIds = new Set<string>();
  const options = value.options.map((option, index) => {
    const optionPath = `${path}.options[${index}]`;
    if (!isRecord(option)) fail(optionPath, "option must be a record");
    const optionId = normalizeId(option.id, `${optionPath}.id`);
    if (optionIds.has(optionId))
      fail(`${optionPath}.id`, "option ids must be unique within a question");
    optionIds.add(optionId);
    return {
      id: optionId,
      label: normalizeText(
        option.label,
        `${optionPath}.label`,
        QUESTION_BATCH_LIMITS.optionLabelBytes,
      ),
      description: normalizeText(
        option.description,
        `${optionPath}.description`,
        QUESTION_BATCH_LIMITS.optionDescriptionBytes,
      ),
    };
  });
  const recommendedOptionId =
    value.recommendedOptionId === undefined
      ? undefined
      : normalizeId(value.recommendedOptionId, `${path}.recommendedOptionId`);
  if (recommendedOptionId !== undefined && !optionIds.has(recommendedOptionId)) {
    fail(`${path}.recommendedOptionId`, "must identify one of this question's options");
  }
  const impact =
    value.impact === undefined
      ? undefined
      : value.impact === "routine" || value.impact === "high_impact"
        ? value.impact
        : fail(`${path}.impact`, "must be routine or high_impact");
  return {
    id,
    prompt,
    options,
    allowsNotes: value.allowsNotes,
    ...(impact === undefined ? {} : { impact }),
    ...(recommendedOptionId === undefined ? {} : { recommendedOptionId }),
  };
}

function normalizeScope(
  scope: unknown,
  ticketId: unknown,
  path: string,
): Pick<QuestionBatchRecord, "scope" | "ticketId"> {
  if (scope === undefined) {
    if (ticketId !== undefined) fail(`${path}.ticketId`, "requires an explicit ticket scope");
    return {};
  }
  if (scope !== "run" && scope !== "ticket") {
    fail(`${path}.scope`, "must be run or ticket");
  }
  if (scope === "run") {
    if (ticketId !== undefined) fail(`${path}.ticketId`, "must be absent for run-scoped questions");
    return { scope };
  }
  if (ticketId === undefined) fail(`${path}.ticketId`, "is required for ticket-scoped questions");
  return { scope, ticketId: normalizeId(ticketId, `${path}.ticketId`) };
}

function normalizeAnswer(
  question: QuestionBatchQuestionRecord,
  input: SaveQuestionBatchAnswerInput,
  revision: number,
): QuestionBatchAnswerRecord {
  const selectedOptionId =
    input.selectedOptionId === undefined
      ? undefined
      : normalizeId(input.selectedOptionId, "$.selectedOptionId");
  if (
    selectedOptionId !== undefined &&
    !question.options.some((option) => option.id === selectedOptionId)
  ) {
    throw new QuestionBatchTransitionError(
      "option_missing",
      `selected option ${selectedOptionId} does not exist on question ${question.id}`,
    );
  }
  const notes = meaningful(input.notes)
    ? normalizeText(input.notes, "$.notes", QUESTION_BATCH_LIMITS.notesBytes)
    : undefined;
  if (notes !== undefined && !question.allowsNotes) {
    throw new QuestionBatchTransitionError(
      "notes_disallowed",
      `question ${question.id} does not allow notes`,
    );
  }
  if (selectedOptionId === undefined && notes === undefined) {
    throw new QuestionBatchTransitionError(
      "answer_empty",
      `question ${question.id} requires an option or meaningful notes`,
    );
  }
  return {
    questionId: question.id,
    revision,
    ...(selectedOptionId === undefined ? {} : { selectedOptionId }),
    ...(notes === undefined ? {} : { notes }),
    ...(input.source === undefined ? {} : { source: input.source }),
    savedAt: normalizeTimestamp(input.savedAt, "$.savedAt"),
  };
}

function requireQuestion(
  revision: QuestionBatchRevisionRecord,
  questionId: string,
): QuestionBatchQuestionRecord {
  const id = normalizeId(questionId, "$.questionId");
  const question = revision.questions.find((candidate) => candidate.id === id);
  if (question === undefined) {
    throw new QuestionBatchTransitionError(
      "question_missing",
      `question ${id} is not in the active revision`,
    );
  }
  return question;
}

function activeRevision(record: QuestionBatchRecord): QuestionBatchRevisionRecord {
  const revision = record.revisions[record.currentRevision - 1];
  if (revision === undefined || revision.revision !== record.currentRevision) {
    throw new QuestionBatchValidationError("$.currentRevision", "active revision is missing");
  }
  return revision;
}

function requireAllAnswered(record: QuestionBatchRecord): void {
  const revision = activeRevision(record);
  const missing = revision.questions
    .filter((question) => !hasAnswer(revision, question.id))
    .map((question) => question.id);
  if (missing.length > 0) {
    throw new QuestionBatchTransitionError(
      "answers_incomplete",
      `question batch still requires answers for: ${missing.join(", ")}`,
    );
  }
}

function requireStatus(
  record: QuestionBatchRecord,
  expected: QuestionBatchStatus,
  action: string,
): void {
  if (record.status !== expected) {
    throw new QuestionBatchTransitionError(
      "state",
      `cannot ${action} while question batch is ${record.status}`,
    );
  }
}

function allowed(reason: string): QuestionBatchCapability {
  return { allowed: true, reason };
}

function denied(reason: string): QuestionBatchCapability {
  return { allowed: false, reason };
}

function stateReason(status: QuestionBatchStatus, action: string): string {
  if (status === "pending_resume") return `Reopen the sealed batch before attempting to ${action}.`;
  return `A resolved batch cannot ${action}.`;
}

function normalizeId(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ||
    Buffer.byteLength(value, "utf8") > QUESTION_BATCH_LIMITS.idBytes
  ) {
    fail(path, "must be a safe nonempty identifier of at most 128 bytes");
  }
  return value;
}

function normalizePlanningRevision(value: unknown): number {
  if (!isNonnegativeInteger(value)) {
    fail("$.planningRevision", "must be a nonnegative safe integer");
  }
  return value;
}

function normalizeText(value: unknown, path: string, maximumBytes: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    !hasOnlyUnicodeScalars(value)
  ) {
    fail(path, `must be meaningful scalar Unicode text of at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > QUESTION_BATCH_LIMITS.timestampBytes ||
    !hasOnlyUnicodeScalars(value)
  ) {
    fail(path, "must be a bounded canonical ISO timestamp");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(path, "must be a canonical UTC ISO-8601 timestamp");
  }
  return value;
}

function timestampMs(value: string): number {
  return new Date(value).getTime();
}

function meaningful(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function hasAnswer(revision: QuestionBatchRevisionRecord, questionId: string): boolean {
  return Object.hasOwn(revision.answers, questionId);
}

function answerFor(
  revision: QuestionBatchRevisionRecord,
  questionId: string,
): QuestionBatchAnswerRecord | undefined {
  return hasAnswer(revision, questionId) ? revision.answers[questionId] : undefined;
}

function putAnswer(
  revision: QuestionBatchRevisionRecord,
  questionId: string,
  answer: QuestionBatchAnswerRecord,
): void {
  Object.defineProperty(revision.answers, questionId, {
    value: answer,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function fail(path: string, message: string): never {
  throw new QuestionBatchValidationError(path, message);
}
