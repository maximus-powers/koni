import { spawn } from "node:child_process";

const protocol = "koni.pi-attempt-process.v1";
const behavior = process.env.KONI_TEST_ATTEMPT_BEHAVIOR ?? "normal";
let launch;
let outputSequence = 0;
let input = "";
let descendant;

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
    send({ type: "ready", sessionFile: `${frame.spec.workspace.sessionDirectory}/${frame.spec.identity.sessionId}.jsonl` });
    if (behavior === "deferred") return;
    if (behavior === "crash") {
      setTimeout(() => process.exit(23), 10);
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
            result: `${process.env.KONI_TEST_PROVIDER_CREDENTIAL}:${process.env.NODE_OPTIONS ?? "no-node-options"}`,
          },
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 },
        },
      });
      finish();
      return;
    }
    if (behavior === "stuck" || behavior === "descendant") {
      process.on("SIGTERM", () => {});
      if (behavior === "descendant") {
        descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
          stdio: "ignore",
        });
        send({ type: "event", event: { type: "pi_lifecycle", eventType: `fixture_descendant:${descendant.pid}` } });
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
    if (!frame.ok || frame.requestId !== "request-reject" || frame.value.outcome !== "rejected") process.exit(93);
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

  if (frame.type === "control" && behavior !== "stuck" && behavior !== "descendant") {
    send({ type: "control_result", controlId: frame.controlId, ok: true });
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
          terminalOutput: { result: `${frame.message.mode}:${frame.message.sequence}:${frame.message.sha256}` },
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
  process.stdout.write(`${JSON.stringify({
    ...body,
    protocol,
    attemptId: launch.attemptId,
    specHash: launch.specHash,
    sequence: ++outputSequence,
  })}\n`);
}

function finish() {
  process.stdin.pause();
  process.stdin.removeAllListeners();
  setTimeout(() => process.exit(0), 10);
}
