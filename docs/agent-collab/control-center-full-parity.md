# Pi-native control-center full parity

Owner: `pi_operator_surface/root`

Status: complete; source lease released on branch `pi-native-port`.

## Lease

- Own only `packages/core/src/control-center/**`, focused control-center tests, this mailbox, and
  append-only registry notes.
- Build on the shared `/koni` / `koni tui` controller and component; do not fork host-specific UI.
- Consume authority RPCs for every durable read and effect. Local form/editor state is a draft,
  never compiler or workflow authority.
- If an authority projection is missing, define the smallest typed versioned RPC contract here and
  hand it to the authority owner; do not edit the run engine, operator bootstrap, or profile
  lifecycle without coordination.
- Preserve coherent concurrent work. Do not run a provider, touch credentials, mutate a project,
  open a terminal/cmux pane, install a binary, or operate a live run.

## Current product contract

The current TypeScript control center is a foundation, not the final surface. This lane is
reconciling it with `docs/control-center.md`, `docs/tui-cleanup-backlog.md`, every `tui-*`
coordination record, and the Rust smoke-tested behavior. The active contract includes:

- one equal-column dashboard with the conditional Questions panel, complete Agents/Activity/Graph
  context, semantic Pi chat, contextual help, and width-safe presentation;
- complete guided New Run intake, an immediate provisional row, recent target branch, all pipeline
  stages, run-local overrides, and explicit Start action;
- one structured Review Plan modal with independently authored concise projections, complete
  post-approval plans, multiline steering, and one adaptive authority action;
- a semantic configuration editor organized by product domains, backed by a project-overlay draft
  and explicit save/validate-publish/discard actions;
- no normal-surface IDs, hashes, paths, raw YAML, transport events, or inferred workflow authority.

## Authority projection requested

The existing authority already owns `branches.list`, `run.create`, `plan.approve`, `plan.revise`,
`run.transcript`, agent steering/follow-up, graph reads, and lifecycle mutations. Full guided
editing additionally needs one versioned read projection and three draft mutations:

- `control.catalog` -> run-type cards/defaults/stages, Pi model and thinking catalogs, persona
  defaults, and semantic configuration sections/fields;
- `config.draft.save` -> persist an authenticated project-overlay draft without activating it;
- `config.draft.publish` -> compile/validate and atomically activate the draft for future runs;
- `config.draft.discard` -> restore the draft from the active project overlay.

The UI contract is typed under `control-center/` and feature-detects these calls. The authority
must derive the projection from the effective compiled project/profile and Pi model catalog; the
TypeScript UI must not read or rewrite YAML itself. Existing pinned runs remain unchanged.

### 2026-07-16 authority-owner correction

The draft-RPC proposal above is retained as the initial handoff, but is superseded by the profile
lifecycle owner's already active interface: `config.catalog`, `config.get`, and one source-SHA-CAS
`config.update`. Unsaved and explicitly saved-but-unpublished edits remain in the controller's
in-memory draft; `config.update` is the only publish boundary and validates the complete candidate
before activation. The control center will not introduce `config.draft.*` methods.

Pi model choices are also not authority configuration. `/koni` snapshots the invoking Pi
`ModelRegistry`; standalone `koni tui` reads the same ordinary Pi catalog through a read-only
`ModelRuntime`. Both inject stable `{provider, id, name, reasoning, available}` options into the
shared controller. Koni neither registers providers nor reads/writes Pi settings or credentials.

> **Contained-catalog correction — 2026-07-16:** the invoking registry alone can contain providers
> registered by ambient extensions that autonomous children intentionally do not load. Both hosts
> now derive selectable entries from a fresh offline Pi `ModelRuntime` using Pi's normal
> credentials and `models.json`. `/koni` intersects that executable inventory with its ambient
> registry; ambient-only entries remain visible in the protocol as unavailable with a reason and
> are never registered or selectable in the contained runtime.

### 2026-07-16 19:24 MST — shared control center implemented

The one controller/component used by Pi `/koni` and explicit `koni tui` now implements the full
operator contract rather than a host-specific approximation:

- equal dashboard columns; conditional Questions; complete run/ticket/agent/activity/graph
  projections; width-safe help and compact presentation;
- complete guided New Run intake with target branch, always-visible stage flow, Small/Medium/Large
  and custom authority cards, question policy, unbounded positive parallelism, all Pi-available
  model/reasoning selectors, explicit Start, and an immediate provisional run row;
- concise independently authored Review Plan sections with one adaptive approve/revise action,
  multiline steering, and complete approved Markdown under Details → Plan;
- vertically composed Objective/Goal/Run/Evidence, ticket step/persona/outcome details, explicit
  failure evidence, cache-excluding `new tks`, approved active time, and semantic activity;
- complete persisted Pi transcript blocks and authority-routed steering/follow-up, with no generic
  `Pi event` reconstruction;
- a semantic domain/resource configuration editor with in-memory save, source-CAS publish,
  discard, nested presentation, and field-type/model/reasoning controls.

Whole-resource collection editing uses this additive opaque contract:

- sections and resources may expose `createOptions` containing only human title/description/name
  copy plus an opaque template ID;
- resources may expose `parentId`, `depth`, `canDuplicate`, and `canDelete`;
- `config.resource.create` accepts `{cas, sectionId, templateId, parentResourceId?, name}`;
- `config.resource.duplicate` accepts `{cas, resourceId, name}`;
- `config.resource.delete` accepts `{cas, resourceId}`.

All three mutations are revisioned and idempotent. The controller blocks them while field edits are
dirty, confirms deletion, and reloads `config.catalog` plus `config.get` after authority commits.
Paths, YAML, hashes, and opaque IDs are never rendered. Authority registration/source mutation is
owned by the run-engine/profile integration lane; this UI does not acquire filesystem authority.

Provider-free focused evidence is **23/23**. The Core strict typecheck was green immediately after
the collection implementation; a later composed run became temporarily red only in concurrently
edited `compiler/reports.ts`, outside this lease. The authority run lifecycle passes **2/2** with
the integration timeout raised above the filesystem-heavy default. One profile/config surface
fixture exceeded its hard-coded 30-second timeout under concurrent test load without emitting a
semantic assertion failure; this lane did not weaken that independent test.

### 2026-07-16 19:40 MST — independent parity review corrections

The 23-test checkpoint above is retained as history and superseded by a fail-closed independent
review. Its P0/P1 findings are now resolved:

- saved configuration drafts retain their originating CAS and base values; reopening after an
  external change requires explicit Ctrl-R three-way rebase or discard before save/publish, with
  overlapping fields called out for review;
- both real hosts now project the ordinary Pi model registry even when the CLI supplies an already
  leased authority client;
- the authority registers revisioned/idempotent `config.resource.*` handlers, advertises semantic
  capabilities/templates, validates and recompiles the complete candidate, and crash-recovers
  source mutations;
- Objectives wrap at the real Details-column width, Questions anchor the live Notes editor, stage
  cards and resource confirmations retain actionable content at compact sizes, and completed runs
  close every stage;
- active selected transcripts coalesce reloads from authority agent events; historical sessions
  are visibly read-only and leaving Chat restores the prior Details tab;
- generic/repeated planning noise is filtered, pre-approval Details never exposes full agent plan
  text, graph titles identify run-integration versus ticket-checkout scope, and Chat has reachable
  contextual help.

The focused provider-free control-center suite is now **31/31** and Core strict TypeScript is green.
The test authority rejects every unfixture RPC instead of accepting unknown methods. Direct real
configuration collection coverage creates, duplicates, deletes, recompiles, source-CAS rejects,
and crash-recovers resources with a filesystem-appropriate 90-second timeout; an engine-level RPC
proof remains owned and reported by the authority integration lane.

### 2026-07-16 19:44 MST — final handoff and lease release

Source under `packages/core/src/control-center/**` and the two focused control-center test files is
released. The last coherent owned checkpoint passed **31/31** and complete Core strict TypeScript.
After that evidence, the authority owner added the real engine-level catalog → create → duplicate →
delete RPC regression with a 120-second integration timeout. A final composed rerun was attempted,
but could not import Core because a concurrent Git/parity lane temporarily referenced an
undeclared `#forwardCompensatePublication` private method; no control-center assertion failed in
that attempt. The primary integrator owns the rerun after those Git lanes restore a coherent
compile. No provider, credential, Pi setting, live project/run, installed binary, process, terminal,
or cmux surface was mutated by this lane.

## Mailbox

Append interface answers, overlap questions, and release evidence below. Preserve earlier notes.
