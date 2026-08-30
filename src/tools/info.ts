import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { YahooClient } from "#/client/http";
import { wrap } from "#/tools/util";

// Broad module set approximating yfinance's `.info` — price, profile, key
// stats, financial metrics, and calendar/earnings context.
const INFO_MODULES = [
  "price",
  "summaryDetail",
  "summaryProfile",
  "assetProfile",
  "financialData",
  "defaultKeyStatistics",
  "quoteType",
  "calendarEvents",
  "earnings",
];

export const registerInfoTools = (server: McpServer, client: YahooClient): void => {
  server.registerTool(
    "yahoo_get_stock_info",
    {
      description:
        "Get comprehensive information for a ticker: current price & trading data, company " +
        "profile, financial metrics, key statistics, earnings, dividends and risk metrics. " +
        "Combines Yahoo's quote and quoteSummary data into a single flat object.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ticker }) =>
      wrap(async () => {
        const [quotes, summary] = await Promise.all([
          client.quote([ticker]),
          client.quoteSummary(ticker, INFO_MODULES),
        ]);
        const quote = (quotes[0] ?? {}) as Record<string, unknown>;
        // Flatten each summary module into the top-level object (≈ yfinance .info).
        const merged = Object.assign({}, quote, ...Object.values(summary));
        return merged;
      }),
  );
};
