use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The small type lattice used while compiling profile expressions.
///
/// Profile authors never write Rust-like expression strings. Selectors and
/// predicates are structured YAML values, which lets the profile compiler
/// validate references before an action or rule is allowed to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    Any,
    Null,
    Boolean,
    Integer,
    Number,
    String,
    Path,
    Node,
    NodeSet,
    Ticket,
    TicketSet,
    Receipt,
    ReceiptSet,
    Json,
}

impl ValueType {
    pub fn accepts(self, actual: Self) -> bool {
        self == Self::Any
            || actual == Self::Any
            || self == actual
            || (self == Self::Number && actual == Self::Integer)
            || (self == Self::Json
                && !matches!(actual, Self::NodeSet | Self::TicketSet | Self::ReceiptSet))
    }
}

#[derive(Debug, Clone, Default)]
pub struct ExpressionSymbols {
    pub node_types: BTreeSet<String>,
    pub queries: BTreeSet<String>,
    /// Operation registry entries that expose a receipt_coverage contract and
    /// can therefore be referenced by the generic currentness predicate.
    pub receipt_coverages: BTreeSet<String>,
    /// `operation-registry-id#effect-id` contracts available to
    /// review_effect_coverage_current predicates.
    pub review_effects: BTreeSet<String>,
    pub gate_policies: BTreeSet<String>,
    pub variables: BTreeMap<String, ValueType>,
}

impl ExpressionSymbols {
    pub fn with_variable(mut self, name: impl Into<String>, value_type: ValueType) -> Self {
        self.variables.insert(name.into(), value_type);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Selector {
    Named(String),
    Nodes(NodesSelectorEnvelope),
    Query(QuerySelectorEnvelope),
    Variable(VariableSelectorEnvelope),
    Ids(IdsSelectorEnvelope),
    Traverse(TraverseSelectorEnvelope),
    Union(UnionSelectorEnvelope),
    Intersection(IntersectionSelectorEnvelope),
    Difference(DifferenceSelectorEnvelope),
    PolicySelection(PolicySelectionSelectorEnvelope),
    PolicyApplicability(PolicyApplicabilitySelectorEnvelope),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySelectionSelectorEnvelope {
    pub policy_selection: PolicySelectionSelector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicySelectionSelector {
    pub policy: String,
    pub gate: Box<Selector>,
    #[serde(default)]
    pub result: PolicySelectionResult,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicySelectionResult {
    #[default]
    Winner,
    Compatible,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyApplicabilitySelectorEnvelope {
    pub policy_applicability: PolicyApplicabilitySelector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyApplicabilitySelector {
    pub policy: String,
    pub subject: Box<Selector>,
    #[serde(default)]
    pub result: PolicyApplicabilityResult,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyApplicabilityResult {
    #[default]
    DirectGates,
    InheritedGates,
    ApplicableGates,
    Ancestors,
    Context,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodesSelectorEnvelope {
    pub nodes: NodeFilter,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeFilter {
    #[serde(default)]
    pub node_types: Vec<String>,
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default)]
    pub status_excluding: Vec<String>,
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<Box<Predicate>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuerySelectorEnvelope {
    pub query: String,
    #[serde(default)]
    pub args: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VariableSelectorEnvelope {
    pub variable: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdsSelectorEnvelope {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TraverseSelectorEnvelope {
    pub traverse: TraverseSelector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TraverseSelector {
    pub from: Box<Selector>,
    #[serde(default)]
    pub relations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    #[serde(default)]
    pub direction: TraverseDirection,
    #[serde(default = "default_min_depth")]
    pub min_depth: usize,
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
    #[serde(default)]
    pub node_types: Vec<String>,
}

fn default_min_depth() -> usize {
    1
}

fn default_max_depth() -> usize {
    1
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraverseDirection {
    #[default]
    Outgoing,
    Incoming,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnionSelectorEnvelope {
    pub union: Vec<Selector>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntersectionSelectorEnvelope {
    pub intersection: Vec<Selector>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DifferenceSelectorEnvelope {
    pub difference: SelectorDifference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectorDifference {
    pub left: Box<Selector>,
    pub right: Box<Selector>,
}

impl Selector {
    pub fn validate(&self, symbols: &ExpressionSymbols) -> std::result::Result<(), String> {
        match self {
            Self::Named(name) => {
                if let Some(variable) = name.strip_prefix('$') {
                    let actual = symbols
                        .variables
                        .get(variable)
                        .copied()
                        .ok_or_else(|| format!("unknown selector variable ${variable}"))?;
                    if !ValueType::NodeSet.accepts(actual) && actual != ValueType::Node {
                        return Err(format!(
                            "selector variable ${variable} is {actual:?}, expected node or node_set"
                        ));
                    }
                } else if !symbols.queries.contains(name) {
                    return Err(format!("unknown selector/query {name}"));
                }
            }
            Self::Nodes(envelope) => {
                validate_node_types(&envelope.nodes.node_types, symbols)?;
                if let Some(predicate) = &envelope.nodes.where_ {
                    predicate.validate(&symbols.clone().with_variable("node", ValueType::Node))?;
                }
            }
            Self::Query(envelope) => {
                if !symbols.queries.contains(&envelope.query) {
                    return Err(format!("unknown query {}", envelope.query));
                }
                if !envelope.args.is_empty() {
                    return Err(format!(
                        "query {} supplies args, but query arguments are not implemented",
                        envelope.query
                    ));
                }
            }
            Self::Variable(envelope) => {
                let actual = symbols
                    .variables
                    .get(&envelope.variable)
                    .copied()
                    .ok_or_else(|| format!("unknown selector variable {}", envelope.variable))?;
                if !ValueType::NodeSet.accepts(actual) && actual != ValueType::Node {
                    return Err(format!(
                        "selector variable {} is {actual:?}, expected node or node_set",
                        envelope.variable
                    ));
                }
            }
            Self::Ids(_) => {}
            Self::Traverse(envelope) => {
                envelope.traverse.from.validate(symbols)?;
                validate_node_types(&envelope.traverse.node_types, symbols)?;
                if envelope.traverse.max_depth == 0
                    || envelope.traverse.min_depth > envelope.traverse.max_depth
                {
                    return Err(
                        "traverse depth must satisfy 1 <= min_depth <= max_depth".to_owned()
                    );
                }
                if envelope.traverse.relation.is_some() && !envelope.traverse.relations.is_empty() {
                    return Err("traverse uses either relation or relations, not both".to_owned());
                }
            }
            Self::Union(envelope) => validate_selector_list(&envelope.union, symbols, "union")?,
            Self::Intersection(envelope) => {
                validate_selector_list(&envelope.intersection, symbols, "intersection")?
            }
            Self::Difference(envelope) => {
                envelope.difference.left.validate(symbols)?;
                envelope.difference.right.validate(symbols)?;
            }
            Self::PolicySelection(envelope) => {
                if !symbols
                    .gate_policies
                    .contains(&envelope.policy_selection.policy)
                {
                    return Err(format!(
                        "unknown gate policy {}",
                        envelope.policy_selection.policy
                    ));
                }
                envelope.policy_selection.gate.validate(symbols)?;
            }
            Self::PolicyApplicability(envelope) => {
                if !symbols
                    .gate_policies
                    .contains(&envelope.policy_applicability.policy)
                {
                    return Err(format!(
                        "unknown gate policy {}",
                        envelope.policy_applicability.policy
                    ));
                }
                envelope.policy_applicability.subject.validate(symbols)?;
            }
        }
        Ok(())
    }

    pub fn referenced_queries(&self, output: &mut BTreeSet<String>) {
        match self {
            Self::Named(name) if !name.starts_with('$') => {
                output.insert(name.clone());
            }
            Self::Query(envelope) => {
                output.insert(envelope.query.clone());
            }
            Self::Nodes(envelope) => {
                if let Some(predicate) = &envelope.nodes.where_ {
                    predicate.referenced_queries(output);
                }
            }
            Self::Traverse(envelope) => envelope.traverse.from.referenced_queries(output),
            Self::Union(envelope) => {
                for selector in &envelope.union {
                    selector.referenced_queries(output);
                }
            }
            Self::Intersection(envelope) => {
                for selector in &envelope.intersection {
                    selector.referenced_queries(output);
                }
            }
            Self::Difference(envelope) => {
                envelope.difference.left.referenced_queries(output);
                envelope.difference.right.referenced_queries(output);
            }
            Self::PolicySelection(envelope) => {
                envelope.policy_selection.gate.referenced_queries(output)
            }
            Self::PolicyApplicability(envelope) => envelope
                .policy_applicability
                .subject
                .referenced_queries(output),
            Self::Named(_) | Self::Variable(_) | Self::Ids(_) => {}
        }
    }

    pub fn referenced_gate_policies(&self, output: &mut BTreeSet<String>) {
        match self {
            Self::Nodes(envelope) => {
                if let Some(predicate) = &envelope.nodes.where_ {
                    predicate.referenced_gate_policies(output);
                }
            }
            Self::Traverse(envelope) => envelope.traverse.from.referenced_gate_policies(output),
            Self::Union(envelope) => {
                for selector in &envelope.union {
                    selector.referenced_gate_policies(output);
                }
            }
            Self::Intersection(envelope) => {
                for selector in &envelope.intersection {
                    selector.referenced_gate_policies(output);
                }
            }
            Self::Difference(envelope) => {
                envelope.difference.left.referenced_gate_policies(output);
                envelope.difference.right.referenced_gate_policies(output);
            }
            Self::PolicySelection(envelope) => {
                output.insert(envelope.policy_selection.policy.clone());
                envelope
                    .policy_selection
                    .gate
                    .referenced_gate_policies(output);
            }
            Self::PolicyApplicability(envelope) => {
                output.insert(envelope.policy_applicability.policy.clone());
                envelope
                    .policy_applicability
                    .subject
                    .referenced_gate_policies(output);
            }
            Self::Named(_) | Self::Query(_) | Self::Variable(_) | Self::Ids(_) => {}
        }
    }
}

fn validate_selector_list(
    selectors: &[Selector],
    symbols: &ExpressionSymbols,
    operation: &str,
) -> std::result::Result<(), String> {
    if selectors.is_empty() {
        return Err(format!("{operation} selector must not be empty"));
    }
    for selector in selectors {
        selector.validate(symbols)?;
    }
    Ok(())
}

fn validate_node_types(
    node_types: &[String],
    symbols: &ExpressionSymbols,
) -> std::result::Result<(), String> {
    for node_type in node_types {
        if !symbols.node_types.contains(node_type) {
            return Err(format!("unknown node type {node_type}"));
        }
    }
    Ok(())
}

/// A boolean expression encoded as a logical tree with typed leaves.
///
/// Examples: `{ all: [...] }`, `{ not: {...} }`, and
/// `{ op: edge_count, relation: claims, min: 1 }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Predicate {
    Constant(bool),
    All(AllPredicate),
    Any(AnyPredicate),
    Not(NotPredicate),
    ForAll(ForAllPredicate),
    Exists(ExistsPredicate),
    Leaf(Box<LeafPredicate>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllPredicate {
    pub all: Vec<Predicate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnyPredicate {
    pub any: Vec<Predicate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotPredicate {
    pub not: Box<Predicate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForAllPredicate {
    pub for_all: QuantifiedPredicate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExistsPredicate {
    pub exists: Selector,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuantifiedPredicate {
    pub select: Selector,
    #[serde(default = "default_binding")]
    pub bind: String,
    pub satisfies: Box<Predicate>,
}

fn default_binding() -> String {
    "node".to_owned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PredicateOp {
    Always,
    EdgeCount,
    IncomingCount,
    FieldEquals,
    FieldIn,
    FieldPresent,
    QueryCount,
    CurrentReceipt,
    ReceiptCoverageCurrent,
    ReviewEffectCoverageCurrent,
    FilesystemManifestCurrent,
    Coverage,
    StatusIs,
    NodeTypeIs,
    CheckPassed,
    PathExists,
    Acyclic,
    SetRelation,
    SemverCompatible,
    ObligationExists,
    StageIs,
    GatePolicyCompatible,
    GatePolicyHasSelection,
    GatePolicySelected,
    GatePolicyCandidateCount,
    GatePolicySatisfied,
    GatePolicyCommandAvailable,
    GatePolicyExecutionReady,
    GatePolicyHasCurrentTerminal,
    GatePolicyEvaluationTargetsReady,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeafPredicate {
    pub op: PredicateOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default)]
    pub values: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<usize>,
    #[serde(default)]
    pub node_types: Vec<String>,
    #[serde(default)]
    pub statuses: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_coverage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_effect: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage_targets: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate_subject: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub numerator: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub denominator: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation_kind: Option<SetRelation>,
    #[serde(default, flatten)]
    pub args: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetRelation {
    Equal,
    Subset,
    Superset,
    Disjoint,
    Intersects,
}

impl Predicate {
    pub fn validate(&self, symbols: &ExpressionSymbols) -> std::result::Result<ValueType, String> {
        match self {
            Self::Constant(_) => {}
            Self::All(envelope) => {
                if envelope.all.is_empty() {
                    return Err("all predicate must not be empty".to_owned());
                }
                for predicate in &envelope.all {
                    predicate.validate(symbols)?;
                }
            }
            Self::Any(envelope) => {
                if envelope.any.is_empty() {
                    return Err("any predicate must not be empty".to_owned());
                }
                for predicate in &envelope.any {
                    predicate.validate(symbols)?;
                }
            }
            Self::Not(envelope) => {
                envelope.not.validate(symbols)?;
            }
            Self::ForAll(envelope) => {
                envelope.for_all.select.validate(symbols)?;
                envelope.for_all.satisfies.validate(
                    &symbols
                        .clone()
                        .with_variable(envelope.for_all.bind.clone(), ValueType::Node),
                )?;
            }
            Self::Exists(envelope) => envelope.exists.validate(symbols)?,
            Self::Leaf(leaf) => leaf.validate(symbols)?,
        }
        Ok(ValueType::Boolean)
    }

    pub fn referenced_queries(&self, output: &mut BTreeSet<String>) {
        match self {
            Self::All(envelope) => {
                for predicate in &envelope.all {
                    predicate.referenced_queries(output);
                }
            }
            Self::Any(envelope) => {
                for predicate in &envelope.any {
                    predicate.referenced_queries(output);
                }
            }
            Self::Not(envelope) => envelope.not.referenced_queries(output),
            Self::ForAll(envelope) => {
                envelope.for_all.select.referenced_queries(output);
                envelope.for_all.satisfies.referenced_queries(output);
            }
            Self::Exists(envelope) => envelope.exists.referenced_queries(output),
            Self::Leaf(leaf) => {
                if let Some(query) = &leaf.query {
                    output.insert(query.clone());
                }
                for selector in [&leaf.numerator, &leaf.denominator, &leaf.left, &leaf.right]
                    .into_iter()
                    .flatten()
                {
                    selector.referenced_queries(output);
                }
                if let Some(selector) = &leaf.coverage_targets {
                    selector.referenced_queries(output);
                }
            }
            Self::Constant(_) => {}
        }
    }

    pub fn referenced_checks(&self, output: &mut BTreeSet<String>) {
        match self {
            Self::All(envelope) => {
                for predicate in &envelope.all {
                    predicate.referenced_checks(output);
                }
            }
            Self::Any(envelope) => {
                for predicate in &envelope.any {
                    predicate.referenced_checks(output);
                }
            }
            Self::Not(envelope) => envelope.not.referenced_checks(output),
            Self::ForAll(envelope) => envelope.for_all.satisfies.referenced_checks(output),
            Self::Leaf(leaf) if leaf.op == PredicateOp::CheckPassed => {
                if let Some(check) = &leaf.check {
                    output.insert(check.clone());
                }
            }
            Self::Constant(_) | Self::Exists(_) | Self::Leaf(_) => {}
        }
    }

    pub fn evaluate<R: ExpressionResolver>(
        &self,
        resolver: &R,
    ) -> std::result::Result<bool, R::Error> {
        match self {
            Self::Constant(value) => Ok(*value),
            Self::All(envelope) => {
                for predicate in &envelope.all {
                    if !predicate.evaluate(resolver)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            Self::Any(envelope) => {
                for predicate in &envelope.any {
                    if predicate.evaluate(resolver)? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            Self::Not(envelope) => Ok(!envelope.not.evaluate(resolver)?),
            Self::ForAll(envelope) => resolver.evaluate_for_all(&envelope.for_all),
            Self::Exists(envelope) => resolver.selector_exists(&envelope.exists),
            Self::Leaf(leaf) => resolver.evaluate_leaf(leaf),
        }
    }

    pub fn referenced_gate_policies(&self, output: &mut BTreeSet<String>) {
        match self {
            Self::All(envelope) => {
                for predicate in &envelope.all {
                    predicate.referenced_gate_policies(output);
                }
            }
            Self::Any(envelope) => {
                for predicate in &envelope.any {
                    predicate.referenced_gate_policies(output);
                }
            }
            Self::Not(envelope) => envelope.not.referenced_gate_policies(output),
            Self::ForAll(envelope) => {
                envelope.for_all.select.referenced_gate_policies(output);
                envelope.for_all.satisfies.referenced_gate_policies(output);
            }
            Self::Exists(envelope) => envelope.exists.referenced_gate_policies(output),
            Self::Leaf(leaf) => {
                if let Some(policy) = &leaf.gate_policy {
                    output.insert(policy.clone());
                }
                for selector in [&leaf.numerator, &leaf.denominator, &leaf.left, &leaf.right]
                    .into_iter()
                    .flatten()
                {
                    selector.referenced_gate_policies(output);
                }
                if let Some(selector) = &leaf.coverage_targets {
                    selector.referenced_gate_policies(output);
                }
            }
            Self::Constant(_) => {}
        }
    }
}

impl LeafPredicate {
    fn validate(&self, symbols: &ExpressionSymbols) -> std::result::Result<(), String> {
        validate_node_types(&self.node_types, symbols)?;
        if let Some(subject) = &self.subject {
            let subject = subject.trim_start_matches('$');
            if !symbols.variables.contains_key(subject) {
                return Err(format!("unknown predicate subject ${subject}"));
            }
        }
        if let Some(query) = &self.query
            && !symbols.queries.contains(query)
        {
            return Err(format!("unknown query {query}"));
        }
        for selector in [&self.numerator, &self.denominator, &self.left, &self.right]
            .into_iter()
            .flatten()
        {
            selector.validate(symbols)?;
        }
        if let Some(selector) = &self.coverage_targets {
            selector.validate(symbols)?;
        }
        if let (Some(min), Some(max)) = (self.min, self.max)
            && min > max
        {
            return Err(format!("predicate {:?} has min greater than max", self.op));
        }
        match self.op {
            PredicateOp::EdgeCount | PredicateOp::IncomingCount => {
                require(self.relation.as_deref(), self.op, "relation")?;
            }
            PredicateOp::FieldEquals => {
                require(self.field.as_deref(), self.op, "field")?;
                if self.value.is_none() && !self.args.contains_key("equals") {
                    return Err("field_equals requires value (or equals)".to_owned());
                }
            }
            PredicateOp::FieldIn => {
                require(self.field.as_deref(), self.op, "field")?;
                if self.values.is_empty() {
                    return Err("field_in requires a nonempty values list".to_owned());
                }
            }
            PredicateOp::FieldPresent => require(self.field.as_deref(), self.op, "field")?,
            PredicateOp::QueryCount => require(self.query.as_deref(), self.op, "query")?,
            PredicateOp::CurrentReceipt => {
                require(self.receipt_type.as_deref(), self.op, "receipt_type")?
            }
            PredicateOp::ReceiptCoverageCurrent => {
                require(
                    self.receipt_coverage.as_deref(),
                    self.op,
                    "receipt_coverage",
                )?;
                let coverage = self
                    .receipt_coverage
                    .as_deref()
                    .expect("required receipt coverage exists");
                if !symbols.receipt_coverages.contains(coverage) {
                    return Err(format!(
                        "unknown receipt coverage operation registry entry {coverage}"
                    ));
                }
                if self.coverage_targets.is_none() {
                    return Err(
                        "receipt_coverage_current requires coverage_targets selector".to_owned(),
                    );
                }
            }
            PredicateOp::ReviewEffectCoverageCurrent => {
                require(
                    self.review_operation.as_deref(),
                    self.op,
                    "review_operation",
                )?;
                require(self.review_effect.as_deref(), self.op, "review_effect")?;
                let key = format!(
                    "{}#{}",
                    self.review_operation
                        .as_deref()
                        .expect("operation required"),
                    self.review_effect.as_deref().expect("effect required")
                );
                if !symbols.review_effects.contains(&key) {
                    return Err(format!("unknown review effect coverage {key}"));
                }
                if self.coverage_targets.is_none() {
                    return Err(
                        "review_effect_coverage_current requires coverage_targets selector"
                            .to_owned(),
                    );
                }
            }
            PredicateOp::Coverage => {
                if self.numerator.is_none() && !self.args.contains_key("covered") {
                    return Err("coverage requires numerator/covered".to_owned());
                }
                if self.denominator.is_none() && !self.args.contains_key("required") {
                    return Err("coverage requires denominator/required".to_owned());
                }
            }
            PredicateOp::CheckPassed => require(self.check.as_deref(), self.op, "check")?,
            PredicateOp::GatePolicyCompatible
            | PredicateOp::GatePolicyHasSelection
            | PredicateOp::GatePolicySelected
            | PredicateOp::GatePolicyCandidateCount
            | PredicateOp::GatePolicySatisfied
            | PredicateOp::GatePolicyCommandAvailable
            | PredicateOp::GatePolicyExecutionReady
            | PredicateOp::GatePolicyHasCurrentTerminal
            | PredicateOp::GatePolicyEvaluationTargetsReady => {
                require(self.gate_policy.as_deref(), self.op, "gate_policy")?;
                let policy = self.gate_policy.as_deref().expect("required policy");
                if !symbols.gate_policies.contains(policy) {
                    return Err(format!("unknown gate policy {policy}"));
                }
                require(self.gate_subject.as_deref(), self.op, "gate_subject")?;
                let gate_subject = self
                    .gate_subject
                    .as_deref()
                    .expect("required gate subject")
                    .trim_start_matches('$');
                if !symbols.variables.contains_key(gate_subject) {
                    return Err(format!("unknown gate predicate subject ${gate_subject}"));
                }
                if matches!(
                    self.op,
                    PredicateOp::GatePolicyCompatible | PredicateOp::GatePolicySelected
                ) && self.subject.is_none()
                {
                    return Err(format!("predicate {:?} requires subject", self.op));
                }
                if self.op == PredicateOp::GatePolicyCandidateCount
                    && self.exact.is_none()
                    && self.min.is_none()
                    && self.max.is_none()
                {
                    return Err(
                        "gate_policy_candidate_count requires exact, min, or max".to_owned()
                    );
                }
            }
            PredicateOp::SetRelation => {
                if self.left.is_none() || self.right.is_none() || self.relation_kind.is_none() {
                    return Err("set_relation requires left, right, and relation_kind".to_owned());
                }
            }
            PredicateOp::Always
            | PredicateOp::FilesystemManifestCurrent
            | PredicateOp::StatusIs
            | PredicateOp::NodeTypeIs
            | PredicateOp::PathExists
            | PredicateOp::Acyclic
            | PredicateOp::SemverCompatible
            | PredicateOp::ObligationExists
            | PredicateOp::StageIs => {}
        }
        Ok(())
    }
}

fn require(value: Option<&str>, op: PredicateOp, field: &str) -> std::result::Result<(), String> {
    if value.is_some_and(|value| !value.trim().is_empty()) {
        Ok(())
    } else {
        Err(format!("predicate {op:?} requires {field}"))
    }
}

/// Runtime boundary for the expression VM. The core owns logical semantics;
/// graph/ticket/receipt storage adapters own domain leaf evaluation.
pub trait ExpressionResolver {
    type Error;

    fn evaluate_leaf(&self, leaf: &LeafPredicate) -> std::result::Result<bool, Self::Error>;
    fn selector_exists(&self, selector: &Selector) -> std::result::Result<bool, Self::Error>;
    fn evaluate_for_all(
        &self,
        predicate: &QuantifiedPredicate,
    ) -> std::result::Result<bool, Self::Error>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_predicate_round_trips_and_validates() {
        let yaml = r#"
all:
  - op: edge_count
    subject: $target
    relation: claims
    min: 1
  - not:
      op: field_in
      subject: $target
      field: status
      values: [archived, superseded]
"#;
        let predicate: Predicate = serde_yaml::from_str(yaml).unwrap();
        let symbols = ExpressionSymbols {
            node_types: ["hypothesis".to_owned()].into_iter().collect(),
            queries: BTreeSet::new(),
            receipt_coverages: BTreeSet::new(),
            review_effects: BTreeSet::new(),
            gate_policies: BTreeSet::new(),
            variables: [("target".to_owned(), ValueType::Node)]
                .into_iter()
                .collect(),
        };
        assert_eq!(predicate.validate(&symbols), Ok(ValueType::Boolean));
        let encoded = serde_yaml::to_string(&predicate).unwrap();
        let decoded: Predicate = serde_yaml::from_str(&encoded).unwrap();
        assert_eq!(decoded, predicate);
    }

    #[test]
    fn selector_rejects_unknown_query() {
        let selector: Selector = serde_yaml::from_str("query: missing\n").unwrap();
        let error = selector
            .validate(&ExpressionSymbols::default())
            .unwrap_err();
        assert!(error.contains("unknown query missing"));
    }

    #[test]
    fn traverse_rejects_inverted_depth() {
        let selector: Selector = serde_yaml::from_str(
            r#"
traverse:
  from: $target
  relation: contains
  min_depth: 3
  max_depth: 1
"#,
        )
        .unwrap();
        let symbols = ExpressionSymbols::default().with_variable("target", ValueType::Node);
        assert!(
            selector
                .validate(&symbols)
                .unwrap_err()
                .contains("min_depth")
        );
    }
}
