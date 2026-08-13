import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillsRoot = path.resolve(import.meta.dirname, "../skills");

describe("Koni's Pi-native skills", () => {
  it("do not teach the retired schema-2 persona or vendored-resource model", async () => {
    const files = await markdownFiles(skillsRoot);
    const violations: string[] = [];
    const retired = [
      /schema[- ]2/giu,
      /\.codex\/koni/gu,
      /^\s*personas?:/gmu,
      /resources\/skills/gu,
      /pi-packages\.yaml/gu,
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const pattern of retired) {
        if (pattern.test(source)) violations.push(`${path.relative(skillsRoot, file)}: ${pattern}`);
        pattern.lastIndex = 0;
      }
    }
    expect(violations).toEqual([]);
  });

  it("teaches profile authors to preserve authenticated skill reads across containment", async () => {
    const source = await readFile(
      path.join(skillsRoot, "configure-koni/references/agents-and-skills.md"),
      "utf8",
    );
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "A complete authenticated skill read remains satisfied across same-scope recovery and compaction",
    );
    expect(normalized).toContain(
      "Do not raise token budgets or remove useful skills to compensate for repeated immutable resource reads",
    );
    expect(normalized).toContain(
      "Narrow a role's skill filter only when the reusable technique itself is outside that role",
    );
    expect(normalized).toContain(
      "A narrowing filter must retain every repository skill that applicable governing instructions require for that role",
    );
    expect(normalized).toContain(
      "Select the repository's proven skill before adding technique-specific prose to the agent",
    );
    expect(normalized).toContain(
      "Configure the Lead to treat each nonterminal ticket in the supplied current board as a compiler-derived current obligation",
    );
    expect(normalized).toContain(
      "Historical overlap alone does not make that current ticket stale or redundant",
    );
    expect(normalized).toContain(
      "Preserve every existing plan, dependency, evidence, interaction, reachability, and safety criterion",
    );
  });

  it("teaches profile authors to prepare fresh worktrees through bounded native bootstrap", async () => {
    const source = await readFile(
      path.join(skillsRoot, "configure-koni/references/run-types.md"),
      "utf8",
    );
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "Fresh managed worktrees do not inherit ignored repository toolchains",
    );
    expect(normalized).toContain("one repository-native, noninteractive, lock-bound setup command");
    expect(normalized).toContain(
      "Treat manifests, continuous-integration configuration, and existing worktree setup scripts as authoritative evidence",
    );
    expect(normalized).toContain(
      "Do not put ecosystem-specific setup advice in an agent's instructions",
    );
    expect(normalized).toContain(
      "do not widen worker filesystem, command, network, or graph authority",
    );
  });

  it("teaches planners to revise validated artifacts as bounded graph diffs", async () => {
    const source = await readFile(path.join(skillsRoot, "model-koni-work/SKILL.md"), "utf8");
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain("Treat a planning revision as a three-way diff");
    expect(normalized).toContain("`upsertNodes` replaces one complete node");
    expect(normalized).toContain("exact `{ source, relation, target }` triples");
    expect(normalized).toContain("set difference between the retained and desired edge sets");
    expect(normalized).toContain("Never add and remove the same edge");
    expect(normalized).toContain(
      "repeat a retained edge, use shorthand objects, or create self-edges",
    );
    expect(normalized).toContain("Keep every retained or new local key connected");
    expect(normalized).toContain("an already-retained or replacement path");
    expect(normalized).toContain("check types, node keys, edge triples, connectivity");
    expect(normalized).toContain("injected operation limits against the complete result");
    expect(normalized).toContain(
      "smallest set of changes that corrects every named validation error",
    );
    expect(normalized).toContain("preserve every unrelated valid operation");
  });

  it("makes the graph-modeling skill discoverable while authoring a planning artifact", async () => {
    const source = await readFile(path.join(skillsRoot, "model-koni-work/SKILL.md"), "utf8");
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
    const normalized = frontmatter.replace(/\s+/gu, " ");

    expect(normalized).toContain("Koni planning artifact");
    expect(normalized).toContain("graph seed");
  });

  it("grounds named repository work before modeling it", async () => {
    const source = await readFile(path.join(skillsRoot, "model-koni-work/SKILL.md"), "utf8");
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "Resolve a named repository work item from its authoritative definition before modeling it",
    );
    expect(normalized).toContain(
      "Do not infer its meaning from an identifier, title, or referenced predecessor",
    );
  });

  it("binds proof planning and review rework to current authenticated evidence", async () => {
    const [softwareReference, executionReference] = await Promise.all([
      readFile(path.join(skillsRoot, "model-koni-work/references/software-projects.md"), "utf8"),
      readFile(path.join(skillsRoot, "model-koni-work/references/execution-contracts.md"), "utf8"),
    ]);
    const normalizedSoftwareReference = softwareReference.replace(/\s+/gu, " ");
    const normalizedExecutionReference = executionReference.replace(/\s+/gu, " ");

    expect(normalizedSoftwareReference).toContain(
      "Place every repository input relied on by the selected proof in exactly the proof field matching its authority role",
    );
    expect(normalizedSoftwareReference).toContain(
      "A filename in a listing or search result authenticates identity, not its command, environment, or convention semantics",
    );
    expect(normalizedExecutionReference).toContain(
      "A prior failed-review blocker is repair history, not current execution evidence",
    );
    expect(normalizedExecutionReference).toContain(
      "Carry forward only a finding that the current candidate and current receipts still establish",
    );
    expect(normalizedExecutionReference).toContain(
      "Keep the legacy default of one automatic rework unless the workflow explicitly sets `review_rework_limit`",
    );
    expect(normalizedExecutionReference).toContain(
      "Increase it only when the same compiler-pinned producer can correct successive current findings inside the unchanged grant",
    );
    expect(normalizedExecutionReference).toContain("The compiler caps the allowance at three");
    expect(normalizedExecutionReference).toContain(
      "The allowance is cumulative for the ticket across fresh execution epochs",
    );
    expect(normalizedSoftwareReference).toContain(
      "Perform a historical-executability audit before selecting the proof strategy",
    );
    expect(normalizedSoftwareReference).toContain(
      "Only the intended target assertion may be absent or red before implementation",
    );
    expect(normalizedSoftwareReference).toContain(
      "Fixture setup and every unchanged or preservation route must remain executable without the missing target",
    );
    expect(normalizedSoftwareReference).toContain(
      "The target invocation itself may be the isolated red at its real application-owned seam",
    );
    expect(normalizedSoftwareReference).toContain(
      "assert the exact structured transition or command that the application owns",
    );
    expect(normalizedSoftwareReference).toContain(
      "A claimed runtime effect still requires separate evidence that executes its actual owner",
    );
  });
});

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(absolute);
    }
  };
  await walk(root);
  return output.sort();
}
