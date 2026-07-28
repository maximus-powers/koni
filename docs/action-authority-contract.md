# Action Authority Contract

> Transition note (2026-07-18): the action catalog, authenticated plan, journal, and deterministic
> executor exist in `packages/core/src/compiler/action-recipes.ts`, but the generic authority host
> described here is not yet connected. The bounded Lead-judgment and report paths are purpose-built
> consumers. They do not establish complete generic action-recipe coverage. This document records
> the required integration boundary without rewriting the earlier compiler design.

Koni configuration may describe actions, but configuration is never effect authority. The TypeScript
authority selects an action from the exact `CompiledBehaviorIr` pinned to a run and is the only
component allowed to host its primitives.

## Invocation

1. The compiler or lifecycle authority chooses the selector from the pinned run behavior. A model,
   extension, operator payload, or stale UI capability cannot name an arbitrary catalog action.
2. The authority constructs a deterministic invocation identity from the run ID, pinned behavior and
   configuration identity, generation, and lifecycle boundary. When applicable, it also uses the
   ticket, step, and reconciliation cycle.
3. `prepareActionInvocation` resolves the selector, actor, checkout, ticket state, typed parameters,
   templates, recipe, compensation, and recovery against the pinned catalog. Its authenticated
   `ActionExecutionPlan` is immutable.
4. The plan and initial `ActionExecutionJournal` are persisted before the first primitive is issued.
   A process restart resumes only after `validateActionExecutionJournal` accepts the exact
   plan/catalog/action/context identity and ordered journal prefix.

The deterministic compile selector belongs at full reconciliation boundaries: after approved
initialization and after an accepted graph delta or integration boundary. Report belongs after the
post-orchestration verification product is frozen. Lead remains the separate one-shot qualitative
judgment seam. It does not schedule or execute recipes.

## Primitive host

`ActionPrimitiveHost.execute` receives the immutable invocation ID, plan hash, action/actor, recipe
phase, prepared step, context, and a stable effect key:

```text
<invocation-id>:<recipe|compensation>:<step-id>:<plan-sha256>
```

Before dispatch, the authority host must verify all of the following:

- The run still has the pinned configuration, behavior, generation, and expected lifecycle
  advancement/revision.
- The plan, action, catalog, and context hashes agree with the durable invocation.
- The run is neither deleted nor in a state that forbids a new effect. Pause prevents another
  primitive from starting and drains or aborts work according to the primitive's existing authority
  contract.
- Actor, checkout, ticket identity/state, graph revision, and Git binding still match.
- The primitive and arguments belong to the finite `ACTION_PRIMITIVE_SCHEMAS` ABI.
- The primitive maps to an existing Koni authority operation. It may not gain ambient shell,
  filesystem, Git, network, provider, or extension authority.

Every primitive delegates to the existing graph/compiler/ticket/check/Git/session authority. The
host durably records the effect key and canonical result before returning. A replay of the same
effect key returns that exact result without repeating the effect. A replay with different plan,
context, primitive, or arguments fails closed. Primitive result, authority state, receipt, and
operator activity should be one transaction wherever the underlying authority permits it.

`executeActionPlan` persists each journal transition before the next effect. A persistence failure
after an effect is reconciled through the same effect key. It is not treated as an instruction to
repeat the effect.

## Failure, recovery, and cancellation

Recipe failure enters compensation only through the authenticated journal. Compensation uses its own
phase-qualified effect keys and the same host checks. `recovery_required` is a terminal result for
this invocation: the authority may persist and schedule the configured recovery action as a new,
separately authenticated and bounded invocation. The executor must not recursively dispatch recovery
or create an unbounded action loop.

Run deletion aborts every associated session, rejects new primitive starts, and leaves no route to
further token or repository use. Pause is durable across restart and cannot be cleared merely by a
worker exit or scheduler reconciliation.

## Current deletion gate

Generic configured actions must not be advertised as executable until tests prove:

- Compiler-selected invocation at each supported boundary.
- Stale revision/generation and arbitrary-selector rejection.
- Effect-before-journal crash replay without duplicate effects.
- Compensation and separately scheduled recovery.
- Pause, deletion, and restart behavior.
- Exact primitive-to-authority dispatch with no ambient authority.
- `workflow.steps[].validation_action` execution at the intended validation boundary.

Until then, `actionSelectors.compile`, workflow `validation_action`, and generic recipe semantics
are compiled/prepared-only configuration. The bounded Lead and report implementations remain honest
purpose-specific exceptions.
