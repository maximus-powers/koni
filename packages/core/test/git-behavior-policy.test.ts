import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileGitBehaviorPolicy,
  createGitRunTemplateContext,
  createGitTicketTemplateContext,
  renderConfiguredCommitTrailers,
  renderRunRef,
  renderTicketCommitSubject,
  renderTicketRef,
  resolveLegacyPolicyWorktreeRoot,
  resolvePolicyWorktreeRoot,
  resolveRepositoryWorktreeNamespaceRoot,
  type GitBehaviorPolicy,
} from "../src/git/behavior-policy.js";

describe("compiler-supplied Git behavior policy", () => {
  it("compiles, freezes, and renders the complete native behavior", () => {
    const result = compileGitBehaviorPolicy(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected policy");
    const run = createGitRunTemplateContext({
      id: "run-abc",
      objective: "Build the Notes Dashboard",
      profileHash: hash("1"),
    });
    const ticket = createGitTicketTemplateContext({
      id: "TK-1",
      cycleId: "cycle-2",
      operation: "implementation",
      title: "Add search",
      reviewId: "review-9",
    });

    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.refs)).toBe(true);
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(renderRunRef(result.value, run)).toMatch(
      /^refs\/heads\/koni\/runs\/build-the-notes-dashboard-[0-9a-f]{12}$/u,
    );
    expect(renderTicketRef(result.value, run, ticket)).toBe(
      "refs/heads/koni/tickets/run-abc/TK-1/cycle-2",
    );
    const worktreeRoot = resolvePolicyWorktreeRoot("/repo/.git", result.value);
    expect(worktreeRoot).toBe(
      path.join(resolveRepositoryWorktreeNamespaceRoot("/repo/.git"), ".koni-worktrees"),
    );
    expect(worktreeRoot.split(path.sep)).not.toContain(".git");
    expect(resolveLegacyPolicyWorktreeRoot("/repo/.git", result.value)).toBe(
      path.resolve("/repo/.git/.koni-worktrees"),
    );
    expect(renderTicketCommitSubject(result.value, run, ticket)).toBe("implementation: Add search");
    expect(renderConfiguredCommitTrailers(result.value, run, ticket)).toEqual({
      "Profile-Hash": hash("1"),
      "Review-Id": "review-9",
    });
  });

  it("makes different templates and worktree roots change exact refs and paths", () => {
    const first = policy(validInput());
    const secondInput = validInput();
    secondInput.runTypeGit = {
      branch_template: "koni/isolated/{{ run.id }}",
      ticket_branch_template: "koni/work/{{ run.id }}/{{ cycle.id }}/{{ ticket.id }}",
    };
    secondInput.profileGit.worktree_root = ".koni-owned/worktrees";
    const second = policy(secondInput);
    const run = createGitRunTemplateContext({
      id: "run-one",
      objective: "A task",
      profileHash: hash("2"),
    });
    const ticket = { id: "TK", cycleId: "C", operation: "build", title: "Thing" };

    expect(renderRunRef(first, run)).not.toBe(renderRunRef(second, run));
    expect(renderTicketRef(first, run, ticket)).not.toBe(renderTicketRef(second, run, ticket));
    expect(resolvePolicyWorktreeRoot("/repo/.git", first)).not.toBe(
      resolvePolicyWorktreeRoot("/repo/.git", second),
    );
    expect(first.policySha256).not.toBe(second.policySha256);
  });

  it.each([
    ["disabled", { enabled: false }, "git_policy.disabled_unsupported"],
    ["wrong backend", { backend: "libgit2" }, "git_policy.unsupported_backend"],
    ["escaping worktree", { worktree_root: "../outside" }, "git_policy.worktree_root"],
    ["absolute worktree", { worktree_root: "/tmp/outside" }, "git_policy.worktree_root"],
    ["unsupported strategy", { integration_strategy: "rebase" }, "git_policy.unsupported_strategy"],
    [
      "multiline subject",
      { commit_template: "{{ ticket.operation }}\n{{ ticket.title }}" },
      "git_policy.commit_subject",
    ],
    [
      "multiline trailer",
      { commit_trailers: { Audit: "one\ntwo" } },
      "git_policy.trailer_template",
    ],
    ["oversize subject", { commit_template: "x".repeat(8 * 1024 + 1) }, "git_policy.field_type"],
  ])("rejects %s at compilation", (_label, patch, code) => {
    const input = validInput();
    Object.assign(input.profileGit, patch);
    const result = compileGitBehaviorPolicy(input);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(code);
  });

  it.each([
    ["missing run identity", "koni/runs/static", "git_policy.run_ref_identity"],
    [
      "missing cycle identity",
      "koni/tickets/{{ run.id }}/{{ ticket.id }}",
      "git_policy.ticket_ref_identity",
    ],
    [
      "Git reflog syntax",
      "koni/tickets/{{ run.id }}/@{bad}/{{ ticket.id }}/{{ cycle.id }}",
      "git_policy.ref_template",
    ],
    [
      "dot component",
      "koni/.private/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
      "git_policy.ref_template",
    ],
    [
      "unknown variable",
      "koni/{{ project.id }}/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
      "git_policy.template_variable",
    ],
  ])("rejects %s ref templates before runtime", (_label, template, code) => {
    const input = validInput();
    input.runTypeGit.ticket_branch_template = template;
    if (_label === "missing run identity") {
      input.runTypeGit.branch_template = template;
      input.runTypeGit.ticket_branch_template =
        "koni/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}";
    }
    const result = compileGitBehaviorPolicy(input);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(code);
  });

  it.each([
    [
      "a run leaf that is the ticket namespace parent",
      "koni/runs/{{ run.id }}",
      "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}",
    ],
    [
      "a dynamic ticket segment that can equal the run leaf",
      "koni/runs/{{ run.id }}/tickets",
      "koni/runs/{{ run.id }}/{{ ticket.id }}/cycles/{{ cycle.id }}",
    ],
  ])("rejects %s", (_label, runTemplate, ticketTemplate) => {
    const input = validInput();
    input.runTypeGit = {
      branch_template: runTemplate,
      ticket_branch_template: ticketTemplate,
    };
    const result = compileGitBehaviorPolicy(input);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "git_policy.ref_namespace_collision",
    );
  });

  it("accepts distinct literal sibling leaves beneath one run namespace", () => {
    const input = validInput();
    input.runTypeGit = {
      branch_template: "koni/runs/{{ run.id }}/integration",
      ticket_branch_template:
        "koni/runs/{{ run.id }}/tickets/{{ ticket.id }}/cycles/{{ cycle.id }}",
    };
    expect(compileGitBehaviorPolicy(input).ok).toBe(true);
  });

  it("rejects authority-owned trailers and omits an unavailable optional review identity", () => {
    const input = validInput();
    input.profileGit.commit_trailers = {
      "Koni-Run": "{{ run.id }}",
    };
    const rejected = compileGitBehaviorPolicy(input);
    expect(rejected.ok).toBe(false);
    expect(rejected.diagnostics.map((item) => item.code)).toContain("git_policy.reserved_trailer");

    const configured = policy(validInput());
    const run = createGitRunTemplateContext({
      id: "run-one",
      objective: "Task",
      profileHash: hash("3"),
    });
    expect(
      renderConfiguredCommitTrailers(configured, run, {
        id: "TK",
        cycleId: "C",
        operation: "build",
        title: "Thing",
      }),
    ).toEqual({ "Profile-Hash": hash("3") });
  });
});

function validInput(): {
  profileGit: Record<string, unknown>;
  runTypeGit: Record<string, unknown>;
} {
  return {
    profileGit: {
      enabled: true,
      backend: "git_cli",
      integration_branch: "main",
      ticket_branch_template: "koni/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
      worktree_root: ".koni-worktrees",
      integration_strategy: "squash",
      commit_template: "{{ ticket.operation }}: {{ ticket.title }}",
      commit_trailers: {
        "Profile-Hash": "{{ profile.hash }}",
        "Review-Id": "{{ review.id }}",
      },
    },
    runTypeGit: {
      branch_template: "koni/runs/{{ run.slug }}-{{ run.short_id }}",
      ticket_branch_template: "koni/tickets/{{ run.id }}/{{ ticket.id }}/{{ cycle.id }}",
    },
  };
}

function policy(input: ReturnType<typeof validInput>): GitBehaviorPolicy {
  const result = compileGitBehaviorPolicy(input);
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join("; "));
  return result.value;
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
