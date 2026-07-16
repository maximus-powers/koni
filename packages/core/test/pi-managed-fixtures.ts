import { Type } from "typebox";
import { rawSha256 } from "../src/shared/canonical.js";
import {
  AGENT_LAUNCH_SPEC_PROTOCOL,
  computeLaunchResourceSetHash,
  createAgentLaunchSpec,
  type AgentLaunchSpec,
  type LaunchResource,
} from "../src/pi/launch-spec.js";
import type { AuthorityBackedTool } from "../src/pi/managed-session.js";

export const TERMINAL_TOOL_NAME = "koni_submit_output";
export const TOOL_SCHEMA_HASH = rawSha256("terminal-input-schema-v1");
export const OUTPUT_SCHEMA_HASH = rawSha256("terminal-output-schema-v1");

export function fixtureTool(): AuthorityBackedTool {
  return {
    name: TERMINAL_TOOL_NAME,
    schemaHash: TOOL_SCHEMA_HASH,
    terminalOutputSchemaHash: OUTPUT_SCHEMA_HASH,
    definition: {
      name: TERMINAL_TOOL_NAME,
      label: "Submit output",
      description: "Submit the terminal structured output to Koni authority",
      parameters: Type.Object({ result: Type.String() }),
      executionMode: "sequential",
      async execute() {
        return {
          content: [{ type: "text", text: "submitted" }],
          details: { accepted: true },
          terminate: true,
        };
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
  resources?: readonly LaunchResource[];
  maxAllTokens?: number;
}): Readonly<AgentLaunchSpec> {
  const resources = options.resources ?? [];
  const systemPrompt = "You are a contained Koni worker. Use only issued tools and context.";
  const initialPrompt = "Complete the exact compiler-issued ticket step, then submit output.";
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
      id: "worker",
      systemPrompt,
      systemPromptHash: rawSha256(systemPrompt),
      initialPrompt,
      initialPromptHash: rawSha256(initialPrompt),
    },
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-terra",
      thinkingLevel: "high",
    },
    tools: [{ name: TERMINAL_TOOL_NAME, schemaHash: TOOL_SCHEMA_HASH, executionMode: "sequential" }],
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
      },
      retries: { maxProviderRetries: 2, baseDelayMs: 1 },
    },
    terminal: {
      toolName: TERMINAL_TOOL_NAME,
      outputSchemaHash: OUTPUT_SCHEMA_HASH,
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
