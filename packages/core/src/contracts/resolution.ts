import type {
  CompiledAgentResource,
  CompiledRunType,
  ConfigurationObject,
} from "./configuration.js";

export interface ResolvedCompiledPersona {
  readonly id: string;
  readonly model_role: string;
  readonly agent_id?: string;
  readonly agent_resource?: CompiledAgentResource;
  readonly description: string;
  readonly instructions: string;
  readonly instruction_source: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking_level?: string;
  readonly capabilities: ConfigurationObject;
  readonly skills: readonly string[];
  readonly run_type?: CompiledRunType;
}

export interface ResolveCompiledPersonaOptions {
  readonly runTypeId?: string;
  /** Highest-precedence stage or one-run model override. */
  readonly model?: string;
  /** Highest-precedence stage or one-run provider-neutral reasoning override. */
  readonly thinkingLevel?: string;
}
