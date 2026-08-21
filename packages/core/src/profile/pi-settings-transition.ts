import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { FileTransactionStore } from "../authority/file-journal.js";
import { isSha256Digest, rawSha256, type Sha256Digest } from "../shared/canonical.js";

const TRANSITION_PROTOCOL = "koni.pi-settings-transition.v1" as const;
const TRANSITION_PATH = "transition.json";

interface PiSettingsTransitionAuthority {
  protocol: typeof TRANSITION_PROTOCOL;
  expectedSettingsSha256: Sha256Digest | null;
  desiredSettingsSha256: Sha256Digest;
  desiredSettingsBase64: string;
  expectedOwnershipSha256: Sha256Digest | null;
  desiredOwnershipSha256: Sha256Digest;
  desiredOwnershipBase64: string;
}

export interface PiSettingsTransitionInput {
  expectedSettingsSha256: Sha256Digest | null;
  desiredSettingsBytes: Uint8Array;
  expectedOwnershipSha256: Sha256Digest | null;
  desiredOwnershipBytes: Uint8Array;
}

export class PiSettingsTransitionError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "PiSettingsTransitionError";
    this.code = code;
  }
}

export class PiSettingsTransitionCoordinator {
  readonly #store: FileTransactionStore;
  readonly #settingsPath: string;
  readonly #ownershipPath: string;
  readonly #transitionPath: string;

  private constructor(store: FileTransactionStore, settingsPath: string, ownershipPath: string) {
    this.#store = store;
    this.#settingsPath = settingsPath;
    this.#ownershipPath = ownershipPath;
    this.#transitionPath = path.join(store.canonicalRoot(), TRANSITION_PATH);
  }

  public static async open(
    projectRoot: string,
    configRoot: string,
  ): Promise<PiSettingsTransitionCoordinator> {
    const coordinationRoot = path.join(configRoot, ".managed", "pi-settings-coordination");
    await mkdir(coordinationRoot, { recursive: true, mode: 0o700 });
    const coordinationMetadata = await lstat(coordinationRoot);
    if (
      !coordinationMetadata.isDirectory() ||
      coordinationMetadata.isSymbolicLink() ||
      (await realpath(coordinationRoot)) !== coordinationRoot
    ) {
      throw new PiSettingsTransitionError(
        "pi_settings_transition_unsafe",
        "Pi settings coordination root is not the exact managed directory",
      );
    }
    return new PiSettingsTransitionCoordinator(
      await FileTransactionStore.open(coordinationRoot),
      path.join(projectRoot, ".pi", "settings.json"),
      path.join(configRoot, ".managed", "pi-settings.json"),
    );
  }

  public async stage(input: Readonly<PiSettingsTransitionInput>): Promise<void> {
    await this.#store.recoverPrepared();
    if ((await readOptionalStableFile(this.#transitionPath)) !== undefined) {
      throw new PiSettingsTransitionError(
        "pi_settings_transition_active",
        "a Pi settings transition is already active",
      );
    }
    const authority: PiSettingsTransitionAuthority = {
      protocol: TRANSITION_PROTOCOL,
      expectedSettingsSha256: input.expectedSettingsSha256,
      desiredSettingsSha256: rawSha256(input.desiredSettingsBytes),
      desiredSettingsBase64: Buffer.from(input.desiredSettingsBytes).toString("base64"),
      expectedOwnershipSha256: input.expectedOwnershipSha256,
      desiredOwnershipSha256: rawSha256(input.desiredOwnershipBytes),
      desiredOwnershipBase64: Buffer.from(input.desiredOwnershipBytes).toString("base64"),
    };
    const transactionId = `pi-settings-stage-${randomUUID()}`;
    await this.#store.prepare(transactionId, [
      {
        path: TRANSITION_PATH,
        bytes: jsonBytes(authority),
        expectedSha256: null,
      },
    ]);
    await this.#store.commit(transactionId);
    await this.#store.cleanupCommitted(transactionId);
  }

  /** Replay one durable settings-to-ownership transition, then retire its authority. */
  public async recover(): Promise<boolean> {
    await this.#store.recoverPrepared();
    const markerBytes = await readOptionalStableFile(this.#transitionPath);
    if (markerBytes === undefined) return false;
    const authority = parseAuthority(markerBytes);
    await replaceDurableFileCas(
      this.#settingsPath,
      authority.expectedSettingsSha256,
      decodeDesiredBytes(
        authority.desiredSettingsBase64,
        authority.desiredSettingsSha256,
        "settings",
      ),
      authority.desiredSettingsSha256,
    );
    await replaceDurableFileCas(
      this.#ownershipPath,
      authority.expectedOwnershipSha256,
      decodeDesiredBytes(
        authority.desiredOwnershipBase64,
        authority.desiredOwnershipSha256,
        "ownership",
      ),
      authority.desiredOwnershipSha256,
    );
    const transactionId = `pi-settings-finalize-${randomUUID()}`;
    await this.#store.prepare(
      transactionId,
      [],
      [{ path: TRANSITION_PATH, expectedSha256: rawSha256(markerBytes) }],
    );
    await this.#store.commit(transactionId);
    await this.#store.cleanupCommitted(transactionId);
    return true;
  }
}

function parseAuthority(bytes: Uint8Array): PiSettingsTransitionAuthority {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new PiSettingsTransitionError(
      "pi_settings_transition_invalid",
      "Pi settings transition is not valid JSON",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PiSettingsTransitionError(
      "pi_settings_transition_invalid",
      "Pi settings transition is not an object",
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "protocol",
    "expectedSettingsSha256",
    "desiredSettingsSha256",
    "desiredSettingsBase64",
    "expectedOwnershipSha256",
    "desiredOwnershipSha256",
    "desiredOwnershipBase64",
  ]);
  if (
    Object.keys(record).some((field) => !allowed.has(field)) ||
    record.protocol !== TRANSITION_PROTOCOL ||
    !isOptionalPreimage(record.expectedSettingsSha256) ||
    !isSha256Digest(record.desiredSettingsSha256) ||
    typeof record.desiredSettingsBase64 !== "string" ||
    !isOptionalPreimage(record.expectedOwnershipSha256) ||
    !isSha256Digest(record.desiredOwnershipSha256) ||
    typeof record.desiredOwnershipBase64 !== "string"
  ) {
    throw new PiSettingsTransitionError(
      "pi_settings_transition_invalid",
      "Pi settings transition has an invalid shape",
    );
  }
  return record as unknown as PiSettingsTransitionAuthority;
}

function isOptionalPreimage(value: unknown): value is Sha256Digest | null {
  return value === null || isSha256Digest(value);
}

function decodeDesiredBytes(base64: string, expected: Sha256Digest, label: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 || rawSha256(bytes) !== expected) {
    throw new PiSettingsTransitionError(
      "pi_settings_transition_invalid",
      `Pi settings transition ${label} bytes do not match their digest`,
    );
  }
  return bytes;
}

async function replaceDurableFileCas(
  destination: string,
  expectedSha256: Sha256Digest | null,
  desiredBytes: Uint8Array,
  desiredSha256: Sha256Digest,
): Promise<void> {
  const current = await readOptionalStableFile(destination);
  const currentSha256 = current === undefined ? null : rawSha256(current);
  if (currentSha256 === desiredSha256) return;
  if (currentSha256 !== expectedSha256) {
    throw new PiSettingsTransitionError(
      "pi_settings_changed",
      `Pi settings transition target changed: ${destination}`,
    );
  }
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(destination)}.koni-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(desiredBytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const beforeRename = await readOptionalStableFile(destination);
    const beforeRenameSha256 = beforeRename === undefined ? null : rawSha256(beforeRename);
    if (beforeRenameSha256 === desiredSha256) return;
    if (beforeRenameSha256 !== expectedSha256) {
      throw new PiSettingsTransitionError(
        "pi_settings_changed",
        `Pi settings transition target changed: ${destination}`,
      );
    }
    await rename(temporary, destination);
    await syncDirectory(parent);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function readOptionalStableFile(filePath: string): Promise<Buffer | undefined> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new PiSettingsTransitionError(
        "pi_settings_transition_unsafe",
        `Pi settings transition target is not a regular file: ${filePath}`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new PiSettingsTransitionError(
        "pi_settings_changed",
        `Pi settings transition target changed while read: ${filePath}`,
      );
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}
