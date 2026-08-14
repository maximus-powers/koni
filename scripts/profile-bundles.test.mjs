import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTATIONS = Object.freeze([
  Object.freeze({
    directory: "coding-profile",
    packageName: "@koni/coding-profile",
    packageVersion: "0.8.33",
    profileId: "software",
    profileVersion: "0.8.33",
    lineage: "koni.software",
    fileCount: 27,
    kinds: { config: 17, agent: 10, skill: 0, other: 0 },
    // Reviewed in-tree profile baseline.
    digest: "sha256:c0620f39ecc961041773080668ee0cdfba224f96a33f245b1b37320e4e38d385",
    migration: {
      id: "retire-inert-semantics-v1",
      kind: "retire_yaml_fields",
      from_profile_range: ">=0.7.0 <0.8.0",
      from_bundle_sha256: [
        "sha256:4e955f7fb5a6bbd58542f395471d2e3f1c87364840abd218f973b8f62a5c0c7e",
      ],
      path: "migrations/retire-inert-semantics-v1.json",
      sha256: "sha256:76557e8ef44078c59656280cc2af17bdfab09797205e04eb35be906cd88b395d",
    },
  }),
  Object.freeze({
    directory: "research-profile",
    packageName: "@koni/research-profile",
    packageVersion: "1.1.44",
    profileId: "research",
    profileVersion: "1.1.44",
    lineage: "koni.research",
    fileCount: 29,
    kinds: { config: 15, agent: 13, skill: 0, other: 1 },
    // Reviewed in-tree profile baseline.
    digest: "sha256:42944fa6eb6658ba1bd650228975c2dfeef1fc5fcfa319c551203226d1b1d9dd",
    migration: {
      id: "retire-inert-semantics-v1",
      kind: "retire_yaml_fields",
      from_profile_range: ">=1.0.11 <1.1.0",
      from_bundle_sha256: [
        "sha256:1bc8bdb64934ccd475f50acad5b22a7b1b6f7e168a748ecd91e234be76126c60",
      ],
      path: "migrations/retire-inert-semantics-v1.json",
      sha256: "sha256:c807436b04f7d44ea65cce5cfa6ed8cba3c4e5d8d571034f7fecc25c9fd117a5",
    },
  }),
]);

function portablePath(path) {
  return path.split(sep).join("/");
}

function classify(path) {
  if (path.startsWith("agents/")) return "agent";
  if (path.startsWith("resources/skills/")) return "skill";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "config";
  return "other";
}

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const metadata = await lstat(absolute);
    assert.equal(metadata.isSymbolicLink(), false, `bundle contains symlink ${absolute}`);
    if (metadata.isDirectory()) {
      files.push(...(await walk(root, absolute)));
    } else {
      assert.equal(metadata.isFile(), true, `bundle contains non-file ${absolute}`);
      files.push(absolute);
    }
  }
  return files;
}

async function independentInventory(root) {
  const inventory = [];
  for (const absolute of await walk(root)) {
    const bytes = await readFile(absolute);
    const path = portablePath(relative(root, absolute));
    inventory.push({
      path,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      size_bytes: bytes.byteLength,
      kind: classify(path),
    });
  }
  inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return inventory;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort(compareUtf8);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function independentDigest(files, migrations = []) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.path}\0${file.sha256}\0${file.size_bytes}\0${file.kind}\0`);
  }
  if (migrations.length > 0) {
    hash.update("koni.profile-migrations.v1\0");
    for (const migration of migrations.map(canonicalJson).sort(compareUtf8)) {
      hash.update(`${migration}\0`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

for (const expected of EXPECTATIONS) {
  test(`${expected.packageName} manifest pins the complete profile baseline`, async () => {
    const packageRoot = join(repositoryRoot, "packages", expected.directory);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "koni", "profile-manifest.json"), "utf8"),
    );
    const baselineRoot = join(packageRoot, "koni", "baseline");
    const inventory = await independentInventory(baselineRoot);

    assert.deepEqual(Object.keys(manifest).sort(), [
      "baseline",
      "bundle_sha256",
      "compatibility",
      "migrations",
      "package",
      "profile",
      "protocol",
    ]);
    assert.equal(manifest.protocol, "koni.profile-package.v1");
    assert.deepEqual(manifest.package, {
      name: expected.packageName,
      version: expected.packageVersion,
    });
    assert.deepEqual(manifest.profile, {
      id: expected.profileId,
      display_name: expected.profileId === "software" ? "Coding" : "Research",
      version: expected.profileVersion,
      lineage: expected.lineage,
    });
    assert.deepEqual(manifest.compatibility, {
      core_api_range: ">=1.0.0 <2.0.0",
      profile_schema_range: ">=3.0.0 <4.0.0",
      pi_range: ">=0.80.10 <0.81.0",
    });
    assert.equal(manifest.baseline.root, "./baseline");
    assert.deepEqual(manifest.baseline.files, inventory);
    assert.deepEqual(manifest.migrations, [expected.migration]);
    const migrationBytes = await readFile(join(packageRoot, "koni", expected.migration.path));
    assert.equal(
      `sha256:${createHash("sha256").update(migrationBytes).digest("hex")}`,
      expected.migration.sha256,
    );
    assert.equal(inventory.length, expected.fileCount);
    assert.equal(manifest.bundle_sha256, independentDigest(inventory, manifest.migrations));
    assert.equal(manifest.bundle_sha256, expected.digest);

    const kinds = { config: 0, agent: 0, skill: 0, prompt: 0, other: 0 };
    for (const file of inventory) kinds[file.kind] += 1;
    assert.deepEqual(kinds, { ...expected.kinds, prompt: 0 });
    assert.equal(
      inventory.some(({ path }) =>
        ["migration-receipt.json", "resource-manifest.json"].includes(path),
      ),
      false,
    );
  });

  test(`${expected.packageName} materializes exactly its manifest inventory`, async () => {
    const packageRoot = join(repositoryRoot, "packages", expected.directory);
    const manifest = JSON.parse(
      await readFile(join(packageRoot, "koni", "profile-manifest.json"), "utf8"),
    );
    const baselineRoot = join(packageRoot, "koni", "baseline");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "koni-profile-materialize-"));
    const destination = join(temporaryRoot, ".koni");
    await cp(baselineRoot, destination, { recursive: true, errorOnExist: true });

    const materialized = await independentInventory(destination);
    assert.deepEqual(materialized, manifest.baseline.files);
    for (const file of materialized) {
      assert.equal(file.path.startsWith("../"), false);
      assert.equal(file.path.startsWith(".managed/"), false);
    }
  });
}

test("Core carries one shared Koni skill resource tree", async () => {
  const skills = await independentInventory(join(repositoryRoot, "packages", "core", "skills"));
  assert.equal(skills.length, 18);
  assert.deepEqual(
    skills.filter(({ path }) => path.endsWith("/SKILL.md")).map(({ path }) => path),
    ["configure-koni/SKILL.md", "model-koni-work/SKILL.md", "operate-koni/SKILL.md"],
  );
});

test("shared profile guidance preserves safe progressive closure", async () => {
  const [runTypes, rulesAndTickets, agentsAndSkills] = await Promise.all([
    readFile(
      join(repositoryRoot, "packages/core/skills/configure-koni/references/run-types.md"),
      "utf8",
    ),
    readFile(
      join(repositoryRoot, "packages/core/skills/model-koni-work/references/rules-and-tickets.md"),
      "utf8",
    ),
    readFile(
      join(repositoryRoot, "packages/core/skills/configure-koni/references/agents-and-skills.md"),
      "utf8",
    ),
  ]);
  const policy = `${runTypes}\n${rulesAndTickets}`.replace(/\s+/gu, " ");

  assert.match(policy, /state each progressive closure chain in the supplied plan and tickets/);
  assert.match(policy, /partial frontier with a supported safe operation must proceed/);
  assert.match(
    policy,
    /absent downstream ticket that supported current work can unlock must proceed/,
  );
  assert.match(policy, /closed frontier with no supported closure path must block/);
  assert.match(
    policy,
    /mixed frontier with any potentially dispatchable unsafe operation must block/,
  );
  assert.match(
    policy,
    /ticket dependencies are the ordering authority for the current executable frontier/i,
  );
  assert.match(policy, /narrative milestones do not create exclusive sequencing/i);
  assert.match(policy, /independent safe preparation obligations form one concurrent frontier/i);
  assert.match(agentsAndSkills, /progressive-frontier policy in `run-types\.md`/);
  assert.match(
    agentsAndSkills,
    /qualitative gate must consume the compiler-projected dependency settlement/i,
  );
});

test("shared profile guidance distinguishes existing-node scope from new-node authority", async () => {
  const guidance = await readFile(
    join(repositoryRoot, "packages/core/skills/model-koni-work/references/rules-and-tickets.md"),
    "utf8",
  );

  assert.match(guidance, /Existing-node write scope does not govern new-node creation/i);
  assert.match(guidance, /allowed_new_node_types.*max_new_nodes/is);
  assert.match(guidance, /absence of an authorized new node.*not.*scope broadening/is);
  assert.match(guidance, /Request change control only when/i);
});

test("shared software guidance defines a disjoint planning-patch ledger", async () => {
  const guidance = await readFile(
    join(repositoryRoot, "packages/core/skills/model-koni-work/references/software-projects.md"),
    "utf8",
  );
  assert.match(guidance, /retain, update, remove, or add/);
  assert.match(guidance, /must not appear in both\s+the add and remove sets/);
  assert.match(guidance, /do not re-add retained edges/);
});

test("shared software guidance defines behavioral proof construction invariants", async () => {
  const guidance = await readFile(
    join(repositoryRoot, "packages/core/skills/model-koni-work/references/software-projects.md"),
    "utf8",
  );
  assert.match(guidance, /assert the desired behavior, not the historical\s+implementation/);
  assert.match(
    guidance,
    /Do not replace a production seam named by an oracle case with a test double/,
  );
  assert.match(guidance, /valid at the real consumer boundary/);
  assert.match(guidance, /same harness failure recurs without changed\s+evidence/);
  assert.match(guidance, /future-green viability/);
  assert.match(guidance, /target consumer contract/);
  assert.match(guidance, /claim-to-observation ledger/);
  assert.match(guidance, /actual runtime owner/);
  assert.match(guidance, /substituted target owner cannot prove/);
  assert.match(
    guidance,
    /route marker proves selection, not the selected behavior's internal\s+claim/,
  );
});

test("coding agents enforce future-green proof viability and claim coverage", async () => {
  const agentRoot = join(
    repositoryRoot,
    "packages",
    "coding-profile",
    "koni",
    "baseline",
    "agents",
  );
  const [planner, implementer, reviewer] = await Promise.all([
    readFile(join(agentRoot, "run-planner.yaml"), "utf8"),
    readFile(join(agentRoot, "implementer.yaml"), "utf8"),
    readFile(join(agentRoot, "reviewer.yaml"), "utf8"),
  ]);

  for (const instructions of [planner, implementer, reviewer]) {
    assert.match(instructions, /future-green viability/);
    assert.match(instructions, /material approval claim/);
  }
  assert.match(reviewer, /claim-to-owner ledger/);
  assert.match(reviewer, /substituted target owner/);
});

test("coding proof gates require the real owner of every material claim", async () => {
  const operations = await readFile(
    join(repositoryRoot, "packages", "coding-profile", "koni", "baseline", "operations.yaml"),
    "utf8",
  );

  assert.match(operations, /claim-to-owner ledger/);
  assert.match(operations, /substituted target owner cannot prove/);
});
