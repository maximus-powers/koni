# Sealed Pi-native model catalog

## 2026-07-16 — lease

Owned by `sealed_model_catalog/root`.

Scope:

- derive one read-only, offline catalog from a fresh Pi `ModelRuntime` using Pi's normal credential
  and `models.json` paths;
- intersect the interactive `/koni` registry with that contained-runtime inventory;
- make unsupported ambient extension-only models visible but unavailable with a concise reason;
- use the same projection for standalone `koni tui`;
- add focused adversarial `registerProvider` and surface-parity tests;
- append current-state supersession notes for linear attempt sessions and two-phase admission.

Explicit exclusions: compiler context assembly, run-program prompt/context construction, resource
selection or binding, compaction, any live Pi state/credential/project/binary/process/terminal
mutation, and serialization or loading of ambient provider functions into the contained child.

## Coordination

The context-building experiment retains exclusive ownership of all context and resource-binding
semantics. This lane will consume only Pi's public model/runtime APIs and control-center protocol.

## 2026-07-16 — moving-tree typecheck observation

This lane's `control-center/component.ts` narrowing diagnostic is fixed and the complete Core
strict typecheck passed at the 38/38 focused checkpoint. A later serialized rerun is currently
blocked by a new, unrelated concurrent edit in `src/profile/run-adoption.ts:192`: the returned
object makes `barrier` optional while `LoadedLegacyRunMigrationEvidence` requires it. This lane
does not own or edit legacy-run adoption. Focused tests and scoped diff checks continue independently;
the owner of that profile/migration edit should restore the shared typecheck before final release.

## 2026-07-16 — implementation handoff

The lease is complete and released to `pi-native-port/root`.

- `pi/model-catalog.ts` creates one fresh `ModelRuntime` with network model refresh disabled while
  retaining Pi's ordinary credential, `models.json`, and cache paths.
- Both standalone and `/koni` take selectable model identity/availability from that same contained
  runtime projection. `/koni` adds ambient-only registry entries solely as unavailable diagnostics.
- A provider registered through the interactive `ModelRegistry.registerProvider()` remains absent
  from the fresh runtime; its function is neither serialized nor invoked.
- New Run and guided configuration never cycle onto unavailable entries. A configured unavailable
  default remains legible with its reason, and starting the run fails before `run.create`.
- Current autonomous sessions are documented as fresh linear sessions with authenticated
  parent-attempt lineage; historical in-session branch-epoch design is explicitly superseded.
- Two-phase admission now claims only no provider turn/token spend before activation. Pi-owned
  credential/model initialization before ready remains permitted and documented.

Evidence: focused catalog/operator/control-center tests **39/39**; scoped whitespace green. The
complete Core strict typecheck was green after this lane's changes and before the unrelated active
legacy-adoption diagnostic recorded above. The offline-runtime sentinel observes zero requests to
an adversarial catalog endpoint and byte-identical `auth.json`/`models.json` after initialization.

## 2026-07-16 — P1 closure lease

Owned by `sealed_catalog_p1_fixes/root` after independent review found three release blockers.

This bounded follow-up owns the sealed model-catalog projection and admission helper, New Run
model/reasoning controls, Pi extension host gate, and the minimum CLI/operator/bootstrap wiring
needed to make `/koni`, `koni run`, and the shared dashboard enforce one contract. It will:

- reject unavailable configured defaults before `run.create` on every operator surface;
- carry Pi 0.80.10's per-model `thinkingLevelMap` support into the UI, preserve invalid configured
  defaults as visible blockers, and never let a selector create a clamped attempt;
- authenticate the exact Pi 0.80.10 + TypeBox host before reusing an existing authority, matching
  the standalone launcher gate.

The active legacy-adoption lane currently owns `cli.ts`, `operator/authority-bootstrap.ts`, and
`operator-surface.test.ts`; patches there wait for its explicit freeze and preserve all adoption
commands. Compiler context assembly, run-program prompt/context construction, resource
selection/binding, compaction, live Pi state, credentials, projects, installed binaries, and
processes remain excluded.

## 2026-07-16 — P1 closure handoff

The follow-up lease is complete and released to `pi-native-port/root`.

- `ControlModelOption` now carries the exact ordered reasoning choices derived from each sealed
  Pi model's `thinkingLevelMap`, using Pi 0.80.10's null/default/xhigh/max rules. Non-reasoning
  models expose only `off`.
- New Run and guided configuration cycle only those per-model choices. Changing models clamps the
  draft locally to a supported visible choice; an invalid project-authored default is not silently
  rewritten and instead renders a warning and blocks launch.
- One shared admission helper rejects missing/unavailable models and unsupported reasoning before
  `run.create`. The Pi guided command, shell `koni run` wrapper, and shared dashboard all call it.
- `/koni` authenticates the exact Pi 0.80.10 + TypeBox 1.1.38 host at session start and again before
  non-stop commands. `ensureProjectAuthority()` authenticates that same peer before its first
  connection attempt, including the existing-authority reuse fast path. Read-only status and the
  compatibility stop path retain their intended no-start/quiesce behavior.
- Focused provider-free regressions prove unavailable CLI and interactive defaults issue no
  `run.create` (interactive admission also stops before branch lookup), invalid dashboard reasoning
  remains visible and non-mutating, a bad interactive host shuts Pi down, and both first-start and
  reuse authenticate the host.

Evidence on the shared source: strict Core TypeScript **green**; catalog/control-center/operator
suite **45/45**; scoped `git diff --check` **green**. No context-building, run-program,
resource-binding, compaction, legacy-adoption, live Pi/user state, credential, project, binary, or
process surface was changed.
