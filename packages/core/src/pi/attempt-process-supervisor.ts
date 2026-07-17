import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { TSchema } from "typebox";
import type { KoniAttemptRecoveryClaim, KoniContextProvider } from "./compaction.js";
import type { KoniAuthorizedMessage } from "./compaction.js";
import type { AgentLaunchSpec } from "./launch-spec.js";
import type { ManagedSessionEvent, ManagedSessionOutcome, ManagedTokenUsage } from "./managed-session.js";
import {
  PI_ATTEMPT_PROCESS_PROTOCOL,
  BoundedJsonLineDecoder,
  assertFrameBinding,
  encodePiAttemptProcessFrame,
  parseChildFrame,
  type PiAttemptChildFrame,
  type PiAttemptParentFrame,
  type PiAttemptProcessMode,
  type PiAuthorityRequest,
  type PiAuthorityResponseValue,
} from "./attempt-process-protocol.js";
import {
  validateKoniToolArguments,
  validateKoniToolReceipt,
  type KoniToolInvocation,
  type KoniToolInvoker,
  type KoniToolRejector,
  type KoniToolName,
  type KoniRuntimeToolRejection,
} from "./tool-catalog.js";
import { isSha256Digest, rawSha256 } from "../shared/canonical.js";
import {
  KONI_RUNTIME_CLOSURE_ENV,
  KONI_RUNTIME_PIN_PATH_ENV,
  KONI_RUNTIME_PIN_SHA256_ENV,
  type RuntimeClosurePinReference,
} from "../runtime/identity.js";
import {
  KONI_PI_PACKAGE_ROOT_ENV,
  type PiPeerRuntime,
} from "../runtime/pi-peer-runtime.js";

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
const DEFAULT_ABORT_GRACE_MS = 5_000;
const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_CONTROL_TEXT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CONCURRENT_AUTHORITY_CALLS = 64;
const MAX_AUTHORITY_REQUESTS_PER_ATTEMPT = 100_000;

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
}

export interface PiAttemptProcessOptions {
  mode: PiAttemptProcessMode;
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
  readonly #readyDeferred = deferred<void>();
  readonly #outcomeDeferred = deferred<ManagedSessionOutcome>();
  readonly #closedDeferred = deferred<void>();
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

  public constructor(spec: Readonly<AgentLaunchSpec>, options: PiAttemptProcessOptions) {
    this.spec = spec;
    this.#options = options;
    validateTimings(options.timings);
    const entry = options.runtime?.childEntry
      ?? fileURLToPath(new URL("./attempt-process-entry.js", import.meta.url));
    const args = [
      ...(options.runtime?.piPeerRuntime?.nodeArguments ?? []),
      entry,
      ...(options.runtime?.childArguments ?? []),
    ];
    const child = spawn(process.execPath, args, {
      cwd: spec.workspace.cwd,
      detached: process.platform !== "win32",
      env: containedChildEnvironment(options.runtime),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.ready = this.#readyDeferred.promise;
    this.outcome = this.#outcomeDeferred.promise;

    child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    child.once("error", (error) => this.#failProtocol(new PiAttemptProcessError("spawn", error.message)));
    child.once("close", (code, signal) => void this.#onClose(code, signal));

    void this.#send({
      type: "launch",
      mode: options.mode,
      deferActivation: options.deferActivation === true,
      spec,
      terminalOutputSchema: structuredClone(options.terminalOutputSchema),
    }).catch((error) => this.#failProtocol(asError(error)));
    void withTimeout(this.ready, timing(options.timings?.launchTimeoutMs, DEFAULT_LAUNCH_TIMEOUT_MS))
      .catch((error) => this.#failProtocol(new PiAttemptProcessError("launch_timeout", errorText(error))));
  }

  public get pid(): number | undefined {
    return this.#child.pid;
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
    if (message.mode !== "steer") throw new PiAttemptProcessError("message_mode", "steer requires a committed steer record");
    await this.#queueAuthorizedMessage(message);
  }

  public async followUp(message: KoniAuthorizedMessage): Promise<void> {
    if (message.mode !== "follow_up") {
      throw new PiAttemptProcessError("message_mode", "followUp requires a committed follow_up record");
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
    this.#deletePromise = (async () => {
      await this.#stop(reason, true).catch(() => undefined);
      await this.#forceStopAfterDeletion();
    })();
    return this.#deletePromise;
  }

  public dispose(): Promise<void> {
    return this.delete("attempt process disposed");
  }

  async #activateOnce(): Promise<void> {
    if (this.#deleted) throw new PiAttemptProcessError("run_deleted", "cannot activate a deleted attempt");
    if (this.#requestedAbort !== undefined) {
      throw new PiAttemptProcessError("attempt_aborted", "cannot activate an aborted attempt");
    }
    await this.ready;
    if (this.#closed) throw new PiAttemptProcessError("attempt_closed", "cannot activate an exited attempt");
    const controlId = randomUUID();
    const pending = deferred<void>();
    this.#controls.set(controlId, pending);
    try {
      await this.#send({ type: "control", controlId, action: "activate" });
      await pending.promise;
    } finally {
      this.#controls.delete(controlId);
    }
  }

  #queueAuthorizedMessage(message: KoniAuthorizedMessage): Promise<void> {
    const sent = this.#messageChain.then(() => this.#sendAuthorizedMessage(message));
    this.#messageChain = sent.catch(() => undefined);
    return sent;
  }

  async #sendAuthorizedMessage(message: KoniAuthorizedMessage): Promise<void> {
    if (this.#deleted) throw new PiAttemptProcessError("run_deleted", "cannot message a deleted attempt");
    validateAuthorizedMessage(message);
    if (message.sequence <= this.#lastAuthorizedMessageSequence) {
      throw new PiAttemptProcessError("message_sequence", "authorized message sequence must increase within a process");
    }
    await this.ready;
    if (this.#closed) throw new PiAttemptProcessError("attempt_closed", "cannot message an exited attempt");
    const controlId = randomUUID();
    const pending = deferred<void>();
    this.#controls.set(controlId, pending);
    try {
      await this.#send({ type: "control", controlId, action: "message", message: structuredClone(message) });
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
        void claim.release().then(() => {
          if (this.#claims.get(token) === claim) this.#claims.delete(token);
        }).catch(() => undefined);
      }
    }
    this.#stopPromise ??= this.#stopOnce();
    return this.#stopPromise;
  }

  async #stopOnce(): Promise<void> {
    if (this.#closed) {
      await this.#ensureProcessGroupGone("SIGKILL", this.#killGraceMs());
      return;
    }
    const controlId = randomUUID();
    this.#unwaitedControls.add(controlId);
    await this.#send({
      type: "control",
      controlId,
      action: "abort",
      reason: this.#requestedAbort ?? "attempt aborted by authority",
    }).catch(() => undefined);

    if (await settlesWithin(this.#closedDeferred.promise, this.#abortGraceMs())) {
      await this.#ensureProcessGroupGone("SIGKILL", this.#killGraceMs());
      return;
    }
    await this.#signalProcessGroup("SIGTERM");
    if (
      await settlesWithin(this.#closedDeferred.promise, this.#termGraceMs()) &&
      !(await this.#isProcessGroupAlive())
    ) {
      return;
    }
    await this.#signalProcessGroup("SIGKILL");
    const closed = await settlesWithin(this.#closedDeferred.promise, this.#killGraceMs());
    const gone = await this.#waitForProcessGroupGone(this.#killGraceMs());
    if (!closed || !gone) {
      throw new PiAttemptProcessError(
        "termination_unconfirmed",
        `attempt ${this.spec.identity.attemptId} process group did not terminate after SIGKILL`,
      );
    }
  }

  async #forceStopAfterDeletion(): Promise<void> {
    if (!this.#closed || await this.#isProcessGroupAlive()) {
      await this.#signalProcessGroup("SIGKILL");
    }
    const closed = this.#closed || await settlesWithin(this.#closedDeferred.promise, this.#killGraceMs());
    const gone = await this.#waitForProcessGroupGone(this.#killGraceMs());
    if (!closed || !gone) {
      throw new PiAttemptProcessError(
        "termination_unconfirmed",
        `deletion could not prove attempt ${this.spec.identity.attemptId} stopped`,
      );
    }
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
        if (this.#readyDeferred.settled || typeof frame.sessionFile !== "string" || frame.sessionFile.length === 0) {
          throw new PiAttemptProcessError("ready_frame", "child sent an invalid or duplicate ready frame");
        }
        if (
          path.resolve(frame.sessionFile) !== path.resolve(
            this.spec.workspace.sessionDirectory,
            `${this.spec.identity.sessionId}.jsonl`,
          )
        ) {
          throw new PiAttemptProcessError("session_file", "child reported a transcript outside its immutable session path");
        }
        this.#sessionFile = frame.sessionFile;
        this.#readyDeferred.resolve();
        return;
      case "event":
        if (!this.#readyDeferred.settled) {
          throw new PiAttemptProcessError("event_before_ready", "child emitted a managed event before session readiness");
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
          throw new PiAttemptProcessError("outcome_before_ready", "child reported an outcome before session readiness");
        }
        if (this.#reportedOutcome !== undefined) {
          throw new PiAttemptProcessError("duplicate_outcome", "child reported more than one terminal outcome");
        }
        this.#reportedOutcome = validateOutcome(this.spec, this.#options.terminalOutputSchema, frame.outcome);
        return;
      case "control_result": {
        const pending = this.#controls.get(frame.controlId);
        if (pending === undefined) {
          if (this.#unwaitedControls.delete(frame.controlId)) return;
          throw new PiAttemptProcessError("control_result", "child replied to an unknown control identity");
        }
        if (frame.ok) pending.resolve();
        else pending.reject(new PiAttemptProcessError("control_failed", sanitizeText(frame.error ?? "control failed", 64 * 1024)));
        return;
      }
      case "authority_request":
        void this.#handleAuthorityRequest(frame.requestId, frame.request);
        return;
      case "authority_cancel":
        this.#authorityCalls.get(frame.requestId)?.abort("Pi cancelled the authority tool call");
        return;
      case "fatal":
        this.#failProtocol(new PiAttemptProcessError("child_fatal", sanitizeText(frame.error, 64 * 1024)));
        return;
    }
  }

  async #handleAuthorityRequest(requestId: string, request: PiAuthorityRequest): Promise<void> {
    if (!isSafeIdentifier(requestId) || this.#seenAuthorityRequests.has(requestId)) {
      this.#failProtocol(new PiAttemptProcessError("authority_request", "invalid or duplicate authority request identity"));
      return;
    }
    if (this.#seenAuthorityRequests.size >= MAX_AUTHORITY_REQUESTS_PER_ATTEMPT) {
      this.#failProtocol(new PiAttemptProcessError("authority_request_limit", "attempt exceeded its authority request limit"));
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
        throw new PiAttemptProcessError("attempt_stopped", "authority effects are closed for this attempt");
      }
      const value = await this.#dispatchAuthority(request, abort.signal);
      await this.#send({ type: "authority_response", requestId, ok: true, value });
    } catch (error) {
      await this.#send({
        type: "authority_response",
        requestId,
        ok: false,
        error: sanitizeText(errorText(error), 64 * 1024),
      }).catch(() => undefined);
    } finally {
      this.#authorityCalls.delete(requestId);
    }
  }

  async #dispatchAuthority(request: PiAuthorityRequest, signal: AbortSignal): Promise<PiAuthorityResponseValue> {
    const provider = this.#options.authority.contextProvider;
    switch (request.operation) {
      case "invoke_tool": {
        assertToolAuthorized(this.spec, request.name);
        this.#claimToolCall(request.callId);
        const invocation: KoniToolInvocation = {
          callId: request.callId,
          name: request.name,
          arguments: validateKoniToolArguments(
            request.name,
            request.arguments,
            request.name === this.spec.terminal.toolName ? this.#options.terminalOutputSchema : undefined,
            this.spec.tools.find((tool) => tool.name === request.name)?.schemaHash,
          ),
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
            request.name === this.spec.terminal.toolName ? this.#options.terminalOutputSchema : undefined,
            this.spec.tools.find((tool) => tool.name === request.name)?.schemaHash,
          ),
          signal,
        };
        validateRuntimeToolRejection(this.spec, request.rejection);
        const receipt = await this.#options.authority.rejectTool(invocation, structuredClone(request.rejection));
        validateKoniToolReceipt(receipt);
        if (receipt.outcome !== "rejected" || receipt.code !== request.rejection.code) {
          throw new PiAttemptProcessError("tool_rejection", "authority returned the wrong rejection receipt");
        }
        return structuredClone(receipt);
      }
      case "load_bound_context":
        return provider.loadBoundContext(this.spec);
      case "load_dynamic_graph_context":
        if (provider.loadDynamicGraphContext === undefined) {
          throw new PiAttemptProcessError("dynamic_context_unavailable", "authority context provider has no dynamic graph selector");
        }
        return provider.loadDynamicGraphContext(this.spec);
      case "load_compaction_snapshot":
        return provider.loadCompactionSnapshot(this.spec);
      case "authorize_compaction":
        validateCompactionAuthorizationRequest(request.record);
        return provider.authorizeCompaction(this.spec, structuredClone(request.record));
      case "acquire_recovery_claim": {
        const claim = await provider.acquireRecoveryClaim(this.spec);
        if (signal.aborted || this.#closed || this.#deleted || this.#requestedAbort !== undefined) {
          await claim.release().catch(() => undefined);
          throw new PiAttemptProcessError("attempt_stopped", "recovery claim completed after the attempt stopped");
        }
        const claimToken = randomUUID();
        this.#claims.set(claimToken, claim);
        return { claimToken, claimId: claim.claimId, state: structuredClone(claim.state) };
      }
      case "release_recovery_claim": {
        const claim = this.#claims.get(request.claimToken);
        if (claim === undefined) throw new PiAttemptProcessError("claim_missing", "recovery claim is not owned by this child");
        await claim.release();
        this.#claims.delete(request.claimToken);
        return { released: true };
      }
    }
  }

  #claimToolCall(callId: string): void {
    if (this.#seenToolCalls.has(callId)) {
      throw new PiAttemptProcessError("tool_call_reuse", `tool call ${callId} was submitted more than once`);
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
        throw new PiAttemptProcessError("channel_closed", "attempt-process input channel is closed");
      }
      await new Promise<void>((resolve, reject) => {
        this.#child.stdin.write(bytes, (error) => error === null ? resolve() : reject(error));
      });
    });
    return this.#writeChain;
  }

  #failProtocol(error: Error): void {
    if (this.#protocolFailure !== undefined || this.#closed) return;
    this.#protocolFailure = error;
    this.#readyDeferred.reject(error);
    for (const pending of this.#controls.values()) pending.reject(error);
    void this.delete("protocol failure").catch(() => undefined);
  }

  #onStderr(chunk: Buffer): void {
    const combined = Buffer.concat([this.#stderr, chunk]);
    this.#stderr = combined.byteLength <= MAX_STDERR_BYTES
      ? combined
      : combined.subarray(combined.byteLength - MAX_STDERR_BYTES);
  }

  async #onClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closedDeferred.resolve();
    try {
      this.#decoder.finish();
    } catch (error) {
      this.#protocolFailure ??= asError(error);
    }
    for (const controller of this.#authorityCalls.values()) controller.abort("attempt process exited");
    this.#authorityCalls.clear();
    await Promise.allSettled([...this.#claims.values()].map((claim) => claim.release()));
    this.#claims.clear();
    const closedError = new PiAttemptProcessError("attempt_closed", "attempt process exited");
    for (const pending of this.#controls.values()) pending.reject(closedError);
    this.#controls.clear();
    this.#child.stdin.destroy();
    this.#readyDeferred.reject(this.#protocolFailure ?? closedError);

    let outcome: ManagedSessionOutcome;
    if (this.#protocolFailure !== undefined) {
      outcome = failedOutcome(this.#protocolFailure.message, this.#reportedOutcome?.usage);
    } else if (code === 0 && this.#reportedOutcome !== undefined) {
      outcome = this.#reportedOutcome;
    } else if (this.#requestedAbort !== undefined) {
      outcome = {
        status: "aborted",
        reason: this.#requestedAbort,
        usage: this.#reportedOutcome?.usage ?? emptyUsage(),
      };
    } else {
      const detail = this.#stderr.toString("utf8").trim();
      outcome = failedOutcome(
        `attempt process exited ${signal === null ? `with code ${String(code)}` : `on ${signal}`}${detail === "" ? "" : `: ${detail}`}`,
        this.#reportedOutcome?.usage,
      );
    }
    this.#outcomeDeferred.resolve(outcome);
    this.#listeners.clear();
  }

  async #signalProcessGroup(signal: NodeJS.Signals): Promise<void> {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === "win32") this.#child.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
  }

  async #isProcessGroupAlive(): Promise<boolean> {
    const pid = this.#child.pid;
    if (pid === undefined) return false;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, 0);
      return true;
    } catch (error) {
      if (isNoSuchProcess(error)) return false;
      throw error;
    }
  }

  async #waitForProcessGroupGone(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (!(await this.#isProcessGroupAlive())) return true;
      await delay(10);
    } while (Date.now() < deadline);
    return !(await this.#isProcessGroupAlive());
  }

  async #ensureProcessGroupGone(signal: NodeJS.Signals, timeoutMs: number): Promise<void> {
    if (!(await this.#isProcessGroupAlive())) return;
    await this.#signalProcessGroup(signal);
    if (!(await this.#waitForProcessGroupGone(timeoutMs))) {
      throw new PiAttemptProcessError("termination_unconfirmed", "attempt process group remains alive");
    }
  }

  #abortGraceMs(): number {
    return timing(this.#options.timings?.abortGraceMs, DEFAULT_ABORT_GRACE_MS);
  }

  #termGraceMs(): number {
    return timing(this.#options.timings?.termGraceMs, DEFAULT_TERM_GRACE_MS);
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
    throw new PiAttemptProcessError("tool_not_authorized", `tool ${name} is absent from the immutable launch inventory`);
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
    throw new PiAttemptProcessError("authorized_message", "committed message record has invalid bytes, digest, mode, or sequence");
  }
}

function validateEvent(
  spec: Readonly<AgentLaunchSpec>,
  terminalOutputSchema: TSchema,
  value: ManagedSessionEvent,
): ManagedSessionEvent {
  switch (value.type) {
    case "status":
      if (!["created", "running", "aborting", "aborted", "completed", "failed", "disposed"].includes(value.status)) {
        throw new PiAttemptProcessError("event", "child reported an invalid session status");
      }
      if (value.detail !== undefined) requireBoundedText(value.detail, "status detail", 1024 * 1024);
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
      if (![
        "context_reissued",
        "compaction_created",
        "compaction_denied",
        "linear_navigation_denied",
      ].includes(value.notice.type)) {
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
  if (value.status !== "completed" && value.status !== "failed" && value.status !== "aborted") {
    throw new PiAttemptProcessError("outcome", "child reported an invalid outcome status");
  }
  validateUsage(value.usage);
  if (value.status === "completed") validateTerminalOutput(spec, terminalOutputSchema, value.terminalOutput);
  if (value.status === "failed") requireBoundedText(value.error, "outcome error", 1024 * 1024);
  if (value.status === "aborted") requireBoundedText(value.reason, "abort reason", 1024 * 1024);
  return structuredClone(value);
}

function validateTerminalOutput(
  spec: Readonly<AgentLaunchSpec>,
  terminalOutputSchema: TSchema,
  value: unknown,
): void {
  validateKoniToolArguments(spec.terminal.toolName as KoniToolName, value, terminalOutputSchema);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new PiAttemptProcessError("terminal_output", "terminal output is not JSON serializable");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > spec.terminal.maxOutputBytes) {
    throw new PiAttemptProcessError("terminal_output", "terminal output exceeds its immutable byte bound");
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
    throw new PiAttemptProcessError("tool_rejection", "child requested a non-canonical runtime tool rejection");
  }
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
    throw new PiAttemptProcessError("compaction_authorization", "child requested malformed compaction authorization");
  }
}

function validateUsage(usage: ManagedTokenUsage): void {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new PiAttemptProcessError("usage", "invalid token usage");
  }
  if (
    usage.newTokens !== usage.input + usage.output ||
    usage.allTokens !== usage.newTokens + usage.cacheRead + usage.cacheWrite
  ) {
    throw new PiAttemptProcessError("usage", "inconsistent token usage aggregates");
  }
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
  return (bytes.byteLength <= maximumBytes ? bytes : bytes.subarray(0, maximumBytes)).toString("utf8");
}

function isSafeIdentifier(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function validateTimings(timings: PiAttemptProcessTimings | undefined): void {
  for (const value of Object.values(timings ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
      throw new PiAttemptProcessError("timing", "process timeout must be a safe integer from 0 to 60000ms");
    }
  }
}

function timing(value: number | undefined, fallback: number): number {
  return value ?? fallback;
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    delay(milliseconds).then(() => false),
  ]);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
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

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function containedChildEnvironment(runtime: PiAttemptProcessRuntime | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...(runtime?.additionalEnvironment ?? {}),
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
