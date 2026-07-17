import assert from "node:assert/strict";
import test from "node:test";

import {
  findParityRoot,
  loadParityRepository,
  validateFingerprintAgainstRepository,
  validateParityModel,
  validateParityRepository
} from "./parity-ledger.mjs";

const root = findParityRoot(new URL("..", import.meta.url).pathname);

function clone(value) {
  return structuredClone(value);
}

test("checked-in executable parity ledger is internally valid", () => {
  const result = validateParityRepository(root);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.summary.cases, 24);
  assert.ok(result.summary.assertions >= 60);
  assert.ok(result.summary.actions >= 100);
});

test("oracle fingerprint rejects locked-input digest drift", () => {
  const model = loadParityRepository(root);
  model.fingerprint.locked_inputs[0].sha256 = "0".repeat(64);
  const errors = validateFingerprintAgainstRepository(model);
  assert.ok(errors.some((error) => error.includes("digest drift for Cargo.lock")), errors.join("\n"));
});

test("oracle capture provenance and isolation are mandatory", () => {
  const model = clone(loadParityRepository(root));
  model.oracleCaptures[0].capture.isolation.provider_calls = 1;
  model.oracleCaptures[0].capture.oracle.commit = "0".repeat(40);
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("capture provenance differs")), result.errors.join("\n"));
  assert.ok(result.errors.some((error) => error.includes("capture isolation contract is not closed")), result.errors.join("\n"));
});

test("oracle capture cannot drop command contracts or smuggle unsafe install paths", () => {
  const model = clone(loadParityRepository(root));
  model.oracleCaptures[0].capture.commands = model.oracleCaptures[0].capture.commands.filter((command) => command.id !== "compile-ticket-contract");
  model.oracleCaptures[0].capture.install_tree[0].path = "../live-project/secret";
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("required command compile-ticket-contract is missing")), result.errors.join("\n"));
  assert.ok(result.errors.some((error) => error.includes("unsafe install path")), result.errors.join("\n"));
});

test("a passing TypeScript case requires a canonical isolated all-pass capture", () => {
  const model = clone(loadParityRepository(root));
  const bundle = model.bundles.find((candidate) => candidate.entry.id === "KPAR-SES-0001");
  const capturedCase = bundle.targetCapture.cases.find((candidate) => candidate.id === bundle.entry.id);
  capturedCase.assertions[0].outcome = "failed";
  bundle.targetCapture.isolation.provider_calls = 1;
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("isolation contract is not closed")), result.errors.join("\n"));
  assert.ok(result.errors.some((error) => error.includes("non-passing assertion")), result.errors.join("\n"));
  assert.ok(result.errors.some((error) => error.includes("canonical hash drift")), result.errors.join("\n"));
});

test("unknown action operation fails closed", () => {
  const model = clone(loadParityRepository(root));
  model.bundles[0].actions.actions[0].op = "shell.run-anything";
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("unknown operation")), result.errors.join("\n"));
});

test("oracle-defect disposition requires an exact issue record", () => {
  const model = clone(loadParityRepository(root));
  const assertion = model.bundles.find((bundle) => bundle.entry.id === "KPAR-CFG-0003").case.assertions[0];
  delete assertion.issue_ref;
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("oracle_defect requires issue_ref")), result.errors.join("\n"));
});

test("oracle assertions cannot hide behind issue waivers", () => {
  const model = clone(loadParityRepository(root));
  const assertion = model.bundles[0].case.assertions[0];
  assertion.issue_ref = "KBUG-CFG-0001";
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("oracle assertion cannot cite an issue waiver")), result.errors.join("\n"));
});

test("duplicate stable ids and broken checkpoint references are rejected", () => {
  const model = clone(loadParityRepository(root));
  model.bundles[0].actions.actions[1].id = model.bundles[0].actions.actions[0].id;
  model.bundles[0].case.checkpoints[0].after_action = "S99-missing";
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("duplicate id")), result.errors.join("\n"));
  assert.ok(result.errors.some((error) => error.includes("unknown after_action")), result.errors.join("\n"));
});

test("release ledgers cannot carry quarantine classifications", () => {
  const model = clone(loadParityRepository(root));
  model.ledger.release_mode = "release";
  model.issues.issues[0].classification = "quarantine";
  const result = validateParityModel(model);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("quarantine forbidden in release mode")), result.errors.join("\n"));
});
