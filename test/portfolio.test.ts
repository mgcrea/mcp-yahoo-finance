import { describe, expect, it } from "vitest";

import { YahooClient } from "#/client/http";
import { loadConfig } from "#/config";

type Call = { url: URL; method: string; contentType: string | null; body: unknown };

const SIGNED_IN = { YAHOO_FINANCE_COOKIE: "A3=anon; T=login; Y=user" };

// Records each request and answers getcrumb, then whatever `reply` returns.
const recordingClient = (reply: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/test/getcrumb") return new Response("c1");
    const headers = new Headers(init?.headers);
    const call = {
      url,
      method: init?.method ?? "GET",
      contentType: headers.get("content-type"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)));
  }) as typeof globalThis.fetch;
  return { client: new YahooClient({ config: loadConfig(SIGNED_IN), fetch }), calls };
};

const params = (url: URL) => Object.fromEntries(url.searchParams);

describe("YahooClient portfolio endpoints", () => {
  it("lists every portfolio with the account's userId", async () => {
    const all = { userId: "U1", portfolios: [{ pfId: "p_3", pfName: "Watch" }] };
    const { client, calls } = recordingClient(() => ({ finance: { result: [all], error: null } }));

    expect(await client.portfolios()).toEqual(all);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.host).toBe("query1.finance.yahoo.com");
    expect(calls[0]!.url.pathname).toBe("/v7/finance/desktop/portfolio/all");
    expect(params(calls[0]!.url).crumb).toBe("c1");
  });

  it("updates a portfolio with a PUT carrying the operations as JSON", async () => {
    const updated = { pfId: "p_3", positions: [] };
    const { client, calls } = recordingClient(() => ({
      finance: { result: [updated], error: null },
    }));
    const operations = [{ operation: "position_insert", symbol: "AAPL", sortOrder: 5 }];

    expect(await client.updatePortfolio({ pfId: "p_3", userId: "U1", operations })).toEqual([
      updated,
    ]);
    const [call] = calls;
    expect(call!.method).toBe("PUT");
    expect(call!.url.host).toBe("query1.finance.yahoo.com");
    expect(call!.url.pathname).toBe("/v6/finance/portfolio/update");
    expect(params(call!.url)).toEqual({ action: "update", pfId: "p_3", userId: "U1", crumb: "c1" });
    expect(call!.contentType).toBe("application/json");
    expect(call!.body).toEqual({
      operations,
      parameters: { fullResponse: true, pfId: "p_3", userId: "U1", userIdType: "guid" },
    });
  });

  it("creates a portfolio with a POST when no pfId is given", async () => {
    const { client, calls } = recordingClient(() => ({ finance: { result: [], error: null } }));
    const operations = [{ operation: "portfolio_update", pfName: "New" }];

    await client.updatePortfolio({ userId: "U1", operations });
    expect(calls[0]!.method).toBe("POST");
    expect(params(calls[0]!.url)).toEqual({ method: "create", userId: "U1", crumb: "c1" });
    expect(calls[0]!.body).toEqual({
      operations,
      parameters: { fullResponse: true, userId: "U1", userIdType: "guid" },
    });
  });

  it("deletes a portfolio with a DELETE and no body", async () => {
    const { client, calls } = recordingClient(() => ({ finance: { result: null, error: null } }));

    await client.deletePortfolio("p_5", "U1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.pathname).toBe("/v6/finance/portfolio");
    expect(params(calls[0]!.url)).toEqual({ pfId: "p_5", userId: "U1", crumb: "c1" });
    expect(calls[0]!.body).toBeUndefined();
  });

  it("surfaces Yahoo's error when a write is refused", async () => {
    const { client } = recordingClient(() => ({
      finance: { result: null, error: { code: "Bad Request", description: "Invalid pfId" } },
    }));
    await expect(client.deletePortfolio("p_9", "U1")).rejects.toThrow("Invalid pfId");
  });
});

describe("YahooClient.signedIn", () => {
  it.each([
    [{}, false],
    [{ YAHOO_FINANCE_COOKIE: "A3=anon" }, false],
    [{ YAHOO_FINANCE_COOKIE: "A3=anon; GUCS=x" }, false],
    [SIGNED_IN, true],
    [{ YAHOO_FINANCE_COOKIE: "T=login" }, true],
  ])("is %o → %s, keyed on Yahoo's T login cookie", (env, expected) => {
    expect(new YahooClient({ config: loadConfig(env) }).signedIn).toBe(expected);
  });
});
