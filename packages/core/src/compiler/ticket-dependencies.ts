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
    dependencies.set(definition.id, Object.freeze(conflicting.sort(compareUtf8)));
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
  return (
    ticketPriority(left) - ticketPriority(right) ||
    writePathSpecificity(right) - writePathSpecificity(left) ||
    compareUtf8(left.id, right.id)
  );
}

function ticketPriority(definition: DerivedTicketDefinition): number {
  return -(definition.rule_priority * 1_000 + definition.operation_dispatch_priority);
}

function writePathSpecificity(definition: DerivedTicketDefinition): number {
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
