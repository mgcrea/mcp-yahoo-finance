import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { YahooFinanceApiError } from "#/client/errors";
import type { Transaction, YahooClient } from "#/client/http";
import { loadList, uniqueTickers } from "#/lib/portfolio";
import { wrap } from "#/tools/util";

// Yahoo stores trade dates as YYYYMMDD; a hyphenated date is answered with a 500.
const toYahooDate = (iso: string): string => iso.replaceAll("-", "");
const fromYahooDate = (d: string | undefined): string | null =>
  d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null;

const toTrade = (t: Transaction) => ({
  id: t.id,
  type: t.type ?? null,
  date: fromYahooDate(t.date),
  quantity: t.quantity ?? null,
  pricePerShare: t.pricePerShare ?? null,
  commission: t.commission ?? null,
  totalValue: t.totalValue ?? null,
  comment: t.comment ?? null,
});

const pfIdInput = z.string().describe("The portfolio's pfId, from yahoo_list_watchlists");
const symbolInput = z.string().describe("Ticker symbol, e.g. 'AAPL'");
const idInput = z.string().describe("The transaction id, from yahoo_get_portfolio_transactions");
const typeInput = z.enum(["BUY", "SELL"]).describe("BUY or SELL");
const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
  .describe("Trade date as YYYY-MM-DD");
const quantityInput = z.number().positive().describe("Number of shares");
const priceInput = z
  .number()
  .nonnegative()
  .describe("Price per share, in the portfolio's currency");
const commissionInput = z.number().nonnegative().describe("Commission paid for the trade");
const commentInput = z.string().describe("Free-text note");

/** The portfolio and the position a transaction call targets. Watchlists hold no trades. */
const loadHolding = async (client: YahooClient, pfId: string, symbol: string) => {
  const { userId, list } = await loadList(client, pfId);
  if (list.pfType === "WATCHLIST") {
    throw new YahooFinanceApiError(
      `${pfId} is a WATCHLIST, which holds no transactions. Record trades in a ` +
        "MANUAL_PORTFOLIO (yahoo_create_watchlist with type MANUAL_PORTFOLIO makes one).",
    );
  }
  const [ticker] = uniqueTickers([symbol]);
  const position = (list.positions ?? []).find((p) => p.symbol === ticker);
  return { userId, list, symbol: ticker!, position };
};

const requirePosition = async (client: YahooClient, pfId: string, symbol: string) => {
  const holding = await loadHolding(client, pfId, symbol);
  if (!holding.position) {
    const held = (holding.list.positions ?? []).map((p) => p.symbol).join(", ");
    throw new YahooFinanceApiError(
      `${holding.symbol} is not in ${pfId} (${holding.list.pfName ?? "unnamed"}). ` +
        `It holds: ${held || "nothing"}.`,
    );
  }
  return { ...holding, position: holding.position };
};

const findTrade = async (
  client: YahooClient,
  pfId: string,
  symbol: string,
  positionId: string,
  id: string,
) => {
  const trades = await client.transactions(pfId, positionId);
  const trade = trades.find((t) => t.id === id);
  if (!trade) {
    const known = trades.map((t) => t.id).join(", ");
    throw new YahooFinanceApiError(
      `No ${symbol} transaction ${id} in ${pfId}. Transactions: ${known || "none"}.`,
    );
  }
  return trade;
};

// Yahoo answers a write with the position's trades and names the new one.
const savedTrade = (reply: {
  newTransactionMeta?: { id?: string };
  transactions?: Transaction[];
}) => {
  const trades = reply.transactions ?? [];
  const id = reply.newTransactionMeta?.id;
  const trade = (id && trades.find((t) => t.id === id)) || trades.at(-1);
  if (!trade) throw new YahooFinanceApiError("Yahoo did not return the saved transaction.");
  return toTrade(trade);
};

/**
 * Tools for the buys and sells recorded in a manual portfolio. Yahoo derives a
 * position's lots from these. Same registration rules as the watchlist tools:
 * a signed-in cookie for the read, YAHOO_FINANCE_ALLOW_WRITES for the rest.
 */
export const registerTransactionTools = (
  server: McpServer,
  client: YahooClient,
  { allowWrites }: { allowWrites: boolean },
): void => {
  server.registerTool(
    "yahoo_get_portfolio_transactions",
    {
      title: "Yahoo Finance: Get Portfolio Transactions",
      description:
        "Get the buys and sells recorded for one symbol in a manual portfolio, as " +
        "{pfId, symbol, transactions: [{id, type, date, quantity, pricePerShare, commission, " +
        "totalValue, comment}]}. Imported trades may have no date or price.",
      inputSchema: z.object({ pfId: pfIdInput, symbol: symbolInput }),
      annotations: { readOnlyHint: true },
    },
    async ({ pfId, symbol }) =>
      wrap(async () => {
        const holding = await requirePosition(client, pfId, symbol);
        const trades = await client.transactions(pfId, holding.position.posId);
        return { pfId, symbol: holding.symbol, transactions: trades.map(toTrade) };
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "yahoo_add_portfolio_transaction",
    {
      title: "Yahoo Finance: Add Portfolio Transaction",
      description:
        "Record a buy or sell in a manual portfolio. Adds the symbol to the portfolio first " +
        "if it is not held yet. Returns {pfId, symbol, transaction}.",
      inputSchema: z.object({
        pfId: pfIdInput,
        symbol: symbolInput,
        type: typeInput,
        date: dateInput,
        quantity: quantityInput,
        price: priceInput,
        commission: commissionInput.optional(),
        comment: commentInput.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ pfId, symbol, type, date, quantity, price, commission = 0, comment = "" }) =>
      wrap(async () => {
        const holding = await loadHolding(client, pfId, symbol);
        let positionId = holding.position?.posId;
        if (!positionId) {
          const lists = await client.updatePortfolio({
            pfId,
            userId: holding.userId,
            operations: [
              {
                operation: "position_insert",
                symbol: holding.symbol,
                sortOrder: holding.list.positions?.length ?? 0,
              },
            ],
          });
          positionId = lists
            .find((p) => p.pfId === pfId)
            ?.positions?.find((p) => p.symbol === holding.symbol)?.posId;
          if (!positionId) {
            throw new YahooFinanceApiError(`Yahoo did not add ${holding.symbol} to ${pfId}.`);
          }
        }
        const reply = await client.saveTransaction({
          pfId,
          positionId,
          type,
          date: toYahooDate(date),
          quantity,
          pricePerShare: price,
          commission,
          comment,
        });
        return { pfId, symbol: holding.symbol, transaction: savedTrade(reply) };
      }),
  );

  server.registerTool(
    "yahoo_update_portfolio_transaction",
    {
      title: "Yahoo Finance: Update Portfolio Transaction",
      description:
        "Change a recorded buy or sell. Only the fields given change; the rest are kept. " +
        "Returns {pfId, symbol, transaction}.",
      inputSchema: z.object({
        pfId: pfIdInput,
        symbol: symbolInput,
        id: idInput,
        type: typeInput.optional(),
        date: dateInput.optional(),
        quantity: quantityInput.optional(),
        price: priceInput.optional(),
        commission: commissionInput.optional(),
        comment: commentInput.optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ pfId, symbol, id, type, date, quantity, price, commission, comment }) =>
      wrap(async () => {
        const holding = await requirePosition(client, pfId, symbol);
        const positionId = holding.position.posId;
        const trade = await findTrade(client, pfId, holding.symbol, positionId, id);
        const reply = await client.saveTransaction({
          pfId,
          positionId,
          id,
          type: type ?? trade.type ?? "BUY",
          date: date ? toYahooDate(date) : (trade.date ?? ""),
          quantity: quantity ?? trade.quantity ?? 0,
          pricePerShare: price ?? trade.pricePerShare ?? 0,
          commission: commission ?? trade.commission ?? 0,
          comment: comment ?? trade.comment ?? "",
        });
        return { pfId, symbol: holding.symbol, transaction: savedTrade(reply) };
      }),
  );

  server.registerTool(
    "yahoo_delete_portfolio_transaction",
    {
      title: "Yahoo Finance: Delete Portfolio Transaction",
      description:
        "Delete a recorded buy or sell. Returns {pfId, symbol, deleted} with the trade as it " +
        "was, which yahoo_add_portfolio_transaction can record again.",
      inputSchema: z.object({ pfId: pfIdInput, symbol: symbolInput, id: idInput }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ pfId, symbol, id }) =>
      wrap(async () => {
        const holding = await requirePosition(client, pfId, symbol);
        const positionId = holding.position.posId;
        const trade = await findTrade(client, pfId, holding.symbol, positionId, id);
        await client.deleteTransaction({ pfId, positionId, id });
        return { pfId, symbol: holding.symbol, deleted: toTrade(trade) };
      }),
  );
};
