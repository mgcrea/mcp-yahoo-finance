import { describe, expect, it, vi } from "vitest";

import { YahooClient } from "#/client/http";
import { loadConfig } from "#/config";
import { normalizeTicker } from "#/lib/ticker";

describe("normalizeTicker", () => {
  it.each([
    ["BRK.B", "BRK-B"],
    ["BRK/B", "BRK-B"],
    ["brk.b", "BRK-B"],
    ["BF.A", "BF-A"],
    ["BRK-B", "BRK-B"],
    ["  BRK.B ", "BRK-B"],
  ])("rewrites the class share %s to %s", (input, expected) => {
    expect(normalizeTicker(input)).toBe(expected);
  });

  it.each(["AAPL", "SHOP.TO", "RIO.L", "7203.T", "0700.HK", "BHP.AX", "^GSPC", "EURUSD=X"])(
    "leaves %s untouched",
    (ticker) => {
      expect(normalizeTicker(ticker)).toBe(ticker);
    },
  );
});

// A supplied cookie + crumb skips the handshake, so fetch sees only API calls.
const makeClient = () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ quoteResponse: { result: [], error: null } }), {
        status: 200,
      }),
  );
  const client = new YahooClient({
    config: loadConfig({ YAHOO_FINANCE_COOKIE: "A3=x", YAHOO_FINANCE_CRUMB: "c" }),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const urls = () => fetch.mock.calls.map((call) => String((call as unknown[])[0]));
  return { client, urls };
};

describe("YahooClient ticker normalization", () => {
  it("sends the hyphenated symbol on path-based endpoints", async () => {
    const { client, urls } = makeClient();
    await client.quoteSummary("BRK.B", ["price"]);
    await client.options("brk/b");
    expect(urls()[0]).toContain("/quoteSummary/BRK-B?");
    expect(urls()[1]).toContain("/options/BRK-B?");
  });

  it("normalizes every symbol of a multi-symbol quote", async () => {
    const { client, urls } = makeClient();
    await client.quote(["BRK.B", "SHOP.TO"]);
    expect(new URL(urls()[0]!).searchParams.get("symbols")).toBe("BRK-B,SHOP.TO");
  });
});
