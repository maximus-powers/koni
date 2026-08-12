import type { DerivedTicketDefinition, DerivedTicketScope } from "../contracts/rules.js";
import { compareUtf8 } from "../shared/canonical.js";
import {
  createProjectPathAuthority,
  type ProjectPathAuthority,
} from "../shared/project-path-authority.js";

export class TicketDependencyProjectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TicketDependencyProjectionError";
  }
}

export interface RetainedTicketDependencyProjection {
  id: string;
  priority: number;
  operationRegistryId: string;
  scope: DerivedTicketScope;
}

interface TicketDependencyProjection extends RetainedTicketDependencyProjection {}

/**
 * Project a stable, acyclic ticket dependency DAG from compiler-issued authority.
 *
 * Higher-ranked and more narrowly scoped tickets own conflicting authority first. A later ticket
 * records every conflicting predecessor rather than a transitive reduction: definitions are
 * reconciled incrementally, so a newly inserted predecessor must remain a direct durable barrier
 * even when an already-completed ticket now appears between the two in the projected order.
 */
export function deriveCompilerTicketDependencies(
  definitions: readonly DerivedTicketDefinition[],
  projectRoot: string,
  retained: readonly RetainedTicketDependencyProjection[] = [],
): ReadonlyMap<string, readonly string[]> {
  const pathAuthority = createProjectPathAuthority(projectRoot);
  const currentIds = new Set(definitions.map((definition) => definition.id));
  const projections: TicketDependencyProjection[] = [
    ...definitions.map((definition) => ({
      id: definition.id,
      priority: ticketPriority(definition),
      operationRegistryId: definition.operation_registry_id,
      scope: definition.scope,
    })),
    ...retained.filter((projection) => !currentIds.has(projection.id)),
  ];
  const ordering = orderTicketDefinitions(projections, pathAuthority);
  const ordered = ordering.ordered;
  const dependencies = new Map<string, readonly string[]>();
  for (const [index, definition] of ordered.entries()) {
    const conflicting: string[] = [];
    for (const predecessor of ordered.slice(0, index)) {
      let conflict: boolean;
      try {
        conflict = compilerScopesWriteConflictWith(
          pathAuthority,
          definition.scope,
          predecessor.scope,
        );
      } catch {
        throw new TicketDependencyProjectionError(
          `ticket ${definition.id} scope could not be compared safely with predecessor ${predecessor.id}`,
        );
      }
      if (conflict || ordering.predecessors.get(definition.id)!.has(predecessor.id)) {
        conflicting.push(predecessor.id);
      }
    }
    dependencies.set(definition.id, Object.freeze(conflicting.sort(compareUtf8)));
  }
  return dependencies;
}

/**
 * Keep runtime execution behind tickets that are still authoring its executable contract or
 * declared asset inputs.
 *
 * Rule priority normally provides the total order. A run can become superficially ready after the
 * first compile-run-plan step adds `runtime_contract.command`, though, while later steps still need
 * to bind scientific inputs and validate the result protocol. The run-experiment rule then has a
 * higher priority than the retained compile ticket and would otherwise launch against that partial
 * contract. Use a deterministic topological order so this semantic producer/consumer edge wins
 * without introducing pairwise-comparator cycles with unrelated tickets.
 */
function orderTicketDefinitions(
  definitions: readonly TicketDependencyProjection[],
  pathAuthority: ProjectPathAuthority,
): {
  ordered: TicketDependencyProjection[];
  predecessors: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const successors = new Map(definitions.map((definition) => [definition.id, new Set<string>()]));
  const predecessors = new Map(definitions.map((definition) => [definition.id, new Set<string>()]));
  const indegree = new Map(definitions.map((definition) => [definition.id, 0]));
  const compilers = definitions.filter(
    (definition) => definition.operationRegistryId === "execution.node.compile-run-plan",
  );
  const executions = definitions.filter(
    (definition) => definition.operationRegistryId === "execution.run.run-experiment",
  );
  const assetImplementations = definitions.filter(
    (definition) => definition.operationRegistryId === "asset-resolution.asset.implement-asset",
  );
  const gateRuns = definitions.filter(
    (definition) => definition.operationRegistryId === "gates.gate.run-gate",
  );
  const executionCompilers = new Map(executions.map((execution) => [execution.id, [] as string[]]));
  const addEdge = (predecessorId: string, successorId: string): void => {
    if (successors.get(predecessorId)!.has(successorId)) return;
    successors.get(predecessorId)!.add(successorId);
    predecessors.get(successorId)!.add(predecessorId);
    indegree.set(successorId, indegree.get(successorId)! + 1);
  };

  for (const compiler of compilers) {
    for (const execution of executions) {
      let conflict: boolean;
      try {
        conflict = compilerScopesWriteConflictWith(pathAuthority, compiler.scope, execution.scope);
      } catch {
        throw new TicketDependencyProjectionError(
          `ticket ${execution.id} scope could not be compared safely with predecessor ${compiler.id}`,
        );
      }
      if (!conflict) continue;
      addEdge(compiler.id, execution.id);
      executionCompilers.get(execution.id)!.push(compiler.id);
    }
  }

  // A fresh gate receipt is a compiler input. Compatibility gate-recheck tickets can be projected
  // with a lower synthetic rule priority than an already-retained run-plan repair; priority alone
  // would then invert the dependency and deadlock the gate behind the consumer that reads it.
  for (const gateRun of gateRuns) {
    for (const compiler of compilers) {
      if (!intersects(gateRun.scope.write_node_ids, compiler.scope.read_node_ids)) continue;
      addEdge(gateRun.id, compiler.id);
    }
  }

  for (const asset of assetImplementations) {
    // Asset implementation is also a direct input to run-plan compilation. During early graph
    // preparation the execution ticket may not exist yet, so routing this edge only through a
    // projected execution consumer reverses the ordinary priority conflict and deadlocks the
    // asset author behind the compiler that is waiting to bind it.
    for (const compiler of compilers) {
      if (!intersects(asset.scope.write_node_ids, compiler.scope.read_node_ids)) continue;
      addEdge(asset.id, compiler.id);
    }
    for (const execution of executions) {
      if (!intersects(asset.scope.write_node_ids, execution.scope.read_node_ids)) continue;
      addEdge(asset.id, execution.id);
      for (const compilerId of executionCompilers.get(execution.id)!) {
        addEdge(asset.id, compilerId);
      }
    }
  }

  const ordered: TicketDependencyProjection[] = [];
  const remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => indegree.get(id) === 0)
      .map((id) => byId.get(id)!)
      .sort(compareTicketDefinitions);
    const next = ready[0];
    if (next === undefined) {
      throw new TicketDependencyProjectionError("ticket preparation dependencies contain a cycle");
    }
    ordered.push(next);
    remaining.delete(next.id);
    for (const successor of successors.get(next.id)!) {
      indegree.set(successor, indegree.get(successor)! - 1);
    }
  }
  return { ordered, predecessors };
}

export function compilerScopesWriteConflict(
  projectRoot: string,
  left: DerivedTicketScope,
  right: DerivedTicketScope,
): boolean {
  return compilerScopesWriteConflictWith(createProjectPathAuthority(projectRoot), left, right);
}

function compilerScopesWriteConflictWith(
  pathAuthority: ProjectPathAuthority,
  left: DerivedTicketScope,
  right: DerivedTicketScope,
): boolean {
  if (
    intersects(left.write_node_ids, right.write_node_ids) ||
    intersects(left.write_node_ids, right.read_node_ids) ||
    intersects(left.read_node_ids, right.write_node_ids)
  )
    return true;
  for (const leftPath of left.write_paths) {
    for (const rightPath of [...right.write_paths, ...right.read_paths]) {
      if (pathAuthority.pathsOverlap(leftPath, rightPath)) return true;
    }
  }
  for (const leftPath of left.read_paths) {
    for (const rightPath of right.write_paths) {
      if (pathAuthority.pathsOverlap(leftPath, rightPath)) return true;
    }
  }
  return false;
}

function compareTicketDefinitions(
  left: TicketDependencyProjection,
  right: TicketDependencyProjection,
): number {
  return (
    left.priority - right.priority ||
    writePathSpecificity(right) - writePathSpecificity(left) ||
    compareUtf8(left.id, right.id)
  );
}

function ticketPriority(definition: DerivedTicketDefinition): number {
  return -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority);
}

function writePathSpecificity(definition: TicketDependencyProjection): number {
  if (definition.scope.write_paths.length === 0) return 0;
  return Math.min(
    ...definition.scope.write_paths.map(
      (value) => value.split(/[\\/]+/u).filter((segment) => segment.length > 0).length,
    ),
  );
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}
