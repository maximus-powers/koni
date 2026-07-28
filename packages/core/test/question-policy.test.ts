import { describe, expect, it } from "vitest";
import {
  QuestionPolicyError,
  presentationQuestionPolicy,
  questionPolicyDisposition,
  semanticQuestionPolicy,
} from "../src/state/question-policy.js";

const routine = {
  id: "routine",
  impact: "routine" as const,
  recommendedOptionId: "recommended",
  options: [{ id: "recommended" }, { id: "alternative" }],
};

const highImpact = {
  id: "high-impact",
  impact: "high_impact" as const,
  recommendedOptionId: "safe",
  options: [{ id: "safe" }, { id: "fast" }],
};

describe("question policy disposition", () => {
  it("durably selects only configured recommendations in autonomous mode", () => {
    expect(questionPolicyDisposition("autonomous", [routine, highImpact])).toEqual({
      policy: "autonomous",
      automaticAnswers: [
        {
          questionId: "routine",
          selectedOptionId: "recommended",
          reason: "configured_recommendation",
        },
        {
          questionId: "high-impact",
          selectedOptionId: "safe",
          reason: "configured_recommendation",
        },
      ],
      pendingQuestionIds: [],
      pausesAttempt: false,
    });
  });

  it("auto-resolves routine questions and pauses for high-impact questions", () => {
    expect(questionPolicyDisposition("high_impact_only", [routine, highImpact])).toEqual({
      policy: "high_impact_only",
      automaticAnswers: [
        {
          questionId: "routine",
          selectedOptionId: "recommended",
          reason: "configured_recommendation",
        },
      ],
      pendingQuestionIds: ["high-impact"],
      pausesAttempt: true,
    });
  });

  it("pauses for every valid interactive question", () => {
    expect(questionPolicyDisposition("interactive", [routine, highImpact])).toEqual({
      policy: "interactive",
      automaticAnswers: [],
      pendingQuestionIds: ["routine", "high-impact"],
      pausesAttempt: true,
    });
  });

  it("maps the three compact selectors without losing semantic policy", () => {
    expect(presentationQuestionPolicy("autonomous")).toBe("none");
    expect(presentationQuestionPolicy("high_impact_only")).toBe("some");
    expect(presentationQuestionPolicy("interactive")).toBe("many");
    expect(semanticQuestionPolicy("none")).toBe("autonomous");
    expect(semanticQuestionPolicy("some")).toBe("high_impact_only");
    expect(semanticQuestionPolicy("many")).toBe("interactive");
  });

  it.each([
    {
      name: "missing recommendation",
      question: { ...routine, recommendedOptionId: "missing" },
      code: "question_recommendation",
    },
    {
      name: "duplicate option",
      question: { ...routine, options: [{ id: "same" }, { id: "same" }] },
      code: "question_options",
    },
    {
      name: "one option",
      question: { ...routine, options: [{ id: "recommended" }] },
      code: "question_options",
    },
    {
      name: "missing impact",
      question: { ...routine, impact: undefined as never },
      code: "question_impact",
    },
  ])("rejects $name before a question can pause a session", ({ question, code }) => {
    try {
      questionPolicyDisposition("interactive", [question]);
      throw new Error("expected question policy validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(QuestionPolicyError);
      expect((error as QuestionPolicyError).code).toBe(code);
    }
  });
});
