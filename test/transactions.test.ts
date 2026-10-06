import { describe, expect, it, vi } from "vitest";

import type { Portfolio, YahooClient } from "#/client/http";
import { registerTools } from "#/tools/index";
import type { ToolResult } from "#/tools/util";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type Def = { annotations?: Record<string, boolean> };

const parse = (result: ToolResult) => ({
  data: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  isError: result.isError ?? false,
});

const holdings = (): Portfolio => ({
  pfId: "p_1",
  pfName: "Portfolio",
  pfType: "MANUAL_PORTFOLIO",
  positions: [
    { posId: "pos_0", symbol: "MSFT", sortOrder: 0, totalLotCount: 1, totalTransactionsCount: 1 },
  ],
});
const watch = (): Portfolio => ({
  pfId: "p_3",
  pfName: "Watch",
  pfType: "WATCHLIST",
  positions: [{ posId: "pos_0", symbol: "AAPL", sortOrder: 0 }],
});

// What Yahoo stores: dates as YYYYMMDD, plus ids the model has no use for.
const RAW_BUY = {
  id: "transaction_1",
  positionId: "pos_0",
  lotId: "lot_1",
  symbol: "MSFT",
  type: "BUY",
  date: "20261001",
  quantity: 10,
  pricePerShare: 250.5,
  commission: 1,
  totalValue: 2506,
  comment: "first buy",
  quantityContributingToLot: 0,
};
const BUY = {
  id: "transaction_1",
  type: "BUY",
  date: "2026-10-01",
  quantity: 10,
  pricePerShare: 250.5,
  commission: 1,
  totalValue: 2506,
  comment: "first buy",
};

const account = (overrides: Record<string, unknown> = {}, allowWrites = true) => {
  const client = {
    signedIn: true,
    portfolios: vi.fn().mockResolvedValue({ userId: "U1", portfolios: [holdings(), watch()] }),
    updatePortfolio: vi.fn(),
    deletePortfolio: vi.fn(),
    transactions: vi.fn().mockResolvedValue([RAW_BUY]),
    saveTransaction: vi.fn(),
    deleteTransaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const tools = new Map<string, { def: Def; handler: Handler }>();
  const server = {
    registerTool: (n: string, def: Def, handler: Handler) => tools.set(n, { def, handler }),
  };
  registerTools(server as never, client as unknown as YahooClient, { allowWrites });
  const call = async (name: string, args: Record<string, unknown>) =>
    parse(await tools.get(name)!.handler(args));
  return { client, tools, call };
};

const names = (tools: Map<string, unknown>) =>
  [...tools.keys()].filter((n) => n.includes("transaction")).toSorted();

describe("transaction tool registration", () => {
  it("offers only the read without YAHOO_FINANCE_ALLOW_WRITES, and all four with it", () => {
    expect(names(account({}, false).tools)).toEqual(["yahoo_get_portfolio_transactions"]);
    expect(names(account().tools)).toEqual([
      "yahoo_add_portfolio_transaction",
      "yahoo_delete_portfolio_transaction",
      "yahoo_get_portfolio_transactions",
      "yahoo_update_portfolio_transaction",
    ]);
  });

  it("marks the read read-only, adding non-destructive, and edits and deletes destructive", () => {
    const { tools } = account();
    const hints = (n: string) => tools.get(n)!.def.annotations;
    expect(hints("yahoo_get_portfolio_transactions")).toMatchObject({ readOnlyHint: true });
    expect(hints("yahoo_add_portfolio_transaction")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(hints("yahoo_update_portfolio_transaction")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(hints("yahoo_delete_portfolio_transaction")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});

describe("yahoo_get_portfolio_transactions", () => {
  it("reads a symbol's trades with ISO dates and without Yahoo's internal ids", async () => {
    const { client, call } = account();
    const { data } = await call("yahoo_get_portfolio_transactions", {
      pfId: "p_1",
      symbol: "msft",
    });
    expect(client.transactions).toHaveBeenCalledWith("p_1", "pos_0");
    expect(data).toEqual({ pfId: "p_1", symbol: "MSFT", transactions: [BUY] });
  });

  it("refuses a watchlist, which holds no transactions", async () => {
    const { data, isError } = await account().call("yahoo_get_portfolio_transactions", {
      pfId: "p_3",
      symbol: "AAPL",
    });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/p_3 is a WATCHLIST/);
  });

  it("says which symbols the portfolio holds when the symbol is not one of them", async () => {
    const { data, isError } = await account().call("yahoo_get_portfolio_transactions", {
      pfId: "p_1",
      symbol: "TSLA",
    });
    expect(isError).toBe(true);
    expect(data.error).toBe("TSLA is not in p_1 (Portfolio). It holds: MSFT.");
  });
});

describe("yahoo_add_portfolio_transaction", () => {
  const saved = (raw: Record<string, unknown>) =>
    vi.fn().mockResolvedValue({ newTransactionMeta: { id: raw.id }, transactions: [RAW_BUY, raw] });

  it("records a trade on a held symbol, sending Yahoo's YYYYMMDD date", async () => {
    const raw = { ...RAW_BUY, id: "transaction_2", type: "SELL", date: "20261005", quantity: 2 };
    const saveTransaction = saved(raw);
    const { client, call } = account({ saveTransaction });

    const { data } = await call("yahoo_add_portfolio_transaction", {
      pfId: "p_1",
      symbol: "MSFT",
      type: "SELL",
      date: "2026-10-05",
      quantity: 2,
      price: 250.5,
    });
    expect(client.updatePortfolio).not.toHaveBeenCalled();
    expect(saveTransaction).toHaveBeenCalledWith({
      pfId: "p_1",
      positionId: "pos_0",
      type: "SELL",
      date: "20261005",
      quantity: 2,
      pricePerShare: 250.5,
      commission: 0,
      comment: "",
    });
    // The reply lists every trade on the position; the new one is named by id.
    expect(data).toEqual({
      pfId: "p_1",
      symbol: "MSFT",
      transaction: { ...BUY, id: "transaction_2", type: "SELL", date: "2026-10-05", quantity: 2 },
    });
  });

  it("adds the position first when the portfolio does not hold the symbol yet", async () => {
    const updatePortfolio = vi.fn().mockResolvedValue([
      {
        ...holdings(),
        positions: [...holdings().positions!, { posId: "pos_1", symbol: "TSLA", sortOrder: 1 }],
      },
    ]);
    const saveTransaction = saved({
      ...RAW_BUY,
      id: "transaction_3",
      positionId: "pos_1",
      symbol: "TSLA",
    });
    const { call } = account({ updatePortfolio, saveTransaction });

    await call("yahoo_add_portfolio_transaction", {
      pfId: "p_1",
      symbol: "tsla",
      type: "BUY",
      date: "2026-10-01",
      quantity: 1,
      price: 400,
      commission: 2,
      comment: "test",
    });
    expect(updatePortfolio).toHaveBeenCalledWith({
      pfId: "p_1",
      userId: "U1",
      operations: [{ operation: "position_insert", symbol: "TSLA", sortOrder: 1 }],
    });
    expect(saveTransaction.mock.calls[0]![0]).toMatchObject({
      positionId: "pos_1",
      commission: 2,
      comment: "test",
    });
  });

  it("refuses a watchlist", async () => {
    const { client, call } = account();
    const { isError } = await call("yahoo_add_portfolio_transaction", {
      pfId: "p_3",
      symbol: "AAPL",
      type: "BUY",
      date: "2026-10-01",
      quantity: 1,
      price: 1,
    });
    expect(isError).toBe(true);
    expect(client.saveTransaction).not.toHaveBeenCalled();
  });
});

describe("yahoo_update_portfolio_transaction", () => {
  it("changes only the fields given and keeps the rest of the trade", async () => {
    const saveTransaction = vi.fn().mockResolvedValue({
      newTransactionMeta: { id: "transaction_1" },
      transactions: [{ ...RAW_BUY, quantity: 12, totalValue: 3007 }],
    });
    const { call } = account({ saveTransaction });

    const { data } = await call("yahoo_update_portfolio_transaction", {
      pfId: "p_1",
      symbol: "MSFT",
      id: "transaction_1",
      quantity: 12,
    });
    expect(saveTransaction).toHaveBeenCalledWith({
      pfId: "p_1",
      positionId: "pos_0",
      id: "transaction_1",
      type: "BUY",
      date: "20261001",
      quantity: 12,
      pricePerShare: 250.5,
      commission: 1,
      comment: "first buy",
    });
    expect(data).toEqual({
      pfId: "p_1",
      symbol: "MSFT",
      transaction: { ...BUY, quantity: 12, totalValue: 3007 },
    });
  });

  it("names the trades that exist when the id is unknown", async () => {
    const { client, call } = account();
    const { data, isError } = await call("yahoo_update_portfolio_transaction", {
      pfId: "p_1",
      symbol: "MSFT",
      id: "transaction_9",
      quantity: 1,
    });
    expect(isError).toBe(true);
    expect(data.error).toBe(
      "No MSFT transaction transaction_9 in p_1. Transactions: transaction_1.",
    );
    expect(client.saveTransaction).not.toHaveBeenCalled();
  });
});

describe("yahoo_delete_portfolio_transaction", () => {
  it("deletes the trade and returns it, so it can be recorded again", async () => {
    const { client, call } = account();
    const { data } = await call("yahoo_delete_portfolio_transaction", {
      pfId: "p_1",
      symbol: "MSFT",
      id: "transaction_1",
    });
    expect(client.deleteTransaction).toHaveBeenCalledWith({
      pfId: "p_1",
      positionId: "pos_0",
      id: "transaction_1",
    });
    expect(data).toEqual({ pfId: "p_1", symbol: "MSFT", deleted: BUY });
  });
});
