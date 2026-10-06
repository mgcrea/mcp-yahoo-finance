import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { YahooFinanceApiError } from "#/client/errors";
import type { Portfolio, YahooClient } from "#/client/http";
import { normalizeTicker } from "#/lib/ticker";
import { wrap } from "#/tools/util";

type Watchlist = { pfId: string; name: string | null; type: string | null; symbols: string[] };

const toWatchlist = (p: Portfolio): Watchlist => ({
  pfId: p.pfId,
  name: p.pfName ?? null,
  type: p.pfType ?? null,
  symbols: (p.positions ?? [])
    .toSorted((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((pos) => pos.symbol),
});

const pfIdInput = z.string().describe("The list's pfId, from yahoo_list_watchlists, e.g. 'p_3'");
const symbolsInput = z.array(z.string()).min(1).describe("Ticker symbols, e.g. ['AAPL', 'BRK.B']");

// Yahoo stores symbols uppercase, so `nvda` must match the NVDA already listed.
const uniqueTickers = (symbols: string[]): string[] => [
  ...new Set(symbols.map((s) => normalizeTicker(s).toUpperCase())),
];

/**
 * Fetch the account and the one list a write targets. Writes stop at
 * watchlists: in a manual portfolio a position carries lots and transactions,
 * and deleting it deletes those with it.
 */
const loadWatchlist = async (client: YahooClient, pfId: string) => {
  const account = await client.portfolios();
  const lists = account.portfolios ?? [];
  const list = lists.find((p) => p.pfId === pfId);
  if (!list) {
    const known = lists.map((p) => `${p.pfId} (${p.pfName ?? "unnamed"})`).join(", ");
    throw new YahooFinanceApiError(`No list with pfId ${pfId}. Lists: ${known || "none"}.`);
  }
  if (list.pfType !== "WATCHLIST") {
    throw new YahooFinanceApiError(
      `${pfId} is a ${list.pfType ?? "non-watchlist"}, not a WATCHLIST. Only watchlists can be ` +
        "edited here: a portfolio's positions hold lots and transactions.",
    );
  }
  if (!account.userId) throw new YahooFinanceApiError("Yahoo did not return the account's userId.");
  return { userId: account.userId, list };
};

// Each write answers with the updated lists; fall back to the old one if not.
const pick = (lists: Portfolio[], pfId: string, fallback: Portfolio): Portfolio =>
  lists.find((p) => p.pfId === pfId) ?? fallback;

/**
 * Tools that read and edit the signed-in account's watchlists. Registered only
 * when YAHOO_FINANCE_COOKIE carries Yahoo's login cookie — anonymously these
 * endpoints have no account to act on. The tools that change the account also
 * need YAHOO_FINANCE_ALLOW_WRITES, so a read-only profile never sees them.
 */
export const registerWatchlistTools = (
  server: McpServer,
  client: YahooClient,
  { allowWrites }: { allowWrites: boolean },
): void => {
  server.registerTool(
    "yahoo_list_watchlists",
    {
      title: "Yahoo Finance: List Watchlists",
      description:
        "List the signed-in account's watchlists and portfolios, as an array of " +
        "{pfId, name, type, symbols}. type is WATCHLIST or MANUAL_PORTFOLIO; only watchlists " +
        "can be edited. Use the pfId with the other watchlist tools.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ((await client.portfolios()).portfolios ?? []).map(toWatchlist)),
  );

  if (!allowWrites) return;

  server.registerTool(
    "yahoo_create_watchlist",
    {
      title: "Yahoo Finance: Create Watchlist",
      description:
        "Create a watchlist on the signed-in account, optionally with its first symbols. " +
        "Returns the new {pfId, name, type, symbols}.",
      inputSchema: z.object({
        name: z.string().min(1).describe("The watchlist's name"),
        symbols: symbolsInput.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, symbols }) =>
      wrap(async () => {
        const account = await client.portfolios();
        if (!account.userId) {
          throw new YahooFinanceApiError("Yahoo did not return the account's userId.");
        }
        const before = new Set((account.portfolios ?? []).map((p) => p.pfId));
        const lists = await client.updatePortfolio({
          userId: account.userId,
          operations: [
            {
              operation: "portfolio_update",
              pfName: name,
              baseCurrency: "USD",
              defaultPf: false,
              // What finance.yahoo.com sends once the account is on Yahoo's
              // newer portfolio model; older accounts get neither field.
              ...(account.hasMigratedToNewModel
                ? { pfType: "WATCHLIST", hasMigratedToNewModel: true }
                : {}),
            },
            ...uniqueTickers(symbols ?? []).map((symbol, sortOrder) => ({
              operation: "position_insert",
              symbol,
              sortOrder,
              onePortfolio: true,
            })),
          ],
        });
        const created =
          lists.find((p) => !before.has(p.pfId)) ?? lists.find((p) => p.pfName === name);
        if (!created) throw new YahooFinanceApiError("Yahoo did not return the new watchlist.");
        return toWatchlist(created);
      }),
  );

  server.registerTool(
    "yahoo_add_to_watchlist",
    {
      title: "Yahoo Finance: Add to Watchlist",
      description:
        "Add symbols to the end of a watchlist. Symbols already on it are skipped and listed " +
        "under skipped. Returns {watchlist, skipped}.",
      inputSchema: z.object({ pfId: pfIdInput, symbols: symbolsInput }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ pfId, symbols }) =>
      wrap(async () => {
        const { userId, list } = await loadWatchlist(client, pfId);
        const current = toWatchlist(list);
        const present = new Set(current.symbols);
        const wanted = uniqueTickers(symbols);
        const toAdd = wanted.filter((s) => !present.has(s));
        const skipped = wanted.filter((s) => present.has(s));
        if (!toAdd.length) return { watchlist: current, skipped };

        const lists = await client.updatePortfolio({
          pfId,
          userId,
          operations: toAdd.map((symbol, i) => ({
            operation: "position_insert",
            symbol,
            sortOrder: current.symbols.length + i,
          })),
        });
        return { watchlist: toWatchlist(pick(lists, pfId, list)), skipped };
      }),
  );

  server.registerTool(
    "yahoo_remove_from_watchlist",
    {
      title: "Yahoo Finance: Remove from Watchlist",
      description:
        "Remove symbols from a watchlist. Symbols not on it are listed under notFound. " +
        "Returns {watchlist, notFound}.",
      inputSchema: z.object({ pfId: pfIdInput, symbols: symbolsInput }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ pfId, symbols }) =>
      wrap(async () => {
        const { userId, list } = await loadWatchlist(client, pfId);
        // Yahoo removes by position id, not by symbol.
        const posIds = new Map((list.positions ?? []).map((p) => [p.symbol, p.posId]));
        const wanted = uniqueTickers(symbols);
        const found = wanted.filter((s) => posIds.has(s));
        const notFound = wanted.filter((s) => !posIds.has(s));
        if (!found.length) return { watchlist: toWatchlist(list), notFound };

        const lists = await client.updatePortfolio({
          pfId,
          userId,
          operations: found.map((s) => ({ operation: "position_delete", posId: posIds.get(s)! })),
        });
        return { watchlist: toWatchlist(pick(lists, pfId, list)), notFound };
      }),
  );

  server.registerTool(
    "yahoo_delete_watchlist",
    {
      title: "Yahoo Finance: Delete Watchlist",
      description:
        "Permanently delete a watchlist. Returns {deleted} with the name and symbols it held, " +
        "which yahoo_create_watchlist can use to recreate it.",
      inputSchema: z.object({ pfId: pfIdInput }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ pfId }) =>
      wrap(async () => {
        const { userId, list } = await loadWatchlist(client, pfId);
        await client.deletePortfolio(pfId, userId);
        return { deleted: toWatchlist(list) };
      }),
  );
};
