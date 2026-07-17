#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findParityRoot, loadParityRepository, validateParityRepository } from "./parity-ledger.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function proofKey(caseId, assertionId) {
  return `${caseId}/${assertionId}`;
}

export function loadProofManifest(root = findParityRoot()) {
  const ledger = parseJson(join(root, "reference/parity/ledger.json"));
  const path = join(root, ledger.proof_manifest.path);
  return { path, manifest: parseJson(path) };
}

export function validateProofManifest(root = findParityRoot()) {
  const model = loadParityRepository(root);
  const { path, manifest } = loadProofManifest(root);
  const errors = [];
  let oraclePassed = new Set();
  try {
    oraclePassed = loadOracleEvidence(root).passed;
  } catch (error) {
    errors.push(`proofs: frozen Rust evidence is invalid: ${error.message}`);
  }
  const oracleCommands = model.oracleCaptures.flatMap(({ capture }) => capture.commands ?? []);
  if (manifest.protocol !== "koni.parity-proofs.v1") errors.push("proofs: invalid protocol");
  const expected = new Map();
  for (const bundle of model.bundles) {
    for (const assertion of bundle.case.assertions) expected.set(proofKey(bundle.entry.id, assertion.id), { bundle, assertion });
  }
  const seen = new Set();
  for (const proof of manifest.proofs ?? []) {
    const key = proofKey(proof.case_id, proof.assertion_id);
    if (seen.has(key)) errors.push(`proofs: duplicate ${key}`);
    seen.add(key);
    const contract = expected.get(key);
    if (!contract) { errors.push(`proofs: unknown ${key}`); continue; }
    const expectedHash = sha256(JSON.stringify(canonical({
      authority: contract.assertion.authority,
      comparator: contract.assertion.comparator,
      description: contract.assertion.description,
      disposition: contract.assertion.disposition,
      expected: contract.assertion.expected,
      surface: contract.assertion.surface,
    })));
    if (proof.contract_sha256 !== "derived" && proof.contract_sha256 !== expectedHash) errors.push(`${key}: contract hash drift`);
    const expectedComparison = contract.assertion.authority === "oracle"
      ? "semantic-oracle-contract"
      : "semantic-specification-contract";
    if (proof.comparison !== expectedComparison) errors.push(`${key}: comparison must be ${expectedComparison}`);
    if (proof.checkpoint !== contract.assertion.checkpoint) errors.push(`${key}: checkpoint drift`);
    if (!Array.isArray(proof.target_tests) || proof.target_tests.length === 0) {
      if (!proof.blocker) errors.push(`${key}: target proof or explicit blocker required`);
    } else {
      for (const test of proof.target_tests) {
        const absolute = join(root, test.file);
        if (!existsSync(absolute)) errors.push(`${key}: missing target test file ${test.file}`);
        if (typeof test.title !== "string" || test.title.trim() === "") errors.push(`${key}: target test title required`);
        else if (existsSync(absolute) && !readFileSync(absolute, "utf8").includes(JSON.stringify(test.title))) {
          errors.push(`${key}: target test title not found in ${test.file}: ${test.title}`);
        }
      }
    }
    if (contract.assertion.authority === "oracle" && !proof.oracle_test && !proof.oracle_capture_command && !proof.blocker) {
      errors.push(`${key}: oracle proof or explicit blocker required`);
    }
    if (proof.oracle_test && [...oraclePassed].filter((name) =>
      name === proof.oracle_test || name.endsWith(`::${proof.oracle_test}`)
    ).length !== 1) {
      errors.push(`${key}: frozen Rust test identity is missing or ambiguous: ${proof.oracle_test}`);
    }
    if (proof.oracle_capture_command && oracleCommands.filter((command) =>
      command.id === proof.oracle_capture_command
    ).length !== 1) {
      errors.push(`${key}: frozen oracle command identity is missing or ambiguous: ${proof.oracle_capture_command}`);
    }
    if (proof.blocker && (!proof.blocker.code || !proof.blocker.required_surface || !proof.blocker.acceptance)) {
      errors.push(`${key}: blocker must name code, required_surface, and acceptance`);
    }
  }
  for (const key of expected.keys()) if (!seen.has(key)) errors.push(`proofs: missing ${key}`);
  const blockers = (manifest.proofs ?? []).filter((proof) => proof.blocker).map((proof) => ({
    key: proofKey(proof.case_id, proof.assertion_id),
    ...proof.blocker,
  }));
  if (model.ledger.release_mode === "release" && blockers.length > 0) errors.push(`release: ${blockers.length} proof blockers remain`);
  if (model.ledger.release_mode === "release") {
    for (const entry of model.ledger.cases) if (entry.status !== "passing") errors.push(`release: ${entry.id} is ${entry.status}, expected passing`);
  }
  return { ok: errors.length === 0, errors, blockers, proofCount: seen.size, path: relative(root, path) };
}

export function targetTestArguments(files, output) {
  return [
    "vitest",
    "run",
    ...files,
    "--config=packages/core/vitest.config.ts",
    "--reporter=json",
    `--outputFile=${output}`,
  ];
}

function runTargetTests(root, proofs) {
  const files = [...new Set(proofs.flatMap((proof) => (proof.target_tests ?? []).map((test) => test.file)))].sort();
  if (files.length === 0) return new Map();
  const required = new Set(proofs.flatMap((proof) => (proof.target_tests ?? []).map((test) =>
    `${test.file}\0${test.title}`
  )));
  const output = join(root, ".parity-target-results.json");
  // The parity runner starts at the repository root, so Vitest will not discover
  // Core's checked-in timeout policy on its own. The corpus intentionally includes
  // real Git worktrees, atomic profile publication, and contained process teardown;
  // under Vitest's five-second default, healthy proofs are reported as generic
  // STACK_TRACE_ERROR failures while their cleanup is still in flight.
  const result = spawnSync("npx", targetTestArguments(files, output), {
    cwd: root,
    encoding: "utf8",
    detached: process.platform !== "win32",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  let report;
  try { report = parseJson(output); }
  finally {
    try { unlinkSync(output); } catch {}
  }
  const results = new Map();
  for (const suite of report.testResults ?? []) {
    const file = relative(root, suite.name).split("\\").join("/");
    for (const assertion of suite.assertionResults ?? []) {
      const key = `${file}\0${assertion.title}`;
      if (results.has(key)) {
        // Parameterized tests may intentionally share a leaf title. They are harmless when
        // no parity assertion cites that ambiguous identity, but mapped evidence must always
        // identify exactly one executable test.
        if (required.has(key)) throw new Error(`duplicate target test identity ${file}: ${assertion.title}`);
        continue;
      }
      results.set(key, assertion.status);
    }
  }
  if (result.status !== 0 && !report) throw new Error(`target test process failed: ${result.stderr}`);
  return results;
}

function loadOracleEvidence(root) {
  const path = join(root, "reference/parity/oracle/rust-oracle-baseline/semantic-contract-suite.json");
  if (!existsSync(path)) return { capture: null, passed: new Set() };
  const capture = parseJson(path);
  const fingerprint = loadParityRepository(root).fingerprint;
  if (
    capture.protocol !== "koni.rust-semantic-suite.v1" ||
    capture.oracle?.commit !== fingerprint.tag.commit ||
    capture.oracle?.tree !== fingerprint.tag.tree ||
    capture.isolation?.detached_oracle_worktree !== true ||
    capture.isolation?.temporary_home !== true ||
    capture.isolation?.provider_calls !== 0 ||
    capture.isolation?.live_project_mutations !== 0 ||
    capture.isolation?.network !== "fixture_only" ||
    capture.isolation?.test_network !== "loopback_only" ||
    capture.secret_scan?.passed !== true ||
    (capture.secret_scan?.matches?.length ?? 0) !== 0
  ) throw new Error("frozen Rust semantic suite failed provenance or isolation validation");
  return { capture, passed: new Set(capture.passed_tests ?? []) };
}

function oracleTestPassed(passed, requested) {
  const matches = [...passed].filter((name) => name === requested || name.endsWith(`::${requested}`));
  return matches.length === 1;
}

export function executeParity(root = findParityRoot(), selectedCase) {
  const ledgerResult = validateParityRepository(root);
  const proofResult = validateProofManifest(root);
  if (!ledgerResult.ok || !proofResult.ok) throw new Error([...ledgerResult.errors, ...proofResult.errors].join("\n"));
  const { manifest } = loadProofManifest(root);
  const model = loadParityRepository(root);
  const contractHashes = new Map(model.bundles.flatMap((bundle) => bundle.case.assertions.map((assertion) => [
    proofKey(bundle.entry.id, assertion.id),
    sha256(JSON.stringify(canonical({
      authority: assertion.authority,
      comparator: assertion.comparator,
      description: assertion.description,
      disposition: assertion.disposition,
      expected: assertion.expected,
      surface: assertion.surface,
    }))),
  ])));
  const proofs = manifest.proofs.filter((proof) => !selectedCase || proof.case_id === selectedCase);
  if (selectedCase && proofs.length === 0) throw new Error(`unknown case ${selectedCase}`);
  const target = runTargetTests(root, proofs);
  const oracle = loadOracleEvidence(root);
  const cases = [];
  const grouped = Map.groupBy(proofs, (proof) => proof.case_id);
  for (const [caseId, caseProofs] of grouped) {
    const assertions = [];
    for (const proof of caseProofs) {
      const targetResults = (proof.target_tests ?? []).map((test) => ({
        file: test.file,
        title: test.title,
        outcome: target.get(`${test.file}\0${test.title}`) ?? "missing",
      }));
      const targetPassed = targetResults.length > 0 && targetResults.every((item) => item.outcome === "passed");
      let oracleResult = null;
      if (proof.oracle_test) oracleResult = { kind: "rust-test", name: proof.oracle_test, outcome: oracleTestPassed(oracle.passed, proof.oracle_test) ? "passed" : "missing" };
      if (proof.oracle_capture_command) {
        const capture = loadParityRepository(root).oracleCaptures.flatMap(({ capture }) => capture.commands ?? []).find((command) => command.id === proof.oracle_capture_command);
        oracleResult = { kind: "command-capture", name: proof.oracle_capture_command, outcome: capture?.exit_code === 0 ? "passed" : "missing" };
      }
      const outcome = proof.blocker ? "blocked" : targetPassed && (!oracleResult || oracleResult.outcome === "passed") ? "passed" : "failed";
      assertions.push({
        id: proof.assertion_id,
        contract_sha256: contractHashes.get(proofKey(proof.case_id, proof.assertion_id)),
        target: targetResults,
        oracle: oracleResult,
        comparison: proof.comparison,
        outcome,
        ...(proof.blocker ? { blocker: proof.blocker } : {}),
      });
    }
    cases.push({
      id: caseId,
      outcome: assertions.every((assertion) => assertion.outcome === "passed") ? "passing" : assertions.some((assertion) => assertion.outcome === "failed") ? "failed" : "blocked",
      assertions,
    });
  }
  const normalized = canonical({
    schema_version: "1.0",
    protocol: "koni.typescript-parity-capture.v1",
    oracle: {
      commit: loadParityRepository(root).fingerprint.tag.commit,
      semantic_suite_sha256: oracle.capture ? sha256(JSON.stringify(canonical(oracle.capture))) : null,
    },
    normalization: "koni.parity-normalization.v2",
    cases,
    isolation: { temporary_projects: true, temporary_pi_homes: true, live_projects: false, provider_calls: 0 },
  });
  return { ...normalized, capture_sha256: sha256(JSON.stringify(normalized)) };
}

/** Execute the complete provider-free corpus and compare every case with its reviewed capture. */
export function gateParity(root = findParityRoot()) {
  const model = loadParityRepository(root);
  const proofResult = validateProofManifest(root);
  const preflightErrors = [];
  if (model.ledger.release_mode !== "release") {
    preflightErrors.push(`release gate requires release_mode=release, found ${model.ledger.release_mode}`);
  }
  if (proofResult.blockers.length > 0) {
    preflightErrors.push(`release gate refuses ${proofResult.blockers.length} explicit proof blockers`);
  }
  for (const bundle of model.bundles) {
    if (bundle.entry.status !== "passing") {
      preflightErrors.push(`release gate requires ${bundle.entry.id} passing, found ${bundle.entry.status}`);
    }
  }
  if (preflightErrors.length > 0) throw new Error(preflightErrors.join("\n"));

  const fresh = executeParity(root);
  const errors = [];
  const freshById = new Map(fresh.cases.map((entry) => [entry.id, entry]));
  for (const bundle of model.bundles) {
    const actual = freshById.get(bundle.entry.id);
    const expected = bundle.targetCapture?.cases?.find((entry) => entry.id === bundle.entry.id);
    if (!actual) {
      errors.push(`${bundle.entry.id}: executable result missing from the full parity run`);
      continue;
    }
    if (actual.outcome !== "passing" || actual.assertions.some((assertion) => assertion.outcome !== "passed")) {
      errors.push(`${bundle.entry.id}: executable result is ${actual.outcome}`);
    }
    if (!expected) {
      errors.push(`${bundle.entry.id}: reviewed target capture is missing the case`);
    } else if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
      errors.push(`${bundle.entry.id}: fresh executable result differs from its reviewed target capture`);
    }
    for (const field of ["oracle", "normalization", "isolation"]) {
      if (JSON.stringify(canonical(fresh[field])) !== JSON.stringify(canonical(bundle.targetCapture?.[field]))) {
        errors.push(`${bundle.entry.id}: fresh ${field} provenance differs from its reviewed target capture`);
      }
    }
  }
  if (freshById.size !== model.bundles.length) {
    errors.push(`full parity run returned ${freshById.size} cases, expected ${model.bundles.length}`);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return fresh;
}

function parseArgs(argv) {
  let command = argv.shift() ?? "validate";
  let selectedCase;
  let root;
  let output;
  while (argv.length) {
    const arg = argv.shift();
    if (arg === "--root") root = argv.shift();
    else if (arg === "--output") output = argv.shift();
    else if (!selectedCase) selectedCase = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  return { command, selectedCase, output, root: root ? findParityRoot(root) : findParityRoot() };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "validate") {
      const ledger = validateParityRepository(args.root);
      const proofs = validateProofManifest(args.root);
      if (!ledger.ok || !proofs.ok) throw new Error([...ledger.errors, ...proofs.errors].join("\n"));
      process.stdout.write(`Parity proofs valid: ${proofs.proofCount} assertions, ${proofs.blockers.length} explicit blockers.\n`);
      if (proofs.blockers.length) for (const blocker of proofs.blockers) process.stdout.write(`BLOCKED ${blocker.key} ${blocker.code}: ${blocker.required_surface}\n`);
    } else if (args.command === "run") {
      const capture = executeParity(args.root, args.selectedCase);
      if (args.output) {
        writeFileSync(resolve(args.output), `${JSON.stringify(capture, null, 2)}\n`, { flag: "w", mode: 0o600 });
        process.stdout.write(`Wrote TypeScript parity capture for ${args.selectedCase ?? "all cases"}.\n`);
      } else {
        process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
      }
    } else if (args.command === "gate") {
      if (args.selectedCase) throw new Error("the release gate always executes the complete parity corpus");
      const capture = gateParity(args.root);
      if (args.output) {
        writeFileSync(resolve(args.output), `${JSON.stringify(capture, null, 2)}\n`, { flag: "w", mode: 0o600 });
      }
      const assertions = capture.cases.reduce((count, entry) => count + entry.assertions.length, 0);
      process.stdout.write(`Executable parity gate passed: ${capture.cases.length} cases, ${assertions} assertions.\n`);
    } else throw new Error(`unknown command ${args.command}; expected validate, run, or gate`);
  } catch (error) {
    process.stderr.write(`ERROR ${error.message}\n`);
    process.exitCode = 1;
  }
}
