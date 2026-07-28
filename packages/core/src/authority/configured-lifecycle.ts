import type {
  CompiledStateMachine,
  CompiledStateMachineCatalog,
  CompiledStateTransition,
} from "../contracts/rules.js";
import {
  LEGACY_RESEARCH_TICKET_LIFECYCLE_MACHINE_SHA256,
  LEGACY_SOFTWARE_TICKET_LIFECYCLE_MACHINE_SHA256,
} from "../contracts/historical-compatibility.js";
import { authorizeStateTransition } from "../compiler/rules.js";
import { canonicalHash } from "../shared/canonical.js";
import type { RunPhase } from "../state/run-lifecycle.js";
import type { TicketStatus } from "../state/run-record.js";

export const CONFIGURED_LIFECYCLE_AUTHORIZATION_PROTOCOL =
  "koni.configured-lifecycle-authorization.v1" as const;

export type ConfiguredLifecycleActor = "human" | "compiler" | string;

export type ConfiguredLifecycleAuthorization = Readonly<{
  protocol: typeof CONFIGURED_LIFECYCLE_AUTHORIZATION_PROTOCOL;
  machineId: "ticket" | "run";
  from: string;
  to: string;
  actor: ConfiguredLifecycleActor;
  /** Internal status changes that retain one configured state need no configured transition. */
  changed: boolean;
  transition?: CompiledStateTransition;
  /** Exact stock-profile compatibility correction; never available to customized machines. */
  compatibility?: "legacy_compiler_reissue";
}>;

export class ConfiguredLifecycleError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ConfiguredLifecycleError";
    this.code = code;
  }
}

/**
 * Verify that a profile can govern the two durable lifecycle domains owned by run authority.
 * Gate and research machines govern graph/compiler state and intentionally cannot substitute for
 * these records.
 */
export function assertRuntimeLifecycleCatalog(
  catalog: CompiledStateMachineCatalog,
): Readonly<{ ticket: CompiledStateMachine; run: CompiledStateMachine }> {
  const ticket = catalog.machines.ticket;
  const run = catalog.machines.run;
  if (ticket === undefined) {
    throw new ConfiguredLifecycleError(
      "lifecycle.ticket_machine_missing",
      "compiled profile has no ticket state machine for durable ticket authority",
    );
  }
  if (run === undefined) {
    throw new ConfiguredLifecycleError(
      "lifecycle.run_machine_missing",
      "compiled profile has no run state machine for durable run authority",
    );
  }
  if (ticket.initial !== "todo") {
    throw new ConfiguredLifecycleError(
      "lifecycle.ticket_initial",
      `ticket state machine must initialize durable work as todo, not ${ticket.initial}`,
    );
  }
  if (run.initial !== "active") {
    throw new ConfiguredLifecycleError(
      "lifecycle.run_initial",
      `run state machine must initialize durable runs as active, not ${run.initial}`,
    );
  }
  return Object.freeze({ ticket, run });
}

/** Map the richer scheduler status vocabulary onto the configured semantic ticket lifecycle. */
export function configuredTicketState(machine: CompiledStateMachine, status: TicketStatus): string {
  switch (status) {
    case "proposed":
      return "proposed";
    case "todo":
    case "ready":
      return "todo";
    case "running":
      return "in_progress";
    case "review":
      return "integrating";
    case "blocked":
    case "failed":
      return "blocked";
    case "completed":
      return "closed";
    case "cancelled":
      return machine.states.includes("retired") ? "retired" : "closed";
  }
}

/** Map fine-grained operator phases onto the configured durable run lifecycle. */
export function configuredRunState(phase: RunPhase): string {
  switch (phase) {
    case "pausing":
    case "paused":
      return "paused";
    case "completed":
      return "concluded";
    case "failed":
      return "failed";
    case "deleting":
    case "deleted":
      return "stopped";
    case "draft":
    case "planning":
    case "awaiting_questions":
    case "awaiting_approval":
    case "approving":
    case "executing":
    case "verifying":
    case "merge_ready":
    case "merging":
    case "blocked":
      return "active";
  }
}

export function authorizeConfiguredTicketTransition(
  catalog: CompiledStateMachineCatalog,
  input: Readonly<{ from: TicketStatus; to: TicketStatus; actor: ConfiguredLifecycleActor }>,
): ConfiguredLifecycleAuthorization {
  const machine = assertRuntimeLifecycleCatalog(catalog).ticket;
  const projected = {
    machineId: "ticket",
    from: configuredTicketState(machine, input.from),
    to: configuredTicketState(machine, input.to),
    actor: input.actor,
  } as const;
  if (projected.from === projected.to) {
    return Object.freeze({
      protocol: CONFIGURED_LIFECYCLE_AUTHORIZATION_PROTOCOL,
      ...projected,
      changed: false,
    });
  }
  const authorization = authorizeStateTransition(catalog, projected);
  if (authorization.allowed) {
    return Object.freeze({
      protocol: CONFIGURED_LIFECYCLE_AUTHORIZATION_PROTOCOL,
      ...projected,
      changed: true,
      transition: authorization.transition,
    });
  }
  if (
    authorization.reason === "transition_not_configured" &&
    projected.from === "closed" &&
    projected.to === "todo" &&
    projected.actor === "compiler" &&
    LEGACY_REISSUE_MACHINE_SHA256S.has(machine.machine_sha256)
  ) {
    const material = {
      id: "compatibility-reopen-compiler-obligation",
      from: ["closed"],
      to: "todo",
      actors: ["compiler"],
    } as const;
    return Object.freeze({
      protocol: CONFIGURED_LIFECYCLE_AUTHORIZATION_PROTOCOL,
      ...projected,
      changed: true,
      transition: Object.freeze({ ...material, transition_sha256: canonicalHash(material) }),
      compatibility: "legacy_compiler_reissue",
    });
  }
  throw new ConfiguredLifecycleError(
    `lifecycle.${authorization.reason}`,
    `${projected.actor} may not move configured ${projected.machineId} lifecycle from ${projected.from} to ${projected.to}: ${authorization.reason}`,
  );
}

export function authorizeConfiguredRunTransition(
  catalog: CompiledStateMachineCatalog,
  input: Readonly<{ from: RunPhase; to: RunPhase; actor: ConfiguredLifecycleActor }>,
): ConfiguredLifecycleAuthorization {
  assertRuntimeLifecycleCatalog(catalog);
  return authorizeConfiguredTransition(catalog, {
    machineId: "run",
    from: configuredRunState(input.from),
    to: configuredRunState(input.to),
    actor: input.actor,
  });
}

function authorizeConfiguredTransition(
  catalog: CompiledStateMachineCatalog,
  input: Readonly<{
    machineId: "ticket" | "run";
    from: string;
    to: string;
    actor: ConfiguredLifecycleActor;
  }>,
): ConfiguredLifecycleAuthorization {
  if (input.from === input.to) {
    return Object.freeze({
      protocol: CONFIGURED_LIFECYCLE_AUTHORIZATION_PROTOCOL,
      ...input,
      changed: false,
    });
  }
  const authorization = authorizeStateTransition(catalog, input);
  if (!authorization.allowed) {
    throw new ConfiguredLifecycleError(
      `lifecycle.${authorization.reason}`,
      `${input.actor} may not move configured ${input.machineId} lifecycle from ${input.from} to ${input.to}: ${authorization.reason}`,
    );
  }
  return Object.freeze({
    protocol: CONFIGURED_LIFECYCLE_AUTHORIZATION_PROTOCOL,
    ...input,
    changed: true,
    transition: Object.freeze(structuredClone(authorization.transition)),
  });
}

const LEGACY_REISSUE_MACHINE_SHA256S = new Set<string>([
  LEGACY_SOFTWARE_TICKET_LIFECYCLE_MACHINE_SHA256,
  LEGACY_RESEARCH_TICKET_LIFECYCLE_MACHINE_SHA256,
]);
