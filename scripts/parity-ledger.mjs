#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CASE_ID = /^KPAR-[A-Z]{3,4}-[0-9]{4}$/;
const ISSUE_ID = /^KBUG-[A-Z]{3,4}-[0-9]{4}$/;
const ACTION_ID = /^S[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CHECKPOINT_ID = /^C[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSERTION_ID = /^A[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const ACTION_OPERATIONS = new Set([
  "project.create", "project.install_profile", "project.upgrade_profile", "config.write_overlay",
  "git.create_branch", "git.checkout_branch", "git.inject_conflict",
  "run.create", "run.answer_question", "run.approve_plan", "run.revise_plan", "run.pause", "run.resume", "run.delete", "run.merge",
  "authority.tick", "authority.crash", "authority.restart",
  "agent.complete", "agent.fail", "agent.steer",
  "broker.call", "broker.replay",
  "ticket.submit", "ticket.review", "ticket.close",
  "compiler.compile", "compiler.reconcile",
  "session.emit", "session.compact", "session.restart",
  "tui.resize", "tui.focus", "tui.input",
  "capture.collect"
]);

const SURFACES = new Set([
  "profile", "config", "graph", "tickets", "run_state", "events", "questions", "plans", "agents", "grants", "receipts", "journal", "git", "worktrees", "sessions", "usage", "tui", "filesystem", "processes", "reports"
]);
const SPEC_DISPOSITIONS = new Set(["oracle_defect", "superseded", "legacy_reader", "oracle_gap", "platform_variant", "quarantine"]);
const ISSUE_REQUIRED = new Set(["oracle_defect", "superseded", "legacy_reader", "platform_variant", "quarantine"]);
const REQUIRED_ORACLE_COMMANDS = new Map([
  ["install-software", 0], ["compile-profile", 0], ["initialize-run", 0], ["list-runs-before", 0], ["validate-run", 0],
  ["pause-unknown-run", 1], ["play-unknown-run", 1], ["cockpit-unknown-run", 1],
  ["compile-ticket-contract", 0], ["positive-run-control-contract", 0]
]);

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestFile(path) {
  return digestBytes(readFileSync(path));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))).map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function pathAt(root, value) {
  return isAbsolute(value) ? value : join(root, value);
}

function addUnique(errors, seen, id, label) {
  if (seen.has(id)) errors.push(`${label}: duplicate id ${id}`);
  if (typeof seen.add === "function") seen.add(id);
  else seen.set(id, true);
}

function requirePattern(errors, value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) errors.push(`${label}: invalid ${JSON.stringify(value)}`);
}

function runGit(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function findParityRoot(start = process.cwd()) {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "reference/parity/ledger.json"))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`could not find reference/parity/ledger.json from ${start}`);
    current = parent;
  }
}

export function loadParityRepository(root = findParityRoot()) {
  const ledger = parseJson(join(root, "reference/parity/ledger.json"));
  const fingerprint = parseJson(pathAt(root, ledger.oracle_fingerprint.path));
  const oracleCaptures = (ledger.oracle_captures ?? []).map((entry) => ({ entry, capture: parseJson(pathAt(root, entry.path)) }));
  const issues = parseJson(pathAt(root, ledger.issue_registry.path));
  const bundles = ledger.cases.map((entry) => ({
    entry,
    case: parseJson(pathAt(root, entry.case.path)),
    actions: parseJson(pathAt(root, entry.actions.path)),
    targetCapture: entry.target_capture ? parseJson(pathAt(root, entry.target_capture.path)) : undefined,
  }));
  return { root, ledger, fingerprint, oracleCaptures, issues, bundles };
}

export function validateParityModel(model) {
  const { ledger, fingerprint, oracleCaptures, issues, bundles } = model;
  const errors = [];

  if (ledger?.protocol !== "koni.parity-ledger.v1") errors.push("ledger: protocol must be koni.parity-ledger.v1");
  if (!['development', 'release'].includes(ledger?.release_mode)) errors.push("ledger: release_mode must be development or release");
  if (fingerprint?.protocol !== "koni.rust-oracle-fingerprint.v1") errors.push("fingerprint: invalid protocol");
  if (issues?.protocol !== "koni.parity-issues.v1") errors.push("issues: invalid protocol");
  if (!ledger?.proof_manifest?.path || !ledger?.proof_manifest?.sha256) errors.push("ledger: hash-pinned proof_manifest is required");
  if (!Array.isArray(oracleCaptures) || oracleCaptures.length === 0) errors.push("ledger: at least one executable oracle capture is required");
  for (const { entry, capture } of oracleCaptures ?? []) {
    if (capture?.protocol !== "koni.oracle-command-capture.v1") errors.push(`${entry.path}: invalid oracle capture protocol`);
    if (capture?.oracle?.commit !== fingerprint?.tag?.commit || capture?.oracle?.tree !== fingerprint?.tag?.tree) errors.push(`${entry.path}: capture provenance differs from fingerprint`);
    if (capture?.isolation?.detached_oracle_worktree !== true || capture?.isolation?.temporary_project !== true || capture?.isolation?.temporary_home !== true || capture?.isolation?.provider_calls !== 0 || capture?.isolation?.live_project_mutations !== 0) errors.push(`${entry.path}: capture isolation contract is not closed`);
    if (capture?.secret_scan?.passed !== true || (capture?.secret_scan?.matches?.length ?? 0) !== 0) errors.push(`${entry.path}: secret scan did not pass cleanly`);
    const installPaths = new Set();
    if (!Array.isArray(capture?.install_tree) || capture.install_tree.length === 0) errors.push(`${entry.path}: install tree must be nonempty`);
    for (const file of capture?.install_tree ?? []) {
      if (installPaths.has(file.path)) errors.push(`${entry.path}: duplicate install path ${file.path}`);
      installPaths.add(file.path);
      if (typeof file.path !== "string" || file.path.includes("..") || (!file.path.startsWith(".koni/") && !file.path.startsWith(".agents/"))) errors.push(`${entry.path}: unsafe install path ${file.path}`);
      if (!Number.isInteger(file.bytes) || file.bytes < 0 || !SHA256.test(file.sha256 ?? "")) errors.push(`${entry.path}/${file.path}: invalid install digest metadata`);
      if (!new Set(["raw", "migration-receipt-v1"]).has(file.normalization)) errors.push(`${entry.path}/${file.path}: unknown install normalization ${file.normalization}`);
    }
    const commandIds = new Set();
    for (const command of capture?.commands ?? []) {
      if (commandIds.has(command.id)) errors.push(`${entry.path}: duplicate command id ${command.id}`);
      commandIds.add(command.id);
      if (!Number.isInteger(command.exit_code)) errors.push(`${entry.path}/${command.id}: exit_code must be an integer`);
    }
    for (const [id, exitCode] of REQUIRED_ORACLE_COMMANDS) {
      const command = (capture?.commands ?? []).find((candidate) => candidate.id === id);
      if (!command) errors.push(`${entry.path}: required command ${id} is missing`);
      else if (command.exit_code !== exitCode) errors.push(`${entry.path}/${id}: expected exit ${exitCode}, got ${command.exit_code}`);
    }
    if (/\/(?:Users|home|tmp)\/|\/private\/var\/folders\//.test(JSON.stringify(capture))) errors.push(`${entry.path}: capture leaks an absolute environment path`);
  }

  const issueMap = new Map();
  for (const issue of issues?.issues ?? []) {
    requirePattern(errors, issue.id, ISSUE_ID, "issue id");
    addUnique(errors, issueMap, issue.id, "issues");
    issueMap.set(issue.id, issue);
    if (!Array.isArray(issue.evidence) || issue.evidence.length === 0) errors.push(`${issue.id}: evidence must be nonempty`);
    for (const field of ["observed", "desired", "closure_proof"]) {
      if (typeof issue[field] !== "string" || issue[field].trim() === "") errors.push(`${issue.id}: ${field} must be nonempty`);
    }
    if (!issue.scope || !Array.isArray(issue.scope.case_ids) || !Array.isArray(issue.scope.assertion_ids) || !Array.isArray(issue.scope.paths)) {
      errors.push(`${issue.id}: exact scope is required`);
    } else if (issue.scope.case_ids.length === 0 || issue.scope.assertion_ids.length === 0 || issue.scope.paths.length === 0) {
      errors.push(`${issue.id}: scope cannot be broad or empty`);
    }
    if (ledger?.release_mode === "release" && issue.classification === "quarantine") errors.push(`${issue.id}: quarantine forbidden in release mode`);
  }

  const caseMap = new Map();
  const assertionsByCase = new Map();
  let checkpointCount = 0;
  let assertionCount = 0;
  let actionCount = 0;
  let oracleAssertionCount = 0;
  let specificationAssertionCount = 0;

  for (const bundle of bundles ?? []) {
    const entry = bundle.entry;
    const testCase = bundle.case;
    const actions = bundle.actions;
    const targetCapture = bundle.targetCapture;
    requirePattern(errors, entry?.id, CASE_ID, "ledger case id");
    addUnique(errors, caseMap, entry?.id, "ledger cases");
    if (testCase?.protocol !== "koni.parity-case.v1") errors.push(`${entry?.id}: invalid case protocol`);
    if (actions?.protocol !== "koni.parity-actions.v1") errors.push(`${entry?.id}: invalid actions protocol`);
    if (entry?.id !== testCase?.id || entry?.id !== actions?.case_id) errors.push(`${entry?.id}: ledger/case/action ids differ`);
    if (entry?.revision !== testCase?.revision) errors.push(`${entry?.id}: ledger/case revisions differ`);
    if (entry?.tier !== testCase?.tier) errors.push(`${entry?.id}: ledger/case tiers differ`);
    if (testCase?.action_script !== entry?.actions?.path) errors.push(`${entry?.id}: action_script does not match ledger action path`);
    if (!actions?.isolation?.temporary_project || !actions?.isolation?.temporary_pi_home || actions?.isolation?.live_projects !== false) {
      errors.push(`${entry?.id}: action script must isolate project/Pi home and forbid live projects`);
    }
    if (!new Set(["disabled", "fixture_only"]).has(actions?.isolation?.network)) errors.push(`${entry?.id}: network must be disabled or fixture_only`);
    if (new Set(["captured", "passing"]).has(entry.status)) {
      if (!entry.target_capture || !targetCapture) errors.push(`${entry.id}: ${entry.status} requires a target_capture`);
      else {
        if (targetCapture.protocol !== "koni.typescript-parity-capture.v1") errors.push(`${entry.id}: invalid target capture protocol`);
        if (targetCapture.oracle?.commit !== fingerprint.tag.commit) errors.push(`${entry.id}: target capture oracle commit drift`);
        if (targetCapture.isolation?.live_projects !== false || targetCapture.isolation?.provider_calls !== 0 || targetCapture.isolation?.temporary_projects !== true || targetCapture.isolation?.temporary_pi_homes !== true) errors.push(`${entry.id}: target capture isolation contract is not closed`);
        if (/\/(?:Users|home|tmp)\/|\/private\/var\/folders\//u.test(JSON.stringify(targetCapture))) errors.push(`${entry.id}: target capture leaks an absolute environment path`);
        const capturedCase = targetCapture.cases?.find((candidate) => candidate.id === entry.id);
        if (!capturedCase) errors.push(`${entry.id}: target capture does not contain the case`);
        else if (entry.status === "passing" && (capturedCase.outcome !== "passing" || capturedCase.assertions?.some((assertion) => assertion.outcome !== "passed"))) errors.push(`${entry.id}: passing capture contains a non-passing assertion`);
        const { capture_sha256: recordedCaptureSha256, ...captureMaterial } = targetCapture;
        const actualCaptureSha256 = digestBytes(JSON.stringify(canonicalJson(captureMaterial)));
        if (recordedCaptureSha256 !== actualCaptureSha256) errors.push(`${entry.id}: target capture canonical hash drift`);
      }
    } else if (entry.target_capture !== undefined) {
      errors.push(`${entry.id}: ${entry.status} cannot publish a target_capture`);
    }

    const actionIds = new Set();
    for (const action of actions?.actions ?? []) {
      requirePattern(errors, action.id, ACTION_ID, `${entry?.id} action id`);
      addUnique(errors, actionIds, action.id, `${entry?.id} actions`);
      if (!ACTION_OPERATIONS.has(action.op)) errors.push(`${entry?.id}/${action.id}: unknown operation ${action.op}`);
      if (!action.args || Array.isArray(action.args) || typeof action.args !== "object") errors.push(`${entry?.id}/${action.id}: args must be an object`);
      actionCount += 1;
    }

    const checkpointIds = new Set();
    const assertionIds = new Set();
    const assertionMap = new Map();
    for (const assertion of testCase?.assertions ?? []) {
      requirePattern(errors, assertion.id, ASSERTION_ID, `${entry?.id} assertion id`);
      addUnique(errors, assertionIds, assertion.id, `${entry?.id} assertions`);
      assertionMap.set(assertion.id, assertion);
      requirePattern(errors, assertion.checkpoint, CHECKPOINT_ID, `${entry?.id}/${assertion.id} checkpoint`);
      if (!SURFACES.has(assertion.surface)) errors.push(`${entry?.id}/${assertion.id}: unknown surface ${assertion.surface}`);
      if (assertion.authority === "oracle") {
        oracleAssertionCount += 1;
        if (assertion.disposition !== "none") errors.push(`${entry?.id}/${assertion.id}: oracle assertion must use disposition none`);
        if (assertion.issue_ref !== undefined) errors.push(`${entry?.id}/${assertion.id}: oracle assertion cannot cite an issue waiver`);
      } else if (assertion.authority === "specification") {
        specificationAssertionCount += 1;
        if (!SPEC_DISPOSITIONS.has(assertion.disposition)) errors.push(`${entry?.id}/${assertion.id}: specification assertion needs a narrow disposition`);
        if (ISSUE_REQUIRED.has(assertion.disposition) && !assertion.issue_ref) errors.push(`${entry?.id}/${assertion.id}: ${assertion.disposition} requires issue_ref`);
        if (assertion.issue_ref) {
          const issue = issueMap.get(assertion.issue_ref);
          if (!issue) errors.push(`${entry?.id}/${assertion.id}: unknown issue_ref ${assertion.issue_ref}`);
          else if (issue.classification !== assertion.disposition) errors.push(`${entry?.id}/${assertion.id}: issue classification ${issue.classification} does not match ${assertion.disposition}`);
        }
        if (ledger?.release_mode === "release" && assertion.disposition === "quarantine") errors.push(`${entry?.id}/${assertion.id}: quarantine forbidden in release mode`);
      } else {
        errors.push(`${entry?.id}/${assertion.id}: authority must be oracle or specification`);
      }
      if (typeof assertion.description !== "string" || assertion.description.trim() === "") errors.push(`${entry?.id}/${assertion.id}: description must be nonempty`);
      assertionCount += 1;
    }
    assertionsByCase.set(entry?.id, assertionIds);

    for (const checkpoint of testCase?.checkpoints ?? []) {
      requirePattern(errors, checkpoint.id, CHECKPOINT_ID, `${entry?.id} checkpoint id`);
      addUnique(errors, checkpointIds, checkpoint.id, `${entry?.id} checkpoints`);
      if (!actionIds.has(checkpoint.after_action)) errors.push(`${entry?.id}/${checkpoint.id}: unknown after_action ${checkpoint.after_action}`);
      for (const surface of checkpoint.capture ?? []) if (!SURFACES.has(surface)) errors.push(`${entry?.id}/${checkpoint.id}: unknown capture surface ${surface}`);
      for (const assertionId of checkpoint.assertions ?? []) {
        const assertion = assertionMap.get(assertionId);
        if (!assertion) errors.push(`${entry?.id}/${checkpoint.id}: unknown assertion ${assertionId}`);
        else if (assertion.checkpoint !== checkpoint.id) errors.push(`${entry?.id}/${assertionId}: assertion checkpoint disagrees with checkpoint membership`);
      }
      const captureAction = (actions?.actions ?? []).find((action) => action.id === checkpoint.after_action);
      if (captureAction?.op !== "capture.collect") errors.push(`${entry?.id}/${checkpoint.id}: after_action must be capture.collect`);
      if (captureAction?.args?.checkpoint !== checkpoint.id) errors.push(`${entry?.id}/${checkpoint.id}: capture action checkpoint differs`);
      checkpointCount += 1;
    }
    for (const assertion of testCase?.assertions ?? []) {
      if (!checkpointIds.has(assertion.checkpoint)) errors.push(`${entry?.id}/${assertion.id}: unknown checkpoint ${assertion.checkpoint}`);
      const checkpoint = (testCase?.checkpoints ?? []).find((item) => item.id === assertion.checkpoint);
      if (checkpoint && !checkpoint.capture.includes(assertion.surface)) errors.push(`${entry?.id}/${assertion.id}: assertion surface is not captured at checkpoint`);
      if (checkpoint && !checkpoint.assertions.includes(assertion.id)) errors.push(`${entry?.id}/${assertion.id}: assertion missing from checkpoint assertion list`);
    }
  }

  for (const issue of issues?.issues ?? []) {
    if (!issue.scope) continue;
    for (const caseId of issue.scope.case_ids ?? []) if (!caseMap.has(caseId)) errors.push(`${issue.id}: scope cites unknown case ${caseId}`);
    for (const assertionId of issue.scope.assertion_ids ?? []) {
      const found = (issue.scope.case_ids ?? []).some((caseId) => assertionsByCase.get(caseId)?.has(assertionId));
      if (!found) errors.push(`${issue.id}: scope assertion ${assertionId} is absent from scoped cases`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      cases: caseMap.size,
      checkpoints: checkpointCount,
      assertions: assertionCount,
      oracle_assertions: oracleAssertionCount,
      specification_assertions: specificationAssertionCount,
      actions: actionCount,
      issues: issueMap.size
    }
  };
}

export function validateFingerprintAgainstRepository(model) {
  const { root, fingerprint, ledger } = model;
  const errors = [];
  try {
    const object = runGit(root, ["rev-parse", `${fingerprint.tag.name}^{tag}`]);
    const commit = runGit(root, ["rev-parse", `${fingerprint.tag.name}^{commit}`]);
    const tree = runGit(root, ["rev-parse", `${fingerprint.tag.name}^{tree}`]);
    if (object !== fingerprint.tag.object) errors.push(`fingerprint: tag object drift (${object})`);
    if (commit !== fingerprint.tag.commit) errors.push(`fingerprint: commit drift (${commit})`);
    if (tree !== fingerprint.tag.tree) errors.push(`fingerprint: tree drift (${tree})`);
  } catch (error) {
    errors.push(`fingerprint: unable to resolve oracle tag: ${error.message}`);
  }

  for (const input of fingerprint.locked_inputs ?? []) {
    if (!SHA256.test(input.sha256 ?? "")) {
      errors.push(`fingerprint: invalid digest for ${input.path}`);
      continue;
    }
    try {
      let actual;
      if (input.source === "tag") {
        actual = digestBytes(execFileSync("git", ["-C", root, "show", `${fingerprint.tag.commit}:${input.path}`]));
      } else if (input.source === "working-contract") {
        actual = digestFile(pathAt(root, input.path));
      } else {
        errors.push(`fingerprint: unknown locked input source ${input.source} for ${input.path}`);
        continue;
      }
      if (actual !== input.sha256) errors.push(`fingerprint: digest drift for ${input.path}; expected ${input.sha256}, got ${actual}`);
    } catch (error) {
      errors.push(`fingerprint: cannot hash ${input.path}: ${error.message}`);
    }
  }

  for (const file of ledger.normalization ?? []) {
    try {
      if (file.sha256 && digestFile(pathAt(root, file.path)) !== file.sha256) errors.push(`ledger: normalization digest drift for ${file.path}`);
    } catch (error) {
      errors.push(`ledger: cannot hash ${file.path}: ${error.message}`);
    }
  }
  for (const file of ledger.oracle_captures ?? []) {
    try {
      if (!file.sha256 || digestFile(pathAt(root, file.path)) !== file.sha256) errors.push(`ledger: oracle capture digest drift for ${file.path}`);
    } catch (error) {
      errors.push(`ledger: cannot hash ${file.path}: ${error.message}`);
    }
  }
  for (const entry of ledger.cases ?? []) {
    if (!entry.target_capture) continue;
    try {
      if (!entry.target_capture.sha256 || digestFile(pathAt(root, entry.target_capture.path)) !== entry.target_capture.sha256) {
        errors.push(`ledger: target capture digest drift for ${entry.id}`);
      }
    } catch (error) {
      errors.push(`ledger: cannot hash target capture for ${entry.id}: ${error.message}`);
    }
  }
  if (ledger.proof_manifest) {
    try {
      if (!ledger.proof_manifest.sha256 || digestFile(pathAt(root, ledger.proof_manifest.path)) !== ledger.proof_manifest.sha256) {
        errors.push(`ledger: proof manifest digest drift for ${ledger.proof_manifest.path}`);
      }
    } catch (error) {
      errors.push(`ledger: cannot hash ${ledger.proof_manifest.path}: ${error.message}`);
    }
  }
  return errors;
}

export function validateParityRepository(root = findParityRoot()) {
  let model;
  try {
    model = loadParityRepository(root);
  } catch (error) {
    return { ok: false, errors: [`load: ${error.message}`], summary: {} };
  }
  const result = validateParityModel(model);
  const errors = [...result.errors, ...validateFingerprintAgainstRepository(model)];
  for (const schema of ["ledger", "case", "actions", "capture", "oracle-command-capture", "issues", "proofs", "rust-semantic-suite", "typescript-parity-capture"]) {
    const path = join(root, `reference/parity/schemas/${schema}.schema.json`);
    try { parseJson(path); } catch (error) { errors.push(`schema ${schema}: ${error.message}`); }
  }
  return { ...result, ok: errors.length === 0, errors };
}

function executionPlan(model, selectedCase) {
  return model.bundles
    .filter((bundle) => !selectedCase || bundle.entry.id === selectedCase)
    .map((bundle) => ({
      id: bundle.entry.id,
      tier: bundle.entry.tier,
      status: bundle.entry.status,
      drivers: bundle.case.drivers,
      fixture: bundle.case.fixture,
      actions: bundle.actions.actions.map(({ id, op }) => ({ id, op })),
      checkpoints: bundle.case.checkpoints.map(({ id, after_action, capture }) => ({ id, after_action, capture }))
    }));
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "validate";
  let root;
  let json = false;
  let selectedCase;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--root") root = args.shift();
    else if (arg === "--json") json = true;
    else if (!selectedCase) selectedCase = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  return { command, root, json, selectedCase };
}

function main(argv) {
  const options = parseArgs(argv);
  const root = options.root ? findParityRoot(options.root) : findParityRoot();
  if (options.command === "validate") {
    const result = validateParityRepository(root);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(`Parity ledger valid: ${result.summary.cases} cases, ${result.summary.checkpoints} checkpoints, ${result.summary.assertions} assertions, ${result.summary.actions} actions, ${result.summary.issues} scoped issues.`);
    else for (const error of result.errors) console.error(`ERROR ${error}`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (options.command === "plan") {
    const model = loadParityRepository(root);
    const result = validateParityModel(model);
    if (!result.ok) throw new Error(`ledger invalid:\n${result.errors.join("\n")}`);
    const plan = executionPlan(model, options.selectedCase);
    if (options.selectedCase && plan.length === 0) throw new Error(`unknown case ${options.selectedCase}`);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  throw new Error(`unknown command ${options.command}; expected validate or plan`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`ERROR ${error.message}`); process.exitCode = 1; }
}
