import { satisfies, valid, validRange } from "semver";
import type {
  CompiledConfiguration,
  ConfigurationObject,
  ConfigurationValue,
} from "../contracts/configuration.js";
import type {
  CompilerGraphNode,
  CompilerGraphProjection,
  DerivationKind,
} from "../contracts/rules.js";
import {
  canonicalEncode,
  canonicalHash,
  compareUtf8,
  type Sha256Digest,
} from "../shared/canonical.js";
import { pointer } from "../shared/diagnostics.js";

const PURE_PREDICATE_OPERATORS = new Set([
  "always",
  "edge_count",
  "incoming_count",
  "field_equals",
  "field_in",
  "field_present",
  "query_count",
  "coverage",
  "status_is",
  "node_type_is",
  "acyclic",
  "set_relation",
  "semver_compatible",
  "obligation_exists",
  "stage_is",
]);

const DOMAIN_PREDICATE_OPERATORS = new Set([
  "current_receipt",
  "receipt_coverage_current",
  "review_effect_coverage_current",
  "filesystem_manifest_current",
  "check_passed",
  "check_has_current_terminal",
  "proof_preparation_current",
  "path_exists",
  "gate_policy_compatible",
  "gate_policy_has_selection",
  "gate_policy_selected",
  "gate_policy_candidate_count",
  "gate_policy_satisfied",
  "gate_policy_command_available",
  "gate_policy_execution_ready",
  "gate_policy_has_current_terminal",
  "gate_policy_evaluation_targets_ready",
]);

const DERIVATION_KINDS = new Set<DerivationKind>([
  "obligation",
  "projection",
  "readiness",
  "program_state",
  "gate_request",
  "check_request",
  "barrier",
  "warning",
]);

export class ExpressionEvaluationError extends Error {
  public readonly code: string;
  public readonly path: string;

  public constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "ExpressionEvaluationError";
    this.code = code;
    this.path = path;
  }
}

export interface RuleDomainContext {
  readonly configuration: CompiledConfiguration;
  readonly graph_sha256: Sha256Digest;
  readonly bindings: Readonly<Record<string, readonly string[]>>;
  readonly subject?: CompilerGraphNode;
  select(selector: ConfigurationValue): readonly string[];
  node(id: string): CompilerGraphNode | undefined;
  evaluate(predicate: ConfigurationValue): boolean;
  withBinding<Value>(name: string, ids: readonly string[], evaluate: () => Value): Value;
}

export interface RuleDomainAdapter {
  /** Return undefined when the adapter does not implement this policy selector. */
  selectPolicy?(
    selector: ConfigurationObject,
    context: RuleDomainContext,
  ): readonly string[] | undefined;
  /** Return undefined when the adapter does not implement this domain leaf. */
  evaluatePredicate?(leaf: ConfigurationObject, context: RuleDomainContext): boolean | undefined;
}

interface MutableGraphNode {
  id: string;
  type: string;
  title: string;
  status: string;
  spec: MutableConfigurationObject;
  edges: Record<string, string[]>;
  annotations?: MutableConfigurationObject;
  fields: MutableConfigurationObject;
}

type MutableConfigurationValue =
  null | boolean | number | string | MutableConfigurationObject | MutableConfigurationValue[];

interface MutableConfigurationObject {
  [key: string]: MutableConfigurationValue;
}

type TraversalDirection = "outgoing" | "incoming" | "both";

/**
 * Deterministic expression VM over one copied graph epoch.
 *
 * The VM owns its graph copy so caller mutation cannot change a compile after
 * hashing has begun. Derivation projection methods intentionally update only
 * this private epoch, matching the Rust compiler's sequential derivation pass.
 */
export class GraphExpressionEvaluator {
  readonly #configuration: CompiledConfiguration;
  readonly #adapter: RuleDomainAdapter | undefined;
  readonly #nodes = new Map<string, MutableGraphNode>();
  readonly #bindings = new Map<string, string[]>();
  readonly #queryStack: string[] = [];
  readonly #inverseRelations = new Map<string, string[]>();
  readonly #nodeStages = new Map<string, string>();
  readonly #inputGraphSha256: Sha256Digest;

  public constructor(
    configuration: CompiledConfiguration,
    graph: CompilerGraphProjection,
    adapter?: RuleDomainAdapter,
  ) {
    this.#configuration = configuration;
    this.#adapter = adapter;
    for (const [index, source] of graph.nodes().entries()) {
      const path = pointer("/graph/nodes", index);
      const node = snapshotNode(source, path);
      if (this.#nodes.has(node.id)) {
        fail(
          "expression.duplicate_node",
          pointer(path, "id"),
          `graph node id is duplicated: ${node.id}`,
        );
      }
      this.#nodes.set(node.id, node);
    }
    this.#validateGraphEdges();
    this.#compileEdgeSemantics();
    for (const [id, definition] of Object.entries(configuration.registries.node_types)) {
      if (typeof definition.stage === "string") {
        this.#nodeStages.set(id, definition.stage);
      }
    }
    this.#inputGraphSha256 = canonicalHash(this.#graphMaterial());
  }

  public get inputGraphSha256(): Sha256Digest {
    return this.#inputGraphSha256;
  }

  public get graphSha256(): Sha256Digest {
    return canonicalHash(this.#graphMaterial());
  }

  public nodes(): readonly CompilerGraphNode[] {
    return [...this.#nodes.values()]
      .sort((left, right) => compareUtf8(left.id, right.id))
      .map((node) => publicNode(node));
  }

  public node(id: string): CompilerGraphNode | undefined {
    const node = this.#nodes.get(id);
    return node === undefined ? undefined : publicNode(node);
  }

  public bind(name: string, ids: readonly string[], path = "/bindings"): void {
    const normalized = normalizeBindingName(name, path);
    const selected = uniqueSortedStrings(ids, path);
    for (const id of selected) {
      if (!this.#nodes.has(id)) {
        fail(
          "expression.missing_node",
          path,
          `binding ${normalized} references missing node ${id}`,
        );
      }
    }
    this.#bindings.set(normalized, selected);
  }

  public withBinding<Value>(
    name: string,
    ids: readonly string[],
    evaluate: () => Value,
    path = "/bindings",
  ): Value {
    const normalized = normalizeBindingName(name, path);
    const selected = uniqueSortedStrings(ids, path);
    for (const id of selected) {
      if (!this.#nodes.has(id)) {
        fail(
          "expression.missing_node",
          path,
          `binding ${normalized} references missing node ${id}`,
        );
      }
    }
    return this.#withBinding(normalized, selected, evaluate);
  }

  public select(selector: ConfigurationValue, path = "/selector"): readonly string[] {
    if (typeof selector === "string") {
      return this.#selectNamed(selector, path);
    }
    const envelope = record(selector, path, "selector must be a string or mapping");
    const keys = Object.keys(envelope);
    if (keys.length !== 1) {
      fail(
        "expression.selector_shape",
        path,
        "selector mapping must contain exactly one selector operator",
      );
    }
    const kind = keys[0]!;
    switch (kind) {
      case "variable": {
        const variable = stringValue(envelope.variable, pointer(path, "variable"));
        return this.#bound(variable, path);
      }
      case "ids": {
        const ids = stringArray(required(envelope, "ids", path), pointer(path, "ids"));
        for (const id of ids) {
          if (!this.#nodes.has(id)) {
            fail(
              "expression.missing_node",
              pointer(path, "ids"),
              `ids selector references missing node ${id}`,
            );
          }
        }
        return uniqueSortedStrings(ids, pointer(path, "ids"));
      }
      case "nodes":
        return this.#selectNodes(required(envelope, "nodes", path), pointer(path, "nodes"));
      case "query":
        return this.#selectQueryEnvelope(required(envelope, "query", path), pointer(path, "query"));
      case "traverse":
        return this.#selectTraverse(
          required(envelope, "traverse", path),
          pointer(path, "traverse"),
        );
      case "union": {
        const selectors = nonemptyArray(envelope.union, pointer(path, "union"));
        const output = new Set<string>();
        for (const [index, child] of selectors.entries()) {
          for (const id of this.select(child, pointer(pointer(path, "union"), index)))
            output.add(id);
        }
        return sortedSet(output);
      }
      case "intersection": {
        const selectors = nonemptyArray(envelope.intersection, pointer(path, "intersection"));
        let output = new Set(this.select(selectors[0]!, pointer(pointer(path, "intersection"), 0)));
        for (let index = 1; index < selectors.length; index += 1) {
          const right = new Set(
            this.select(selectors[index]!, pointer(pointer(path, "intersection"), index)),
          );
          output = new Set([...output].filter((id) => right.has(id)));
        }
        return sortedSet(output);
      }
      case "difference": {
        const difference = exactRecord(
          required(envelope, "difference", path),
          pointer(path, "difference"),
          ["left", "right"],
        );
        const left = new Set(
          this.select(
            required(difference, "left", path),
            pointer(pointer(path, "difference"), "left"),
          ),
        );
        const right = new Set(
          this.select(
            required(difference, "right", path),
            pointer(pointer(path, "difference"), "right"),
          ),
        );
        return sortedSet(new Set([...left].filter((id) => !right.has(id))));
      }
      case "policy_selection":
      case "policy_applicability":
        return this.#selectPolicy(envelope, path);
      default:
        fail("expression.unknown_selector", path, `unknown selector operator ${kind}`);
    }
  }

  public evaluate(predicate: ConfigurationValue, path = "/predicate"): boolean {
    if (typeof predicate === "boolean") return predicate;
    const envelope = record(predicate, path, "predicate must be a boolean or mapping");
    if (Object.hasOwn(envelope, "all")) {
      exactKeys(envelope, path, ["all"]);
      const predicates = nonemptyArray(envelope.all, pointer(path, "all"));
      for (const [index, child] of predicates.entries()) {
        if (!this.evaluate(child, pointer(pointer(path, "all"), index))) return false;
      }
      return true;
    }
    if (Object.hasOwn(envelope, "any")) {
      exactKeys(envelope, path, ["any"]);
      const predicates = nonemptyArray(envelope.any, pointer(path, "any"));
      for (const [index, child] of predicates.entries()) {
        if (this.evaluate(child, pointer(pointer(path, "any"), index))) return true;
      }
      return false;
    }
    if (Object.hasOwn(envelope, "not")) {
      exactKeys(envelope, path, ["not"]);
      return !this.evaluate(envelope.not!, pointer(path, "not"));
    }
    if (Object.hasOwn(envelope, "for_all")) {
      exactKeys(envelope, path, ["for_all"]);
      const quantified = exactRecord(
        required(envelope, "for_all", path),
        pointer(path, "for_all"),
        ["select", "bind", "satisfies"],
        ["select", "satisfies"],
      );
      const selected = this.select(quantified.select!, pointer(pointer(path, "for_all"), "select"));
      const binding =
        optionalString(quantified.bind, pointer(pointer(path, "for_all"), "bind")) ?? "node";
      for (const id of selected) {
        const passed = this.#withBinding(binding, [id], () =>
          this.evaluate(quantified.satisfies!, pointer(pointer(path, "for_all"), "satisfies")),
        );
        if (!passed) return false;
      }
      return true;
    }
    if (Object.hasOwn(envelope, "exists")) {
      exactKeys(envelope, path, ["exists"]);
      return this.select(envelope.exists!, pointer(path, "exists")).length > 0;
    }
    return this.#evaluateLeaf(envelope, path);
  }

  public materializeDerivation(
    anchorNodeId: string,
    kind: DerivationKind,
    derivation: ConfigurationObject,
    ruleId: string,
    programState: Record<string, ConfigurationValue>,
    path: string,
  ): void {
    if (!DERIVATION_KINDS.has(kind)) {
      fail("rule.derivation_kind", pointer(path, "kind"), `unsupported derivation kind ${kind}`);
    }
    if (kind === "program_state") {
      const field = optionalString(derivation.field, pointer(path, "field"));
      if (field !== undefined && derivation.value !== undefined) {
        setValuePath(
          programState as unknown as MutableConfigurationObject,
          field,
          cloneValue(derivation.value),
          path,
        );
      }
      return;
    }
    const node = this.#nodes.get(anchorNodeId);
    if (node === undefined) return;
    const reason = optionalString(derivation.reason, pointer(path, "reason"));
    const key = optionalString(derivation.key, pointer(path, "key"));
    switch (kind) {
      case "obligation": {
        const obligations = mutableRecordAt(node.fields, "obligations");
        const unmet = mutableArrayAt(obligations, "unmet");
        unmet.push(
          compactObject({
            key,
            severity: optionalString(derivation.severity, pointer(path, "severity")) ?? "blocking",
            reason,
            rule: ruleId,
          }),
        );
        break;
      }
      case "readiness":
        node.fields.readiness = compactObject({
          state: derivation.value === undefined ? "blocked" : cloneValue(derivation.value),
          reason,
          rule: ruleId,
        });
        break;
      case "projection": {
        const field = optionalString(derivation.field, pointer(path, "field"));
        if (field !== undefined && derivation.value !== undefined) {
          const compiler = mutableRecordAt(node.fields, "compiler");
          setValuePath(compiler, field, cloneValue(derivation.value), path);
        }
        break;
      }
      case "warning":
      case "barrier":
      case "gate_request":
      case "check_request": {
        const collection = `${kind}s`;
        mutableArrayAt(node.fields, collection).push(compactObject({ key, reason, rule: ruleId }));
        break;
      }
    }
  }

  public field(nodeId: string, field: string): ConfigurationValue | undefined {
    const node = this.#nodes.get(nodeId);
    return node === undefined ? undefined : cloneOptional(this.#fieldValue(node, field));
  }

  #selectNamed(name: string, path: string): readonly string[] {
    if (name.startsWith("$")) return this.#bound(name, path);
    if (Object.hasOwn(this.#configuration.registries.queries, name))
      return this.#selectQuery(name, path);
    if (Object.hasOwn(this.#configuration.registries.node_types, name)) {
      return [...this.#nodes.values()]
        .filter((node) => node.type === name)
        .map((node) => node.id)
        .sort(compareUtf8);
    }
    fail("expression.unknown_selector", path, `unknown selector, query, or node type ${name}`);
  }

  #bound(name: string, path: string): readonly string[] {
    const normalized = normalizeBindingName(name, path);
    const ids = this.#bindings.get(normalized);
    if (ids === undefined) {
      fail(
        "expression.unknown_binding",
        path,
        `selector references unbound variable $${normalized}`,
      );
    }
    return [...ids];
  }

  #selectNodes(value: ConfigurationValue, path: string): readonly string[] {
    const filter = exactRecord(value, path, [
      "node_types",
      "statuses",
      "status_excluding",
      "where",
    ]);
    const types = optionalStringArray(filter.node_types, pointer(path, "node_types"));
    const statuses = optionalStringArray(filter.statuses, pointer(path, "statuses"));
    const excluded = optionalStringArray(
      filter.status_excluding,
      pointer(path, "status_excluding"),
    );
    const output: string[] = [];
    for (const node of [...this.#nodes.values()].sort((left, right) =>
      compareUtf8(left.id, right.id),
    )) {
      if (types.length > 0 && !types.includes(node.type)) continue;
      if (statuses.length > 0 && !statuses.includes(node.status)) continue;
      if (excluded.includes(node.status)) continue;
      if (filter.where !== undefined) {
        const passed = this.#withBinding("node", [node.id], () =>
          this.evaluate(filter.where!, pointer(path, "where")),
        );
        if (!passed) continue;
      }
      output.push(node.id);
    }
    return output;
  }

  #selectQueryEnvelope(value: ConfigurationValue, path: string): readonly string[] {
    if (typeof value === "string") return this.#selectQuery(value, path);
    const query = exactRecord(value, path, ["id", "args"], ["id"]);
    const id = stringValue(query.id, pointer(path, "id"));
    if (
      query.args !== undefined &&
      Object.keys(record(query.args, pointer(path, "args"))).length > 0
    ) {
      fail(
        "expression.query_arguments",
        pointer(path, "args"),
        `query ${id} supplied unsupported arguments`,
      );
    }
    return this.#selectQuery(id, path);
  }

  #selectQuery(id: string, path: string): readonly string[] {
    if (this.#queryStack.includes(id)) {
      fail(
        "expression.recursive_query",
        path,
        `recursive query ${[...this.#queryStack, id].join(" -> ")}`,
      );
    }
    const source = this.#configuration.registries.queries[id];
    if (source === undefined) {
      fail("expression.unknown_query", path, `query ${id} is not configured`);
    }
    const query = exactRecord(
      source,
      `/registries/queries/${escapePointer(id)}`,
      ["id", "params", "node_types", "statuses", "status_excluding", "traverse", "select", "where"],
      ["id"],
    );
    this.#queryStack.push(id);
    try {
      let output: readonly string[];
      if (query.select !== undefined) {
        output = this.select(query.select, pointer(path, "select"));
      } else if (query.traverse !== undefined) {
        const traversal = exactRecord(
          query.traverse,
          pointer(path, "traverse"),
          ["from", "relations", "direction", "max_depth"],
          ["from"],
        );
        const traverse: MutableConfigurationObject = {
          from: cloneValue(traversal.from!),
          relations: cloneValue(traversal.relations ?? []),
          direction: cloneValue(traversal.direction ?? "outgoing"),
          min_depth: 1,
          max_depth: cloneValue(traversal.max_depth ?? 1),
          node_types: cloneValue(query.node_types ?? []),
        };
        output = this.#selectTraverse(traverse, pointer(path, "traverse"));
      } else {
        const types = optionalStringArray(query.node_types, pointer(path, "node_types"));
        output = [...this.#nodes.values()]
          .filter((node) => types.length === 0 || types.includes(node.type))
          .map((node) => node.id)
          .sort(compareUtf8);
      }
      const statuses = optionalStringArray(query.statuses, pointer(path, "statuses"));
      const excluded = optionalStringArray(
        query.status_excluding,
        pointer(path, "status_excluding"),
      );
      const filtered: string[] = [];
      for (const nodeId of output) {
        const node = this.#nodes.get(nodeId);
        if (node === undefined) continue;
        if (statuses.length > 0 && !statuses.includes(node.status)) continue;
        if (excluded.includes(node.status)) continue;
        if (query.where !== undefined) {
          const passed = this.#withBinding("node", [nodeId], () =>
            this.evaluate(query.where!, pointer(path, "where")),
          );
          if (!passed) continue;
        }
        filtered.push(nodeId);
      }
      return uniqueSortedStrings(filtered, path);
    } finally {
      this.#queryStack.pop();
    }
  }

  #selectTraverse(value: ConfigurationValue, path: string): readonly string[] {
    const traversal = exactRecord(
      value,
      path,
      ["from", "relation", "relations", "direction", "min_depth", "max_depth", "node_types"],
      ["from"],
    );
    if (traversal.relation !== undefined && traversal.relations !== undefined) {
      fail(
        "expression.traverse_relations",
        path,
        "traverse uses either relation or relations, not both",
      );
    }
    const starts = this.select(traversal.from!, pointer(path, "from"));
    const relation = optionalString(traversal.relation, pointer(path, "relation"));
    const relations =
      relation === undefined
        ? optionalStringArray(traversal.relations, pointer(path, "relations"))
        : [relation];
    const direction = optionalString(traversal.direction, pointer(path, "direction")) ?? "outgoing";
    if (!new Set(["outgoing", "incoming", "both"]).has(direction)) {
      fail(
        "expression.traverse_direction",
        pointer(path, "direction"),
        `unsupported traversal direction ${direction}`,
      );
    }
    const minDepth = optionalBound(traversal.min_depth, pointer(path, "min_depth")) ?? 1;
    const maxDepth = optionalBound(traversal.max_depth, pointer(path, "max_depth")) ?? 1;
    if (minDepth < 1 || maxDepth < minDepth || maxDepth > 64) {
      fail(
        "expression.traverse_depth",
        path,
        "traverse depth must satisfy 1 <= min_depth <= max_depth <= 64",
      );
    }
    const types = optionalStringArray(traversal.node_types, pointer(path, "node_types"));
    const output = new Set<string>();
    for (const id of this.#traverse(
      starts,
      relations.length === 0 ? undefined : relations,
      direction as TraversalDirection,
      minDepth,
      maxDepth,
    )) {
      const node = this.#nodes.get(id)!;
      if (types.length === 0 || types.includes(node.type)) output.add(id);
    }
    return sortedSet(output);
  }

  #selectPolicy(envelope: ConfigurationObject, path: string): readonly string[] {
    if (this.#adapter?.selectPolicy === undefined) {
      fail(
        "expression.domain_adapter_required",
        path,
        "policy selector requires a configured rule domain adapter",
      );
    }
    const selected = this.#adapter.selectPolicy(
      cloneObject(envelope),
      this.#domainContext(undefined, path),
    );
    if (selected === undefined) {
      fail(
        "expression.domain_selector_unhandled",
        path,
        "rule domain adapter did not handle policy selector",
      );
    }
    const ids = uniqueSortedStrings(selected, path);
    for (const id of ids) {
      if (!this.#nodes.has(id)) {
        fail(
          "expression.domain_missing_node",
          path,
          `rule domain adapter selected missing node ${id}`,
        );
      }
    }
    return ids;
  }

  #evaluateLeaf(leaf: ConfigurationObject, path: string): boolean {
    const op = stringValue(leaf.op, pointer(path, "op"));
    if (DOMAIN_PREDICATE_OPERATORS.has(op)) {
      const subject = this.#subject(leaf, path);
      if (this.#adapter?.evaluatePredicate === undefined) {
        fail(
          "expression.domain_adapter_required",
          path,
          `predicate ${op} requires a configured rule domain adapter`,
        );
      }
      const result = this.#adapter.evaluatePredicate(
        cloneObject(leaf),
        this.#domainContext(subject, path),
      );
      if (result === undefined) {
        fail(
          "expression.domain_predicate_unhandled",
          path,
          `rule domain adapter did not handle predicate ${op}`,
        );
      }
      if (typeof result !== "boolean") {
        fail(
          "expression.domain_predicate_result",
          path,
          `rule domain adapter returned a non-boolean result for ${op}`,
        );
      }
      return result;
    }
    if (!PURE_PREDICATE_OPERATORS.has(op)) {
      fail("expression.unknown_predicate", pointer(path, "op"), `unknown predicate operator ${op}`);
    }
    const subject = this.#subject(leaf, path);
    switch (op) {
      case "always":
        return true;
      case "edge_count": {
        const relation = stringValue(leaf.relation, pointer(path, "relation"));
        const count =
          subject === undefined
            ? 0
            : this.#semanticNeighbors(subject.id, relation, "outgoing").length;
        return countMatches(count, leaf, path);
      }
      case "incoming_count": {
        const relation = optionalString(leaf.relation, pointer(path, "relation"));
        const count =
          subject === undefined
            ? 0
            : this.#semanticNeighbors(subject.id, relation, "incoming").length;
        return countMatches(count, leaf, path);
      }
      case "field_present": {
        const field = stringValue(leaf.field, pointer(path, "field"));
        const value = subject === undefined ? undefined : this.#fieldValue(subject, field);
        return value !== undefined && !isEmptyValue(value);
      }
      case "field_equals": {
        const field = stringValue(leaf.field, pointer(path, "field"));
        const expected = leaf.value ?? leaf.equals;
        if (expected === undefined) {
          fail("expression.predicate_field", path, "field_equals requires value or equals");
        }
        const actual = subject === undefined ? undefined : this.#fieldValue(subject, field);
        return actual !== undefined && canonicalEncode(actual) === canonicalEncode(expected);
      }
      case "field_in": {
        const field = stringValue(leaf.field, pointer(path, "field"));
        const values = nonemptyArray(leaf.values, pointer(path, "values"));
        const actual = subject === undefined ? undefined : this.#fieldValue(subject, field);
        return (
          actual !== undefined &&
          values.some((candidate) => canonicalEncode(candidate) === canonicalEncode(actual))
        );
      }
      case "query_count": {
        const query = stringValue(leaf.query, pointer(path, "query"));
        return countMatches(this.#selectQuery(query, pointer(path, "query")).length, leaf, path);
      }
      case "status_is": {
        if (subject === undefined) return false;
        const statuses = optionalStringArray(leaf.statuses, pointer(path, "statuses"));
        return statuses.includes(subject.status) || leaf.value === subject.status;
      }
      case "node_type_is": {
        if (subject === undefined) return false;
        const types = optionalStringArray(leaf.node_types, pointer(path, "node_types"));
        return types.includes(subject.type) || leaf.value === subject.type;
      }
      case "set_relation": {
        if (leaf.left === undefined || leaf.right === undefined) {
          fail(
            "expression.predicate_selector",
            path,
            "set_relation requires left and right selectors",
          );
        }
        const left = new Set(this.select(leaf.left, pointer(path, "left")));
        const right = new Set(this.select(leaf.right, pointer(path, "right")));
        const relation = stringValue(leaf.relation_kind, pointer(path, "relation_kind"));
        switch (relation) {
          case "equal":
            return setsEqual(left, right);
          case "subset":
            return isSubset(left, right);
          case "superset":
            return isSubset(right, left);
          case "disjoint":
            return [...left].every((id) => !right.has(id));
          case "intersects":
            return [...left].some((id) => right.has(id));
          default:
            return fail(
              "expression.set_relation",
              pointer(path, "relation_kind"),
              `unknown set relation ${relation}`,
            );
        }
      }
      case "coverage": {
        const numerator = leaf.numerator;
        const denominator = leaf.denominator;
        if (numerator === undefined || denominator === undefined) {
          fail(
            "expression.predicate_selector",
            path,
            "coverage requires numerator and denominator selectors",
          );
        }
        return isSubset(
          new Set(this.select(denominator, pointer(path, "denominator"))),
          new Set(this.select(numerator, pointer(path, "numerator"))),
        );
      }
      case "acyclic":
        return this.#acyclic(optionalString(leaf.relation, pointer(path, "relation")));
      case "semver_compatible": {
        const provided = optionalString(leaf.provided ?? leaf.value, pointer(path, "provided"));
        const requiredRange = optionalString(leaf.required, pointer(path, "required"));
        return (
          provided !== undefined &&
          requiredRange !== undefined &&
          valid(provided) !== null &&
          validRange(requiredRange) !== null &&
          satisfies(provided, requiredRange)
        );
      }
      case "obligation_exists": {
        const obligations =
          subject === undefined ? undefined : this.#fieldValue(subject, "obligations.unmet");
        return Array.isArray(obligations) && obligations.length > 0;
      }
      case "stage_is": {
        if (subject === undefined) return false;
        const expected = optionalString(leaf.value, pointer(path, "value"));
        return expected !== undefined && this.#nodeStages.get(subject.type) === expected;
      }
      default:
        fail(
          "expression.unknown_predicate",
          pointer(path, "op"),
          `unknown predicate operator ${op}`,
        );
    }
  }

  #subject(leaf: ConfigurationObject, path: string): MutableGraphNode | undefined {
    const explicit = optionalString(leaf.subject, pointer(path, "subject"));
    // Rule bodies conventionally bind `$target`; query/node `where` clauses bind `$node`.
    // Preserve an explicit subject exactly, otherwise select the innermost conventional binding.
    const source = explicit ?? (this.#bindings.has("target") ? "$target" : "$node");
    const binding = normalizeBindingName(source, pointer(path, "subject"));
    const ids = this.#bindings.get(binding);
    if (ids === undefined) {
      fail(
        "expression.unknown_binding",
        pointer(path, "subject"),
        `predicate references unbound subject $${binding}`,
      );
    }
    return ids[0] === undefined ? undefined : this.#nodes.get(ids[0]);
  }

  #fieldValue(node: MutableGraphNode, field: string): MutableConfigurationValue | undefined {
    if (field.length === 0 || field === ".") return undefined;
    const root: MutableConfigurationObject = {
      ...cloneMutableObject(node.fields),
      schema_version: "1.0",
      id: node.id,
      type: node.type,
      title: node.title,
      status: node.status,
      spec: cloneMutableObject(node.spec),
      edges: cloneMutableObject(node.edges),
      ...(node.annotations === undefined
        ? {}
        : { annotations: cloneMutableObject(node.annotations) }),
    };
    let current: MutableConfigurationValue = root;
    const normalized = field.replace(/^\$?\./u, "");
    for (const segment of normalized.split(".")) {
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isSafeInteger(index) || index < 0 || current[index] === undefined)
          return undefined;
        current = current[index]!;
      } else if (isMutableRecord(current) && current[segment] !== undefined) {
        current = current[segment]!;
      } else {
        return undefined;
      }
    }
    return cloneMutableValue(current);
  }

  #traverse(
    starts: readonly string[],
    relations: readonly string[] | undefined,
    direction: TraversalDirection,
    minDepth: number,
    maxDepth: number,
  ): readonly string[] {
    const seen = new Set(starts);
    const queue = starts.map((id) => ({ id, depth: 0 }));
    const output = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      const requested = relations ?? [undefined];
      const neighbors = uniqueSortedStrings(
        requested.flatMap((relation) =>
          direction === "both"
            ? [
                ...this.#semanticNeighbors(current.id, relation, "outgoing"),
                ...this.#semanticNeighbors(current.id, relation, "incoming"),
              ]
            : this.#semanticNeighbors(current.id, relation, direction),
        ),
        "/traverse",
      );
      for (const id of neighbors) {
        if (seen.has(id)) continue;
        seen.add(id);
        const depth = current.depth + 1;
        if (depth >= minDepth) output.add(id);
        queue.push({ id, depth });
      }
    }
    return sortedSet(output);
  }

  #semanticNeighbors(
    nodeId: string,
    relation: string | undefined,
    direction: "outgoing" | "incoming",
  ): readonly string[] {
    const inverse = relation === undefined ? undefined : this.#inverseRelations.get(relation);
    const paths: { relation: string | undefined; direction: "outgoing" | "incoming" }[] =
      inverse !== undefined && inverse.length > 0
        ? inverse.map((canonical) => ({ relation: canonical, direction: opposite(direction) }))
        : [{ relation, direction }];
    const output = new Set<string>();
    for (const path of paths) {
      for (const id of this.#rawNeighbors(nodeId, path.relation, path.direction)) output.add(id);
    }
    return sortedSet(output);
  }

  #rawNeighbors(
    nodeId: string,
    relation: string | undefined,
    direction: "outgoing" | "incoming",
  ): readonly string[] {
    const output = new Set<string>();
    if (direction === "outgoing") {
      const node = this.#nodes.get(nodeId);
      if (node === undefined) return [];
      if (relation === undefined) {
        for (const targets of Object.values(node.edges))
          for (const target of targets) output.add(target);
      } else {
        for (const target of node.edges[relation] ?? []) output.add(target);
      }
    } else {
      for (const candidate of this.#nodes.values()) {
        if (relation === undefined) {
          if (Object.values(candidate.edges).some((targets) => targets.includes(nodeId)))
            output.add(candidate.id);
        } else if ((candidate.edges[relation] ?? []).includes(nodeId)) {
          output.add(candidate.id);
        }
      }
    }
    return sortedSet(output);
  }

  #acyclic(relation: string | undefined): boolean {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const neighbor of this.#semanticNeighbors(id, relation, "outgoing")) {
        if (!visit(neighbor)) return false;
      }
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    return [...this.#nodes.keys()].sort(compareUtf8).every(visit);
  }

  #withBinding<Value>(name: string, ids: readonly string[], evaluate: () => Value): Value {
    const normalized = normalizeBindingName(name, "/bindings");
    const previous = this.#bindings.get(normalized);
    this.#bindings.set(normalized, [...ids]);
    try {
      return evaluate();
    } finally {
      if (previous === undefined) this.#bindings.delete(normalized);
      else this.#bindings.set(normalized, previous);
    }
  }

  #domainContext(subject: MutableGraphNode | undefined, path: string): RuleDomainContext {
    const bindings: Record<string, readonly string[]> = Object.create(null) as Record<
      string,
      readonly string[]
    >;
    for (const [name, ids] of [...this.#bindings].sort(([left], [right]) =>
      compareUtf8(left, right),
    )) {
      bindings[name] = Object.freeze([...ids]);
    }
    return Object.freeze({
      configuration: this.#configuration,
      graph_sha256: this.graphSha256,
      bindings: Object.freeze(bindings),
      ...(subject === undefined ? {} : { subject: publicNode(subject) }),
      select: (selector: ConfigurationValue) => this.select(selector, `${path}/domain-selector`),
      node: (id: string) => this.node(id),
      evaluate: (predicate: ConfigurationValue) =>
        this.evaluate(predicate, `${path}/domain-predicate`),
      withBinding: <Value>(name: string, ids: readonly string[], evaluate: () => Value) =>
        this.withBinding(name, ids, evaluate, `${path}/domain-binding`),
    });
  }

  #validateGraphEdges(): void {
    for (const node of this.#nodes.values()) {
      for (const [relation, targets] of Object.entries(node.edges)) {
        if (relation.trim().length === 0) {
          fail(
            "expression.edge_relation",
            `/graph/nodes/${escapePointer(node.id)}/edges`,
            "edge relation must not be empty",
          );
        }
        for (const target of targets) {
          if (!this.#nodes.has(target)) {
            fail(
              "expression.missing_edge_target",
              `/graph/nodes/${escapePointer(node.id)}/edges/${escapePointer(relation)}`,
              `edge targets missing node ${target}`,
            );
          }
        }
      }
    }
  }

  #compileEdgeSemantics(): void {
    for (const value of this.#configuration.edge_types) {
      if (
        value.bidirectional !== true ||
        typeof value.inverse !== "string" ||
        typeof value.relation !== "string"
      )
        continue;
      const current = this.#inverseRelations.get(value.inverse) ?? [];
      current.push(value.relation);
      this.#inverseRelations.set(value.inverse, [...new Set(current)].sort(compareUtf8));
    }
  }

  #graphMaterial(): ConfigurationValue {
    return [...this.#nodes.values()]
      .sort((left, right) => compareUtf8(left.id, right.id))
      .map((node) => nodeMaterial(node));
  }
}

function snapshotNode(source: CompilerGraphNode, path: string): MutableGraphNode {
  const id = stringValue(source.id, pointer(path, "id"));
  const type = stringValue(source.type, pointer(path, "type"));
  const title = stringValue(source.title, pointer(path, "title"));
  const status = stringValue(source.status, pointer(path, "status"));
  const spec = cloneMutableObject(record(source.spec, pointer(path, "spec")));
  const edges: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [relation, targets] of Object.entries(source.edges).sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    edges[relation] = uniqueSortedStrings(targets, `${path}/edges/${escapePointer(relation)}`);
  }
  const annotations =
    source.annotations === undefined
      ? undefined
      : cloneMutableObject(record(source.annotations, pointer(path, "annotations")));
  const structuralFields = new Set([
    "schema_version",
    "id",
    "type",
    "title",
    "status",
    "spec",
    "edges",
    "annotations",
    "fields",
  ]);
  const fields = Object.fromEntries(
    Object.entries(source as unknown as ConfigurationObject)
      .filter(([field]) => !structuralFields.has(field))
      .map(([field, value]) => [field, cloneValue(value)]),
  );
  for (const [field, value] of Object.entries(source.fields ?? {})) {
    if (fields[field] !== undefined && canonicalHash(fields[field]) !== canonicalHash(value)) {
      fail(
        "expression.ambiguous_node_field",
        pointer(pointer(path, "fields"), field),
        `node field ${field} differs between its graph projection and fields map`,
      );
    }
    fields[field] = cloneValue(value);
  }
  return {
    id,
    type,
    title,
    status,
    spec,
    edges,
    ...(annotations === undefined ? {} : { annotations }),
    fields,
  };
}

function publicNode(node: MutableGraphNode): CompilerGraphNode {
  return deepFreeze({
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: cloneObject(node.spec),
    edges: cloneEdges(node.edges),
    ...(node.annotations === undefined ? {} : { annotations: cloneObject(node.annotations) }),
    ...(Object.keys(node.fields).length === 0 ? {} : { fields: cloneObject(node.fields) }),
  });
}

function nodeMaterial(node: MutableGraphNode): ConfigurationObject {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    spec: cloneObject(node.spec),
    edges: cloneObject(node.edges),
    ...(node.annotations === undefined ? {} : { annotations: cloneObject(node.annotations) }),
    ...(Object.keys(node.fields).length === 0 ? {} : { fields: cloneObject(node.fields) }),
  };
}

function cloneEdges(
  edges: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, readonly string[]>> {
  const output: Record<string, readonly string[]> = Object.create(null) as Record<
    string,
    readonly string[]
  >;
  for (const [relation, targets] of Object.entries(edges).sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    output[relation] = Object.freeze([...targets]);
  }
  return Object.freeze(output);
}

function countMatches(count: number, leaf: ConfigurationObject, path: string): boolean {
  const exact = optionalBound(leaf.exact, pointer(path, "exact"));
  const min = optionalBound(leaf.min, pointer(path, "min"));
  const max = optionalBound(leaf.max, pointer(path, "max"));
  if (min !== undefined && max !== undefined && min > max) {
    fail("expression.count_bounds", path, "predicate min must not exceed max");
  }
  return (
    (exact === undefined || count === exact) &&
    (min === undefined || count >= min) &&
    (max === undefined || count <= max)
  );
}

function setValuePath(
  root: MutableConfigurationObject,
  field: string,
  value: MutableConfigurationValue,
  path: string,
): void {
  const segments = field.split(".");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    fail(
      "rule.derivation_field",
      pointer(path, "field"),
      "derivation field must be a nonempty dot path",
    );
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const existing = current[segment];
    if (existing === undefined) {
      const child: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
      current[segment] = child;
      current = child;
    } else if (isMutableRecord(existing)) {
      current = existing;
    } else {
      fail(
        "rule.derivation_field_conflict",
        pointer(path, "field"),
        `derivation field ${field} crosses a non-object value`,
      );
    }
  }
}

function mutableRecordAt(
  root: MutableConfigurationObject,
  key: string,
): MutableConfigurationObject {
  const existing = root[key];
  if (existing === undefined) {
    const created: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
    root[key] = created;
    return created;
  }
  if (!isMutableRecord(existing)) {
    fail(
      "rule.derivation_projection",
      `/graph/fields/${escapePointer(key)}`,
      `compiler projection ${key} is not an object`,
    );
  }
  return existing;
}

function mutableArrayAt(
  root: MutableConfigurationObject,
  key: string,
): MutableConfigurationValue[] {
  const existing = root[key];
  if (existing === undefined) {
    const created: MutableConfigurationValue[] = [];
    root[key] = created;
    return created;
  }
  if (!Array.isArray(existing)) {
    fail(
      "rule.derivation_projection",
      `/graph/fields/${escapePointer(key)}`,
      `compiler projection ${key} is not an array`,
    );
  }
  return existing;
}

function compactObject(
  values: Record<string, MutableConfigurationValue | undefined>,
): MutableConfigurationObject {
  const output: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
  for (const [key, value] of Object.entries(values)) if (value !== undefined) output[key] = value;
  return output;
}

function isEmptyValue(value: ConfigurationValue | MutableConfigurationValue): boolean {
  return (
    value === null ||
    (typeof value === "string" && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecordLike(value) && Object.keys(value).length === 0)
  );
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && isSubset(left, right);
}

function isSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].every((id) => right.has(id));
}

function opposite(direction: "outgoing" | "incoming"): "outgoing" | "incoming" {
  return direction === "outgoing" ? "incoming" : "outgoing";
}

function normalizeBindingName(value: string, path: string): string {
  const name = value.trimStart().startsWith("$") ? value.trimStart().slice(1) : value;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
    fail("expression.binding_name", path, `invalid binding name ${value}`);
  }
  return name;
}

function optionalBound(value: ConfigurationValue | undefined, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("expression.integer_bound", path, "expression bound must be a nonnegative safe integer");
  }
  return value;
}

function required(
  source: ConfigurationObject,
  key: string,
  parentPath: string,
): ConfigurationValue {
  const value = source[key];
  if (value === undefined)
    fail("expression.missing_field", pointer(parentPath, key), `required field ${key} is missing`);
  return value;
}

function exactRecord(
  value: ConfigurationValue,
  path: string,
  allowed: readonly string[],
  requiredKeys: readonly string[] = [],
): ConfigurationObject {
  const output = record(value, path);
  exactKeys(output, path, allowed);
  for (const key of requiredKeys) {
    if (output[key] === undefined)
      fail("expression.missing_field", pointer(path, key), `required field ${key} is missing`);
  }
  return output;
}

function exactKeys(value: ConfigurationObject, path: string, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      fail(
        "expression.unknown_field",
        pointer(path, key),
        `expression contains unknown field ${key}`,
      );
    }
  }
}

function record(
  value: ConfigurationValue,
  path: string,
  message = "expected a mapping",
): ConfigurationObject {
  if (!isRecordLike(value)) fail("expression.mapping", path, message);
  return value;
}

function stringValue(value: ConfigurationValue | undefined, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("expression.string", path, "expected a nonempty string");
  }
  return value;
}

function optionalString(value: ConfigurationValue | undefined, path: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, path);
}

function stringArray(value: ConfigurationValue, path: string): string[] {
  if (!Array.isArray(value)) fail("expression.string_array", path, "expected an array of strings");
  return value.map((item, index) => stringValue(item, pointer(path, index)));
}

function optionalStringArray(value: ConfigurationValue | undefined, path: string): string[] {
  return value === undefined ? [] : stringArray(value, path);
}

function nonemptyArray(
  value: ConfigurationValue | undefined,
  path: string,
): readonly ConfigurationValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("expression.nonempty_array", path, "expected a nonempty array");
  }
  return value;
}

function uniqueSortedStrings(values: readonly string[], path: string): string[] {
  const output = [...values].sort(compareUtf8);
  for (let index = 1; index < output.length; index += 1) {
    if (output[index] === output[index - 1]) {
      fail("expression.duplicate_value", path, `duplicate value ${output[index]}`);
    }
  }
  return output;
}

function sortedSet(values: ReadonlySet<string>): string[] {
  return [...values].sort(compareUtf8);
}

function isRecordLike(value: unknown): value is ConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMutableRecord(value: MutableConfigurationValue): value is MutableConfigurationObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneOptional(
  value: MutableConfigurationValue | undefined,
): ConfigurationValue | undefined {
  return value === undefined ? undefined : cloneValue(value);
}

function cloneValue(
  value: ConfigurationValue | MutableConfigurationValue,
): MutableConfigurationValue {
  return cloneMutableValue(value as MutableConfigurationValue);
}

function cloneMutableValue(value: MutableConfigurationValue): MutableConfigurationValue {
  if (Array.isArray(value)) return value.map(cloneMutableValue);
  if (isMutableRecord(value)) return cloneMutableObject(value);
  return value;
}

function cloneObject(value: ConfigurationObject | MutableConfigurationObject): ConfigurationObject {
  return cloneMutableObject(value);
}

function cloneMutableObject(
  value: MutableConfigurationObject | ConfigurationObject,
): MutableConfigurationObject {
  const output: MutableConfigurationObject = Object.create(null) as MutableConfigurationObject;
  for (const key of Object.keys(value).sort(compareUtf8)) output[key] = cloneValue(value[key]!);
  return output;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function fail(code: string, path: string, message: string): never {
  throw new ExpressionEvaluationError(code, path, message);
}
