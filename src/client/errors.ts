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
