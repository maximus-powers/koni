import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "packages/core/src");
const defaultLineLimit = 2_500;

const grandfatheredLineLimits = new Map([
  ["packages/core/src/authority/run-engine.ts", 19_864],
  ["packages/core/src/compiler/configuration.ts", 2_749],
  ["packages/core/src/compiler/run-program.ts", 13_139],
  ["packages/core/src/control-center/component.ts", 4_433],
  ["packages/core/src/control-center/controller.ts", 5_957],
  ["packages/core/src/git/lifecycle.ts", 4_517],
  ["packages/core/src/pi/attempt-process-supervisor.ts", 2_584],
  ["packages/core/src/pi/managed-session.ts", 3_799],
  ["packages/core/src/state/run-record.ts", 6_134],
]);

const forbiddenFacadeImports = new Map([
  ["packages/core/src/authority/action-execution.ts", "./run-engine.js"],
  ["packages/core/src/authority/config-documents.ts", "./run-engine.js"],
  ["packages/core/src/authority/configured-lifecycle.ts", "./run-engine.js"],
  ["packages/core/src/authority/execution-policy.ts", "./run-engine.js"],
  ["packages/core/src/authority/monitor-methods.ts", "./run-engine.js"],
  ["packages/core/src/authority/monitor-projection.ts", "./run-engine.js"],
  ["packages/core/src/compiler/action-recipes.ts", "./run-program.js"],
  ["packages/core/src/compiler/execution-semantics.ts", "./run-program.js"],
  ["packages/core/src/compiler/graph-constraints.ts", "./run-program.js"],
  ["packages/core/src/compiler/ticket-dependencies.ts", "./run-program.js"],
  ["packages/core/src/pi/interactive-tools.ts", "./managed-session.js"],
  ["packages/core/src/pi/tool-renderer.ts", "./managed-session.js"],
  ["packages/core/src/pi/transcript-page.ts", "./managed-session.js"],
]);

test("production TypeScript modules stay within their architecture budgets", async () => {
  const violations = [];
  for (const absolutePath of await listTypeScriptFiles(sourceRoot)) {
    const relativePath = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
    const contents = await readFile(absolutePath, "utf8");
    const lineCount = contents.endsWith("\n")
      ? contents.slice(0, -1).split("\n").length
      : contents.split("\n").length;
    const limit = grandfatheredLineLimits.get(relativePath) ?? defaultLineLimit;
    if (lineCount > limit) {
      violations.push(`${relativePath}: ${lineCount} lines exceeds ${limit}`);
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

test("extracted leaf modules do not import their owning facade", async () => {
  const violations = [];
  for (const [relativePath, forbiddenImport] of forbiddenFacadeImports) {
    const contents = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    if (
      contents.includes(`from "${forbiddenImport}"`) ||
      contents.includes(`from '${forbiddenImport}'`)
    ) {
      violations.push(`${relativePath}: imports ${forbiddenImport}`);
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});

async function listTypeScriptFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await listTypeScriptFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      output.push(absolutePath);
    }
  }
  return output.sort();
}
