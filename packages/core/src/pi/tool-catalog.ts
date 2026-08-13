import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  canonicalEncode,
  canonicalHash,
  compareUtf8,
  type Sha256Digest,
} from "../shared/canonical.js";
import type { AuthorityBackedTool } from "./managed-session.js";
import { renderKoniToolCall, renderKoniToolResult } from "./tool-renderer.js";

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

export const CUMULATIVE_TOOL_RETRY_INSTRUCTION =
  "On retry of this tool, use the immediately preceding arguments as the working draft, correct every current mismatch together, and do not undo a prior correction unless a later diagnostic explicitly requires it.";

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

/** A model-correctable mismatch against the compiler-issued exact tool contract. */
export class KoniToolArgumentValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KoniToolArgumentValidationError";
  }
}

type SchemaValidationError =
  ReturnType<typeof Value.Errors> extends Iterable<infer Error> ? Error : never;

/** Enough errors to identify several nested union branches without traversing an attacker-sized set. */
const MAX_SCHEMA_DIAGNOSTIC_ERRORS = 256;

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

const stringList = (maximum: number) =>
  Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
    maxItems: maximum,
    uniqueItems: true,
  });
const pathField = Type.String({ minLength: 1, maxLength: 4_096 });
const sha256Field = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const jsonObject = Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown());
const legacyRecordNoteSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);
const currentRecordNoteSchema = Type.Object(
  {
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
  },
  { additionalProperties: false },
);

/** Recovery-only schema for attempts issued before policy-aware recommendations were mandatory. */
const legacyAskQuestionSchema = Type.Union([
  Type.Object(
    {
      prompt: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
      options: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 128 }),
            label: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
            description: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 2, maxItems: 8 },
      ),
      allowsNotes: Type.Optional(Type.Boolean()),
      recommendedOptionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      questions: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 128 }),
            prompt: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
            options: Type.Array(
              Type.Object(
                {
                  id: Type.String({ minLength: 1, maxLength: 128 }),
                  label: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
                  description: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
                },
                { additionalProperties: false },
              ),
              { minItems: 2, maxItems: 8 },
            ),
            allowsNotes: Type.Optional(Type.Boolean()),
            recommendedOptionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 8 },
      ),
    },
    { additionalProperties: false },
  ),
]);

const currentAskQuestionSchema = Type.Union([
  Type.Object(
    {
      prompt: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
      options: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 128 }),
            label: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
            description: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 2, maxItems: 8 },
      ),
      allowsNotes: Type.Optional(Type.Boolean()),
      recommendedOptionId: Type.String({ minLength: 1, maxLength: 128 }),
      impact: Type.Union([Type.Literal("routine"), Type.Literal("high_impact")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      questions: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 128 }),
            prompt: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
            options: Type.Array(
              Type.Object(
                {
                  id: Type.String({ minLength: 1, maxLength: 128 }),
                  label: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
                  description: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
                },
                { additionalProperties: false },
              ),
              { minItems: 2, maxItems: 8 },
            ),
            allowsNotes: Type.Optional(Type.Boolean()),
            recommendedOptionId: Type.String({ minLength: 1, maxLength: 128 }),
            impact: Type.Union([Type.Literal("routine"), Type.Literal("high_impact")]),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 8 },
      ),
    },
    { additionalProperties: false },
  ),
]);

const CATALOG: Readonly<Record<KoniToolName, Omit<CatalogEntry, "name">>> = {
  koni_context: {
    label: "Ticket context",
    description: "Read a bounded page of compiler-issued context for this exact ticket step.",
    schema: Type.Object(
      {
        offsetChars: Type.Optional(Type.Integer({ minimum: 0 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 131_072 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 512 * 1024,
  },
  koni_read_resource: {
    label: "Read resource",
    description:
      "Read a bounded page of one immutable compiler-issued skill or prompt by its resource ID or relative Pi path.",
    schema: Type.Object(
      {
        resourceId: Type.String({ minLength: 1, maxLength: 1024 }),
        offsetChars: Type.Optional(Type.Integer({ minimum: 0 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 131_072 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 512 * 1024,
  },
  koni_graph_context: {
    label: "Graph context",
    description:
      "Read a bounded typed-graph neighborhood inside this attempt's compiler-issued scope.",
    schema: Type.Object(
      {
        anchors: Type.Optional(stringList(16)),
        relations: Type.Optional(stringList(32)),
        direction: Type.Optional(
          Type.Union([Type.Literal("outgoing"), Type.Literal("incoming"), Type.Literal("both")]),
        ),
        maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
        nodeTypes: Type.Optional(stringList(32)),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_read_file: {
    label: "Read",
    description:
      "Read at most 32 KiB from an allowed regular file. For a large file, search for a known symbol or literal before reading at a nonzero byte offset.",
    schema: Type.Object(
      {
        path: pathField,
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_list_files: {
    label: "List",
    description: "List bounded regular files and directories allowed by the compiled ticket grant.",
    schema: Type.Object(
      {
        path: Type.Optional(pathField),
        recursive: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 4 * 1024 * 1024,
  },
  koni_search_files: {
    label: "Search",
    description:
      "Search literal UTF-8 text in allowed regular files and return line, preview, and exact byte offsets for targeted reads.",
    schema: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 4_096 }),
        roots: Type.Optional(Type.Array(pathField, { maxItems: 64, uniqueItems: true })),
        caseSensitive: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "parallel",
    terminal: false,
    maxResultBytes: 4 * 1024 * 1024,
  },
  koni_run_check: {
    label: "Run check",
    description: "Execute one exact compiler-configured check in the authority-owned OS sandbox.",
    schema: Type.Object(
      {
        checkId: Type.String({ minLength: 1, maxLength: 256 }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 4 * 1024 * 1024,
  },
  koni_write_file: {
    label: "Write",
    description:
      "Atomically replace a compiled-grant file using an exact content-hash precondition.",
    schema: Type.Object(
      {
        path: pathField,
        content: Type.String({ maxLength: 16 * 1024 * 1024 }),
        expectedSha256: Type.Union([sha256Field, Type.Null()], {
          description:
            "Required precondition: the `sha256` returned by your most recent accepted read of this exact path. Use null only to create a file that does not exist yet. The authority never volunteers this value; it proves you are replacing the bytes you actually observed.",
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 1024 * 1024,
  },
  koni_edit_file: {
    label: "Edit",
    description:
      "Replace one exact text occurrence in a compiled-grant file under a content-hash precondition.",
    schema: Type.Object(
      {
        path: pathField,
        oldText: Type.String({ minLength: 1, maxLength: 8 * 1024 * 1024 }),
        newText: Type.String({ maxLength: 8 * 1024 * 1024 }),
        expectedSha256: Type.String({
          pattern: "^sha256:[0-9a-f]{64}$",
          description:
            "Required precondition: the `sha256` returned by your most recent accepted read of this exact path. Supply it rather than falling back to a whole-file write; the authority never volunteers this value, because it proves you are editing the bytes you actually observed.",
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 1024 * 1024,
  },
  koni_update_working_spec: {
    label: "Update working specification",
    description:
      "Create the next canonical working-spec version under owner authentication and contextual CAS.",
    schema: Type.Object(
      {
        expectedContextualRevision: Type.Integer({ minimum: 0 }),
        expectedCanonicalDigest: sha256Field,
        guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 * 1024 })),
        content: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 * 1024 })),
        affectedNodeIds: Type.Optional(stringList(256)),
        paths: Type.Optional(Type.Array(pathField, { maxItems: 256, uniqueItems: true })),
      },
      { additionalProperties: false },
    ),
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
    description:
      "Submit explicit recommendations and impact. The pinned run policy either records them automatically or pauses for operator input.",
    schema: currentAskQuestionSchema,
    executionMode: "sequential",
    terminal: false,
    maxResultBytes: 2 * 1024 * 1024,
  },
  koni_submit_output: {
    label: "Submit output",
    description:
      // The batch rule was enforced but never stated, so agents kept pairing the submission with a
      // last read or note. That is not a recoverable tool error: it aborts the whole turn and costs
      // the entire attempt. Say it where the model reads the contract.
      // The exact compiler-selected terminal schema is appended when the tool is constructed. Do
      // not state a universal `status` contract here: planning artifacts intentionally have no
      // status field, and small models followed this prose instead of the contradictory schema.
      "Submit the one terminal structured result and end this attempt. Call this tool ALONE: it must be the only tool call in its batch, so finish every other call in an earlier turn and never pair this submission with another tool. Do not send placeholder or schema-probing content. Send the arguments as one JSON object.",
    schema: jsonObject,
    executionMode: "sequential",
    terminal: true,
    maxResultBytes: 2 * 1024 * 1024,
  },
};

/** Build the exact hash-bound inventory loaded into one contained Pi AgentSession. */
export function createKoniAuthorityTools(options: KoniToolCatalogOptions): AuthorityBackedTool[] {
  if (options.names.length === 0)
    throw new Error("a contained attempt requires at least one Koni tool");
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
    const terminalSchema = options.terminalOutputSchema ?? parameters;
    const nestedContracts = source.terminal
      ? describeNestedDiscriminatedContracts(terminalSchema)
      : [];
    const description = source.terminal
      ? `${source.description} Exact compiler-issued shape: ${describeSchemaShape(terminalSchema)}.${nestedContracts.length === 0 ? "" : ` ${nestedContracts.join(". ")}.`} On every validation retry, resubmit the complete object instead of only the corrected section. Never add status, summary, or any other field unless it appears in that exact shape.`
      : hasLargePayloadPresentationEnvelope(name)
        ? `${source.description} Exact authority shape: ${describeSchemaShape(source.schema)}. Include every field shown; Pi's presentation envelope is non-authoritative and Koni validates the exact contract before any filesystem effect.`
        : source.description;
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
        throw new Error(
          `authority tool result for ${name} exceeds its ${resultLimitBytes}-byte launch bound`,
        );
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
      // The immutable launch already authenticates this per-tool ceiling (4 KiB–16 MiB). Do not
      // replace it with a hidden 64 KiB runtime cap: receipt details intentionally duplicate the
      // semantic payload used by Pi renderers, so otherwise valid bounded context/file pages can
      // fail after the authority has accepted and persisted them.
      return resultFromReceipt(receipt, maxResultBytes);
    };
    const reject: AuthorityBackedTool["reject"] = async (callId, args, rejection, signal) => {
      validateRuntimeRejection(rejection);
      const receipt = await options.reject(
        {
          callId,
          name,
          arguments: structuredClone(args),
          ...(signal === undefined ? {} : { signal }),
        },
        structuredClone(rejection),
      );
      validateKoniToolReceipt(receipt);
      if (receipt.outcome !== "rejected" || receipt.code !== rejection.code) {
        throw new Error(`authority returned the wrong rejection outcome for ${name}`);
      }
      return resultFromReceipt(receipt);
    };
    const definition: ToolDefinition = {
      name,
      label: source.label,
      description,
      promptSnippet: description,
      parameters,
      executionMode: source.executionMode,
      async execute(callId, args, signal): Promise<AgentToolResult<unknown>> {
        return execute(callId, args as Record<string, unknown>, signal);
      },
      renderCall(args, theme, context) {
        return renderKoniToolCall(name, source.label, args, theme, context.lastComponent);
      },
      renderResult(result, renderOptions, theme, context) {
        return renderKoniToolResult(
          source.label,
          result,
          renderOptions,
          theme,
          context.lastComponent,
        );
      },
    };
    return {
      name,
      schemaHash,
      maxResultBytes,
      execute,
      reject,
      // The terminal outcome contract stays the exact compiled union even though the advertised
      // parameters carry the transport-flattened view (see transportToolSchema).
      ...(source.terminal
        ? {
            terminalOutputSchema: structuredClone(options.terminalOutputSchema ?? parameters),
            terminalOutputSchemaHash: canonicalHash(options.terminalOutputSchema ?? parameters),
          }
        : {}),
      definition,
    };
  });
}

export function koniToolSchemaHash(
  name: KoniToolName,
  terminalOutputSchema?: TSchema,
): Sha256Digest {
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
  const presentationSchema = resolveToolSchema(name, terminalOutputSchema, expectedSchemaHash);
  // The provider and Pi see the transport-representable presentation schema. Authority must never
  // confuse that compatibility envelope with the compiler-issued terminal contract: validate the
  // exact separately hash-bound schema here before any terminal effect can run.
  const authoritySchema =
    name === "koni_submit_output" && terminalOutputSchema !== undefined
      ? terminalOutputSchema
      : hasLargePayloadPresentationEnvelope(name)
        ? CATALOG[name].schema
        : presentationSchema;
  // Reject a JSON-serialized object once: some provider tool-call transports stringify structured
  // arguments (observed live: `graphDelta` declared object but delivered as a string, making the
  // success branch unsatisfiable). Parse-and-retry so a correct payload is not rejected for a
  // transport artifact outside the agent's control.
  const parsed = coerceJsonObjectArguments(value);
  const accepts = (candidate: unknown): candidate is Record<string, unknown> =>
    Value.Check(authoritySchema, candidate) &&
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate);
  if (accepts(parsed)) return structuredClone(parsed);
  // Repair nested fields the transport stringified (for example an object-typed `graphDelta` or a
  // null CAS precondition delivered as a JSON string). Only accept the repaired payload when it
  // passes the exact compiled schema, so this transport normalization can never widen authority.
  const repaired = repairStringifiedJsonFields(parsed, authoritySchema);
  if (repaired !== undefined && accepts(repaired)) return structuredClone(repaired);
  // A bare validation failure ("arguments do not match the schema") forces the agent to brute-force
  // the contract one field/const at a time (observed live: 100+ failed submit calls guessing the
  // status value, whole token budgets drained). Return a self-describing error that names the
  // allowed values, the actual-vs-max lengths, and the full expected shape, so the next call is
  // correct. This is provider-agnostic — it derives everything from the compiled schema.
  throw new KoniToolArgumentValidationError(
    describeSchemaMismatch(name, authoritySchema, repaired ?? parsed, repaired !== undefined),
  );
}

/** Accept a JSON-string form of the arguments (a transport artifact) as if it were the object. */
function coerceJsonObjectArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Root-union tool schemas flatten to zero properties in provider tool transforms (observed live:
 * the terminal submit tool advertised `{properties: {}, required: []}`, so agents could not target
 * the contract and transports delivered object-typed fields as strings, making one step class
 * unsatisfiable). Expose a merged single-object view — every union field present, shared fields
 * union-typed and required, branch-specific fields optional, the exact branch shapes in the
 * description — while the schema hash and authority-side validation keep the exact compiled union.
 */
function transportToolSchema(name: KoniToolName, schema: TSchema): TSchema {
  return terminalTransportToolSchema(name, schema, true, true);
}

/** Reconstruct launch specs issued before the outer terminal envelope became presentation-only. */
function strictOuterTransportToolSchema(name: KoniToolName, schema: TSchema): TSchema {
  return terminalTransportToolSchema(name, schema, true, false);
}

/** Reconstruct launch specs issued before nested discriminator validation moved to authority. */
function legacyTransportToolSchema(name: KoniToolName, schema: TSchema): TSchema {
  return terminalTransportToolSchema(name, schema, false, false);
}

function terminalTransportToolSchema(
  name: KoniToolName,
  schema: TSchema,
  relaxNestedDiscriminators: boolean,
  relaxOuterEnvelope: boolean,
): TSchema {
  if (name !== "koni_submit_output") return schema;
  const branches = (schema as { anyOf?: TSchema[] }).anyOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    const nestedPresentation = relaxNestedDiscriminators
      ? relaxNestedDiscriminatedArrays(schema)
      : schema;
    return relaxOuterEnvelope
      ? relaxTerminalPresentationEnvelope(nestedPresentation)
      : nestedPresentation;
  }
  const byKey = new Map<
    string,
    { variants: TSchema[]; hashes: Set<string>; requiredOccurrences: number }
  >();
  for (const branch of branches) {
    const properties = (branch as { properties?: Record<string, TSchema> }).properties;
    if (properties === undefined) return schema;
    const required = new Set((branch as { required?: string[] }).required ?? []);
    for (const [key, property] of Object.entries(properties)) {
      const slot = byKey.get(key) ?? {
        variants: [],
        hashes: new Set<string>(),
        requiredOccurrences: 0,
      };
      const hash = canonicalHash(property);
      if (!slot.hashes.has(hash)) {
        slot.hashes.add(hash);
        slot.variants.push(structuredClone(property));
      }
      if (required.has(key)) slot.requiredOccurrences += 1;
      byKey.set(key, slot);
    }
  }
  const merged: Record<string, TSchema> = {};
  for (const [key, slot] of byKey) {
    const single = slot.variants.length === 1 ? slot.variants[0]! : Type.Union(slot.variants);
    merged[key] = slot.requiredOccurrences === branches.length ? single : Type.Optional(single);
  }
  // Merging costs the one thing the union expressed for free: that branch fields are mutually
  // exclusive. Every branch-specific field arrives as an optional sibling of every other, so a
  // schema-reading agent sees `graphDelta` and `upstreamChangeRequest` as combinable and pairing
  // them reads as thorough rather than invalid. The authority then refuses the pair and discards
  // the whole attempt. Observed across two runs and traced to this flattening rather than to any
  // persona, because 23 configured operations permit both a graph mutation and an upstream
  // request. State the exclusion where the fields are declared; prose elsewhere loses to shape.
  const exclusions = mutuallyExclusiveFieldGroups(branches);
  const flattened = Type.Object(merged, {
    additionalProperties: false,
    description:
      `Send exactly one of these shapes, omitting every other branch's fields: ${describeSchemaShape(schema)}` +
      (exclusions.length === 0
        ? ""
        : `. Optional fields above belong to different shapes and must never be combined: ${exclusions
            .map((group) => group.map((field) => `\`${field}\``).join(" + "))
            .join("; ")} — sending fields from two shapes is refused and discards the attempt`),
  });
  const nestedPresentation = relaxNestedDiscriminators
    ? relaxNestedDiscriminatedArrays(flattened)
    : flattened;
  return relaxOuterEnvelope
    ? relaxTerminalPresentationEnvelope(nestedPresentation)
    : nestedPresentation;
}

/**
 * Pi validates advertised parameters before Koni can issue a bounded durable rejection, and its
 * validator echoes the complete submitted object on failure. A planning artifact can be several
 * megabytes, so even a misplaced root field can consume the remaining context before authority
 * sees the call. Keep the compiler-selected root field names visible to the provider, but make the
 * presentation envelope permissive. Exact shape validation remains hash-bound at the terminal
 * compiler boundary before any effect can be accepted.
 */
function relaxTerminalPresentationEnvelope(schema: TSchema): TSchema {
  const properties = (schema as { properties?: Record<string, TSchema> }).properties;
  const visibleFields = Object.fromEntries(
    Object.keys(properties ?? {})
      .sort(compareUtf8)
      .map((key) => [key, Type.Optional(Type.Unknown())]),
  );
  const description = (schema as { description?: unknown }).description;
  return Type.Object(visibleFields, {
    additionalProperties: true,
    ...(typeof description === "string" ? { description } : {}),
  });
}

/**
 * Pi validates its advertised tool schema before calling Koni. Its generic validator expands every
 * branch of a nested discriminated union and echoes the complete submitted artifact, so one wrong
 * discriminator can consume tens of thousands of tokens without ever reaching Koni's bounded,
 * durable compiler rejection. Make the discriminator and its branch-owned object
 * presentation-only; the outer envelope is relaxed separately. The exact terminal schema remains
 * hash-bound and is compiled by authority before any effect is accepted.
 */
function relaxNestedDiscriminatedArrays(schema: TSchema): TSchema {
  const visit = (candidate: unknown): unknown => {
    if (!isRecord(candidate)) return candidate;
    const out: Record<string, unknown> = structuredClone(candidate);
    if (isRecord(candidate.properties)) {
      out.properties = Object.fromEntries(
        Object.entries(candidate.properties).map(([key, property]) => [key, visit(property)]),
      );
    }
    if (candidate.type === "array" && isRecord(candidate.items)) {
      const presentation = discriminatedArrayItemPresentation(candidate.items);
      out.items = presentation ?? visit(candidate.items);
    } else if (isRecord(candidate.items)) {
      out.items = visit(candidate.items);
    }
    if (Array.isArray(candidate.anyOf)) out.anyOf = candidate.anyOf.map(visit);
    return out;
  };
  return visit(schema) as TSchema;
}

function discriminatedArrayItemPresentation(items: Record<string, unknown>): TSchema | undefined {
  const branches = Array.isArray(items.anyOf) ? items.anyOf : undefined;
  if (branches === undefined || branches.length < 2) return undefined;
  const branchProperties = branches.map((branch) =>
    isRecord(branch) && isRecord(branch.properties) ? branch.properties : undefined,
  );
  if (branchProperties.some((properties) => properties === undefined)) return undefined;
  const properties = branchProperties as Record<string, unknown>[];
  const allKeys = [...new Set(properties.flatMap((branch) => Object.keys(branch)))].sort(
    compareUtf8,
  );
  const sharedKeys = allKeys.filter((key) =>
    properties.every((branch) => Object.hasOwn(branch, key)),
  );
  const discriminator = sharedKeys.find((key) => {
    const literals = properties.map((branch) => branch[key]);
    return literals.every((value) => isRecord(value) && typeof value.const === "string");
  });
  if (discriminator === undefined) return undefined;
  const discriminatorValues = properties.map(
    (branch) => (branch[discriminator] as Record<string, unknown>).const as string,
  );
  if (new Set(discriminatorValues).size !== branches.length) return undefined;

  const requiredByBranch = branches.map(
    (branch) => new Set((branch as { required?: string[] }).required ?? []),
  );
  const merged: Record<string, TSchema> = {};
  for (const key of allKeys) {
    const variants = properties.flatMap((branch) =>
      Object.hasOwn(branch, key) ? [branch[key] as TSchema] : [],
    );
    if (key === discriminator) {
      merged[key] = Type.String({
        minLength: 1,
        description: `Exact allowed literals: ${discriminatorValues
          .map((value) => JSON.stringify(value))
          .join(", ")}`,
      });
      continue;
    }
    if (
      key === "spec" &&
      variants.every((variant) => isRecord(variant) && variant.type === "object")
    ) {
      merged[key] = Type.Object({}, { additionalProperties: true });
      continue;
    }
    const unique = new Map(variants.map((variant) => [canonicalHash(variant), variant]));
    const property =
      unique.size === 1 ? structuredClone(variants[0]!) : Type.Union([...unique.values()]);
    merged[key] = requiredByBranch.every((required) => required.has(key))
      ? property
      : Type.Optional(property);
  }
  return Type.Object(merged, {
    additionalProperties: false,
    description: `Presentation envelope only. ${discriminator} must be one of ${discriminatorValues
      .map((value) => JSON.stringify(value))
      .join(", ")}; authority validates the exact branch-owned spec.`,
  });
}

/** Parse top-level fields that carry a structured or scalar JSON value as transport text. */
function repairStringifiedJsonFields(
  value: unknown,
  schema: TSchema,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string") {
      const trimmed = field.trim();
      const encodedJsonValue =
        trimmed.startsWith("{") ||
        trimmed.startsWith("[") ||
        /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/u.test(trimmed);
      try {
        const parsed = encodedJsonValue ? JSON.parse(trimmed) : undefined;
        const fieldSchemas = topLevelFieldSchemas(schema, key);
        const originalAlreadyMatches = fieldSchemas.some((fieldSchema) =>
          Value.Check(fieldSchema, field),
        );
        const decodedMatches = fieldSchemas.some((fieldSchema) => Value.Check(fieldSchema, parsed));
        const decodedHasExpectedContainerKind = fieldSchemas.some((fieldSchema) =>
          schemaAllowsContainerKind(fieldSchema, parsed),
        );
        if (
          encodedJsonValue &&
          typeof parsed !== "string" &&
          !originalAlreadyMatches &&
          (decodedMatches || decodedHasExpectedContainerKind)
        ) {
          out[key] = parsed;
          changed = true;
          continue;
        }
      } catch {
        /* leave as-is */
      }
    }
    out[key] = field;
  }
  return changed ? out : undefined;
}

/** Return every root-object schema that governs one submitted field, including union branches. */
function topLevelFieldSchemas(schema: TSchema, key: string): TSchema[] {
  const record = schema as unknown as Record<string, unknown>;
  const result: TSchema[] = [];
  if (isRecord(record.properties) && key in record.properties) {
    result.push(record.properties[key] as TSchema);
  }
  for (const branchKey of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = record[branchKey];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isRecord(branch)) result.push(...topLevelFieldSchemas(branch, key));
    }
  }
  return result;
}

/** Match only the outer object/array kind so invalid nested data can still receive exact diagnostics. */
function schemaAllowsContainerKind(schema: TSchema, value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = schema as unknown as Record<string, unknown>;
  if (record.type === (Array.isArray(value) ? "array" : "object")) return true;
  for (const branchKey of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = record[branchKey];
    if (
      Array.isArray(branches) &&
      branches.some((branch) => isRecord(branch) && schemaAllowsContainerKind(branch, value))
    )
      return true;
  }
  return false;
}

/** Human-readable, agent-actionable description of why `value` failed `schema`, plus the shape. */
function describeSchemaMismatch(
  name: KoniToolName,
  schema: TSchema,
  value: unknown,
  decodedStringifiedFields = false,
): string {
  const observed = isRecord(value)
    ? Object.entries(value)
        .map(([key, field]) =>
          typeof field === "string"
            ? `${sanitizeDiagnosticText(key)}(${field.length} chars)`
            : `${sanitizeDiagnosticText(key)}(${Array.isArray(field) ? "array" : typeof field})`,
        )
        .join(", ")
    : typeof value;
  const overview =
    `arguments do not match the compiler-issued schema for ${name}. ` +
    (decodedStringifiedFields
      ? "Koni decoded JSON-string fields before validation; correct the exact decoded-field errors below rather than changing their transport representation. "
      : "") +
    `You sent: { ${observed} }. Expected exactly one of: ${describeSchemaShape(schema)}. ` +
    "Send status as the exact literal shown, include every listed field, and keep each string within its char limit. " +
    CUMULATIVE_TOOL_RETRY_INSTRUCTION;
  const diagnostics = argumentSchemaMismatchDiagnostics(schema, value);
  const boundedOverview = boundUtf8Text(overview, 8 * 1024, " … schema overview truncated");
  return boundUtf8Text(
    diagnostics.length === 0
      ? boundedOverview
      : `${boundedOverview} Exact mismatches:\n- ${diagnostics.join("\n- ")}`,
    16 * 1024,
  );
}

function argumentSchemaMismatchDiagnostics(schema: TSchema, value: unknown): string[] {
  const errors = boundedSchemaValidationErrors(schema, value);
  const selected = errors.filter((error) => error.keyword !== "anyOf" && error.keyword !== "oneOf");
  const rendered = new Set<string>();
  for (const error of selected) {
    const instancePath = error.instancePath.length === 0 ? "/" : error.instancePath;
    let reason: string;
    if (error.keyword === "additionalProperties") {
      const fields = [...error.params.additionalProperties].sort(compareUtf8);
      reason = `unexpected ${fields.length === 1 ? "field" : "fields"} ${fields.map(diagnosticFieldName).join(", ")}`;
    } else if (error.keyword === "required") {
      const fields = [...error.params.requiredProperties].sort(compareUtf8);
      reason = `required ${fields.length === 1 ? "field" : "fields"} missing: ${fields.map(diagnosticFieldName).join(", ")}`;
    } else if (error.keyword === "const") {
      reason = `expected ${JSON.stringify(error.params.allowedValue)}`;
    } else if (error.keyword === "enum") {
      reason = `expected one of ${error.params.allowedValues.map((item) => JSON.stringify(item)).join(", ")}`;
    } else {
      reason = error.message;
    }
    rendered.add(`${sanitizeDiagnosticText(instancePath)}: ${sanitizeDiagnosticText(reason)}`);
    if (rendered.size === 8) break;
  }
  return [...rendered];
}

function diagnosticFieldName(field: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) ? field : JSON.stringify(field);
}

function boundedSchemaValidationErrors(schema: TSchema, value: unknown): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  const append = (candidateSchema: TSchema, candidateValue: unknown, prefix: string): void => {
    for (const error of Value.Errors(candidateSchema, candidateValue)) {
      errors.push({
        ...error,
        instancePath: `${prefix}${error.instancePath}`,
      });
      if (errors.length === MAX_SCHEMA_DIAGNOSTIC_ERRORS) return;
    }
  };
  const visit = (candidateSchema: TSchema, candidateValue: unknown, prefix: string): void => {
    if (errors.length === MAX_SCHEMA_DIAGNOSTIC_ERRORS) return;
    const union = candidateSchema as { anyOf?: TSchema[]; oneOf?: TSchema[] };
    const unionKeyword = Array.isArray(union.anyOf)
      ? "anyOf"
      : Array.isArray(union.oneOf)
        ? "oneOf"
        : undefined;
    if (unionKeyword !== undefined) {
      const branches = union[unionKeyword]!;
      const selected = selectDiagnosticUnionBranches(branches, candidateValue);
      if (selected.length === 1) visit(selected[0]!, candidateValue, prefix);
      else append({ ...candidateSchema, [unionKeyword]: selected }, candidateValue, prefix);
      return;
    }
    const objectSchema = candidateSchema as {
      type?: unknown;
      properties?: Record<string, TSchema>;
    };
    if (
      objectSchema.type === "object" &&
      objectSchema.properties !== undefined &&
      isRecord(candidateValue)
    ) {
      append(
        {
          ...candidateSchema,
          properties: Object.fromEntries(
            Object.keys(objectSchema.properties).map((key) => [key, {}]),
          ),
        },
        candidateValue,
        prefix,
      );
      for (const [key, propertySchema] of Object.entries(objectSchema.properties)) {
        if (errors.length === MAX_SCHEMA_DIAGNOSTIC_ERRORS) return;
        if (!Object.hasOwn(candidateValue, key)) continue;
        visit(propertySchema, candidateValue[key], `${prefix}/${escapeJsonPointerToken(key)}`);
      }
      return;
    }
    const arraySchema = candidateSchema as { type?: unknown; items?: TSchema };
    if (
      arraySchema.type === "array" &&
      arraySchema.items !== undefined &&
      Array.isArray(candidateValue)
    ) {
      append({ ...candidateSchema, items: {} }, candidateValue, prefix);
      for (const [index, item] of candidateValue.entries()) {
        if (errors.length === MAX_SCHEMA_DIAGNOSTIC_ERRORS) return;
        visit(arraySchema.items, item, `${prefix}/${index}`);
      }
      return;
    }
    append(candidateSchema, candidateValue, prefix);
  };
  visit(schema, value, "");
  return errors;
}

function selectDiagnosticUnionBranches(branches: readonly TSchema[], value: unknown): TSchema[] {
  const scores = branches.map((branch) => schemaConstScore(branch, value));
  const uncontradicted = scores
    .map((score, index) => ({ score, index }))
    .filter(({ score }) => score.matches > 0 && score.contradictions === 0);
  const candidates =
    uncontradicted.length > 0
      ? uncontradicted
      : scores.map((score, index) => ({ score, index })).filter(({ score }) => score.matches > 0);
  if (candidates.length === 0) return [...branches];
  const minimumContradictions = Math.min(...candidates.map(({ score }) => score.contradictions));
  const leastContradicted = candidates.filter(
    ({ score }) => score.contradictions === minimumContradictions,
  );
  const maximumMatches = Math.max(...leastContradicted.map(({ score }) => score.matches));
  const selected = new Set(
    leastContradicted
      .filter(({ score }) => score.matches === maximumMatches)
      .map(({ index }) => index),
  );
  return branches.filter((_branch, index) => selected.has(index));
}

function schemaConstScore(
  schema: TSchema,
  value: unknown,
): { matches: number; contradictions: number } {
  if (Object.hasOwn(schema, "const"))
    return Value.Check(schema, value)
      ? { matches: 1, contradictions: 0 }
      : { matches: 0, contradictions: 1 };
  const properties = (schema as { properties?: Record<string, TSchema> }).properties;
  if (properties === undefined || !isRecord(value)) return { matches: 0, contradictions: 0 };
  let matches = 0;
  let contradictions = 0;
  for (const [key, property] of Object.entries(properties)) {
    if (!Object.hasOwn(value, key)) continue;
    const nested = schemaConstScore(property, value[key]);
    matches += nested.matches;
    contradictions += nested.contradictions;
  }
  return { matches, contradictions };
}

function escapeJsonPointerToken(value: string): string {
  return value.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function sanitizeDiagnosticText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "?");
}

function boundUtf8Text(
  value: string,
  maximumBytes: number,
  marker = "\n- additional mismatches omitted",
): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const available = maximumBytes - Buffer.byteLength(marker, "utf8");
  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <= available) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}${marker}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compact rendering of the allowed shapes (union branches, required fields, consts, limits). */
/**
 * Field groups that never co-occur in any branch, so the merged object can name the combinations
 * its flattened shape would otherwise advertise as legal. Only groups of two or more are worth
 * stating: a lone branch-specific field cannot be combined with a sibling from its own branch.
 */
function mutuallyExclusiveFieldGroups(branches: readonly TSchema[]): string[][] {
  const shared = new Set<string>();
  const perBranch = branches.map((branch) =>
    Object.keys((branch as { properties?: Record<string, TSchema> }).properties ?? {}),
  );
  for (const key of perBranch.flat()) {
    if (perBranch.every((keys) => keys.includes(key))) shared.add(key);
  }
  const groups = perBranch
    .map((keys) => keys.filter((key) => !shared.has(key)).sort(compareUtf8))
    .filter((group) => group.length > 0);
  const seen = new Set<string>();
  return groups.filter((group) => {
    const identity = group.join(" ");
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Provider validation reports a nested discriminated-union mismatch as repeated "type must equal
 * constant" and "spec must not have additional properties" lines without naming either the valid
 * type or the offending field. Planning Graph Seed nodes are exactly such a union. Summarize each
 * type's allowed spec keys in the tool description so a small model can correct the next complete
 * submission without reverse-engineering opaque validator output.
 */
function describeNestedDiscriminatedContracts(schema: TSchema): string[] {
  const descriptions: string[] = [];
  const visit = (candidate: unknown, path: string): void => {
    if (!isRecord(candidate)) return;
    const properties = isRecord(candidate.properties) ? candidate.properties : undefined;
    if (properties !== undefined) {
      for (const [key, property] of Object.entries(properties)) {
        visit(property, path.length === 0 ? key : `${path}.${key}`);
      }
    }
    if (candidate.type === "array" && isRecord(candidate.items)) {
      const branches = Array.isArray(candidate.items.anyOf) ? candidate.items.anyOf : undefined;
      if (branches !== undefined) {
        const variants = branches.flatMap((branch) => {
          if (!isRecord(branch) || !isRecord(branch.properties)) return [];
          const discriminator = branch.properties.type;
          const spec = branch.properties.spec;
          if (
            !isRecord(discriminator) ||
            typeof discriminator.const !== "string" ||
            !isRecord(spec) ||
            spec.additionalProperties !== false ||
            !isRecord(spec.properties)
          ) {
            return [];
          }
          const fields = Object.keys(spec.properties).sort(compareUtf8);
          return [
            `type ${JSON.stringify(discriminator.const)} allows only spec {${fields.length === 0 ? "" : ` ${fields.join(", ")} `}}`,
          ];
        });
        if (variants.length === branches.length && variants.length > 0) {
          descriptions.push(
            `${path}[] uses these exact type/spec contracts: ${variants.join("; ")}`,
          );
          return;
        }
      }
      visit(candidate.items, `${path}[]`);
    }
    if (Array.isArray(candidate.anyOf)) {
      for (const branch of candidate.anyOf) visit(branch, path);
    }
  };
  visit(schema, "");
  return descriptions;
}

function describeSchemaShape(schema: TSchema): string {
  const branches = Array.isArray((schema as { anyOf?: TSchema[] }).anyOf)
    ? (schema as { anyOf: TSchema[] }).anyOf
    : [schema];
  const rendered = branches.map((branch) => {
    const props = (
      branch as {
        properties?: Record<string, { const?: unknown; type?: string; maxLength?: number }>;
      }
    ).properties;
    if (props === undefined) return "{…}";
    const fields = Object.entries(props).map(([key, prop]) => {
      if (prop && Object.hasOwn(prop, "const")) return `${key}: ${JSON.stringify(prop.const)}`;
      const limit = prop?.maxLength === undefined ? "" : ` (≤${prop.maxLength} chars)`;
      return `${key}: ${prop?.type ?? "value"}${limit}`;
    });
    return `{ ${fields.join(", ")} }`;
  });
  return rendered.join("  OR  ");
}

function resolveToolSchema(
  name: KoniToolName,
  terminalOutputSchema?: TSchema,
  expectedSchemaHash?: Sha256Digest,
): TSchema {
  // The submit tool's advertised parameters are the transport-representable view of the terminal
  // union (see transportToolSchema); the exact union itself remains the terminal outcome contract,
  // separately hash-bound via spec.terminal.outputSchemaHash and enforced by the compiler's
  // assignment-output parse. Flattening here keeps the sealed binding consistent: the spec's
  // schemaHash, the child's exposed definition, and argument validation all derive from one place.
  const current =
    name === "koni_submit_output" && terminalOutputSchema !== undefined
      ? transportToolSchema(name, terminalOutputSchema)
      : hasLargePayloadPresentationEnvelope(name)
        ? relaxLargePayloadPresentationEnvelope(CATALOG[name].schema)
        : CATALOG[name].schema;
  if (expectedSchemaHash === undefined || canonicalHash(current) === expectedSchemaHash)
    return current;
  // Write/edit calls can carry multi-megabyte payloads. Launches issued before their Pi-facing
  // envelope became presentation-only bound the exact catalog schema directly; reconstruct that
  // strict definition without changing the authority contract used by either generation.
  if (
    hasLargePayloadPresentationEnvelope(name) &&
    canonicalHash(CATALOG[name].schema) === expectedSchemaHash
  ) {
    return CATALOG[name].schema;
  }
  // The immediately preceding transport kept the outer object exact while making nested
  // discriminators presentation-only. Preserve already-issued attempts across this upgrade.
  if (
    name === "koni_submit_output" &&
    terminalOutputSchema !== undefined &&
    canonicalHash(strictOuterTransportToolSchema(name, terminalOutputSchema)) === expectedSchemaHash
  ) {
    return strictOuterTransportToolSchema(name, terminalOutputSchema);
  }
  // Launch specs issued before the transport flatten bound the raw terminal union as the submit
  // tool's parameter schema; keep those in-flight attempts recoverable.
  if (
    name === "koni_submit_output" &&
    terminalOutputSchema !== undefined &&
    canonicalHash(legacyTransportToolSchema(name, terminalOutputSchema)) === expectedSchemaHash
  ) {
    return legacyTransportToolSchema(name, terminalOutputSchema);
  }
  if (
    name === "koni_submit_output" &&
    terminalOutputSchema !== undefined &&
    canonicalHash(terminalOutputSchema) === expectedSchemaHash
  ) {
    return terminalOutputSchema;
  }
  if (name === "koni_record_note" && canonicalHash(legacyRecordNoteSchema) === expectedSchemaHash) {
    return legacyRecordNoteSchema;
  }
  if (
    name === "koni_ask_question" &&
    canonicalHash(legacyAskQuestionSchema) === expectedSchemaHash
  ) {
    return legacyAskQuestionSchema;
  }
  throw new Error(`unsupported historical schema hash for ${name}`);
}

function hasLargePayloadPresentationEnvelope(
  name: KoniToolName,
): name is "koni_write_file" | "koni_edit_file" {
  return name === "koni_write_file" || name === "koni_edit_file";
}

/**
 * Pi validates advertised parameters before Koni and echoes the complete arguments on failure.
 * For write/edit calls that can include multi-megabyte source text, even a missing CAS field can
 * consume the remaining context without reaching the durable authority rejection. Preserve every
 * exact field name and its guidance for the provider, but leave presentation validation permissive;
 * validate the unchanged catalog schema at authority before any filesystem effect.
 */
function relaxLargePayloadPresentationEnvelope(schema: TSchema): TSchema {
  const properties = (schema as { properties?: Record<string, TSchema> }).properties;
  const visibleFields = Object.fromEntries(
    Object.entries(properties ?? {})
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([key, property]) => {
        const description = (property as { description?: unknown }).description;
        return [
          key,
          Type.Optional(
            Type.Unknown(typeof description === "string" ? { description } : undefined),
          ),
        ];
      }),
  );
  return Type.Object(visibleFields, {
    additionalProperties: true,
    description:
      "Presentation envelope only. Koni validates the exact field types, required fields, bounds, and content-hash precondition before any filesystem effect.",
  });
}

export function renderKoniToolReceipt(receipt: KoniToolReceipt): string {
  validateKoniToolReceipt(receipt);
  return JSON.stringify(
    {
      status: receipt.outcome,
      receiptId: receipt.receiptId,
      summary: receipt.summary,
      ...(receipt.outcome === "rejected" ? { code: receipt.code } : {}),
      ...(receipt.value === undefined ? {} : { value: receipt.value }),
    },
    null,
    2,
  );
}

export function koniToolResultPayloadBytes(
  result: Pick<AgentToolResult<unknown>, "content" | "details" | "terminate">,
): number {
  return Buffer.byteLength(
    canonicalEncode({
      content: result.content,
      details: result.details,
      ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
    }),
    "utf8",
  );
}

export function validateKoniToolReceipt(value: unknown): asserts value is KoniToolReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("authority tool receipt must be an object");
  }
  const receipt = value as Record<string, unknown>;
  const expected =
    receipt.outcome === "rejected"
      ? [
          "code",
          "outcome",
          "protocol",
          "receiptId",
          "summary",
          ...(receipt.value === undefined ? [] : ["value"]),
        ]
      : [
          "outcome",
          "protocol",
          "receiptId",
          "summary",
          ...(receipt.value === undefined ? [] : ["value"]),
        ];
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
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\u0000")
  );
}

function safeReceiptCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value);
}
