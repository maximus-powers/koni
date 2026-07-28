import { MAX_MONITOR_EVENTS, MAX_MONITOR_RUNS } from "../monitor/protocol.js";
import type { JsonValue } from "./protocol.js";
import {
  projectMonitorAttention,
  projectMonitorEvents,
  projectMonitorSnapshotFromPage,
} from "./monitor-projection.js";
import type { ProjectAuthorityStore } from "./project-store.js";
import { AuthorityRpcError, type AuthorityServer } from "./server.js";

/** Register the bounded, read-only half of the Pi companion authority contract. */
export function registerMonitorAuthorityMethods(
  server: AuthorityServer,
  store: ProjectAuthorityStore,
): void {
  server.register("monitor.snapshot", {
    mutating: false,
    handle: async ({ request }) => {
      const limit = optionalBoundedInteger(request.params, "limit", 50, 1, MAX_MONITOR_RUNS);
      const snapshot = await store.readConsistently(async () => {
        const state = await store.state();
        const page = await store.runSummaryPage({ limit });
        return projectMonitorSnapshotFromPage(state, page);
      });
      return { result: snapshot as unknown as JsonValue };
    },
  });
  server.register("monitor.events", {
    mutating: false,
    handle: async ({ request }) => {
      const after = optionalBoundedInteger(request.params, "after", 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalBoundedInteger(request.params, "limit", 200, 1, MAX_MONITOR_EVENTS);
      try {
        return {
          result: projectMonitorEvents(await store.state(), after, limit) as unknown as JsonValue,
        };
      } catch (error) {
        throw new AuthorityRpcError(
          "monitor_cursor",
          error instanceof Error ? error.message : "monitor event cursor is invalid",
        );
      }
    },
  });
  server.register("monitor.attention", {
    mutating: false,
    handle: async ({ request }) => {
      const runId = requiredString(request.params, "runId");
      const run = await store.getRun(runId);
      if (run.lifecycle.phase === "deleted") {
        throw new AuthorityRpcError(
          "run_deleted",
          "deleted runs have no pending operator attention",
        );
      }
      return { result: projectMonitorAttention(run) as unknown as JsonValue };
    },
  });
}

function paramsRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthorityRpcError("invalid_params", "request parameters must be an object");
  }
  return value;
}

function requiredString(value: JsonValue | undefined, key: string): string {
  const candidate = paramsRecord(value)[key];
  if (typeof candidate !== "string" || candidate.length === 0 || [...candidate].length > 256) {
    throw new AuthorityRpcError("invalid_params", `${key} must be a bounded non-empty string`);
  }
  return candidate;
}

function optionalBoundedInteger(
  value: JsonValue | undefined,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = paramsRecord(value)[key];
  if (candidate === undefined) return fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    Number(candidate) < minimum ||
    Number(candidate) > maximum
  ) {
    throw new AuthorityRpcError(
      "invalid_params",
      `${key} must be between ${minimum} and ${maximum}`,
    );
  }
  return Number(candidate);
}
