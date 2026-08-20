import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { TSchema } from "typebox";
import type {
  KoniAttemptRecoveryClaim,
  KoniAuthorizedMessage,
  KoniContextProvider,
  KoniProviderRequestReservation,
  KoniProviderRequestSettlement,
} from "./compaction.js";
import { providerRequestRetirementValidationError } from "./compaction.js";
import type { AgentLaunchSpec } from "./launch-spec.js";
import type {
  ManagedSessionEvent,
  ManagedSessionOutcome,
  ManagedTokenUsage,
} from "./managed-session.js";
import {
  PI_ATTEMPT_PROCESS_PROTOCOL,
  BoundedJsonLineDecoder,
  assertFrameBinding,
  encodePiAttemptProcessFrame,
  isBoundedOpaqueToolCallId,
  parseChildFrame,
  type PiAttemptChildFrame,
  type PiAttemptParentFrame,
  type PiAttemptProcessMode,
  type PiAuthorityRequest,
  type PiAuthorityResponseValue,
} from "./attempt-process-protocol.js";
import {
  KoniToolArgumentValidationError,
  validateKoniToolArguments,
  validateKoniToolReceipt,
  type KoniToolInvocation,
  type KoniToolInvoker,
  type KoniToolRejector,
  type KoniToolName,
  type KoniRuntimeToolRejection,
} from "./tool-catalog.js";
import { isSha256Digest, rawSha256, type Sha256Digest } from "../shared/canonical.js";
import {
  KONI_RUNTIME_CLOSURE_ENV,
  KONI_RUNTIME_PIN_PATH_ENV,
  KONI_RUNTIME_PIN_SHA256_ENV,
  type RuntimeClosurePinReference,
} from "../runtime/identity.js";
import { KONI_PI_PACKAGE_ROOT_ENV, type PiPeerRuntime } from "../runtime/pi-peer-runtime.js";
import {
  isSupportedProviderOutputCap,
  isSupportedStoredProviderInputEstimate,
  providerApiHasSupportedOutputCap,
} from "./provider-request.js";

import {
  ATTEMPT_ABSENCE_OBSERVER_SOURCE,
  ATTEMPT_CLEANUP_COORDINATOR_SOURCE,
  ATTEMPT_GROUP_GUARDIAN_SOURCE,
  ATTEMPT_SENTINEL_SOURCE,
} from "./attempt-process-sources.js";
// A fresh contained Pi session must authenticate its exact runtime, materialize its sealed
// resources, and persist the session header before it can acknowledge readiness. That cold path
// can legitimately exceed 30 seconds on a large project or cold filesystem. This remains a
// bounded construction timeout only; provider activation and every model request are separately
// authorized after readiness.
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000;
// A provider turn may legitimately span many settled model responses. Bound silence after the
// last provider-boundary activity rather than the whole attempt lifetime, otherwise a productive
// multi-turn worker is killed mid-task and its work is needlessly reissued.
const DEFAULT_ACTIVATED_OUTCOME_TIMEOUT_MS = 120_000;
/**
 * The outcome deadline exists to contain a child that has gone silent with nothing outstanding. A
 * reserved-but-unsettled provider request is not silence: the turn is demonstrably in flight and
 * owned upstream. Killing it anyway made every provider turn longer than the deadline fail, which
 * across a long research run meant the planner — which legitimately reasons for minutes before its
 * first tool call — could not finish at all, and each abort left the reservation held. Extend while
 * a request is genuinely open, but keep a hard ceiling so a wedged provider still terminates.
 */
const MAX_PROVIDER_INFLIGHT_DEADLINE_EXTENSIONS = 5;
const DEFAULT_ABORT_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_AUTOMATIC_RETIREMENT_RECOVERY_ATTEMPTS = 3;
const MAX_CONTROL_TEXT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CONCURRENT_AUTHORITY_CALLS = 64;
const MAX_AUTHORITY_REQUESTS_PER_ATTEMPT = 100_000;
const MAX_SENTINEL_FRAME_BYTES = 4 * 1024;

type AttemptAdmissionPhase =
  "constructing" | "ready" | "session_committed" | "activated" | "terminal";

interface AttemptWorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface PiAttemptProcessAuthority {
  invokeTool: KoniToolInvoker;
  rejectTool: KoniToolRejector;
  contextProvider: KoniContextProvider;
}

export interface PiAttemptProcessTimings {
  launchTimeoutMs?: number;
  abortGraceMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
  activatedOutcomeTimeoutMs?: number;
}

export interface PiAttemptProcessRuntime {
  /** Test/packaging seam. Production defaults to the compiled child entry beside this module. */
  childEntry?: string;
  childArguments?: readonly string[];
  additionalEnvironment?: Readonly<Record<string, string>>;
  /** Exact Pi loader selected from the user's authenticated Pi installation. */
  piPeerRuntime?: PiPeerRuntime;
  /** Complete content-hashed runtime closure captured by the owning authority. */
  runtimeClosurePin?: RuntimeClosurePinReference;
  /** Provider-free seams for coordinator observation and guardian crash-window regressions. */
  cleanupOwnerFault?:
    | "fail_first_observation"
    | "delay_first_ack"
    | "eperm_first_attempt"
    | "exit_before_signal_once"
    | "exit_before_ready_once"
    | "exit_after_ready_once"
    | "exit_after_dispatch_once"
    | "exit_after_absence_once";
  /** Provider-free seam for the parent-supervised observation-only fallback. */
  fallbackObserverFault?: "exit_once" | "exit_always";
  /** Provider-free seam proving outcome remains withheld until fallback ESRCH observation. */
  fallbackObservationDelayMs?: number;
  /** Provider-free seam: the first in-group guardian exits at an authenticated lifecycle boundary. */
  groupGuardianFault?: "exit_before_signal_once" | "exit_before_ready_once";
  /** Provider-free seam proving authority-channel EOF arms cleanup before the in-group anchor exits. */
  closeRetirementChannelAfterReady?: boolean;
}

export interface PiAttemptProcessOptions {
  mode: PiAttemptProcessMode;
  /** Exact transcript snapshot hash of the prior validated planning checkpoint. */
  priorTranscriptSha256?: Sha256Digest;
  /** Hold the real Pi session before its first provider turn until `activate()` is acknowledged. */
  deferActivation?: boolean;
  terminalOutputSchema: TSchema;
  authority: PiAttemptProcessAuthority;
  timings?: PiAttemptProcessTimings;
  runtime?: PiAttemptProcessRuntime;
}

export interface PiAttemptProcessEvent {
  identity: AgentLaunchSpec["identity"];
  event: ManagedSessionEvent;
}

export class PiAttemptProcessError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PiAttemptProcessError";
    this.code = code;
  }
}

/**
 * Owns one autonomous Pi attempt in one detached Node process group. The handle is usable as soon
 * as it is returned; `ready` authenticates construction and `outcome` settles only after process
 * exit, so a terminal message can never be mistaken for provider-process cleanup.
 */
export class SupervisedPiAttemptProcess {
  public readonly spec: Readonly<AgentLaunchSpec>;
  public readonly ready: Promise<void>;
  public readonly outcome: Promise<ManagedSessionOutcome>;
  public readonly cleanupFailure: Promise<PiAttemptProcessError>;

  readonly #options: PiAttemptProcessOptions;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder = new BoundedJsonLineDecoder();
  readonly #listeners = new Set<(event: PiAttemptProcessEvent) => void>();
  readonly #controls = new Map<string, Deferred<void>>();
  readonly #authorityCalls = new Map<string, AbortController>();
  readonly #seenAuthorityRequests = new Set<string>();
  readonly #seenToolCalls = new Set<string>();
  readonly #unwaitedControls = new Set<string>();
  readonly #claims = new Map<string, KoniAttemptRecoveryClaim>();
  readonly #topologyReadyDeferred = deferred<void>();
  readonly #readyDeferred = deferred<void>();
  readonly #outcomeDeferred = deferred<ManagedSessionOutcome>();
  readonly #cleanupFailureDeferred = deferred<PiAttemptProcessError>();
  readonly #closedDeferred = deferred<void>();
  readonly #workerExitDeferred = deferred<AttemptWorkerExit>();
  #writeChain: Promise<void> = Promise.resolve();
  #messageChain: Promise<void> = Promise.resolve();
  #outboundSequence = 0;
  #inboundSequence = 0;
  #reportedOutcome: ManagedSessionOutcome | undefined;
  #protocolFailure: Error | undefined;
  #stopPromise: Promise<void> | undefined;
  #deletePromise: Promise<void> | undefined;
  #requestedAbort: string | undefined;
  #deleted = false;
  #closed = false;
  #stderr = Buffer.alloc(0);
  #lastAuthorizedMessageSequence = 0;
  #sessionFile: string | undefined;
  #activationPromise: Promise<void> | undefined;
  #activationControlId: string | undefined;
  #activationToken: string | undefined;
  #preActivationTimeout: NodeJS.Timeout | undefined;
  #activatedOutcomeTimeout: NodeJS.Timeout | undefined;
  #openProviderRequests = 0;
  #providerInflightExtensions = 0;
  #admissionPhase: AttemptAdmissionPhase = "constructing";
  #processGroupId: number | undefined;
  #processGroupRetirementProven = false;
  #retirementPromise: Promise<void> | undefined;
  #retirementAttempt = 0;
  #retirementPending: { attempt: number; result: Deferred<void> } | undefined;
  #retirementSignalObserved = false;
  #retirementSignalAttempt: number | undefined;
  #retirementFailureObserved = false;
  #retirementRecoveryAttempts = 0;
  #retirementRecoveryPromise: Promise<void> | undefined;
  #fallbackObservationPromise: Promise<void> | undefined;
  #fallbackObserverFaultConsumed = false;
  #sentinelBuffer = Buffer.alloc(0);
  #sentinelRetirement: NodeJS.WritableStream | undefined;
  #workerExitReceived = false;
  #sentinelExited = false;
  #sentinelExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  #transportClosed = false;
  #guardianFailurePending: Error | undefined;
  #recoveryClaimRequested = false;

  public constructor(spec: Readonly<AgentLaunchSpec>, options: PiAttemptProcessOptions) {
    this.spec = spec;
    this.#options = options;
    validateTimings(options.timings);
    if (
      (options.mode === "planning_revision" && !isSha256Digest(options.priorTranscriptSha256)) ||
      (options.mode !== "planning_revision" && options.priorTranscriptSha256 !== undefined)
    ) {
      throw new PiAttemptProcessError(
        "planning_revision_transcript",
        "planning revision process mode requires exactly one prior transcript hash",
      );
    }
    const entry =
      options.runtime?.childEntry ??
      fileURLToPath(new URL("./attempt-process-entry.js", import.meta.url));
    const workerArguments = [
      ...(options.runtime?.piPeerRuntime?.nodeArguments ?? []),
      entry,
      ...(options.runtime?.childArguments ?? []),
    ];
    const encodedWorkerArguments = Buffer.from(JSON.stringify(workerArguments), "utf8").toString(
      "base64url",
    );
    const encodedGuardianSource = Buffer.from(ATTEMPT_GROUP_GUARDIAN_SOURCE, "utf8").toString(
      "base64url",
    );
    const encodedCoordinatorSource = Buffer.from(
      ATTEMPT_CLEANUP_COORDINATOR_SOURCE,
      "utf8",
    ).toString("base64url");
    const child = spawn(
      process.execPath,
      [
        "-e",
        ATTEMPT_SENTINEL_SOURCE,
        encodedWorkerArguments,
        encodedGuardianSource,
        encodedCoordinatorSource,
        options.runtime?.cleanupOwnerFault ?? "none",
        options.runtime?.groupGuardianFault ?? "none",
      ],
      {
        cwd: spec.workspace.cwd,
        detached: process.platform !== "win32",
        env: containedChildEnvironment(options.runtime),
        shell: false,
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.#child = child;
    this.#processGroupId = child.pid;
    this.ready = this.#readyDeferred.promise;
    this.outcome = this.#outcomeDeferred.promise;
    this.cleanupFailure = this.#cleanupFailureDeferred.promise;

    child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    const sentinelControl = child.stdio[3];
    const sentinelRetirement = child.stdio[4];
    if (sentinelControl === null || sentinelControl === undefined) {
      this.#failProtocol(
        new PiAttemptProcessError(
          "sentinel_channel",
          "attempt sentinel has no worker control channel",
        ),
      );
    } else {
      sentinelControl.on("data", (chunk: Buffer) => this.#onSentinelControl(chunk));
      sentinelControl.once("error", (error) =>
        this.#failProtocol(new PiAttemptProcessError("sentinel_channel", error.message)),
      );
    }
    if (
      sentinelRetirement === null ||
      sentinelRetirement === undefined ||
      typeof (sentinelRetirement as { write?: unknown }).write !== "function"
    ) {
      this.#failProtocol(
        new PiAttemptProcessError("sentinel_channel", "attempt sentinel has no retirement channel"),
      );
    } else {
      this.#sentinelRetirement = sentinelRetirement as NodeJS.WritableStream;
      sentinelRetirement.once("error", (error) => this.#recordRetirementFailure(error));
    }
    child.once("error", (error) =>
      this.#failProtocol(new PiAttemptProcessError("spawn", error.message)),
    );
    child.once("exit", (code, signal) => void this.#onSentinelExit(code, signal));
    child.once("close", (code, signal) => void this.#onClose(code, signal));

    void this.#topologyReadyDeferred.promise
      .then(() =>
        this.#send({
          type: "launch",
          mode: options.mode,
          deferActivation: options.deferActivation === true,
          spec,
          terminalOutputSchema: structuredClone(options.terminalOutputSchema),
          ...(options.priorTranscriptSha256 === undefined
            ? {}
            : { priorTranscriptSha256: options.priorTranscriptSha256 }),
        }),
      )
      .catch((error) => this.#failProtocol(asError(error)));
    void withTimeout(
      this.ready,
      timing(options.timings?.launchTimeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS),
    ).catch((error) =>
      this.#failProtocol(new PiAttemptProcessError("launch_timeout", errorText(error))),
    );
    void this.ready.then(() => this.#armPreActivationDeadline()).catch(() => undefined);
    if (options.runtime?.closeRetirementChannelAfterReady === true) {
      void this.ready
        .then(() => this.#startRetirement(true))
        .catch((error) => {
          this.#recordRetirementFailure(error);
        });
    }
  }

  public get pid(): number | undefined {
    return this.#processGroupId;
  }

  public get deleted(): boolean {
    return this.#deleted;
  }

  public get sessionFile(): string | undefined {
    return this.#sessionFile;
  }

  public subscribe(listener: (event: PiAttemptProcessEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Begin provider execution after the authority has committed this process's exact session file.
   * Non-deferred compatibility/test children already begin after readiness, so activation is a
   * harmless no-op for them.
   */
  public activate(): Promise<void> {
    if (this.#options.deferActivation !== true) return Promise.resolve();
    this.#activationPromise ??= this.#activateOnce();
    return this.#activationPromise;
  }

  public async steer(message: KoniAuthorizedMessage): Promise<void> {
    if (message.mode !== "steer")
      throw new PiAttemptProcessError("message_mode", "steer requires a committed steer record");
    await this.#queueAuthorizedMessage(message);
  }

  public async followUp(message: KoniAuthorizedMessage): Promise<void> {
    if (message.mode !== "follow_up") {
      throw new PiAttemptProcessError(
        "message_mode",
        "followUp requires a committed follow_up record",
      );
    }
    await this.#queueAuthorizedMessage(message);
  }

  /** Gracefully abort, then terminate the whole attempt process group if Pi does not exit. */
  public abort(reason = "attempt aborted by authority"): Promise<void> {
    return this.#stop(reason, false);
  }

  /** Install a local tombstone before any await and prove the whole process group has stopped. */
  public delete(reason = "run deleted"): Promise<void> {
    if (this.#deletePromise !== undefined) return this.#deletePromise;
    this.#deleted = true;
    const deletion = (async () => {
      await this.#stop(reason, true);
      await this.#forceStopAfterDeletion();
    })();
    this.#deletePromise = deletion;
    void deletion.catch(() => {
      if (this.#deletePromise === deletion && !this.#closed) this.#deletePromise = undefined;
    });
    return deletion;
  }

  public dispose(): Promise<void> {
    return this.delete("attempt process disposed");
  }

  async #activateOnce(): Promise<void> {
    if (this.#deleted)
      throw new PiAttemptProcessError("run_deleted", "cannot activate a deleted attempt");
    if (this.#requestedAbort !== undefined) {
      throw new PiAttemptProcessError("attempt_aborted", "cannot activate an aborted attempt");
    }
    await this.ready;
    if (this.#preActivationTimeout !== undefined) {
      clearTimeout(this.#preActivationTimeout);
      this.#preActivationTimeout = undefined;
    }
    if (this.#closed)
      throw new PiAttemptProcessError("attempt_closed", "cannot activate an exited attempt");
    if (this.#admissionPhase !== "ready") {
      throw new PiAttemptProcessError(
        "activation_state",
        `cannot commit a session while attempt admission is ${this.#admissionPhase}`,
      );
    }
    // Calling activate is the authority's proof that it durably committed the exact session file.
    // Open effect authority atomically immediately before sending activation. The child can begin
    // work as soon as it receives that frame, so waiting for its acknowledgement would create a
    // false-denial race for the first recovery/tool request.
    this.#admissionPhase = "session_committed";
    const controlId = randomUUID();
    const activationToken = randomUUID();
    this.#activationControlId = controlId;
    this.#activationToken = activationToken;
    const pending = deferred<void>();
    this.#controls.set(controlId, pending);
    try {
      this.#admissionPhase = "activated";
      await this.#send({ type: "control", controlId, action: "activate", activationToken });
      await pending.promise;
      this.#refreshActivatedOutcomeDeadline();
    } catch (error) {
      this.#admissionPhase = "terminal";
      await this.delete("activation handshake failed").catch(() => undefined);
      throw error;
    } finally {
      this.#controls.delete(controlId);
      this.#activationControlId = undefined;
    }
  }

  #refreshActivatedOutcomeDeadline(): void {
    if (this.#closed || this.#requestedAbort !== undefined) return;
    if (this.#activatedOutcomeTimeout !== undefined) clearTimeout(this.#activatedOutcomeTimeout);
    this.#activatedOutcomeTimeout = setTimeout(() => {
      this.#activatedOutcomeTimeout = undefined;
      if (
        this.#openProviderRequests > 0 &&
        this.#providerInflightExtensions < MAX_PROVIDER_INFLIGHT_DEADLINE_EXTENSIONS
      ) {
        this.#providerInflightExtensions += 1;
        this.#refreshActivatedOutcomeDeadline();
        return;
      }
      void this.abort("activated attempt exceeded the bounded provider outcome deadline");
    }, this.#options.timings?.activatedOutcomeTimeoutMs ?? DEFAULT_ACTIVATED_OUTCOME_TIMEOUT_MS);
    this.#activatedOutcomeTimeout.unref();
    void this.outcome.finally(() => {
      if (this.#activatedOutcomeTimeout !== undefined) {
        clearTimeout(this.#activatedOutcomeTimeout);
        this.#activatedOutcomeTimeout = undefined;
      }
    });
  }

  #armPreActivationDeadline(): void {
    if (this.#closed || this.#requestedAbort !== undefined || this.#admissionPhase !== "ready")
      return;
    this.#preActivationTimeout = setTimeout(() => {
      this.#preActivationTimeout = undefined;
      void this.abort("ready attempt exceeded the bounded activation deadline");
    }, this.#options.timings?.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
    this.#preActivationTimeout.unref();
    void this.outcome.finally(() => {
      if (this.#preActivationTimeout !== undefined) {
        clearTimeout(this.#preActivationTimeout);
        this.#preActivationTimeout = undefined;
      }
    });
  }

  #queueAuthorizedMessage(message: KoniAuthorizedMessage): Promise<void> {
    const sent = this.#messageChain.then(() => this.#sendAuthorizedMessage(message));
    this.#messageChain = sent.catch(() => undefined);
    return sent;
  }

  async #sendAuthorizedMessage(message: KoniAuthorizedMessage): Promise<void> {
    if (this.#deleted)
      throw new PiAttemptProcessError("run_deleted", "cannot message a deleted attempt");
    validateAuthorizedMessage(message);
    if (message.sequence <= this.#lastAuthorizedMessageSequence) {
      throw new PiAttemptProcessError(
        "message_sequence",
        "authorized message sequence must increase within a process",
      );
    }
    await this.ready;
    if (this.#closed)
      throw new PiAttemptProcessError("attempt_closed", "cannot message an exited attempt");
    if (this.#admissionPhase !== "activated") {
      throw new PiAttemptProcessError(
        "attempt_not_activated",
        "cannot message an attempt before authority activation",
      );
    }
    const controlId = randomUUID();
    const pending = deferred<void>();
    this.#controls.set(controlId, pending);
    try {
      await this.#send({
        type: "control",
        controlId,
        action: "message",
        message: structuredClone(message),
      });
      await pending.promise;
      this.#lastAuthorizedMessageSequence = message.sequence;
    } finally {
      this.#controls.delete(controlId);
    }
  }

  #stop(reasonValue: string, deleting: boolean): Promise<void> {
    requireBoundedText(reasonValue, "abort reason", 64 * 1024);
    this.#requestedAbort ??= reasonValue;
    if (deleting) this.#deleted = true;
    for (const controller of this.#authorityCalls.values()) {
      controller.abort(this.#requestedAbort);
    }
    if (deleting) {
      // Recovery ownership is authority state, not child state. Revoke it immediately rather than
      // waiting for an uncooperative provider process to acknowledge deletion.
      for (const [token, claim] of this.#claims) {
        void claim
          .release()
          .then(() => {
            if (this.#claims.get(token) === claim) this.#claims.delete(token);
          })
          .catch(() => undefined);
      }
    }
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const stopping = this.#stopOnce();
    this.#stopPromise = stopping;
    void stopping.catch(() => {
      if (this.#stopPromise === stopping && !this.#closed) this.#stopPromise = undefined;
    });
    return stopping;
  }

  async #stopOnce(): Promise<void> {
    if (this.#closed) return;
    const retirementAttemptAtStart = this.#retirementAttempt;
    const controlId = randomUUID();
    this.#unwaitedControls.add(controlId);
    await this.#send({
      type: "control",
      controlId,
      action: "abort",
      reason: this.#requestedAbort ?? "attempt aborted by authority",
    }).catch(() => undefined);

    if (await settlesWithin(this.#closedDeferred.promise, this.#abortGraceMs())) return;
    if (
      (this.#retirementSignalObserved || this.#retirementFailureObserved) &&
      !this.#processGroupRetirementProven &&
      this.#retirementAttempt > retirementAttemptAtStart
    ) {
      throw new PiAttemptProcessError(
        "termination_unconfirmed",
        "process-group retirement began during this stop but did not prove absence",
      );
    }
    await this.#retireProcessGroup();
  }

  async #forceStopAfterDeletion(): Promise<void> {
    if (this.#closed) return;
    await this.#retireProcessGroup();
  }

  #onStdout(chunk: Buffer): void {
    if (this.#protocolFailure !== undefined) return;
    try {
      for (const value of this.#decoder.push(chunk)) {
        const frame = parseChildFrame(value);
        assertFrameBinding(frame, {
          attemptId: this.spec.identity.attemptId,
          specHash: this.spec.specHash,
          nextSequence: this.#inboundSequence + 1,
        });
        this.#inboundSequence = frame.sequence;
        this.#onFrame(frame);
      }
    } catch (error) {
      this.#failProtocol(asError(error));
    }
  }

  #onFrame(frame: PiAttemptChildFrame): void {
    switch (frame.type) {
      case "ready":
        if (
          this.#readyDeferred.settled ||
          typeof frame.sessionFile !== "string" ||
          frame.sessionFile.length === 0
        ) {
          throw new PiAttemptProcessError(
            "ready_frame",
            "child sent an invalid or duplicate ready frame",
          );
        }
        if (
          path.resolve(frame.sessionFile) !==
          path.resolve(
            this.spec.workspace.sessionDirectory,
            `${this.spec.identity.sessionId}.jsonl`,
          )
        ) {
          throw new PiAttemptProcessError(
            "session_file",
            "child reported a transcript outside its immutable session path",
          );
        }
        this.#sessionFile = frame.sessionFile;
        this.#admissionPhase = this.#options.deferActivation === true ? "ready" : "activated";
        this.#readyDeferred.resolve();
        return;
      case "event":
        if (!this.#readyDeferred.settled) {
          throw new PiAttemptProcessError(
            "event_before_ready",
            "child emitted a managed event before session readiness",
          );
        }
        frame.event = validateEvent(this.spec, this.#options.terminalOutputSchema, frame.event);
        for (const listener of this.#listeners) {
          try {
            listener({ identity: this.spec.identity, event: structuredClone(frame.event) });
          } catch {
            // Observers never participate in authority or process lifecycle.
          }
        }
        return;
      case "outcome":
        if (!this.#readyDeferred.settled) {
          throw new PiAttemptProcessError(
            "outcome_before_ready",
            "child reported an outcome before session readiness",
          );
        }
        if (this.#reportedOutcome !== undefined) {
          throw new PiAttemptProcessError(
            "duplicate_outcome",
            "child reported more than one terminal outcome",
          );
        }
        if (this.#admissionPhase !== "activated" && this.#requestedAbort === undefined) {
          throw new PiAttemptProcessError(
            "outcome_before_activation",
            "child reported an outcome before authority activation",
          );
        }
        this.#reportedOutcome = validateOutcome(
          this.spec,
          this.#options.terminalOutputSchema,
          frame.outcome,
        );
        this.#admissionPhase = "terminal";
        // The logical outcome is not externally terminal yet. Give the worker one bounded cleanup
        // window to flush/release Pi, then retire the still-live sentinel group either way.
        void this.#retireAfterWorkerCleanup().catch((error) =>
          this.#recordRetirementFailure(error),
        );
        return;
      case "control_result": {
        const pending = this.#controls.get(frame.controlId);
        if (pending === undefined) {
          if (this.#unwaitedControls.delete(frame.controlId)) return;
          throw new PiAttemptProcessError(
            "control_result",
            "child replied to an unknown control identity",
          );
        }
        if (frame.ok) {
          if (frame.controlId === this.#activationControlId) {
            if (this.#admissionPhase !== "activated") {
              throw new PiAttemptProcessError(
                "activation_state",
                "child acknowledged activation outside active admission",
              );
            }
          }
          pending.resolve();
        } else
          pending.reject(
            new PiAttemptProcessError(
              "control_failed",
              sanitizeText(frame.error ?? "control failed", 64 * 1024),
            ),
          );
        return;
      }
      case "authority_request":
        void this.#handleAuthorityRequest(frame.requestId, frame.activationToken, frame.request);
        return;
      case "authority_cancel":
        this.#authorityCalls.get(frame.requestId)?.abort("Pi cancelled the authority tool call");
        return;
      case "fatal":
        this.#failProtocol(
          new PiAttemptProcessError("child_fatal", sanitizeText(frame.error, 64 * 1024)),
        );
        return;
    }
  }

  async #handleAuthorityRequest(
    requestId: string,
    activationToken: string | undefined,
    request: PiAuthorityRequest,
  ): Promise<void> {
    if (!isSafeIdentifier(requestId) || this.#seenAuthorityRequests.has(requestId)) {
      this.#failProtocol(
        new PiAttemptProcessError(
          "authority_request",
          "invalid or duplicate authority request identity",
        ),
      );
      return;
    }
    if (this.#seenAuthorityRequests.size >= MAX_AUTHORITY_REQUESTS_PER_ATTEMPT) {
      this.#failProtocol(
        new PiAttemptProcessError(
          "authority_request_limit",
          "attempt exceeded its authority request limit",
        ),
      );
      return;
    }
    this.#seenAuthorityRequests.add(requestId);
    if (this.#authorityCalls.size >= MAX_CONCURRENT_AUTHORITY_CALLS) {
      await this.#send({
        type: "authority_response",
        requestId,
        ok: false,
        error: "too many concurrent authority requests",
      }).catch(() => undefined);
      return;
    }
    const abort = new AbortController();
    this.#authorityCalls.set(requestId, abort);
    try {
      if (this.#deleted || this.#requestedAbort !== undefined) {
        throw new PiAttemptProcessError(
          "attempt_stopped",
          "authority effects are closed for this attempt",
        );
      }
      this.#assertAuthorityRequestAllowed(request, activationToken);
      const value = await this.#dispatchAuthority(request, abort.signal);
      await this.#send({ type: "authority_response", requestId, ok: true, value });
    } catch (error) {
      const errorCode = structuredErrorCode(error);
      await this.#send({
        type: "authority_response",
        requestId,
        ok: false,
        error: sanitizeText(errorText(error), 64 * 1024),
        ...(errorCode === undefined ? {} : { errorCode }),
      }).catch(() => undefined);
    } finally {
      this.#authorityCalls.delete(requestId);
    }
  }

  async #dispatchAuthority(
    request: PiAuthorityRequest,
    signal: AbortSignal,
  ): Promise<PiAuthorityResponseValue> {
    const provider = this.#options.authority.contextProvider;
    switch (request.operation) {
      case "invoke_tool": {
        assertToolAuthorized(this.spec, request.name);
        this.#claimToolCall(request.callId);
        let forwardedArguments: Record<string, unknown>;
        try {
          forwardedArguments = validateKoniToolArguments(
            request.name,
            request.arguments,
            request.name === this.spec.terminal.toolName
              ? this.#options.terminalOutputSchema
              : undefined,
            this.spec.tools.find((tool) => tool.name === request.name)?.schemaHash,
          );
        } catch (error) {
          if (!(error instanceof KoniToolArgumentValidationError)) throw error;
          // The authority records exact-contract mismatches as durable no-effect rejections. Keep
          // the provider's presentation-valid bytes intact so transcript recovery can bind the
          // rejection to the original call instead of surfacing an unauthenticated local error.
          forwardedArguments = structuredClone(request.arguments);
        }
        const invocation: KoniToolInvocation = {
          callId: request.callId,
          name: request.name,
          arguments: forwardedArguments,
          signal,
        };
        const receipt = await this.#options.authority.invokeTool(invocation);
        validateKoniToolReceipt(receipt);
        return structuredClone(receipt);
      }
      case "reject_tool": {
        assertToolAuthorized(this.spec, request.name);
        this.#claimToolCall(request.callId);
        const invocation: KoniToolInvocation = {
          callId: request.callId,
          name: request.name,
          arguments: validateKoniToolArguments(
            request.name,
            request.arguments,
            request.name === this.spec.terminal.toolName
              ? this.#options.terminalOutputSchema
              : undefined,
            this.spec.tools.find((tool) => tool.name === request.name)?.schemaHash,
          ),
          signal,
        };
        validateRuntimeToolRejection(this.spec, request.rejection);
        const receipt = await this.#options.authority.rejectTool(
          invocation,
          structuredClone(request.rejection),
        );
        validateKoniToolReceipt(receipt);
        if (receipt.outcome !== "rejected" || receipt.code !== request.rejection.code) {
          throw new PiAttemptProcessError(
            "tool_rejection",
            "authority returned the wrong rejection receipt",
          );
        }
        return structuredClone(receipt);
      }
      case "load_bound_context":
        return provider.loadBoundContext(this.spec);
      case "load_dynamic_graph_context":
        if (provider.loadDynamicGraphContext === undefined) {
          throw new PiAttemptProcessError(
            "dynamic_context_unavailable",
            "authority context provider has no dynamic graph selector",
          );
        }
        return provider.loadDynamicGraphContext(this.spec);
      case "load_compaction_snapshot":
        return provider.loadCompactionSnapshot(this.spec);
      case "authorize_compaction":
        validateCompactionAuthorizationRequest(request.record);
        return provider.authorizeCompaction(this.spec, structuredClone(request.record));
      case "acquire_recovery_claim": {
        if (this.#options.mode !== "recover" && this.#options.mode !== "planning_revision") {
          throw new PiAttemptProcessError(
            "recovery_claim",
            "fresh attempts cannot acquire recovery ownership",
          );
        }
        if (this.#recoveryClaimRequested || this.#claims.size !== 0) {
          throw new PiAttemptProcessError(
            "recovery_claim",
            "attempt requested recovery ownership more than once",
          );
        }
        this.#recoveryClaimRequested = true;
        const claim = await provider.acquireRecoveryClaim(this.spec);
        try {
          validateRecoveryClaimForAdmission(this.spec, claim);
        } catch (error) {
          await claim.release().catch(() => undefined);
          throw error;
        }
        if (signal.aborted || this.#closed || this.#deleted || this.#requestedAbort !== undefined) {
          await claim.release().catch(() => undefined);
          throw new PiAttemptProcessError(
            "attempt_stopped",
            "recovery claim completed after the attempt stopped",
          );
        }
        const claimToken = randomUUID();
        this.#claims.set(claimToken, claim);
        return { claimToken, claimId: claim.claimId, state: structuredClone(claim.state) };
      }
      case "release_recovery_claim": {
        if (this.#options.mode !== "recover" && this.#options.mode !== "planning_revision") {
          throw new PiAttemptProcessError(
            "recovery_claim",
            "fresh attempts cannot release recovery ownership",
          );
        }
        const claim = this.#claims.get(request.claimToken);
        if (claim === undefined)
          throw new PiAttemptProcessError(
            "claim_missing",
            "recovery claim is not owned by this child",
          );
        await claim.release();
        this.#claims.delete(request.claimToken);
        return { released: true };
      }
      case "reserve_provider_request": {
        this.#providerInflightExtensions = 0;
        this.#refreshActivatedOutcomeDeadline();
        if (provider.reserveProviderRequest === undefined) {
          throw new PiAttemptProcessError(
            "provider_reservation",
            "authority has no provider reservation service",
          );
        }
        const reserved = await provider.reserveProviderRequest(
          this.spec,
          structuredClone(request.request),
        );
        validateProviderReservationResponse(request.request, reserved);
        // Counted only once the reservation exists, so a rejected reservation cannot leave a
        // phantom in-flight request holding the deadline open.
        this.#openProviderRequests += 1;
        return structuredClone(reserved);
      }
      case "reconcile_provider_request": {
        this.#providerInflightExtensions = 0;
        this.#refreshActivatedOutcomeDeadline();
        if (provider.reconcileProviderRequest === undefined) {
          throw new PiAttemptProcessError(
            "provider_settlement",
            "authority has no provider settlement service",
          );
        }
        const settled = await provider.reconcileProviderRequest(
          this.spec,
          structuredClone(request.settlement),
        );
        validateProviderSettlementResponse(request.settlement, settled);
        // Cleared only on a durable settlement; a failed reconcile leaves the request open, which
        // is exactly the state the extension is meant to keep alive.
        this.#openProviderRequests = Math.max(0, this.#openProviderRequests - 1);
        return structuredClone(settled);
      }
    }
  }

  #assertAuthorityRequestAllowed(
    request: PiAuthorityRequest,
    activationToken: string | undefined,
  ): void {
    if (this.#admissionPhase === "activated") {
      if (activationToken === this.#activationToken) return;
      throw new PiAttemptProcessError(
        "activation_token",
        "authority request omitted the committed activation capability",
      );
    }
    if (
      this.#admissionPhase !== "terminal" &&
      (request.operation === "load_bound_context" ||
        request.operation === "load_dynamic_graph_context")
    ) {
      return;
    }
    throw new PiAttemptProcessError(
      "attempt_not_activated",
      `${request.operation} is unavailable while attempt admission is ${this.#admissionPhase}`,
    );
  }

  #claimToolCall(callId: string): void {
    if (this.#seenToolCalls.has(callId)) {
      throw new PiAttemptProcessError(
        "tool_call_reuse",
        `tool call ${callId} was submitted more than once`,
      );
    }
    this.#seenToolCalls.add(callId);
  }

  async #send(frame: ParentFramePayload): Promise<void> {
    const envelope = {
      ...frame,
      protocol: PI_ATTEMPT_PROCESS_PROTOCOL,
      attemptId: this.spec.identity.attemptId,
      specHash: this.spec.specHash,
      sequence: ++this.#outboundSequence,
    } as PiAttemptParentFrame;
    const bytes = encodePiAttemptProcessFrame(envelope);
    this.#writeChain = this.#writeChain.then(async () => {
      if (this.#closed || this.#child.stdin.destroyed) {
        throw new PiAttemptProcessError(
          "channel_closed",
          "attempt-process input channel is closed",
        );
      }
      await new Promise<void>((resolve, reject) => {
        this.#child.stdin.write(bytes, (error) => (error === null ? resolve() : reject(error)));
      });
    });
    return this.#writeChain;
  }

  #failProtocol(error: Error): void {
    if (this.#protocolFailure !== undefined || this.#closed) return;
    this.#protocolFailure = error;
    this.#topologyReadyDeferred.reject(error);
    this.#readyDeferred.reject(error);
    for (const pending of this.#controls.values()) pending.reject(error);
    void this.delete("protocol failure").catch(() => undefined);
  }

  #onStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.#stderr, chunk]);
    this.#stderr =
      combined.byteLength <= MAX_STDERR_BYTES
        ? combined
        : combined.subarray(combined.byteLength - MAX_STDERR_BYTES);
  }

  #onSentinelControl(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    this.#sentinelBuffer = Buffer.concat([this.#sentinelBuffer, chunk]);
    if (this.#sentinelBuffer.byteLength > MAX_SENTINEL_FRAME_BYTES) {
      this.#failProtocol(
        new PiAttemptProcessError(
          "sentinel_channel",
          "attempt sentinel frame exceeds its byte bound",
        ),
      );
      return;
    }
    for (;;) {
      const newline = this.#sentinelBuffer.indexOf(0x0a);
      if (newline < 0) return;
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            this.#sentinelBuffer.subarray(0, newline),
          ),
        );
      } catch {
        this.#failProtocol(
          new PiAttemptProcessError(
            "sentinel_channel",
            "attempt sentinel sent invalid control JSON",
          ),
        );
        return;
      }
      this.#sentinelBuffer = this.#sentinelBuffer.subarray(newline + 1);
      if (isRecord(value) && value.type === "topology_ready") {
        if (this.#topologyReadyDeferred.settled || this.#readyDeferred.settled) {
          this.#failProtocol(
            new PiAttemptProcessError(
              "sentinel_channel",
              "attempt sentinel repeated or delayed its topology-ready boundary",
            ),
          );
          return;
        }
        this.#topologyReadyDeferred.resolve();
        continue;
      }
      if (isRecord(value) && value.type === "worker_exit") {
        if (this.#workerExitReceived) {
          this.#failProtocol(
            new PiAttemptProcessError("sentinel_channel", "attempt sentinel repeated worker exit"),
          );
          return;
        }
        this.#workerExitReceived = true;
        let workerExit: AttemptWorkerExit;
        try {
          workerExit = validateWorkerExit(value);
        } catch (error) {
          this.#failProtocol(asError(error));
          return;
        }
        this.#workerExitDeferred.resolve(workerExit);
        this.#handleWorkerExit(workerExit);
        continue;
      }
      if (
        isRecord(value) &&
        value.type === "retirement_signal" &&
        Number.isSafeInteger(value.attempt)
      ) {
        const attempt = Number(value.attempt);
        if (attempt < 1 || attempt > this.#retirementAttempt) {
          this.#recordRetirementFailure(
            new PiAttemptProcessError(
              "termination_unconfirmed",
              "cleanup coordinator published a destructive boundary for an unissued retirement attempt",
            ),
          );
          return;
        }
        if (this.#retirementSignalObserved) {
          this.#recordRetirementFailure(
            new PiAttemptProcessError(
              "termination_unconfirmed",
              "cleanup coordinator published more than one destructive process-group boundary",
            ),
          );
          return;
        }
        this.#retirementSignalObserved = true;
        this.#retirementSignalAttempt = attempt;
        continue;
      }
      if (
        isRecord(value) &&
        value.type === "retirement_ack" &&
        Number.isSafeInteger(value.attempt)
      ) {
        const attempt = Number(value.attempt);
        const absentWithoutSignal = value.absentWithoutSignal === true;
        if (attempt < 1 || attempt > this.#retirementAttempt) {
          this.#recordRetirementFailure(
            new PiAttemptProcessError(
              "termination_unconfirmed",
              "cleanup coordinator acknowledged an unissued retirement attempt",
            ),
          );
          return;
        }
        const pending = this.#retirementPending;
        if (
          (!this.#retirementSignalObserved || this.#retirementSignalAttempt === undefined) &&
          !absentWithoutSignal
        ) {
          this.#recordRetirementFailure(
            new PiAttemptProcessError(
              "termination_unconfirmed",
              "cleanup coordinator proved absence without publishing its destructive boundary",
            ),
          );
          return;
        }
        this.#processGroupRetirementProven = true;
        this.#processGroupId = undefined;
        this.#sentinelRetirement?.end();
        // Absence proof is global to the original process-group identity. A late proof remains
        // authoritative after its caller timed out, and also satisfies a newer observation-only
        // retry if one is currently waiting.
        pending?.result.resolve();
        void this.#finalizeRetiredOutcome();
        continue;
      }
      if (
        isRecord(value) &&
        value.type === "retirement_failed" &&
        Number.isSafeInteger(value.attempt) &&
        typeof value.error === "string"
      ) {
        const attempt = Number(value.attempt);
        const pending = this.#retirementPending;
        if (pending === undefined || pending.attempt !== attempt) {
          // A result from an already-rejected observation cannot authorize or disturb a newer one.
          if (attempt <= this.#retirementAttempt) continue;
          this.#recordRetirementFailure(
            new PiAttemptProcessError(
              "termination_unconfirmed",
              "cleanup coordinator rejected an unknown retirement attempt",
            ),
          );
          return;
        }
        const failure = new PiAttemptProcessError(
          "termination_unconfirmed",
          sanitizeText(value.error, 64 * 1024),
        );
        pending.result.reject(failure);
        this.#recordRetirementFailure(failure);
        continue;
      }
      if (isRecord(value) && value.type === "guardian_exit") {
        if (
          value.phase !== "pre_signal" ||
          !Number.isSafeInteger(value.generation) ||
          Number(value.generation) < 1 ||
          (value.recovering !== undefined && typeof value.recovering !== "boolean") ||
          (value.attempt !== undefined &&
            (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1))
        ) {
          this.#failProtocol(
            new PiAttemptProcessError(
              "sentinel_channel",
              "attempt sentinel reported an invalid guardian-exit boundary",
            ),
          );
          return;
        }
        const failure = new PiAttemptProcessError(
          "termination_unconfirmed",
          `attempt group guardian exited before its self-group signal: ${sanitizeText(
            typeof value.error === "string"
              ? value.error
              : `code ${String(value.code)} signal ${String(value.signal)}`,
            64 * 1024,
          )}`,
        );
        const pending = this.#retirementPending;
        if (
          pending !== undefined &&
          (value.attempt === undefined || Number(value.attempt) === pending.attempt)
        ) {
          if (value.recovering === true) {
            // A surviving sentinel is proof that the prior guardian did not successfully signal
            // its group. Keep the same pending attempt while the sentinel installs one replacement.
            this.#recordRetirementFailure(failure);
          } else {
            pending.result.reject(failure);
            this.#recordRetirementFailure(failure);
          }
        } else {
          // Wait for the sentinel to prove its one-shot replacement has installed a fresh command
          // reader. Starting retirement before that boundary can strand the command in the closed
          // guardian's pipe and leave a provider-capable worker alive.
          this.#guardianFailurePending = failure;
        }
        continue;
      }
      if (isRecord(value) && value.type === "coordinator_exit" && typeof value.error === "string") {
        this.#failProtocol(
          new PiAttemptProcessError(
            "termination_unconfirmed",
            `attempt cleanup coordinator exited before ESRCH proof: ${sanitizeText(value.error, 64 * 1024)}`,
          ),
        );
        continue;
      }
      if (
        isRecord(value) &&
        value.type === "guardian_ready" &&
        Number.isSafeInteger(value.generation) &&
        Number(value.generation) >= 1
      ) {
        const failure = this.#guardianFailurePending;
        if (failure !== undefined) {
          this.#guardianFailurePending = undefined;
          this.#failProtocol(failure);
        }
        continue;
      }
      this.#failProtocol(
        new PiAttemptProcessError(
          "sentinel_channel",
          "attempt sentinel sent an unknown control frame",
        ),
      );
      return;
    }
  }

  #handleWorkerExit(workerExit: AttemptWorkerExit): void {
    // The sentinel flushes worker stdout before writing fd 3. Deferring one event-loop turn lets
    // Node deliver every already-readable protocol frame before classifying an outcome-less exit.
    setImmediate(() => {
      if (
        this.#closed ||
        this.#retirementPromise !== undefined ||
        this.#retirementFailureObserved ||
        (this.#retirementSignalObserved && !this.#processGroupRetirementProven)
      )
        return;
      if (this.#reportedOutcome === undefined && this.#protocolFailure === undefined) {
        const detail =
          workerExit.error ??
          (workerExit.signal === null
            ? `worker exited with code ${String(workerExit.code)}`
            : `worker exited on ${workerExit.signal}`);
        this.#failProtocol(new PiAttemptProcessError("worker_exit", detail));
        return;
      }
      void this.#retireProcessGroup().catch((error) => this.#recordRetirementFailure(error));
    });
  }

  async #onSentinelExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#sentinelExited) return;
    this.#sentinelExited = true;
    this.#sentinelExit = { code, signal };
    if (
      this.#retirementPromise === undefined &&
      !this.#processGroupRetirementProven &&
      !this.#retirementFailureObserved &&
      !this.#retirementSignalObserved
    ) {
      this.#protocolFailure ??= new PiAttemptProcessError(
        "termination_unconfirmed",
        "attempt sentinel exited before retirement began; the in-group guardian is taking ownership",
      );
      void this.#retireProcessGroup().catch((error) => this.#recordRetirementFailure(error));
    }
  }

  async #onClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#transportClosed) return;
    this.#transportClosed = true;
    this.#sentinelExit ??= { code, signal };
    try {
      this.#decoder.finish();
    } catch (error) {
      this.#protocolFailure ??= asError(error);
    }
    for (const controller of this.#authorityCalls.values())
      controller.abort("attempt process exited");
    this.#authorityCalls.clear();
    await Promise.allSettled([...this.#claims.values()].map((claim) => claim.release()));
    this.#claims.clear();
    const closedError = new PiAttemptProcessError("attempt_closed", "attempt sentinel exited");
    for (const pending of this.#controls.values()) pending.reject(closedError);
    this.#controls.clear();
    this.#child.stdin.destroy();
    this.#topologyReadyDeferred.reject(this.#protocolFailure ?? closedError);
    this.#readyDeferred.reject(this.#protocolFailure ?? closedError);

    if (!this.#processGroupRetirementProven && this.#retirementAttempt > 0) {
      const attempt = this.#retirementPending?.attempt ?? this.#retirementAttempt;
      await this.#observeAfterTransportClose(attempt).catch(() => undefined);
    }
    await this.#finalizeRetiredOutcome();
  }

  async #finalizeRetiredOutcome(): Promise<void> {
    if (this.#closed || !this.#transportClosed || !this.#processGroupRetirementProven) return;
    this.#closed = true;
    this.#processGroupId = undefined;
    this.#closedDeferred.resolve();
    const reportedOutcome = this.#reportedOutcome;
    const exit = this.#sentinelExit ?? { code: null, signal: null };
    let outcome: ManagedSessionOutcome;
    if (this.#protocolFailure !== undefined) {
      outcome = failedOutcome(this.#protocolFailure.message, reportedOutcome?.usage);
    } else if (reportedOutcome !== undefined) {
      outcome = reportedOutcome;
    } else if (this.#requestedAbort !== undefined) {
      outcome = {
        status: "aborted",
        reason: this.#requestedAbort,
        usage: emptyUsage(),
      };
    } else {
      const detail = this.#stderr.toString("utf8").trim();
      outcome = failedOutcome(
        `attempt process exited ${exit.signal === null ? `with code ${String(exit.code)}` : `on ${exit.signal}`}${detail === "" ? "" : `: ${detail}`}`,
        emptyUsage(),
      );
    }
    this.#outcomeDeferred.resolve(outcome);
    this.#listeners.clear();
  }

  #retireProcessGroup(): Promise<void> {
    return this.#startRetirement(false);
  }

  #startRetirement(closeAuthorityChannel: boolean): Promise<void> {
    if (this.#processGroupRetirementProven) return this.#closedDeferred.promise;
    if (this.#retirementPromise !== undefined) return this.#retirementPromise;
    const retirement = this.#retireProcessGroupOnce(closeAuthorityChannel);
    this.#retirementPromise = retirement;
    void retirement
      .finally(() => {
        if (this.#retirementPromise === retirement && !this.#processGroupRetirementProven) {
          this.#retirementPromise = undefined;
        }
      })
      .catch(() => undefined);
    return this.#retirementPromise;
  }

  async #retireAfterWorkerCleanup(): Promise<void> {
    await settlesWithin(this.#workerExitDeferred.promise, this.#killGraceMs());
    // Once the destructive boundary was accepted, only an explicit authority retry may continue
    // an inconclusive observation. Background worker/outcome callbacks must not silently consume
    // the retained retry handle or turn a failed proof into an unreviewable auto-retry.
    if (
      this.#retirementFailureObserved ||
      (this.#retirementSignalObserved && !this.#processGroupRetirementProven)
    )
      return;
    await this.#retireProcessGroup();
  }

  async #retireProcessGroupOnce(closeAuthorityChannel = false): Promise<void> {
    if (this.#closed) return;
    if (this.#processGroupId === undefined || this.#sentinelRetirement === undefined) {
      throw new PiAttemptProcessError(
        "termination_unconfirmed",
        "attempt process-group identity is already retired",
      );
    }
    // The detached coordinator retains this authority command and relays it through the sentinel
    // to a live in-group guardian. Only that guardian may self-signal its group; the coordinator
    // remains observation-only and ACKs only after ESRCH.
    const attempt = ++this.#retirementAttempt;
    const result = deferred<void>();
    this.#retirementPending = { attempt, result };
    if (this.#retirementSignalObserved) {
      // The in-group guardian already crossed the sole destructive boundary. Every retry from
      // here is observation-only, so automatic recovery can never signal a recycled numeric PGID.
      void this.#startFallbackObservation()
        .then(() => result.resolve())
        .catch((error) => result.reject(error));
    } else if (this.#transportClosed) {
      void this.#observeAfterTransportClose(attempt).catch(() => undefined);
    } else {
      await new Promise<void>((resolve, reject) => {
        if (closeAuthorityChannel) {
          if (attempt !== 1) {
            reject(
              new PiAttemptProcessError(
                "termination_unconfirmed",
                "authority-channel EOF may only arm the first retirement attempt",
              ),
            );
            return;
          }
          this.#sentinelRetirement!.end((error?: Error | null) =>
            error == null ? resolve() : reject(error),
          );
          return;
        }
        this.#sentinelRetirement!.write(`retire:${attempt}\n`, (error) =>
          error === null ? resolve() : reject(error),
        );
      });
    }
    try {
      await withTimeout(result.promise, this.#killGraceMs());
    } finally {
      if (this.#retirementPending?.attempt === attempt) this.#retirementPending = undefined;
    }
    if (!(await settlesWithin(this.#closedDeferred.promise, this.#killGraceMs()))) {
      throw new PiAttemptProcessError(
        "termination_unconfirmed",
        `attempt ${this.spec.identity.attemptId} sentinel did not close after process-group retirement`,
      );
    }
  }

  #recordRetirementFailure(error: unknown): void {
    if (
      this.#reportedOutcome !== undefined &&
      !this.#closed &&
      this.#retirementRecoveryAttempts < MAX_AUTOMATIC_RETIREMENT_RECOVERY_ATTEMPTS
    ) {
      if (this.#retirementRecoveryPromise !== undefined) return;
      this.#retirementRecoveryAttempts += 1;
      const recovery = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        // Let the rejected single-flight retirement release its slot before re-driving it.
        await this.#retirementPromise?.catch(() => undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await this.#startRetirement(false);
      });
      this.#retirementRecoveryPromise = recovery;
      void recovery.then(
        () => {
          if (this.#retirementRecoveryPromise === recovery) {
            this.#retirementRecoveryPromise = undefined;
          }
        },
        (recoveryError) => {
          if (this.#retirementRecoveryPromise === recovery) {
            this.#retirementRecoveryPromise = undefined;
          }
          this.#recordRetirementFailure(recoveryError);
        },
      );
      return;
    }
    this.#retirementFailureObserved = true;
    const failure = new PiAttemptProcessError("termination_unconfirmed", errorText(error));
    this.#protocolFailure ??= failure;
    this.#cleanupFailureDeferred.resolve(failure);
    this.#readyDeferred.reject(this.#protocolFailure);
  }

  #observeAfterTransportClose(attempt: number): Promise<void> {
    const observation = this.#startFallbackObservation();
    return observation.catch((error) => {
      const failure = new PiAttemptProcessError(
        "termination_unconfirmed",
        `fallback process-group observation failed: ${errorText(error)}`,
      );
      const pending = this.#retirementPending;
      if (pending?.attempt === attempt) pending.result.reject(failure);
      this.#recordRetirementFailure(failure);
      throw failure;
    });
  }

  #startFallbackObservation(): Promise<void> {
    if (this.#processGroupRetirementProven) return Promise.resolve();
    if (this.#fallbackObservationPromise !== undefined) return this.#fallbackObservationPromise;
    const processGroupId = this.#processGroupId;
    if (processGroupId === undefined) {
      return Promise.reject(
        new PiAttemptProcessError(
          "termination_unconfirmed",
          "fallback observer has no retained process-group identity",
        ),
      );
    }
    const timeoutMs = Math.max(this.#killGraceMs(), 250);
    const configuredDelay = this.#options.runtime?.fallbackObservationDelayMs ?? 0;
    const initialDelayMs =
      Number.isSafeInteger(configuredDelay) && configuredDelay > 0
        ? Math.min(configuredDelay, timeoutMs - 1)
        : 0;
    const injectFault =
      this.#options.runtime?.fallbackObserverFault === "exit_always" ||
      (this.#options.runtime?.fallbackObserverFault === "exit_once" &&
        !this.#fallbackObserverFaultConsumed);
    if (injectFault) this.#fallbackObserverFaultConsumed = true;
    const observation = new Promise<void>((resolve, reject) => {
      const observer = spawn(
        process.execPath,
        [
          "-e",
          ATTEMPT_ABSENCE_OBSERVER_SOURCE,
          String(processGroupId),
          String(timeoutMs),
          String(initialDelayMs),
          injectFault ? "exit_once" : "none",
        ],
        {
          cwd: this.spec.workspace.cwd,
          detached: process.platform !== "win32",
          // The observer needs no credentials, runtime loader, project configuration, or provider
          // environment. Its entire authority is the numeric identity plus signal-0 observation.
          env: {},
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      let spawnError: Error | undefined;
      observer.once("error", (error) => {
        spawnError = error;
      });
      observer.once("close", (code, signal) => {
        if (spawnError !== undefined) {
          reject(spawnError);
          return;
        }
        if (code === 0 && signal === null) {
          this.#processGroupRetirementProven = true;
          this.#processGroupId = undefined;
          this.#retirementPending?.result.resolve();
          void this.#finalizeRetiredOutcome();
          resolve();
          return;
        }
        reject(
          new Error(
            `observer exited ${signal === null ? `with code ${String(code)}` : `on ${signal}`}`,
          ),
        );
      });
    });
    this.#fallbackObservationPromise = observation;
    void observation
      .finally(() => {
        if (
          this.#fallbackObservationPromise === observation &&
          !this.#processGroupRetirementProven
        ) {
          this.#fallbackObservationPromise = undefined;
        }
      })
      .catch(() => undefined);
    return observation;
  }

  #abortGraceMs(): number {
    return timing(this.#options.timings?.abortGraceMs, DEFAULT_ABORT_GRACE_MS);
  }

  #killGraceMs(): number {
    return timing(this.#options.timings?.killGraceMs, DEFAULT_KILL_GRACE_MS);
  }
}

type ParentFramePayload = PiAttemptParentFrame extends infer Frame
  ? Frame extends PiAttemptParentFrame
    ? Omit<Frame, "protocol" | "attemptId" | "specHash" | "sequence">
    : never
  : never;

function assertToolAuthorized(spec: Readonly<AgentLaunchSpec>, name: KoniToolName): void {
  if (!spec.tools.some((tool) => tool.name === name)) {
    throw new PiAttemptProcessError(
      "tool_not_authorized",
      `tool ${name} is absent from the immutable launch inventory`,
    );
  }
}

function validateAuthorizedMessage(message: KoniAuthorizedMessage): void {
  const bytes = Buffer.byteLength(message.content, "utf8");
  if (
    !Number.isSafeInteger(message.sequence) ||
    message.sequence < 1 ||
    (message.mode !== "steer" && message.mode !== "follow_up") ||
    bytes === 0 ||
    bytes > MAX_CONTROL_TEXT_BYTES ||
    message.content.includes("\u0000") ||
    message.sizeBytes !== bytes ||
    message.sha256 !== rawSha256(message.content)
  ) {
    throw new PiAttemptProcessError(
      "authorized_message",
      "committed message record has invalid bytes, digest, mode, or sequence",
    );
  }
}

function validateEvent(
  spec: Readonly<AgentLaunchSpec>,
  terminalOutputSchema: TSchema,
  value: ManagedSessionEvent,
): ManagedSessionEvent {
  switch (value.type) {
    case "status":
      if (
        !["created", "running", "aborting", "aborted", "completed", "failed", "disposed"].includes(
          value.status,
        )
      ) {
        throw new PiAttemptProcessError("event", "child reported an invalid session status");
      }
      if (value.detail !== undefined)
        requireBoundedText(value.detail, "status detail", 1024 * 1024);
      break;
    case "pi_lifecycle":
      requireBoundedText(value.eventType, "Pi lifecycle event", 16 * 1024);
      break;
    case "usage":
      validateUsage(value.usage);
      break;
    case "terminal":
      if (value.toolName !== spec.terminal.toolName) {
        throw new PiAttemptProcessError("event", "child reported the wrong terminal tool");
      }
      validateTerminalOutput(spec, terminalOutputSchema, value.output);
      break;
    case "compaction":
      if (
        ![
          "context_reissued",
          "compaction_created",
          "compaction_denied",
          "linear_navigation_denied",
        ].includes(value.notice.type)
      ) {
        throw new PiAttemptProcessError("event", "child reported an invalid compaction notice");
      }
      requireBoundedText(value.notice.detail, "compaction notice", 1024 * 1024);
      break;
  }
  return structuredClone(value);
}

function validateOutcome(
  spec: Readonly<AgentLaunchSpec>,
  terminalOutputSchema: TSchema,
  value: ManagedSessionOutcome,
): ManagedSessionOutcome {
  if (
    value.status !== "completed" &&
    value.status !== "checkpointed" &&
    value.status !== "failed" &&
    value.status !== "aborted"
  ) {
    throw new PiAttemptProcessError("outcome", "child reported an invalid outcome status");
  }
  validateUsage(value.usage);
  if (value.status === "completed" || value.status === "checkpointed")
    validateTerminalOutput(spec, terminalOutputSchema, value.terminalOutput);
  if (
    value.status === "checkpointed" &&
    (spec.planningRevision === undefined || value.revision !== spec.planningRevision.revision)
  ) {
    throw new PiAttemptProcessError(
      "outcome",
      "child reported a planning checkpoint outside its immutable revision binding",
    );
  }
  if (value.status === "failed") {
    requireBoundedText(value.error, "outcome error", 1024 * 1024);
    if (value.code !== undefined) requireBoundedText(value.code, "outcome failure code", 128);
  }
  if (value.status === "aborted") requireBoundedText(value.reason, "abort reason", 1024 * 1024);
  return structuredClone(value);
}

function validateTerminalOutput(
  spec: Readonly<AgentLaunchSpec>,
  terminalOutputSchema: TSchema,
  value: unknown,
): void {
  try {
    validateKoniToolArguments(
      spec.terminal.toolName as KoniToolName,
      value,
      terminalOutputSchema,
      spec.terminal.outputSchemaHash,
    );
  } catch (error) {
    if (!(error instanceof KoniToolArgumentValidationError)) throw error;
    throw new PiAttemptProcessError(
      "terminal_output",
      "terminal output does not match its exact immutable schema",
    );
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new PiAttemptProcessError("terminal_output", "terminal output is not JSON serializable");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > spec.terminal.maxOutputBytes) {
    throw new PiAttemptProcessError(
      "terminal_output",
      "terminal output exceeds its immutable byte bound",
    );
  }
}

function requireBoundedText(value: string, name: string, maximumBytes: number): void {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    value.includes("\u0000")
  ) {
    throw new PiAttemptProcessError("text", `${name} is empty, oversized, or contains NUL`);
  }
}

function validateRuntimeToolRejection(
  spec: Readonly<AgentLaunchSpec>,
  value: KoniRuntimeToolRejection,
): void {
  const expected = `Tool was not executed because its worst-case result would exceed this attempt's ${spec.budgets.transcript.maxBytes}-byte transcript budget.`;
  if (value.code !== "transcript_result_budget" || value.summary !== expected) {
    throw new PiAttemptProcessError(
      "tool_rejection",
      "child requested a non-canonical runtime tool rejection",
    );
  }
}

function validateRecoveryClaimForAdmission(
  spec: Readonly<AgentLaunchSpec>,
  claim: KoniAttemptRecoveryClaim,
): void {
  const state = claim.state;
  let encoded: string;
  try {
    encoded = JSON.stringify(state);
  } catch {
    throw new PiAttemptProcessError(
      "recovery_claim",
      "authority recovery state is not JSON serializable",
    );
  }
  if (
    claim.protocol !== "koni.attempt-recovery-claim.v1" ||
    !isSafeIdentifier(claim.claimId) ||
    typeof claim.release !== "function" ||
    Buffer.byteLength(encoded, "utf8") > 16 * 1024 * 1024 ||
    state.protocol !== "koni.attempt-recovery.v1" ||
    state.specHash !== spec.specHash ||
    state.runId !== spec.identity.runId ||
    state.ticketId !== spec.identity.ticketId ||
    state.stepId !== spec.identity.stepId ||
    state.attemptId !== spec.identity.attemptId ||
    state.sessionId !== spec.identity.sessionId ||
    state.grantHash !== spec.authority.grantHash ||
    state.generation !== spec.authority.generation ||
    state.epoch !== spec.authority.epoch ||
    state.stateHash !== spec.authority.expectedStateHash ||
    !["continue", "terminal_accepted", "terminal_inflight", "revoked"].includes(state.status) ||
    state.authorizedMessages.length > MAX_AUTHORITY_REQUESTS_PER_ATTEMPT ||
    state.authorizedToolResults.length > MAX_AUTHORITY_REQUESTS_PER_ATTEMPT ||
    state.authorizedCompactions.length > MAX_AUTHORITY_REQUESTS_PER_ATTEMPT ||
    (state.providerRequests?.length ?? 0) > MAX_AUTHORITY_REQUESTS_PER_ATTEMPT
  ) {
    throw new PiAttemptProcessError(
      "recovery_claim",
      "authority returned an unbound or oversized recovery claim",
    );
  }
  validateUsage(state.usage);
  validateProviderRecoveryLedger(spec, state);
  const messageSequences = new Set<number>();
  for (const message of state.authorizedMessages) {
    validateAuthorizedMessage(message);
    if (messageSequences.has(message.sequence)) {
      throw new PiAttemptProcessError(
        "recovery_claim",
        "recovery claim repeats an authorized message sequence",
      );
    }
    messageSequences.add(message.sequence);
  }
  const toolCalls = new Set<string>();
  for (const result of state.authorizedToolResults) {
    if (
      !Number.isSafeInteger(result.sequence) ||
      result.sequence < 1 ||
      !isBoundedOpaqueToolCallId(result.callId) ||
      !spec.tools.some((tool) => tool.name === result.toolName) ||
      (result.outcome !== "accepted" && result.outcome !== "rejected") ||
      !isSha256Digest(result.argumentsSha256) ||
      !Number.isSafeInteger(result.argumentsSizeBytes) ||
      result.argumentsSizeBytes < 0 ||
      !isSha256Digest(result.receiptSha256) ||
      !Number.isSafeInteger(result.receiptSizeBytes) ||
      result.receiptSizeBytes < 0 ||
      toolCalls.has(result.callId)
    ) {
      throw new PiAttemptProcessError(
        "recovery_claim",
        "recovery claim contains an invalid tool receipt binding",
      );
    }
    toolCalls.add(result.callId);
  }
  const compactions = new Set<string>();
  for (const compaction of state.authorizedCompactions) {
    if (
      !Number.isSafeInteger(compaction.sequence) ||
      compaction.sequence < 1 ||
      !isSafeIdentifier(compaction.authorizationId) ||
      !isSha256Digest(compaction.summaryHash) ||
      !Number.isSafeInteger(compaction.summaryBytes) ||
      compaction.summaryBytes < 1 ||
      !isSafeIdentifier(compaction.firstKeptEntryId) ||
      !Number.isSafeInteger(compaction.tokensBefore) ||
      compaction.tokensBefore < 0 ||
      compactions.has(compaction.authorizationId)
    ) {
      throw new PiAttemptProcessError(
        "recovery_claim",
        "recovery claim contains an invalid compaction binding",
      );
    }
    compactions.add(compaction.authorizationId);
  }
}

function validateProviderRecoveryLedger(
  spec: Readonly<AgentLaunchSpec>,
  state: KoniAttemptRecoveryClaim["state"],
): void {
  const requests = state.providerRequests;
  if (requests === undefined) {
    if (state.providerUsageBaseline !== undefined) {
      throw new PiAttemptProcessError("recovery_claim", "provider baseline has no request ledger");
    }
    return;
  }
  if (!Array.isArray(requests)) {
    throw new PiAttemptProcessError("recovery_claim", "provider request ledger is malformed");
  }
  const baseline = state.providerUsageBaseline ?? emptyUsage();
  validateUsage(baseline);
  let input = baseline.input;
  let output = baseline.output;
  let cacheRead = baseline.cacheRead;
  let cacheWrite = baseline.cacheWrite;
  let unresolved = false;
  for (const [index, request] of requests.entries()) {
    const cap = request.serializedOutputCap;
    if (
      request.sequence !== index + 1 ||
      !isSafeIdentifier(request.reservationId) ||
      request.api !== spec.model.api ||
      request.modelId !== spec.model.id ||
      !isSha256Digest(request.payloadSha256) ||
      !Number.isSafeInteger(request.payloadSizeBytes) ||
      request.payloadSizeBytes < 1 ||
      request.payloadSizeBytes > 64 * 1024 * 1024 ||
      !isSupportedStoredProviderInputEstimate(
        request.payloadSizeBytes,
        request.prospectiveInputTokens,
      ) ||
      !Number.isSafeInteger(request.reservedOutputTokens) ||
      request.reservedOutputTokens < 1 ||
      request.reservedOutputTokens > spec.model.catalogMaxTokens ||
      !isSafeIdentifier(request.baselineEntryId) ||
      (cap !== undefined &&
        (spec.model.api === "openai-codex-responses" ||
          !isSupportedProviderOutputCap(spec.model.api, cap) ||
          cap.value !== request.reservedOutputTokens)) ||
      (cap === undefined &&
        (providerApiHasSupportedOutputCap(spec.model.api) ||
          request.reservedOutputTokens !== spec.model.catalogMaxTokens))
    ) {
      throw new PiAttemptProcessError(
        "recovery_claim",
        "provider request ledger is not launch-bound",
      );
    }
    if (request.settlement !== undefined && request.retirement !== undefined) {
      throw new PiAttemptProcessError(
        "recovery_claim",
        "provider request cannot be both settled and retired",
      );
    }
    if (request.retirement !== undefined) {
      const retirementError = providerRequestRetirementValidationError(request.retirement);
      if (retirementError !== undefined) {
        throw new PiAttemptProcessError("recovery_claim", retirementError);
      }
      continue;
    }
    if (request.settlement === undefined) {
      if (unresolved || index !== requests.length - 1) {
        throw new PiAttemptProcessError(
          "recovery_claim",
          "provider request ledger has an ambiguous gap",
        );
      }
      unresolved = true;
      continue;
    }
    if (
      !isSafeIdentifier(request.settlement.assistantEntryId) ||
      !isSha256Digest(request.settlement.assistantEntrySha256)
    ) {
      throw new PiAttemptProcessError(
        "recovery_claim",
        "provider settlement identity is malformed",
      );
    }
    validateUsage(request.settlement.usage);
    if (
      safeUsageTotal(
        request.settlement.usage.input,
        request.settlement.usage.cacheRead,
        request.settlement.usage.cacheWrite,
      ) > request.prospectiveInputTokens ||
      request.settlement.usage.output > request.reservedOutputTokens
    ) {
      throw new PiAttemptProcessError(
        "recovery_claim",
        "provider settlement exceeds its reservation",
      );
    }
    input = safeUsageTotal(input, request.settlement.usage.input);
    output = safeUsageTotal(output, request.settlement.usage.output);
    cacheRead = safeUsageTotal(cacheRead, request.settlement.usage.cacheRead);
    cacheWrite = safeUsageTotal(cacheWrite, request.settlement.usage.cacheWrite);
  }
  const expected = {
    input,
    output,
    cacheRead,
    cacheWrite,
    newTokens: safeUsageTotal(input, output),
    allTokens: safeUsageTotal(input, output, cacheRead, cacheWrite),
  };
  if (JSON.stringify(expected) !== JSON.stringify(state.usage)) {
    throw new PiAttemptProcessError(
      "recovery_claim",
      "provider ledger does not equal authority usage totals",
    );
  }
}

function safeUsageTotal(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new PiAttemptProcessError("usage", "token usage exceeds safe accounting range");
  }
  return total;
}

function validateCompactionAuthorizationRequest(
  value: Extract<PiAuthorityRequest, { operation: "authorize_compaction" }>["record"],
): void {
  if (
    !isSha256Digest(value.summaryHash) ||
    !Number.isSafeInteger(value.summaryBytes) ||
    value.summaryBytes < 1 ||
    value.summaryBytes > 4 * 1024 * 1024 ||
    !isSafeIdentifier(value.firstKeptEntryId) ||
    !Number.isSafeInteger(value.tokensBefore) ||
    value.tokensBefore < 0
  ) {
    throw new PiAttemptProcessError(
      "compaction_authorization",
      "child requested malformed compaction authorization",
    );
  }
}

function validateProviderReservationResponse(
  request: Extract<PiAuthorityRequest, { operation: "reserve_provider_request" }>["request"],
  response: KoniProviderRequestReservation,
): void {
  if (
    response.protocol !== "koni.provider-request-reservation.v1" ||
    response.sequence !== request.sequence ||
    !isSafeIdentifier(response.reservationId) ||
    !isSafeIdentifier(response.baselineEntryId)
  ) {
    throw new PiAttemptProcessError(
      "provider_reservation",
      "authority returned a malformed provider reservation",
    );
  }
}

function validateProviderSettlementResponse(
  request: Extract<PiAuthorityRequest, { operation: "reconcile_provider_request" }>["settlement"],
  response: KoniProviderRequestSettlement,
): void {
  if (
    response.protocol !== "koni.provider-request-settlement.v1" ||
    response.sequence !== request.sequence ||
    response.reservationId !== request.reservationId ||
    response.assistantEntryId !== request.assistantEntryId ||
    response.assistantEntrySha256 !== request.assistantEntrySha256
  ) {
    throw new PiAttemptProcessError(
      "provider_settlement",
      "authority returned a mismatched provider settlement",
    );
  }
  validateUsage(response.usage);
  if (JSON.stringify(response.usage) !== JSON.stringify(request.usage)) {
    throw new PiAttemptProcessError(
      "provider_settlement",
      "authority settled different provider usage",
    );
  }
}

function validateUsage(usage: ManagedTokenUsage): void {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new PiAttemptProcessError("usage", "invalid token usage");
  }
  if (
    usage.newTokens !== usage.input + usage.output ||
    usage.allTokens !== usage.newTokens + usage.cacheRead + usage.cacheWrite
  ) {
    throw new PiAttemptProcessError("usage", "inconsistent token usage aggregates");
  }
}

function validateWorkerExit(value: unknown): AttemptWorkerExit {
  if (
    !isRecord(value) ||
    value.type !== "worker_exit" ||
    (value.code !== null && (!Number.isSafeInteger(value.code) || Number(value.code) < 0)) ||
    (value.signal !== null && typeof value.signal !== "string") ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || Buffer.byteLength(value.error, "utf8") > 64 * 1024))
  ) {
    throw new PiAttemptProcessError(
      "sentinel_channel",
      "attempt sentinel sent a malformed worker-exit frame",
    );
  }
  return {
    code: value.code as number | null,
    signal: value.signal as NodeJS.Signals | null,
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}

function failedOutcome(error: string, usage = emptyUsage()): ManagedSessionOutcome {
  return { status: "failed", error: sanitizeText(error, 1024 * 1024), usage };
}

function emptyUsage(): ManagedTokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, allTokens: 0 };
}

interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve(value) {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(reason);
    },
  };
  // A launch/close race can reject `ready` before a caller attaches. Keep Node from treating that
  // as an unhandled rejection while preserving the original rejecting promise for callers.
  void result.promise.catch(() => undefined);
  return result;
}

function sanitizeText(value: string, maximumBytes: number): string {
  const clean = String(value).replaceAll("\u0000", "�");
  const bytes = Buffer.from(clean, "utf8");
  return (bytes.byteLength <= maximumBytes ? bytes : bytes.subarray(0, maximumBytes)).toString(
    "utf8",
  );
}

function isSafeIdentifier(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function validateTimings(timings: PiAttemptProcessTimings | undefined): void {
  for (const value of Object.values(timings ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 120_000) {
      throw new PiAttemptProcessError(
        "timing",
        "process timeout must be a safe integer from 0 to 120000ms",
      );
    }
  }
}

function timing(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(milliseconds).then(() => false),
  ]);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out after ${milliseconds}ms`)),
          milliseconds,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function structuredErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string" || !isSafeIdentifier(error.code))
    return undefined;
  return error.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function containedChildEnvironment(
  runtime: PiAttemptProcessRuntime | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(runtime?.additionalEnvironment ?? {}),
    // Pi 0.80.10's Bedrock adapter delegates retries to the AWS SDK and does not forward
    // StreamOptions.maxRetries. One authority reservation must authorize exactly one transport.
    AWS_MAX_ATTEMPTS: "1",
  };
  // Keep Pi/provider credentials and normal settings discovery intact, but do not permit ambient
  // Node code injection to execute before the sealed child entry establishes its resource set.
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NPM_CONFIG_NODE_OPTIONS",
    "NODE_INSPECT_RESUME_ON_START",
  ]) {
    delete environment[name];
  }
  if (runtime?.piPeerRuntime !== undefined) {
    environment[KONI_PI_PACKAGE_ROOT_ENV] = runtime.piPeerRuntime.packageRoot;
  }
  if (runtime?.runtimeClosurePin !== undefined) {
    environment[KONI_RUNTIME_CLOSURE_ENV] = runtime.runtimeClosurePin.closureSha256;
    environment[KONI_RUNTIME_PIN_PATH_ENV] = runtime.runtimeClosurePin.path;
    environment[KONI_RUNTIME_PIN_SHA256_ENV] = runtime.runtimeClosurePin.pinSha256;
  }
  return environment;
}
