import type { Readable, Writable } from "node:stream";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import {
  PiProtocolPeer,
  type CompilerRequestFrame,
  type PiProtocolOptions,
  type RequestHandlerResult,
} from "./protocol.js";
import { SecretRedactor } from "./redaction.js";
import { PI_SDK_VERSION, PiRuntimeManager } from "./runtime.js";
import { parseRuntimeCommand } from "./validation.js";
import type { RuntimeHostMetadata } from "./wire-types.js";

export const HOST_VERSION = "0.1.0" as const;

export interface KoniPiHostOptions {
  credentialStore: CredentialStore;
  redactor?: SecretRedactor;
  protocol?: PiProtocolOptions;
  provider?: Provider;
  allowedProviderId?: string;
  oauthLoginTimeoutMs?: number;
}

export class KoniPiHost {
  readonly protocol: PiProtocolPeer;
  readonly runtime: PiRuntimeManager;
  readonly redactor: SecretRedactor;
  private shutdownRun: Promise<void> | undefined;

  constructor(input: Readable, output: Writable, options: KoniPiHostOptions) {
    this.redactor = options.redactor ?? new SecretRedactor();
    this.protocol = new PiProtocolPeer(input, output, this.redactor, options.protocol);
    this.runtime = new PiRuntimeManager({
      protocol: this.protocol,
      credentialStore: options.credentialStore,
      redactor: this.redactor,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.allowedProviderId === undefined ? {} : { allowedProviderId: options.allowedProviderId }),
      ...(options.oauthLoginTimeoutMs === undefined ? {} : { oauthLoginTimeoutMs: options.oauthLoginTimeoutMs }),
      onFatal: (error) => this.protocol.abort(error),
    });
  }

  async run(): Promise<void> {
    try {
      await this.protocol.run((frame) => this.handleRequest(frame));
    } finally {
      await this.shutdown();
    }
  }

  shutdown(): Promise<void> {
    this.shutdownRun ??= (async () => {
      try {
        await this.runtime.shutdown();
      } finally {
        this.protocol.close();
      }
    })();
    return this.shutdownRun;
  }

  async handleRequest(frame: CompilerRequestFrame): Promise<RequestHandlerResult> {
    const command = parseRuntimeCommand(frame.command);
    switch (command.command) {
      case "list_models":
        return { kind: "models", models: this.runtime.listModels() };
      case "metadata":
        return { kind: "metadata", metadata: this.metadata() };
      case "start_session":
        return this.runtime.startSession(command.request, frame.session_id);
      case "start_turn":
        return this.runtime.prepareTurn(command.request);
      case "control":
        return this.runtime.prepareControl(command.control);
      case "authenticate":
        return this.runtime.authenticate(command.credential_lease, command.request);
      case "shutdown":
        await this.runtime.shutdown();
        return { kind: "accepted" };
    }
  }

  metadata(): RuntimeHostMetadata {
    return {
      host_version: HOST_VERSION,
      pi_sdk_version: PI_SDK_VERSION,
      provider: this.runtime.providerId(),
      ambient_resources: false,
      ambient_credentials: false,
      tools: "compiler-brokered-only",
    };
  }
}
