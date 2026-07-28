import { spawn } from "node:child_process";

const protocol = "koni.pi-attempt-process.v1";
const behavior = process.env.KONI_TEST_ATTEMPT_BEHAVIOR ?? "normal";
let launch;
let outputSequence = 0;
let input = "";
let descendant;
let recoveryClaimToken;
let activationToken;

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
    if (behavior === "authority_before_ready") {
      send({
        type: "authority_request",
        requestId: "before-ready",
        request: {
          operation: "invoke_tool",
          callId: "before-ready-call",
          name: frame.spec.terminal.toolName,
          arguments: { result: "must-not-run" },
        },
      });
      return;
    }
    if (behavior === "recovery_admission") {
      send({
        type: "authority_request",
        requestId: "recovery-context",
        request: { operation: "load_bound_context" },
      });
      return;
    }
    if (behavior === "protocol_before_ready") {
      send({ type: "event", event: { type: "pi_lifecycle", eventType: "must-not-precede-ready" } });
      setInterval(() => {}, 1_000);
      return;
    }
    send({
      type: "ready",
      sessionFile: `${frame.spec.workspace.sessionDirectory}/${frame.spec.identity.sessionId}.jsonl`,
    });
    if (behavior === "authority_before_activation") {
      send({
        type: "authority_request",
        requestId: "before-activation",
        request: {
          operation: "invoke_tool",
          callId: "before-activation-call",
          name: frame.spec.terminal.toolName,
          arguments: { result: "must-not-run" },
        },
      });
      return;
    }
    if (behavior === "deferred" || behavior === "provider_authority") return;
    if (behavior === "crash") {
      setTimeout(() => process.exit(23), 10);
      return;
    }
    if (behavior === "failed_code") {
      send({
        type: "outcome",
        outcome: {
          status: "failed",
          code: "provider_admission",
          error: "input budget cannot reserve the prospective provider input",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
    if (behavior === "crash_descendant") {
      descendant = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
        {
          stdio: "ignore",
        },
      );
      send({
        type: "event",
        event: { type: "pi_lifecycle", eventType: `fixture_descendant:${descendant.pid}` },
      });
      setTimeout(() => process.exit(23), 10);
      return;
    }
    if (behavior === "sentinel_crash_descendant") {
      descendant = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
        {
          stdio: "ignore",
        },
      );
      send({
        type: "event",
        event: { type: "pi_lifecycle", eventType: `fixture_descendant:${descendant.pid}` },
      });
      setTimeout(() => {
        process.kill(process.ppid, "SIGKILL");
        setInterval(() => {}, 1_000);
      }, 10);
      return;
    }
    if (behavior === "authority") {
      send({
        type: "authority_request",
        requestId: "request-one",
        request: {
          operation: "invoke_tool",
          callId: "call-one",
          name: frame.spec.terminal.toolName,
          arguments: { result: "fixture" },
        },
      });
      return;
    }
    if (behavior === "authority_reject") {
      send({
        type: "authority_request",
        requestId: "request-reject",
        request: {
          operation: "reject_tool",
          callId: "call-reject",
          name: frame.spec.terminal.toolName,
          arguments: { result: "fixture" },
          rejection: {
            code: "transcript_result_budget",
            summary: `Tool was not executed because its worst-case result would exceed this attempt's ${frame.spec.budgets.transcript.maxBytes}-byte transcript budget.`,
          },
        },
      });
      return;
    }
    if (behavior === "message") return;
    if (behavior === "environment") {
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: {
            result: [
              process.env.KONI_TEST_PROVIDER_CREDENTIAL,
              process.env.NODE_OPTIONS ?? "no-node-options",
              `aws-${process.env.AWS_MAX_ATTEMPTS ?? "unset"}`,
              `home-${process.env.HOME ?? "unset"}`,
              `agent-${process.env.PI_CODING_AGENT_DIR ?? "unset"}`,
            ].join(":"),
          },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
    if (behavior === "normal_descendant") {
      descendant = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
        {
          stdio: "ignore",
        },
      );
      send({
        type: "event",
        event: { type: "pi_lifecycle", eventType: `fixture_descendant:${descendant.pid}` },
      });
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: { result: "descendant-retired" },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
    if (behavior === "stuck" || behavior === "descendant") {
      process.on("SIGTERM", () => {});
      if (behavior === "descendant") {
        descendant = spawn(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
          {
            stdio: "ignore",
          },
        );
        send({
          type: "event",
          event: { type: "pi_lifecycle", eventType: `fixture_descendant:${descendant.pid}` },
        });
      }
      setInterval(() => {}, 1_000);
      return;
    }
    send({
      type: "event",
      event: {
        type: "usage",
        usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, newTokens: 5, allTokens: 17 },
      },
    });
    send({
      type: "outcome",
      outcome: {
        status: "completed",
        terminalOutput: { result: "ok" },
        usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, newTokens: 5, allTokens: 17 },
      },
    });
    finish();
    return;
  }

  if (frame.type === "authority_response" && behavior === "authority_before_ready") {
    if (frame.ok || frame.requestId !== "before-ready") process.exit(94);
    send({
      type: "ready",
      sessionFile: `${launch.spec.workspace.sessionDirectory}/${launch.spec.identity.sessionId}.jsonl`,
    });
    return;
  }
  if (frame.type === "authority_response" && behavior === "authority_before_activation") {
    if (frame.requestId === "before-activation") {
      if (frame.ok) process.exit(95);
      return;
    }
    if (frame.requestId === "after-activation") {
      if (!frame.ok) process.exit(96);
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: { result: "activation-gated" },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
  }
  if (frame.type === "authority_response" && behavior === "recovery_admission") {
    if (frame.requestId === "recovery-context") {
      if (!frame.ok) process.exit(97);
      send({
        type: "authority_request",
        requestId: "recovery-effect",
        request: {
          operation: "invoke_tool",
          callId: "arbitrary-recovery-call",
          name: launch.spec.terminal.toolName,
          arguments: { result: "must-not-run" },
        },
      });
      return;
    }
    if (frame.requestId === "recovery-effect") {
      if (frame.ok) process.exit(98);
      send({
        type: "ready",
        sessionFile: `${launch.spec.workspace.sessionDirectory}/${launch.spec.identity.sessionId}.jsonl`,
      });
      return;
    }
    if (frame.requestId === "recovery-claim") {
      if (!frame.ok || typeof frame.value?.claimToken !== "string") process.exit(99);
      recoveryClaimToken = frame.value.claimToken;
      send({
        type: "authority_request",
        requestId: "recovery-release",
        activationToken,
        request: { operation: "release_recovery_claim", claimToken: recoveryClaimToken },
      });
      return;
    }
    if (frame.requestId === "recovery-release") {
      if (!frame.ok) process.exit(100);
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: { result: "recovery-gated" },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
  }

  if (frame.type === "authority_response" && behavior === "authority") {
    if (!frame.ok || frame.requestId !== "request-one") process.exit(92);
    send({
      type: "outcome",
      outcome: {
        status: "completed",
        terminalOutput: { result: "authority-ok" },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
      },
    });
    finish();
    return;
  }
  if (frame.type === "authority_response" && behavior === "authority_reject") {
    if (!frame.ok || frame.requestId !== "request-reject" || frame.value.outcome !== "rejected")
      process.exit(93);
    send({
      type: "outcome",
      outcome: {
        status: "completed",
        terminalOutput: { result: "rejection-recorded" },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
      },
    });
    finish();
    return;
  }
  if (frame.type === "authority_response" && behavior === "provider_authority") {
    if (frame.requestId === "provider-reserve") {
      if (
        !frame.ok ||
        frame.value?.protocol !== "koni.provider-request-reservation.v1" ||
        frame.value?.sequence !== 1
      )
        process.exit(101);
      send({
        type: "authority_request",
        requestId: "provider-settle",
        activationToken,
        request: {
          operation: "reconcile_provider_request",
          settlement: {
            sequence: 1,
            reservationId: frame.value.reservationId,
            assistantEntryId: "assistant-provider-one",
            assistantEntrySha256: `sha256:${"c".repeat(64)}`,
            usage: {
              input: 10,
              output: 5,
              cacheRead: 2,
              cacheWrite: 1,
              newTokens: 15,
              allTokens: 18,
            },
          },
        },
      });
      return;
    }
    if (frame.requestId === "provider-settle") {
      if (
        !frame.ok ||
        frame.value?.protocol !== "koni.provider-request-settlement.v1" ||
        frame.value?.assistantEntrySha256 !== `sha256:${"c".repeat(64)}`
      )
        process.exit(102);
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: { result: "provider-authority-ok" },
          usage: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            newTokens: 15,
            allTokens: 18,
          },
        },
      });
      finish();
      return;
    }
  }

  if (frame.type === "control" && behavior !== "stuck" && behavior !== "descendant") {
    if (frame.action === "activate") activationToken = frame.activationToken;
    if (behavior === "authority_before_activation" && frame.action === "activate") {
      // Deliberately issue the first authorized effect before acknowledging activation. The
      // parent must open the token gate immediately before sending the activation frame.
      send({
        type: "authority_request",
        requestId: "after-activation",
        activationToken,
        request: {
          operation: "invoke_tool",
          callId: "after-activation-call",
          name: launch.spec.terminal.toolName,
          arguments: { result: "allowed" },
        },
      });
      send({ type: "control_result", controlId: frame.controlId, ok: true });
      return;
    }
    if (behavior === "recovery_admission" && frame.action === "activate") {
      send({
        type: "authority_request",
        requestId: "recovery-claim",
        activationToken,
        request: { operation: "acquire_recovery_claim" },
      });
      send({ type: "control_result", controlId: frame.controlId, ok: true });
      return;
    }
    if (behavior === "provider_authority" && frame.action === "activate") {
      send({
        type: "authority_request",
        requestId: "provider-reserve",
        activationToken,
        request: {
          operation: "reserve_provider_request",
          request: {
            sequence: 1,
            api: launch.spec.model.api,
            modelId: launch.spec.model.id,
            payloadSha256: `sha256:${"b".repeat(64)}`,
            payloadSizeBytes: 64,
            prospectiveInputTokens: 4_112,
            reservedOutputTokens: launch.spec.model.catalogMaxTokens,
          },
        },
      });
      send({ type: "control_result", controlId: frame.controlId, ok: true });
      return;
    }
    send({ type: "control_result", controlId: frame.controlId, ok: true });
    if (behavior === "authority_before_ready" && frame.action === "activate") {
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: { result: "before-ready-denied" },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
    if (behavior === "deferred" && frame.action === "activate") {
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: { result: "activated" },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
    if (behavior === "message" && frame.action === "message") {
      send({
        type: "outcome",
        outcome: {
          status: "completed",
          terminalOutput: {
            result: `${frame.message.mode}:${frame.message.sequence}:${frame.message.sha256}`,
          },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
    if (frame.action === "abort") {
      send({
        type: "outcome",
        outcome: {
          status: "aborted",
          reason: frame.reason,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
    }
  }
}

function send(body) {
  process.stdout.write(
    `${JSON.stringify({
      ...body,
      protocol,
      attemptId: launch.attemptId,
      specHash: launch.specHash,
      sequence: ++outputSequence,
    })}\n`,
  );
}

function finish() {
  process.stdin.pause();
  process.stdin.removeAllListeners();
  setTimeout(() => process.exit(0), 10);
}
