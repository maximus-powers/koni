import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileTransactionStore } from "../src/authority/file-journal.js";
import { compileProfileConfiguration } from "../src/compiler/configuration.js";
import { compileProjectDirectory } from "../src/compiler/project-directory.js";
import type { ValidationResult } from "../src/shared/diagnostics.js";
import {
  installProfile,
  loadProfilePackage,
  withProfileLifecycleLock,
} from "../src/profile/install.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("authenticated project directory compiler boundary", () => {
  it("compiles exact current bytes while excluding only compiler-owned state", async () => {
    const { root, projectRoot, baseline } = await installedProject("coding-profile");
    await writeNested(
      join(projectRoot, ".koni/.managed/upstream/noise.txt"),
      "ignored managed bytes\n",
    );
    await writeNested(join(projectRoot, ".koni/runs/legacy/run.json"), "{}\n");

    const compiled = await compileProjectDirectory(projectRoot, baseline);
    expect(compiled.ok, diagnostics(compiled)).toBe(true);
    const frozen = compileProfileConfiguration(baseline);
    expect(frozen.ok, diagnostics(frozen)).toBe(true);
    if (!compiled.ok || !frozen.ok) return;
    expect(compiled.value.configuration_sha256).toBe(frozen.value.configuration_sha256);
    expect(compiled.value.effective_bundle_sha256).toBe(frozen.value.effective_bundle_sha256);
    expect(Object.isFrozen(compiled.value)).toBe(true);
    expect(root).toContain("koni-project-directory-");
  });

  it("classifies editable config, agent, skill, and prompt resources from their paths", async () => {
    const { projectRoot, baseline } = await installedProject("coding-profile");
    const original = await compileProjectDirectory(projectRoot, baseline);
    expect(original.ok, diagnostics(original)).toBe(true);
    if (!original.ok) return;

    await writeFile(
      join(projectRoot, ".koni/project.yaml"),
      (await readFile(join(projectRoot, ".koni/project.yaml"), "utf8")).replace(
        "title: Software project",
        "title: Project-local software",
      ),
    );
    await writeFile(join(projectRoot, ".koni/project-local.yaml"), "project_local: true\n");
    await writeNested(
      join(projectRoot, ".koni/resources/skills/project-local/SKILL.md"),
      "# Local skill\n",
    );
    await writeNested(
      join(projectRoot, ".koni/prompts/project-local.md"),
      "Project-local prompt.\n",
    );
    const agent = (await readFile(join(projectRoot, ".koni/agents/lead.yaml"), "utf8"))
      .replace("id: lead", "id: project-local-agent")
      .replace("description: Supervises", "description: Locally supervises");
    await writeFile(join(projectRoot, ".koni/agents/project-local-agent.yaml"), agent);

    const compiled = await compileProjectDirectory(projectRoot, baseline);
    expect(compiled.ok, diagnostics(compiled)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.project.project).toMatchObject({ title: "Project-local software" });
    expect(compiled.value.agents["project-local-agent"]?.id).toBe("project-local-agent");
    expect(compiled.value.baseline_bundle_sha256).toBe(original.value.baseline_bundle_sha256);
    expect(compiled.value.effective_bundle_sha256).not.toBe(original.value.effective_bundle_sha256);
    expect(compiled.value.configuration_sha256).not.toBe(original.value.configuration_sha256);
  });

  it("requires trusted package provenance instead of trusting managed metadata", async () => {
    const { projectRoot } = await installedProject("coding-profile");
    const wrongPackage = await loadProfilePackage(
      resolve(repositoryRoot, "packages", "research-profile"),
    );
    const result = await compileProjectDirectory(projectRoot, wrongPackage);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_source.provenance_mismatch",
    );
  });

  it("rejects forged install provenance even when it remains structurally valid", async () => {
    const { projectRoot, baseline } = await installedProject("coding-profile");
    const installPath = join(projectRoot, ".koni/.managed/install.json");
    const metadata = JSON.parse(await readFile(installPath, "utf8")) as {
      package: { name: string };
    };
    metadata.package.name = "@koni/forged-profile";
    await writeFile(installPath, `${JSON.stringify(metadata, null, 2)}\n`);

    const result = await compileProjectDirectory(projectRoot, baseline);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_source.provenance_mismatch",
    );
  });

  it("fails closed on symlinks and untracked file kinds", async () => {
    const linked = await installedProject("coding-profile");
    const outside = join(linked.root, "outside.yaml");
    await writeFile(outside, "outside: true\n");
    await symlink(outside, join(linked.projectRoot, ".koni/escape.yaml"));
    const symlinked = await compileProjectDirectory(linked.projectRoot, linked.baseline);
    expect(symlinked.ok).toBe(false);
    expect(symlinked.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_source.symlink",
    );

    const untracked = await installedProject("coding-profile");
    await writeFile(join(untracked.projectRoot, ".koni/notes.md"), "not a classified prompt\n");
    const unsafeKind = await compileProjectDirectory(untracked.projectRoot, untracked.baseline);
    expect(unsafeKind.ok).toBe(false);
    expect(unsafeKind.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_source.untracked_file_kind",
    );
  });

  it("refuses an unrelated compile while profile publication owns the lifecycle lock", async () => {
    const { projectRoot, baseline } = await installedProject("coding-profile");
    const configRoot = join(projectRoot, ".koni");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publication = withProfileLifecycleLock(configRoot, async () => {
      acquired();
      await releasePromise;
    });
    await acquiredPromise;
    try {
      const result = await compileProjectDirectory(projectRoot, baseline);
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "project_source.profile_update_active",
      );
    } finally {
      release();
      await publication;
    }
  });

  it("refuses a crash-pending profile transaction until recovery retires it", async () => {
    const { projectRoot, baseline } = await installedProject("coding-profile");
    const configRoot = join(projectRoot, ".koni");
    const store = await FileTransactionStore.open(configRoot);
    await store.prepare("profile-race", [
      {
        path: ".managed/recovery-marker.json",
        bytes: Buffer.from("{}\n", "utf8"),
        expectedSha256: null,
      },
    ]);

    const pending = await compileProjectDirectory(projectRoot, baseline);
    expect(pending.ok).toBe(false);
    expect(pending.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "project_source.transaction_pending",
    );

    expect(await store.recoverPrepared()).toEqual(["profile-race"]);
    const recovered = await compileProjectDirectory(projectRoot, baseline);
    expect(recovered.ok, diagnostics(recovered)).toBe(true);
  });
});

async function installedProject(packageDirectory: string): Promise<{
  root: string;
  projectRoot: string;
  baseline: Awaited<ReturnType<typeof loadProfilePackage>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "koni-project-directory-"));
  temporaryRoots.push(root);
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const packageRoot = resolve(repositoryRoot, "packages", packageDirectory);
  const baseline = await loadProfilePackage(packageRoot);
  await installProfile(projectRoot, packageRoot);
  return { root, projectRoot, baseline };
}

async function writeNested(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function diagnostics(result: ValidationResult<unknown>): string {
  return result.diagnostics
    .map((diagnostic) => `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
    .join("\n");
}
