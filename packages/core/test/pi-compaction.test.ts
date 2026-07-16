import { describe, expect, it } from "vitest";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
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
  it("creates structured checkpoints and reissues exact authoritative context", async () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const provider = fixtureContextProvider(spec, snapshot);
    const notices: string[] = [];
    const handlers = await loadHandlers(createKoniManagedExtension({
      spec,
      contextProvider: provider,
      onNotice: (notice) => notices.push(notice.type),
    }));

    const context = await handlers.get("context")!({ type: "context", messages: [] }, {});
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].content[0].text).toContain("<koni_authoritative_context");
    expect(context.messages[0].content[0].text).toContain("authoritative context");

    const compacted = await handlers.get("session_before_compact")!({
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
    }, {});
    expect(compacted.compaction.summary).toContain("# Koni attempt checkpoint");
    expect(compacted.compaction.summary).toContain("## Files read or modified");
    expect(compacted.compaction.details).toMatchObject({
      protocol: "koni.compaction.v1",
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
    const handlers = await loadHandlers(createKoniManagedExtension({ spec, contextProvider: provider }));
    await expect(handlers.get("context")!({ type: "context", messages: [] }, {})).rejects.toThrow(
      "does not match the immutable launch binding",
    );
    const compacted = await handlers.get("session_before_compact")!({
      type: "session_before_compact",
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
      branchEntries: [],
      preparation: { firstKeptEntryId: "entry", tokensBefore: 1 },
    }, {});
    expect(compacted).toEqual({ cancel: true });
  });

  it("renders explicit human-readable plan domains and durable reference classes", () => {
    const spec = fixtureLaunchSpec({
      cwd: "/tmp/koni-workspace",
      sessionDirectory: "/tmp/koni-sessions/attempt-one",
    });
    const rendered = renderCompactionSummary(spec, snapshot);
    expect(rendered).toContain("### Architecture");
    expect(rendered).toContain("### Decisions");
    expect(rendered).toContain("### Risk");
    expect(rendered).toContain("### Verification");
    expect(rendered).toContain("## Receipts");
    expect(rendered).toContain("## Checks");
    expect(rendered).toContain("## Unresolved questions");
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
  };
}
