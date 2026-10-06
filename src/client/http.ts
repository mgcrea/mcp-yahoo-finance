import {
  MANUAL_AUTH_REJECTED_MESSAGE,
  RATE_LIMIT_MESSAGE,
  SIGNED_OUT_MESSAGE,
  YahooCookieRejectedError,
  YahooFinanceApiError,
} from "#/client/errors";
import { limitFetch } from "#/client/limit";
import { CrumbSession, DEFAULT_USER_AGENT, type Logger } from "#/client/session";
import { chromeFetch } from "#/client/transport";
import type { Config } from "#/config";
import { normalizeTicker } from "#/lib/ticker";

export type { Logger } from "#/client/session";

const HOST = "https://query2.finance.yahoo.com";
// Portfolio reads and writes go where finance.yahoo.com's own page sends them.
const PORTFOLIO_HOST = "https://query1.finance.yahoo.com";

export type YahooClientOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
};

type RequestOptions = {
  query?: Record<string, unknown>;
  needsCrumb?: boolean;
  host?: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Acts on the signed-in account, so a 403 means the login is gone. */
  account?: boolean;
};

/** What {@link YahooClient.authStatus} found out about YAHOO_FINANCE_COOKIE. */
export type AuthStatus = {
  /** Yahoo accepted the login just now. */
  signedIn: boolean;
  /** The cookie carries `T`, Yahoo's login cookie. */
  loginCookie: boolean;
  /** Names of the supplied cookies; their values stay out of the reply. */
  cookies: string[];
  /** How many watchlists and portfolios the account holds, when signed in. */
  lists?: number;
  /** What to do about it, when not signed in. */
  action?: string;
};

/** One list on the account — a watchlist or a manual portfolio. */
export type Portfolio = {
  pfId: string;
  pfName?: string;
  pfType?: string;
  positions?: { posId: string; symbol: string; sortOrder?: number }[];
  [key: string]: unknown;
};

export type PortfolioOperation = { operation: string; [key: string]: unknown };

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

// Yahoo's `T` cookie is the login one; without it a cookie is just a browser id.
const hasLoginCookie = (cookie: string | undefined): boolean =>
  cookie !== undefined && /(?:^|;\s*)T=/.test(cookie);

const NO_LOGIN_COOKIE_ACTION =
  "YAHOO_FINANCE_COOKIE has no T cookie, so it names a browser, not an account. Copy the whole " +
  "cookie (A3, T and Y) from a finance.yahoo.com tab where you are signed in.";

const cookieNames = (cookie: string | undefined): string[] =>
  (cookie ?? "")
    .split(/;\s*/)
    .map((part) => part.split("=")[0]!.trim())
    .filter(Boolean);

// Keep Yahoo's own reason after ours: it tells a stale cookie from a new failure.
const cookieRejected = (
  message: string,
  { message: reason, status, code }: YahooFinanceApiError,
): YahooCookieRejectedError =>
  new YahooCookieRejectedError(`${message} (Yahoo: ${reason})`, {
    ...(status ? { status } : {}),
    ...(code ? { code } : {}),
  });

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
  /** Whether YAHOO_FINANCE_COOKIE replaces the anonymous handshake. */
  readonly manualAuth: boolean;
  private readonly cookieNames: string[];
  /** Whether the supplied cookie belongs to a signed-in Yahoo account. */
  readonly signedIn: boolean;

  constructor(opts: YahooClientOptions) {
    this.fetchImpl = limitFetch(opts.fetch ?? chromeFetch, {
      concurrency: opts.config.concurrency,
      timeoutMs: opts.config.requestTimeoutMs,
    });
    this.logger = opts.logger;
    this.manualAuth = Boolean(opts.config.cookie);
    this.signedIn = hasLoginCookie(opts.config.cookie);
    this.cookieNames = cookieNames(opts.config.cookie);
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
      const url = `${opts.host ?? HOST}${path}${buildQuery(query)}`;
      const method = opts.method ?? "GET";
      this.logger?.debug?.(`[yahoo] ${method} ${url}`);
      const hasBody = opts.body !== undefined;
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          "user-agent": this.userAgent,
          accept: "application/json",
          cookie: await this.session.cookieHeader(url),
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
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
      if (opts.account && err instanceof YahooFinanceApiError && err.status === 403) {
        throw cookieRejected(SIGNED_OUT_MESSAGE, err);
      }
      if (!opts.needsCrumb || !isCrumbError(err)) throw err;
      this.logger?.warn?.("[yahoo] crumb rejected — refreshing and retrying once");
      this.session.invalidate();
      try {
        return await send();
      } catch (retryErr) {
        if (this.manualAuth && isCrumbError(retryErr)) {
          throw cookieRejected(MANUAL_AUTH_REJECTED_MESSAGE, retryErr as YahooFinanceApiError);
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

  /**
   * Check YAHOO_FINANCE_COOKIE against Yahoo. The cookie header carries no
   * expiry, so the only way to know a login still holds is to use it: list the
   * account. A refused login is reported, not thrown; other failures still throw.
   */
  async authStatus(): Promise<AuthStatus> {
    const base = { loginCookie: this.signedIn, cookies: this.cookieNames };
    if (!this.signedIn) return { signedIn: false, ...base, action: NO_LOGIN_COOKIE_ACTION };
    try {
      const account = await this.portfolios();
      return { signedIn: true, ...base, lists: account.portfolios?.length ?? 0 };
    } catch (err) {
      if (!(err instanceof YahooCookieRejectedError)) throw err;
      return { signedIn: false, ...base, action: err.message };
    }
  }

  /** Every list on the signed-in account, plus the `userId` that writes need. */
  portfolios(): Promise<{
    userId?: string;
    hasMigratedToNewModel?: boolean;
    portfolios?: Portfolio[];
  }> {
    return this.request<unknown[]>("/v7/finance/desktop/portfolio/all", "finance", {
      host: PORTFOLIO_HOST,
      needsCrumb: true,
      account: true,
    }).then((arr) => (Array.isArray(arr) ? (arr[0] ?? {}) : {}));
  }

  /**
   * Apply operations to one list, or create a list when `pfId` is omitted.
   * Returns the lists Yahoo sends back, the affected one included.
   */
  updatePortfolio(args: {
    pfId?: string;
    userId: string;
    operations: PortfolioOperation[];
  }): Promise<Portfolio[]> {
    const { pfId, userId, operations } = args;
    return this.request<Portfolio[] | null>("/v6/finance/portfolio/update", "finance", {
      host: PORTFOLIO_HOST,
      needsCrumb: true,
      account: true,
      method: pfId ? "PUT" : "POST",
      query: pfId ? { action: "update", pfId, userId } : { method: "create", userId },
      body: {
        operations,
        parameters: { fullResponse: true, ...(pfId ? { pfId } : {}), userId, userIdType: "guid" },
      },
    }).then((r) => r ?? []);
  }

  /** Delete one list. */
  async deletePortfolio(pfId: string, userId: string): Promise<void> {
    await this.request("/v6/finance/portfolio", "finance", {
      host: PORTFOLIO_HOST,
      needsCrumb: true,
      account: true,
      method: "DELETE",
      query: { pfId, userId },
    });
  }
}
