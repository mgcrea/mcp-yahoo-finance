import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ChartResult, YahooClient } from "#/client/http";
import { toISO } from "#/lib/format";
import { INTERVALS, PERIODS, periodToRange } from "#/lib/period";
import { wrap } from "#/tools/util";

const at = <T>(arr: (T | null | undefined)[] | undefined, i: number): T | null =>
  (arr?.[i] ?? null) as T | null;

/** Flatten a `chart` result into row-per-timestamp OHLCV objects. */
const toOhlcvRows = (chart: ChartResult): Record<string, unknown>[] => {
  const timestamps = chart.timestamp ?? [];
  const quote = chart.indicators?.quote?.[0] ?? {};
  const adjclose = chart.indicators?.adjclose?.[0]?.adjclose;
  return timestamps.map((ts, i) => ({
    date: toISO(ts),
    open: at<number>(quote.open, i),
    high: at<number>(quote.high, i),
    low: at<number>(quote.low, i),
    close: at<number>(quote.close, i),
    adjclose: at<number>(adjclose, i),
    volume: at<number>(quote.volume, i),
  }));
};

export const registerPriceTools = (server: McpServer, client: YahooClient): void => {
  server.registerTool(
    "yahoo_get_historical_stock_prices",
    {
      title: "Yahoo Finance: Get Historical Stock Prices",
      description:
        "Get historical OHLCV stock prices for a ticker as an array of " +
        "{date, open, high, low, close, adjclose, volume}. " +
        "Intraday intervals (1m–90m) only return roughly the last 60 days of data.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
        period: z.enum(PERIODS).default("1mo").describe("Time range (default 1mo)"),
        interval: z.enum(INTERVALS).default("1d").describe("Candle interval (default 1d)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ticker, period, interval }) =>
      wrap(async () => {
        const { period1, period2 } = periodToRange(period);
        const chart = await client.chart(ticker, { period1, period2, interval });
        return toOhlcvRows(chart);
      }),
  );

  server.registerTool(
    "yahoo_get_stock_actions",
    {
      title: "Yahoo Finance: Get Stock Actions",
      description:
        "Get dividend and stock-split history for a ticker, as " +
        "{dividends: [{date, amount}], splits: [{date, numerator, denominator, ratio}]}.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
        period: z.enum(PERIODS).default("max").describe("Time range (default max)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ticker, period }) =>
      wrap(async () => {
        const { period1, period2 } = periodToRange(period);
        const chart = await client.chart(ticker, {
          period1,
          period2,
          interval: "1d",
          events: "div|split",
        });
        const dividends = Object.values(chart.events?.dividends ?? {}).map((d) => ({
          date: toISO(d.date),
          amount: d.amount ?? null,
        }));
        const splits = Object.values(chart.events?.splits ?? {}).map((s) => ({
          date: toISO(s.date),
          numerator: s.numerator ?? null,
          denominator: s.denominator ?? null,
          ratio: s.splitRatio ?? null,
        }));
        return { dividends, splits };
      }),
  );
};
