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

  it("teaches profile authors to requeue compiler-current retired obligations", async () => {
    const source = await readFile(
      path.join(skillsRoot, "configure-koni/references/configuration-layers.md"),
      "utf8",
    );
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "If the ticket machine has a distinct terminal retirement state, let only the compiler return that state to the queued state",
    );
    expect(normalized).toContain(
      "A deterministic obligation can become inapplicable before execution and become current again after a prerequisite closes",
    );
  });

  it("keeps same-workflow publication separate from upstream change control", async () => {
    const source = await readFile(
      path.join(skillsRoot, "model-koni-work/references/execution-contracts.md"),
      "utf8",
    );
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "A forbidden graph mutation on an earlier step does not by itself require upstream change control",
    );
    expect(normalized).toContain(
      "Preserve the repository effect and its exact semantic handoff in predecessor evidence",
    );
    expect(normalized).toContain(
      "Reserve upstream change control for authority that the complete current workflow cannot satisfy",
    );
    expect(normalized).toContain(
      "Every workflow step whose operation exposes an upstream-change terminal branch must select a compiler-owned validation action",
    );
    expect(normalized).toContain(
      "The settled source action is proposal-publication authority, not optional extra validation",
    );
  });

  it("teaches reviewers to close the current bounded finding frontier before rework", async () => {
    const [agentReference, executionReference] = await Promise.all([
      readFile(path.join(skillsRoot, "configure-koni/references/agents-and-skills.md"), "utf8"),
      readFile(path.join(skillsRoot, "model-koni-work/references/execution-contracts.md"), "utf8"),
    ]);
    const normalizedAgentReference = agentReference.replace(/\s+/gu, " ");
    const normalizedExecutionReference = executionReference.replace(/\s+/gu, " ");

    expect(normalizedAgentReference).toContain(
      "Before reopening a producer, configure its reviewer to make one bounded pass over the complete issued review contract",
    );
    expect(normalizedAgentReference).toContain(
      "all material findings already supported by current authorized evidence and repairable by that producer",
    );
    expect(normalizedAgentReference).toContain(
      "must not widen discovery, speculate, or retain resolved findings merely to make the batch larger",
    );
    expect(normalizedExecutionReference).toContain(
      "A nonpassing review should return every material finding already supported by the current authorized evidence and repairable by the same reopened producer",
    );
    expect(normalizedExecutionReference).toContain(
      "Do not deliberately serialize inspectable findings across rework cycles",
    );
  });

  it("teaches empirical reviewers to close scientific runtime contract ledgers", async () => {
    const source = await readFile(
      path.join(skillsRoot, "model-koni-work/references/empirical-research.md"),
      "utf8",
    );
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "Before accepting a scientific runtime or its post-result verifier, construct one closed validation ledger",
    );
    expect(normalized).toContain(
      "producer operation and resource contract, result schema and interpretation semantics, exact input and provenance identities, population and accounting invariants, output boundary, and negative safety constraints",
    );
    expect(normalized).toContain(
      "Acceptance requires every material entry to be satisfied or evidence-backed not applicable",
    );
    expect(normalized).toContain(
      "A nonpassing review returns every currently supported unsatisfied entry that the same producer can repair",
    );
  });

  it("teaches profile authors to delegate only bounded authenticated change closure", async () => {
    const [configurationReference, softwareReference] = await Promise.all([
      readFile(path.join(skillsRoot, "configure-koni/references/configuration-layers.md"), "utf8"),
      readFile(path.join(skillsRoot, "model-koni-work/references/software-projects.md"), "utf8"),
    ]);
    const normalizedConfiguration = configurationReference.replace(/\s+/gu, " ");
    const normalizedSoftware = softwareReference.replace(/\s+/gu, " ");

    expect(normalizedConfiguration).toContain(
      "Keep `operator` as the default proposal `decision_policy`",
    );
    expect(normalizedConfiguration).toContain(
      "Use `automatic` only for a closure route whose immutable proposal authority",
    );
    expect(normalizedConfiguration).toContain(
      "limited to existing exact subjects, forbid new nodes and deletion, and require independent review before application",
    );
    expect(normalizedConfiguration).toContain(
      "A route that can widen scope, choose among materially different outcomes, or authorize irreversible effects remains `operator`",
    );
    expect(normalizedSoftware).toContain(
      "An invalid proof seam may use automatic scoped change control only when the authenticated profile policy pre-authorizes",
    );
    expect(normalizedSoftware).toContain(
      "same-subject correction over existing nodes with no deletion or scope widening",
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
    const [source, softwareReference] = await Promise.all([
      readFile(path.join(skillsRoot, "model-koni-work/SKILL.md"), "utf8"),
      readFile(path.join(skillsRoot, "model-koni-work/references/software-projects.md"), "utf8"),
    ]);
    const normalized = source.replace(/\s+/gu, " ");
    const normalizedSoftwareReference = softwareReference.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "Resolve a named repository work item from its authoritative definition before modeling it",
    );
    expect(normalized).toContain(
      "Do not infer its meaning from an identifier, title, or referenced predecessor",
    );
    expect(normalizedSoftwareReference).toContain(
      "Require positive first-party evidence that binds the named surface to its selected owner",
    );
    expect(normalizedSoftwareReference).toContain(
      "A failed or truncated broad search does not select an owner",
    );
    expect(normalizedSoftwareReference).toContain(
      "A bounded search with no objective-specific match counts against that candidate",
    );
    expect(normalizedSoftwareReference).toContain(
      "Do not inspect or serialize that candidate's generic implementation seams until positive objective-specific evidence selects it",
    );
    expect(normalizedSoftwareReference).toContain(
      "continue bounded owner discovery across the remaining plausible first-party roots",
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
    expect(normalizedSoftwareReference).toContain(
      "A proof-construction ledger is closed only when every material boundary has either an authenticated repository input in its exact authority field or an evidence-backed `not applicable` disposition",
    );
    expect(normalizedSoftwareReference).toContain(
      "Proof source or covered product paths never stand in for missing support evidence",
    );
    expect(normalizedSoftwareReference).toContain(
      "Reconcile the closed ledger against the downstream preparation contract before submission",
    );
    expect(normalizedExecutionReference).toContain(
      "A prior failed-review blocker is repair history, not current execution evidence",
    );
    expect(normalizedExecutionReference).toContain(
      "Carry forward only a finding that the current candidate and current receipts still establish",
    );
    expect(normalizedExecutionReference).toContain(
      "Validate currentness, exact membership, and downstream interactions; do not repeat that upstream semantic review from the same evidence",
    );
    expect(normalizedExecutionReference).toContain(
      "Carry the complete bounded desired state through every upstream request and proposal selection",
    );
    expect(normalizedExecutionReference).toContain(
      "A route-only synopsis is not a complete change contract",
    );
    expect(normalizedExecutionReference).toContain(
      "A familiar command name is not evidence that an executable exists",
    );
    expect(normalizedExecutionReference).toContain(
      "A read, listing, or planned-file declaration authenticates a path or content, not authority to invoke that path as `argv[0]`",
    );
    expect(normalizedExecutionReference).toContain(
      "Authenticate `argv[0]` itself as an executable launcher",
    );
    expect(normalizedExecutionReference).toContain(
      "place an authenticated runner at `argv[0]` and the planned source path in a later argument",
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
