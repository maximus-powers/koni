import type {
  CompiledAgentResource,
  CompiledRunType,
  ConfigurationObject,
} from "./configuration.js";

export interface ResolvedCompiledAgent {
  readonly id: string;
  readonly role: string;
  readonly resource: CompiledAgentResource;
  readonly description: string;
  readonly instructions: string;
  readonly instruction_source: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking_level?: string;
  readonly capabilities: ConfigurationObject;
  readonly run_type?: CompiledRunType;
}

export interface ResolveCompiledAgentOptions {
  readonly runTypeId?: string;
  /** Highest-precedence stage or one-run model override. */
  readonly model?: string;
  /** Highest-precedence stage or one-run provider-neutral reasoning override. */
  readonly thinkingLevel?: string;
}
