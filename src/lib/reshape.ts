import { nanToNull, toISO, unwrap } from "./format";

type Row = Record<string, unknown>;

const PERIOD_PREFIX = /^(annual|quarterly|trailing)/;

/** Strip the `annual`/`quarterly` prefix and lower-case the first letter. */
const cleanMetricKey = (key: string): string => {
  const stripped = key.replace(PERIOD_PREFIX, "");
  return stripped ? stripped[0]!.toLowerCase() + stripped.slice(1) : key;
};

/**
 * Reshape quoteSummary statement modules (e.g. `incomeStatementHistory`) — an
 * array of period objects keyed by metric — into `[{date, ...metrics}]` with
 * `{raw}` wrappers unwrapped and `NaN` mapped to `null`. (Fallback path; the
 * primary statement source is {@link reshapeTimeseries}.)
 */
export const reshapeStatement = (rows: Row[] | undefined): Row[] =>
  (rows ?? []).map((row) => {
    const out: Row = { date: row.endDate ? toISO(unwrap(row.endDate)) : null };
    for (const [key, value] of Object.entries(row)) {
      if (key === "endDate" || key === "maxAge") continue;
      out[key] = nanToNull(unwrap(value));
    }
    return out;
  });

type TimeseriesPoint = { asOfDate?: string; reportedValue?: unknown };
type TimeseriesSeries = Record<string, unknown> & { meta?: { type?: string[] } };

/**
 * Pivot a `fundamentalsTimeSeries` result — an array of per-metric series, each
 * carrying an array of `{asOfDate, reportedValue}` points — into a date-keyed
 * `[{date, ...metrics}]` array sorted newest-first.
 */
export const reshapeTimeseries = (series: TimeseriesSeries[] | undefined): Row[] => {
  const byDate = new Map<string, Row>();
  for (const entry of series ?? []) {
    const type = entry.meta?.type?.[0];
    if (!type) continue;
    const points = entry[type];
    if (!Array.isArray(points)) continue;
    const metric = cleanMetricKey(type);
    for (const point of points as TimeseriesPoint[]) {
      if (!point || !point.asOfDate) continue;
      const date = point.asOfDate;
      const row = byDate.get(date) ?? { date };
      row[metric] = nanToNull(unwrap(point.reportedValue));
      byDate.set(date, row);
    }
  }
  return [...byDate.values()].toSorted((a, b) => String(b.date).localeCompare(String(a.date)));
};

/** Build the `type=` query value fundamentalsTimeSeries expects for a module. */
export const TIMESERIES_KEYS: Record<string, string[]> = {
  financials: [
    "TotalRevenue",
    "CostOfRevenue",
    "GrossProfit",
    "OperatingExpense",
    "OperatingIncome",
    "NetIncome",
    "BasicEPS",
    "DilutedEPS",
    "EBIT",
    "EBITDA",
    "InterestExpense",
    "TaxProvision",
    "PretaxIncome",
  ],
  "balance-sheet": [
    "TotalAssets",
    "CurrentAssets",
    "CashAndCashEquivalents",
    "Inventory",
    "TotalLiabilitiesNetMinorityInterest",
    "CurrentLiabilities",
    "LongTermDebt",
    "TotalDebt",
    "StockholdersEquity",
    "RetainedEarnings",
    "WorkingCapital",
  ],
  "cash-flow": [
    "OperatingCashFlow",
    "InvestingCashFlow",
    "FinancingCashFlow",
    "FreeCashFlow",
    "CapitalExpenditure",
    "NetIncomeFromContinuingOperations",
    "DepreciationAndAmortization",
    "ChangeInWorkingCapital",
    "EndCashPosition",
  ],
};

/** Compose the `type` query param: `<prefix><Metric>` for every metric. */
export const timeseriesType = (module: string, prefix: "annual" | "quarterly"): string =>
  (TIMESERIES_KEYS[module] ?? []).map((m) => prefix + m).join(",");
