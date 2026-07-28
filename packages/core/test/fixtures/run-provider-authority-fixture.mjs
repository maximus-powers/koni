import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const protocol = "koni.pi-attempt-process.v1";
const scenario = process.env.KONI_TEST_PROVIDER_SCENARIO ?? "normal";
let launch;
let activationToken;
let sequence = 0;
let input = "";
let sessionFile;
let assistantEntry;
let reservationId;
let secondAssistantEntry;
let secondReservationId;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    onFrame(JSON.parse(line));
  }
});
process.stdin.resume();

function onFrame(frame) {
  if (launch === undefined) {
    launch = frame;
    if (frame.type !== "launch" || frame.protocol !== protocol) process.exit(91);
    sessionFile = path.join(
      frame.spec.workspace.sessionDirectory,
      `${frame.spec.identity.sessionId}.jsonl`,
    );
    createTranscript(frame.spec);
    send({ type: "ready", sessionFile });
    return;
  }
  if (frame.type === "control" && frame.action === "activate") {
    activationToken = frame.activationToken;
    send({ type: "control_result", controlId: frame.controlId, ok: true });
    requestReservation();
    return;
  }
  if (frame.type === "control" && frame.action === "abort") {
    send({
      type: "control_result",
      controlId: frame.controlId,
      ok: true,
    });
    if (scenario === "pause_canonical_abort" && launch.spec.lineage.branchEpoch === 0) {
      appendCanonicalAbort();
    }
    send({
      type: "outcome",
      outcome: {
        status: "aborted",
        reason: frame.reason,
        usage: emptyUsage(),
      },
    });
    finish(0);
    return;
  }
  if (frame.type !== "authority_response") return;
  if (frame.requestId === "reserve") {
    if (!frame.ok || frame.value?.protocol !== "koni.provider-request-reservation.v1") {
      if (scenario === "context_window_headroom") {
        send({
          type: "outcome",
          outcome: {
            status: "failed",
            error: `first reservation rejected: ${frame.error ?? "invalid response"}`,
            usage: emptyUsage(),
          },
        });
        finish(23);
        return;
      }
      process.exit(92);
    }
    reservationId = frame.value.reservationId;
    if (scenario === "partial_assistant") {
      appendFileSync(
        sessionFile,
        '{"type":"message","id":"assistant","parentId":"baseline","message":{"role":"assistant"',
      );
      syncFile();
      finish(23);
      return;
    }
    if (scenario === "canonical_abort_recovery" && launch.spec.lineage.branchEpoch === 0) {
      appendCanonicalAbort();
      finish(23);
      return;
    }
    if (scenario === "pause_canonical_abort" && launch.spec.lineage.branchEpoch === 0) return;
    appendAssistant();
    if (
      (scenario === "failed_provider" ||
        scenario === "failed_provider_tool_call" ||
        scenario === "uncanonical_provider_error") &&
      launch.spec.lineage.branchEpoch === 0
    ) {
      finish(23);
      return;
    }
    if (scenario === "pause" || scenario === "delete") return;
    if (
      scenario === "response_overshoot" ||
      scenario === "synthesis_threshold" ||
      scenario === "context_window_headroom"
    ) {
      requestSettlement();
      return;
    }
    requestTerminal();
    return;
  }
  if (frame.requestId === "terminal") {
    if (!frame.ok || frame.value?.outcome !== "accepted") process.exit(93);
    if (scenario === "synthesis_threshold") {
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: { result: "provider-plan" },
          usage: usage(),
        },
      });
      finish(0);
      return;
    }
    requestSettlement();
    if (scenario === "lost_settlement_ack") {
      // Give the parent time to commit, then lose the response and process outcome projection.
      setTimeout(() => finish(23), 75);
    }
    return;
  }
  if (
    frame.requestId === "settle" &&
    (scenario === "normal" ||
      scenario === "torn_after_assistant" ||
      scenario.startsWith("assignment_terminal_"))
  ) {
    if (!frame.ok || frame.value?.protocol !== "koni.provider-request-settlement.v1")
      process.exit(94);
    if (
      scenario.startsWith("assignment_terminal_") &&
      launch.spec.identity.ticketId === "ticket-one"
    ) {
      // Leave the assignment process alive after authority has atomically compiled its terminal
      // tool. The parent test commits pause/delete before any child outcome can publish or tick.
      return;
    }
    send({
      type: "outcome",
      outcome: {
        status: "completed",
        terminalOutput: { result: "provider-plan" },
        usage: usage(),
      },
    });
    finish(0);
  }
  if (frame.requestId === "settle" && scenario === "response_overshoot") {
    if (!frame.ok || frame.value?.protocol !== "koni.provider-request-settlement.v1")
      process.exit(95);
    requestNextReservation();
  }
  if (frame.requestId === "settle" && scenario === "context_window_headroom") {
    if (!frame.ok || frame.value?.protocol !== "koni.provider-request-settlement.v1") {
      send({
        type: "outcome",
        outcome: {
          status: "failed",
          error: `first settlement rejected: ${frame.error ?? "invalid response"}`,
          usage: usage(),
        },
      });
      finish(23);
      return;
    }
    requestNextReservation();
  }
  if (frame.requestId === "settle" && scenario === "synthesis_threshold") {
    if (!frame.ok || frame.value?.protocol !== "koni.provider-request-settlement.v1")
      process.exit(97);
    requestSynthesisContext();
  }
  if (frame.requestId === "synthesis-context" && scenario === "synthesis_threshold") {
    const policy = frame.value?.runtimePolicy;
    if (
      !frame.ok ||
      policy?.protocol !== "koni.runtime-policy-context.v1" ||
      policy?.kind !== "planning_synthesis" ||
      typeof policy.content !== "string" ||
      !policy.content.includes("Stop reading, listing, or searching repository files")
    )
      process.exit(98);
    requestForbiddenRead();
  }
  if (frame.requestId === "synthesis-read" && scenario === "synthesis_threshold") {
    if (
      frame.ok ||
      typeof frame.error !== "string" ||
      !frame.error.includes("planning exploration is closed")
    ) {
      process.exit(99);
    }
    requestTerminal();
  }
  if (frame.requestId === "reserve-next" && scenario === "response_overshoot") {
    if (frame.ok) process.exit(96);
    send({
      type: "outcome",
      outcome: {
        status: "failed",
        error: "next provider request correctly denied after transcript overshoot",
        usage: usage(),
      },
    });
    finish(23);
  }
  if (frame.requestId === "reserve-next" && scenario === "context_window_headroom") {
    if (!frame.ok || frame.value?.protocol !== "koni.provider-request-reservation.v1")
      process.exit(101);
    secondReservationId = frame.value.reservationId;
    appendSecondAssistant();
    requestSecondTerminal();
  }
  if (frame.requestId === "terminal-second" && scenario === "context_window_headroom") {
    if (!frame.ok || frame.value?.outcome !== "accepted") process.exit(102);
    requestSecondSettlement();
  }
  if (frame.requestId === "settle-second" && scenario === "context_window_headroom") {
    if (!frame.ok || frame.value?.protocol !== "koni.provider-request-settlement.v1")
      process.exit(103);
    send({
      type: "outcome",
      outcome: {
        status: "completed",
        terminalOutput: { result: "provider-plan" },
        usage: combinedUsage(),
      },
    });
    finish(0);
  }
}

function createTranscript(spec) {
  mkdirSync(spec.workspace.sessionDirectory, { recursive: true, mode: 0o700 });
  const mapping = {
    type: "custom",
    id: "mapping",
    parentId: null,
    customType: "koni.attempt-session-map",
    data: {
      protocol: "koni.attempt-session-map.v1",
      specHash: spec.specHash,
      runId: spec.identity.runId,
      ticketId: spec.identity.ticketId,
      stepId: spec.identity.stepId,
      attemptId: spec.identity.attemptId,
      sessionId: spec.identity.sessionId,
      grantId: spec.authority.grantId,
      grantHash: spec.authority.grantHash,
      generation: spec.authority.generation,
      epoch: spec.authority.epoch,
      stateHash: spec.authority.expectedStateHash,
      resourceSetHash: spec.resources.setHash,
      model: spec.model,
      lineage: spec.lineage,
      sessionFile,
    },
  };
  const initial = {
    type: "message",
    id: "baseline",
    parentId: "mapping",
    message: {
      role: "user",
      content: [{ type: "text", text: spec.persona.initialPrompt }],
      timestamp: Date.now(),
    },
  };
  writeFileSync(
    sessionFile,
    jsonl(
      { type: "session", version: 3, id: spec.identity.sessionId, cwd: spec.workspace.cwd },
      mapping,
      initial,
    ),
    { mode: 0o600 },
  );
  chmodSync(sessionFile, 0o600);
  syncFile();
}

function requestReservation() {
  const payload =
    scenario === "context_window_headroom"
      ? sizedProviderPayload(103_386)
      : { model: launch.spec.model.id, input: [{ role: "user", content: "work" }], stream: true };
  const encoded = JSON.stringify(payload);
  send({
    type: "authority_request",
    requestId: "reserve",
    activationToken,
    request: {
      operation: "reserve_provider_request",
      request: {
        sequence: 1,
        api: launch.spec.model.api,
        modelId: launch.spec.model.id,
        payloadSha256: rawSha256(encoded),
        payloadSizeBytes: Buffer.byteLength(encoded),
        prospectiveInputTokens: estimateProviderInputTokens(Buffer.byteLength(encoded)),
        reservedOutputTokens: launch.spec.model.catalogMaxTokens,
      },
    },
  });
}

function appendAssistant() {
  const failed =
    (scenario === "failed_provider" ||
      scenario === "failed_provider_tool_call" ||
      scenario === "uncanonical_provider_error") &&
    launch.spec.lineage.branchEpoch === 0;
  const content =
    scenario === "response_overshoot"
      ? [{ type: "text", text: "x".repeat(1_100_000) }]
      : scenario === "context_window_headroom"
        ? [{ type: "text", text: "Inspecting the already-injected compiler context." }]
        : scenario === "synthesis_threshold"
          ? [{ type: "text", text: "Continue repository exploration." }]
          : failed || scenario === "pause" || scenario === "delete"
            ? failed
              ? scenario === "failed_provider_tool_call"
                ? [
                    {
                      type: "thinking",
                      thinking: "partial provider reasoning before a terminal error",
                    },
                    {
                      type: "toolCall",
                      id: "unaccepted-write-call",
                      name: "koni_write_file",
                      arguments: {
                        path: "never-written.txt",
                        expectedSha256: null,
                        content: "must not execute",
                      },
                    },
                  ]
                : [
                    {
                      type: "thinking",
                      thinking: "partial provider reasoning before a terminal error",
                    },
                  ]
              : [{ type: "text", text: "provider response" }]
            : [
                {
                  type: "toolCall",
                  id: "terminal-call",
                  name: launch.spec.terminal.toolName,
                  arguments: { result: "provider-plan" },
                },
              ];
  assistantEntry = {
    type: "message",
    id: "assistant",
    parentId: "baseline",
    message: {
      role: "assistant",
      content,
      api: launch.spec.model.api,
      provider: launch.spec.model.provider,
      model: launch.spec.model.id,
      usage: failed ? emptyPiUsage() : piUsage(),
      stopReason: failed ? "error" : content[0].type === "toolCall" ? "toolUse" : "stop",
      ...(failed
        ? {
            ...(scenario === "failed_provider" || scenario === "failed_provider_tool_call"
              ? { responseId: "resp_fixture_provider_error" }
              : {}),
            errorMessage: "Codex error: simulated terminal provider failure",
          }
        : {}),
      timestamp: Date.now(),
    },
  };
  appendFileSync(sessionFile, `${JSON.stringify(assistantEntry)}\n`);
  if (scenario === "torn_after_assistant") {
    appendFileSync(sessionFile, '{"type":"custom","id":"torn-tail"');
  }
  syncFile();
}

function appendCanonicalAbort() {
  assistantEntry = {
    type: "message",
    id: "assistant-aborted",
    parentId: "baseline",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "partial streamed reasoning" }],
      api: launch.spec.model.api,
      provider: launch.spec.model.provider,
      model: launch.spec.model.id,
      usage: emptyPiUsage(),
      stopReason: "aborted",
      responseId: "resp_fixture_canonical_abort",
      errorMessage: "Request was aborted",
      timestamp: Date.now(),
    },
  };
  appendFileSync(sessionFile, `${JSON.stringify(assistantEntry)}\n`);
  syncFile();
}

function appendSecondAssistant() {
  secondAssistantEntry = {
    type: "message",
    id: "assistant-second",
    parentId: assistantEntry.id,
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "terminal-call-second",
          name: launch.spec.terminal.toolName,
          arguments: { result: "provider-plan" },
        },
      ],
      api: launch.spec.model.api,
      provider: launch.spec.model.provider,
      model: launch.spec.model.id,
      usage: secondPiUsage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
  };
  appendFileSync(sessionFile, `${JSON.stringify(secondAssistantEntry)}\n`);
  syncFile();
}

function requestNextReservation() {
  const payload =
    scenario === "context_window_headroom"
      ? sizedProviderPayload(99_290)
      : { model: launch.spec.model.id, input: [{ role: "user", content: "next" }], stream: true };
  const encoded = JSON.stringify(payload);
  send({
    type: "authority_request",
    requestId: "reserve-next",
    activationToken,
    request: {
      operation: "reserve_provider_request",
      request: {
        sequence: 2,
        api: launch.spec.model.api,
        modelId: launch.spec.model.id,
        payloadSha256: rawSha256(encoded),
        payloadSizeBytes: Buffer.byteLength(encoded),
        prospectiveInputTokens: estimateProviderInputTokens(Buffer.byteLength(encoded)),
        reservedOutputTokens: launch.spec.model.catalogMaxTokens,
      },
    },
  });
}

function sizedProviderPayload(targetBytes) {
  const payload = {
    model: launch.spec.model.id,
    input: [{ role: "user", content: "" }],
    stream: true,
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(payload));
  if (baseBytes > targetBytes) throw new Error("provider payload target is too small");
  payload.input[0].content = "x".repeat(targetBytes - baseBytes);
  if (Buffer.byteLength(JSON.stringify(payload)) !== targetBytes)
    throw new Error("provider payload target drifted");
  return payload;
}

function estimateProviderInputTokens(payloadSizeBytes) {
  return Math.ceil(payloadSizeBytes / 2) + 4 * 1024;
}

function requestSecondTerminal() {
  send({
    type: "authority_request",
    requestId: "terminal-second",
    activationToken,
    request: {
      operation: "invoke_tool",
      callId: "terminal-call-second",
      name: launch.spec.terminal.toolName,
      arguments: { result: "provider-plan" },
    },
  });
}

function requestSecondSettlement() {
  send({
    type: "authority_request",
    requestId: "settle-second",
    activationToken,
    request: {
      operation: "reconcile_provider_request",
      settlement: {
        sequence: 2,
        reservationId: secondReservationId,
        assistantEntryId: secondAssistantEntry.id,
        assistantEntrySha256: canonicalHash(secondAssistantEntry),
        usage: secondUsage(),
      },
    },
  });
}

function requestSynthesisContext() {
  send({
    type: "authority_request",
    requestId: "synthesis-context",
    activationToken,
    request: { operation: "load_bound_context" },
  });
}

function requestForbiddenRead() {
  send({
    type: "authority_request",
    requestId: "synthesis-read",
    activationToken,
    request: {
      operation: "invoke_tool",
      callId: "synthesis-read-call",
      name: "koni_read_file",
      arguments: { path: "README.md" },
    },
  });
}

function requestTerminal() {
  send({
    type: "authority_request",
    requestId: "terminal",
    activationToken,
    request: {
      operation: "invoke_tool",
      callId: "terminal-call",
      name: launch.spec.terminal.toolName,
      arguments: { result: "provider-plan" },
    },
  });
}

function requestSettlement() {
  send({
    type: "authority_request",
    requestId: "settle",
    activationToken,
    request: {
      operation: "reconcile_provider_request",
      settlement: {
        sequence: 1,
        reservationId,
        assistantEntryId: assistantEntry.id,
        assistantEntrySha256: canonicalHash(assistantEntry),
        usage: usage(),
      },
    },
  });
}

function usage() {
  if (scenario === "context_window_headroom") {
    return {
      input: 21_248,
      output: 146,
      cacheRead: 0,
      cacheWrite: 0,
      newTokens: 21_394,
      allTokens: 21_394,
    };
  }
  return { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, newTokens: 15, allTokens: 18 };
}

function secondUsage() {
  return {
    input: 22_000,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    newTokens: 22_020,
    allTokens: 22_020,
  };
}

function combinedUsage() {
  return {
    input: 43_248,
    output: 166,
    cacheRead: 0,
    cacheWrite: 0,
    newTokens: 43_414,
    allTokens: 43_414,
  };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 };
}

function piUsage() {
  if (scenario === "context_window_headroom") {
    return {
      input: 21_248,
      output: 146,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 21_394,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  return {
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function secondPiUsage() {
  return {
    input: 22_000,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 22_020,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function send(body) {
  process.stdout.write(
    `${JSON.stringify({
      ...body,
      protocol,
      attemptId: launch.attemptId,
      specHash: launch.specHash,
      sequence: ++sequence,
    })}\n`,
  );
}

function syncFile() {
  const fd = openSync(sessionFile, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function jsonl(...values) {
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
}

function rawSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalHash(value) {
  return rawSha256(canonicalEncode(value));
}

function canonicalEncode(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalEncode).join(",")}]`;
  const keys = Object.keys(value).sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalEncode(value[key])}`).join(",")}}`;
}

function finish(code) {
  process.stdin.pause();
  process.stdin.removeAllListeners();
  setTimeout(() => process.exit(code), 10);
}
