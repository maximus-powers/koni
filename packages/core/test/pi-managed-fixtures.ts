import { Type, type TSchema } from "typebox";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import {
  AGENT_LAUNCH_SPEC_PROTOCOL,
  computeLaunchResourceSetHash,
  createAgentLaunchSpec,
  type AgentLaunchSpec,
  type AgentAttemptLineage,
  type LaunchResource,
} from "../src/pi/launch-spec.js";
import type { AuthorityBackedTool } from "../src/pi/managed-session.js";
import {
  KONI_TOOL_RECEIPT_PROTOCOL,
  koniToolSchemaHash,
  koniToolMaxResultBytes,
  renderKoniToolReceipt,
  type KoniToolReceipt,
} from "../src/pi/tool-catalog.js";

export const TERMINAL_TOOL_NAME = "koni_submit_output";
export const TERMINAL_OUTPUT_SCHEMA = Type.Object(
  { result: Type.String() },
  { additionalProperties: false },
);
export const TOOL_SCHEMA_HASH = canonicalHash(TERMINAL_OUTPUT_SCHEMA);
export const OUTPUT_SCHEMA_HASH = canonicalHash(TERMINAL_OUTPUT_SCHEMA);
/** Exact secret-free descriptor seal for Pi 0.80.10's built-in gpt-5.6-terra catalog entry. */
export const FIXTURE_MODEL_CATALOG_SHA256 =
  "sha256:9a7e2648bd9e90f23733d681fa1188c763e7d8864c3f69a825c17af89421e37f" as const;

export function fixtureTool(): AuthorityBackedTool {
  const acceptedReceipt = (): KoniToolReceipt => ({
    protocol: KONI_TOOL_RECEIPT_PROTOCOL,
    receiptId: "fixture-receipt",
    outcome: "accepted",
    summary: "submitted",
  });
  const execute: AuthorityBackedTool["execute"] = async () => ({
    content: [{ type: "text", text: renderKoniToolReceipt(acceptedReceipt()) }],
    details: acceptedReceipt(),
    terminate: true,
  });
  const reject: AuthorityBackedTool["reject"] = async (_callId, _args, rejection) => {
    const receipt: KoniToolReceipt = {
      protocol: KONI_TOOL_RECEIPT_PROTOCOL,
      receiptId: "fixture-rejection",
      outcome: "rejected",
      code: rejection.code,
      summary: rejection.summary,
    };
    return {
      content: [{ type: "text", text: renderKoniToolReceipt(receipt) }],
      details: receipt,
    };
  };
  return {
    name: TERMINAL_TOOL_NAME,
    schemaHash: TOOL_SCHEMA_HASH,
    maxResultBytes: koniToolMaxResultBytes("koni_submit_output"),
    terminalOutputSchema: TERMINAL_OUTPUT_SCHEMA,
    terminalOutputSchemaHash: OUTPUT_SCHEMA_HASH,
    execute,
    reject,
    definition: {
      name: TERMINAL_TOOL_NAME,
      label: "Submit output",
      description: "Submit the terminal structured output to Koni authority",
      parameters: TERMINAL_OUTPUT_SCHEMA,
      executionMode: "sequential",
      async execute() {
        return execute("fixture-call", {});
      },
    },
  };
}

export function fixtureLaunchSpec(options: {
  cwd: string;
  sessionDirectory: string;
  runId?: string;
  ticketId?: string;
  stepId?: string;
  attemptId?: string;
  sessionId?: string;
  personaId?: string;
  resources?: readonly LaunchResource[];
  maxAllTokens?: number;
  lineage?: AgentAttemptLineage;
  terminalOutputSchema?: TSchema;
}): Readonly<AgentLaunchSpec> {
  const resources = options.resources ?? [];
  const systemPrompt = "You are a contained Koni worker. Use only issued tools and context.";
  const initialPrompt = "Complete the exact compiler-issued ticket step, then submit output.";
  const terminalOutputSchema = options.terminalOutputSchema ?? TERMINAL_OUTPUT_SCHEMA;
  return createAgentLaunchSpec({
    protocol: AGENT_LAUNCH_SPEC_PROTOCOL,
    issuedAt: "2026-07-16T00:00:00.000Z",
    identity: {
      runId: options.runId ?? "run-one",
      ticketId: options.ticketId ?? "ticket-one",
      stepId: options.stepId ?? "step-one",
      attemptId: options.attemptId ?? "attempt-one",
      sessionId: options.sessionId ?? "session-one",
    },
    lineage: options.lineage ?? { branchEpoch: 0, reason: "initial" },
    authority: {
      grantId: "grant-one",
      grantHash: rawSha256("grant"),
      generation: 1,
      epoch: 1,
      expectedRevision: 3,
      expectedStateHash: rawSha256("state"),
      authoritativeContextHash: rawSha256("authoritative context"),
    },
    workspace: {
      cwd: options.cwd,
      sessionDirectory: options.sessionDirectory,
    },
    persona: {
      id: options.personaId ?? "worker",
      systemPrompt,
      systemPromptHash: rawSha256(systemPrompt),
      initialPrompt,
      initialPromptHash: rawSha256(initialPrompt),
    },
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-terra",
      api: "openai-codex-responses",
      catalogMaxTokens: 128_000,
      catalogSha256: FIXTURE_MODEL_CATALOG_SHA256,
      thinkingLevel: "high",
    },
    tools: [
      {
        name: TERMINAL_TOOL_NAME,
        schemaHash: koniToolSchemaHash("koni_submit_output", terminalOutputSchema),
        executionMode: "sequential",
        maxResultBytes: koniToolMaxResultBytes("koni_submit_output"),
      },
    ],
    resources: {
      setHash: computeLaunchResourceSetHash(resources),
      entries: resources,
    },
    budgets: {
      tokens: {
        maxInput: options.maxAllTokens ?? 10_000,
        maxOutput: options.maxAllTokens ?? 10_000,
        maxCacheRead: options.maxAllTokens ?? 10_000,
        maxCacheWrite: options.maxAllTokens ?? 10_000,
        maxNew: options.maxAllTokens ?? 10_000,
        maxAll: options.maxAllTokens ?? 10_000,
        providerOutputHeadroom: 128_000,
      },
      retries: { maxProviderRetries: 0, baseDelayMs: 1 },
      transcript: { maxBytes: 64 * 1024 * 1024 },
    },
    terminal: {
      toolName: TERMINAL_TOOL_NAME,
      outputSchemaHash: canonicalHash(terminalOutputSchema),
      maxOutputBytes: 64 * 1024,
    },
  });
}

export function fixtureResource(
  kind: LaunchResource["kind"],
  id: string,
  relativePath: string,
  content: string,
): LaunchResource {
  return {
    kind,
    id,
    relativePath,
    content,
    sha256: rawSha256(content),
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}
