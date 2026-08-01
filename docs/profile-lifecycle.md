# Pi-native profile lifecycle

Status: implemented in `@koni/core`. Coding 0.7.0 and Research 1.0.11 are the first evolved
immutable bundles using this lifecycle.

## Operator entry points: 2026-07-17

```sh
koni init coding --root .       # or: research
koni update --root .
koni conflicts --root .         # list pending upstream changes
koni conflicts path/to/file.yaml --root .
koni conflicts path/to/file.yaml --keep-project --root .
# or choose --accept-upstream after inspecting both documents
```

The same lifecycle is reachable through `/koni init|update|conflicts` and the shared Configure UI.
Configure shows **[u] Open comparison** when upstream changes are pending, keeps the current project
and authenticated upstream documents side by side, and sends lifecycle/source CAS values as hidden
control data. It never exposes those implementation hashes as choices or writes YAML directly.

## Ownership boundary

An official profile package contains a passive Pi registrar, `koni/profile-manifest.json`, and a
complete immutable `koni/baseline/` tree. Pi-loaded registrars announce their manifest URL through
Koni discovery events. Core verifies every manifest path, byte count, file hash, bundle digest,
package identity, profile lineage, and compatibility range before use.

Installation owns only `<project>/.koni`. It never mutates `.pi`, `.agents`, credentials, settings,
community packages, prompts, themes, sessions, or unrelated agent-tool content such as `.claude` and
`.codex`.

## Baseline plus project overlay

Every install/upgrade stores two forms of provenance:

- `.koni/.managed/install.json` remains the strict compatibility record consumed by the project
  compiler.
- `.koni/.managed/lifecycle.json` records generation, lineage, installed bundle, complete overlay,
  pending upstream changes, immutable baseline history, and guarded migrations.

Exact baseline bytes are retained at `.koni/.managed/baselines/<bundle-sha256>/`. They are
write-once: a changed archived byte fails the next lifecycle operation instead of being silently
repaired.

Upgrade is a three-way comparison among the exact prior baseline, current project bytes, and the new
verified package baseline:

- unchanged project files adopt changed upstream defaults.
- project edits, deletions, additions, and modified files removed upstream remain project-owned.
- a real edit/delete conflict stages incoming bytes beneath `.managed/upstream/` and records a
  pending change without overwriting the project file.
- an ordinary local override is not mislabeled as a conflict when upstream did not change.

> **Field-level overlay transition: 2026-07-17 (`release_lifecycle_closure/root`):** The file-level
> rules above remain the compatibility behavior for non-YAML and unmergeable sources. Ordinary YAML
> configuration now uses the archived old document as a semantic merge base: upstream-only map
> fields are applied, project-only fields/comments/order are retained where the YAML AST can
> represent them, lists and scalars remain atomic, and only same-field divergence is staged. Each
> divergence is durably named by a sorted field path. `/` denotes the historical whole-document
> fallback. This allows new Git/intake defaults to reach a customized profile without replacing
> unrelated project configuration.

Publication uses a crash-forward file transaction with source-hash compare-and-swap. Normal upgrades
are semver-monotonic. Downgrade requires an explicit guarded option. Preview performs the same
projection without creating `.koni`, a lock, or a transaction.

## Safe guided configuration edits

The control center does not write YAML or `.managed` files directly. Core exposes:

- `catalogProjectAuthoredConfig(projectRoot, profilePackageRoot)`.
- `readProjectAuthoredConfigDocument(projectRoot, profilePackageRoot, path)`.
- `updateProjectAuthoredConfigDocument(request)`.

The catalog returns each authored YAML document's normalized path, source SHA, byte size, file kind,
semantic domain, guided-editability, label, and top-level keys, together with the compiled
configuration and effective-bundle revisions.

An update accepts one structured document and its exact expected source SHA. Core rejects
compiler-owned paths and unsafe values, serializes one strict YAML document, reconstructs the
complete candidate from the authenticated baseline plus current project overlay, compiles that
candidate, and atomically publishes the document, install bookkeeping, and lifecycle generation. The
result returns the new source, configuration, and effective-bundle hashes. Invalid candidates and
stale editors produce no authored or lifecycle change.

Real three-way conflicts are resolved through `resolveProfileUpstreamConflict(request)`. The request
binds lifecycle generation, path, and current project digest. `keep_project` preserves the overlay
while recording that decision. `accept_upstream` writes/recreates the verified package byte or
removes an upstream-orphaned file. Both choices compile the complete candidate and publish the file
effect, pending-conflict removal, resolution history, and lifecycle generation in one transaction.

> **Field-only acceptance transition: 2026-07-17 (`release_lifecycle_closure/root`):** For a staged
> YAML field conflict, `accept_upstream` now patches only the recorded divergent fields into the
> already auto-merged project document. Project-only values and non-conflicting upstream changes
> therefore survive either resolution. Historical conflicts without field provenance and explicit
> `/` whole-document fallbacks retain the verified-byte replacement behavior described above.

> **Stock ticket-reissue compatibility: 2026-07-19 (`primary-integrator/root`):** Compiler fixpoint
> verification may prove that a previously closed ticket's obligation is applicable again after its
> evidence becomes stale. Current Coding and Research profiles now configure a compiler-only
> `closed -> todo` transition named `reopen-stale-obligation`. Runs pinned to the exact
> pre-transition stock lifecycle-machine hashes receive only that same additive transition in
> memory. Customized lifecycle machines, human actors, and every other source/target pair continue
> to fail closed. The pinned configuration, catalog bytes, historical attempts, and terminal
> receipts are not rewritten.

> **Raw Configure-document transition: 2026-07-17 (`config_document_authority/root`):** The
> structured-YAML editor above remains supported, and is now joined by one raw authored-source
> transaction for YAML, TOML, and Markdown. It uses the same lifecycle lock, complete-candidate
> compiler, source-hash CAS, overlay bookkeeping, and crash-forward publication boundary. Invalid
> YAML stays listable/readable for repair, while no invalid candidate can publish. The semantic
> authority presents nine friendly domains and 29 resource kinds without accepting operator
> filesystem paths, and adds guarded raw-document lifecycle and resolved run-type templates. RPC and
> control-center presentation are adapters over this authority rather than a second configuration
> owner.

> **Configure receipt transition: 2026-07-17 (`config_document_authority/root`):** The raw
> publication boundary now optionally commits an authority mutation identity and its exact
> post-commit source/configuration/bundle result in the same filesystem transaction. Ordinary
> semantic update/create/rename/delete/create-run-type RPCs can therefore recover after a crash
> before their outer receipt: recovery first completes or retires the crash-forward journal, then
> verifies the exact witnessed state before returning it. It never reports a later catalog as the
> original result.

# Transition note: authenticated semantic retirements (2026-07-17)

The conflict-aware baseline/overlay upgrade remains the default. A newer package may now also
declare a mandatory `retire_yaml_fields` resource when a formerly accepted setting has become
invalid rather than merely changed. This is not an executable migration hook. It is an exact,
hash-bound deletion list whose applicability is constrained by both the old profile version and the
exact old bundle digest. Koni previews old/project values without writing, requires that exact
preview for apply, archives arbitrary project values verbatim, compiles the full candidate, and
publishes the plan, receipt, lifecycle witness, and configuration in one transaction. Existing run
snapshots remain immutable. The retirement applies only to future compilation of project config.

> **Official retirement publication transition: 2026-07-18 (`profile_release_publication/root`):**
> The mechanism above is now exercised by authenticated Coding `0.8.0` and Research `1.1.0`
> releases. Each manifest admits `retire-inert-semantics-v1` only from its exact prior official
> bundle and hashes the retirement resource into the new bundle identity. Exact source-baseline
> files adopt the authenticated target after retired values are archived. Any byte-different project
> file remains on the ordinary semantic merge/conflict path. Publication inventories the reviewed
> in-tree baseline and is byte-stable on repeat. It does not recapture or replace that baseline from
> historical input.
>
> Historical schema-1 adoption has two narrow stock-compatibility bridges for semantics that the
> current compiler intentionally rejects: enumerated complete Lead `{description,instructions}`
> pairs and the exact former `browser-smoke` check object. Both require a full canonical-hash match,
> preserve all unrelated fields and siblings, reject one-byte customization, and cannot replay after
> the project becomes managed. These bridges do not relax current profile validation.

> **Compiler-ownership migration correction: 2026-07-19 (`primary-integrator/root`):** The schema-1
> merge still preserves project-authored semantic choices, but a historical array may no longer
> replace compiler ownership introduced by the authenticated target schema. Target
> `compiler_owned_fields` and `agent_visible_compiler_owned_fields` are unioned into matching
> migrated node types before the complete candidate is compiled. This specifically prevents an old
> delivery node's `[status]` list from stripping the target-bound `spec.target_branch`. Extra legacy
> ownership is retained, while unknown or inconsistent source bindings still fail normal semantic
> validation. The Coding release manifest names every supported 0.7 source bundle exactly. There is
> no version-only or wildcard migration authority.

> **Fresh conversational roots for reissued obligations: 2026-07-19 (`primary-integrator/root`):**
> The compiler-only `closed -> todo` transition above reopens the semantic obligation and preserves
> every historical attempt, transcript, receipt, and step link. It does not mean that the old
> terminal Pi conversation remains suitable context. Tickets and assignment attempts now carry a
> monotonic execution epoch. The first attempt of a new epoch is an independent Pi session root,
> while retries and rework inside that epoch may still branch from its current conversation.
> Existing records remain readable. When an already-reissued legacy ticket has no explicit epoch,
> Core infers the current generation from its authenticated Git-cycle ordinal and deliberately
> excludes ambiguous epoch-less attempts from parent selection, then persists the inferred epoch on
> the next admission. This avoids replaying a completed ticket's large terminal history without
> deleting any audit evidence.

> **Cross-ticket proof provenance transition: 2026-07-19 (`primary-integrator/root`):** A fresh
> conversational root does not discard immutable causal evidence. Review attempt contexts now carry
> a bounded, hash-sealed `historicalPreparation` envelope when the same authenticated preparation
> snapshot that authorizes `proof_preparation_current` remains source-current. It includes the
> independently reviewed historical check signals, preparation review identity, and exact
> proof-source continuity, while current-step execution remains in `predecessorExecution`. A
> reviewer therefore gets the whole red-to-green proof chain without inheriting another ticket's Pi
> conversation. Missing, stale, superseded, target-mismatched, source-drifted, or unauthenticated
> preparation yields no envelope and remains fail-closed.
