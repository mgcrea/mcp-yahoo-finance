import type { McpServer } from "@modelcontextprotocol/server";

import type { YahooClient } from "#/client/http";
import { registerFinancialTools } from "#/tools/financials";
import { registerHolderTools } from "#/tools/holders";
import { registerInfoTools } from "#/tools/info";
import { registerNewsTools } from "#/tools/news";
import { registerOptionTools } from "#/tools/options";
import { registerPriceTools } from "#/tools/prices";
import { registerRecommendationTools } from "#/tools/recommendations";
import { registerWatchlistTools } from "#/tools/watchlists";

export type RegisterToolsOptions = {
  /** Register the tools that change the account (YAHOO_FINANCE_ALLOW_WRITES). */
  allowWrites?: boolean;
};

/** Register every Yahoo Finance tool on the MCP server. */
export const registerTools = (
  server: McpServer,
  client: YahooClient,
  { allowWrites = false }: RegisterToolsOptions = {},
): void => {
  registerPriceTools(server, client);
  registerInfoTools(server, client);
  registerNewsTools(server, client);
  registerFinancialTools(server, client);
  registerHolderTools(server, client);
  registerOptionTools(server, client);
  registerRecommendationTools(server, client);
  if (client.signedIn) registerWatchlistTools(server, client, { allowWrites });
};
