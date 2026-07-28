export const MAX_STATE_BYTES = 32 * 1024 * 1024;
export const MAX_RUN_BYTES = 64 * 1024 * 1024;

/** One maximum-sized run plus its exact raw-byte authority anchor, published state last. */
export const MAX_TRANSACTION_BYTES = MAX_RUN_BYTES + MAX_STATE_BYTES;
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
export const MAX_TRANSACTION_EFFECTS = 100_000;
export const MAX_TRANSACTION_PATH_BYTES = 4_096;

export const MAX_ARCHIVE_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_READ_CONCURRENCY = 4;
export const MAX_LIST_RUN_CONCURRENCY = 2;

export function transactionPayloadBytes(
  writes: readonly Readonly<{ bytes: Uint8Array }>[],
): number {
  let total = 0;
  for (const write of writes) {
    const size = write.bytes.byteLength;
    if (!Number.isSafeInteger(size) || size < 0 || total > Number.MAX_SAFE_INTEGER - size) {
      return Number.POSITIVE_INFINITY;
    }
    total += size;
  }
  return total;
}

/** Conservative identity for default APFS and other case/normalization-insensitive stores. */
export function portableDurablePathIdentity(relative: string): string {
  return relative.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
}

export class AsyncSemaphore {
  readonly #limit: number;
  #available: number;
  readonly #waiters: Array<(release: () => void) => void> = [];

  public constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError("semaphore limit must be a positive safe integer");
    }
    this.#limit = limit;
    this.#available = limit;
  }

  public async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    const release = await this.#acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return this.#releaseOnce();
    }
    return new Promise<() => void>((resolve) => this.#waiters.push(resolve));
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next !== undefined) {
        next(this.#releaseOnce());
      } else {
        this.#available += 1;
        if (this.#available > this.#limit) {
          throw new Error("semaphore released beyond its configured limit");
        }
      }
    };
  }
}

/**
 * Bounded mapping which stops admitting new work after the first failure and drains every sibling
 * already admitted before propagating that exact first error.
 */
export async function mapBoundedDrained<Input, Output>(
  values: readonly Input[],
  limit: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("bounded map limit must be a positive safe integer");
  }
  const results = new Array<Output>(values.length);
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = cursor;
      if (index >= values.length) return;
      cursor += 1;
      try {
        results[index] = await mapper(values[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, values.length) }, () => worker());
  await Promise.all(workers);
  if (failed) throw firstError;
  return results;
}
