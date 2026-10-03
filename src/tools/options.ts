import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { YahooFinanceApiError } from "#/client/errors";
import type { YahooClient } from "#/client/http";
import { type Contract, OPTION_FIELDS, projectFields, windowStrikes } from "#/lib/options";
import { wrap } from "#/tools/util";

const toDateString = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toISOString().slice(0, 10);

export const registerOptionTools = (server: McpServer, client: YahooClient): void => {
  server.registerTool(
    "yahoo_get_option_expiration_dates",
    {
      title: "Yahoo Finance: Get Option Expiration Dates",
      description:
        "Get the available option expiration dates for a ticker, as an array of YYYY-MM-DD " +
        "strings. Use one of these with yahoo_get_option_chain.",
      inputSchema: z.object({
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ ticker }) =>
      wrap(async () => {
        const result = await client.options(ticker);
        const dates = (result.expirationDates ?? []) as number[];
        return dates.map(toDateString);
      }),
  );

  server.registerTool(
    "yahoo_get_option_chain",
    {
      title: "Yahoo Finance: Get Option Chain",
      description:
        "Get the option chain (calls or puts) for a ticker at a given expiration date. " +
        "Call yahoo_get_option_expiration_dates first to obtain a valid expiration_date. " +
        "A full chain is large — a liquid US name runs 40-90 strikes, ~15 columns each, per " +
        "expiration — so pass strike_window_pct and fields to fetch only what the analysis " +
        "needs, especially when comparing several expirations.",
      inputSchema: z.object({
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
        expiration_date: z.string().describe("Expiration date as YYYY-MM-DD"),
        option_type: z.enum(["calls", "puts"]).describe("Which side of the chain to return"),
        strike_window_pct: z
          .number()
          .positive()
          .max(1)
          .optional()
          .describe(
            "Keep only strikes within ± this fraction of the underlying's current price, e.g. " +
              "0.15 keeps 85%-115% of spot. Omit for every strike. If the window would be empty " +
              "or the price is unavailable, the full chain is returned instead.",
          ),
        fields: z
          .array(z.enum(OPTION_FIELDS))
          .optional()
          .describe(
            "Only return these columns per contract; strike is always included. Omit for all. " +
              'A good pricing set: ["bid", "ask", "lastPrice", "impliedVolatility", ' +
              '"openInterest", "volume"]. expiration and lastTradeDate are epoch seconds.',
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ ticker, expiration_date, option_type, strike_window_pct, fields }) =>
      wrap(async () => {
        const epoch = Math.floor(new Date(`${expiration_date}T00:00:00Z`).getTime() / 1000);
        if (!Number.isFinite(epoch)) {
          throw new YahooFinanceApiError(`Invalid expiration_date: ${expiration_date}`);
        }
        const result = await client.options(ticker, epoch);
        const chain = (
          result.options as { calls?: Contract[]; puts?: Contract[] }[] | undefined
        )?.[0];
        if (!chain) {
          throw new YahooFinanceApiError(
            `No option chain for ${ticker} on ${expiration_date}. ` +
              "Use yahoo_get_option_expiration_dates for valid dates.",
          );
        }
        // The options payload carries the underlying's quote, so the spot price
        // for the strike window costs no second request.
        const spot = (result.quote as { regularMarketPrice?: number } | undefined)
          ?.regularMarketPrice;
        const side = option_type === "calls" ? (chain.calls ?? []) : (chain.puts ?? []);
        return projectFields(windowStrikes(side, spot, strike_window_pct), fields);
      }),
  );
};
