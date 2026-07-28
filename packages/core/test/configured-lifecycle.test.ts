import { describe, expect, it } from "vitest";
import {
  STATE_MACHINE_CATALOG_PROTOCOL,
  type CompiledStateMachine,
  type CompiledStateMachineCatalog,
  type CompiledStateTransition,
} from "../src/contracts/rules.js";
import {
  assertRuntimeLifecycleCatalog,
  authorizeConfiguredRunTransition,
  authorizeConfiguredTicketTransition,
  ConfiguredLifecycleError,
} from "../src/authority/configured-lifecycle.js";
import { canonicalHash, rawSha256 } from "../src/shared/canonical.js";
import { LEGACY_SOFTWARE_TICKET_LIFECYCLE_MACHINE_SHA256 } from "../src/contracts/historical-compatibility.js";

describe("configured durable lifecycle authority", () => {
  it("treats scheduler-only ticket movement as a no-op and authorizes semantic transitions", () => {
    const catalog = lifecycleCatalog();
    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "todo",
        to: "proposed",
        actor: "compiler",
      }).transition?.id,
    ).toBe("propose-change");
    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "proposed",
        to: "todo",
        actor: "compiler",
      }).transition?.id,
    ).toBe("approve-change");
    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "todo",
        to: "ready",
        actor: "compiler",
      }),
    ).toMatchObject({ changed: false, from: "todo", to: "todo" });

    const started = authorizeConfiguredTicketTransition(catalog, {
      from: "ready",
      to: "running",
      actor: "compiler",
    });
    expect(started).toMatchObject({ changed: true, from: "todo", to: "in_progress" });
    expect(started.transition?.id).toBe("start");

    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "running",
        to: "review",
        actor: "compiler",
      }).transition?.id,
    ).toBe("request-review");
    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "review",
        to: "completed",
        actor: "compiler",
      }).transition?.id,
    ).toBe("finish-reviewed");
  });

  it("fails closed when an actor or semantic ticket transition is not configured", () => {
    const catalog = lifecycleCatalog();
    expect(() =>
      authorizeConfiguredTicketTransition(catalog, {
        from: "ready",
        to: "running",
        actor: "human",
      }),
    ).toThrowError(ConfiguredLifecycleError);
    expect(() =>
      authorizeConfiguredTicketTransition(catalog, {
        from: "running",
        to: "completed",
        actor: "compiler",
      }),
    ).toThrow(/transition_not_configured/u);
  });

  it("reopens only the exact stock pre-reissue lifecycle for the compiler", () => {
    const legacy = legacySoftwareLifecycleCatalog();
    expect(legacy.machines.ticket?.machine_sha256).toBe(
      LEGACY_SOFTWARE_TICKET_LIFECYCLE_MACHINE_SHA256,
    );
    expect(
      authorizeConfiguredTicketTransition(legacy, {
        from: "completed",
        to: "ready",
        actor: "compiler",
      }),
    ).toMatchObject({
      changed: true,
      compatibility: "legacy_compiler_reissue",
      transition: { id: "compatibility-reopen-compiler-obligation" },
    });
    expect(() =>
      authorizeConfiguredTicketTransition(legacy, {
        from: "completed",
        to: "ready",
        actor: "human",
      }),
    ).toThrow(/actor_not_allowed|transition_not_configured/u);

    const ticket = legacy.machines.ticket!;
    const customized = catalogWith({
      ...legacy.machines,
      ticket: machine(ticket.id, ticket.initial, ticket.states, ticket.terminal_states, [
        ...ticket.transitions,
        transition("custom-noop", ["todo"], "todo", ["compiler"]),
      ]),
    });
    expect(() =>
      authorizeConfiguredTicketTransition(customized, {
        from: "completed",
        to: "ready",
        actor: "compiler",
      }),
    ).toThrow(/transition_not_configured/u);
  });

  it("maps pause, resume, conclusion, failure, and deletion onto the run machine", () => {
    const catalog = lifecycleCatalog();
    expect(
      authorizeConfiguredRunTransition(catalog, {
        from: "executing",
        to: "pausing",
        actor: "human",
      }).transition?.id,
    ).toBe("pause");
    expect(
      authorizeConfiguredRunTransition(catalog, {
        from: "paused",
        to: "executing",
        actor: "human",
      }).transition?.id,
    ).toBe("resume");
    expect(
      authorizeConfiguredRunTransition(catalog, {
        from: "merge_ready",
        to: "completed",
        actor: "compiler",
      }).transition?.id,
    ).toBe("conclude");
    expect(
      authorizeConfiguredRunTransition(catalog, {
        from: "planning",
        to: "failed",
        actor: "compiler",
      }).transition?.id,
    ).toBe("fail");
    expect(
      authorizeConfiguredRunTransition(catalog, {
        from: "blocked",
        to: "deleting",
        actor: "human",
      }).transition?.id,
    ).toBe("stop");
    expect(
      authorizeConfiguredRunTransition(catalog, {
        from: "planning",
        to: "awaiting_approval",
        actor: "compiler",
      }),
    ).toMatchObject({ changed: false, from: "active", to: "active" });
  });

  it("requires dedicated ticket and run machines with canonical initial states", () => {
    const catalog = lifecycleCatalog();
    const missingRun = catalogWith({ ticket: catalog.machines.ticket! });
    expect(() => assertRuntimeLifecycleCatalog(missingRun)).toThrow(/no run state machine/u);

    const wrongRun = machine("run", "draft", ["draft", "active"], [], []);
    expect(() =>
      assertRuntimeLifecycleCatalog(
        catalogWith({
          ticket: catalog.machines.ticket!,
          run: wrongRun,
        }),
      ),
    ).toThrow(/initialize durable runs as active/u);
  });
});

function lifecycleCatalog(): CompiledStateMachineCatalog {
  const ticketStates = [
    "proposed",
    "todo",
    "in_progress",
    "integrating",
    "blocked",
    "closed",
    "retired",
  ];
  const ticket = machine(
    "ticket",
    "todo",
    ticketStates,
    ["closed", "retired"],
    [
      transition("propose-change", ["todo"], "proposed", ["compiler"]),
      transition("approve-change", ["proposed"], "todo", ["compiler"]),
      transition("start", ["todo"], "in_progress", ["compiler"]),
      transition("request-review", ["in_progress"], "integrating", ["compiler"]),
      transition("review-failed", ["integrating"], "in_progress", ["compiler"]),
      transition("block-todo", ["todo"], "blocked", ["compiler"]),
      transition("block-active", ["in_progress", "integrating"], "blocked", ["compiler"]),
      transition("release", ["blocked"], "todo", ["compiler"]),
      transition("finish-reviewed", ["integrating"], "closed", ["compiler"]),
      transition("retire", ["todo", "in_progress", "integrating", "blocked"], "retired", [
        "compiler",
      ]),
    ],
  );
  const runStates = ["active", "paused", "concluded", "stopped", "failed"];
  const run = machine(
    "run",
    "active",
    runStates,
    ["concluded", "stopped", "failed"],
    [
      transition("pause", ["active"], "paused", ["human"]),
      transition("resume", ["paused"], "active", ["human"]),
      transition("conclude", ["active", "paused"], "concluded", ["compiler"]),
      transition("stop", ["active", "paused"], "stopped", ["human"]),
      transition("fail", ["active", "paused"], "failed", ["compiler"]),
    ],
  );
  return catalogWith({ ticket, run });
}

function legacySoftwareLifecycleCatalog(): CompiledStateMachineCatalog {
  const ticket = machine(
    "ticket",
    "todo",
    ["proposed", "todo", "in_progress", "integrating", "blocked", "closed", "retired"],
    ["closed", "retired"],
    [
      transition("propose-change", ["todo"], "proposed", ["lead", "compiler"]),
      transition("approve", ["proposed"], "todo", ["lead"]),
      transition("reject-proposal", ["proposed"], "closed", ["lead", "compiler"]),
      transition("start", ["todo"], "in_progress", ["lead", "compiler"]),
      transition("request-review", ["in_progress"], "integrating", ["lead", "compiler"]),
      transition("rework", ["integrating"], "in_progress", ["reviewer", "compiler"]),
      transition("block-todo", ["todo"], "blocked", ["compiler"]),
      transition("block-active", ["in_progress", "integrating"], "blocked", ["compiler"]),
      transition("release", ["blocked"], "todo", ["compiler", "lead"]),
      transition("interrupt-active", ["in_progress"], "todo", ["compiler"]),
      transition("finish", ["integrating", "in_progress"], "closed", ["compiler"]),
      transition("resolve-blocked", ["blocked"], "closed", ["compiler"]),
      transition("retire", ["proposed", "todo", "blocked"], "retired", ["compiler"]),
    ],
  );
  return catalogWith({ ticket, run: lifecycleCatalog().machines.run! });
}

function transition(
  id: string,
  from: readonly string[],
  to: string,
  actors: readonly string[],
): CompiledStateTransition {
  const material = { id, from: [...from], to, actors: [...actors] };
  return { ...material, transition_sha256: canonicalHash(material) };
}

function machine(
  id: string,
  initial: string,
  states: readonly string[],
  terminalStates: readonly string[],
  transitions: readonly CompiledStateTransition[],
): CompiledStateMachine {
  const material = {
    id,
    initial,
    states: [...states],
    terminal_states: [...terminalStates],
    transitions: [...transitions],
  };
  return { ...material, machine_sha256: canonicalHash(material) };
}

function catalogWith(
  machines: Readonly<Record<string, CompiledStateMachine>>,
): CompiledStateMachineCatalog {
  const material = {
    protocol: STATE_MACHINE_CATALOG_PROTOCOL,
    configuration_sha256: rawSha256("configuration"),
    machines,
  };
  return { ...material, catalog_sha256: canonicalHash(material) };
}
