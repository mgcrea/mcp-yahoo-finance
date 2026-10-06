import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { YahooFinanceApiError } from "#/client/errors";
import type { YahooClient } from "#/client/http";
import {
  describeHistory,
  historyOf,
  loadList,
  pickList,
  toListView,
  uniqueTickers,
} from "#/lib/portfolio";
import { wrap } from "#/tools/util";

const pfIdInput = z.string().describe("The list's pfId, from yahoo_list_watchlists, e.g. 'p_3'");
const symbolsInput = z.array(z.string()).min(1).describe("Ticker symbols, e.g. ['AAPL', 'BRK.B']");
// In a manual portfolio a position carries lots and transactions, and removing
// the position deletes them with it — so that takes an explicit yes.
const deleteHistoryInput = z
  .boolean()
  .optional()
  .describe(
    "Required to remove a portfolio position that holds lots or transactions, which are " +
      "deleted with it. Leave unset to be told what would be deleted instead.",
  );

/**
 * Tools that read and edit the signed-in account's watchlists and portfolios.
 * Registered only when YAHOO_FINANCE_COOKIE carries Yahoo's login cookie —
 * anonymously these endpoints have no account to act on. The tools that change
 * the account also need YAHOO_FINANCE_ALLOW_WRITES, so a read-only profile
 * never sees them.
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
        "{pfId, name, type, symbols}. type is WATCHLIST or MANUAL_PORTFOLIO. Use the pfId " +
        "with the other watchlist and portfolio transaction tools.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => ((await client.portfolios()).portfolios ?? []).map(toListView)),
  );

  if (!allowWrites) return;

  server.registerTool(
    "yahoo_create_watchlist",
    {
      title: "Yahoo Finance: Create Watchlist",
      description:
        "Create a watchlist, or a manual portfolio with type MANUAL_PORTFOLIO, optionally " +
        "with its first symbols. Returns the new {pfId, name, type, symbols}.",
      inputSchema: z.object({
        name: z.string().min(1).describe("The list's name"),
        symbols: symbolsInput.optional(),
        type: z
          .enum(["WATCHLIST", "MANUAL_PORTFOLIO"])
          .optional()
          .describe("WATCHLIST (the default), or MANUAL_PORTFOLIO to record trades in it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ name, symbols, type = "WATCHLIST" }) =>
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
              // newer portfolio model. An older account gets no type for a
              // watchlist, its default, but a portfolio still has to say so.
              ...(account.hasMigratedToNewModel
                ? { pfType: type, hasMigratedToNewModel: true }
                : type !== "WATCHLIST"
                  ? { pfType: type }
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
        if (!created) throw new YahooFinanceApiError("Yahoo did not return the new list.");
        return toListView(created);
      }),
  );

  server.registerTool(
    "yahoo_add_to_watchlist",
    {
      title: "Yahoo Finance: Add to Watchlist",
      description:
        "Add symbols to the end of a watchlist or portfolio. Symbols already on it are " +
        "skipped and listed under skipped. In a portfolio they start with no lots; record " +
        "trades with yahoo_add_portfolio_transaction. Returns {watchlist, skipped}.",
      inputSchema: z.object({ pfId: pfIdInput, symbols: symbolsInput }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ pfId, symbols }) =>
      wrap(async () => {
        const { userId, list } = await loadList(client, pfId);
        const current = toListView(list);
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
        return { watchlist: toListView(pickList(lists, pfId, list)), skipped };
      }),
  );

  server.registerTool(
    "yahoo_remove_from_watchlist",
    {
      title: "Yahoo Finance: Remove from Watchlist",
      description:
        "Remove symbols from a watchlist or portfolio. Symbols not on it are listed under " +
        "notFound. A portfolio position holding lots or transactions is only removed with " +
        "delete_history: true, and those are listed under deletedHistory. Returns " +
        "{watchlist, notFound, deletedHistory?}.",
      inputSchema: z.object({
        pfId: pfIdInput,
        symbols: symbolsInput,
        delete_history: deleteHistoryInput,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ pfId, symbols, delete_history }) =>
      wrap(async () => {
        const { userId, list } = await loadList(client, pfId);
        // Yahoo removes by position id, not by symbol.
        const bySymbol = new Map((list.positions ?? []).map((p) => [p.symbol, p]));
        const wanted = uniqueTickers(symbols);
        const found = wanted.filter((s) => bySymbol.has(s));
        const notFound = wanted.filter((s) => !bySymbol.has(s));
        if (!found.length) return { watchlist: toListView(list), notFound };

        const history = historyOf(found.map((s) => bySymbol.get(s)!));
        if (history.length && !delete_history) {
          throw new YahooFinanceApiError(
            "Removing deletes the lots and transactions these positions hold: " +
              `${describeHistory(history)}. Nothing was removed. Pass delete_history: true ` +
              "to remove them anyway.",
          );
        }
        const lists = await client.updatePortfolio({
          pfId,
          userId,
          operations: found.map((s) => ({
            operation: "position_delete",
            posId: bySymbol.get(s)!.posId,
          })),
        });
        return {
          watchlist: toListView(pickList(lists, pfId, list)),
          notFound,
          ...(history.length ? { deletedHistory: history } : {}),
        };
      }),
  );

  server.registerTool(
    "yahoo_delete_watchlist",
    {
      title: "Yahoo Finance: Delete Watchlist",
      description:
        "Permanently delete a watchlist or portfolio. A portfolio holding lots or " +
        "transactions is only deleted with delete_history: true. Returns {deleted} with the " +
        "name and symbols it held, which yahoo_create_watchlist can use to recreate it, and " +
        "deletedHistory when there was any.",
      inputSchema: z.object({ pfId: pfIdInput, delete_history: deleteHistoryInput }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ pfId, delete_history }) =>
      wrap(async () => {
        const { userId, list } = await loadList(client, pfId);
        const history = historyOf(list.positions ?? []);
        if (history.length && !delete_history) {
          throw new YahooFinanceApiError(
            `${pfId} (${list.pfName ?? "unnamed"}) holds lots and transactions that deleting ` +
              `it would erase: ${describeHistory(history)}. Nothing was deleted. Pass ` +
              "delete_history: true to delete it anyway.",
          );
        }
        await client.deletePortfolio(pfId, userId);
        return {
          deleted: toListView(list),
          ...(history.length ? { deletedHistory: history } : {}),
        };
      }),
  );
};
