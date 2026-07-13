use std::collections::{BTreeMap, BTreeSet};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::error::{KoniError, Result};
use crate::graph::normalized_hash;
use crate::state::{Journal, JournalStatus, StateStore};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionRecipe {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub parameters: BTreeMap<String, ParameterSpec>,
    #[serde(default)]
    pub steps: Vec<ActionStep>,
    #[serde(default)]
    pub recovery_action: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParameterSpec {
    #[serde(rename = "type")]
    pub value_type: ValueType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<Value>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    String,
    Integer,
    Boolean,
    Array,
    Object,
    Any,
}

impl ValueType {
    fn accepts(self, value: &Value) -> bool {
        match self {
            Self::String => value.is_string(),
            Self::Integer => value.is_i64() || value.is_u64(),
            Self::Boolean => value.is_boolean(),
            Self::Array => value.is_array(),
            Self::Object => value.is_object(),
            Self::Any => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionStep {
    #[serde(rename = "use")]
    pub primitive: String,
    #[serde(default)]
    pub args: BTreeMap<String, Value>,
    #[serde(default)]
    pub bind: Option<String>,
    #[serde(default)]
    pub compensate: Option<CompensationStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompensationStep {
    #[serde(rename = "use")]
    pub primitive: String,
    #[serde(default)]
    pub args: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrimitiveSpec {
    pub id: String,
    #[serde(default)]
    pub required_args: BTreeMap<String, ValueType>,
    #[serde(default)]
    pub optional_args: BTreeMap<String, ValueType>,
    pub effect: Effect,
    #[serde(default)]
    pub reversible: bool,
    #[serde(default)]
    pub irreversible: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Read,
    StateWrite,
    FileWrite,
    Process,
    GitWorktree,
    GitIndex,
    GitRef,
    AgentSpawn,
}

#[derive(Debug, Clone)]
pub struct PrimitiveCatalog {
    specs: BTreeMap<String, PrimitiveSpec>,
}

impl Default for PrimitiveCatalog {
    fn default() -> Self {
        let mut catalog = Self {
            specs: BTreeMap::new(),
        };
        for spec in built_in_primitives() {
            catalog.specs.insert(spec.id.clone(), spec);
        }
        catalog
    }
}

impl PrimitiveCatalog {
    pub fn get(&self, id: &str) -> Option<&PrimitiveSpec> {
        self.specs.get(id)
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.specs.keys().map(String::as_str)
    }

    pub fn validate_recipe(&self, recipe: &ActionRecipe) -> Result<()> {
        if recipe.steps.is_empty() {
            return Err(KoniError::Workflow(format!(
                "action {} has no steps",
                recipe.id
            )));
        }
        let mut bindings = BTreeSet::new();
        let mut irreversible_seen = false;
        for (index, step) in recipe.steps.iter().enumerate() {
            let spec = self.get(&step.primitive).ok_or_else(|| {
                KoniError::Workflow(format!(
                    "action {} step {} uses unknown primitive {}",
                    recipe.id, index, step.primitive
                ))
            })?;
            validate_args(&recipe.id, index, spec, &step.args)?;
            validate_templates(&recipe.id, index, &step.args, &recipe.parameters, &bindings)?;
            if irreversible_seen && spec.effect != Effect::Read {
                return Err(KoniError::Workflow(format!(
                    "action {} mutates after an irreversible step at index {index}",
                    recipe.id
                )));
            }
            if spec.irreversible {
                irreversible_seen = true;
                if recipe.recovery_action.is_none() {
                    return Err(KoniError::Workflow(format!(
                        "action {} contains irreversible primitive {} without recovery_action",
                        recipe.id, spec.id
                    )));
                }
            } else if spec.effect > Effect::Read && !spec.reversible && step.compensate.is_none() {
                return Err(KoniError::Workflow(format!(
                    "action {} step {} ({}) mutates without built-in reversibility or compensation",
                    recipe.id, index, spec.id
                )));
            }
            if let Some(compensation) = &step.compensate {
                let compensation_spec = self.get(&compensation.primitive).ok_or_else(|| {
                    KoniError::Workflow(format!(
                        "action {} step {} compensation uses unknown primitive {}",
                        recipe.id, index, compensation.primitive
                    ))
                })?;
                validate_args(&recipe.id, index, compensation_spec, &compensation.args)?;
            }
            if let Some(binding) = &step.bind
                && !bindings.insert(binding.clone())
            {
                return Err(KoniError::Workflow(format!(
                    "action {} repeats binding {binding}",
                    recipe.id
                )));
            }
        }
        Ok(())
    }
}

fn validate_args(
    action_id: &str,
    index: usize,
    spec: &PrimitiveSpec,
    args: &BTreeMap<String, Value>,
) -> Result<()> {
    for (name, expected) in &spec.required_args {
        let value = args.get(name).ok_or_else(|| {
            KoniError::Workflow(format!(
                "action {action_id} step {index} primitive {} is missing {name}",
                spec.id
            ))
        })?;
        if !is_template(value) && !expected.accepts(value) {
            return Err(KoniError::Workflow(format!(
                "action {action_id} step {index} primitive {} argument {name} has the wrong type",
                spec.id
            )));
        }
    }
    for name in args.keys() {
        if !spec.required_args.contains_key(name) && !spec.optional_args.contains_key(name) {
            return Err(KoniError::Workflow(format!(
                "action {action_id} step {index} primitive {} does not accept argument {name}",
                spec.id
            )));
        }
    }
    Ok(())
}

fn validate_templates(
    action_id: &str,
    index: usize,
    args: &BTreeMap<String, Value>,
    parameters: &BTreeMap<String, ParameterSpec>,
    bindings: &BTreeSet<String>,
) -> Result<()> {
    for reference in template_references(&Value::Object(args.clone().into_iter().collect())) {
        let root = reference.split('.').next().unwrap_or_default();
        if root == "run" || root == "profile" || root == "repo" {
            continue;
        }
        if let Some(parameter) = reference.strip_prefix("params.") {
            let name = parameter.split('.').next().unwrap_or_default();
            if parameters.contains_key(name) {
                continue;
            }
        }
        if let Some(binding) = reference.strip_prefix("steps.") {
            let name = binding.split('.').next().unwrap_or_default();
            if bindings.contains(name) {
                continue;
            }
        }
        return Err(KoniError::Workflow(format!(
            "action {action_id} step {index} references unavailable template value {reference}"
        )));
    }
    Ok(())
}

fn template_references(value: &Value) -> Vec<String> {
    match value {
        Value::String(value) => {
            let mut output = Vec::new();
            let mut rest = value.as_str();
            while let Some(start) = rest.find("${") {
                rest = &rest[start + 2..];
                let Some(end) = rest.find('}') else {
                    break;
                };
                output.push(rest[..end].to_owned());
                rest = &rest[end + 1..];
            }
            output
        }
        Value::Array(values) => values.iter().flat_map(template_references).collect(),
        Value::Object(values) => values.values().flat_map(template_references).collect(),
        _ => Vec::new(),
    }
}

fn is_template(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| value.starts_with("${") && value.ends_with('}'))
}

pub trait PrimitiveHost {
    fn execute(&mut self, primitive: &str, args: &BTreeMap<String, Value>) -> Result<Value>;
    fn compensate(&mut self, primitive: &str, args: &BTreeMap<String, Value>) -> Result<()> {
        self.execute(primitive, args).map(|_| ())
    }
}

pub struct WorkflowVm<'a, H> {
    store: &'a StateStore,
    profile_hash: &'a str,
    catalog: PrimitiveCatalog,
    host: &'a mut H,
}

impl<'a, H: PrimitiveHost> WorkflowVm<'a, H> {
    pub fn new(store: &'a StateStore, profile_hash: &'a str, host: &'a mut H) -> Self {
        Self {
            store,
            profile_hash,
            catalog: PrimitiveCatalog::default(),
            host,
        }
    }

    pub fn execute(
        &mut self,
        recipe: &ActionRecipe,
        provided: BTreeMap<String, Value>,
        context: BTreeMap<String, Value>,
    ) -> Result<Value> {
        self.catalog.validate_recipe(recipe)?;
        let parameters = resolve_parameters(recipe, provided)?;
        let mut values = context;
        values.insert(
            "params".to_owned(),
            Value::Object(parameters.clone().into_iter().collect()),
        );
        let mut journal = Journal {
            id: Uuid::now_v7().to_string(),
            action: recipe.id.clone(),
            input_hash: Some(normalized_hash(&json!({
                "recipe": recipe.id,
                "profile_hash": self.profile_hash,
                "parameters": parameters,
            }))),
            status: JournalStatus::Running,
            started_at: Utc::now(),
            profile_hash: self.profile_hash.to_owned(),
            completed_steps: Vec::new(),
            outputs: BTreeMap::new(),
            error: None,
        };
        self.store.write_journal(&journal)?;
        let mut completed: Vec<(usize, BTreeMap<String, Value>)> = Vec::new();
        for (index, step) in recipe.steps.iter().enumerate() {
            let args = resolve_value(
                &Value::Object(step.args.clone().into_iter().collect()),
                &values,
            )?;
            let args: BTreeMap<String, Value> = args
                .as_object()
                .expect("resolved action args remain an object")
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            match self.host.execute(&step.primitive, &args) {
                Ok(output) => {
                    if let Some(binding) = &step.bind {
                        values
                            .entry("steps".to_owned())
                            .or_insert_with(|| Value::Object(Default::default()))
                            .as_object_mut()
                            .expect("steps context is an object")
                            .insert(binding.clone(), output.clone());
                        journal.outputs.insert(binding.clone(), output);
                    }
                    journal.completed_steps.push(index);
                    completed.push((index, args));
                    self.store.write_journal(&journal)?;
                }
                Err(error) => {
                    journal.error = Some(error.to_string());
                    journal.status = JournalStatus::Compensating;
                    self.store.write_journal(&journal)?;
                    let compensation_error = self.compensate(recipe, &completed, &values).err();
                    journal.status = JournalStatus::Failed;
                    if let Some(compensation_error) = compensation_error {
                        journal.error = Some(format!(
                            "{error}; compensation failed: {compensation_error}"
                        ));
                    }
                    self.store.write_journal(&journal)?;
                    return Err(error);
                }
            }
        }
        journal.status = JournalStatus::Complete;
        self.store.write_journal(&journal)?;
        Ok(Value::Object(journal.outputs.into_iter().collect()))
    }

    fn compensate(
        &mut self,
        recipe: &ActionRecipe,
        completed: &[(usize, BTreeMap<String, Value>)],
        values: &BTreeMap<String, Value>,
    ) -> Result<()> {
        for (index, _) in completed.iter().rev() {
            let step = &recipe.steps[*index];
            let spec = self
                .catalog
                .get(&step.primitive)
                .expect("recipe was validated");
            if let Some(compensation) = &step.compensate {
                let args = resolve_value(
                    &Value::Object(compensation.args.clone().into_iter().collect()),
                    values,
                )?;
                let args = args
                    .as_object()
                    .expect("compensation args remain object")
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
                self.host.compensate(&compensation.primitive, &args)?;
            } else if spec.reversible {
                let args =
                    BTreeMap::from([("journal_step".to_owned(), Value::from(*index as u64))]);
                self.host.compensate(&step.primitive, &args)?;
            }
        }
        Ok(())
    }
}

fn resolve_parameters(
    recipe: &ActionRecipe,
    mut values: BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>> {
    for (name, spec) in &recipe.parameters {
        if !values.contains_key(name) {
            if let Some(default) = &spec.default {
                values.insert(name.clone(), default.clone());
            } else if spec.required {
                return Err(KoniError::Action(format!(
                    "action {} requires parameter {name}",
                    recipe.id
                )));
            }
        }
        if let Some(value) = values.get(name)
            && !spec.value_type.accepts(value)
        {
            return Err(KoniError::Action(format!(
                "action {} parameter {name} has the wrong type",
                recipe.id
            )));
        }
    }
    let unknown: Vec<_> = values
        .keys()
        .filter(|name| !recipe.parameters.contains_key(*name))
        .cloned()
        .collect();
    if !unknown.is_empty() {
        return Err(KoniError::Action(format!(
            "action {} received unknown parameters: {}",
            recipe.id,
            unknown.join(", ")
        )));
    }
    Ok(values)
}

fn resolve_value(value: &Value, context: &BTreeMap<String, Value>) -> Result<Value> {
    match value {
        Value::String(text)
            if text.starts_with("${") && text.ends_with('}') && text.matches("${").count() == 1 =>
        {
            lookup_context(context, &text[2..text.len() - 1]).cloned()
        }
        Value::String(text) => {
            let mut output = text.clone();
            for reference in template_references(value) {
                let replacement = lookup_context(context, &reference)?;
                let replacement = replacement
                    .as_str()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| replacement.to_string());
                output = output.replace(&format!("${{{reference}}}"), &replacement);
            }
            Ok(Value::String(output))
        }
        Value::Array(values) => values
            .iter()
            .map(|value| resolve_value(value, context))
            .collect(),
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| Ok((key.clone(), resolve_value(value, context)?)))
            .collect::<Result<serde_json::Map<_, _>>>()
            .map(Value::Object),
        _ => Ok(value.clone()),
    }
}

fn lookup_context<'a>(context: &'a BTreeMap<String, Value>, path: &str) -> Result<&'a Value> {
    let mut parts = path.split('.');
    let root = parts.next().unwrap_or_default();
    let mut value = context
        .get(root)
        .ok_or_else(|| KoniError::Action(format!("template value {path} is unavailable")))?;
    for part in parts {
        value = match value {
            Value::Object(map) => map.get(part),
            Value::Array(items) => part
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get(index)),
            _ => None,
        }
        .ok_or_else(|| KoniError::Action(format!("template value {path} is unavailable")))?;
    }
    Ok(value)
}

fn built_in_primitives() -> Vec<PrimitiveSpec> {
    let any = ValueType::Any;
    let string = ValueType::String;
    let object = ValueType::Object;
    let array = ValueType::Array;
    type PrimitiveDefinition<'a> = (
        &'a str,
        Effect,
        bool,
        bool,
        &'a [(&'a str, ValueType)],
        &'a [(&'a str, ValueType)],
    );
    let definitions: &[PrimitiveDefinition<'_>] = &[
        (
            "graph.validate",
            Effect::Read,
            false,
            false,
            &[],
            &[("scope", object)],
        ),
        (
            "graph.derive",
            Effect::StateWrite,
            true,
            false,
            &[],
            &[("ticket", string)],
        ),
        (
            "graph.apply_delta",
            Effect::StateWrite,
            true,
            false,
            &[("delta", object)],
            &[("policy", string)],
        ),
        (
            "state.transition",
            Effect::StateWrite,
            true,
            false,
            &[("ticket", string), ("to", string)],
            &[("from", string)],
        ),
        (
            "state.event.append",
            Effect::StateWrite,
            true,
            false,
            &[("type", string)],
            &[("ticket", string), ("data", any)],
        ),
        (
            "state.snapshot",
            Effect::StateWrite,
            true,
            false,
            &[("kind", string)],
            &[],
        ),
        (
            "state.lease.create",
            Effect::StateWrite,
            true,
            false,
            &[("ticket", string)],
            &[("branch", string), ("worktree", string)],
        ),
        (
            "state.lease.clear",
            Effect::StateWrite,
            true,
            false,
            &[("ticket", string)],
            &[],
        ),
        (
            "context.issue",
            Effect::FileWrite,
            true,
            false,
            &[("ticket", string)],
            &[("step", string)],
        ),
        (
            "output.record",
            Effect::StateWrite,
            true,
            false,
            &[("ticket", string), ("step", string), ("output", object)],
            &[],
        ),
        (
            "review.record",
            Effect::StateWrite,
            true,
            false,
            &[("ticket", string), ("status", string)],
            &[("notes", string)],
        ),
        (
            "process.run",
            Effect::Process,
            false,
            false,
            &[("check", string)],
            &[("variables", object)],
        ),
        (
            "agent.spawn",
            Effect::AgentSpawn,
            false,
            false,
            &[("role", string), ("prompt", string)],
            &[("ticket", string), ("step", string)],
        ),
        (
            "agent.await",
            Effect::Read,
            false,
            false,
            &[("ticket", string)],
            &[("timeout", ValueType::Integer)],
        ),
        (
            "git.assert_clean",
            Effect::Read,
            false,
            false,
            &[],
            &[("path", string)],
        ),
        (
            "git.worktree.create",
            Effect::GitWorktree,
            true,
            false,
            &[("branch", string), ("path", string), ("start", string)],
            &[],
        ),
        (
            "git.worktree.remove",
            Effect::GitWorktree,
            true,
            false,
            &[("path", string)],
            &[("force", ValueType::Boolean)],
        ),
        (
            "git.worktree.refresh",
            Effect::GitIndex,
            true,
            false,
            &[("ticket", string), ("onto", string)],
            &[],
        ),
        (
            "git.checkpoint",
            Effect::GitRef,
            true,
            false,
            &[("message", string)],
            &[("paths", array)],
        ),
        (
            "git.integrate.squash",
            Effect::GitRef,
            false,
            true,
            &[("source", string), ("target", string), ("message", string)],
            &[("trailers", object)],
        ),
        (
            "git.branch.delete",
            Effect::GitRef,
            true,
            false,
            &[("branch", string)],
            &[("force", ValueType::Boolean)],
        ),
        (
            "report.render",
            Effect::FileWrite,
            true,
            false,
            &[("template", string), ("output", string)],
            &[("context", object)],
        ),
        (
            "ticket.emit",
            Effect::StateWrite,
            true,
            false,
            &[("operation", string), ("targets", array)],
            &[("scope", object), ("workflow", string)],
        ),
        (
            "ticket.retire",
            Effect::StateWrite,
            true,
            false,
            &[("ticket", string), ("reason", string)],
            &[],
        ),
    ];
    definitions
        .iter()
        .map(
            |(id, effect, reversible, irreversible, required, optional)| PrimitiveSpec {
                id: (*id).to_owned(),
                effect: *effect,
                reversible: *reversible,
                irreversible: *irreversible,
                required_args: required
                    .iter()
                    .map(|(name, kind)| ((*name).to_owned(), *kind))
                    .collect(),
                optional_args: optional
                    .iter()
                    .map(|(name, kind)| ((*name).to_owned(), *kind))
                    .collect(),
            },
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Host {
        calls: Vec<String>,
        fail: Option<String>,
    }

    impl PrimitiveHost for Host {
        fn execute(&mut self, primitive: &str, _args: &BTreeMap<String, Value>) -> Result<Value> {
            self.calls.push(primitive.to_owned());
            if self.fail.as_deref() == Some(primitive) {
                return Err(KoniError::Action("injected".to_owned()));
            }
            Ok(serde_json::json!({"primitive": primitive}))
        }
    }

    fn transition_recipe() -> ActionRecipe {
        ActionRecipe {
            id: "start".to_owned(),
            description: String::new(),
            parameters: BTreeMap::from([(
                "ticket".to_owned(),
                ParameterSpec {
                    value_type: ValueType::String,
                    required: true,
                    default: None,
                },
            )]),
            steps: vec![ActionStep {
                primitive: "state.transition".to_owned(),
                args: BTreeMap::from([
                    (
                        "ticket".to_owned(),
                        Value::String("${params.ticket}".to_owned()),
                    ),
                    ("to".to_owned(), Value::String("in_progress".to_owned())),
                ]),
                bind: Some("transition".to_owned()),
                compensate: None,
            }],
            recovery_action: None,
            aliases: Vec::new(),
        }
    }

    #[test]
    fn validates_and_executes_recipe() {
        let temp = tempfile::tempdir().unwrap();
        let store = StateStore::new(temp.path().to_path_buf());
        store.ensure_layout().unwrap();
        let mut host = Host::default();
        let mut vm = WorkflowVm::new(&store, "profile", &mut host);
        let result = vm
            .execute(
                &transition_recipe(),
                BTreeMap::from([("ticket".to_owned(), Value::String("TK-1".to_owned()))]),
                BTreeMap::new(),
            )
            .unwrap();
        assert_eq!(result["transition"]["primitive"], "state.transition");
        assert_eq!(host.calls, vec!["state.transition"]);
    }

    #[test]
    fn irreversible_step_requires_recovery() {
        let mut recipe = transition_recipe();
        recipe.steps = vec![ActionStep {
            primitive: "git.integrate.squash".to_owned(),
            args: BTreeMap::from([
                ("source".to_owned(), Value::String("ticket".to_owned())),
                ("target".to_owned(), Value::String("main".to_owned())),
                (
                    "message".to_owned(),
                    Value::String("feat: ticket".to_owned()),
                ),
            ]),
            bind: None,
            compensate: None,
        }];
        assert!(
            PrimitiveCatalog::default()
                .validate_recipe(&recipe)
                .is_err()
        );
    }
}
