/**
 * Runs outside the attempt process group from before worker admission. It is the sole retirement
 * command reader and may only observe the anchored group with signal 0. The in-group guardian is
 * the only destructive actor, so a coordinator retry can never signal a recycled numeric PGID.
 */
export const ATTEMPT_CLEANUP_COORDINATOR_SOURCE = String.raw`
const fs = require("node:fs");
const processGroupId = Number(process.argv[1]);
const fault = process.argv[2] || "none";
const initialAttempt = Number(process.argv[3] || "0");
const control = fs.createWriteStream(null, { fd: 3, autoClose: false });
const commands = fs.createReadStream(null, { fd: 4, autoClose: false });
const relay = fs.createWriteStream(null, { fd: 5, autoClose: false });
let commandBytes = "";
let absenceProven = false;
let destructiveBoundaryPublished = false;
let firstObservationFailed = false;
let firstAckDelayed = false;
let absenceFaultConsumed = false;
let observing = false;
let pendingAttempt;
let lastAttempt = 0;
let acknowledging = false;

const send = (value, callback) => {
  control.write(JSON.stringify(value) + "\n", callback);
};
const forward = (attempt, callback, coordinatorExiting = false) => {
  relay.write(JSON.stringify({
    type: "retire",
    attempt,
    ...(coordinatorExiting ? { coordinatorExiting: true } : {}),
  }) + "\n", callback);
};
control.on("error", () => {});
relay.on("error", () => {});
const fail = (attempt, error) => {
  observing = false;
  pendingAttempt = undefined;
  send({ type: "retirement_failed", attempt, error: String(error && error.message || error) });
};
const acknowledge = (attempt, absentWithoutSignal = false) => {
  if (acknowledging) return;
  acknowledging = true;
  absenceProven = true;
  commands.destroy();
  relay.end();
  control.end(JSON.stringify({
    type: "retirement_ack",
    attempt,
    ...(absentWithoutSignal ? { absentWithoutSignal: true } : {}),
  }) + "\n", () => process.exit(0));
};
const publishDestructiveBoundary = (attempt) => {
  if (destructiveBoundaryPublished) return;
  destructiveBoundaryPublished = true;
  send({ type: "retirement_signal", attempt });
};
const observeUntilGone = () => {
  const attempt = pendingAttempt;
  if (attempt === undefined || absenceProven) return;
  if (fault === "eperm_first_attempt" && attempt === 1) {
    // Deterministic seam: EPERM is never converted into absence. A later strictly increasing
    // authority attempt may resume real ESRCH observation without another numeric signal target.
    setTimeout(observeUntilGone, 5);
    return;
  }
  try {
    process.kill(-processGroupId, 0);
    setTimeout(observeUntilGone, 5);
  } catch (error) {
    if (error && error.code === "ESRCH") {
      if (fault === "exit_after_absence_once" && !absenceFaultConsumed) {
        absenceFaultConsumed = true;
        process.kill(process.pid, "SIGKILL");
        return;
      }
      absenceProven = true;
      publishDestructiveBoundary(attempt);
      if (fault === "delay_first_ack" && !firstAckDelayed) {
        firstAckDelayed = true;
        setTimeout(() => acknowledge(attempt), 100);
        return;
      }
      acknowledge(attempt);
      return;
    }
    if (error && error.code === "EPERM") {
      // EPERM is evidence only that absence is unproven. Keep observing; it must never be
      // converted into an ACK or used as authority for a second destructive target.
      setTimeout(observeUntilGone, 5);
      return;
    }
    fail(attempt, error);
  }
};
const retire = (attempt) => {
  try {
    if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) throw new Error("invalid process group");
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("invalid retirement attempt");
    if (process.platform === "win32") throw new Error("process-group retirement is unsupported on Windows");
    if (attempt <= lastAttempt) throw new Error("retirement attempts must increase");
    lastAttempt = attempt;
    if (absenceProven) {
      acknowledge(attempt, !destructiveBoundaryPublished);
      return;
    }
    pendingAttempt = attempt;
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") {
        acknowledge(attempt, true);
        return;
      }
      if (!(error && error.code === "EPERM")) throw error;
    }
    if (fault === "exit_after_dispatch_once") {
      forward(attempt, () => process.kill(process.pid, "SIGKILL"), true);
    } else {
      forward(attempt);
    }
    observing = true;
    if (fault === "fail_first_observation" && !firstObservationFailed) {
      firstObservationFailed = true;
      setTimeout(() => fail(attempt, new Error("simulated first absence-observation failure")), 10);
      return;
    }
    observeUntilGone();
  } catch (error) {
    fail(attempt, error);
  }
};

commands.setEncoding("utf8");
commands.on("data", (chunk) => {
  commandBytes += chunk;
  if (commandBytes.length > 1024) {
    fail(Math.max(lastAttempt, 1), new Error("retirement command exceeds its byte bound"));
    return;
  }
  for (;;) {
    const newline = commandBytes.indexOf("\n");
    if (newline < 0) break;
    const line = commandBytes.slice(0, newline);
    commandBytes = commandBytes.slice(newline + 1);
    const match = /^retire:([1-9][0-9]*)$/.exec(line);
    if (!match) {
      fail(Math.max(lastAttempt, 1), new Error("invalid retirement command"));
      continue;
    }
    retire(Number(match[1]));
  }
});
commands.once("end", () => {
  if (!absenceProven && !observing) retire(lastAttempt + 1);
});
if (fault === "exit_before_ready_once") {
  setImmediate(() => process.kill(process.pid, "SIGKILL"));
} else {
  relay.write(JSON.stringify({ type: "coordinator_ready" }) + "\n", () => {
    if (fault === "exit_after_ready_once") {
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
      return;
    }
    if (Number.isSafeInteger(initialAttempt) && initialAttempt > 0) retire(initialAttempt);
  });
}
setInterval(() => {}, 60_000);
`;

/**
 * Parent-supervised last-resort observer. It is detached from the attempt group, has no inherited
 * authority fd, and can only use signal 0. Exit 0 means ESRCH; every other exit is unproven.
 */
export const ATTEMPT_ABSENCE_OBSERVER_SOURCE = String.raw`
const processGroupId = Number(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
const initialDelayMs = Number(process.argv[3]);
const fault = process.argv[4] || "none";
const deadline = Date.now() + timeoutMs;
const observe = () => {
  if (fault === "exit_once") {
    process.kill(process.pid, "SIGKILL");
    return;
  }
  try {
    process.kill(-processGroupId, 0);
  } catch (error) {
    if (error && error.code === "ESRCH") process.exit(0);
    if (!(error && error.code === "EPERM")) process.exit(3);
  }
  if (Date.now() >= deadline) process.exit(2);
  setTimeout(observe, 5);
};
if (
  !Number.isSafeInteger(processGroupId) ||
  processGroupId < 1 ||
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs < 1 ||
  !Number.isSafeInteger(initialDelayMs) ||
  initialDelayMs < 0
) process.exit(4);
setTimeout(observe, initialDelayMs);
setInterval(() => {}, 60_000);
`;

/** The independent anchor remains in the attempt group if either worker or sentinel exits. */
export const ATTEMPT_GROUP_GUARDIAN_SOURCE = String.raw`
const fs = require("node:fs");
const executorFault = process.argv[1] || "none";
const lifecycleFault = process.argv[2] || "none";
const generation = Number(process.argv[3]);
const commands = fs.createReadStream(null, { fd: 4, autoClose: false });
const status = fs.createWriteStream(null, { fd: 5, autoClose: false });
let commandBytes = "";
let retiring = false;
if (lifecycleFault === "exit_before_ready_once") {
  setImmediate(() => process.kill(process.pid, "SIGKILL"));
} else {
  status.write(JSON.stringify({ type: "guardian_ready", generation }) + "\n");
}
if (lifecycleFault === "exit_before_signal_once") {
  setTimeout(() => {
    if (retiring) return;
    retiring = true;
    commands.pause();
    process.kill(process.pid, "SIGKILL");
  }, 100);
}
const retire = (attempt) => {
  if (retiring) return;
  retiring = true;
  commands.pause();
  if (executorFault === "exit_before_signal") {
    process.kill(process.pid, "SIGKILL");
    return;
  }
  try {
    // Destructive authority is capability-by-topology: this process may only kill its own group.
    // A successful call kills sentinel, worker, descendants, and this guardian atomically enough
    // that the sentinel cannot observe this guardian close and create a duplicate executor.
    process.kill(0, "SIGKILL");
  } catch (error) {
    retiring = false;
    commands.resume();
    status.write(JSON.stringify({
      type: "guardian_signal_failed",
      generation,
      attempt,
      error: String(error && error.message || error),
    }) + "\n");
  }
};
commands.setEncoding("utf8");
commands.on("data", (chunk) => {
  if (retiring) return;
  commandBytes += chunk;
  if (commandBytes.length > 1024) process.exit(87);
  for (;;) {
    const newline = commandBytes.indexOf("\n");
    if (newline < 0) break;
    const line = commandBytes.slice(0, newline);
    commandBytes = commandBytes.slice(newline + 1);
    const match = /^retire:([1-9][0-9]*)$/.exec(line);
    if (!match) process.exit(88);
    retire(Number(match[1]));
  }
});
// Sentinel death closes the private command pipe. This still-live identity anchor then retires the
// whole group without needing a numeric PGID or any out-of-group destructive authority.
commands.once("end", () => retire(0));
setInterval(() => {}, 60_000);
`;

// This bootstrap intentionally contains only Node built-ins and is passed as an argv byte string.
// It remains the detached process-group leader while the real attempt worker runs as a member of
// that group. A worker crash therefore cannot recycle the PGID before the authority retires every
// descendant. fd 3 is a sentinel-only channel; the worker never inherits it.
export const ATTEMPT_SENTINEL_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const workerArguments = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const guardianSource = Buffer.from(process.argv[2], "base64url").toString("utf8");
const coordinatorSource = Buffer.from(process.argv[3], "base64url").toString("utf8");
const cleanupFault = process.argv[4] || "none";
const initialGuardianFault = process.argv[5] || "none";
const control = fs.createWriteStream(null, { fd: 3, autoClose: false });
let worker;
let workerReported = false;
let guardianGeneration = 0;
let pendingRetirementAttempt;
let activeGuardianInput;
let activeGuardianReady = false;
let guardianForwardedAttempt;
let guardianSpawnError;
let executorFaultConsumed = false;
let coordinatorReady = false;
let workerStarted = false;
const reportWorker = (value) => {
  if (workerReported) return;
  workerReported = true;
  control.write(JSON.stringify(value) + "\n");
};
const reportGuardian = (value) => {
  control.write(JSON.stringify(value) + "\n");
};
const forwardRetirement = () => {
  if (
    !activeGuardianReady ||
    pendingRetirementAttempt === undefined ||
    !activeGuardianInput ||
    guardianForwardedAttempt === pendingRetirementAttempt
  ) return;
  guardianForwardedAttempt = pendingRetirementAttempt;
  activeGuardianInput.write("retire:" + String(pendingRetirementAttempt) + "\n");
};
const startWorker = () => {
  if (workerStarted || !coordinatorReady || !activeGuardianReady) return;
  workerStarted = true;
  worker = spawn(process.execPath, workerArguments, {
    cwd: process.cwd(),
    env: process.env,
    detached: false,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  process.stdin.pipe(worker.stdin);
  worker.stdout.pipe(process.stdout, { end: false });
  worker.stderr.pipe(process.stderr, { end: false });
  worker.stdin.on("error", () => {});
  const reportAfterOutput = (value) => process.stdout.write("", () => reportWorker(value));
  worker.once("error", (error) => reportAfterOutput({
    type: "worker_exit",
    error: String(error && error.message || error),
  }));
  worker.once("close", (code, signal) => reportAfterOutput({ type: "worker_exit", code, signal }));
  reportGuardian({ type: "topology_ready" });
};
const spawnGuardian = () => {
  const generation = ++guardianGeneration;
  const executorFault = cleanupFault === "exit_before_signal_once" && !executorFaultConsumed
    ? "exit_before_signal"
    : "none";
  const guardian = spawn(process.execPath, [
    "-e",
    guardianSource,
    executorFault,
    generation === 1 ? initialGuardianFault : "none",
    String(generation),
  ], {
    detached: false,
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  activeGuardianInput = guardian.stdio[4];
  activeGuardianInput.on("error", () => {});
  activeGuardianReady = false;
  guardianForwardedAttempt = undefined;
  guardianSpawnError = undefined;
  let statusBytes = "";
  guardian.stdio[5].setEncoding("utf8");
  guardian.stdio[5].on("data", (chunk) => {
    statusBytes += chunk;
    if (statusBytes.length > 1024) return guardian.kill("SIGKILL");
    for (;;) {
      const newline = statusBytes.indexOf("\n");
      if (newline < 0) break;
      const line = statusBytes.slice(0, newline);
      statusBytes = statusBytes.slice(newline + 1);
      let value;
      try { value = JSON.parse(line); } catch { return guardian.kill("SIGKILL"); }
      if (value && value.type === "guardian_ready" && value.generation === generation) {
        activeGuardianReady = true;
        reportGuardian({ type: "guardian_ready", generation });
        forwardRetirement();
        startWorker();
      } else if (
        value &&
        value.type === "guardian_signal_failed" &&
        value.generation === generation &&
        Number.isSafeInteger(value.attempt)
      ) {
        pendingRetirementAttempt = undefined;
        guardianForwardedAttempt = undefined;
        reportGuardian({
          type: "retirement_failed",
          attempt: value.attempt,
          error: String(value.error || "in-group guardian could not signal its own process group"),
        });
      } else {
        return guardian.kill("SIGKILL");
      }
    }
  });
  let closed = false;
  const onClose = (code, signal, error) => {
    if (closed) return;
    closed = true;
    if (generation !== guardianGeneration) return;
    const recovering = pendingRetirementAttempt !== undefined;
    if (recovering && executorFault === "exit_before_signal") executorFaultConsumed = true;
    activeGuardianReady = false;
    activeGuardianInput = undefined;
    guardianForwardedAttempt = undefined;
    reportGuardian({
      type: "guardian_exit",
      phase: "pre_signal",
      generation,
      ...(pendingRetirementAttempt === undefined ? {} : { attempt: pendingRetirementAttempt }),
      ...(recovering ? { recovering: true } : {}),
      error: error || guardianSpawnError || "code " + String(code) + " signal " + String(signal),
    });
    // Close is the no-duplicate boundary: if self-group SIGKILL succeeded, this sentinel is dead
    // and cannot execute this callback. A surviving sentinel therefore knows replacement is safe.
    setImmediate(spawnGuardian);
  };
  guardian.once("error", (error) => {
    guardianSpawnError = String(error && error.message || error);
  });
  guardian.once("close", (code, signal) => onClose(code, signal));
};

let coordinatorGeneration = 0;
let coordinatorReplacementUsed = false;
const spawnCoordinator = (initialAttempt = 0) => {
  const generation = ++coordinatorGeneration;
  const coordinatorFault = generation === 1 ? cleanupFault : "none";
  coordinatorReady = false;
  const coordinator = spawn(process.execPath, [
    "-e",
    coordinatorSource,
    String(process.pid),
    coordinatorFault,
    String(initialAttempt),
  ], {
    detached: true,
    shell: false,
    // fd4 is an inherited read capability, not another consumer: only the active coordinator
    // attaches a stream to it. A replacement is spawned only after the old process's close event.
    stdio: ["ignore", "ignore", "ignore", 3, 4, "pipe"],
    windowsHide: true,
  });
  let coordinatorBytes = "";
  let coordinatorSpawnError;
  coordinator.stdio[5].setEncoding("utf8");
  coordinator.stdio[5].on("data", (chunk) => {
    coordinatorBytes += chunk;
    if (coordinatorBytes.length > 1024) return coordinator.kill("SIGKILL");
    for (;;) {
      const newline = coordinatorBytes.indexOf("\n");
      if (newline < 0) break;
      const line = coordinatorBytes.slice(0, newline);
      coordinatorBytes = coordinatorBytes.slice(newline + 1);
      let value;
      try { value = JSON.parse(line); } catch { return coordinator.kill("SIGKILL"); }
      if (value && value.type === "coordinator_ready") {
        if (generation !== coordinatorGeneration || coordinatorReady) return coordinator.kill("SIGKILL");
        coordinatorReady = true;
        startWorker();
      } else if (
        value &&
        value.type === "retire" &&
        Number.isSafeInteger(value.attempt) &&
        value.attempt > 0 &&
        (value.coordinatorExiting === undefined || value.coordinatorExiting === true)
      ) {
        if (generation !== coordinatorGeneration) return coordinator.kill("SIGKILL");
        if (pendingRetirementAttempt === undefined || value.attempt > pendingRetirementAttempt) {
          pendingRetirementAttempt = value.attempt;
          guardianForwardedAttempt = undefined;
        } else if (pendingRetirementAttempt !== value.attempt) {
          return coordinator.kill("SIGKILL");
        }
        if (value.coordinatorExiting !== true) forwardRetirement();
      } else {
        return coordinator.kill("SIGKILL");
      }
    }
  });
  coordinator.once("error", (error) => {
    coordinatorSpawnError = String(error && error.message || error);
  });
  coordinator.once("close", (code, signal) => {
    if (generation !== coordinatorGeneration) return;
    coordinatorReady = false;
    // A normal coordinator closes only after ESRCH, at which point successful guardian retirement
    // has already killed this sentinel. Reaching this callback means observation authority failed.
    reportGuardian({
      type: "coordinator_exit",
      error: coordinatorSpawnError || "code " + String(code) + " signal " + String(signal),
    });
    if (!coordinatorReplacementUsed) {
      coordinatorReplacementUsed = true;
      spawnCoordinator(pendingRetirementAttempt || 0);
    }
    // The replacement is detached before the private guardian pipe is closed. Guardian EOF then
    // kills the provider-capable group; the replacement remains to prove ESRCH and accept a retry.
    if (activeGuardianInput) activeGuardianInput.end();
  });
};
spawnCoordinator();
spawnGuardian();
setInterval(() => {}, 60_000);
`;
