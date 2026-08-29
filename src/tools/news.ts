import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { YahooClient } from "../client/http";
import { toISO } from "../lib/format";
import { wrap } from "./util";

type NewsItem = {
  uuid?: string;
  title?: string;
  publisher?: string;
  link?: string;
  providerPublishTime?: number;
  type?: string;
};

export const registerNewsTools = (server: McpServer, client: YahooClient): void => {
  server.registerTool(
    "yahoo_get_yahoo_finance_news",
    {
      description:
        "Get recent Yahoo Finance news articles for a ticker, as an array of " +
        "{uuid, title, publisher, link, publishedAt, type}.",
      inputSchema: {
        ticker: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ticker }) =>
      wrap(async () => {
        const result = await client.search(ticker);
        return ((result.news ?? []) as NewsItem[]).map((n) => ({
          uuid: n.uuid ?? null,
          title: n.title ?? null,
          publisher: n.publisher ?? null,
          link: n.link ?? null,
          publishedAt: toISO(n.providerPublishTime),
          type: n.type ?? null,
        }));
      }),
  );
};
