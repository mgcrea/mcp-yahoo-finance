// Yahoo sends 429 for two different things: a real burst limit, and a TLS
// handshake it does not accept (see transport.ts). Only the first is fixed by
// waiting, and cookies fix neither, so the message must not send the model off
// to find some.
export const RATE_LIMIT_MESSAGE =
  "Yahoo Finance answered HTTP 429. Retry in a minute, and lower YAHOO_FINANCE_CONCURRENCY " +
  "if many tickers are being fetched at once. If every call fails, Yahoo has likely changed " +
  "the browser fingerprint it accepts; upgrade @mgcrea/mcp-yahoo-finance.";

// A supplied cookie/crumb pair is never refreshed, so once Yahoo rejects it
// every crumb call fails until someone replaces it.
export const MANUAL_AUTH_REJECTED_MESSAGE =
  "Yahoo Finance rejected YAHOO_FINANCE_COOKIE / YAHOO_FINANCE_CRUMB. Copy both again from " +
  "the same browser session, or unset them to let the server handshake on its own.";

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

/** Thrown when the cookie/crumb handshake with Yahoo cannot be completed. */
export class YahooCrumbError extends YahooFinanceApiError {
  override readonly name = "YahooCrumbError";

  constructor(
    message = "Failed to obtain a Yahoo Finance crumb. Yahoo may have changed its consent flow; " +
      "set YAHOO_FINANCE_COOKIE and YAHOO_FINANCE_CRUMB to bypass the automatic handshake.",
  ) {
    super(message);
  }
}
