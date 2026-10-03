// The columns of one contract row in Yahoo's /v7/finance/options payload.
// `expiration` and `lastTradeDate` are epoch seconds; `sanitize` leaves them as
// numbers, which is why `contractSymbol` (it encodes the expiry) is the
// readable handle.
export const OPTION_FIELDS = [
  "contractSymbol",
  "strike",
  "currency",
  "lastPrice",
  "change",
  "percentChange",
  "volume",
  "openInterest",
  "bid",
  "ask",
  "contractSize",
  "expiration",
  "lastTradeDate",
  "impliedVolatility",
  "inTheMoney",
] as const;
export type OptionField = (typeof OPTION_FIELDS)[number];

export type Contract = Record<string, unknown> & { strike?: number };

/**
 * Keep the contracts whose strike lies within ±`pct` of `spot` (0.15 keeps
 * 85%–115%). Returns the chain unchanged when there is no usable spot or the
 * window would select nothing: a caller asking for a narrower view must never
 * be handed an empty chain when strikes exist, because "no contracts" reads as
 * a fact about the market rather than about the filter.
 */
export const windowStrikes = (
  chain: Contract[],
  spot: number | undefined,
  pct: number | undefined,
): Contract[] => {
  if (pct === undefined || spot === undefined || !(spot > 0)) return chain;
  const lo = spot * (1 - pct);
  const hi = spot * (1 + pct);
  const windowed = chain.filter(
    (c) => typeof c.strike === "number" && c.strike >= lo && c.strike <= hi,
  );
  return windowed.length > 0 ? windowed : chain;
};

/** Keep only `fields` on every contract, always retaining `strike` so rows stay identifiable. */
export const projectFields = (
  chain: Contract[],
  fields: readonly OptionField[] | undefined,
): Contract[] => {
  if (!fields || fields.length === 0) return chain;
  const keep = new Set<string>(["strike", ...fields]);
  return chain.map((c) => Object.fromEntries(Object.entries(c).filter(([key]) => keep.has(key))));
};
