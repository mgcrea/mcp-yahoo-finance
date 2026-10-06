import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { YahooClient } from "#/client/http";
import { wrap } from "#/tools/util";

/**
 * Tool that checks YAHOO_FINANCE_COOKIE against Yahoo. Registered whenever a
 * cookie is supplied, signed in or not, since a cookie missing its login is
 * exactly what it has to explain.
 */
export const registerAuthTools = (
  server: McpServer,
  client: YahooClient,
  { allowWrites }: { allowWrites: boolean },
): void => {
  server.registerTool(
    "yahoo_auth_status",
    {
      title: "Yahoo Finance: Auth Status",
      description:
        "Check whether the configured Yahoo cookie is still signed in, by listing the account " +
        "live. Returns {signedIn, loginCookie, cookies, lists, writes}, plus action when it is " +
        "not signed in. Yahoo does not reveal when a cookie expires; call this when watchlist " +
        "tools fail.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ({ ...(await client.authStatus()), writes: allowWrites })),
  );
};
