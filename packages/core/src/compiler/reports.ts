import YAML from "yaml";
import type { TransactionWrite } from "../authority/file-journal.js";
import type { JsonValue } from "../authority/protocol.js";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type { GraphNode, TypedGraph } from "../graph/model.js";
import { canonicalHash, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import type { RunRecord, RunReportRecord } from "../state/run-record.js";
import { GraphExpressionEvaluator } from "./expressions.js";

export interface PreparedReportArtifact extends TransactionWrite {
  ledgerId: string;
  format: "json" | "markdown" | "yaml" | "csv" | "manifest";
}

export interface PreparedReportBundle {
  report: RunReportRecord;
  artifacts: PreparedReportArtifact[];
}

interface ReportColumn {
  id: string;
  title: string;
  value: ConfigurationValue;
}

interface ReportLedger {
  id: string;
  title: string;
  formats: Array<"json" | "markdown" | "yaml" | "csv">;
  output: string;
  source: ConfigurationValue;
  filter?: ConfigurationValue;
  columns: ReportColumn[];
  rows: JsonValue[];
  hash: Sha256Digest;
}

/**
 * Compile the complete configured report bundle from one frozen run epoch.
 * No timestamp enters the output bytes, so identical graph/ticket/check state
 * produces byte-identical JSON, Markdown, YAML, CSV, and manifest artifacts.
 */
export function compileConfiguredReports(input: {
  configuration: CompiledConfiguration;
  graph: TypedGraph;
  run: RunRecord;
  compiledAt: string;
}): PreparedReportBundle {
  const evaluator = new GraphExpressionEvaluator(input.configuration, input.graph);
  const definitions = Object.entries(input.configuration.registries.reports)
    .sort(([left], [right]) => left.localeCompare(right));
  const ledgers: ReportLedger[] = definitions.map(([registryId, definition]) => {
    const id = requiredText(definition.id ?? registryId, `report ${registryId} id`);
    if (id !== registryId) throw new Error(`report registry id ${registryId} does not match ${id}`);
    const title = requiredText(definition.title ?? id, `report ${id} title`);
    const formats = reportFormats(definition.formats, id);
    const output = safeReportOutput(requiredText(definition.output, `report ${id} output`), id);
    const source = definition.source ?? "graph";
    const columns = reportColumns(definition.columns, id);
    let rows = sourceRows(source, input.configuration, input.graph, input.run, evaluator)
      .map((row) => decorateGraphRow(row, input.graph))
      .filter((row) => reportFilter(definition.filter, row, evaluator));
    rows.sort((left, right) => reportRowKey(left).localeCompare(reportRowKey(right)));
    if (columns.length > 0) {
      rows = rows.map((row) => Object.fromEntries(columns.map((column) => [
        column.id,
        projectValue(column.value, row),
      ])) as JsonValue);
    }
    return {
      id,
      title,
      formats,
      output,
      source,
      ...(definition.filter === undefined ? {} : { filter: definition.filter }),
      columns,
      rows,
      hash: canonicalHash(rows),
    };
  });

  const bundleKind = optionalText(asRecord(input.configuration.profile.reporting)?.bundle_kind)
    ?? `${input.configuration.package.profile_lineage}-report-bundle`;
  const bundleContract = Object.fromEntries(ledgers.map((ledger) => [ledger.id, {
    ledgerHash: ledger.hash,
    rowCount: ledger.rows.length,
    formats: ledger.formats,
    output: ledger.output,
  }]));
  const bundleHash = canonicalHash(bundleContract);
  const reportId = stableId("RPT", [bundleKind, bundleHash]);
  const root = `runs/${input.run.id}/program/reports/${reportId}`;
  const artifacts: PreparedReportArtifact[] = [];
  const outputs: RunReportRecord["outputs"] = [];

  for (const ledger of ledgers) {
    const data: JsonValue = {
      protocol: "koni.report-ledger.v1",
      reportId,
      ledgerId: stableId("LEDGER", [ledger.id, ledger.hash]),
      kind: ledger.id,
      rowCount: ledger.rows.length,
      ledgerHash: ledger.hash,
      bundleHash,
      rows: ledger.rows,
    };
    for (const format of ledger.formats) {
      const bytes = renderReport(format, ledger, data);
      const artifactPath = `${root}/${withExtension(ledger.output, format)}`;
      const sha256 = rawSha256(bytes);
      artifacts.push({
        path: artifactPath,
        bytes,
        expectedSha256: null,
        ledgerId: ledger.id,
        format,
      });
      outputs.push({
        ledgerId: ledger.id,
        format,
        artifactPath,
        sha256,
        sizeBytes: bytes.byteLength,
      });
    }
  }
  outputs.sort((left, right) =>
    left.ledgerId.localeCompare(right.ledgerId) || left.format.localeCompare(right.format));
  const graphHash = input.graph.hash;
  const ticketBoardHash = canonicalHash(reportTicketRows(input.run));
  const runStateHash = canonicalHash({
    graphHash,
    ticketBoardHash,
    checks: input.run.checks ?? [],
    ruleAuthorityEvidence: input.run.ruleAuthorityEvidence ?? null,
  });
  const manifestPath = `${root}/report-manifest.json`;
  const manifest: JsonValue = {
    protocol: "koni.report-manifest.v1",
    reportId,
    bundleKind,
    bundleHash,
    profileHash: input.run.compiledConfigHash,
    graphHash,
    ticketBoardHash,
    runStateHash,
    ledgerHashes: Object.fromEntries(ledgers.map((ledger) => [ledger.id, ledger.hash])),
    ledgerCounts: Object.fromEntries(ledgers.map((ledger) => [ledger.id, ledger.rows.length])),
    outputs: outputs.map((output) => ({
      ledgerId: output.ledgerId,
      format: output.format,
      artifactPath: output.artifactPath,
      sha256: output.sha256,
      sizeBytes: output.sizeBytes,
    })),
  };
  artifacts.push({
    path: manifestPath,
    bytes: stableJsonBytes(manifest),
    expectedSha256: null,
    ledgerId: "manifest",
    format: "manifest",
  });
  return {
    report: {
      protocol: "koni.report-bundle.v1",
      reportId,
      bundleKind,
      bundleHash,
      graphHash,
      ticketBoardHash,
      runStateHash,
      manifestArtifactPath: manifestPath,
      outputs,
      compiledAt: input.compiledAt,
    },
    artifacts,
  };
}

function sourceRows(
  source: ConfigurationValue,
  configuration: CompiledConfiguration,
  graph: TypedGraph,
  run: RunRecord,
  evaluator: GraphExpressionEvaluator,
): JsonValue[] {
  if (source === "graph" || typeof source !== "object" || source === null || Array.isArray(source)) {
    return graph.nodes() as unknown as JsonValue[];
  }
  const record = source as ConfigurationObject;
  if (record.tickets !== undefined) return reportTicketRows(run);
  if (typeof record.query === "string") {
    return evaluator.select({ query: record.query })
      .flatMap((id) => {
        const node = graph.node(id);
        return node === undefined ? [] : [node as unknown as JsonValue];
      });
  }
  if (typeof record.node_type === "string") {
    return graph.nodes().filter((node) => node.type === record.node_type) as unknown as JsonValue[];
  }
  if (typeof record.receipt_type === "string") {
    return reportReceiptRows(run, configuration, record.receipt_type);
  }
  if (Array.isArray(record.union)) {
    let rows = record.union.flatMap((item) => {
      const normalized = typeof item === "string" ? { query: item } : item;
      return sourceRows(normalized, configuration, graph, run, evaluator);
    });
    if (record.negative_only === true) rows = rows.filter(isNegativeRow);
    return rows;
  }
  return graph.nodes() as unknown as JsonValue[];
}

function reportTicketRows(run: RunRecord): JsonValue[] {
  return Object.values(run.tickets).sort((left, right) => left.id.localeCompare(right.id)).map((ticket) => {
    const attempts = ticket.steps.flatMap((step) => step.attemptIds)
      .flatMap((id) => run.attempts[id] === undefined ? [] : [run.attempts[id]!]);
    return jsonValue({
      ...ticket,
      ticket_id: ticket.id,
      operation: ticket.operationId,
      target_nodes: ticket.targetNodeIds,
      steering: attempts.flatMap((attempt) => attempt.authorityMessages ?? []),
      step_outputs: ticket.steps.filter((step) => step.summary !== undefined).length,
      scope_warnings: [],
      review_result: { status: ticket.status === "completed" ? "accepted" : ticket.status },
    });
  });
}

function reportReceiptRows(
  run: RunRecord,
  configuration: CompiledConfiguration,
  receiptType: string,
): JsonValue[] {
  return (run.checks ?? []).flatMap((check) => {
    const definition = configuration.registries.checks[check.requestedCheckId];
    const configuredType = optionalText(definition?.receipt_type) ??
      optionalText(asRecord(definition?.command)?.receipt_type) ?? "check.receipt";
    if (configuredType !== receiptType) return [];
    const attempt = run.attempts[check.attemptId];
    return [jsonValue({
      id: check.id,
      receipt_id: check.id,
      receipt_type: configuredType,
      ticket_id: attempt?.ticketId ?? null,
      status: check.accepted ? "passed" : "failed",
      verdict: check.accepted ? "passed" : "failed",
      exit_code: check.commands.at(-1)?.exitCode ?? null,
      runtime: check.commands.map((command) => command.sandboxKind),
      command: check.commands.map((command) => [command.resolvedExecutable, ...command.argv.slice(1)]),
      summary: check.summary,
      targets: attempt === undefined ? [] : run.tickets[attempt.ticketId]?.targetNodeIds ?? [],
    })];
  });
}

function decorateGraphRow(row: JsonValue, graph: TypedGraph): JsonValue {
  if (!isRecord(row) || typeof row.id !== "string") return row;
  const node = graph.node(row.id);
  if (node === undefined || node.type !== "claim") return row;
  const related = graph.nodes().filter((candidate) => candidate.type === "evidence" &&
    ["supports", "contradicts", "informs"].some((relation) =>
      (candidate.edges[relation] ?? []).includes(node.id)));
  return jsonValue({
    ...row,
    derived: {
      support_count: related.filter((candidate) => (candidate.edges.supports ?? []).includes(node.id)).length,
      contradiction_count: related.filter((candidate) => (candidate.edges.contradicts ?? []).includes(node.id)).length,
      inform_count: related.filter((candidate) => (candidate.edges.informs ?? []).includes(node.id)).length,
    },
  });
}

function reportFilter(
  filter: ConfigurationValue | undefined,
  row: JsonValue,
  evaluator: GraphExpressionEvaluator,
): boolean {
  if (filter === undefined) return true;
  if (!isRecord(row) || typeof row.id !== "string" || evaluator.node(row.id) === undefined) return false;
  return evaluator.withBinding("row", [row.id], () => evaluator.evaluate(filter));
}

function reportColumns(value: ConfigurationValue | undefined, reportId: string): ReportColumn[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`report ${reportId} columns must be a list`);
  return value.map((item, index) => {
    const column = asRecord(item);
    if (column === undefined) throw new Error(`report ${reportId} column ${index + 1} is invalid`);
    const id = requiredText(column.id, `report ${reportId} column id`);
    return {
      id,
      title: optionalText(column.title) ?? id,
      value: column.value ?? null,
    };
  });
}

function reportFormats(value: ConfigurationValue | undefined, reportId: string): ReportLedger["formats"] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`report ${reportId} has no output formats`);
  const allowed = new Set<ReportLedger["formats"][number]>(["json", "markdown", "yaml", "csv"]);
  return value.map((format) => {
    if (typeof format !== "string" || !allowed.has(format as ReportLedger["formats"][number])) {
      throw new Error(`report ${reportId} has unsupported format ${String(format)}`);
    }
    return format as ReportLedger["formats"][number];
  });
}

function renderReport(format: ReportLedger["formats"][number], ledger: ReportLedger, data: JsonValue): Buffer {
  if (format === "json") return stableJsonBytes(data);
  if (format === "yaml") return Buffer.from(YAML.stringify(sortJson(data), { lineWidth: 0 }), "utf8");
  if (format === "csv") return Buffer.from(renderCsv(ledger.rows), "utf8");
  return Buffer.from(renderMarkdown(ledger), "utf8");
}

function renderMarkdown(ledger: ReportLedger): string {
  const columns = ledger.columns.length > 0
    ? ledger.columns.map((column) => [column.id, column.title] as const)
    : [...new Set(ledger.rows.flatMap((row) => isRecord(row) ? Object.keys(row) : []))]
      .sort().map((id) => [id, id] as const);
  let output = `# ${ledger.title}\n\n`;
  if (columns.length === 0) return `${output}No rows.\n`;
  output += `| ${columns.map(([, title]) => title).join(" | ")} |\n`;
  output += `| ${columns.map(() => "---").join(" | ")} |\n`;
  if (ledger.rows.length === 0) {
    output += `| ${columns.map((_, index) => index === 0 ? "no rows" : "-").join(" | ")} |\n`;
  }
  for (const row of ledger.rows) {
    output += `| ${columns.map(([id]) => markdownCell(isRecord(row) ? row[id] ?? null : null)).join(" | ")} |\n`;
  }
  return output;
}

function renderCsv(rows: readonly JsonValue[]): string {
  const columns = [...new Set(rows.flatMap((row) => isRecord(row) ? Object.keys(row) : []))].sort();
  const lines = [columns.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(cellText(isRecord(row) ? row[column] ?? null : null))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function projectValue(expression: ConfigurationValue, row: JsonValue): JsonValue {
  if (typeof expression !== "string" || !expression.startsWith("$row")) return jsonValue(expression);
  const path = expression.slice("$row".length).replace(/^\./u, "").split(".").filter(Boolean);
  let cursor: JsonValue | undefined = row;
  for (const segment of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
    if (cursor === undefined) return null;
  }
  return cursor ?? null;
}

function reportRowKey(row: JsonValue): string {
  if (!isRecord(row)) return JSON.stringify(sortJson(row));
  return [
    optionalText(row.type ?? row.node_type) ?? "row",
    optionalText(row.status) ?? "",
    optionalText(row.id ?? row.ticket_id ?? row.receipt_id) ?? "",
    JSON.stringify(sortJson(row)),
  ].join("\0");
}

function isNegativeRow(row: JsonValue): boolean {
  if (!isRecord(row)) return false;
  const values = [row.status, row.verdict, asRecord(row.spec)?.polarity]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLocaleLowerCase());
  return values.some((value) => ["failed", "rejected", "contradicts", "negative", "blocked"].includes(value));
}

function withExtension(output: string, format: ReportLedger["formats"][number]): string {
  const extension = format === "markdown" ? "md" : format;
  const slash = output.lastIndexOf("/");
  const dot = output.lastIndexOf(".");
  return dot > slash ? `${output.slice(0, dot)}.${extension}` : `${output}.${extension}`;
}

function safeReportOutput(value: string, id: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 || normalized.startsWith("/") || normalized === ".." ||
    normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("\0")
  ) throw new Error(`report ${id} output escapes its compiler artifact namespace`);
  return normalized;
}

function stableId(prefix: string, parts: readonly string[]): string {
  return `${prefix}-${rawSha256(parts.join("|")).slice("sha256:".length, "sha256:".length + 12)}`;
}

function stableJsonBytes(value: JsonValue): Buffer {
  return Buffer.from(`${JSON.stringify(sortJson(value), null, 2)}\n`, "utf8");
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key]!)]));
  }
  return value;
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return null;
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, jsonValue(child)]));
  }
  return String(value);
}

function markdownCell(value: JsonValue): string {
  return cellText(value).replaceAll("|", "\\|").replaceAll("\n", " ") || "-";
}

function cellText(value: JsonValue): string {
  if (value === null) return "-";
  if (typeof value === "string") return value.length === 0 ? "-" : value;
  if (Array.isArray(value)) return value.map(cellText).join(", ") || "-";
  return JSON.stringify(sortJson(value));
}

function csvCell(value: string): string {
  return /[,"\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return asRecord(value) !== undefined;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is missing`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
