import {
  MANUAL_AUTH_REJECTED_MESSAGE,
  RATE_LIMIT_MESSAGE,
  YahooFinanceApiError,
} from "#/client/errors";
import { limitFetch } from "#/client/limit";
import { CrumbSession, DEFAULT_USER_AGENT, type Logger } from "#/client/session";
import { chromeFetch } from "#/client/transport";
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

type EnvelopeError = { code?: string; description?: string };

const envelopeRoot = (json: unknown, key: string): { result?: unknown; error?: unknown } | null => {
  if (!json || typeof json !== "object") return null;
  const root = (json as Record<string, unknown>)[key];
  return root && typeof root === "object" ? root : null;
};

/**
 * Pull Yahoo's `{ <root>: { result, error } }` envelope, or throw on `error`.
 * Auth and gateway errors arrive under `finance` whatever the endpoint, and
 * HTTP/2 has no status text, so the status code is the last-resort message.
 */
const unwrapEnvelope = (json: unknown, rootKey: string, res: Response): unknown => {
  const root = envelopeRoot(json, rootKey);
  const error = (root?.error ?? envelopeRoot(json, "finance")?.error) as EnvelopeError | undefined;
  if (error || !res.ok) {
    const message = error?.description || error?.code || res.statusText || `HTTP ${res.status}`;
    throw new YahooFinanceApiError(rateLimitMessage(res.status, message), {
      ...(res.ok ? {} : { status: res.status }),
      ...(error?.code ? { code: error.code } : {}),
    });
  }
  return root ? root.result : json;
};

// Turn Yahoo's terse 429 body into an actionable message.
const rateLimitMessage = (status: number, fallback: string): string =>
  status === 429 ? RATE_LIMIT_MESSAGE : fallback;

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
  private readonly manualAuth: boolean;

  constructor(opts: YahooClientOptions) {
    this.fetchImpl = limitFetch(opts.fetch ?? chromeFetch, {
      concurrency: opts.config.concurrency,
      timeoutMs: opts.config.requestTimeoutMs,
    });
    this.logger = opts.logger;
    this.manualAuth = Boolean(opts.config.cookie || opts.config.crumb);
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
          const message = text || res.statusText || `HTTP ${res.status}`;
          throw new YahooFinanceApiError(rateLimitMessage(res.status, message), {
            status: res.status,
          });
        }
        throw new YahooFinanceApiError(`Expected JSON but got: ${text.slice(0, 200)}`);
      }
      return unwrapEnvelope(json, rootKey, res) as T;
    };

    try {
      return await send();
    } catch (err) {
      if (!opts.needsCrumb || !isCrumbError(err)) throw err;
      this.logger?.warn?.("[yahoo] crumb rejected — refreshing and retrying once");
      this.session.invalidate();
      try {
        return await send();
      } catch (retryErr) {
        if (this.manualAuth && isCrumbError(retryErr)) {
          const { message, status, code } = retryErr as YahooFinanceApiError;
          throw new YahooFinanceApiError(`${MANUAL_AUTH_REJECTED_MESSAGE} (Yahoo: ${message})`, {
            ...(status ? { status } : {}),
            ...(code ? { code } : {}),
          });
        }
        throw retryErr;
      }
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
