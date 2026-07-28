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

/**
 * Project a stable, acyclic ticket dependency DAG from compiler-issued write authority.
 *
 * Higher-ranked tickets own a conflicting scope first. A later ticket waits on the closest
 * conflicting predecessors; transitively implied predecessors are removed to keep the durable
 * graph meaningful rather than recording a dense all-pairs ordering.
 */
export function deriveCompilerTicketDependencies(
  definitions: readonly DerivedTicketDefinition[],
  projectRoot: string,
): ReadonlyMap<string, readonly string[]> {
  const ordered = [...definitions].sort(compareTicketDefinitions);
  const pathAuthority = createProjectPathAuthority(projectRoot);
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
      if (conflict) conflicting.push(predecessor.id);
    }
    const direct = conflicting.filter(
      (candidate) =>
        !conflicting.some(
          (other) => other !== candidate && transitivelyDependsOn(other, candidate, dependencies),
        ),
    );
    dependencies.set(definition.id, Object.freeze(direct.sort(compareUtf8)));
  }
  return dependencies;
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
  left: DerivedTicketDefinition,
  right: DerivedTicketDefinition,
): number {
  return ticketPriority(left) - ticketPriority(right) || compareUtf8(left.id, right.id);
}

function ticketPriority(definition: DerivedTicketDefinition): number {
  return -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority);
}

function transitivelyDependsOn(
  source: string,
  target: string,
  dependencies: ReadonlyMap<string, readonly string[]>,
): boolean {
  const pending = [...(dependencies.get(source) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (candidate === target) return true;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    pending.push(...(dependencies.get(candidate) ?? []));
  }
  return false;
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}
