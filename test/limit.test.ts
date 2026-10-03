import { describe, expect, it } from "vitest";

import { YahooFinanceApiError } from "#/client/errors";
import { limitFetch } from "#/client/limit";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("limitFetch", () => {
  it("never has more than `concurrency` requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const pending: (() => void)[] = [];
    const fetch = (() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<Response>((resolve) =>
        pending.push(() => {
          inFlight -= 1;
          resolve(new Response("{}"));
        }),
      );
    }) as typeof globalThis.fetch;

    const limited = limitFetch(fetch, { concurrency: 2, timeoutMs: 10_000 });
    const all = Promise.all(Array.from({ length: 5 }, () => limited("https://x.test/")));
    await tick();
    expect(inFlight).toBe(2);
    while (pending.length > 0) {
      pending.shift()!();
      await tick();
    }
    await all;
    expect(peak).toBe(2);
  });

  it("frees the slot when a request fails", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      return new Response("{}");
    }) as typeof globalThis.fetch;
    const limited = limitFetch(fetch, { concurrency: 1, timeoutMs: 10_000 });
    await expect(limited("https://x.test/")).rejects.toThrow("network down");
    await expect(limited("https://x.test/")).resolves.toBeInstanceOf(Response);
  });

  it("turns a timeout into an actionable YahooFinanceApiError", async () => {
    const fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof globalThis.fetch;
    const limited = limitFetch(fetch, { concurrency: 1, timeoutMs: 20 });
    const err = await limited("https://x.test/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YahooFinanceApiError);
    expect((err as Error).message).toContain("YAHOO_FINANCE_REQUEST_TIMEOUT_MS");
  });
});
