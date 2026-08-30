import { describe, expect, it, vi } from "vitest";

import type { YahooClient } from "#/client/http";
import { registerTools } from "#/tools/index";
import type { ToolResult } from "#/tools/util";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Minimal MCP-server stand-in that captures tool registrations. */
const fakeServer = () => {
  const tools = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => {
      tools.set(name, handler);
    },
  };
  return { server, tools };
};

const parse = (result: ToolResult): { data: unknown; isError: boolean } => ({
  data: JSON.parse(result.content[0]!.text),
  isError: result.isError ?? false,
});

const makeClient = (overrides: Partial<YahooClient> = {}): YahooClient =>
  ({
    chart: vi.fn(),
    quote: vi.fn(),
    quoteSummary: vi.fn(),
    search: vi.fn(),
    options: vi.fn(),
    fundamentalsTimeSeries: vi.fn(),
    ...overrides,
  }) as unknown as YahooClient;

describe("registerTools", () => {
  it("registers all 9 Yahoo Finance tools", () => {
    const { server, tools } = fakeServer();
    registerTools(server as never, makeClient());
    expect([...tools.keys()].toSorted()).toEqual([
      "yahoo_get_financial_statement",
      "yahoo_get_historical_stock_prices",
      "yahoo_get_holder_info",
      "yahoo_get_option_chain",
      "yahoo_get_option_expiration_dates",
      "yahoo_get_recommendations",
      "yahoo_get_stock_actions",
      "yahoo_get_stock_info",
      "yahoo_get_yahoo_finance_news",
    ]);
  });
});

describe("yahoo_get_historical_stock_prices handler", () => {
  it("calls chart with a derived range and flattens OHLCV rows", async () => {
    const chart = vi.fn().mockResolvedValue({
      timestamp: [1_700_000_000],
      indicators: {
        quote: [{ open: [1], high: [2], low: [0.5], close: [1.5], volume: [100] }],
        adjclose: [{ adjclose: [1.4] }],
      },
    });
    const { server, tools } = fakeServer();
    registerTools(server as never, makeClient({ chart }));

    const result = await tools.get("yahoo_get_historical_stock_prices")!({
      ticker: "AAPL",
      period: "5d",
      interval: "1d",
    });

    expect(chart).toHaveBeenCalledOnce();
    const [symbol, params] = chart.mock.calls[0]!;
    expect(symbol).toBe("AAPL");
    expect(params.interval).toBe("1d");
    expect(params.period1).toBeGreaterThan(0);
    expect(params.period2).toBeGreaterThan(params.period1);

    const { data, isError } = parse(result);
    expect(isError).toBe(false);
    expect(data).toEqual([
      {
        date: "2023-11-14T22:13:20.000Z",
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        adjclose: 1.4,
        volume: 100,
      },
    ]);
  });
});

describe("yahoo_get_recommendations handler", () => {
  it("dedupes upgrades/downgrades to the latest entry per firm", async () => {
    const quoteSummary = vi.fn().mockResolvedValue({
      upgradeDowngradeHistory: {
        history: [
          { firm: "BigBank", toGrade: "Buy", epochGradeDate: 1_716_000_000 },
          { firm: "BigBank", toGrade: "Hold", epochGradeDate: 1_710_000_000 },
          { firm: "SmallCap", toGrade: "Sell", epochGradeDate: 1_715_000_000 },
        ],
      },
    });
    const { server, tools } = fakeServer();
    registerTools(server as never, makeClient({ quoteSummary }));

    const result = await tools.get("yahoo_get_recommendations")!({
      ticker: "AAPL",
      recommendation_type: "upgrades_downgrades",
      months_back: 600,
    });

    const { data } = parse(result);
    const rows = data as { firm: string; toGrade: string }[];
    expect(rows).toHaveLength(2);
    const bigBank = rows.find((r) => r.firm === "BigBank");
    expect(bigBank?.toGrade).toBe("Buy"); // the newer of the two BigBank entries
  });
});

describe("error handling", () => {
  it("returns an isError tool result when the client throws", async () => {
    const quote = vi.fn().mockRejectedValue(new Error("Quote not found for ticker symbol"));
    const { server, tools } = fakeServer();
    registerTools(
      server as never,
      makeClient({ quote, quoteSummary: vi.fn().mockResolvedValue({}) }),
    );

    const result = await tools.get("yahoo_get_stock_info")!({ ticker: "NOPE" });
    const { data, isError } = parse(result);
    expect(isError).toBe(true);
    expect((data as { error: string }).error).toMatch(/not found/i);
  });
});
