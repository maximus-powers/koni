import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "release.yml");

test("matrix release jobs never upload colliding artifact names", async () => {
  const workflow = YAML.parse(await readFile(workflowPath, "utf8"));

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const matrix = job.strategy?.matrix ?? {};
    const varyingDimensions = Object.entries(matrix)
      .filter(([, values]) => Array.isArray(values) && values.length > 1)
      .map(([name]) => name);
    if (varyingDimensions.length === 0) continue;

    for (const step of job.steps ?? []) {
      if (!String(step.uses ?? "").startsWith("actions/upload-artifact@")) continue;
      const artifactName = String(step.with?.name ?? "");
      for (const dimension of varyingDimensions) {
        assert.match(
          artifactName,
          new RegExp(`\\$\\{\\{\\s*matrix\\.${dimension}\\s*\\}\\}`),
          `${jobId} uploads one artifact from multiple matrix.${dimension} values as ${JSON.stringify(artifactName)}`,
        );
      }
    }
  }
});
