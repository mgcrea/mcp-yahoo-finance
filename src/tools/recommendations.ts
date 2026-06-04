import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { YahooClient } from "../client/http";
import { toISO, unwrap } from "../lib/format";
import { wrap } from "./util";

type UpgradeRow = {
  firm?: string;
  toGrade?: string;
  fromGrade?: string;
  action?: string;
  epochGradeDate?: unknown;
};

export const registerRecommendationTools = (server: McpServer, client: YahooClient): void => {
  server.registerTool(
    "get_recommendations",
    {
      description:
        "Get analyst recommendations for a ticker. recommendation_type 'recommendations' returns " +
        "the buy/hold/sell trend; 'upgrades_downgrades' returns rating changes, filtered to the " +
        "last `months_back` months and deduped to the latest entry per firm.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
        recommendation_type: z
          .enum(["recommendations", "upgrades_downgrades"])
          .default("recommendations")
          .describe("Which dataset to return"),
        months_back: z
          .number()
          .int()
          .positive()
          .default(12)
          .describe("For upgrades_downgrades: how many months back to include (default 12)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ticker, recommendation_type, months_back }) =>
      wrap(async () => {
        if (recommendation_type === "recommendations") {
          const summary = await client.quoteSummary(ticker, ["recommendationTrend"]);
          const trend = (summary.recommendationTrend as { trend?: unknown[] } | undefined)?.trend;
          return trend ?? [];
        }

        const summary = await client.quoteSummary(ticker, ["upgradeDowngradeHistory"]);
        const history =
          (summary.upgradeDowngradeHistory as { history?: UpgradeRow[] } | undefined)?.history ??
          [];
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - months_back);

        const rows = history
          .map((h) => ({
            firm: h.firm ?? "",
            toGrade: h.toGrade ?? null,
            fromGrade: h.fromGrade ?? null,
            action: h.action ?? null,
            date: toISO(unwrap(h.epochGradeDate)),
          }))
          .filter((h) => h.date !== null && new Date(h.date) >= cutoff)
          .toSorted((a, b) => new Date(b.date!).getTime() - new Date(a.date!).getTime());

        // Keep only the most recent entry per firm (rows are already newest-first).
        const seen = new Set<string>();
        return rows.filter((h) => {
          if (seen.has(h.firm)) return false;
          seen.add(h.firm);
          return true;
        });
      }),
  );
};
