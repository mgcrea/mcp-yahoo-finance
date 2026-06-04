export const PERIODS = [
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max",
] as const;
export type Period = (typeof PERIODS)[number];

export const INTERVALS = [
  "1m",
  "2m",
  "5m",
  "15m",
  "30m",
  "60m",
  "90m",
  "1h",
  "1d",
  "5d",
  "1wk",
  "1mo",
  "3mo",
] as const;
export type Interval = (typeof INTERVALS)[number];

const toEpochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/**
 * Convert a yfinance-style `period` string into the `{period1, period2}` epoch
 * seconds range that Yahoo's `chart` endpoint expects (`period2` = now).
 */
export const periodToRange = (
  period: Period,
  now: Date = new Date(),
): {
  period1: number;
  period2: number;
} => {
  const period2 = toEpochSeconds(now);
  const d = new Date(now);
  switch (period) {
    case "1d":
      d.setDate(d.getDate() - 1);
      break;
    case "5d":
      d.setDate(d.getDate() - 5);
      break;
    case "1mo":
      d.setMonth(d.getMonth() - 1);
      break;
    case "3mo":
      d.setMonth(d.getMonth() - 3);
      break;
    case "6mo":
      d.setMonth(d.getMonth() - 6);
      break;
    case "1y":
      d.setFullYear(d.getFullYear() - 1);
      break;
    case "2y":
      d.setFullYear(d.getFullYear() - 2);
      break;
    case "5y":
      d.setFullYear(d.getFullYear() - 5);
      break;
    case "10y":
      d.setFullYear(d.getFullYear() - 10);
      break;
    case "ytd":
      d.setMonth(0, 1);
      d.setHours(0, 0, 0, 0);
      break;
    case "max":
      return { period1: 0, period2 };
  }
  return { period1: toEpochSeconds(d), period2 };
};
