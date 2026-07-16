import type { Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import type { CredentialClient } from "./credential-channel.js";
import { HostError } from "./errors.js";
import type { SecretRedactor } from "./redaction.js";

export const OPENAI_CODEX_PROVIDER_ID = "openai-codex" as const;

function parseCredential(value: Credential | undefined): OAuthCredential | undefined {
  if (value === undefined) return undefined;
  if (value.type !== "oauth") {
    throw new HostError("UNSUPPORTED", "Koni Pi host accepts OAuth credentials only");
  }
  return value;
}

/** Pi CredentialStore whose only persistence authority is the private fd3 broker. */
export class IpcCredentialStore implements CredentialStore {
  private leaseId: string | undefined;

  constructor(
    private readonly client: CredentialClient,
    private readonly redactor: SecretRedactor,
  ) {}

  setLease(leaseId: string): void {
    if (this.leaseId !== undefined && this.leaseId !== leaseId) {
      throw new HostError("CONFLICT", "credential lease is already bound for this host");
    }
    this.leaseId = leaseId;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    this.assertProvider(providerId);
    const credential = await this.client.read(this.requireLease());
    this.redactor.addCredential(credential);
    return credential;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    this.assertProvider(providerId);
    const leaseId = this.requireLease();
    const transaction = await this.client.beginModify(leaseId);
    this.redactor.addCredential(transaction.current);
    try {
      const proposed = parseCredential(await fn(transaction.current));
      if (proposed === undefined) {
        await this.client.abortModify(leaseId, transaction.transactionId, "unchanged");
        return transaction.current;
      }
      this.redactor.addCredential(proposed);
      return await this.client.commitModify(leaseId, transaction.transactionId, proposed);
    } catch (error) {
      try {
        await this.client.abortModify(leaseId, transaction.transactionId, "callback_or_commit_error");
      } catch {
        // Preserve the callback/commit failure; Rust expires abandoned transactions.
      }
      throw error;
    }
  }

  async delete(providerId: string): Promise<void> {
    this.assertProvider(providerId);
    await this.client.delete(this.requireLease());
  }

  private requireLease(): string {
    if (!this.leaseId) throw new HostError("NOT_INITIALIZED", "credential lease is not bound to a runtime session");
    return this.leaseId;
  }

  private assertProvider(providerId: string): void {
    if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
      throw new HostError("UNSUPPORTED", `credential access is restricted to ${OPENAI_CODEX_PROVIDER_ID}`);
    }
  }
}
