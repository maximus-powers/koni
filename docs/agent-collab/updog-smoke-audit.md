# Updog Medium smoke-readiness audit

Last checked: 2026-07-14 21:55 MST

## Lease and safety boundary

- Owner: `updog-smoke-audit/root`.
- Scope: strictly read-only inspection of `/Users/max/Desktop/updog`, its Git worktrees, Koni
  durable state, installed binary metadata, and live process/cockpit state; reconstruct the exact
  questionnaire/SPICED objective; publish a safe fresh Medium-run recipe and acceptance checks.
- Sole permitted write: append-only coordination evidence in this mailbox and the central registry.
- Never mutate, recover, resume, delete, or use as launch candidates the forensic runs
  `019f5e99-95b4-7eb3-a2db-d9eac1f9ffda` and
  `019f616d-83f9-7e60-8d21-6a3d3c4bf7a9`.
- No install, launch, process signal, cockpit/cmux action, branch/worktree mutation, credential
  access, run-state write, or Updog file edit is authorized in this lane.

## Coordination checkpoint

Read the current central safety contract plus `updog-northstar-audit.md`,
`primary-integrator.md`, `software-final-design-audit.md`, and `integration-matrix.md` before
inspection. The settled Software 0.4 profile/CLI checkpoint and Pi cutover release candidate are
inputs, not authorization to mutate the live project.

## Findings

Pending read-only inspection.

### 2026-07-14 22:05 MST — read-only audit complete

The pending marker above is retained as the lane's initial state. This transition records the
completed inventory and releases the lane without authorizing any installation or run action.

#### Hard safety result: do not migrate the live Updog checkout

The requested in-place schema-2 update conflicts with the standing protected-run contract:

- `/Users/max/Desktop/updog` is still a schema-1 installation at `.codex/koni`, Software `0.2.0`.
- Current `koni init` sees `.codex/koni` and unconditionally enters `execute_pi_migration(...,
  true)` (`crates/koni-cli/src/main.rs:1260-1320`).
- That apply path calls `Engine::archive_pi_migration_runs` before schema-2 publication
  (`main.rs:3061-3082`). Both protected IDs are schema-1 runs in this Git common directory.
- Therefore an in-place update necessarily archives or otherwise mutates the exact forensic
  records that the primary lease says must never be mutated, recovered, resumed, deleted, or
  reinterpreted.

The safe acceptance topology is an **independent clone** of `harness-testing`, an **isolated
current-build install prefix**, and a **new cockpit/run namespace**. A linked worktree is not
sufficient because it shares the original Git common directory and `.git/koni` state. Do not
replace the installed global binary or stop/reuse the current cockpit. This conflict was routed to
`primary-integrator/root` and `final-runtime-audit/root` as soon as it was proven.

#### Current Updog and protected-run inventory

Read-only inspection at the timestamp above found:

- project root `/Users/max/Desktop/updog`;
- branch `harness-testing`, HEAD `95304acf017ace08ee801b014bf5603c6cb1a4c4`, identical to
  local `development`;
- only Koni installation/resource changes in the target checkout: staged/untracked
  `.agents/skills/{configure-koni,model-koni-work,operate-koni}`, modified
  `.codex/config.toml`, and untracked `.codex/agents` plus `.codex/koni`;
- no SPICED product implementation at HEAD; the repository still contains the legacy Sales Notes
  questionnaire/proposal/query/mutation shape;
- the only protected ticket commit beyond target HEAD is
  `2cf7ad9643cdb9ca9bc9bdcff81f0dbd2d160e8f`, which restores `.codex/config.toml` rather than
  implementing the feature;
- every protected integration/ticket worktree remains locked;
- the sole Koni process is the existing cockpit, PID/PGID `2282`, started 2026-07-14 22:08 UTC
  with cwd Updog; no worker, Pi host, Cargo, Rust compiler, or protected-run command process is
  active;
- `/Users/max/.cargo/bin/koni` remains the old `koni 0.1.0` binary, SHA-256
  `e041a1f41a43fb564f9ee0659561390302a7a0e2dfc2e6c0e897755dff3b46e5`, modified
  2026-07-14 19:19:31 UTC. Its command catalog predates the schema-2 Pi runtime surfaces;
- both protected authoritative orchestration records remain paused:
  `running: false`, updated at `2026-07-14T21:37:40.242370Z` and
  `2026-07-14T21:37:41.200943Z`. Their lifecycle `running` flags are stale compatibility
  projections and are not authority to resume them.

The current cockpit visually reports the two protected Small runs paused at approximately 16.6M
and 16.8M tokens, zero verified active agents out of 18, and repeated historical Integrator rows.
That is forensic presentation evidence only.

#### Exact objective and settled user decisions

The authoritative original goal is the YAML `goal` scalar in:

`/Users/max/Desktop/updog/.git/koni/runs/019f616d-83f9-7e60-8d21-6a3d3c4bf7a9/run.yaml`

It is 4,098 bytes / 69 lines with SHA-256
`00672c0eb14bd987f8057cee3d756e1d0b3b8c3037a20bbc306218ed7b5b5a34`. It starts:

> Can you make the last section of the questionnaire page in the books app (currently sales
> notes) have a different long input section for each of the sections of the spiced framework?

The remainder contains the user's exact six Situation questions, seven Pain questions, six Impact
questions, six Critical Event questions, and six Decision questions. Do not normalize the wording,
punctuation, or Unicode quotes by hand. Read the scalar directly for the fresh prompt, for example:

```sh
ruby -e 'require "yaml"; print YAML.load_file(ARGV[0]).fetch("goal")' \
  /Users/max/Desktop/updog/.git/koni/runs/019f616d-83f9-7e60-8d21-6a3d3c4bf7a9/run.yaml
```

The exact durable revision steering is the `planning.revision.requested` instruction in
`planning/transcript.jsonl` for the same run:

> Preserve the existing General / Sales Notes card, its ID, thread, note key, required completion
> behavior, and stored content. Add Situation, Pain, Impact, Critical Event, and Decision after it
> as optional independent long-text fields. Keep questionnaire and proposal surfaces aligned to
> the same six threads, and include mutation/query parity so Fill From Meetings can populate them.
> Derive all surfaces from one shared typed contract. Retain a focused red test first with one exact
> argv, explicit test_paths, and separate production owned_paths.

For the fresh run, append that exact steering to the original goal before planning. The already
settled contract is: visible order **General, Situation, Pain, Impact, Critical Event, Decision**;
the existing `general-info-sales-notes` identity/thread/note key/content and required completion
semantics survive behind the visible General label; the five new fields are independently saved,
optional, and blank-neutral; questionnaire and proposal expose the same six fields; query,
mutation, and Fill From Meetings have parity; one shared typed contract drives all surfaces; and
the plan names one focused red-first exact argv plus explicit test and production paths. The
planner should not spend a question turn reopening any of those choices.

#### Why the prior planning run is not an efficiency baseline

The protected replacement's `planning/session.yaml` records 1,812,911 input tokens, 1,445,120
cached tokens, 33,008 output tokens, 21,423 reasoning tokens, 400,799 new tokens against a 250,000
limit, and `synthesis_forced: true`. Its predecessor first planned the wrong product contract:
replacing Sales Notes, making five fields required, and changing only the questionnaire. The
revision then paid for another broad exploration pass. A dynamic worktree also hit an untrusted
`mise` configuration failure. These are concrete causes to remove from the fresh run, not costs to
accept as normal.

Software `0.4.0` Medium instead defines one combined plan, one early batch of one-to-three
material questions only when needed, a 240,000-new-token limit with 60,000 reserved for synthesis,
parallelism 3, and:

- Planner `gpt-5.6-sol` / `max`
- Lead `gpt-5.6-sol` / `xhigh`
- Worker `gpt-5.6-terra` / `high`
- Reviewer `gpt-5.6-sol` / `max`

#### Safe fresh Medium launch recipe for the primary integrator

This is a recipe, not permission for this read-only lane to execute it. Perform it only after the
frozen release matrix and independent runtime audit agree on one current source fingerprint.

1. Install the frozen build into a new prefix without replacing `~/.cargo/bin/koni`, using the
   repository's `scripts/install-dev.sh` with `KONI_INSTALL_PREFIX=<isolated-prefix>`. Record the
   source/release fingerprint and packaged binary hash.
2. Create a true independent clone, not a linked worktree:
   `git clone --no-local --branch harness-testing /Users/max/Desktop/updog <smoke-clone>`.
   Assert its `git rev-parse --git-common-dir` differs from the original. This intentionally
   excludes original dirty installation files and all original `.git/koni` run state.
3. Initialize only the clone with the isolated binary:
   `<isolated-prefix>/bin/koni init --target <smoke-clone> --profile software`. Verify `.koni`,
   schema 2, Software `0.4.0`, and Medium's exact defaults above.
4. Add the repository-owned setup hook before running. The generic Software profile deliberately
   assumes no package manager, but fresh Updog ticket worktrees need the previously proven static
   workspace-write setup check:
   `pnpm install --frozen-lockfile --prefer-offline`, cwd `.`, timeout 1200, receipt type
   `worktree_setup`, with inherited `PATH`, `HOME`, `TMPDIR`, `CI`, `PNPM_HOME`, and
   `COREPACK_HOME`; set `git.ticket_worktree_setup_check` to that check. This remains a supported,
   validated profile field. Without it, every new ticket worktree lacks `node_modules` and creates
   misleading infrastructure failures.
5. Review the clone's `.mise.toml`, then launch the isolated cockpit with
   `MISE_TRUSTED_CONFIG_PATHS="<smoke-clone>:<smoke-clone>/.git/koni/worktrees"`. The old run
   showed that dynamically created Koni worktrees otherwise fail `mise` trust. Include that
   variable in setup inheritance if the command environment requires it. This is path trust only
   after explicit review; it is not permission to trust arbitrary configuration.
6. Commit only the clone's reviewed Koni-owned `.koni`, installed repository skills, and Updog
   setup customization onto its local `harness-testing` target before planning. Confirm a clean
   target checkout so eventual promotion has a stable merge base. Do not import the original
   schema-1 installation wholesale.
7. Run `<isolated-prefix>/bin/koni auth status --json`. If no valid subscription session is
   available, stop for an explicit operator login; credential mutation is not implicit in the
   smoke recipe and no secret payload should be inspected.
8. In the new isolated cockpit choose **Medium**, target branch `harness-testing`, the defaults
   above, and paste the exact original goal followed by the exact settled steering. Start Planning.
   Equivalent CLI shape: `koni plan-run --root <smoke-clone> --run-type medium
   --target-branch harness-testing --goal "$GOAL"`; omit an explicit question-policy override so
   Medium's configured high-impact-only policy remains authoritative.
9. Every repair/retry must use this new run namespace or another fresh clone/run. Never point a
   command, cockpit action, recovery flow, or migration at either protected run ID.

#### Acceptance checklist

**Safety and release identity**

- Clone Git common directory, run root, isolated binary, and source fingerprint are recorded and
  distinct from the original.
- Original cockpit PID `2282`, both protected directories/hashes, their locked worktrees, and both
  `orchestration.yaml` `running: false` values remain unchanged.
- The fresh run ID exists only in the clone; the target checkout was clean before planning and
  remains free of unrelated product edits.
- Runtime evidence records one exact compiler grant, one contained Pi process/session identity,
  successful grant claim, durable broker terminal receipt, grant revocation, clean host/private
  credential-service teardown, and durable usage reconciliation. Failure diagnostics are
  sanitized; no secret value is inspected.

**Planning economy and cognition**

- The first plan honors every settled General/SPICED decision without a revision loop.
- At most one early batch of one-to-three questions is asked, and only for a still-unresolved
  material product decision; repository facts and settled decisions are not asked again.
- New planning tokens stay within 240,000 and preferably do not force synthesis. The transcript
  has no repeated whole-repository scans, repeated dependency/setup discovery, or repeated plan
  restatement.
- The graph seed is the smallest root-connected semantic model: no duplicate systems/contracts,
  no role/file-taxonomy fanout, and no eight-ticket restatement of one vertical feature.
- Tickets are a few cohesive vertical slices with explicit production/test paths and one focused
  proof per implementation claim; extra proof exists only for a distinct gap/risk. Disjoint
  scopes parallelize without shared-file collisions.

**Product behavior**

- The Books questionnaire final section visibly represents the SPICED Framework and orders cards
  General, Situation, Pain, Impact, Critical Event, Decision.
- The five SPICED cards show the exact supplied guidance text. General retains the legacy stored
  identity/content and required completion behavior; the five additions are optional and do not
  block completion while blank.
- Proposal and questionnaire render the same six independently editable/savable fields in the
  same order. Reload and partial update preserve the other five values.
- Query/mutation contracts expose all six. Fill From Meetings can propose/apply the five SPICED
  values through the existing approval path and leaves General untouched when omitted.
- One typed shared contract drives field order/identity across surfaces; no database migration is
  introduced unless repository inspection proves one is actually required.

**Evidence, lifecycle, and promotion**

- A focused red receipt demonstrates the missing behavior before production edits, followed by a
  fresh green receipt for the exact same argv. Schema/Books/provider compatibility checks plus
  relevant type/lint checks are compiler-current.
- Local HTTPS desktop and narrow-width smoke cover the rendered workflow when project-native
  tooling supports them.
- Target sync, final verification, and report complete without stale-running agents, generic
  long-lived `Execute compiled work` labels, repeated recovery generations, or orphan processes.
- The run stops at operator-controlled promotion. Its row shows ready-to-merge, and
  `merge-run --preview` is clean; do not promote until the user explicitly presses `m`.

After each fresh run, review token use by stage/persona/ticket, attempts and retries, repeated
commands/scans, setup failures, review/rework cycles, stale agent rows, and durable terminal
cleanup. Repair systemic harness/profile causes, preserve the completed run as evidence, and use a
new run for the next comparison. This is the requested cognition/efficiency feedback loop; it must
not mutate either forensic run.

## Release status

Read-only audit complete and lease released. No Updog file, Git ref/worktree, installed binary,
credential, process, cockpit/cmux surface, or run artifact was changed. The primary integrator may
consume this recipe only after resolving the explicit in-place-migration contradiction in favor of
the independent-clone topology (or receiving new user authority that changes the protected-run
contract).
