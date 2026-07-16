import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { findParityRoot } from "./parity-ledger.mjs";

const root = findParityRoot(new URL("..", import.meta.url).pathname);
const source = readFileSync(new URL("./capture-rust-oracle.mjs", import.meta.url), "utf8");

test("oracle capture requires detached frozen source before fixture execution", () => {
  const guard = source.indexOf("assertSafeOracleSource(repoRoot, oracleWorktree, fingerprint);");
  const fixture = source.indexOf("writeFileSync(join(projectRoot, \"README.md\")");
  assert.ok(guard >= 0 && fixture >= 0 && guard < fixture);
});

test("oracle capture hard-isolates project, home, providers, and live projects", () => {
  for (const required of [
    "project root must be inside the disposable sandbox",
    "home root must be inside the disposable sandbox",
    "KONI_DISABLE_PROVIDER",
    "PI_CODING_AGENT_DIR",
    "provider_calls: 0",
    "live_project_mutations: 0"
  ]) assert.ok(source.includes(required), `missing ${required}`);
});

test("capture uses only deterministic non-agent command surfaces", () => {
  for (const required of ["install-software", "compile-profile", "validate-run", "pause-unknown-run", "play-unknown-run", "cockpit-unknown-run"]) assert.ok(source.includes(required));
  for (const forbidden of ["plan-run", "spawn-lead", "spawn-worker", "resume-planning", "approve-run", "supervise-run"]) assert.equal(source.includes(`\"${forbidden}\"`), false, forbidden);
});

test("oracle fingerprint itself is present and immutable-looking", () => {
  const fingerprint = JSON.parse(readFileSync(`${root}/reference/parity/oracle/rust-oracle-baseline/fingerprint.json`, "utf8"));
  assert.equal(fingerprint.tag.name, "rust-oracle-baseline");
  assert.match(fingerprint.tag.commit, /^[0-9a-f]{40}$/);
  assert.match(fingerprint.tag.tree, /^[0-9a-f]{40}$/);
});
