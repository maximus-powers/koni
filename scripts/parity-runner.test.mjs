import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { findParityRoot } from "./parity-ledger.mjs";
import { executeParity, targetTestArguments, validateProofManifest } from "./parity-runner.mjs";
import { parsePassedTests } from "./parity-rust-suite.mjs";

const root = findParityRoot(new URL("..", import.meta.url).pathname);

test("every parity assertion has executable evidence or a typed blocker", () => {
  const result = validateProofManifest(root);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.proofCount, 65);
  assert.equal(result.blockers.length, 0);
  for (const blocker of result.blockers) {
    assert.match(blocker.key, /^KPAR-/u);
    assert.ok(blocker.required_surface.length > 20);
    assert.ok(blocker.acceptance.length > 20);
  }
});

test("frozen Rust result parsing retains semantic test identities only", () => {
  const tests = parsePassedTests([
    "running 2 tests",
    "test engine::tests::contract_b ... ok",
    "test engine::tests::contract_a ... ok",
    "test result: ok. 2 passed; 0 failed; finished in 0.42s",
    "Compiling secret/path",
  ].join("\n"));
  assert.deepEqual(tests, ["engine::tests::contract_a", "engine::tests::contract_b"]);
});

test("target proofs inherit Core's checked-in Vitest policy from the repository root", () => {
  const args = targetTestArguments(["packages/core/test/example.test.ts"], "/tmp/results.json");
  assert.deepEqual(args, [
    "vitest",
    "run",
    "packages/core/test/example.test.ts",
    "--config=packages/core/vitest.config.ts",
    "--reporter=json",
    "--outputFile=/tmp/results.json",
  ]);
  assert.equal(args.includes("--no-file-parallelism"), false);
});

test("a specification-only native Pi case executes into a deterministic normalized capture", () => {
  const first = executeParity(root, "KPAR-SES-0001");
  const second = executeParity(root, "KPAR-SES-0001");
  const checked = JSON.parse(readFileSync(join(root, "reference/parity/captures/KPAR-SES-0001.typescript.json"), "utf8"));
  assert.deepEqual(second, first);
  assert.deepEqual(first, checked);
  assert.equal(first.cases[0].outcome, "passing");
  assert.equal(first.cases[0].assertions.length, 4);
  assert.ok(first.cases[0].assertions.every((assertion) => assertion.outcome === "passed"));
  assert.doesNotMatch(JSON.stringify(first), /\/(?:Users|home|private\/var\/folders|tmp)\//u);
});
