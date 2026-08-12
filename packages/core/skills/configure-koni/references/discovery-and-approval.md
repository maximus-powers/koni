# Discovery and approval

Customize from evidence, not from a generic project label. The goal is not to encode everything in
the repository; it is to encode the facts, gaps, dependencies, and proof boundaries that should
remain authoritative across agents.

## Establish the baseline

1. Locate the repository root and read its governing instruction files, including applicable
   `AGENTS.md` files.
2. Read `.koni/project.yaml`, every cataloged run type, every `profile.source`, the resolved profile
   manifest, all imported modules, and `.koni/agents/` rather than assuming fixed paths.
3. Identify whether the installed semantic baseline is Software, empirical Research, or already
   customized from its profile identity and actual ontology. The installed files are authoritative;
   do not reconstruct a bundled default or compare against an uninstalled template unless the user
   specifically requests an upgrade audit. When a profile-specific reference describes a newer
   bundled paradigm than the installed version, surface preservation versus coherent migration as an
   explicit approval choice rather than applying the newer semantics implicitly.
4. When roles, models, tools, permissions, or skills may change, inspect `.koni/agents`,
   `AGENTS.md`, `.pi/settings.json`, and Pi's resolved project/package resources.
5. Check for initialized or active run state. Explain that profile edits apply to future resolved
   snapshots and do not rewrite active runs.

Edit the installed profile directly after approval. Do not create a shadow baseline, generated
overlay, or second profile merely to preserve defaults.

## Inspect the repository

Prefer primary project evidence in this order:

- repository instructions, README files, architecture records, domain documentation, and
  code-ownership policy;
- workspace and package manifests, build files, task runners, lockfiles, deployment descriptors, and
  generated-code policy;
- CI workflows and the exact commands they run, followed by local testing documentation and test
  layout;
- source boundaries, entry points, public APIs, schemas, migrations, event or file contracts, and
  cross-module call paths;
- for empirical work, experiment configs, notebooks, datasets or dataset manifests, metrics,
  baseline implementations, seed policy, artifact stores, and reporting code;
- current Git topology, release or publication process, and any target-branch constraints.

Use repository search and small representative reads before broad traversal. Do not infer an
architectural boundary from a directory name alone. Record exact project-root-relative paths only
after verifying them.

## Apply the sufficiency rubric

Classify each area as **observed**, **inferred**, or **missing**. A model is sufficient when every
missing item is either low impact or recorded as an explicit assumption.

| Area                      | Sufficient evidence                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outcome and units of work | The root outcome, meaningful deliverables, and identities that must persist across agents are clear.                                                                                                                                                                                                                      |
| Boundaries and interfaces | Owned domains, exact paths, public interfaces, data or artifact contracts, and material dependency directions are known.                                                                                                                                                                                                  |
| Gap compilation           | Each important missing state can be detected deterministically and mapped to one bounded operation and workflow.                                                                                                                                                                                                          |
| Proof                     | Terminal claims have repository-native commands, empirical receipts, review criteria, or explicit human gates; stale proof can be distinguished from current proof; for Software, proof-source files can be separated from product-write paths or the co-located-byte limitation is an explicit unresolved design choice. |
| Integration               | Ticket composition, target synchronization, reporting, and explicit promotion expectations are clear.                                                                                                                                                                                                                     |
| Roles and authority       | Creative responsibilities, graph mutation authority, filesystem scope, network needs, and irreversible effects have owners.                                                                                                                                                                                               |
| Run variation             | Differences among Small, Medium, Large, or custom runs are genuine pipeline/intake/model choices rather than hidden semantic forks.                                                                                                                                                                                       |

Do not turn every rubric row into a node. Create graph identity only for a fact with an independent
lifecycle, relationships, queries, or evidence.

## Ask only high-impact questions

Ask when the answer would change at least one of these:

- node identity, lifecycle, or edge cardinality;
- domain or experiment boundary and ticket decomposition;
- operation authority, product write paths, network access, or irreversible effects;
- the accepted proof strategy, primary metric, gate threshold, or conclusion policy;
- whether a co-located Software oracle should move to a separate repository-native harness or
  requires an explicitly redesigned authority/currentness contract;
- target branch, synchronization, promotion, or publication behavior;
- a meaningful distinction between run types.

Prefer one to three concise questions in a batch. Include the repository-backed inference and its
consequence so the user can decide quickly. Do not ask users to repeat facts already present in
project files, choose formatting trivia, or approve individual low-risk YAML details.

## Present the design before writing

Present one approval packet containing:

1. **Baseline and retained structure** — installed profile identity, valuable defaults, and why they
   remain.
2. **Project model** — the root outcome, durable node identities and lifecycles, canonical edges and
   inverse aliases, and excluded concepts that remain fields or workflow outputs.
3. **Compiler behavior** — candidate queries, gap rules, derived obligations, ticket operations,
   scope projection, dependencies, and already-satisfied behavior.
4. **Execution and proof** — operation authority, workflow/review boundaries, project-native
   commands or empirical receipts, freshness rules, gates, reports, and promotion.
5. **Run and agent behavior** — any intake, pipeline, model, agent, skill, permission, or
   parallelism changes.
6. **File plan and assumptions** — exact installed files to edit, IDs to preserve or migrate,
   validation plan, and remaining assumptions.

Show proposed node and relation IDs plus the rule-to-operation-to-workflow mapping; prose alone is
not reviewable enough. Keep the packet conceptual unless a short YAML fragment resolves ambiguity.

End by explicitly asking whether to apply that design. Stop before file writes. If the user revises
it, update the packet and request approval again for the material changes. An earlier broad request
such as "customize this profile" does not waive this boundary.

## Apply and prove the approved model

- Make the smallest coherent edits to the current installed files. Preserve stable IDs when their
  meaning remains; an ID rename is a migration and requires all references to change together.
- Use exact argv arrays discovered from the repository. Keep setup or mutation out of read-only
  verification checks. Never invent `npm`, `pnpm`, `cargo`, `pytest`, or another command because it
  appeared in a default.
- Validate the profile, then validate initialized state when present. Exercise a representative gap
  that emits exactly one ticket, the satisfied state that emits none, and a malformed or
  unauthorized state that fails closed. Use an isolated temporary copy when the repository has no
  profile fixture harness; do not add permanent test infrastructure solely to satisfy this procedure
  without approval.
- Review the diff against the approved packet. Surface any necessary divergence and obtain approval
  before expanding scope.
