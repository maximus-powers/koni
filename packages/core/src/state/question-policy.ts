export const QUESTION_POLICIES = ["autonomous", "high_impact_only", "interactive"] as const;

export type QuestionPolicy = (typeof QUESTION_POLICIES)[number];
export type QuestionImpact = "routine" | "high_impact";

export interface QuestionPolicyOption {
  readonly id: string;
}

export interface QuestionPolicyInput {
  readonly id: string;
  readonly options: readonly QuestionPolicyOption[];
  readonly recommendedOptionId: string;
  readonly impact: QuestionImpact;
}

export interface AutomaticQuestionAnswer {
  readonly questionId: string;
  readonly selectedOptionId: string;
  readonly reason: "configured_recommendation";
}

export interface QuestionPolicyDisposition {
  readonly policy: QuestionPolicy;
  readonly automaticAnswers: readonly AutomaticQuestionAnswer[];
  readonly pendingQuestionIds: readonly string[];
  readonly pausesAttempt: boolean;
}

/**
 * Project one compiler-authored question set through its pinned run policy.
 *
 * This function makes no state transition and never invents an answer. Every automatic answer is
 * the question's one explicit recommendation; malformed question contracts fail before a durable
 * question batch or waiter can be created.
 */
export function questionPolicyDisposition(
  policy: QuestionPolicy,
  questions: readonly QuestionPolicyInput[],
): QuestionPolicyDisposition {
  if (!QUESTION_POLICIES.includes(policy)) {
    throw new QuestionPolicyError("policy", `unsupported question policy ${String(policy)}`);
  }
  if (questions.length < 1 || questions.length > 8) {
    throw new QuestionPolicyError(
      "question_count",
      "a question batch must contain one to eight questions",
    );
  }

  const ids = new Set<string>();
  const automaticAnswers: AutomaticQuestionAnswer[] = [];
  const pendingQuestionIds: string[] = [];
  for (const question of questions) {
    if (!safeId(question.id) || ids.has(question.id)) {
      throw new QuestionPolicyError(
        "question_identity",
        "question ids must be unique safe identifiers",
      );
    }
    ids.add(question.id);
    if (question.options.length < 2 || question.options.length > 8) {
      throw new QuestionPolicyError(
        "question_options",
        `question ${question.id} must contain two to eight options`,
      );
    }
    const optionIds = question.options.map((option) => option.id);
    if (optionIds.some((id) => !safeId(id)) || new Set(optionIds).size !== optionIds.length) {
      throw new QuestionPolicyError(
        "question_options",
        `question ${question.id} option ids must be unique and safe`,
      );
    }
    if (!optionIds.includes(question.recommendedOptionId)) {
      throw new QuestionPolicyError(
        "question_recommendation",
        `question ${question.id} recommendation must name exactly one configured option`,
      );
    }
    if (question.impact !== "routine" && question.impact !== "high_impact") {
      throw new QuestionPolicyError(
        "question_impact",
        `question ${question.id} impact must be routine or high_impact`,
      );
    }

    const automatic =
      policy === "autonomous" || (policy === "high_impact_only" && question.impact === "routine");
    if (automatic) {
      automaticAnswers.push({
        questionId: question.id,
        selectedOptionId: question.recommendedOptionId,
        reason: "configured_recommendation",
      });
    } else {
      pendingQuestionIds.push(question.id);
    }
  }

  return Object.freeze({
    policy,
    automaticAnswers: Object.freeze(automaticAnswers.map((answer) => Object.freeze(answer))),
    pendingQuestionIds: Object.freeze([...pendingQuestionIds]),
    pausesAttempt: pendingQuestionIds.length > 0,
  });
}

export function presentationQuestionPolicy(policy: QuestionPolicy): "none" | "some" | "many" {
  if (policy === "autonomous") return "none";
  if (policy === "high_impact_only") return "some";
  if (policy === "interactive") return "many";
  throw new QuestionPolicyError("policy", `unsupported question policy ${String(policy)}`);
}

export function semanticQuestionPolicy(presentation: "none" | "some" | "many"): QuestionPolicy {
  if (presentation === "none") return "autonomous";
  if (presentation === "some") return "high_impact_only";
  if (presentation === "many") return "interactive";
  throw new QuestionPolicyError(
    "policy",
    `unsupported question presentation ${String(presentation)}`,
  );
}

export class QuestionPolicyError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "QuestionPolicyError";
    this.code = code;
  }
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}
