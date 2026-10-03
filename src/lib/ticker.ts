// Yahoo spells US share classes with a hyphen (`BRK-B`), but people and models
// type `BRK.B` or `BRK/B`. Yahoo does not reject the dotted form with an error,
// it comes back empty (Alex2Yang97/yahoo-finance-mcp#17), so the request fails
// silently and the model reports "no data" for Berkshire. Only a single trailing A/B class
// letter is rewritten — exchange suffixes (`SHOP.TO`, `RIO.L`, `7203.T`,
// `0700.HK`) are real Yahoo symbols and must pass through untouched.
const CLASS_SHARE = /^([A-Za-z]{1,6})[./-]([AaBb])$/;

/** Normalize a ticker to the form Yahoo expects: `BRK.B` / `brk/b` → `BRK-B`. */
export const normalizeTicker = (ticker: string): string => {
  const trimmed = ticker.trim();
  const match = CLASS_SHARE.exec(trimmed);
  return match ? `${match[1]!.toUpperCase()}-${match[2]!.toUpperCase()}` : trimmed;
};
