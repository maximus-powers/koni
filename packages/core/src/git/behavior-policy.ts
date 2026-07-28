import path from "node:path";
import { canonicalHash, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import {
  DiagnosticBag,
  validationFailure,
  validationSuccess,
  type ValidationResult,
} from "../shared/diagnostics.js";

export const GIT_BEHAVIOR_POLICY_PROTOCOL = "koni.git-behavior-policy.v1" as const;

export type GitIntegrationStrategy = "squash" | "merge";

export interface GitBehaviorPolicyMaterial {
  protocol: typeof GIT_BEHAVIOR_POLICY_PROTOCOL;
  enabled: true;
  backend: "git_cli";
  targetSelection: {
    /** A presentation/default-selection hint. The operator-selected ref always remains authoritative. */
    default: "current" | { ref: string };
  };
  refs: {
    /** Branch-name template, without the `refs/heads/` prefix. */
    run: string;
    /** Branch-name template, without the `refs/heads/` prefix. */
    ticket: string;
  };
  worktrees: {
    /** Safe Koni-relative path within this repository's managed-worktree namespace. */
    root: string;
  };
  integration: {
    strategy: GitIntegrationStrategy;
  };
  commits: {
    subject: string;
    trailers: Readonly<Record<string, string>>;
  };
}

/** Fully validated and hash-bound behavior supplied to each new run by the compiler. */
export interface GitBehaviorPolicy extends GitBehaviorPolicyMaterial {
  policySha256: Sha256Digest;
}

export interface CompileGitBehaviorPolicyInput {
  profileGit: unknown;
  runTypeGit: unknown;
  /** Diagnostic roots used by the configuration compiler. */
  profilePath?: string;
  runTypePath?: string;
}

export interface GitRunTemplateContext {
  id: string;
  slug: string;
  shortId: string;
  profileHash: string;
}

export interface GitTicketTemplateContext {
  id: string;
  cycleId: string;
  operation: string;
  title: string;
  reviewId?: string;
}

export interface GitRunAdmission {
  policy: GitBehaviorPolicy;
  run: GitRunTemplateContext;
}

const PROFILE_FIELDS = new Set([
  "enabled",
  "backend",
  "integration_branch",
  "branch_template",
  "ticket_branch_template",
  "worktree_root",
  "integration_strategy",
  "commit_template",
  "commit_trailers",
]);
const RUN_TYPE_FIELDS = new Set(["branch_template", "ticket_branch_template"]);
const RUN_REF_VARIABLES = new Set(["run.id", "run.slug", "run.short_id"]);
const TICKET_REF_VARIABLES = new Set([
  "run.id",
  "run.slug",
  "run.short_id",
  "ticket.id",
  "cycle.id",
]);
const COMMIT_SUBJECT_VARIABLES = new Set(["ticket.operation", "ticket.title"]);
const COMMIT_TRAILER_VARIABLES = new Set([
  "run.id",
  "ticket.id",
  "cycle.id",
  "profile.hash",
  "review.id",
]);
const RESERVED_TRAILERS = new Set([
  "Koni-Run",
  "Koni-Ticket",
  "Koni-Cycle",
  "Koni-Ticket-Head",
  "Koni-Target",
]);
const MAX_TEMPLATE_BYTES = 8 * 1024;

/**
 * Compile the exact schema-2 profile/run-type Git behavior into one immutable runtime policy.
 *
 * This helper deliberately returns ordinary compiler diagnostics instead of throwing so the
 * configuration compiler can merge these errors into its single admission report. It accepts no
 * historical aliases: source migration is explicit, while already-created lifecycle records use
 * their own compatibility path.
 */
export function compileGitBehaviorPolicy(
  input: CompileGitBehaviorPolicyInput,
): ValidationResult<GitBehaviorPolicy> {
  const bag = new DiagnosticBag();
  const profilePath = input.profilePath ?? "/profile/git";
  const runTypePath = input.runTypePath ?? "/run_type/git";
  const profile = exactObject(input.profileGit, profilePath, PROFILE_FIELDS, bag);
  const runType = exactObject(input.runTypeGit, runTypePath, RUN_TYPE_FIELDS, bag);

  const enabled = booleanField(profile, "enabled", profilePath, bag);
  if (enabled === false) {
    bag.error(
      "git_policy.disabled_unsupported",
      `${profilePath}/enabled`,
      "Pi-native Koni runs require isolated Git worktrees; enabled:false is not a supported run backend",
    );
  }
  const backend = stringField(profile, "backend", profilePath, bag);
  if (backend !== undefined && backend !== "git_cli") {
    bag.error(
      "git_policy.unsupported_backend",
      `${profilePath}/backend`,
      `native Koni supports only the authenticated git_cli backend, not ${JSON.stringify(backend)}`,
    );
  }

  const integrationBranch = stringField(profile, "integration_branch", profilePath, bag);
  const targetDefault =
    integrationBranch === undefined
      ? undefined
      : parseTargetDefault(integrationBranch, `${profilePath}/integration_branch`, bag);
  const runTemplate = inheritedString(
    runType,
    profile,
    "branch_template",
    runTypePath,
    profilePath,
    bag,
  );
  const ticketTemplate = inheritedString(
    runType,
    profile,
    "ticket_branch_template",
    runTypePath,
    profilePath,
    bag,
  );
  const worktreeRoot = stringField(profile, "worktree_root", profilePath, bag);
  const strategy = stringField(profile, "integration_strategy", profilePath, bag);
  const subjectTemplate = stringField(profile, "commit_template", profilePath, bag);
  const trailers = trailerRecord(profile.commit_trailers, `${profilePath}/commit_trailers`, bag);

  if (runTemplate !== undefined) {
    const variables = validateTemplate(
      runTemplate,
      `${runTypePath}/branch_template`,
      RUN_REF_VARIABLES,
      bag,
    );
    if (!runTemplate.startsWith("koni/")) {
      bag.error(
        "git_policy.ref_namespace",
        `${runTypePath}/branch_template`,
        "run branches must remain beneath the reserved koni/ namespace",
      );
    }
    if (!(
      variables.has("run.id") ||
      (variables.has("run.slug") && variables.has("run.short_id"))
    )) {
      bag.error(
        "git_policy.run_ref_identity",
        `${runTypePath}/branch_template`,
        "run branch template must contain run.id or both run.slug and run.short_id",
      );
    }
    validateRenderedRefTemplate(runTemplate, `${runTypePath}/branch_template`, bag);
  }
  if (ticketTemplate !== undefined) {
    const variables = validateTemplate(
      ticketTemplate,
      `${runTypePath}/ticket_branch_template`,
      TICKET_REF_VARIABLES,
      bag,
    );
    if (!ticketTemplate.startsWith("koni/")) {
      bag.error(
        "git_policy.ref_namespace",
        `${runTypePath}/ticket_branch_template`,
        "ticket branches must remain beneath the reserved koni/ namespace",
      );
    }
    for (const required of ["run.id", "ticket.id", "cycle.id"] as const) {
      if (!variables.has(required)) {
        bag.error(
          "git_policy.ticket_ref_identity",
          `${runTypePath}/ticket_branch_template`,
          `ticket branch template must contain ${required}`,
        );
      }
    }
    validateRenderedRefTemplate(ticketTemplate, `${runTypePath}/ticket_branch_template`, bag);
  }
  if (worktreeRoot !== undefined)
    validateWorktreeRoot(worktreeRoot, `${profilePath}/worktree_root`, bag);
  if (strategy !== undefined && strategy !== "squash" && strategy !== "merge") {
    bag.error(
      "git_policy.unsupported_strategy",
      `${profilePath}/integration_strategy`,
      "integration strategy must be squash or merge",
    );
  }
  if (subjectTemplate !== undefined) {
    validateTemplate(
      subjectTemplate,
      `${profilePath}/commit_template`,
      COMMIT_SUBJECT_VARIABLES,
      bag,
    );
    if (/[\r\n]/u.test(subjectTemplate)) {
      bag.error(
        "git_policy.commit_subject",
        `${profilePath}/commit_template`,
        "commit subject template must be one line",
      );
    }
  }
  for (const [token, template] of Object.entries(trailers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/u.test(token)) {
      bag.error(
        "git_policy.trailer_token",
        `${profilePath}/commit_trailers/${escapePointer(token)}`,
        "commit trailer token is malformed",
      );
    }
    if (RESERVED_TRAILERS.has(token)) {
      bag.error(
        "git_policy.reserved_trailer",
        `${profilePath}/commit_trailers/${escapePointer(token)}`,
        `${token} is owned by the Git authority`,
      );
    }
    validateTemplate(
      template,
      `${profilePath}/commit_trailers/${escapePointer(token)}`,
      COMMIT_TRAILER_VARIABLES,
      bag,
    );
    if (/[\r\n]/u.test(template)) {
      bag.error(
        "git_policy.trailer_template",
        `${profilePath}/commit_trailers/${escapePointer(token)}`,
        "commit trailer template must be one line",
      );
    }
  }
  if (runTemplate !== undefined && ticketTemplate !== undefined) {
    validateRefNamespaceSeparation(
      runTemplate,
      ticketTemplate,
      `${runTypePath}/ticket_branch_template`,
      bag,
    );
  }

  if (
    bag.hasErrors() ||
    enabled !== true ||
    backend !== "git_cli" ||
    targetDefault === undefined ||
    runTemplate === undefined ||
    ticketTemplate === undefined ||
    worktreeRoot === undefined ||
    (strategy !== "squash" && strategy !== "merge") ||
    subjectTemplate === undefined ||
    trailers === undefined
  ) {
    return validationFailure(bag.sorted());
  }

  const material: GitBehaviorPolicyMaterial = {
    protocol: GIT_BEHAVIOR_POLICY_PROTOCOL,
    enabled: true,
    backend: "git_cli",
    targetSelection: { default: targetDefault },
    refs: { run: runTemplate, ticket: ticketTemplate },
    worktrees: { root: worktreeRoot },
    integration: { strategy },
    commits: { subject: subjectTemplate, trailers: sortRecord(trailers) },
  };
  const policy = deepFreeze({ ...material, policySha256: canonicalHash(material) });
  return validationSuccess(policy, bag.sorted());
}

export function assertGitBehaviorPolicy(value: unknown): asserts value is GitBehaviorPolicy {
  if (!isObject(value) || value.protocol !== GIT_BEHAVIOR_POLICY_PROTOCOL) {
    throw new Error("Git behavior policy protocol is missing or unsupported");
  }
  const result = compileGitBehaviorPolicy({
    profileGit: {
      enabled: value.enabled,
      backend: value.backend,
      integration_branch:
        isObject(value.targetSelection) && value.targetSelection.default === "current"
          ? "current"
          : isObject(value.targetSelection) && isObject(value.targetSelection.default)
            ? value.targetSelection.default.ref
            : undefined,
      branch_template: isObject(value.refs) ? value.refs.run : undefined,
      ticket_branch_template: isObject(value.refs) ? value.refs.ticket : undefined,
      worktree_root: isObject(value.worktrees) ? value.worktrees.root : undefined,
      integration_strategy: isObject(value.integration) ? value.integration.strategy : undefined,
      commit_template: isObject(value.commits) ? value.commits.subject : undefined,
      commit_trailers: isObject(value.commits) ? value.commits.trailers : undefined,
    },
    runTypeGit: {
      branch_template: isObject(value.refs) ? value.refs.run : undefined,
      ticket_branch_template: isObject(value.refs) ? value.refs.ticket : undefined,
    },
  });
  if (!result.ok) {
    throw new Error(
      `Git behavior policy is invalid: ${result.diagnostics.map((item) => item.message).join("; ")}`,
    );
  }
  if (typeof value.policySha256 !== "string" || value.policySha256 !== result.value.policySha256) {
    throw new Error("Git behavior policy hash does not match its material");
  }
  if (canonicalHash(value) !== canonicalHash(result.value)) {
    throw new Error("Git behavior policy contains unknown or non-canonical material");
  }
}

export function createGitRunTemplateContext(input: {
  id: string;
  objective: string;
  profileHash: string;
}): GitRunTemplateContext {
  assertNamespaceValue(input.id, "run ID");
  if (
    input.objective.length === 0 ||
    input.objective.length > 4 * 1024 * 1024 ||
    input.objective.includes("\0")
  ) {
    throw new Error("run objective is empty, too large, or contains NUL");
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.profileHash)) {
    throw new Error("profile hash is not a SHA-256 digest");
  }
  const digest = rawSha256(input.id).slice("sha256:".length);
  return Object.freeze({
    id: input.id,
    slug: objectiveSlug(input.objective),
    shortId: digest.slice(0, 12),
    profileHash: input.profileHash,
  });
}

/** Construct the exact immutable ticket values used by ref, subject, and trailer templates. */
export function createGitTicketTemplateContext(
  input: GitTicketTemplateContext,
): GitTicketTemplateContext {
  const context: GitTicketTemplateContext = {
    id: input.id,
    cycleId: input.cycleId,
    operation: input.operation,
    title: input.title,
    ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
  };
  assertGitTicketTemplateContext(context);
  return Object.freeze(context);
}

export function renderRunRef(policy: GitBehaviorPolicy, run: GitRunTemplateContext): string {
  assertGitBehaviorPolicy(policy);
  assertGitRunTemplateContext(run);
  return branchRef(renderTemplate(policy.refs.run, templateValues(run)));
}

export function renderTicketRef(
  policy: GitBehaviorPolicy,
  run: GitRunTemplateContext,
  ticket: GitTicketTemplateContext,
): string {
  assertGitBehaviorPolicy(policy);
  assertGitRunTemplateContext(run);
  assertGitTicketTemplateContext(ticket);
  return branchRef(renderTemplate(policy.refs.ticket, templateValues(run, ticket)));
}

/**
 * Return the compiler-owned external root shared by all new managed worktrees for one repository.
 *
 * Worktrees cannot live below `.git`: developer tools such as Vite deny every `.git` subtree by default,
 * which makes real files in those worktrees appear to be missing. The canonical common-directory
 * digest prevents repositories with the same basename from sharing authority.
 */
export function resolveRepositoryWorktreeNamespaceRoot(commonDirectory: string): string {
  if (!path.isAbsolute(commonDirectory)) throw new Error("Git common directory must be absolute");
  const common = path.resolve(commonDirectory);
  const repositoryRoot = path.basename(common) === ".git" ? path.dirname(common) : common;
  const parent = path.dirname(repositoryRoot);
  const readable =
    path
      .basename(repositoryRoot)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "repository";
  const digest = rawSha256(common).slice("sha256:".length, "sha256:".length + 16);
  return path.join(parent, ".koni-worktrees", `${readable}-${digest}`);
}

export function resolvePolicyWorktreeRoot(
  commonDirectory: string,
  policy: GitBehaviorPolicy,
): string {
  assertGitBehaviorPolicy(policy);
  const namespace = resolveRepositoryWorktreeNamespaceRoot(commonDirectory);
  const resolved = path.resolve(namespace, ...policy.worktrees.root.split("/"));
  if (!isInside(namespace, resolved))
    throw new Error("Git policy worktree root escapes its managed namespace");
  return resolved;
}

/** Compatibility-only resolver for policy-backed runs issued before external worktree placement. */
export function resolveLegacyPolicyWorktreeRoot(
  commonDirectory: string,
  policy: GitBehaviorPolicy,
): string {
  assertGitBehaviorPolicy(policy);
  if (!path.isAbsolute(commonDirectory)) throw new Error("Git common directory must be absolute");
  const resolved = path.resolve(commonDirectory, ...policy.worktrees.root.split("/"));
  if (!isInside(commonDirectory, resolved))
    throw new Error("legacy Git policy worktree root escapes the common directory");
  return resolved;
}

export function renderTicketCommitSubject(
  policy: GitBehaviorPolicy,
  run: GitRunTemplateContext,
  ticket: GitTicketTemplateContext,
): string {
  assertGitBehaviorPolicy(policy);
  assertGitRunTemplateContext(run);
  assertGitTicketTemplateContext(ticket);
  const rendered = renderTemplate(policy.commits.subject, templateValues(run, ticket)).trim();
  if (rendered.length === 0 || rendered.length > MAX_TEMPLATE_BYTES || /[\0\r\n]/u.test(rendered)) {
    throw new Error("rendered commit subject must be one bounded non-empty line");
  }
  return rendered;
}

export function renderConfiguredCommitTrailers(
  policy: GitBehaviorPolicy,
  run: GitRunTemplateContext,
  ticket: GitTicketTemplateContext,
): Readonly<Record<string, string>> {
  assertGitBehaviorPolicy(policy);
  assertGitRunTemplateContext(run);
  assertGitTicketTemplateContext(ticket);
  const values = templateValues(run, ticket);
  const output: Record<string, string> = {};
  for (const [token, template] of Object.entries(policy.commits.trailers)) {
    const missing = templateVariableNames(template).filter(
      (variable) => values[variable] === undefined,
    );
    if (missing.length === 1 && missing[0] === "review.id") {
      // Review identity is not available at worker checkpoint time and is optional even at
      // publication when a profile has no independent reviewer. Omit that complete trailer rather
      // than emitting an invented value; every other missing variable remains an error.
      continue;
    }
    if (missing.length > 0) throw new Error(`template value is unavailable: ${missing.join(", ")}`);
    const rendered = renderTemplate(template, values).trim();
    if (
      rendered.length === 0 ||
      rendered.length > MAX_TEMPLATE_BYTES ||
      /[\0\r\n]/u.test(rendered)
    ) {
      throw new Error(`rendered commit trailer ${token} is empty, too large, or multiline`);
    }
    output[token] = rendered;
  }
  return Object.freeze(sortRecord(output));
}

function templateVariableNames(template: string): string[] {
  return [
    ...new Set(
      [...template.matchAll(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gu)].map((match) => match[1]!),
    ),
  ];
}

function exactObject(
  value: unknown,
  at: string,
  allowed: ReadonlySet<string>,
  bag: DiagnosticBag,
): Record<string, unknown> {
  if (!isObject(value)) {
    bag.error("git_policy.object", at, "Git behavior must be an object");
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      bag.error(
        "git_policy.unknown_field",
        `${at}/${escapePointer(key)}`,
        "unknown Git behavior field",
      );
  }
  return value;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
  at: string,
  bag: DiagnosticBag,
): boolean | undefined {
  const value = record[key];
  if (typeof value !== "boolean") {
    bag.error("git_policy.field_type", `${at}/${key}`, `${key} must be a boolean`);
    return undefined;
  }
  return value;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
  at: string,
  bag: DiagnosticBag,
): string | undefined {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TEMPLATE_BYTES ||
    value.includes("\0")
  ) {
    bag.error("git_policy.field_type", `${at}/${key}`, `${key} must be a bounded non-empty string`);
    return undefined;
  }
  return value;
}

function inheritedString(
  runType: Record<string, unknown>,
  profile: Record<string, unknown>,
  key: string,
  runTypePath: string,
  profilePath: string,
  bag: DiagnosticBag,
): string | undefined {
  if (runType[key] !== undefined) return stringField(runType, key, runTypePath, bag);
  return stringField(profile, key, profilePath, bag);
}

function trailerRecord(
  value: unknown,
  at: string,
  bag: DiagnosticBag,
): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!isObject(value)) {
    bag.error(
      "git_policy.trailer_object",
      at,
      "commit_trailers must be an object of string templates",
    );
    return undefined;
  }
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item !== "string" ||
      item.length === 0 ||
      Buffer.byteLength(item, "utf8") > MAX_TEMPLATE_BYTES ||
      item.includes("\0")
    ) {
      bag.error(
        "git_policy.trailer_template",
        `${at}/${escapePointer(key)}`,
        "commit trailer must be a bounded non-empty string template",
      );
    } else {
      output[key] = item;
    }
  }
  return output;
}

function parseTargetDefault(
  value: string,
  at: string,
  bag: DiagnosticBag,
): "current" | { ref: string } | undefined {
  if (value === "current") return "current";
  try {
    return {
      ref: branchRef(value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value),
    };
  } catch (error) {
    bag.error(
      "git_policy.integration_branch",
      at,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

function validateTemplate(
  template: string,
  at: string,
  allowed: ReadonlySet<string>,
  bag: DiagnosticBag,
): Set<string> {
  const variables = new Set<string>();
  const spans: Array<[number, number]> = [];
  const expression = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gu;
  for (const match of template.matchAll(expression)) {
    const variable = match[1]!;
    variables.add(variable);
    spans.push([match.index, match.index + match[0].length]);
    if (!allowed.has(variable)) {
      bag.error(
        "git_policy.template_variable",
        at,
        `template variable is not allowed here: ${variable}`,
      );
    }
  }
  let literal = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    literal += template.slice(cursor, start);
    cursor = end;
  }
  literal += template.slice(cursor);
  if (literal.includes("{{") || literal.includes("}}")) {
    bag.error(
      "git_policy.template_syntax",
      at,
      "template contains an invalid or unclosed placeholder",
    );
  }
  return variables;
}

function validateWorktreeRoot(value: string, at: string, bag: DiagnosticBag): void {
  const first = value.split("/")[0] ?? "";
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.endsWith("/") ||
    value
      .split("/")
      .some((component) => component.length === 0 || component === "." || component === "..") ||
    path.posix.normalize(value) !== value ||
    !/^\.?koni(?:[-_.]|$)/u.test(first)
  ) {
    bag.error(
      "git_policy.worktree_root",
      at,
      "worktree_root must be a normalized, reserved Koni-relative path within the managed-worktree namespace",
    );
  }
}

function validateRenderedRefTemplate(template: string, at: string, bag: DiagnosticBag): void {
  try {
    branchRef(
      renderTemplate(template, {
        "run.id": "run-id",
        "run.slug": "run-slug",
        "run.short_id": "0123456789ab",
        "ticket.id": "ticket-id",
        "cycle.id": "cycle-id",
      }),
    );
  } catch (error) {
    bag.error(
      "git_policy.ref_template",
      at,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Git stores refs as files. A rendered leaf such as `koni/runs/R` therefore cannot coexist with
 * `koni/runs/R/tickets/T`. Compare the complete segment domains, treating placeholders as
 * potentially equal unless fixed literals prove otherwise, so custom templates fail before Git.
 */
function validateRefNamespaceSeparation(
  runTemplate: string,
  ticketTemplate: string,
  at: string,
  bag: DiagnosticBag,
): void {
  const run = runTemplate.split("/");
  const ticket = ticketTemplate.split("/");
  if (templateSegmentsMayPrefix(run, ticket) || templateSegmentsMayPrefix(ticket, run)) {
    bag.error(
      "git_policy.ref_namespace_collision",
      at,
      "run and ticket branch templates may render as the same ref or as a Git leaf/prefix pair; place them beneath distinct literal sibling segments",
    );
  }
}

function templateSegmentsMayPrefix(
  prefix: readonly string[],
  candidate: readonly string[],
): boolean {
  return (
    prefix.length <= candidate.length &&
    prefix.every((segment, index) => templateSegmentsMayEqual(segment, candidate[index]!))
  );
}

function templateSegmentsMayEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const leftDynamic = left.includes("{{");
  const rightDynamic = right.includes("{{");
  if (!leftDynamic && !rightDynamic) return false;
  if (!leftDynamic) return literalMatchesTemplate(left, right);
  if (!rightDynamic) return literalMatchesTemplate(right, left);

  const leftPrefix = templateFixedPrefix(left);
  const rightPrefix = templateFixedPrefix(right);
  if (
    leftPrefix.length > 0 &&
    rightPrefix.length > 0 &&
    !(leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix))
  )
    return false;
  const leftSuffix = templateFixedSuffix(left);
  const rightSuffix = templateFixedSuffix(right);
  if (
    leftSuffix.length > 0 &&
    rightSuffix.length > 0 &&
    !(leftSuffix.endsWith(rightSuffix) || rightSuffix.endsWith(leftSuffix))
  )
    return false;
  return true;
}

function literalMatchesTemplate(literal: string, template: string): boolean {
  const expression = template
    .split(/(\{\{\s*[a-z_]+\.[a-z_]+\s*\}\})/gu)
    .map((part) => (part.startsWith("{{") ? "[A-Za-z0-9._-]+" : escapeRegExp(part)))
    .join("");
  return new RegExp(`^${expression}$`, "u").test(literal);
}

function templateFixedPrefix(template: string): string {
  const index = template.indexOf("{{");
  return index < 0 ? template : template.slice(0, index);
}

function templateFixedSuffix(template: string): string {
  const index = template.lastIndexOf("}}");
  return index < 0 ? template : template.slice(index + 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function renderTemplate(
  template: string,
  values: Readonly<Record<string, string | undefined>>,
): string {
  return template.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gu, (_match, variable: string) => {
    const value = values[variable];
    if (value === undefined) throw new Error(`template value is unavailable: ${variable}`);
    return value;
  });
}

function templateValues(
  run: GitRunTemplateContext,
  ticket?: GitTicketTemplateContext,
): Readonly<Record<string, string | undefined>> {
  return {
    "run.id": run.id,
    "run.slug": run.slug,
    "run.short_id": run.shortId,
    "profile.hash": run.profileHash,
    "ticket.id": ticket?.id,
    "ticket.operation": ticket?.operation,
    "ticket.title": ticket?.title,
    "cycle.id": ticket?.cycleId,
    "review.id": ticket?.reviewId,
  };
}

function branchRef(value: string): string {
  if (
    value.length === 0 ||
    value.length > 1_000 ||
    value === "@" ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\u0000-\u0020\u007f~^:?*\\[\]]/u.test(value) ||
    value
      .split("/")
      .some(
        (component) =>
          component.length === 0 ||
          component === "." ||
          component.startsWith(".") ||
          component.startsWith("-") ||
          component.endsWith(".") ||
          component.endsWith(".lock"),
      )
  ) {
    throw new Error(`rendered Git branch is malformed: ${value}`);
  }
  return `refs/heads/${value}`;
}

export function assertGitRunTemplateContext(
  value: unknown,
): asserts value is GitRunTemplateContext {
  if (!isObject(value) || !hasExactKeys(value, ["id", "slug", "shortId", "profileHash"])) {
    throw new Error("run template context is not an exact object");
  }
  if (typeof value.id !== "string") throw new Error("run ID must be a string");
  assertNamespaceValue(value.id, "run ID");
  if (
    typeof value.slug !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.slug)
  ) {
    throw new Error("run slug is malformed");
  }
  if (typeof value.shortId !== "string" || !/^[0-9a-f]{12}$/u.test(value.shortId)) {
    throw new Error("run short ID is malformed");
  }
  if (typeof value.profileHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.profileHash)) {
    throw new Error("profile hash is malformed");
  }
}

export function assertGitTicketTemplateContext(
  value: unknown,
): asserts value is GitTicketTemplateContext {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["id", "cycleId", "operation", "title", "reviewId"], ["reviewId"])
  ) {
    throw new Error("ticket template context is not an exact object");
  }
  if (typeof value.id !== "string" || typeof value.cycleId !== "string") {
    throw new Error("ticket and cycle IDs must be strings");
  }
  assertNamespaceValue(value.id, "ticket ID");
  assertNamespaceValue(value.cycleId, "ticket cycle ID");
  for (const [label, candidate] of [
    ["ticket operation", value.operation],
    ["ticket title", value.title],
  ] as const) {
    if (typeof candidate !== "string") throw new Error(`${label} must be a string`);
    const text = candidate;
    if (
      text.length === 0 ||
      Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_BYTES ||
      text.includes("\0")
    ) {
      throw new Error(`${label} is empty, too large, or contains NUL`);
    }
  }
  if (
    value.reviewId !== undefined &&
    (typeof value.reviewId !== "string" ||
      value.reviewId.length === 0 ||
      /[\0\r\n]/u.test(value.reviewId))
  ) {
    throw new Error("review ID is malformed");
  }
}

function assertNamespaceValue(value: string, label: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value) ||
    value.includes("..") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    throw new Error(`${label} is not safe for a Git namespace`);
  }
}

function objectiveSlug(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return slug.length === 0 ? "run" : slug;
}

function sortRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  return (
    keys.every((key) => allowedSet.has(key)) &&
    allowed.every((key) => optionalSet.has(key) || Object.hasOwn(value, key))
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
