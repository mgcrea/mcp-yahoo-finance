// Yahoo sends 429 for two different things: a real burst limit, and a TLS
// handshake it does not accept (see transport.ts). Only the first is fixed by
// waiting, and cookies fix neither, so the message must not send the model off
// to find some.
export const RATE_LIMIT_MESSAGE =
  "Yahoo Finance answered HTTP 429. Retry in a minute, and lower YAHOO_FINANCE_CONCURRENCY " +
  "if many tickers are being fetched at once. If every call fails, Yahoo has likely changed " +
  "the browser fingerprint it accepts; upgrade @mgcrea/mcp-yahoo-finance.";

// Thrown once a crumb freshly derived from the supplied cookie was rejected
// too: the cookie itself is stale (signed out, expired), so only a new one helps.
export const MANUAL_AUTH_REJECTED_MESSAGE =
  "Yahoo Finance rejected YAHOO_FINANCE_COOKIE, even with a fresh crumb. Copy it again from " +
  "a browser session, or unset it to let the server handshake on its own.";

// Thrown when an account endpoint answers 403: the crumb still works, since
// Yahoo issues one to anonymous cookies too, but the `T` login has expired or
// been signed out. Only a cookie copied from a signed-in tab brings it back.
export const SIGNED_OUT_MESSAGE =
  "Yahoo Finance no longer accepts the login in YAHOO_FINANCE_COOKIE: it expired or was " +
  "signed out. Copy the cookie again from a finance.yahoo.com tab where you are signed in.";

export class YahooFinanceApiError extends Error {
  override readonly name: string = "YahooFinanceApiError";
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(message: string, opts: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }
}

/** Thrown when Yahoo refuses YAHOO_FINANCE_COOKIE itself: a new copy is the only fix. */
export class YahooCookieRejectedError extends YahooFinanceApiError {
  override readonly name = "YahooCookieRejectedError";
}

/** Thrown when the cookie/crumb handshake with Yahoo cannot be completed. */
export class YahooCrumbError extends YahooFinanceApiError {
  override readonly name = "YahooCrumbError";

  constructor(
    message = "Failed to obtain a Yahoo Finance crumb. Yahoo may have changed its consent flow; " +
      "set YAHOO_FINANCE_COOKIE to bypass the automatic handshake.",
  ) {
    super(message);
  }
}
