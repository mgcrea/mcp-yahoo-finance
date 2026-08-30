import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { YahooClient } from "#/client/http";
import { wrap } from "#/tools/util";

const HOLDER_TYPES = [
  "major_holders",
  "institutional_holders",
  "mutualfund_holders",
  "insider_transactions",
  "insider_purchases",
  "insider_roster_holders",
] as const;
type HolderType = (typeof HOLDER_TYPES)[number];

// holder_type → quoteSummary module + the inner field to surface.
const MAP: Record<HolderType, { module: string; pick: (m: Record<string, unknown>) => unknown }> = {
  major_holders: { module: "majorHoldersBreakdown", pick: (m) => m },
  institutional_holders: { module: "institutionOwnership", pick: (m) => m.ownershipList ?? [] },
  mutualfund_holders: { module: "fundOwnership", pick: (m) => m.ownershipList ?? [] },
  insider_transactions: { module: "insiderTransactions", pick: (m) => m.transactions ?? [] },
  insider_purchases: { module: "netSharePurchaseActivity", pick: (m) => m },
  insider_roster_holders: { module: "insiderHolders", pick: (m) => m.holders ?? [] },
};

export const registerHolderTools = (server: McpServer, client: YahooClient): void => {
  server.registerTool(
    "yahoo_get_holder_info",
    {
      title: "Yahoo Finance: Get Holder Info",
      description:
        "Get ownership / holder information for a ticker. holder_type selects between major " +
        "holders breakdown, institutional holders, mutual-fund holders, insider transactions, " +
        "insider purchase activity, and the insider roster.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
        holder_type: z.enum(HOLDER_TYPES).describe("Which holder dataset to return"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ticker, holder_type }) =>
      wrap(async () => {
        const { module, pick } = MAP[holder_type];
        const summary = await client.quoteSummary(ticker, [module]);
        const mod = (summary[module] ?? {}) as Record<string, unknown>;
        return pick(mod);
      }),
  );
};
