#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

import { findParityRoot } from "./parity-ledger.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function parseArgs(argv) {
  const options = { keep: false, output: undefined, targetDir: undefined };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    if (arg === "--output") options.output = args.shift();
    else if (arg === "--target-dir") options.targetDir = args.shift();
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

export function assertSafeOracleSource(repoRoot, oracleWorktree, fingerprint) {
  const commit = git(oracleWorktree, ["rev-parse", "HEAD"]);
  const tree = git(oracleWorktree, ["rev-parse", "HEAD^{tree}"]);
  let branch = "";
  try { branch = git(oracleWorktree, ["symbolic-ref", "--quiet", "HEAD"]); } catch {}
  if (commit !== fingerprint.tag.commit) throw new Error(`oracle worktree commit ${commit} is not frozen ${fingerprint.tag.commit}`);
  if (tree !== fingerprint.tag.tree) throw new Error(`oracle worktree tree ${tree} is not frozen ${fingerprint.tag.tree}`);
  if (branch) throw new Error(`oracle worktree must be detached, found ${branch}`);
  const common = git(repoRoot, ["rev-parse", "--git-common-dir"]);
  const oracleCommon = git(oracleWorktree, ["rev-parse", "--git-common-dir"]);
  if (resolve(repoRoot, common) !== resolve(oracleWorktree, oracleCommon)) throw new Error("oracle worktree is not attached to the expected repository");
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  return value;
}

function makeNormalizer(projectRoot, sandboxRoot) {
  const identities = new Map();
  const counters = new Map();
  const patterns = [
    ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i],
    ["ticket", /^T-[0-9a-f]+$/i], ["context", /^CTX-[0-9a-f]+$/i], ["output", /^OUT-[0-9a-f]+$/i],
    ["review", /^REV-[0-9a-f]+$/i], ["receipt", /^(RT|GR)-[0-9a-f]+$/i], ["snapshot", /^S-[0-9a-f]+$/i]
  ];
  const timestampKey = /(^|_)(at|time|timestamp)$|^(started_at|finished_at|issued_at|reviewed_at|recorded_at|created_at|updated_at|leased_at|heartbeat_at)$/;
  const commitKey = /^(git_commit|source_main_commit|commit|head|target_commit|parent_commit|transaction_commit_id)$/;
  const pathReplacements = [
    [resolve(projectRoot), "<project-root>"],
    [realpathSync(projectRoot), "<project-root>"],
    [resolve(sandboxRoot), "<sandbox-root>"],
    [realpathSync(sandboxRoot), "<sandbox-root>"]
  ].filter(([path], index, values) => values.findIndex(([candidate]) => candidate === path) === index)
    .sort((a, b) => b[0].length - a[0].length);

  function identity(value) {
    for (const [name, pattern] of patterns) {
      if (!pattern.test(value)) continue;
      if (!identities.has(value)) {
        const next = (counters.get(name) ?? 0) + 1;
        counters.set(name, next);
        identities.set(value, `<${name}:${next}>`);
      }
      return identities.get(value);
    }
    return value;
  }

  function normalize(value, key = "") {
    if (Array.isArray(value)) return value.map((item) => normalize(item, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((child) => [child, normalize(value[child], child)]));
    if (timestampKey.test(key)) return value == null ? value : "<timestamp>";
    if (commitKey.test(key) && typeof value === "string") return "<commit>";
    if (["pid", "broker_pid", "lead_pid"].includes(key) && typeof value === "number") return 1;
    if (typeof value !== "string") return value;
    let output = identity(value);
    if (output !== value) return output;
    for (const [path, replacement] of pathReplacements) output = output.split(path).join(replacement);
    output = output.replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, (match) => identity(match));
    output = output.replace(/\bT-[0-9a-f]+\b/gi, (match) => identity(match));
    output = output.replace(/\b[0-9a-f]{40}\b/gi, "<commit>");
    output = output.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>");
    return output;
  }
  return normalize;
}

function command(binary, id, args, env, normalize, { allowFailure = false } = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`${id} failed (${result.status}): ${result.stderr}`);
  const parse = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return "";
    try { return normalize(JSON.parse(trimmed)); } catch { return normalize(trimmed); }
  };
  return {
    id,
    argv: args.map((arg) => normalize(arg)),
    exit_code: result.status ?? 1,
    stdout: parse(result.stdout ?? ""),
    stderr: parse(result.stderr ?? "")
  };
}

function tree(root, prefixes) {
  const files = [];
  function normalizedBytes(path, bytes) {
    if (relative(root, path).split(sep).join("/") !== ".koni/migration-receipt.json") return { bytes, normalization: "raw" };
    const timestamp = /(^|_)(at|time|timestamp)$/;
    function normalizeReceipt(value, key = "") {
      if (Array.isArray(value)) return value.map((item) => normalizeReceipt(item, key));
      if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((child) => [child, normalizeReceipt(value[child], child)]));
      if (timestamp.test(key)) return value == null ? value : "<timestamp>";
      if (typeof value === "string") return value
        .split(realpathSync(root)).join("<project-root>")
        .split(resolve(root)).join("<project-root>")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<uuid>");
      return value;
    }
    const normalized = `${JSON.stringify(stableJson(normalizeReceipt(JSON.parse(bytes.toString("utf8")))), null, 2)}\n`;
    return { bytes: Buffer.from(normalized, "utf8"), normalization: "migration-receipt-v1" };
  }
  function visit(path) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`capture tree contains non-file ${path}`);
    const captured = normalizedBytes(path, readFileSync(path));
    files.push({ path: relative(root, path).split(sep).join("/"), bytes: captured.bytes.length, sha256: sha256(captured.bytes), normalization: captured.normalization });
  }
  for (const prefix of prefixes) visit(join(root, prefix));
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function findRunId(runs) {
  if (typeof runs === "string" && /^[0-9a-f-]{36}$/i.test(runs)) return runs;
  const candidates = Array.isArray(runs) ? runs : runs?.runs ?? runs?.entries ?? [];
  const first = Array.isArray(candidates) ? candidates[0] : Object.values(candidates)[0];
  const id = first?.run_id ?? first?.id;
  if (typeof id !== "string") throw new Error(`could not discover run id from runs projection: ${JSON.stringify(runs)}`);
  return id;
}

function scanSecrets(value) {
  const text = JSON.stringify(value);
  const patterns = [/(?:sk|sess)-[A-Za-z0-9_-]{20,}/g, /Bearer\s+[A-Za-z0-9._-]{20,}/g, /refresh_token["'=:\s]+[A-Za-z0-9._-]{12,}/gi];
  return patterns.flatMap((pattern) => text.match(pattern) ?? []);
}

function focusedContractTest(oracleWorktree, targetDir, env, id, integrationTarget, testName) {
  const args = ["test", "--locked", "-p", "koni-core", "--test", integrationTarget, testName, "--", "--exact"];
  const result = spawnSync("cargo", args, {
    cwd: oracleWorktree,
    env: { ...env, CARGO_TARGET_DIR: targetDir },
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${id} failed (${result.status}): ${result.stderr}\n${result.stdout}`);
  return {
    id,
    argv: ["cargo", ...args],
    exit_code: 0,
    stdout: { test: testName, passed: true },
    stderr: ""
  };
}

export function captureOracle({ repoRoot, oracleWorktree, binary, targetDir, sandboxRoot, projectRoot, homeRoot }) {
  const fingerprint = JSON.parse(readFileSync(join(repoRoot, "reference/parity/oracle/rust-oracle-baseline/fingerprint.json"), "utf8"));
  assertSafeOracleSource(repoRoot, oracleWorktree, fingerprint);
  if (!resolve(projectRoot).startsWith(`${resolve(sandboxRoot)}${sep}`)) throw new Error("project root must be inside the disposable sandbox");
  if (!resolve(homeRoot).startsWith(`${resolve(sandboxRoot)}${sep}`)) throw new Error("home root must be inside the disposable sandbox");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "# parity fixture\n", "utf8");
  execFileSync("git", ["init", "-b", "main", projectRoot], { stdio: "ignore" });
  git(projectRoot, ["config", "user.name", "Koni Parity"]);
  git(projectRoot, ["config", "user.email", "parity@invalid.example"]);
  git(projectRoot, ["add", "README.md"]);
  git(projectRoot, ["commit", "-m", "fixture"]);

  const env = {
    ...process.env,
    HOME: homeRoot,
    XDG_CONFIG_HOME: join(homeRoot, ".config"),
    XDG_DATA_HOME: join(homeRoot, ".local/share"),
    XDG_CACHE_HOME: join(homeRoot, ".cache"),
    PI_CODING_AGENT_DIR: join(homeRoot, ".pi/agent"),
    KONI_DISABLE_PROVIDER: "1",
    NO_COLOR: "1",
    TERM: "dumb"
  };
  const normalize = makeNormalizer(projectRoot, sandboxRoot);
  const commands = [];
  commands.push(command(binary, "install-software", ["init", "--profile", "software", "--target", projectRoot], env, normalize));
  const installTree = tree(projectRoot, [".koni", ".agents"]);
  commands.push(command(binary, "compile-profile", ["validate-profile", join(projectRoot, ".koni")], env, normalize));
  const initializedRaw = command(binary, "initialize-run", ["init-run", "--root", projectRoot, "--goal", "deterministic compiler parity fixture"], env, (value) => value);
  commands.push({ ...initializedRaw, stdout: normalize(initializedRaw.stdout), argv: initializedRaw.argv.map((arg) => normalize(arg)) });
  const runsRaw = command(binary, "list-runs-before", ["runs", "--root", projectRoot], env, (value) => value);
  commands.push({ ...runsRaw, stdout: normalize(runsRaw.stdout), argv: runsRaw.argv.map((arg) => normalize(arg)) });
  commands.push(command(binary, "validate-run", ["validate", "--root", projectRoot], env, normalize));
  const absentRunId = "00000000-0000-7000-8000-000000000001";
  commands.push(command(binary, "pause-unknown-run", ["pause-run", absentRunId, "--root", projectRoot], env, normalize, { allowFailure: true }));
  commands.push(command(binary, "play-unknown-run", ["play-run", absentRunId, "--root", projectRoot], env, normalize, { allowFailure: true }));
  commands.push(command(binary, "cockpit-unknown-run", ["--run", absentRunId, "cockpit", projectRoot, "--json"], env, normalize, { allowFailure: true }));
  commands.push(focusedContractTest(oracleWorktree, targetDir, env, "compile-ticket-contract", "graph_check_set", "selected_proof_that_is_also_a_ticket_target_compiles_once_deterministically"));
  commands.push(focusedContractTest(oracleWorktree, targetDir, env, "positive-run-control-contract", "run_lifecycle", "selected_run_play_pause_is_durable_across_planning_and_active_phases"));

  const capture = stableJson({
    schema_version: "1.0",
    protocol: "koni.oracle-command-capture.v1",
    oracle: { tag: fingerprint.tag.name, commit: fingerprint.tag.commit, tree: fingerprint.tag.tree },
    isolation: { detached_oracle_worktree: true, temporary_project: true, temporary_home: true, provider_calls: 0, live_project_mutations: 0 },
    platform: `${process.platform}-${process.arch}`,
    install_tree: installTree,
    commands,
    secret_scan: { passed: true, matches: [] }
  });
  const matches = scanSecrets(capture);
  if (matches.length) throw new Error(`secret scan failed: ${matches.length} matches`);
  return capture;
}

function main(argv) {
  const options = parseArgs(argv);
  const repoRoot = findParityRoot();
  const fingerprint = JSON.parse(readFileSync(join(repoRoot, "reference/parity/oracle/rust-oracle-baseline/fingerprint.json"), "utf8"));
  const sandboxRoot = mkdtempSync(join(tmpdir(), "koni-rust-oracle-"));
  const oracleWorktree = join(sandboxRoot, "oracle-source");
  const projectRoot = join(sandboxRoot, "project");
  const homeRoot = join(sandboxRoot, "home");
  const targetDir = resolve(options.targetDir ?? join(repoRoot, "target/parity-rust-oracle"));
  let attached = false;
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", oracleWorktree, fingerprint.tag.name], { stdio: ["ignore", "ignore", "inherit"] });
    attached = true;
    assertSafeOracleSource(repoRoot, oracleWorktree, fingerprint);
    execFileSync("cargo", ["build", "--locked", "-p", "koni-cli", "--bin", "koni"], {
      cwd: oracleWorktree,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: ["ignore", "ignore", "inherit"]
    });
    const binary = join(targetDir, "debug", process.platform === "win32" ? "koni.exe" : "koni");
    const capture = captureOracle({ repoRoot, oracleWorktree, binary, targetDir, sandboxRoot, projectRoot, homeRoot });
    const output = `${JSON.stringify(capture, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.output), output, "utf8");
    else process.stdout.write(output);
  } finally {
    if (attached && !options.keep) {
      try { execFileSync("git", ["-C", repoRoot, "worktree", "remove", "--force", oracleWorktree], { stdio: "ignore" }); } catch {}
    }
    if (!options.keep) rmSync(sandboxRoot, { recursive: true, force: true });
    else console.error(`Retained isolated oracle sandbox: ${sandboxRoot}`);
  }
}

if (resolve(process.argv[1] ?? "") === resolve(new URL(import.meta.url).pathname)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`ERROR ${error.message}`); process.exitCode = 1; }
}
