import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { canonicalEncode, canonicalHash, type Sha256Digest } from "../shared/canonical.js";
import type { AuthorityBackedTool } from "./managed-session.js";

export const KONI_TOOL_NAMES = [
  "koni_context",
  "koni_read_resource",
  "koni_graph_context",
  "koni_read_file",
  "koni_list_files",
  "koni_search_files",
  "koni_run_check",
  "koni_write_file",
  "koni_edit_file",
  "koni_update_working_spec",
  "koni_record_note",
  "koni_ask_question",
  "koni_submit_output",
] as const;

export type KoniToolName = (typeof KONI_TOOL_NAMES)[number];

export interface KoniToolInvocation {
  callId: string;
  name: KoniToolName;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
}

export const KONI_TOOL_RECEIPT_PROTOCOL = "koni.tool-receipt.v1" as const;

interface KoniToolReceiptBase {
  protocol: typeof KONI_TOOL_RECEIPT_PROTOCOL;
  receiptId: string;
  outcome: "accepted" | "rejected";
  summary: string;
  value?: unknown;
}

export interface KoniAcceptedToolReceipt extends KoniToolReceiptBase {
  outcome: "accepted";
}

export interface KoniRejectedToolReceipt extends KoniToolReceiptBase {
  outcome: "rejected";
  /** Stable authority-owned rejection code; prose belongs in summary/value. */
  code: string;
}

export type KoniToolReceipt = KoniAcceptedToolReceipt | KoniRejectedToolReceipt;

export interface KoniRuntimeToolRejection {
  code: "transcript_result_budget";
  summary: string;
}

/** The closure must cross the TypeScript authority boundary; Pi never performs effects itself. */
export type KoniToolInvoker = (call: KoniToolInvocation) => Promise<KoniToolReceipt>;
export type KoniToolRejector = (
  call: KoniToolInvocation,
  rejection: KoniRuntimeToolRejection,
) => Promise<KoniRejectedToolReceipt>;

export interface KoniToolCatalogOptions {
  names: readonly KoniToolName[];
  invoke: KoniToolInvoker;
  /** Record a no-effect runtime rejection in the same durable authority ledger as tool effects. */
  reject: KoniToolRejector;
  /** Exact structured terminal-call arguments selected by the compiler for this attempt. */
  terminalOutputSchema?: TSchema;
  /** Reconstruct a supported historical schema for an already-issued launch specification. */
  schemaHashes?: Readonly<Partial<Record<KoniToolName, Sha256Digest>>>;
}

interface CatalogEntry {
  name: KoniToolName;
  label: string;
  description: string;
  schema: TSchema;
  executionMode: "sequential" | "parallel";
  terminal: boolean;
  maxResultBytes: number;
}

const stringList = (maximum: number) => Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
  maxItems: maximum,
  uniqueItems: true,
});
const pathField = Type.String({ minLength: 1, maxLength: 4_096 });
const sha256Field = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const jsonObject = Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown());
const legacyRecordNoteSchema = Type.Object({
  nodeId: Type.String({ minLength: 1, maxLength: 256 }),
  kind: Type.Union([
    Type.Literal("observation"),
    Type.Literal("implementation_detail"),
    Type.Literal("rationale"),
    Type.Literal("nit"),
    Type.Literal("open_question"),
  ]),
  body: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
  supersedes: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });
const currentRecordNoteSchema = Type.Object({
  nodeId: Type.String({ minLength: 1, maxLength: 256 }),
  kind: Type.Union([
    Type.Literal("observation"),
    Type.Literal("implementation_detail"),
    Type.Literal("rationale"),
    Type.Literal("nit"),
    Type.Literal("open_question"),
  ]),
  body: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
  paths: Type.Optional(Type.Array(pathField, { maxItems: 256, uniqueItems: true })),
  supersedes: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });

const CATALOG: Readonly<Record<KoniToolName, Omit<CatalogEntry, "name">>> = {
  koni_context: {
    label: "Ticket context",
    description: "Read a bounded page of compiler-issued context for this exact ticket step.",
    schema: Type.Object({
      offsetChars: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 131_072 })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 512 * 1024,
  },
  koni_read_resource: {
    label: "Read resource",
    description: "Read a bounded page of one immutable compiler-issued skill or prompt resource.",
    schema: Type.Object({
      resourceId: Type.String({ minLength: 1, maxLength: 256 }),
      offsetChars: Type.Optional(Type.Integer({ minimum: 0 })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 131_072 })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 512 * 1024,
  },
  koni_graph_context: {
    label: "Graph context",
    description: "Read a bounded typed-graph neighborhood inside this attempt's compiler-issued scope.",
    schema: Type.Object({
      anchors: Type.Optional(stringList(16)),
      relations: Type.Optional(stringList(32)),
      direction: Type.Optional(Type.Union([
        Type.Literal("outgoing"),
        Type.Literal("incoming"),
        Type.Literal("both"),
      ])),
      maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
      nodeTypes: Type.Optional(stringList(32)),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_read_file: {
    label: "Read",
    description: "Read a bounded page of a regular file allowed by the compiled ticket grant.",
    schema: Type.Object({
      path: pathField,
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_list_files: {
    label: "List",
    description: "List bounded regular files and directories allowed by the compiled ticket grant.",
    schema: Type.Object({
      path: Type.Optional(pathField),
      recursive: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 4 * 1024 * 1024,
  },
  koni_search_files: {
    label: "Search",
    description: "Search literal UTF-8 text only in regular files allowed by the compiled ticket grant.",
    schema: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 4_096 }),
      roots: Type.Optional(Type.Array(pathField, { maxItems: 64, uniqueItems: true })),
      caseSensitive: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 4 * 1024 * 1024,
  },
  koni_run_check: {
    label: "Run check",
    description: "Execute one exact compiler-configured check in the authority-owned OS sandbox.",
    schema: Type.Object({
      checkId: Type.String({ minLength: 1, maxLength: 256 }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 4 * 1024 * 1024,
  },
  koni_write_file: {
    label: "Write",
    description: "Atomically replace a compiled-grant file using an exact content-hash precondition.",
    schema: Type.Object({
      path: pathField,
      content: Type.String({ maxLength: 16 * 1024 * 1024 }),
      expectedSha256: Type.Union([sha256Field, Type.Null()]),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 1024 * 1024,
  },
  koni_edit_file: {
    label: "Edit",
    description: "Replace one exact text occurrence in a compiled-grant file under a content-hash precondition.",
    schema: Type.Object({
      path: pathField,
      oldText: Type.String({ minLength: 1, maxLength: 8 * 1024 * 1024 }),
      newText: Type.String({ maxLength: 8 * 1024 * 1024 }),
      expectedSha256: sha256Field,
    }, { additionalProperties: false }),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 1024 * 1024,
  },
  koni_update_working_spec: {
    label: "Update working specification",
    description: "Create the next canonical working-spec version under owner authentication and contextual CAS.",
    schema: Type.Object({
      expectedContextualRevision: Type.Integer({ minimum: 0 }),
      expectedCanonicalDigest: sha256Field,
      guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 * 1024 })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 * 1024 })),
      affectedNodeIds: Type.Optional(stringList(256)),
      paths: Type.Optional(Type.Array(pathField, { maxItems: 256, uniqueItems: true })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_record_note: {
    label: "Record note",
    description: "Append a provenance-bound advisory note to a graph node visible to this ticket.",
    schema: currentRecordNoteSchema,
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_ask_question: {
    label: "Ask user",
    description: "Open one durable compiler-bound question and suspend this attempt until it is answered.",
    schema: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
      options: Type.Array(Type.Object({
        id: Type.String({ minLength: 1, maxLength: 128 }),
        label: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
        description: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
      }, { additionalProperties: false }), { minItems: 2, maxItems: 8 }),
      allowsNotes: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_submit_output: {
    label: "Submit output",
    description: "Submit the one terminal structured result for compiler reconciliation and end this attempt.",
    schema: jsonObject,
    executionMode: "sequential",
    terminal: true,
    maxResultBytes: 2 * 1024 * 1024,
  },
};

/** Build the exact hash-bound inventory loaded into one contained Pi AgentSession. */
export function createKoniAuthorityTools(options: KoniToolCatalogOptions): AuthorityBackedTool[] {
  if (options.names.length === 0) throw new Error("a contained attempt requires at least one Koni tool");
  const names = new Set<KoniToolName>();
  return options.names.map((name) => {
    if (names.has(name)) throw new Error(`duplicate Koni tool ${name}`);
    names.add(name);
    const source = CATALOG[name];
    const parameters = resolveToolSchema(
      name,
      options.terminalOutputSchema,
      options.schemaHashes?.[name],
    );
    const schemaHash = canonicalHash(parameters);
    const maxResultBytes = source.maxResultBytes;
    const resultFromReceipt = (
      receipt: KoniToolReceipt,
      resultLimitBytes = maxResultBytes,
    ): AgentToolResult<unknown> => {
      validateKoniToolReceipt(receipt);
      const result: AgentToolResult<unknown> = {
        content: [{ type: "text", text: renderKoniToolReceipt(receipt) }],
        details: structuredClone(receipt),
        ...(source.terminal && receipt.outcome === "accepted" ? { terminate: true } : {}),
      };
      if (koniToolResultPayloadBytes(result) > resultLimitBytes) {
        throw new Error(`authority tool result for ${name} exceeds its ${resultLimitBytes}-byte launch bound`);
      }
      return result;
    };
    const execute: AuthorityBackedTool["execute"] = async (callId, args, signal) => {
      const receipt = await options.invoke({
        callId,
        name,
        arguments: structuredClone(args),
        ...(signal === undefined ? {} : { signal }),
      });
      return resultFromReceipt(receipt, Math.min(maxResultBytes, 64 * 1024));
    };
    const reject: AuthorityBackedTool["reject"] = async (callId, args, rejection, signal) => {
      validateRuntimeRejection(rejection);
      const receipt = await options.reject({
        callId,
        name,
        arguments: structuredClone(args),
        ...(signal === undefined ? {} : { signal }),
      }, structuredClone(rejection));
      validateKoniToolReceipt(receipt);
      if (receipt.outcome !== "rejected" || receipt.code !== rejection.code) {
        throw new Error(`authority returned the wrong rejection outcome for ${name}`);
      }
      return resultFromReceipt(receipt);
    };
    const definition: ToolDefinition = {
      name,
      label: source.label,
      description: source.description,
      promptSnippet: source.description,
      parameters,
      executionMode: source.executionMode,
      async execute(callId, args, signal): Promise<AgentToolResult<unknown>> {
        return execute(callId, args as Record<string, unknown>, signal);
      },
    };
    return {
      name,
      schemaHash,
      maxResultBytes,
      execute,
      reject,
      ...(source.terminal ? {
        terminalOutputSchema: parameters,
        terminalOutputSchemaHash: schemaHash,
      } : {}),
      definition,
    };
  });
}

export function koniToolSchemaHash(name: KoniToolName, terminalOutputSchema?: TSchema): Sha256Digest {
  return canonicalHash(resolveToolSchema(name, terminalOutputSchema));
}

export function isSupportedKoniToolSchemaHash(
  name: KoniToolName,
  schemaHash: Sha256Digest,
  terminalOutputSchema?: TSchema,
): boolean {
  try {
    return canonicalHash(resolveToolSchema(name, terminalOutputSchema, schemaHash)) === schemaHash;
  } catch {
    return false;
  }
}

export function koniToolMaxResultBytes(name: KoniToolName): number {
  return CATALOG[name].maxResultBytes;
}

/** Revalidate at the authority boundary; Pi's extension-side validation is presentation only. */
export function validateKoniToolArguments(
  name: KoniToolName,
  value: unknown,
  terminalOutputSchema?: TSchema,
  expectedSchemaHash?: Sha256Digest,
): Record<string, unknown> {
  const schema = resolveToolSchema(name, terminalOutputSchema, expectedSchemaHash);
  if (!Value.Check(schema, value) || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`arguments do not match the compiler-issued schema for ${name}`);
  }
  return structuredClone(value as Record<string, unknown>);
}

function resolveToolSchema(
  name: KoniToolName,
  terminalOutputSchema?: TSchema,
  expectedSchemaHash?: Sha256Digest,
): TSchema {
  const current = name === "koni_submit_output" && terminalOutputSchema !== undefined
    ? terminalOutputSchema
    : CATALOG[name].schema;
  if (expectedSchemaHash === undefined || canonicalHash(current) === expectedSchemaHash) return current;
  if (name === "koni_record_note" && canonicalHash(legacyRecordNoteSchema) === expectedSchemaHash) {
    return legacyRecordNoteSchema;
  }
  throw new Error(`unsupported historical schema hash for ${name}`);
}

export function renderKoniToolReceipt(receipt: KoniToolReceipt): string {
  validateKoniToolReceipt(receipt);
  return JSON.stringify({
    status: receipt.outcome,
    receiptId: receipt.receiptId,
    summary: receipt.summary,
    ...(receipt.outcome === "rejected" ? { code: receipt.code } : {}),
    ...(receipt.value === undefined ? {} : { value: receipt.value }),
  }, null, 2);
}

export function koniToolResultPayloadBytes(result: Pick<AgentToolResult<unknown>, "content" | "details" | "terminate">): number {
  return Buffer.byteLength(canonicalEncode({
    content: result.content,
    details: result.details,
    ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
  }), "utf8");
}

export function validateKoniToolReceipt(value: unknown): asserts value is KoniToolReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("authority tool receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const expected = receipt.outcome === "rejected"
    ? ["code", "outcome", "protocol", "receiptId", "summary", ...(receipt.value === undefined ? [] : ["value"])]
    : ["outcome", "protocol", "receiptId", "summary", ...(receipt.value === undefined ? [] : ["value"])];
  const actual = Object.keys(receipt).sort();
  expected.sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    receipt.protocol !== KONI_TOOL_RECEIPT_PROTOCOL ||
    (receipt.outcome !== "accepted" && receipt.outcome !== "rejected") ||
    !safeReceiptText(receipt.receiptId, 256) ||
    !safeReceiptText(receipt.summary, 64 * 1024) ||
    (receipt.outcome === "rejected" && !safeReceiptCode(receipt.code))
  ) {
    throw new Error("authority tool receipt is malformed");
  }
  const encoded = canonicalEncode(receipt);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024 * 1024) {
    throw new Error("authority tool receipt exceeds 16 MiB");
  }
}

function validateRuntimeRejection(value: KoniRuntimeToolRejection): void {
  if (
    value.code !== "transcript_result_budget" ||
    !safeReceiptText(value.summary, 64 * 1024) ||
    Object.keys(value).sort().join(",") !== "code,summary"
  ) {
    throw new Error("runtime tool rejection is malformed");
  }
}

function safeReceiptText(value: unknown, maximum: number): value is string {
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\u0000");
}

function safeReceiptCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value);
}
