# Configuration layers

Use the layer that owns the decision.

| Layer                     | Location                        | Owns                                                                                         |
| ------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| Pi repository environment | `AGENTS.md`, `.pi/`, `.agents/` | Packages, skills, extensions, prompts, themes, repository instructions                       |
| Project catalog           | `.koni/project.yaml`            | Project identity, default run type, ordered run-type registry                                |
| Run type                  | `.koni/run-types/*.yaml`        | Intake, planning, pipeline, questions, Git naming, concurrency, role model overrides         |
| Agent overlay             | `.koni/agents/*.yaml`           | Stable instructions, Pi narrowing filters, model defaults, tools, Koni role and capabilities |
| Profile manifest          | `.koni/profile.yaml`            | Semantic initialization, ticket Git policy, orchestration defaults, module imports           |
| Profile modules           | Imported YAML                   | Graph, rules, operations, workflows, actions, checks, reports, cockpit, lifecycle            |

All Koni documents use `schema_version: "3.0"`. Agent files are discovered from `.koni/agents/`; the
profile does not import them.

The verified package profile is the immutable baseline. Project `.koni` files are its managed
overlay. Never edit `.koni/.managed`. `koni update` performs a guarded three-way upgrade and stages
real conflicts for review.

## Placement examples

- Ask for target region on deployment runs → run-type intake.
- Use a stronger reviewer on large changes → run-type reviewer role model.
- Give one reviewer fewer skills → its `.koni/agents/reviewer.yaml` Pi filter.
- Install a new general skill → ordinary Pi package/settings or project skill directory.
- Make every change identify affected services → graph schema plus rules.
- Let implementers edit `packages/api` → rule-emitted ticket paths and operation authority.
- Add a security specialist → agent file plus workflow `agent` reference.
- Show open risks → cockpit view over graph data.

## Coherence chain

For every project obligation, trace one chain:

1. a graph type and lifecycle make the fact representable;
2. a query and rule detect the missing state;
3. the rule derives an obligation and deterministic ticket;
4. an operation grants only that ticket's authority;
5. a workflow orders work, checks, and independent review;
6. receipts or gates prove the terminal state;
7. reports and views project the authoritative result.

If a setting does not belong on this chain, in a run-control layer, or in Pi's repository
environment, it may be prompt decoration rather than enforceable configuration.

Keep deterministic closure reversible at the configured lifecycle boundary. A deterministic
obligation can become inapplicable before execution and become current again after a prerequisite
closes. If the ticket machine has a distinct terminal retirement state, let only the compiler return
that state to the queued state. Do not give agents or operators a general terminal-state reopening
route, and do not make the compiler mint a different ticket identity to work around a missing
lifecycle transition.

## Change-control decision ownership

Keep `operator` as the default proposal `decision_policy`. Use `automatic` only for a closure route
whose immutable proposal authority binds the exact trigger, request, permitted application
operations, and reviewed correction boundary. The route must be limited to existing exact subjects,
forbid new nodes and deletion, and require independent review before application. A route that can
widen scope, choose among materially different outcomes, or authorize irreversible effects remains
`operator`.

```yaml
change_control:
  role: proposal
  proposal_step: propose-correction
  application_operations: [apply-correction, no-op]
  decision_policy: automatic
```

Automatic approval does not make an agent an operator. Core derives a separate durable policy
decision from the compiler-authenticated proposal authority. The application and its review retain
their configured graph, filesystem, command, and effect limits. If those limits cannot express the
needed correction, model a different operator-reviewed route instead of broadening this one.
