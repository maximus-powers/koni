# Continuous Planning Session Revisions Design

## Summary

Koni will represent pre-approval planning as one durable logical planning session instead of one
agent attempt per operator revision. The planning session keeps one run, planner persona, attempt
identity, Pi session identity, transcript, pinned configuration, and detached planning checkout.
Operator steering starts a new revision epoch inside that session. It resets the revision-scoped
token allowance, appends the steering to the existing authenticated transcript, and asks the planner
to edit the current plan rather than reproduce it from an empty artifact.

The live provider process is not part of the continuity contract. Koni may release it while a plan
waits for human review and later reopen the same authenticated Pi session file. This preserves
planning continuity across long review intervals and process restarts without depending on an
in-memory provider thread.

Each compiler-valid revision remains an immutable checkpoint. The operator sees one current plan,
but Koni retains the submitted patch, materialized artifact, graph candidate, transcript snapshot,
usage epoch, steering authority, and hashes for every checkpoint. Approval binds one exact latest
checkpoint.

## Problem

Current plan steering:

1. Marks the prior planning attempt as superseded.
2. Creates a new attempt ID and Pi session ID.
3. Forks the authenticated prior conversation into the new session.
4. Gives the new attempt fresh grants and budgets.
5. Requires another complete plan and Graph Seed terminal payload.

This is safe and preserves conversation content, but the lifecycle model implies that steering
replaces the planner. It also makes the planner rewrite an artifact whose unchanged parts Koni
already holds. The user intent is simpler: planning is one iterative activity, steering edits its
current draft, and explicit steering authorizes more model tokens for that same activity.

## Goals

- Keep one logical planning attempt and one Pi session identity from initial planning through
  approval.
- Reopen the same authenticated Pi transcript after review, restart, or runtime release.
- Apply steering as an append-only authority event inside that session.
- Let the planner submit a bounded patch against the last compiler-valid artifact.
- Reset the configured planning token allowance for each explicit operator-steered revision.
- Keep provider accounting cumulative and monotonic for audit and cost reporting.
- Keep repository discovery calls and duplicate-call detection cumulative across the planning
  session.
- Preserve every compiler-valid plan revision as an immutable, hash-bound checkpoint.
- Keep compiler rejection as an in-revision correction loop.
- Bind approval to the exact current validated checkpoint and pinned repository/configuration
  context.
- Recover safely when the authority or provider host stops while planning, awaiting review, or
  resuming a revision.

## Non-goals

- Keeping one operating-system process or provider connection alive during human review.
- Resetting the model's physical context-window limit.
- Resetting repository discovery authority after steering.
- Permitting the planner to mutate repository files or graph state before approval.
- Removing immutable provider requests, tool receipts, transcripts, usage, steering, or plan
  checkpoints.
- Retrofitting active historical multi-attempt runs into a fabricated single session.
- Changing ticket-worker, Lead, reviewer, or integration attempt semantics.
- Allowing silent autonomous plan revisions. Only an explicit operator steering event starts a new
  revision epoch after review.

## Approaches Considered

### 1. Continuous logical session with immutable revision checkpoints — selected

Use one planning attempt and Pi session identity. Release and reopen the provider runtime around
review boundaries. Store revision-specific launch bindings, budgets, patches, and checkpoints under
the stable planning attempt. This satisfies conversational and artifact continuity while preserving
authority evidence.

### 2. Keep immutable attempts but hide them from the UI

Retain the current conversation-fork implementation and present all attempts as one planning
session. This is the smallest change, but it does not satisfy the requirement that steering resume
the same agent session and incrementally edit the artifact. It also leaves plan revision semantics
split between the product model and the authority model.

### 3. Keep the live provider process suspended during review

Do not terminate the managed session after plan submission; wait in memory for approval or steering.
This provides literal process continuity but fails restart safety, consumes resources during
potentially long reviews, and cannot make process lifetime an authority guarantee.

## Terminology

- **Planning session:** The stable pre-approval authority object identified by one planning
  `attemptId` and one Pi `sessionId`.
- **Revision epoch:** One bounded period of model work between initial launch or operator steering
  and a compiler-valid plan checkpoint.
- **Plan patch:** The planner-authored change from the last validated artifact to a candidate next
  artifact.
- **Checkpoint:** The complete compiler-valid materialized plan and graph candidate for one
  revision.
- **Runtime host:** A disposable process that opens and advances the stable Pi session transcript.

## Durable State

`RunRecord` gains an optional `planningSession`. It is required for new agent-planned runs and
absent on legacy runs that retain the existing multi-attempt compatibility path.

```ts
interface PlanningSessionRecord {
  protocol: "koni.planning-session.v1";
  attemptId: string;
  sessionId: string;
  status: "running" | "waiting_question" | "awaiting_review" | "approving" | "approved" | "blocked";
  currentRevision: number;
  approvedRevision?: number;
  revisions: PlanningRevisionRecord[];
}

interface PlanningRevisionRecord {
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
```

The existing `RunPlanRecord` remains the current-plan projection used by approval and operator
surfaces. Its `revision` must equal the latest `awaiting_review` or `approved` planning revision.
Historical revision bodies live in immutable artifacts rather than expanding the run record.

The stable `AgentAttemptRecord` gains revision-aware planning metadata and a `waiting_plan_review`
status. Its original `launchSpecHash` remains immutable. Revision launch specifications and grants
are bound by `planningSession.revisions`, not by overwriting the initial hash.

## Session and Runtime Lifecycle

### Initial planning

1. Pin the run context and create the detached read-only planning checkout.
2. Create one planning attempt ID and one Pi session ID.
3. Create planning revision `0` with zero token baseline.
4. Create the Pi session file and initial attempt/session mapping.
5. Run the bounded planner against the pinned checkout.
6. Accept a complete initial planning artifact through compiler validation.
7. Persist checkpoint `0`, set the attempt to `waiting_plan_review`, and release the runtime host.

### Steering

1. Require the run to be awaiting review, or to be in the existing explicitly supported blocked
   structural-replan state.
2. Persist the exact steering event before starting model work.
3. Mark the prior checkpoint `superseded` without changing its artifact.
4. Increment `currentRevision` and capture the cumulative provider totals as the new token baseline.
5. Issue a revision-specific immutable launch spec and grant under the stable attempt/session.
6. Reopen and authenticate the same Pi session file.
7. Append an authority-bound steering message naming the base checkpoint hash.
8. Ask the planner to edit only the affected artifact sections and submit a patch.

### Approval

Approval requires:

- `planningSession.status === "awaiting_review"`;
- `RunPlanRecord.revision === planningSession.currentRevision`;
- a compiler-valid checkpoint for that revision;
- no unresolved planning question batch;
- no unsettled provider request;
- exact checkpoint, target, base, configuration, and resource hashes.

Approval marks the revision and session approved, marks the stable planning attempt completed,
retires the detached planning checkout, creates the permanent run namespace, publishes the
checkpoint graph, and compiles the initial ticket board.

## Same-Session Continuation

The Pi session ID and session file remain stable. A revision runtime does not create a conversation
fork or another session header. It opens the existing file and verifies:

- the expected run, attempt, and session identities;
- the detached workspace path or approved-run replan workspace path;
- the last authenticated session entry;
- the prior checkpoint transcript hash;
- the revision's immutable launch spec and grant;
- the absence of an unsettled provider reservation;
- the current authority generation and planning revision.

The runtime appends a `koni.planning-revision-map` entry before the next provider request. That map
binds the revision, launch-spec hash, grant hash, token baseline, prior checkpoint, and steering
event. A crash before this append is effect-free. A crash after it is recovered as the same
revision, not as another planning attempt.

## Artifact Editing

Revision `0` submits the existing complete artifact:

- title;
- four full plan domains;
- four concise review domains;
- typed Graph Seed.

Later revisions submit `PlanningArtifactPatch`:

```ts
interface PlanningArtifactPatch {
  baseRevision: number;
  baseArtifactSha256: Sha256Digest;
  title?: string;
  full?: Partial<Record<PlanDomain, string>>;
  concise?: Partial<Record<PlanDomain, PlanReviewItem[]>>;
  graphSeed?: {
    setRootSpec?: Record<string, JsonValue>;
    removeRootSpecFields?: string[];
    upsertNodes?: PlanningGraphSeedNode[];
    removeNodeKeys?: string[];
    addEdges?: PlanningGraphSeedEdge[];
    removeEdges?: PlanningGraphSeedEdge[];
  };
}
```

The authority applies the patch to the exact base artifact, canonicalizes Graph Seed ordering, and
then runs the existing complete artifact parser and graph compiler. A patch cannot change the run
objective, pinned context, protected root fields, compiler-owned fields, or artifact protocol.
Removing a node also requires removing its edges in the same patch; dangling edges fail with a
model-visible compiler diagnostic.

Compiler rejection does not create a checkpoint or reset the revision budget. It returns the exact
diagnostic to the current live revision so the planner can correct and resubmit another patch.

## Token and Repository Budgets

Provider request and usage records remain cumulative on the stable attempt. A revision reset is an
allowance baseline, not deletion or zeroing of usage:

```text
revision new_tokens = cumulative new_tokens - revision budget baseline new_tokens
```

The configured `limit`, `synthesis_reserve`, and force-synthesis behavior apply to that delta. Every
steering event therefore authorizes one new configured planning token envelope. Operator surfaces
and reports continue to show cumulative usage, plus the current revision's usage.

The provider's authenticated context-window limit always applies to the complete resumed
conversation. Resetting the allowance cannot exceed it. Existing compiler-authored compaction is
permitted before a resumed revision, and its summary must include the current materialized plan,
checkpoint hash, resolved questions, steering history, and retained evidence identifiers.

Repository discovery calls remain cumulative across the planning session. Steering does not mint a
new discovery allowance. Exact duplicate discovery remains rejected. The planner must reuse prior
results and may spend only the remainder of the configured repository-call budget.

## Questions

Question batches remain nested inside the active planning revision. New batches bind both the stable
`attemptId` and `planningRevision`. Resolving a batch resumes that same revision. A stale answer or
resolution from an earlier revision cannot wake the current revision.

If the live runtime is gone, question resolution reopens the same Pi session and revision using the
durable transcript and batch resolution. It does not create another attempt or reset the revision's
token baseline.

## Recovery

- **Crash while awaiting review:** Rehydrate no provider host. Preserve the validated checkpoint and
  wait for approval or steering.
- **Crash while a revision is running:** Authenticate the current revision map, provider ledger,
  transcript leaf, launch spec, and grant; then continue that revision.
- **Crash after steering commit but before provider request:** Reopen the same revision from the
  committed steering event and zero revision usage.
- **Crash after provider reservation:** Use the existing provider-exposure reconciliation before
  continuing.
- **Crash after checkpoint artifacts but before run-record publication:** Complete the same
  crash-forward checkpoint transaction or leave the previous checkpoint current.
- **Compiler rejection:** Preserve the rejected tool receipt and continue the same revision.
- **Token exhaustion:** Apply the existing bounded synthesis/abort behavior to the current revision;
  do not silently create another revision or reset its budget.

## Compatibility

New runs use `planningSession`. Existing run records without it keep their current attempt-lineage
semantics. Do not merge historical session files, rewrite attempt IDs, or fabricate revision maps.

An active legacy run awaiting approval may be approved or revised through the legacy path. The new
continuous-session behavior begins only for runs created with the new planning-session marker.
Monitoring code projects both shapes into the same operator-facing plan/revision view.

Configuration continues to reject the retired `planning.session_scope` setting. Continuous planning
is the engine-owned behavior for new runs, not a selectable mode that could fragment the authority
contract.

## Operator Experience

The review UI continues to show one current plan and Graph Seed. Copy changes from “fresh planning
attempt” to “continue the planning session” or “revise the current plan.” Agent history shows one
planner identity with revision checkpoints and cumulative/revision usage instead of multiple planner
attempts.

The public `plan.revise` request shape may remain `{ runId, instructions }`. Its response adds the
stable planning session identity and new revision. Approval continues to use `plan.approve` and
binds the current checkpoint internally.

## Invariants

- One new agent-planned run has exactly one planning attempt ID and Pi session ID before approval.
- Every revision number is append-only, contiguous, and unique within that session.
- Every revision has exactly one immutable launch spec and token baseline.
- At most one revision is provider-capable at a time.
- At most one compiler-valid checkpoint is current.
- Steering is committed before a revision can issue a provider request.
- A patch names the exact base revision and artifact hash.
- A failed patch never mutates the current plan.
- Provider usage is monotonic and cumulative.
- Token allowance is measured from the current revision baseline.
- Repository discovery usage is cumulative.
- Approval names the exact current checkpoint and cannot approve a superseded revision.
- Runtime release, process restart, and question pause never change the planning session identity.

## Acceptance Criteria

1. Start a planned run and record one planning attempt/session identity.
2. Produce and validate revision `0`; observe the run awaiting approval while the planning attempt
   remains a resumable review checkpoint.
3. Submit steering; observe the same attempt/session identities and revision `1`.
4. Verify that the revision prompt retains prior transcript, questions, evidence, and plan.
5. Submit a patch changing one plan domain and one Graph Seed node; verify all other artifact
   content is byte-equivalent after materialization.
6. Reject a malformed patch and correct it in the same revision without another budget reset.
7. Verify revision `1` receives a fresh token allowance while cumulative usage remains unchanged
   except for newly settled requests.
8. Verify repository-call usage does not reset.
9. Restart while awaiting review and resume revision `1` through the same Pi session file.
10. Restart during revision `1` and recover the same revision without a conversation fork.
11. Approve revision `1`; verify approval cannot bind revision `0` and that the permanent graph and
    ticket board derive from revision `1`.
12. Load and finish a legacy multi-attempt planning run without rewriting its history.
