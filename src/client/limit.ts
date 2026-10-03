import { YahooFinanceApiError } from "#/client/errors";

/**
 * Wrap `fetch` with a concurrency cap and a per-request timeout. Applied once,
 * below both the crumb handshake and the API calls, so every request Yahoo sees
 * counts against the same budget. The cap is what keeps a model fanning out
 * across a watchlist (`Promise.all` over twenty tickers) from tripping Yahoo's
 * 429; the timeout is what keeps a stalled connection from hanging a tool call.
 */
export const limitFetch = (
  fetchImpl: typeof fetch,
  opts: { concurrency: number; timeoutMs: number },
): typeof fetch => {
  let active = 0;
  const queue: (() => void)[] = [];

  const acquire = async (): Promise<void> => {
    if (active < opts.concurrency) {
      active += 1;
      return;
    }
    // The releasing request hands its slot straight over, so `active` stays put.
    await new Promise<void>((resolve) => queue.push(resolve));
  };
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  };

  return async (input, init) => {
    await acquire();
    try {
      // The signal keeps governing the body read after headers arrive, so a
      // stalled body still aborts — the slot, though, is freed at headers.
      return await fetchImpl(input, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new YahooFinanceApiError(
          `Yahoo Finance did not answer within ${opts.timeoutMs} ms. Retry, or raise ` +
            "YAHOO_FINANCE_REQUEST_TIMEOUT_MS.",
        );
      }
      throw err;
    } finally {
      release();
    }
  };
};
