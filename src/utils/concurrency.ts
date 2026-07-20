/** Minimal cancellation token interface (compatible with vscode.CancellationToken). */
export interface CancellationLike {
  isCancellationRequested: boolean;
}

export class CancelledError extends Error {
  constructor() {
    super("Operation cancelled.");
    this.name = "CancelledError";
  }
}

/**
 * Run an async `worker` over `items` with a bounded number of concurrent
 * executions. Results are returned in input order. Individual failures are
 * captured per item so a single failure does not abort the batch.
 *
 * @param items Input items.
 * @param concurrency Maximum simultaneous workers (clamped to >= 1).
 * @param worker Async function producing a result for each item.
 * @param token Optional cancellation token; when cancelled, no new work starts.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  token?: CancellationLike
): Promise<Array<PromiseSettledResult<R>>> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;

  async function run(): Promise<void> {
    while (true) {
      if (token?.isCancellationRequested) {
        return;
      }
      const current = next++;
      if (current >= items.length) {
        return;
      }
      try {
        const value = await worker(items[current], current);
        results[current] = { status: "fulfilled", value };
      } catch (reason) {
        results[current] = { status: "rejected", reason };
      }
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

/** Throw {@link CancelledError} if the token has been cancelled. */
export function throwIfCancelled(token?: CancellationLike): void {
  if (token?.isCancellationRequested) {
    throw new CancelledError();
  }
}
