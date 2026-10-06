import { describe, expect, it } from "vitest";

import { YahooCookieRejectedError } from "#/client/errors";
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

// Shapes as Yahoo answered them on 2026-10-06, against a throwaway portfolio.
const BUY = {
  id: "transaction_941a",
  positionId: "pos_0",
  lotId: "lot_941a",
  symbol: "AAPL",
  type: "BUY",
  date: "20261001",
  quantity: 10,
  pricePerShare: 250.5,
  commission: 1,
  totalValue: 2506,
  comment: "",
};

describe("YahooClient transaction endpoints", () => {
  it("reads a position's trades", async () => {
    const { client, calls } = recordingClient(() => ({ transactions: [BUY], totalCount: 1 }));

    expect(await client.transactions("p_8", "pos_0")).toEqual([BUY]);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.host).toBe("query1.finance.yahoo.com");
    expect(calls[0]!.url.pathname).toBe("/ws/portfolio-api/v1/portfolio/transactions");
    expect(params(calls[0]!.url)).toEqual({
      pfId: "p_8",
      positionId: "pos_0",
      category: "trades",
      crumb: "c1",
    });
  });

  it("adds a transaction with a POST and edits one with a PUT", async () => {
    const reply = { newTransactionMeta: { id: "transaction_941a" }, transactions: [BUY] };
    const { client, calls } = recordingClient(() => reply);
    const transaction = {
      pfId: "p_8",
      positionId: "pos_0",
      type: "BUY",
      date: "20261001",
      quantity: 10,
      pricePerShare: 250.5,
      commission: 1,
      comment: "",
    };

    expect(await client.saveTransaction(transaction)).toEqual(reply);
    await client.saveTransaction({ ...transaction, id: "transaction_941a" });

    expect(calls.map((c) => c.method)).toEqual(["POST", "PUT"]);
    expect(calls[0]!.url.pathname).toBe("/ws/portfolio-api/v1/portfolio/transaction");
    expect(calls[0]!.contentType).toBe("application/json");
    expect(calls[0]!.body).toEqual({ transaction });
    expect(calls[1]!.body).toEqual({ transaction: { ...transaction, id: "transaction_941a" } });
  });

  it("deletes a transaction with a DELETE naming it in the query", async () => {
    const { client, calls } = recordingClient(() => ({ transactions: [] }));

    await client.deleteTransaction({ pfId: "p_8", positionId: "pos_0", id: "transaction_941a" });
    expect(calls[0]!.method).toBe("DELETE");
    expect(params(calls[0]!.url)).toEqual({
      pfId: "p_8",
      positionId: "pos_0",
      id: "transaction_941a",
      crumb: "c1",
    });
    expect(calls[0]!.body).toBeUndefined();
  });
});

describe("YahooClient transaction endpoints with a signed-out cookie", () => {
  // What Yahoo answers an account endpoint once the T login has expired.
  const signedOut = () =>
    new Response(
      JSON.stringify({
        finance: {
          result: null,
          error: {
            code: "Forbidden",
            description: "Unable to authenticate user against member profile.",
          },
        },
      }),
      { status: 403 },
    );
  const client = () => {
    const fetch = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname === "/v1/test/getcrumb"
        ? new Response("c1")
        : signedOut()) as typeof globalThis.fetch;
    return new YahooClient({ config: loadConfig(SIGNED_IN), fetch });
  };
  const trade = {
    pfId: "p_8",
    positionId: "pos_0",
    type: "BUY",
    date: "20261001",
    quantity: 1,
    pricePerShare: 1,
    commission: 0,
    comment: "",
  };

  it.each([
    ["transactions", () => client().transactions("p_8", "pos_0")],
    ["saveTransaction", () => client().saveTransaction(trade)],
    [
      "deleteTransaction",
      () => client().deleteTransaction({ pfId: "p_8", positionId: "pos_0", id: "t" }),
    ],
  ])("%s says the login expired, as the portfolio calls do", async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(YahooCookieRejectedError);
  });
});
