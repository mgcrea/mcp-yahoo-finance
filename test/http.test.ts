import { describe, expect, it } from "vitest";

import { YahooFinanceApiError } from "#/client/errors";
import { YahooClient } from "#/client/http";
import { loadConfig } from "#/config";

// What Yahoo really sends for a rejected crumb: the error sits under
// `finance` whatever the endpoint, and HTTP/2 carries no status text.
const unauthorized = () =>
  new Response(
    JSON.stringify({
      finance: {
        result: null,
        error: {
          code: "Unauthorized",
          description:
            "User is unable to access this feature - https://bit.ly/yahoo-finance-api-feedback",
        },
      },
    }),
    { status: 401, statusText: "" },
  );

const quoteFailure = async (env: NodeJS.ProcessEnv): Promise<YahooFinanceApiError> => {
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("getcrumb")) return new Response("fresh-crumb");
    if (url.includes("finance.yahoo.com/quote")) return new Response("<html></html>");
    return unauthorized();
  }) as typeof globalThis.fetch;
  const client = new YahooClient({ config: loadConfig(env), fetch });
  const err = await client.quote(["AAPL"]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(YahooFinanceApiError);
  return err as YahooFinanceApiError;
};

describe("YahooClient on HTTP 401", () => {
  it("reports Yahoo's reason, status and code instead of an empty message", async () => {
    const err = await quoteFailure({});
    expect(err.message).toContain("User is unable to access this feature");
    expect(err.status).toBe(401);
    expect(err.code).toBe("Unauthorized");
  });

  it("points at the supplied cookie and crumb when those were rejected", async () => {
    const err = await quoteFailure({
      YAHOO_FINANCE_COOKIE: "A3=stale",
      YAHOO_FINANCE_CRUMB: "stale",
    });
    expect(err.message).toContain("YAHOO_FINANCE_COOKIE");
    expect(err.message).toContain("User is unable to access this feature");
    expect(err.status).toBe(401);
  });

  it("falls back to the status code when the body says nothing", async () => {
    const fetch = (async (input: string | URL | Request) =>
      String(input).includes("/v8/finance/chart")
        ? new Response("", { status: 503, statusText: "" })
        : new Response("<html></html>")) as typeof globalThis.fetch;
    const client = new YahooClient({ config: loadConfig({}), fetch });
    const err = await client
      .chart("AAPL", { period1: 0, period2: 1, interval: "1d" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe("HTTP 503");
  });
});
