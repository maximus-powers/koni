import { describe, expect, it } from "vitest";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { DynamicGraphContextSelector } from "../src/graph/context-selector.js";
import { GraphSchema, TypedGraph, createGraphContextualState } from "../src/graph/model.js";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import {
  createKoniManagedExtension,
  renderCompactionSummary,
  type KoniCompactionSnapshot,
  type KoniContextProvider,
} from "../src/pi/compaction.js";
import { fixtureLaunchSpec } from "./pi-managed-fixtures.js";

const snapshot: KoniCompactionSnapshot = {
  objective: "Implement the compiler-issued change.",
  plan: {
    architecture: "Keep authority effects outside Pi.",
    decisions: "Use one fresh linear session per attempt.",
    risk: "Reject ambient resources and stale grants.",
    verification: "Run focused checks and compile receipts.",
  },
  graphRefs: ["claim:authority", "gate:verification"],
  touchedFiles: ["src/example.ts"],
  receiptIds: ["receipt-one"],
  checkIds: ["check-unit"],
  unresolvedQuestions: ["Which compatibility fixture remains?"],
  nextAction: "Submit the terminal structured output.",
};

describe("Koni Pi compaction extension", () => {
  it("reissues an authenticated planning-synthesis policy ahead of conversation history", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-synthesis",
    });
    const provider = fixtureContextProvider(spec, snapshot);
    const base = provider.loadBoundContext.bind(provider);
    const content = "Stop repository discovery and submit the reviewable plan.";
    provider.loadBoundContext = async (requested) => ({
      ...(await base(requested)),
      runtimePolicy: {
        protocol: "koni.runtime-policy-context.v1",
        kind: "planning_synthesis",
        sha256: rawSha256(content),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        content,
      },
    });
    const handlers = await loadHandlers(
      createKoniManagedExtension({ spec, contextProvider: provider }),
    );
    const existing = { role: "user", content: [{ type: "text", text: "existing history" }] };

    const context = await handlers.get("context")!({ type: "context", messages: [existing] }, {});
    expect(context.messages).toHaveLength(3);
    expect(context.messages[1].content[0].text).toContain("<koni_runtime_policy");
    expect(context.messages[1].content[0].text).toContain(content);
    expect(context.messages[2]).toBe(existing);

    provider.loadBoundContext = async (requested) => ({
      ...(await base(requested)),
      runtimePolicy: {
        protocol: "koni.runtime-policy-context.v1",
        kind: "planning_synthesis",
        sha256: rawSha256("different"),
        sizeBytes: Buffer.byteLength(content, "utf8"),
        content,
      },
    });
    await expect(handlers.get("context")!({ type: "context", messages: [] }, {})).rejects.toThrow(
      /runtime policy context.*unauthenticated/u,
    );
  });

  it("creates structured checkpoints and reissues exact authoritative context", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const provider = fixtureContextProvider(spec, snapshot);
    const notices: string[] = [];
    const handlers = await loadHandlers(
      createKoniManagedExtension({
        spec,
        contextProvider: provider,
        onNotice: (notice) => notices.push(notice.type),
      }),
    );

    const context = await handlers.get("context")!({ type: "context", messages: [] }, {});
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].content[0].text).toContain("<koni_authoritative_context");
    expect(context.messages[0].content[0].text).toContain("authoritative context");

    const compacted = await handlers.get("session_before_compact")!(
      {
        type: "session_before_compact",
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
        branchEntries: [],
        preparation: {
          firstKeptEntryId: "entry-one",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 12_000,
          fileOps: { read: [], modified: [] },
          settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1_000 },
        },
      },
      {},
    );
    expect(compacted.compaction.summary).toContain("# Koni attempt checkpoint");
    expect(compacted.compaction.summary).toContain("## Files read or modified");
    expect(compacted.compaction.details).toMatchObject({
      protocol: "koni.compaction.v1",
      authorizationId: "authorization-one",
      contextReissueRequired: true,
      contextHash: spec.authority.authoritativeContextHash,
    });
    expect(await handlers.get("session_before_fork")!({}, {})).toEqual({ cancel: true });
    expect(await handlers.get("session_before_tree")!({}, {})).toEqual({ cancel: true });
    expect(await handlers.get("session_before_switch")!({}, {})).toEqual({ cancel: true });
    expect(notices).toEqual([
      "context_reissued",
      "compaction_created",
      "linear_navigation_denied",
      "linear_navigation_denied",
      "linear_navigation_denied",
    ]);
  });

  it("injects a separately hashed freshly selected graph envelope on every context event", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-dynamic-context",
    });
    const graph = new TypedGraph(new GraphSchema({ nodeTypes: [], edgeTypes: [] }));
    const contextual = createGraphContextualState("run-root-dynamic");
    const selector = new DynamicGraphContextSelector();
    const dynamic = selector.select({
      cacheKey: canonicalHash([0, graph.hash, contextual.hash]),
      identity: {
        ...spec.identity,
        personaId: spec.persona.id,
        grantHash: spec.authority.grantHash,
        launchSpecHash: spec.specHash,
        generation: spec.authority.generation,
      },
      objective: "Inject only transient graph context.",
      runUpdatedAt: "2026-01-01T00:00:00.000Z",
      semanticRevision: 0,
      semanticHash: graph.hash,
      contextual,
      graph,
      nodePaths: {},
      ticketTargetIds: [],
      stepTargetIds: [],
      scopedPaths: ["."],
      compatibleAttemptIds: new Set([spec.identity.attemptId]),
      abandonedAttemptIds: new Set(),
      maxInputTokens: spec.budgets.tokens.maxInput,
    });
    const provider = fixtureContextProvider(spec, snapshot);
    let selections = 0;
    provider.loadDynamicGraphContext = async () => {
      selections += 1;
      return dynamic;
    };
    const handlers = await loadHandlers(
      createKoniManagedExtension({ spec, contextProvider: provider }),
    );

    const first = await handlers.get("context")!({ type: "context", messages: [] }, {});
    const second = await handlers.get("context")!({ type: "context", messages: [] }, {});
    expect(selections).toBe(2);
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0].content[0].text).toContain(`<koni_authoritative_context`);
    expect(first.messages[1].content[0].text).toContain(`<koni_dynamic_graph_context`);
    expect(first.messages[1].content[0].text).toContain(`envelope_hash="${dynamic.envelopeHash}"`);
    expect(second.messages[1].content[0].text).toContain(dynamic.content);

    await handlers.get("session_before_compact")!(
      {
        type: "session_before_compact",
        reason: "threshold",
        willRetry: false,
        signal: new AbortController().signal,
        branchEntries: [],
        preparation: {
          firstKeptEntryId: "entry-dynamic",
          messagesToSummarize: [],
          turnPrefixMessages: [],
          isSplitTurn: false,
          tokensBefore: 1_000,
          fileOps: { read: [], modified: [] },
          settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
        },
      },
      {},
    );
    const postCompaction = await handlers.get("context")!({ type: "context", messages: [] }, {});
    expect(selections).toBe(3);
    expect(postCompaction.messages[1].content[0].text).toContain(dynamic.content);
  });

  it("fails closed when authoritative context or compaction metadata drifts", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const provider = fixtureContextProvider(spec, { ...snapshot, objective: "" });
    provider.loadBoundContext = async (value) => ({
      ...(await fixtureContextProvider(value, snapshot).loadBoundContext(value)),
      stateHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const handlers = await loadHandlers(
      createKoniManagedExtension({ spec, contextProvider: provider }),
    );
    await expect(handlers.get("context")!({ type: "context", messages: [] }, {})).rejects.toThrow(
      "does not match the immutable launch binding",
    );
    const compacted = await handlers.get("session_before_compact")!(
      {
        type: "session_before_compact",
        reason: "manual",
        willRetry: false,
        signal: new AbortController().signal,
        branchEntries: [],
        preparation: { firstKeptEntryId: "entry", tokensBefore: 1 },
      },
      {},
    );
    expect(compacted).toEqual({ cancel: true });
  });

  it("runs the pre-provider guard before every authoritative context projection", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-provider-guard",
    });
    let guards = 0;
    const handlers = await loadHandlers(
      createKoniManagedExtension({
        spec,
        contextProvider: fixtureContextProvider(spec, snapshot),
        beforeProviderRequest() {
          guards += 1;
          if (guards === 2) throw new Error("attempt budget exhausted before provider request");
        },
      }),
    );

    await expect(
      handlers.get("context")!({ type: "context", messages: [] }, {}),
    ).resolves.toBeDefined();
    await expect(handlers.get("context")!({ type: "context", messages: [] }, {})).rejects.toThrow(
      "attempt budget exhausted before provider request",
    );
    expect(guards).toBe(2);
  });

  it("renders explicit human-readable plan domains and durable reference classes", () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const rendered = renderCompactionSummary(spec, snapshot);
    expect(rendered).toContain("### Architecture");
    expect(rendered).toContain("- Branch: initial (epoch 0)");
    expect(rendered).toContain("### Decisions");
    expect(rendered).toContain("### Risk");
    expect(rendered).toContain("### Verification");
    expect(rendered).toContain("## Receipts");
    expect(rendered).toContain("## Checks");
    expect(rendered).toContain("## Unresolved questions");
  });

  it("bounds the complete structured checkpoint rather than only each field", () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const largeItem = "x".repeat(64 * 1024);
    const oversized: KoniCompactionSnapshot = {
      ...snapshot,
      graphRefs: Array.from({ length: 70 }, () => largeItem),
    };
    expect(() => renderCompactionSummary(spec, oversized)).toThrow("structured compaction exceeds");
  });
});

type Handler = (event: any, context: any) => any;

async function loadHandlers(extension: InlineExtension): Promise<Map<string, Handler>> {
  const handlers = new Map<string, Handler>();
  const api = {
    on(type: string, handler: Handler) {
      handlers.set(type, handler);
    },
  } as unknown as ExtensionAPI;
  const factory = typeof extension === "function" ? extension : extension.factory;
  await factory(api);
  return handlers;
}

function fixtureContextProvider(
  spec: ReturnType<typeof fixtureLaunchSpec>,
  compact: KoniCompactionSnapshot,
): KoniContextProvider {
  return {
    async loadBoundContext() {
      return {
        runId: spec.identity.runId,
        ticketId: spec.identity.ticketId,
        stepId: spec.identity.stepId,
        attemptId: spec.identity.attemptId,
        sessionId: spec.identity.sessionId,
        grantId: spec.authority.grantId,
        generation: spec.authority.generation,
        epoch: spec.authority.epoch,
        stateHash: spec.authority.expectedStateHash,
        contextHash: spec.authority.authoritativeContextHash,
        content: "authoritative context",
      };
    },
    async loadCompactionSnapshot() {
      return compact;
    },
    async authorizeCompaction() {
      return { authorizationId: "authorization-one" };
    },
    async acquireRecoveryClaim() {
      return {
        protocol: "koni.attempt-recovery-claim.v1",
        claimId: `claim-${spec.identity.attemptId}`,
        state: {
          protocol: "koni.attempt-recovery.v1",
          specHash: spec.specHash,
          ...spec.identity,
          grantHash: spec.authority.grantHash,
          generation: spec.authority.generation,
          epoch: spec.authority.epoch,
          stateHash: spec.authority.expectedStateHash,
          status: "continue",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
          authorizedMessages: [],
          authorizedToolResults: [],
          authorizedCompactions: [],
        },
        async release() {},
      };
    },
  };
}
