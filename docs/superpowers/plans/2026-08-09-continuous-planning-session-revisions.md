# Continuous Planning Session Revisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace steering-created planning attempts with one durable logical planning session that
edits its current artifact, resumes the same authenticated Pi transcript, and resets only the
revision-scoped token allowance.

**Architecture:** A new `PlanningSessionRecord` owns one stable planning `attemptId` and
`sessionId`, plus append-only revision records. Initial planning submits a complete artifact;
steered revisions submit patches against the last validated artifact. Each revision has an immutable
launch binding and token baseline, while provider usage, repository discovery, transcript history,
and the detached workspace remain cumulative. A successful submission creates a review checkpoint
rather than completing the planning attempt; approval seals the latest checkpoint and completes the
session.

**Tech Stack:** TypeScript 5.9, Node.js 22.19+, Pi 0.80.10, TypeBox 1.1.38, Vitest 4.1, Koni
authority RPC and repository-owned Git sidecar.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-09-continuous-planning-session-revisions-design.md`.
- Preserve one planning attempt ID, Pi session ID, session file, pinned context, and detached
  planning checkout through all pre-approval revisions.
- “Same session” means the same authenticated Pi session file and identity; the runtime host remains
  disposable.
- Keep every validated revision immutable and approval-bound by hash.
- Reset the configured token allowance only after explicit operator steering; never erase or
  decrease cumulative provider usage.
- Keep repository discovery calls and duplicate-call detection cumulative across revisions.
- Keep compiler rejection inside the current revision and do not reset its budget.
- Bind question batches to the active planning revision.
- Do not change Lead, ticket-worker, reviewer, or integration attempt behavior.
- New runs use continuous planning; historical runs without the new marker retain the legacy
  multi-attempt path.
- Do not add a configurable `planning.session_scope` mode.
- Preserve unrelated changes already present in this worktree; inspect the live diff before each
  task and resolve overlaps semantically.

---

## File Structure

- Create `packages/core/src/compiler/planning-artifact.ts`: planning artifact types, patch schema,
  patch materialization, canonicalization, and pure validation helpers.
- Modify `packages/core/src/state/run-record.ts`: durable planning session/revision records,
  `waiting_plan_review`, validation, and append-only mutation invariants.
- Modify `packages/core/src/state/run-lifecycle.ts`: planning checkpoint, steering revision,
  approval, question, pause, and recovery transitions.
- Modify `packages/core/src/pi/launch-spec.ts`: revision-specific planning launch binding under a
  stable attempt/session identity.
- Modify `packages/core/src/pi/managed-session.ts`: authenticated reopening of the same Pi session
  file for a later revision.
- Modify `packages/core/src/pi/attempt-process-supervisor.ts`: revision-aware child identity and
  recovery without a new attempt/session.
- Modify `packages/core/src/compiler/run-program.ts`: initial artifact compilation, patch
  compilation, graph validation, revision prompts, and budget-baseline-aware launch specs.
- Modify `packages/core/src/authority/run-engine.ts`: checkpoint settlement, `plan.revise`, revision
  launch/recovery, budget accounting, question binding, and approval sealing.
- Modify `packages/core/src/monitor/{protocol,client,controller,component}.ts`: continuous-session
  projections and copy.
- Modify `packages/core/src/control-center/{view-model,controller,component}.ts`: continuous
  revision display and copy.
- Modify `packages/core/src/state/stage-capability.ts`: revise-action capability language.
- Create `packages/core/test/planning-artifact.test.ts`: focused patch semantics.
- Modify the existing state, compiler, authority, Pi, monitor, control-center, and package smoke
  tests listed in the tasks below.
- Modify `docs/{architecture,configuration,control-center,runtime-and-git}.md`: public lifecycle
  contract.

---

### Task 1: Add the durable continuous-planning state model

**Files:**

- Modify: `packages/core/src/state/run-record.ts:365-710,1246-1335,1564-1810,5520-5660`
- Modify: `packages/core/src/state/run-lifecycle.ts:1-155,230-305`
- Test: `packages/core/test/run-lifecycle.test.ts`
- Test: `packages/core/test/run-authority-engine.test.ts`

**Interfaces:**

- Produces: `PlanningSessionRecord`, `PlanningRevisionRecord`, `PlanningSteeringBinding`,
  `AgentProviderTokenTotals`, and `AttemptStatus = ... | "waiting_plan_review"`.
- Produces: lifecycle event `plan_checkpoint_validated` and keeps `plan_revision_requested` as the
  operator steering event.
- Consumes: existing `RunPlanRecord`, `AgentAttemptRecord`, `RunLifecycleState.planRevision`, and
  canonical hash helpers.

- [ ] **Step 1: Write failing lifecycle and run-record validation tests**

Add cases proving one planning attempt can move `running -> waiting_plan_review -> running` while
the lifecycle moves `planning -> awaiting_approval -> planning`, and that revision arrays are
contiguous and append-only.

```ts
it("revises one planning session without replacing its attempt identity", () => {
  const initial = lifecycle("planning");
  const reviewed = reduceRunLifecycle(initial, {
    type: "plan_checkpoint_validated",
    atMs: 20,
    revision: 0,
  }).state;
  const revising = reduceRunLifecycle(reviewed, {
    type: "plan_revision_requested",
    atMs: 30,
  }).state;

  expect(reviewed.phase).toBe("awaiting_approval");
  expect(revising.phase).toBe("planning");
  expect(revising.planRevision).toBe(1);
});
```

Add an `assertRunRecord` case with one `planningSession`, two revision records, and one stable
planning attempt. Mutate the second revision number and expect validation to reject it.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
npm exec --workspace @koni/core -- vitest run test/run-lifecycle.test.ts test/run-authority-engine.test.ts
```

Expected: failures for the unknown lifecycle event, unknown attempt status, and absent
planning-session validator.

- [ ] **Step 3: Add the durable types and validators**

Add these public shapes, using existing `Sha256Digest`, `CompiledTokenPolicy`, and bounded
timestamp/ID validation conventions:

```ts
export interface AgentProviderTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PlanningSteeringBinding {
  sequence: number;
  instructionsSha256: Sha256Digest;
  instructionsSizeBytes: number;
  artifactPath: string;
  recordedAt: string;
}

export interface PlanningRevisionRecord {
  protocol: "koni.planning-revision.v1";
  revision: number;
  status: "running" | "awaiting_review" | "superseded" | "approved" | "failed";
  launchSpecSha256: Sha256Digest;
  grantSha256: Sha256Digest;
  budgetBaseline: AgentProviderTokenTotals;
  budgetPolicy: CompiledTokenPolicy;
  startedAt: string;
  steering?: PlanningSteeringBinding;
  patchSha256?: Sha256Digest;
  artifactSha256?: Sha256Digest;
  graphSha256?: Sha256Digest;
  transcriptSha256?: Sha256Digest;
  checkpointPath?: string;
  completedAt?: string;
}

export interface PlanningSessionRecord {
  protocol: "koni.planning-session.v1";
  attemptId: string;
  sessionId: string;
  status: "running" | "waiting_question" | "awaiting_review" | "approving" | "approved" | "blocked";
  currentRevision: number;
  approvedRevision?: number;
  revisions: PlanningRevisionRecord[];
}
```

Add `planningSession?: PlanningSessionRecord` to `RunRecord`. Validate stable attempt/session
identity, contiguous revisions starting at zero, exactly one current revision, state agreement with
`run.plan`, and legal approval fields. Extend mutation validation so earlier revision records and
checkpoint hashes cannot change.

- [ ] **Step 4: Add lifecycle transitions without changing legacy events**

Add `plan_checkpoint_validated` as the new event used by continuous sessions. Leave `plan_submitted`
readable for legacy runs. `plan_revision_requested` increments the revision and returns to planning
but does not imply a replacement attempt.

- [ ] **Step 5: Run the focused tests**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 6: Commit the state boundary**

```bash
git add packages/core/src/state/run-record.ts packages/core/src/state/run-lifecycle.ts packages/core/test/run-lifecycle.test.ts packages/core/test/run-authority-engine.test.ts
git commit -m "feat(core): model continuous planning revisions"
```

---

### Task 2: Implement partial planning-artifact revisions

**Files:**

- Create: `packages/core/src/compiler/planning-artifact.ts`
- Modify: `packages/core/src/compiler/run-program.ts:226-390,1850-1895,8442-9410`
- Create: `packages/core/test/planning-artifact.test.ts`
- Modify: `packages/core/test/native-run-program.test.ts:3040-3310`

**Interfaces:**

- Produces: `PlanningArtifact`, `PlanningArtifactPatch`, `parsePlanningArtifact`,
  `parsePlanningArtifactPatch`, `applyPlanningArtifactPatch`, and `canonicalizePlanningGraphSeed`.
- Produces: `RunProgram.compilePlanningRevision({ run, attemptId, revision, patch })`.
- Consumes: the existing complete plan domains and existing graph-seed compiler.

- [ ] **Step 1: Write focused failing patch tests**

Cover unchanged-domain preservation, base-hash mismatch, node upsert/removal, edge removal,
dangling-edge rejection, protected-root rejection, and canonical ordering.

```ts
it("materializes a revision without rewriting unaffected plan domains", () => {
  const base = planningArtifactFixture();
  const revised = applyPlanningArtifactPatch(base, {
    baseRevision: 0,
    baseArtifactSha256: canonicalHash(base),
    full: { verification: "Use the exact composed verification seam." },
    graphSeed: {
      upsertNodes: [{ key: "proof-main", type: "proof", title: "Composed proof", spec: proofSpec }],
    },
  });

  expect(revised.full.architecture).toBe(base.full.architecture);
  expect(revised.full.decisions).toBe(base.full.decisions);
  expect(revised.full.risk).toBe(base.full.risk);
  expect(revised.full.verification).not.toBe(base.full.verification);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
npm exec --workspace @koni/core -- vitest run test/planning-artifact.test.ts test/native-run-program.test.ts
```

Expected: module-not-found and missing compiler method failures.

- [ ] **Step 3: Extract the planning artifact contract into the focused module**

Move the four-domain constant and pure parsing logic out of `run-program.ts`. Preserve the existing
initial terminal schema and artifact bytes. Export exact types:

```ts
export const PLAN_DOMAINS = ["architecture", "decisions", "risk", "verification"] as const;
export type PlanDomain = (typeof PLAN_DOMAINS)[number];

export interface PlanningArtifactPatch {
  baseRevision: number;
  baseArtifactSha256: Sha256Digest;
  title?: string;
  full?: Partial<Record<PlanDomain, string>>;
  concise?: Partial<Record<PlanDomain, PlanReviewItem[]>>;
  graphSeed?: PlanningGraphSeedPatch;
}
```

Use semantic graph operations rather than array-index JSON Patch. Reject duplicate operations,
unknown keys, removal of `$root`, and noncanonical or conflicting edge operations. Apply into a
clone, then validate the complete result with `parsePlanningArtifact`.

- [ ] **Step 4: Add compiler entry points for initial and revision output**

Keep `compilePlanningOutput` for revision zero and legacy runs. Add:

```ts
public async compilePlanningRevision(input: {
  run: RunRecord;
  attemptId: string;
  revision: number;
  patch: unknown;
}): Promise<PlanningCompilation>;
```

Load the exact base checkpoint artifact, verify `baseRevision` and `baseArtifactSha256`, apply the
patch, compile the complete Graph Seed, and write immutable patch/artifact/graph/checkpoint files
under:

```text
runs/<run-id>/attempts/<attempt-id>/planning/revisions/<revision>/
```

- [ ] **Step 5: Prove rejected patches are effect-free**

Add a test that hashes the prior `RunPlanRecord`, rejects a disconnected Graph Seed patch, and
asserts no artifact write or changed plan is returned.

- [ ] **Step 6: Run the compiler tests**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 7: Commit the artifact boundary**

```bash
git add packages/core/src/compiler/planning-artifact.ts packages/core/src/compiler/run-program.ts packages/core/test/planning-artifact.test.ts packages/core/test/native-run-program.test.ts
git commit -m "feat(core): compile incremental plan revisions"
```

---

### Task 3: Bind revision launches under one attempt and session

**Files:**

- Modify: `packages/core/src/pi/launch-spec.ts:1-130,210-390,680-730`
- Modify: `packages/core/src/compiler/run-program.ts:1210-1370,6512-6585,13830-13960`
- Modify: `packages/core/src/state/run-record.ts:635-710,5520-5660`
- Test: `packages/core/test/pi-launch-spec.test.ts`
- Test: `packages/core/test/native-run-program.test.ts`

**Interfaces:**

- Produces: optional `AgentLaunchSpec.planningRevision` binding.
- Produces: `preparePlanningRevision(...)` that reuses `attemptId` and `sessionId` while issuing a
  new immutable revision spec and grant.
- Consumes: `PlanningRevisionRecord.budgetBaseline`, current checkpoint hash, and steering binding.

- [ ] **Step 1: Write failing launch-spec identity tests**

```ts
it("authenticates a later planning revision without a conversation fork", () => {
  const spec = planningRevisionSpec({ revision: 1 });
  expect(validateAgentLaunchSpec(spec).identity.attemptId).toBe("attempt-plan");
  expect(spec.identity.sessionId).toBe("session-plan");
  expect(spec.lineage.conversationFork).toBeUndefined();
  expect(spec.planningRevision).toMatchObject({ revision: 1, baseRevision: 0 });
});
```

Reject a planning revision that changes attempt/session IDs, omits the prior checkpoint hash, uses a
noncontiguous revision, or has a token baseline greater than cumulative settled usage.

- [ ] **Step 2: Run and confirm failure**

```bash
npm exec --workspace @koni/core -- vitest run test/pi-launch-spec.test.ts test/native-run-program.test.ts
```

- [ ] **Step 3: Extend the immutable launch specification**

Add:

```ts
planningRevision?: {
  revision: number;
  baseRevision: number | null;
  priorCheckpointSha256: Sha256Digest | null;
  steeringSha256: Sha256Digest | null;
  budgetBaseline: AgentProviderTokenTotals;
};
```

Require it only for continuous planning. Exclude it from non-planning specs. Keep ordinary attempt
lineage unchanged; a later planning revision is not an attempt-lineage child.

- [ ] **Step 4: Make the planning prompt revision-aware**

Revision zero keeps the complete-output prompt. Later revisions receive the current plan artifact,
base hash, exact steering, resolved questions, and patch schema. Replace “revise the prior plan in a
fresh attempt” language with:

```text
Continue this planning session. Apply the operator steering to the current compiler-valid plan.
Preserve unchanged domains and graph elements. Submit only the bounded patch against the named
base revision and artifact hash.
```

- [ ] **Step 5: Run tests and commit**

```bash
npm exec --workspace @koni/core -- vitest run test/pi-launch-spec.test.ts test/native-run-program.test.ts
git add packages/core/src/pi/launch-spec.ts packages/core/src/compiler/run-program.ts packages/core/src/state/run-record.ts packages/core/test/pi-launch-spec.test.ts packages/core/test/native-run-program.test.ts
git commit -m "feat(core): bind planning revision launch epochs"
```

---

### Task 4: Reopen the same authenticated Pi session for steering

**Files:**

- Modify: `packages/core/src/pi/managed-session.ts:220-650,1400-1735,1760-2160`
- Modify: `packages/core/src/pi/attempt-process-supervisor.ts`
- Modify: `packages/core/test/fixtures/pi-attempt-process-fixture.mjs`
- Test: `packages/core/test/pi-managed-session.test.ts`
- Test: `packages/core/test/pi-attempt-process.test.ts`

**Interfaces:**

- Produces: `ManagedPiSession.continuePlanningRevision(spec, options)`.
- Produces: transcript entry `koni.planning-revision-map`.
- Consumes: stable session file, prior checkpoint transcript hash, new revision spec/grant, and
  steering message.

- [ ] **Step 1: Write failing same-session continuation tests**

Create revision zero, persist an accepted planning checkpoint, release the runtime, then continue
revision one. Assert the same session header ID and file path, no `parentSession`, one appended
revision map, and the steering message after that map.

```ts
expect(revisionOne.sessionFile).toBe(revisionZero.sessionFile);
expect(parseHeader(revisionOne.sessionFile).id).toBe("session-plan");
expect(parseHeader(revisionOne.sessionFile).parentSession).toBeUndefined();
expect(entriesOfType("koni.conversation-fork-map")).toHaveLength(0);
```

Add rejection cases for a changed workspace, changed attempt/session identity, mismatched transcript
leaf, stale checkpoint hash, and unsettled provider request.

- [ ] **Step 2: Run and confirm failure**

```bash
npm exec --workspace @koni/core -- vitest run test/pi-managed-session.test.ts test/pi-attempt-process.test.ts
```

- [ ] **Step 3: Add authenticated continued-session opening**

Implement a separate opener from `createForkedSessionManager`:

```ts
async function openPlanningRevisionSessionManager(
  spec: Readonly<AgentLaunchSpec>,
): Promise<SessionManager>;
```

Open the existing file with no symlink following, authenticate the session header and original
attempt mapping, validate the last checkpoint transcript hash, append a revision map, fsync, and
then expose the session to Pi. Never write a new header or fork map.

- [ ] **Step 4: Make terminal acceptance end one revision host, not the planning attempt**

Return a managed outcome that distinguishes a planning checkpoint:

```ts
type ManagedSessionOutcome =
  | { status: "checkpointed"; terminalOutput: unknown; usage: ManagedTokenUsage }
  | ExistingManagedSessionOutcome;
```

The process supervisor must report the revision number with this outcome and release child
resources. It must not report a terminal attempt completion.

- [ ] **Step 5: Add process recovery coverage**

Test process exit while awaiting review, after the revision map but before the provider request, and
after a settled provider response. Recovery must reopen the same session/revision or remain idle
awaiting review.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --workspace @koni/core -- vitest run test/pi-managed-session.test.ts test/pi-attempt-process.test.ts
git add packages/core/src/pi/managed-session.ts packages/core/src/pi/attempt-process-supervisor.ts packages/core/test/fixtures/pi-attempt-process-fixture.mjs packages/core/test/pi-managed-session.test.ts packages/core/test/pi-attempt-process.test.ts
git commit -m "feat(core): continue one Pi planning session"
```

---

### Task 5: Replace `plan.revise` attempt replacement with session revision

**Files:**

- Modify:
  `packages/core/src/authority/run-engine.ts:3260-3285,3880-4040,9380-9860,10070-10780,13190-13320,14090-14320`
- Modify: `packages/core/src/state/stage-capability.ts:430-465`
- Test: `packages/core/test/run-authority-engine.test.ts:1940-2025`
- Test: `packages/core/test/run-provider-authority.test.ts:990-1060`
- Test: `packages/core/test/change-control-authority-integration.test.ts`

**Interfaces:**

- Produces: `#launchPlanningRevision(runId, revision)` and checkpoint settlement.
- Changes: `#revisePlan` appends steering and reuses the existing planning attempt/session.
- Consumes: Task 2 compiler patching, Task 3 revision spec, and Task 4 continued session.

- [ ] **Step 1: Replace the existing two-attempt expectation with a failing continuity test**

Change the current feature-plan revision test to assert:

```ts
const initialPlanner = onlyPlanningAttempt(planned);
// submit plan.revise and wait for revision 1 review
const revisedPlanner = onlyPlanningAttempt(revised);

expect(revisedPlanner.id).toBe(initialPlanner.id);
expect(revisedPlanner.sessionId).toBe(initialPlanner.sessionId);
expect(revised.planningSession?.currentRevision).toBe(1);
expect(revised.planningSession?.revisions).toHaveLength(2);
expect(revisedPlanner.lineage?.conversationFork).toBeUndefined();
```

Assert the prior checkpoint is `superseded`, its hashes are unchanged, and revision one names the
exact steering binding.

- [ ] **Step 2: Run and confirm the old implementation fails**

```bash
npm exec --workspace @koni/core -- vitest run test/run-authority-engine.test.ts test/run-provider-authority.test.ts
```

- [ ] **Step 3: Change initial planning settlement into a review checkpoint**

When a continuous planning terminal tool succeeds, compile revision zero, persist checkpoint
artifacts, set `RunPlanRecord.status = "awaiting_approval"`, set the planning attempt status to
`waiting_plan_review`, apply `plan_checkpoint_validated`, and release the runtime. Do not populate
terminal-attempt closure fields until approval.

- [ ] **Step 4: Rewrite `#revisePlan`**

Remove the loop that interrupts/supersedes planning attempts. In one authority transaction:

1. Validate the current checkpoint and provider ledger.
2. Persist the steering bytes and append their binding.
3. Mark the prior revision superseded.
4. Capture cumulative token totals as the next revision baseline.
5. Append the running revision record.
6. Set the stable attempt to `queued` and clear revision-local synthesis state.
7. Apply `plan_revision_requested`.

After commit, open the same Pi session with `#launchPlanningRevision`.

- [ ] **Step 5: Compile a revision patch into the next checkpoint**

Route revision-zero output to `compilePlanningOutput` and later output to `compilePlanningRevision`.
A compiler rejection remains a model-visible rejected tool receipt; do not advance the plan revision
or checkpoint.

- [ ] **Step 6: Seal the planning session during approval**

Before Git materialization, verify the current checkpoint hash and revision. On successful approval,
mark the planning revision/session approved and finish the stable planning attempt once. Reject
stale approval and steering races through the existing authority revision compare-and-swap.

- [ ] **Step 7: Preserve explicit blocked-plan replanning**

For the existing approved-but-structurally-blocked path, reopen the stable planning session against
the permanent run worktree only when its session/checkpoint still authenticates. Do not resurrect
the retired detached checkout. Add a test proving that path keeps the same session identity.

- [ ] **Step 8: Run authority tests and commit**

```bash
npm exec --workspace @koni/core -- vitest run test/run-authority-engine.test.ts test/run-provider-authority.test.ts test/change-control-authority-integration.test.ts
git add packages/core/src/authority/run-engine.ts packages/core/src/state/stage-capability.ts packages/core/test/run-authority-engine.test.ts packages/core/test/run-provider-authority.test.ts packages/core/test/change-control-authority-integration.test.ts
git commit -m "feat(core): revise plans within one authority session"
```

---

### Task 6: Reset revision token allowance without resetting evidence or cost

**Files:**

- Modify: `packages/core/src/authority/run-engine.ts:21670-21920`
- Modify: `packages/core/src/pi/managed-session.ts:300-650`
- Modify: `packages/core/src/compiler/run-program.ts:13830-13960`
- Test: `packages/core/test/run-provider-authority.test.ts`
- Test: `packages/core/test/native-run-program.test.ts`

**Interfaces:**

- Produces: `planningRevisionTokenUsage(attempt, revision): AgentProviderTokenTotals`.
- Changes: token-policy enforcement uses cumulative totals minus revision baseline.
- Preserves: repository-call enforcement reads all accepted discovery receipts on the stable
  attempt.

- [ ] **Step 1: Write failing budget-baseline tests**

Set cumulative usage to 90,000 new tokens, begin a revision with a 90,000 baseline and 120,000
limit, then settle 10,000 new tokens. Assert revision usage is 10,000 and cumulative usage is
100,000. Add a second test proving the existing repository-call count is not zeroed.

```ts
expect(planningRevisionNewTokens(attempt, revision)).toBe(10_000);
expect(attempt.inputTokens + attempt.outputTokens).toBe(100_000);
expect(inheritedRepositoryDiscoveryCalls(run, attempt)).toBe(previousDiscoveryCount);
```

- [ ] **Step 2: Run and confirm failure**

```bash
npm exec --workspace @koni/core -- vitest run test/run-provider-authority.test.ts test/native-run-program.test.ts
```

- [ ] **Step 3: Introduce baseline-relative token accounting**

Keep provider requests and attempt totals monotonic. Compute input, output, cache, processed, and
`new_tokens` deltas from the active revision baseline. Reject negative deltas as corrupted state.
Use the delta for token limit and synthesis threshold checks; use cumulative totals for provider
accounting and monitoring.

- [ ] **Step 4: Move planning synthesis state to the revision record**

Replace the single `attempt.planningSynthesis` authority for continuous sessions with revision-local
synthesis metadata. Historical attempts retain the old field. A compiler rejection after synthesis
does not reopen discovery or reset the budget.

- [ ] **Step 5: Preserve cumulative repository discovery**

For continuous sessions, count all accepted discovery tools on the stable attempt. Keep exact
duplicate rejection across revisions. Add an error message that tells the planner the retained
receipt belongs to the same planning session.

- [ ] **Step 6: Cover context-window pressure and compaction**

Add a test where revision allowance remains but the resumed transcript approaches the authenticated
context window. Assert Koni compacts or triggers synthesis without treating the allowance reset as a
larger physical context window.

- [ ] **Step 7: Run tests and commit**

```bash
npm exec --workspace @koni/core -- vitest run test/run-provider-authority.test.ts test/native-run-program.test.ts
git add packages/core/src/authority/run-engine.ts packages/core/src/pi/managed-session.ts packages/core/src/compiler/run-program.ts packages/core/test/run-provider-authority.test.ts packages/core/test/native-run-program.test.ts
git commit -m "feat(core): reset planning revision token allowance"
```

---

### Task 7: Bind questions and recovery to the active revision

**Files:**

- Modify: `packages/core/src/state/question-batch.ts`
- Modify: `packages/core/src/authority/run-engine.ts:1910-1970,2760-2820,9630-9860,17100-17500`
- Modify: `packages/core/src/pi/attempt-process-supervisor.ts`
- Test: `packages/core/test/run-authority-engine.test.ts`
- Test: `packages/core/test/pi-attempt-process.test.ts`
- Test: `scripts/pi-package-smoke.test.mjs`

**Interfaces:**

- Changes: `QuestionBatchRecord` gains optional `planningRevision`, required for new planning
  batches.
- Produces: recovery distinguishes `running`, `waiting_question`, and `waiting_plan_review` for one
  stable attempt.

- [ ] **Step 1: Write failing question revision tests**

Assert a revision-one batch resumes revision one, while a delayed revision-zero resolution is
rejected as stale. Assert resolving after runtime loss reopens the same attempt/session/revision and
does not reset the budget baseline.

- [ ] **Step 2: Run and confirm failure**

```bash
npm exec --workspace @koni/core -- vitest run test/run-authority-engine.test.ts test/pi-attempt-process.test.ts
```

- [ ] **Step 3: Add revision binding to question batches**

Set `planningRevision` when a planning tool opens a batch. Validate it against the current revision
on answer save, explicit Resolve, waiter delivery, and crash recovery. Leave it absent for legacy
batches and non-planning questions.

- [ ] **Step 4: Make startup recovery revision-aware**

Recovery rules:

- `waiting_plan_review`: do not spawn a child;
- `waiting_question`: wait for Resolve, then reopen the same revision;
- `running`: recover the current revision spec/session file;
- committed steering with no provider request: start the committed revision;
- accepted checkpoint without run publication: finish the checkpoint transaction idempotently.

- [ ] **Step 5: Extend the packaged real-Pi smoke scenario**

In `scripts/pi-package-smoke.test.mjs`, run initial planning, answer a question, review, steer once,
and verify the same attempt/session mapping and a second planning revision map in the same JSONL
file before approval.

- [ ] **Step 6: Run tests and commit**

```bash
npm exec --workspace @koni/core -- vitest run test/run-authority-engine.test.ts test/pi-attempt-process.test.ts
npm run build --workspace @koni/core
node --test scripts/pi-package-smoke.test.mjs
git add packages/core/src/state/question-batch.ts packages/core/src/authority/run-engine.ts packages/core/src/pi/attempt-process-supervisor.ts packages/core/test/run-authority-engine.test.ts packages/core/test/pi-attempt-process.test.ts scripts/pi-package-smoke.test.mjs
git commit -m "feat(core): recover planning revision continuity"
```

---

### Task 8: Update operator projections and compatibility behavior

**Files:**

- Modify: `packages/core/src/monitor/protocol.ts`
- Modify: `packages/core/src/monitor/client.ts`
- Modify: `packages/core/src/monitor/controller.ts`
- Modify: `packages/core/src/monitor/component.ts`
- Modify: `packages/core/src/authority/monitor-projection.ts`
- Modify: `packages/core/src/control-center/view-model.ts:870-945`
- Modify: `packages/core/src/control-center/controller.ts:4200-4245`
- Modify: `packages/core/src/control-center/component.ts:2300-2360,3750-3785,4045-4070`
- Test: `packages/core/test/monitor-protocol.test.ts`
- Test: `packages/core/test/monitor-controller.test.ts`
- Test: `packages/core/test/monitor-components.test.ts`
- Test: `packages/core/test/control-center-view-model.test.ts`
- Test: `packages/core/test/control-center-surfaces.test.ts`
- Test: `packages/core/test/run-record-fixtures.ts`

**Interfaces:**

- Keeps: public mutation request `plan.revise({ runId, instructions })`.
- Adds: response/projection fields `planningSessionId`, `planningAttemptId`, and `revisionUsage`
  where appropriate.
- Preserves: legacy runs project their current plan and attempt lineage without fabricated
  continuity.

- [ ] **Step 1: Write failing projection tests**

Assert one planner row persists through revision zero and one; the plan review shows revision one;
usage shows cumulative and current-revision totals; activity says “Planning session continued”
rather than “Fresh planning attempt.”

- [ ] **Step 2: Run and confirm failure**

```bash
npm exec --workspace @koni/core -- vitest run test/monitor-protocol.test.ts test/monitor-controller.test.ts test/monitor-components.test.ts test/control-center-view-model.test.ts test/control-center-surfaces.test.ts
```

- [ ] **Step 3: Project continuous and legacy records through one view model**

When `planningSession` exists, derive identity and revision usage from it. Otherwise preserve the
existing attempt-lineage projection. Never coalesce or rewrite historical attempts.

- [ ] **Step 4: Update operator copy**

Use:

- “Revise the current plan” for steering form help;
- “Continue planning session” for activity;
- “Revision N” for checkpoints;
- “Same planner session; token allowance reset for this revision” for details.

Remove “fresh immutable planning attempt” and “next planning attempt” from continuous-session paths.

- [ ] **Step 5: Run tests and commit**

```bash
npm exec --workspace @koni/core -- vitest run test/monitor-protocol.test.ts test/monitor-controller.test.ts test/monitor-components.test.ts test/control-center-view-model.test.ts test/control-center-surfaces.test.ts
git add packages/core/src/monitor packages/core/src/authority/monitor-projection.ts packages/core/src/control-center packages/core/test/monitor-protocol.test.ts packages/core/test/monitor-controller.test.ts packages/core/test/monitor-components.test.ts packages/core/test/control-center-view-model.test.ts packages/core/test/control-center-surfaces.test.ts packages/core/test/run-record-fixtures.ts
git commit -m "feat(core): present one revisable planning session"
```

---

### Task 9: Preserve legacy runs and document the new contract

**Files:**

- Modify: `packages/core/src/state/run-record.ts`
- Modify: `packages/core/src/authority/run-engine.ts`
- Modify: `packages/core/test/run-authority-engine.test.ts`
- Modify: `packages/core/test/run-provider-authority.test.ts`
- Modify: `docs/architecture.md`
- Modify: `docs/configuration.md`
- Modify: `docs/control-center.md`
- Modify: `docs/runtime-and-git.md`
- Modify: `docs/getting-started.md`

**Interfaces:**

- Produces: a compatibility branch selected solely by presence/absence of `run.planningSession`.
- Preserves: historical multi-attempt runs and their session/lineage artifacts byte-for-byte.

- [ ] **Step 1: Write failing legacy compatibility tests**

Load a run with two historical planning attempts and no `planningSession`. Assert validation,
review, approval, and the existing legacy revise path remain available without synthesizing a
session record. Create a new run and assert `planningSession` is present immediately after planning
admission.

- [ ] **Step 2: Run and confirm failure**

```bash
npm exec --workspace @koni/core -- vitest run test/run-authority-engine.test.ts test/run-provider-authority.test.ts
```

- [ ] **Step 3: Add the explicit compatibility branch**

Do not infer continuity by inspecting attempt count. New run creation writes the marker. Runs
without it use the legacy implementation. Keep legacy launch-spec paths, conversation forks,
terminal artifacts, and approval checks unchanged.

- [ ] **Step 4: Update documentation**

Document:

- one logical session and disposable runtime hosts;
- incremental plan patches and immutable checkpoints;
- same-session question and steering continuation;
- revision-scoped token reset with cumulative provider accounting;
- cumulative repository discovery;
- compiler correction versus operator steering;
- legacy-run behavior.

Remove statements that every planning revision receives a fresh Pi session.

- [ ] **Step 5: Run documentation and compatibility tests**

```bash
npm exec --workspace @koni/core -- vitest run test/run-authority-engine.test.ts test/run-provider-authority.test.ts
npm run test:docs
```

- [ ] **Step 6: Commit compatibility and docs**

```bash
git add packages/core/src/state/run-record.ts packages/core/src/authority/run-engine.ts packages/core/test/run-authority-engine.test.ts packages/core/test/run-provider-authority.test.ts docs/architecture.md docs/configuration.md docs/control-center.md docs/runtime-and-git.md docs/getting-started.md
git commit -m "docs: define continuous planning session revisions"
```

---

### Task 10: Run integration verification and audit the authority invariants

**Files:**

- Modify only if failures expose a defect: files already listed in Tasks 1-9.
- Test: the complete repository quality suite.

**Interfaces:**

- Consumes all preceding tasks.
- Produces a passing continuous-planning lifecycle with no regression to other attempt kinds.

- [ ] **Step 1: Run focused continuous-planning tests together**

```bash
npm exec --workspace @koni/core -- vitest run test/planning-artifact.test.ts test/pi-launch-spec.test.ts test/pi-managed-session.test.ts test/pi-attempt-process.test.ts test/native-run-program.test.ts test/run-lifecycle.test.ts test/run-authority-engine.test.ts test/run-provider-authority.test.ts test/monitor-protocol.test.ts test/control-center-surfaces.test.ts
```

Expected: PASS with no retries or open handles.

- [ ] **Step 2: Run the core package check**

```bash
npm run check --workspace @koni/core
```

Expected: typecheck, Vitest, and clean package build all pass.

- [ ] **Step 3: Run repository-level contract checks**

```bash
npm run test:docs
npm run test:architecture
npm run test:profiles
npm run test:pi-host-boundary
```

Expected: PASS.

- [ ] **Step 4: Run the packaged Pi smoke test**

```bash
npm run test:pi-package
```

Expected: the steered planning scenario uses one attempt/session file, appends the next revision
map, resets revision token usage, preserves cumulative evidence, and approves the latest checkpoint.

- [ ] **Step 5: Perform the invariant audit**

Inspect one test run record and session file and verify:

```text
one planning attempt ID
one Pi session ID and header
two contiguous revision records
two immutable revision launch specs
one append-only steering event
one cumulative provider ledger
revision-one budget baseline equal to totals at steering
no conversation-fork map
prior checkpoint unchanged and superseded
approval bound to the latest checkpoint hash
```

- [ ] **Step 6: Run the full repository check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit any verification fixes separately**

Stage only files changed to correct verified failures, then commit with a message naming the
specific invariant, for example:

```bash
git commit -m "fix(core): bind approval to current planning checkpoint"
```
