import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  acceptYamlConflictPaths,
  isValidYamlConflictPaths,
  threeWayMergeYaml,
} from "../src/profile/yaml-three-way.js";

describe("profile YAML three-way merge", () => {
  it("applies upstream-only fields while retaining project-only values, comments, and order", () => {
    const base = bytes(`git:
  backend: libgit2
  worktree_root: .worktrees
  ticket_branch_template: koni/{{ run.id }}/{{ ticket.id }}
orchestration:
  max_parallel: 4
questions:
  policy: interactive
`);
    const project = bytes(`git:
  # project chooses where worktrees live
  backend: libgit2
  worktree_root: .project-worktrees
  ticket_branch_template: koni/{{ run.id }}/{{ ticket.id }}
orchestration:
  max_parallel: 9
questions:
  policy: interactive
project_only:
  keep: true
`);
    const upstream = bytes(`git:
  backend: git_cli
  worktree_root: .koni-worktrees
  ticket_branch_template: koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}
orchestration:
  max_parallel: 4
questions:
  policy: interactive
  default_scope: run
`);

    const merged = threeWayMergeYaml(base, project, upstream)!;
    expect(merged.conflictPaths).toEqual(["/git/worktree_root"]);
    const source = new TextDecoder().decode(merged.bytes);
    expect(source).toContain("# project chooses where worktrees live");
    const value = YAML.parse(source) as Record<string, any>;
    expect(value.git).toEqual({
      backend: "git_cli",
      worktree_root: ".project-worktrees",
      ticket_branch_template:
        "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}",
    });
    expect(value.orchestration.max_parallel).toBe(9);
    expect(value.questions).toEqual({ policy: "interactive", default_scope: "run" });
    expect(value.project_only).toEqual({ keep: true });
    expect(Object.keys(value)).toEqual(["git", "orchestration", "questions", "project_only"]);
  });

  it("accepts only explicit divergent fields without replacing unrelated project edits", () => {
    const project = bytes(`git:
  backend: git_cli
  worktree_root: .project-worktrees
orchestration:
  max_parallel: 9
project_only: true
`);
    const upstream = bytes(`git:
  backend: git_cli
  worktree_root: .koni-worktrees
orchestration:
  max_parallel: 4
`);
    const accepted = acceptYamlConflictPaths(project, upstream, ["/git/worktree_root"])!;
    expect(YAML.parse(new TextDecoder().decode(accepted))).toEqual({
      git: { backend: "git_cli", worktree_root: ".koni-worktrees" },
      orchestration: { max_parallel: 9 },
      project_only: true,
    });
  });

  it("combines disjoint keys when both sides add the same new map", () => {
    const merged = threeWayMergeYaml(
      bytes("profile: base\n"),
      bytes("profile: base\nnew_domain:\n  project: keep\n"),
      bytes("profile: base\nnew_domain:\n  upstream: apply\n"),
    )!;
    expect(merged.conflictPaths).toEqual([]);
    expect(YAML.parse(new TextDecoder().decode(merged.bytes))).toEqual({
      profile: "base",
      new_domain: { project: "keep", upstream: "apply" },
    });
  });

  it("treats lists atomically and rejects malformed or aliased documents", () => {
    const merged = threeWayMergeYaml(
      bytes("values: [one, two]\n"),
      bytes("values: [project]\n"),
      bytes("values: [upstream]\n"),
    )!;
    expect(merged.conflictPaths).toEqual(["/values"]);
    expect(YAML.parse(new TextDecoder().decode(merged.bytes))).toEqual({ values: ["project"] });

    expect(
      threeWayMergeYaml(
        bytes("value: &shared one\ncopy: *shared\n"),
        bytes("value: &shared one\ncopy: *shared\n"),
        bytes("value: two\ncopy: two\n"),
      ),
    ).toBeUndefined();
    expect(isValidYamlConflictPaths(["/git/backend", "/run~1type/value"])).toBe(true);
    expect(isValidYamlConflictPaths(["/bad~2escape"])).toBe(false);
  });

  it("fails closed on noncanonical or over-budget field conflict paths", () => {
    expect(isValidYamlConflictPaths(["/b", "/a"])).toBe(false);
    expect(isValidYamlConflictPaths(["/", "/nested"])).toBe(false);
    expect(
      acceptYamlConflictPaths(
        bytes("a: project\nb: project\n"),
        bytes("a: upstream\nb: upstream\n"),
        ["/b", "/a"],
      ),
    ).toBeUndefined();

    const oversizedKey = "x".repeat(4_097);
    expect(
      threeWayMergeYaml(
        bytes(`stable: true\n${oversizedKey}: base\n`),
        bytes(`stable: true\n${oversizedKey}: project\n`),
        bytes(`stable: true\n${oversizedKey}: upstream\n`),
      ),
    ).toBeUndefined();
  });
});

function bytes(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}
