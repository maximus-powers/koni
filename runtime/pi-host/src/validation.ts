import { HostError } from "./errors.js";
import type {
  CredentialBrokerRequest,
  RuntimeCommand,
  RuntimeControl,
  RuntimeInput,
  RuntimeModelRef,
  RuntimeSessionStart,
  RuntimeThinkingLevel,
  RuntimeToolDefinition,
  RuntimeTurnRequest,
} from "./wire-types.js";

const THINKING_LEVELS = new Set<RuntimeThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HostError("INVALID_REQUEST", `${name} must be an object`);
  return value;
}

export function requireString(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {},
): string {
  const min = options.min ?? 1;
  const max = options.max ?? 1024 * 1024;
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HostError("INVALID_REQUEST", `${name} must contain ${min}..=${max} characters`);
  }
  return value;
}

export function requireId(value: unknown, name: string): string {
  const result = requireString(value, name, { max: 128 });
  if (result.trim() !== result || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new HostError("INVALID_REQUEST", `${name} contains whitespace or control characters`);
  }
  return result;
}

function optionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new HostError("INVALID_REQUEST", `${name} must be an array`);
  return value.map((entry, index) => requireString(entry, `${name}[${index}]`, { max: 64 }));
}

function parseModel(value: unknown): RuntimeModelRef {
  const model = requireRecord(value, "start_session.model");
  const thinking = requireString(model["thinking_level"], "start_session.model.thinking_level", { max: 16 });
  if (!THINKING_LEVELS.has(thinking as RuntimeThinkingLevel)) {
    throw new HostError("INVALID_REQUEST", `unsupported thinking level ${thinking}`);
  }
  const contextWindow = model["context_window"];
  if (
    contextWindow !== null &&
    (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
  ) {
    throw new HostError("INVALID_REQUEST", "start_session.model.context_window must be a positive integer or null");
  }
  return {
    provider: requireId(model["provider"], "start_session.model.provider"),
    model: requireId(model["model"], "start_session.model.model"),
    thinking_level: thinking as RuntimeThinkingLevel,
    input_capabilities: optionalStringArray(model["input_capabilities"], "start_session.model.input_capabilities"),
    context_window: contextWindow,
  };
}

function parseTools(value: unknown): RuntimeToolDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new HostError("INVALID_REQUEST", "start_session.tools must have at most 128 entries");
  }
  const names = new Set<string>();
  return value.map((entry, index) => {
    const tool = requireRecord(entry, `start_session.tools[${index}]`);
    const name = requireId(tool["name"], `start_session.tools[${index}].name`);
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name)) {
      throw new HostError("INVALID_REQUEST", `start_session.tools[${index}].name is invalid`);
    }
    if (names.has(name)) throw new HostError("INVALID_REQUEST", `duplicate tool ${name}`);
    names.add(name);
    const inputSchema = requireRecord(tool["input_schema"], `start_session.tools[${index}].input_schema`);
    if (inputSchema["type"] !== "object") {
      throw new HostError("INVALID_REQUEST", `start_session.tools[${index}] requires an object input schema`);
    }
    return {
      name,
      description: requireString(tool["description"], `start_session.tools[${index}].description`, { max: 8192 }),
      input_schema: structuredClone(inputSchema),
    };
  });
}

function parseTerminalBoundaryTools(
  value: unknown,
  tools: readonly RuntimeToolDefinition[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new HostError(
      "INVALID_REQUEST",
      "start_session.terminal_boundary_tools must have at most 8 entries",
    );
  }
  const declaredTools = new Set(tools.map((tool) => tool.name));
  const terminalTools = new Set<string>();
  return value.map((entry, index) => {
    const name = requireId(
      entry,
      `start_session.terminal_boundary_tools[${index}]`,
    );
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(name)) {
      throw new HostError(
        "INVALID_REQUEST",
        `start_session.terminal_boundary_tools[${index}] is invalid`,
      );
    }
    if (terminalTools.has(name)) {
      throw new HostError("INVALID_REQUEST", `duplicate terminal boundary tool ${name}`);
    }
    if (!declaredTools.has(name)) {
      throw new HostError(
        "INVALID_REQUEST",
        `terminal boundary tool ${name} is not declared in start_session.tools`,
      );
    }
    terminalTools.add(name);
    return name;
  });
}

function parseStartSession(value: unknown): RuntimeSessionStart {
  const request = requireRecord(value, "start_session.request");
  const attempt = request["attempt"];
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 0xffff_ffff) {
    throw new HostError("INVALID_REQUEST", "start_session.attempt must be a u32 integer");
  }
  const tools = parseTools(request["tools"]);
  return {
    session_id: requireId(request["session_id"], "start_session.session_id"),
    run_id: requireId(request["run_id"], "start_session.run_id"),
    agent_id: requireId(request["agent_id"], "start_session.agent_id"),
    attempt,
    model: parseModel(request["model"]),
    instructions: requireString(request["instructions"], "start_session.instructions", { min: 0 }),
    tools,
    terminal_boundary_tools: parseTerminalBoundaryTools(
      request["terminal_boundary_tools"],
      tools,
    ),
    context_completion_required:
      request["context_completion_required"] === undefined
        ? false
        : typeof request["context_completion_required"] === "boolean"
          ? request["context_completion_required"]
          : (() => {
              throw new HostError(
                "INVALID_REQUEST",
                "start_session.context_completion_required must be a boolean",
              );
            })(),
    credential_lease: requireId(request["credential_lease"], "start_session.credential_lease"),
  };
}

function parseInputs(value: unknown): RuntimeInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new HostError("INVALID_REQUEST", "start_turn.input must contain 1..=64 entries");
  }
  return value.map((entry, index) => {
    const input = requireRecord(entry, `start_turn.input[${index}]`);
    if (input["kind"] === "text") {
      return { kind: "text", text: requireString(input["text"], `start_turn.input[${index}].text`, { min: 0 }) };
    }
    if (input["kind"] === "image") {
      return {
        kind: "image",
        media_type: requireString(input["media_type"], `start_turn.input[${index}].media_type`, { max: 128 }),
        sha256: requireString(input["sha256"], `start_turn.input[${index}].sha256`, { max: 64 }),
        data_base64: requireString(input["data_base64"], `start_turn.input[${index}].data_base64`, { max: 1024 * 1024 }),
      };
    }
    throw new HostError("INVALID_REQUEST", `start_turn.input[${index}] has an unknown kind`);
  });
}

function parseStartTurn(value: unknown): RuntimeTurnRequest {
  const request = requireRecord(value, "start_turn.request");
  const outputSchema = request["output_schema"];
  if (outputSchema !== null && !isRecord(outputSchema)) {
    throw new HostError("INVALID_REQUEST", "start_turn.output_schema must be an object or null");
  }
  const budget = request["output_token_budget"];
  if (budget !== null && (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0)) {
    throw new HostError("INVALID_REQUEST", "start_turn.output_token_budget must be a positive integer or null");
  }
  return {
    turn_id: requireId(request["turn_id"], "start_turn.turn_id"),
    input: parseInputs(request["input"]),
    output_schema: outputSchema === null ? null : structuredClone(outputSchema),
    output_token_budget: budget,
  };
}

function parseControl(value: unknown): RuntimeControl {
  const control = requireRecord(value, "control");
  if (control["control"] === "steer" || control["control"] === "follow_up") {
    return {
      control: control["control"],
      text: requireString(control["text"], `control.${control["control"]}.text`, { min: 0 }),
    };
  }
  if (control["control"] === "cancel") {
    return { control: "cancel", reason: requireString(control["reason"], "control.cancel.reason", { min: 0 }) };
  }
  throw new HostError("INVALID_REQUEST", "unknown runtime control");
}

function parseAuthRequest(value: unknown): CredentialBrokerRequest {
  const request = requireRecord(value, "authenticate.request");
  if (request["provider"] !== "open-ai-codex") {
    throw new HostError("INVALID_REQUEST", "authenticate provider must be open-ai-codex");
  }
  if (request["request"] === "status" || request["request"] === "logout") {
    return { request: request["request"], provider: "open-ai-codex" };
  }
  if (request["request"] === "begin_login") {
    if (request["preferred_flow"] !== "browser_pkce" && request["preferred_flow"] !== "device_code") {
      throw new HostError("INVALID_REQUEST", "authenticate preferred_flow is invalid");
    }
    return {
      request: "begin_login",
      provider: "open-ai-codex",
      preferred_flow: request["preferred_flow"],
    };
  }
  if (request["request"] === "acquire_lease") {
    return {
      request: "acquire_lease",
      provider: "open-ai-codex",
      session_id: requireId(request["session_id"], "authenticate.session_id"),
    };
  }
  throw new HostError("INVALID_REQUEST", "unknown credential broker request");
}

export function parseRuntimeCommand(value: unknown): RuntimeCommand {
  const command = requireRecord(value, "command");
  switch (command["command"]) {
    case "list_models":
      return { command: "list_models" };
    case "metadata":
      return { command: "metadata" };
    case "start_session":
      return { command: "start_session", request: parseStartSession(command["request"]) };
    case "start_turn":
      return { command: "start_turn", request: parseStartTurn(command["request"]) };
    case "control":
      return { command: "control", control: parseControl(command["control"]) };
    case "authenticate":
      return {
        command: "authenticate",
        credential_lease: requireId(command["credential_lease"], "authenticate.credential_lease"),
        request: parseAuthRequest(command["request"]),
      };
    case "shutdown":
      return { command: "shutdown" };
    default:
      throw new HostError("INVALID_REQUEST", "unknown runtime command");
  }
}
