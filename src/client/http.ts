import { YahooFinanceApiError } from "#/client/errors";
import { limitFetch } from "#/client/limit";
import { CrumbSession, DEFAULT_USER_AGENT, type Logger } from "#/client/session";
import type { Config } from "#/config";
import { normalizeTicker } from "#/lib/ticker";

export type { Logger } from "#/client/session";

const HOST = "https://query2.finance.yahoo.com";

export type YahooClientOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
};

type RequestOptions = {
  query?: Record<string, unknown>;
  needsCrumb?: boolean;
};

type OHLCV = {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
};

export type ChartResult = {
  meta?: Record<string, unknown>;
  timestamp?: number[];
  indicators?: { quote?: OHLCV[]; adjclose?: { adjclose?: (number | null)[] }[] };
  events?: {
    dividends?: Record<string, { amount?: number; date?: number }>;
    splits?: Record<
      string,
      { numerator?: number; denominator?: number; splitRatio?: string; date?: number }
    >;
  };
};

const buildQuery = (query: Record<string, unknown> | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
};

/** Pull Yahoo's `{ <root>: { result, error } }` envelope, or throw on `error`. */
const unwrapEnvelope = (json: unknown, rootKey: string): unknown => {
  if (json && typeof json === "object") {
    const root = (json as Record<string, unknown>)[rootKey];
    if (root && typeof root === "object") {
      const { result, error } = root as { result?: unknown; error?: unknown };
      if (error) {
        const e = error as { code?: string; description?: string };
        const opts = e.code ? { code: e.code } : {};
        throw new YahooFinanceApiError(e.description ?? e.code ?? "Yahoo Finance error", opts);
      }
      return result;
    }
  }
  return json;
};

// Turn Yahoo's terse 429 body into an actionable message.
const rateLimitMessage = (status: number, fallback: string): string =>
  status === 429
    ? "Yahoo Finance rate limit hit (HTTP 429). Lower YAHOO_FINANCE_CONCURRENCY, retry later, " +
      "or set YAHOO_FINANCE_COOKIE + YAHOO_FINANCE_CRUMB from a browser session."
    : fallback;

// Every error thrown below carries either `status` or `code`/message, so the
// retry decision can be made from the error alone (no out-of-band signal).
const isCrumbError = (err: unknown): boolean => {
  if (!(err instanceof YahooFinanceApiError)) return false;
  return err.status === 401 || err.code === "Unauthorized" || /crumb/i.test(err.message);
};

/**
 * Thin native-`fetch` client for Yahoo Finance's public JSON endpoints. Handles
 * crumb injection + a single invalidate-and-retry on auth failures, and maps
 * Yahoo's error envelopes to {@link YahooFinanceApiError}.
 */
export class YahooClient {
  private readonly session: CrumbSession;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent = DEFAULT_USER_AGENT;

  constructor(opts: YahooClientOptions) {
    this.fetchImpl = limitFetch(opts.fetch ?? fetch, {
      concurrency: opts.config.concurrency,
      timeoutMs: opts.config.requestTimeoutMs,
    });
    this.logger = opts.logger;
    this.session = new CrumbSession({
      fetch: this.fetchImpl,
      ...(opts.logger ? { logger: opts.logger } : {}),
      ...(opts.config.cookie ? { cookie: opts.config.cookie } : {}),
      ...(opts.config.crumb ? { crumb: opts.config.crumb } : {}),
    });
  }

  private async request<T>(path: string, rootKey: string, opts: RequestOptions = {}): Promise<T> {
    const send = async (): Promise<T> => {
      const query = { ...opts.query };
      // Every Yahoo endpoint — even crumb-less ones — needs the session cookies
      // or it answers 429. Crumb endpoints additionally need the crumb param.
      if (opts.needsCrumb) {
        query.crumb = await this.session.get();
      } else {
        await this.session.ensureCookies();
      }
      const url = `${HOST}${path}${buildQuery(query)}`;
      this.logger?.debug?.(`[yahoo] GET ${url}`);
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "user-agent": this.userAgent,
          accept: "application/json",
          cookie: await this.session.cookieHeader(url),
        },
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        if (!res.ok) {
          throw new YahooFinanceApiError(rateLimitMessage(res.status, text || res.statusText), {
            status: res.status,
          });
        }
        throw new YahooFinanceApiError(`Expected JSON but got: ${text.slice(0, 200)}`);
      }
      const result = unwrapEnvelope(json, rootKey);
      if (!res.ok) {
        throw new YahooFinanceApiError(rateLimitMessage(res.status, res.statusText), {
          status: res.status,
        });
      }
      return result as T;
    };

    try {
      return await send();
    } catch (err) {
      if (opts.needsCrumb && isCrumbError(err)) {
        this.logger?.warn?.("[yahoo] crumb rejected — refreshing and retrying once");
        this.session.invalidate();
        return send();
      }
      throw err;
    }
  }

  /** Historical OHLCV + dividend/split events. No crumb required. */
  chart(
    symbol: string,
    params: { period1: number; period2: number; interval: string; events?: string },
  ): Promise<ChartResult> {
    // The `chart` envelope nests its data in a single-element `result` array.
    return this.request<ChartResult[]>(
      `/v8/finance/chart/${encodeURIComponent(normalizeTicker(symbol))}`,
      "chart",
      {
        query: params,
      },
    ).then((arr) => (Array.isArray(arr) ? (arr[0] ?? {}) : (arr ?? {})) as ChartResult);
  }

  /** Real-time-ish quote rows for one or more symbols. Crumb required. */
  quote(symbols: string[]): Promise<unknown[]> {
    return this.request<{ result?: unknown[] } | unknown[]>("/v7/finance/quote", "quoteResponse", {
      query: { symbols: symbols.map(normalizeTicker).join(",") },
      needsCrumb: true,
    }).then((r) => (Array.isArray(r) ? r : ((r as { result?: unknown[] })?.result ?? [])));
  }

  /** Modular fundamentals/profile data. Crumb required. */
  quoteSummary(symbol: string, modules: string[]): Promise<Record<string, unknown>> {
    return this.request<unknown[]>(
      `/v10/finance/quoteSummary/${encodeURIComponent(normalizeTicker(symbol))}`,
      "quoteSummary",
      { query: { modules: modules.join(",") }, needsCrumb: true },
    ).then((arr) => (Array.isArray(arr) ? (arr[0] ?? {}) : {}) as Record<string, unknown>);
  }

  /** Search — returns `{ quotes, news, ... }`. No crumb required. */
  search(query: string): Promise<{ news?: unknown[]; quotes?: unknown[] }> {
    return this.request("/v1/finance/search", "__none__", {
      query: { q: normalizeTicker(query), newsCount: 20, quotesCount: 6 },
    }) as Promise<{ news?: unknown[]; quotes?: unknown[] }>;
  }

  /** Options chain (and expiration dates). Crumb required. */
  options(symbol: string, date?: number): Promise<Record<string, unknown>> {
    return this.request<unknown[]>(
      `/v7/finance/options/${encodeURIComponent(normalizeTicker(symbol))}`,
      "optionChain",
      { query: date ? { date } : {}, needsCrumb: true },
    ).then((arr) => (Array.isArray(arr) ? (arr[0] ?? {}) : {}) as Record<string, unknown>);
  }

  /** Time-series fundamentals (modern replacement for the statement modules). */
  fundamentalsTimeSeries(
    symbol: string,
    params: { type: string; period1: number; period2: number },
  ): Promise<unknown[]> {
    return this.request<{ result?: unknown[] } | unknown[]>(
      `/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(normalizeTicker(symbol))}`,
      "timeseries",
      { query: params, needsCrumb: true },
    ).then((r) => (Array.isArray(r) ? r : ((r as { result?: unknown[] })?.result ?? [])));
  }
}
