import { YahooFinanceApiError } from "#/client/errors";
import type { Portfolio, YahooClient } from "#/client/http";
import { normalizeTicker } from "#/lib/ticker";

export type ListView = {
  pfId: string;
  name: string | null;
  type: string | null;
  symbols: string[];
};

type Position = NonNullable<Portfolio["positions"]>[number];

export const toListView = (p: Portfolio): ListView => ({
  pfId: p.pfId,
  name: p.pfName ?? null,
  type: p.pfType ?? null,
  symbols: (p.positions ?? [])
    .toSorted((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((pos) => pos.symbol),
});

// Yahoo stores symbols uppercase, so `nvda` must match the NVDA already listed.
export const uniqueTickers = (symbols: string[]): string[] => [
  ...new Set(symbols.map((s) => normalizeTicker(s).toUpperCase())),
];

/** Fetch the account and the one list a call targets, with the userId writes need. */
export const loadList = async (client: YahooClient, pfId: string) => {
  const account = await client.portfolios();
  const lists = account.portfolios ?? [];
  const list = lists.find((p) => p.pfId === pfId);
  if (!list) {
    const known = lists.map((p) => `${p.pfId} (${p.pfName ?? "unnamed"})`).join(", ");
    throw new YahooFinanceApiError(`No list with pfId ${pfId}. Lists: ${known || "none"}.`);
  }
  if (!account.userId) throw new YahooFinanceApiError("Yahoo did not return the account's userId.");
  return { userId: account.userId, list };
};

// Each write answers with the updated lists; fall back to the old one if not.
export const pickList = (lists: Portfolio[], pfId: string, fallback: Portfolio): Portfolio =>
  lists.find((p) => p.pfId === pfId) ?? fallback;

/** What a position holds that removing it would delete. */
export type History = { symbol: string; lots: number; transactions: number };

export const historyOf = (positions: Position[]): History[] =>
  positions
    .map((p) => ({
      symbol: p.symbol,
      lots: p.totalLotCount ?? 0,
      transactions: p.totalTransactionsCount ?? 0,
    }))
    .filter((h) => h.lots + h.transactions > 0);

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export const describeHistory = (history: History[]): string =>
  history
    .map((h) => `${h.symbol} (${count(h.lots, "lot")}, ${count(h.transactions, "transaction")})`)
    .join(", ");
