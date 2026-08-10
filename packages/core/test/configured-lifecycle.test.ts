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

describe("configured durable lifecycle authority", () => {
  it("authorizes queued ticket lifecycle transitions", () => {
    const catalog = lifecycleCatalog();
    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "queued",
        to: "proposed",
        actor: "compiler",
      }).transition?.id,
    ).toBe("propose-change");
    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "proposed",
        to: "queued",
        actor: "compiler",
      }).transition?.id,
    ).toBe("approve-change");

    const started = authorizeConfiguredTicketTransition(catalog, {
      from: "queued",
      to: "running",
      actor: "compiler",
    });
    expect(started).toMatchObject({ changed: true, from: "queued", to: "in_progress" });
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
        from: "queued",
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

  it("reopens the configured queued lifecycle only for the compiler", () => {
    const catalog = lifecycleCatalog();
    expect(
      authorizeConfiguredTicketTransition(catalog, {
        from: "completed",
        to: "queued",
        actor: "compiler",
      }),
    ).toMatchObject({
      changed: true,
      transition: { id: "reopen-stale-obligation" },
    });
    expect(() =>
      authorizeConfiguredTicketTransition(catalog, {
        from: "completed",
        to: "queued",
        actor: "human",
      }),
    ).toThrow(/actor_not_allowed|transition_not_configured/u);
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

    const wrongTicket = machine("ticket", "legacy-waiting", ["legacy-waiting", "closed"], ["closed"], []);
    expect(() =>
      assertRuntimeLifecycleCatalog(
        catalogWith({
          ticket: wrongTicket,
          run: catalog.machines.run!,
        }),
      ),
    ).toThrow(/initialize durable work as queued/u);
  });
});

function lifecycleCatalog(): CompiledStateMachineCatalog {
  const ticketStates = [
    "proposed",
    "queued",
    "in_progress",
    "integrating",
    "blocked",
    "closed",
    "retired",
  ];
  const ticket = machine(
    "ticket",
    "queued",
    ticketStates,
    ["closed", "retired"],
    [
      transition("propose-change", ["queued"], "proposed", ["compiler"]),
      transition("approve-change", ["proposed"], "queued", ["compiler"]),
      transition("start", ["queued"], "in_progress", ["compiler"]),
      transition("request-review", ["in_progress"], "integrating", ["compiler"]),
      transition("review-failed", ["integrating"], "in_progress", ["compiler"]),
      transition("block-queued", ["queued"], "blocked", ["compiler"]),
      transition("block-active", ["in_progress", "integrating"], "blocked", ["compiler"]),
      transition("release", ["blocked"], "queued", ["compiler"]),
      transition("reopen-stale-obligation", ["closed"], "queued", ["compiler"]),
      transition("finish-reviewed", ["integrating"], "closed", ["compiler"]),
      transition("retire", ["queued", "in_progress", "integrating", "blocked"], "retired", [
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
