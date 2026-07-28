import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAuthorityEndpoint } from "../src/authority/endpoint.js";
import type { TransactionWrite } from "../src/authority/file-journal.js";
import {
  type CommunityResourceError,
  pinCommunityResourceBundle,
  selectCommunityAttemptResources,
  validatePinnedCommunityResourceBundle,
} from "../src/compiler/community-resources.js";
import {
  NativeRunCompilerProgram,
  type NativeRunProgramError,
} from "../src/compiler/run-program.js";
import type { VerifiedProfileBaseline } from "../src/compiler/profile-package.js";
import { computeLaunchResourceSetHash, type AgentLaunchSpec } from "../src/pi/launch-spec.js";
import { installProfile, loadProfilePackage } from "../src/profile/install.js";
import {
  discoverInstalledPiPackageReferences,
  parsePiResourceBindingCatalog,
  type InstalledPiPackageReference,
} from "../src/profile/resource-bindings.js";
import { canonicalHash, type Sha256Digest } from "../src/shared/canonical.js";
import { newRunLifecycle, reduceRunLifecycle } from "../src/state/run-lifecycle.js";
import type { AgentAttemptRecord, RunRecord } from "../src/state/run-record.js";
import { fixtureRunGit } from "./run-record-fixtures.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const FIXED_NOW = new Date("2026-07-16T20:00:00.000Z");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("compiler-selected Pi community resources", () => {
  it("pins only exact text selections and never evaluates package extensions", async () => {
    const fixture = await communityPackage();
    const catalog = parsePiResourceBindingCatalog(skillsCatalog());
    const bundle = await pinCommunityResourceBundle({
      catalog,
      installed: [fixture.reference],
    });

    expect(Object.keys(bundle.bindings)).toEqual(["review-methods"]);
    expect(
      bundle.bindings["review-methods"]?.files.map(({ relativePath }) => relativePath),
    ).toEqual([
      "prompts/review.md",
      "skills/review/SKILL.md",
      "skills/review/references/details.md",
    ]);
    expect(
      bundle.bindings["review-methods"]?.files.some(
        ({ relativePath }) =>
          relativePath.includes("unselected") || relativePath.includes("extensions"),
      ),
    ).toBe(false);
    await expect(readFile(fixture.marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const ineligible = selectCommunityAttemptResources({
      bundle,
      personaId: "reviewer",
      stageIds: ["orchestrate"],
      networkAccess: false,
    });
    expect(ineligible).toEqual({ resources: [], toolNames: [], bindingIds: [] });

    const selected = selectCommunityAttemptResources({
      bundle,
      personaId: "run-planner",
      stageIds: ["focused-plan"],
      networkAccess: false,
    });
    expect(selected.bindingIds).toEqual(["review-methods"]);
    expect(selected.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          relativePath: "community/review-methods/skills/review/SKILL.md",
        }),
        expect.objectContaining({
          kind: "prompt",
          relativePath: "community/review-methods/prompts/review.md",
        }),
        expect.objectContaining({ kind: "append_system_prompt" }),
      ]),
    );
    expect(computeLaunchResourceSetHash(selected.resources)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects tampered pinned resource bytes and paths before launch", async () => {
    const fixture = await communityPackage();
    const bundle = await pinCommunityResourceBundle({
      catalog: parsePiResourceBindingCatalog(skillsCatalog()),
      installed: [fixture.reference],
    });
    const changedBytes = structuredClone(bundle) as unknown as {
      bindings: Record<string, { files: Array<{ content: string }> }>;
    };
    changedBytes.bindings["review-methods"]!.files[0]!.content = "tampered";
    expect(() => validatePinnedCommunityResourceBundle(changedBytes)).toThrowError(
      expect.objectContaining({ code: "pinned_file" }) as CommunityResourceError,
    );

    const escapingPath = structuredClone(bundle) as unknown as {
      bindings: Record<string, { files: Array<{ relativePath: string }> }>;
    };
    escapingPath.bindings["review-methods"]!.files[0]!.relativePath = "../ambient.md";
    expect(() => validatePinnedCommunityResourceBundle(escapingPath)).toThrowError(
      expect.objectContaining({ code: "resource_path" }) as CommunityResourceError,
    );
  });

  it("fails closed for unknown extension APIs and gates Koni-owned network adapters", async () => {
    const fixture = await communityPackage();
    const catalog = parsePiResourceBindingCatalog(explicitToolCatalog());
    await expect(
      pinCommunityResourceBundle({ catalog, installed: [fixture.reference] }),
    ).rejects.toMatchObject({
      code: "adapter_unavailable",
    } satisfies Partial<CommunityResourceError>);
    await expect(readFile(fixture.marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const bundle = await pinCommunityResourceBundle({
      catalog,
      installed: [fixture.reference],
      adapters: [
        {
          id: "bounded-web-check",
          bindingId: "web-tools",
          packageName: "fixture-community",
          toolName: "koni_run_check",
          requiresNetwork: true,
        },
      ],
    });
    expect(() =>
      selectCommunityAttemptResources({
        bundle,
        personaId: "verifier",
        stageIds: ["verification"],
        networkAccess: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "network_grant" }) as CommunityResourceError);
    expect(
      selectCommunityAttemptResources({
        bundle,
        personaId: "verifier",
        stageIds: ["verification"],
        networkAccess: true,
      }),
    ).toEqual({
      resources: [],
      toolNames: ["koni_run_check"],
      bindingIds: ["web-tools"],
    });
  });

  it("uses Pi's read-only resolver without changing settings or inheriting ambient files", async () => {
    const fixture = await communityPackage();
    const root = await temporaryRoot("koni-pi-inventory-");
    const projectRoot = path.join(root, "project");
    const agentDir = path.join(root, "pi-agent");
    await mkdir(projectRoot);
    await mkdir(agentDir);
    const settingsPath = path.join(agentDir, "settings.json");
    const settings = `${JSON.stringify(
      {
        packages: [fixture.root],
        skills: [path.join(root, "ambient-skill")],
        extensions: [path.join(root, "ambient-extension.ts")],
      },
      null,
      2,
    )}\n`;
    await writeFile(settingsPath, settings);
    const inventory = await discoverInstalledPiPackageReferences({
      projectRoot,
      agentDir,
      projectTrusted: false,
    });

    expect(await readFile(settingsPath, "utf8")).toBe(settings);
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      packageName: "fixture-community",
      packageVersion: "1.0.0",
      packageRoot: fixture.root,
    });
    expect(
      inventory[0]?.resources.map(({ kind, relativePath }) => `${kind}:${relativePath}`),
    ).toEqual([
      "extension:extensions/index.ts",
      "prompt:prompts/review.md",
      "prompt:prompts/unselected.md",
      "skill:skills/review/SKILL.md",
    ]);
  });

  it("hash-binds eligible selections into launch specs and ignores later package upgrades", async () => {
    const fixture = await communityPackage();
    const project = await installedCodingProject();
    await writeFile(
      path.join(project.projectRoot, ".koni", "resources", "pi-packages.yaml"),
      skillsCatalog(),
    );
    let inventoryReads = 0;
    const program = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      installedPiPackagesLoader: async () => {
        inventoryReads += 1;
        return [fixture.reference];
      },
      now: () => new Date(FIXED_NOW),
    });
    const resolved = await program.resolveRun({
      runId: "run-community-pinned",
      objective: "Use one selected planning method",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Use one selected planning method" },
    });
    expect(inventoryReads).toBe(1);
    await persistWrites(project.projectRoot, resolved.artifactWrites ?? []);
    const run = runRecord(project.projectRoot, resolved, "Use one selected planning method");
    const first = await program.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-community-one",
      sessionId: "session-community-one",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("authority-two"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    await persistWrites(project.projectRoot, first.artifactWrites ?? []);
    expect(first.spec.resources.setHash).toBe(
      computeLaunchResourceSetHash(first.spec.resources.entries),
    );
    expect(first.spec.resources.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining("Original review method") }),
        expect.objectContaining({ content: expect.stringContaining("Original review prompt") }),
      ]),
    );
    expect(
      first.spec.resources.entries.some(({ relativePath }) => relativePath.includes("unselected")),
    ).toBe(false);
    expect(first.spec.tools.find(({ name }) => name === "koni_read_resource")?.schemaHash).toMatch(
      /^sha256:/u,
    );

    await writeFile(
      path.join(fixture.root, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: changed\n---\nUpgraded method.\n",
    );
    await writeFile(
      path.join(fixture.root, "prompts", "review.md"),
      "---\ndescription: changed\n---\nUpgraded prompt.\n",
    );

    const restarted = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      installedPiPackagesLoader: async () => {
        throw new Error("a pinned run must not consult mutable Pi packages");
      },
      now: () => new Date(FIXED_NOW),
    });
    const second = await restarted.prepareAttempt({
      kind: "planning",
      run,
      attemptId: "attempt-community-two",
      sessionId: "session-community-two",
      nextAuthorityRevision: 2,
      expectedAuthorityStateHash: digest("authority-two"),
      lineage: { branchEpoch: 0, reason: "initial" },
    });
    expect(second.spec.resources.setHash).toBe(first.spec.resources.setHash);
    expect(second.spec.resources.entries).toEqual(first.spec.resources.entries);
    expect(JSON.stringify(second.spec.resources.entries)).not.toContain("Upgraded");

    const attempt = attemptRecord(first.spec);
    run.attempts[attempt.id] = attempt;
    await expect(
      restarted.recoverAttempt({ run, attempt, spec: first.spec }),
    ).resolves.toMatchObject({
      spec: { resources: { setHash: first.spec.resources.setHash } },
    });
  });

  it("reports missing enabled packages but leaves interactive-only bindings ambient", async () => {
    const project = await installedCodingProject();
    const resourcePath = path.join(project.projectRoot, ".koni", "resources", "pi-packages.yaml");
    await writeFile(resourcePath, skillsCatalog());
    const missing = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      installedPiPackagesLoader: async () => [],
      now: () => new Date(FIXED_NOW),
    });
    await expect(
      missing.resolveRun({
        runId: "run-community-missing",
        objective: "Fail closed on missing resources",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Fail closed on missing resources" },
      }),
    ).rejects.toMatchObject({
      code: "community_resource_unavailable",
    } satisfies Partial<NativeRunProgramError>);

    await writeFile(resourcePath, interactiveCatalog());
    let inventoryReads = 0;
    const interactive = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      installedPiPackagesLoader: async () => {
        inventoryReads += 1;
        return [];
      },
      now: () => new Date(FIXED_NOW),
    });
    await expect(
      interactive.resolveRun({
        runId: "run-interactive-only",
        objective: "Keep operator resources ambient",
        runTypeId: "small",
        targetRef: "refs/heads/main",
        intake: { goal: "Keep operator resources ambient" },
      }),
    ).resolves.toMatchObject({ runTypeId: "small" });
    expect(inventoryReads).toBe(0);
  });

  it("keeps pre-community pinned run artifacts resumable", async () => {
    const project = await installedCodingProject();
    const program = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      now: () => new Date(FIXED_NOW),
    });
    const resolved = await program.resolveRun({
      runId: "run-community-pinned",
      objective: "Resume an artifact issued before community bindings",
      runTypeId: "small",
      targetRef: "refs/heads/main",
      intake: { goal: "Resume an artifact issued before community bindings" },
    });
    const write = resolved.artifactWrites?.[0];
    if (write === undefined) throw new Error("expected pinned configuration artifact");
    const parsed = JSON.parse(Buffer.from(write.bytes).toString("utf8")) as Record<string, unknown>;
    delete parsed.artifactSha256;
    delete parsed.community;
    const legacyArtifact = { ...parsed, artifactSha256: canonicalHash(parsed) };
    await persistWrites(project.projectRoot, [
      {
        path: write.path,
        bytes: Buffer.from(`${JSON.stringify(legacyArtifact)}\n`, "utf8"),
        expectedSha256: null,
      },
    ]);

    const restarted = await NativeRunCompilerProgram.create({
      projectRoot: project.projectRoot,
      packageBaseline: project.baseline,
      installedPiPackagesLoader: async () => {
        throw new Error("recovery must not consult Pi's mutable package inventory");
      },
      now: () => new Date(FIXED_NOW),
    });
    const run = runRecord(
      project.projectRoot,
      resolved,
      "Resume an artifact issued before community bindings",
    );
    await expect(
      restarted.prepareAttempt({
        kind: "planning",
        run,
        attemptId: "attempt-pre-community",
        sessionId: "session-pre-community",
        nextAuthorityRevision: 2,
        expectedAuthorityStateHash: digest("pre-community-authority"),
        lineage: { branchEpoch: 0, reason: "initial" },
      }),
    ).resolves.toMatchObject({
      spec: {
        resources: {
          entries: expect.not.arrayContaining([
            expect.objectContaining({ relativePath: expect.stringContaining("community/") }),
          ]),
        },
      },
    });
  });
});

async function communityPackage(): Promise<{
  root: string;
  marker: string;
  reference: InstalledPiPackageReference;
}> {
  const root = await temporaryRoot("koni-community-package-");
  const marker = path.join(root, "extension-executed.txt");
  await mkdir(path.join(root, "extensions"));
  await mkdir(path.join(root, "skills", "review", "references"), { recursive: true });
  await mkdir(path.join(root, "prompts"));
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-community",
        version: "1.0.0",
        pi: {
          extensions: ["extensions/index.ts"],
          skills: ["skills"],
          prompts: ["prompts"],
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "extensions", "index.ts"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`,
  );
  await writeFile(
    path.join(root, "skills", "review", "SKILL.md"),
    [
      "---",
      "name: review",
      "description: Review a bounded plan.",
      "---",
      "Original review method.",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "skills", "review", "references", "details.md"),
    "Original method details.\n",
  );
  await writeFile(
    path.join(root, "prompts", "review.md"),
    "---\ndescription: Review\n---\nOriginal review prompt.\n",
  );
  await writeFile(
    path.join(root, "prompts", "unselected.md"),
    "Never inherit this ambient prompt.\n",
  );
  return {
    root,
    marker,
    reference: {
      source: root,
      packageName: "fixture-community",
      packageVersion: "1.0.0",
      packageRoot: root,
      resources: [
        { kind: "extension", relativePath: "extensions/index.ts", ambientEnabled: true },
        { kind: "prompt", relativePath: "prompts/review.md", ambientEnabled: true },
        { kind: "prompt", relativePath: "prompts/unselected.md", ambientEnabled: true },
        { kind: "skill", relativePath: "skills/review/SKILL.md", ambientEnabled: true },
      ],
    },
  };
}

function skillsCatalog(): string {
  return `protocol: koni.pi-resource-bindings.v1
bindings:
  - id: review-methods
    package: fixture-community
    description: Exact planning resources.
    enabled: true
    integration: skills_only
    resources: [skill, prompt]
    select:
      skills: [skills/review/SKILL.md]
      prompts: [prompts/review.md]
      tools: []
    stages: [focused-plan]
    personas: [run-planner]
    requires_network: false
    rationale: Explicit project selection.
`;
}

function explicitToolCatalog(): string {
  return `protocol: koni.pi-resource-bindings.v1
bindings:
  - id: web-tools
    package: fixture-community
    description: Authority-backed bounded network adapter.
    enabled: true
    integration: explicit_tools
    resources: [extension]
    select:
      skills: []
      prompts: []
      tools: [bounded-web-check]
    stages: [verification]
    personas: [verifier]
    requires_network: true
    rationale: Extension code remains unloaded.
`;
}

function interactiveCatalog(): string {
  return `protocol: koni.pi-resource-bindings.v1
bindings:
  - id: context-mode
    package: fixture-community
    description: Operator-only ambient extension.
    enabled: true
    integration: interactive_only
    resources: [extension, skill]
    stages: []
    personas: []
    requires_network: false
    rationale: Never enters contained attempts.
`;
}

async function installedCodingProject(): Promise<{
  projectRoot: string;
  baseline: VerifiedProfileBaseline;
}> {
  const root = await temporaryRoot("koni-community-project-");
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot);
  git(projectRoot, ["init", "--initial-branch=main"]);
  git(projectRoot, ["config", "user.name", "Koni Test"]);
  git(projectRoot, ["config", "user.email", "koni@example.invalid"]);
  await writeFile(path.join(projectRoot, "README.md"), "# Fixture\n");
  git(projectRoot, ["add", "README.md"]);
  git(projectRoot, ["commit", "-m", "fixture"]);
  const packageRoot = path.resolve(repositoryRoot, "packages", "coding-profile");
  const baseline = await loadProfilePackage(packageRoot);
  await installProfile(projectRoot, packageRoot);
  return { projectRoot, baseline };
}

function runRecord(
  projectRoot: string,
  resolved: Awaited<ReturnType<NativeRunCompilerProgram["resolveRun"]>>,
  objective: string,
): RunRecord {
  const lifecycle = reduceRunLifecycle(newRunLifecycle("run-community-pinned"), {
    type: "planning_started",
    atMs: FIXED_NOW.getTime(),
  }).state;
  return {
    protocol: "koni.run-record.v1",
    id: "run-community-pinned",
    revision: 1,
    generation: lifecycle.generation,
    projectRoot,
    profile: resolved.profile,
    compiledConfigHash: resolved.compiledConfigHash,
    runTypeId: resolved.runTypeId,
    planningMode: resolved.planningMode,
    objective,
    intake: { goal: objective },
    executionConfig: resolved.executionConfig,
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    lifecycle,
    pipelineStageIds: resolved.pipelineStageIds,
    currentPipelineStageId: "focused-plan",
    plan: undefined,
    graphRevision: 0,
    graphHash: undefined,
    tickets: {},
    attempts: {},
    questions: {},
    activity: [],
    git: fixtureRunGit(projectRoot, "run-community-pinned"),
  };
}

function attemptRecord(spec: AgentLaunchSpec): AgentAttemptRecord {
  return {
    id: spec.identity.attemptId,
    sessionId: spec.identity.sessionId,
    ticketId: spec.identity.ticketId,
    stepId: spec.identity.stepId,
    personaId: spec.persona.id,
    modelProvider: spec.model.provider,
    modelId: spec.model.id,
    thinkingLevel: spec.model.thinkingLevel,
    status: "running",
    launchSpecHash: spec.specHash,
    sessionFile: undefined,
    startedAt: FIXED_NOW.toISOString(),
    endedAt: undefined,
    terminalSummary: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    lineage: structuredClone(spec.lineage),
    authorityMessages: [],
    authorityToolResults: [],
    authorityCompactions: [],
    kind: "planning",
  };
}

async function persistWrites(
  projectRoot: string,
  writes: readonly TransactionWrite[],
): Promise<void> {
  const endpoint = await discoverAuthorityEndpoint(projectRoot);
  for (const write of writes) {
    const destination = path.join(endpoint.stateRoot, write.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, write.bytes);
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function digest(value: string): Sha256Digest {
  return canonicalHash(value);
}

function git(cwd: string, argv: string[]): string {
  const result = spawnSync("git", argv, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${argv.join(" ")} failed`);
  return result.stdout.trim();
}
