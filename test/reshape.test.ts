import { describe, expect, it } from "vitest";

import { reshapeStatement, reshapeTimeseries, timeseriesType } from "#/lib/reshape";

describe("reshapeStatement", () => {
  it("pivots period rows into {date, ...metrics}, unwrapping and nulling NaN", () => {
    const rows = [
      {
        endDate: 1_700_000_000,
        maxAge: 1,
        totalRevenue: { raw: 1000, fmt: "1k" },
        netIncome: NaN,
      },
    ];
    expect(reshapeStatement(rows)).toEqual([
      { date: "2023-11-14T22:13:20.000Z", totalRevenue: 1000, netIncome: null },
    ]);
  });

  it("handles missing input", () => {
    expect(reshapeStatement(undefined)).toEqual([]);
  });
});

describe("reshapeTimeseries", () => {
  it("pivots per-metric series into date-keyed rows, newest first", () => {
    const series = [
      {
        meta: { type: ["annualTotalRevenue"] },
        annualTotalRevenue: [
          { asOfDate: "2022-12-31", reportedValue: { raw: 100 } },
          { asOfDate: "2023-12-31", reportedValue: { raw: 200 } },
        ],
      },
      {
        meta: { type: ["annualNetIncome"] },
        annualNetIncome: [{ asOfDate: "2023-12-31", reportedValue: { raw: 50 } }],
      },
    ];
    expect(reshapeTimeseries(series as never)).toEqual([
      { date: "2023-12-31", totalRevenue: 200, netIncome: 50 },
      { date: "2022-12-31", totalRevenue: 100 },
    ]);
  });
});

describe("timeseriesType", () => {
  it("prefixes each metric for the requested module + cadence", () => {
    const type = timeseriesType("cash-flow", "quarterly");
    expect(type).toContain("quarterlyOperatingCashFlow");
    expect(type).toContain("quarterlyFreeCashFlow");
  });

  it("returns empty string for unknown modules", () => {
    expect(timeseriesType("nope", "annual")).toBe("");
  });
});
