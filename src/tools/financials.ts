import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { YahooClient } from "../client/http";
import { periodToRange } from "../lib/period";
import { reshapeStatement, reshapeTimeseries, timeseriesType } from "../lib/reshape";
import { wrap } from "./util";

const FINANCIAL_TYPES = [
  "income_stmt",
  "quarterly_income_stmt",
  "balance_sheet",
  "quarterly_balance_sheet",
  "cashflow",
  "quarterly_cashflow",
] as const;
type FinancialType = (typeof FINANCIAL_TYPES)[number];

// financial_type → { timeseries module, period prefix } + quoteSummary fallback.
const MAP: Record<
  FinancialType,
  { module: string; prefix: "annual" | "quarterly"; fbModule: string; fbKey: string }
> = {
  income_stmt: {
    module: "financials",
    prefix: "annual",
    fbModule: "incomeStatementHistory",
    fbKey: "incomeStatementHistory",
  },
  quarterly_income_stmt: {
    module: "financials",
    prefix: "quarterly",
    fbModule: "incomeStatementHistoryQuarterly",
    fbKey: "incomeStatementHistory",
  },
  balance_sheet: {
    module: "balance-sheet",
    prefix: "annual",
    fbModule: "balanceSheetHistory",
    fbKey: "balanceSheetStatements",
  },
  quarterly_balance_sheet: {
    module: "balance-sheet",
    prefix: "quarterly",
    fbModule: "balanceSheetHistoryQuarterly",
    fbKey: "balanceSheetStatements",
  },
  cashflow: {
    module: "cash-flow",
    prefix: "annual",
    fbModule: "cashflowStatementHistory",
    fbKey: "cashflowStatements",
  },
  quarterly_cashflow: {
    module: "cash-flow",
    prefix: "quarterly",
    fbModule: "cashflowStatementHistoryQuarterly",
    fbKey: "cashflowStatements",
  },
};

export const registerFinancialTools = (server: McpServer, client: YahooClient): void => {
  server.registerTool(
    "get_financial_statement",
    {
      description:
        "Get a financial statement for a ticker as an array of period objects (each with a " +
        "`date` plus the statement's line-item metrics), newest first. " +
        "financial_type selects the statement and annual/quarterly cadence.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
        financial_type: z
          .enum(FINANCIAL_TYPES)
          .describe("Which statement: income / balance sheet / cash flow, annual or quarterly"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ticker, financial_type }) =>
      wrap(async () => {
        const { module, prefix, fbModule, fbKey } = MAP[financial_type];
        const { period1, period2 } = periodToRange("5y");
        const series = await client.fundamentalsTimeSeries(ticker, {
          type: timeseriesType(module, prefix),
          period1,
          period2,
        });
        const rows = reshapeTimeseries(series as never);
        if (rows.length > 0) return rows;

        // Fallback: the deprecated quoteSummary statement modules.
        const summary = await client.quoteSummary(ticker, [fbModule]);
        const mod = summary[fbModule] as Record<string, unknown> | undefined;
        return reshapeStatement(mod?.[fbKey] as never);
      }),
  );
};
