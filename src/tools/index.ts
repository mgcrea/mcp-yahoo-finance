import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { YahooClient } from "../client/http";
import { registerFinancialTools } from "./financials";
import { registerHolderTools } from "./holders";
import { registerInfoTools } from "./info";
import { registerNewsTools } from "./news";
import { registerOptionTools } from "./options";
import { registerPriceTools } from "./prices";
import { registerRecommendationTools } from "./recommendations";

/** Register every Yahoo Finance tool on the MCP server. */
export const registerTools = (server: McpServer, client: YahooClient): void => {
  registerPriceTools(server, client);
  registerInfoTools(server, client);
  registerNewsTools(server, client);
  registerFinancialTools(server, client);
  registerHolderTools(server, client);
  registerOptionTools(server, client);
  registerRecommendationTools(server, client);
};
