import { describe, expect, it } from "vitest";
import { canonicalHash } from "../src/shared/canonical.js";
import {
  deriveProviderSettlement,
  deriveProviderSettlements,
  estimateProviderInputTokens,
  isSupportedStoredProviderInputEstimate,
  providerPayloadIdentity,
  providerApiHasSupportedOutputCap,
  serializedProviderOutputCap,
} from "../src/pi/provider-request.js";
import type { PiSessionEntry } from "../src/pi/session-transcript.js";

describe("Pi-aligned provider input estimation", () => {
  it("uses UTF-8 wire bytes with a provider-safe bytes/2 bound and framing reserve", () => {
    expect(estimateProviderInputTokens(140_050)).toBe(74_121);
    const identity = providerPayloadIdentity({ input: "SPICED" });
    expect(identity.prospectiveInputTokens).toBe(
      Math.ceil(identity.payloadSizeBytes / 2) + 4_096,
    );
  });

  it("reserves above Claude's observed live tokenization on real payload mixes", () => {
    // Live regressions from anthropic-messages runs:
    // - prose/tool-schema payload: 79,139 bytes settled at 25,565 prompt tokens (~3.1 bytes/token),
    //   exceeding the original bytes/4 reservation of 23,881 and failing the run closed.
    // - code-heavy payload (TSX tool results): 182,488 bytes settled at 67,579 prompt tokens
    //   (~2.7 bytes/token), exceeding the interim bytes/3 reservation of 64,926.
    expect(estimateProviderInputTokens(79_139)).toBeGreaterThanOrEqual(25_565);
    expect(estimateProviderInputTokens(182_488)).toBeGreaterThanOrEqual(67_579);
  });

  it("accepts only current or pre-migration estimates while reading durable ledgers", () => {
    expect(isSupportedStoredProviderInputEstimate(140_050, 74_121)).toBe(true);
    expect(isSupportedStoredProviderInputEstimate(140_050, 50_780)).toBe(true);
    expect(isSupportedStoredProviderInputEstimate(140_050, 39_109)).toBe(true);
    expect(isSupportedStoredProviderInputEstimate(140_050, 144_146)).toBe(true);
    expect(isSupportedStoredProviderInputEstimate(140_050, 39_108)).toBe(false);
  });
});

describe("Pi provider settlement projection", () => {
  it("requires complete internally consistent canonical usage", () => {
    expect(() => deriveProviderSettlement([baseline(), assistant({ usage: undefined })], "baseline"))
      .toThrow(/missing its canonical usage/u);
    expect(() => deriveProviderSettlement([
      baseline(),
      assistant({ usage: usage({ totalTokens: -1 }) }),
    ], "baseline")).toThrow(/invalid totalTokens/u);
    expect(() => deriveProviderSettlement([
      baseline(),
      assistant({ usage: usage({ output: -1, totalTokens: 16 }) }),
    ], "baseline")).toThrow(/invalid output/u);
  });

  it.each(["error", "aborted"])("retains the reservation for a %s assistant", (stopReason) => {
    expect(() => deriveProviderSettlement([
      baseline(),
      assistant({ stopReason, usage: usage() }),
    ], "baseline")).toThrow(/trustworthy terminal response boundary/u);
  });

  it.each(["stop", "toolUse", "length"])("settles a complete %s response", (stopReason) => {
    const entry = assistant({ stopReason, usage: usage() });
    expect(deriveProviderSettlement([baseline(), entry], "baseline")).toEqual({
      assistantEntryId: "assistant-one",
      assistantEntrySha256: canonicalHash(entry),
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        newTokens: 15,
        allTokens: 18,
      },
    });
  });

  it("treats provider-raw totalTokens as observational when all components are complete", () => {
    expect(deriveProviderSettlement([
      baseline(),
      assistant({ usage: usage({ totalTokens: 15 }) }),
    ], "baseline")?.usage.allTokens).toBe(18);
  });

  it("re-derives an earlier response within the next durable reservation baseline", () => {
    const first = assistant({ usage: usage() });
    const secondBaseline = {
      type: "message",
      id: "baseline-two",
      parentId: first.id,
      message: { role: "toolResult" },
    } as PiSessionEntry;
    const second = assistant({
      id: "assistant-two",
      parentId: "baseline-two",
      usage: usage({ input: 20, output: 7, cacheRead: 3, cacheWrite: 2, totalTokens: 32 }),
    });
    expect(deriveProviderSettlement(
      [baseline(), first, secondBaseline, second],
      "baseline",
      "baseline-two",
    )?.assistantEntryId).toBe("assistant-one");
  });

  it("changes the settlement digest when assistant content or tool calls are altered", () => {
    const original = assistant({ usage: usage() });
    const altered = assistant({
      usage: usage(),
      content: [{ type: "toolCall", id: "call", name: "koni_submit_output", arguments: { result: "altered" } }],
    });
    expect(deriveProviderSettlement([baseline(), original], "baseline")?.assistantEntrySha256)
      .not.toBe(deriveProviderSettlement([baseline(), altered], "baseline")?.assistantEntrySha256);
  });

  it("re-derives a long ordered ledger in one bounded transcript traversal", () => {
    const rounds = 2_000;
    const entries: PiSessionEntry[] = [];
    const boundaries: Array<{ baselineEntryId: string; nextBaselineEntryId?: string }> = [];
    for (let index = 0; index < rounds; index += 1) {
      const baselineId = `baseline-${index}`;
      const assistantId = `assistant-${index}`;
      entries.push({
        type: "message",
        id: baselineId,
        parentId: index === 0 ? null : `assistant-${index - 1}`,
        message: { role: "user" },
      } as PiSessionEntry);
      entries.push(assistant({
        id: assistantId,
        parentId: baselineId,
        usage: usage(),
      }));
      boundaries.push({
        baselineEntryId: baselineId,
        ...(index + 1 === rounds ? {} : { nextBaselineEntryId: `baseline-${index + 1}` }),
      });
    }
    const settlements = deriveProviderSettlements(entries, boundaries);
    expect(settlements).toHaveLength(rounds);
    expect(settlements[0]?.assistantEntryId).toBe("assistant-0");
    expect(settlements.at(-1)?.assistantEntryId).toBe(`assistant-${rounds - 1}`);
  });
});

describe("pinned Pi provider output-cap projection", () => {
  it.each([
    ["openai-completions", { max_tokens: 4_096 }, "/max_tokens"],
    ["openai-completions", { max_completion_tokens: 4_096 }, "/max_completion_tokens"],
    ["openai-responses", { max_output_tokens: 4_096 }, "/max_output_tokens"],
    ["azure-openai-responses", { max_output_tokens: 4_096 }, "/max_output_tokens"],
    ["anthropic-messages", { max_tokens: 4_096 }, "/max_tokens"],
    ["google-generative-ai", { config: { maxOutputTokens: 4_096 } }, "/config/maxOutputTokens"],
    ["google-vertex", { config: { maxOutputTokens: 4_096 } }, "/config/maxOutputTokens"],
    ["bedrock-converse-stream", { inferenceConfig: { maxTokens: 4_096 } }, "/inferenceConfig/maxTokens"],
    ["mistral-conversations", { maxTokens: 4_096 }, "/maxTokens"],
    ["pi-messages", { options: { maxTokens: 4_096 } }, "/options/maxTokens"],
  ] as const)("reads Pi 0.80.10 %s payload at its exact adapter path", (api, payload, expectedPath) => {
    expect(providerApiHasSupportedOutputCap(api)).toBe(true);
    expect(serializedProviderOutputCap(api, payload)).toEqual({ path: expectedPath, value: 4_096 });
  });

  it("keeps Codex uncapped and rejects an invented field", () => {
    expect(providerApiHasSupportedOutputCap("openai-codex-responses")).toBe(false);
    expect(serializedProviderOutputCap("openai-codex-responses", { model: "gpt-5.6-terra" })).toBeUndefined();
    expect(() => serializedProviderOutputCap(
      "openai-codex-responses",
      { model: "gpt-5.6-terra", max_output_tokens: 4_096 },
    )).toThrow(/unsupported max_output_tokens/u);
  });
});

function baseline(): PiSessionEntry {
  return {
    type: "message",
    id: "baseline",
    parentId: null,
    message: { role: "user", content: [{ type: "text", text: "work" }] },
  } as PiSessionEntry;
}

function assistant(options: {
  id?: string;
  parentId?: string;
  stopReason?: string;
  usage?: Record<string, unknown> | undefined;
  content?: unknown[];
}): PiSessionEntry {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: options.content ?? [{ type: "text", text: "complete" }],
    stopReason: options.stopReason ?? "stop",
  };
  if (options.usage !== undefined) message.usage = options.usage;
  return {
    type: "message",
    id: options.id ?? "assistant-one",
    parentId: options.parentId ?? "baseline",
    message,
  } as PiSessionEntry;
}

function usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 18,
    ...overrides,
  };
}
