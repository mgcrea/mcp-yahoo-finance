import { Cookie, CookieJar } from "tough-cookie";

import { YahooCrumbError } from "#/client/errors";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type CrumbSessionOptions = {
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
  /** Skip the automatic handshake and use these values directly. */
  cookie?: string;
  crumb?: string;
};

// A realistic desktop browser User-Agent — Yahoo gates the cookie/crumb
// handshake on a browser-like UA and `accept: text/html`.
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CRUMB_SEED_URL = "https://finance.yahoo.com/quote/AAPL";
const GET_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";

const parseHtmlEntities = (str: string): string =>
  str.replace(/&#x([0-9A-Fa-f]{1,3});/gi, (_, num: string) =>
    String.fromCharCode(parseInt(num, 16)),
  );

/**
 * Manages the Yahoo Finance cookie + crumb handshake required by the
 * authenticated endpoints (v7 quote/options, v10 quoteSummary).
 *
 * The flow — ported from `yahoo-finance2`'s `getCrumb.ts` — hits a seed page to
 * collect cookies, transparently clears the EU "guce" consent wall when Yahoo
 * redirects to it, then exchanges the cookies for a crumb. Results are cached;
 * `invalidate()` forces a refetch after an "Invalid Crumb" response.
 */
export class CrumbSession {
  readonly jar: CookieJar;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;
  private readonly manualCrumb: string | undefined;
  private crumb: string | null = null;
  private inflight: Promise<string> | null = null;
  private cookiesReady = false;
  private cookieInflight: Promise<void> | null = null;

  constructor(opts: CrumbSessionOptions = {}) {
    this.jar = new CookieJar();
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.manualCrumb = opts.crumb;
    if (opts.crumb) this.crumb = opts.crumb;
    if (opts.cookie) {
      // Seed the jar so the very first request already carries the override.
      for (const part of opts.cookie.split(/;\s*/)) {
        const cookie = Cookie.parse(part);
        if (cookie) void this.jar.setCookie(cookie, CRUMB_SEED_URL);
      }
      // Trust the supplied cookie — don't run the automatic warm-up.
      this.cookiesReady = true;
    }
  }

  /** Cookie header value for a given URL, as stored in the jar. */
  cookieHeader(url: string): Promise<string> {
    return this.jar.getCookieString(url, { allPaths: true });
  }

  /** Drop the cached crumb so the next {@link get} performs a fresh handshake. */
  invalidate(): void {
    if (!this.manualCrumb) {
      this.crumb = null;
      this.cookiesReady = false;
    }
  }

  /**
   * Make sure the jar holds Yahoo's session cookies (clearing the consent wall
   * if needed). Every request — even the crumb-less ones — needs these or Yahoo
   * answers HTTP 429. Idempotent and de-duplicated across concurrent callers.
   */
  ensureCookies(): Promise<void> {
    if (this.cookiesReady) return Promise.resolve();
    if (!this.cookieInflight) {
      this.cookieInflight = this.fetchCookies()
        .then(() => {
          this.cookiesReady = true;
          this.cookieInflight = null;
        })
        .catch((err: unknown) => {
          this.cookieInflight = null;
          throw err;
        });
    }
    return this.cookieInflight;
  }

  /** Resolve the crumb, performing (and de-duplicating) the handshake as needed. */
  get(): Promise<string> {
    if (this.crumb) return Promise.resolve(this.crumb);
    if (!this.inflight) {
      this.inflight = this.handshake()
        .then((crumb) => {
          this.crumb = crumb;
          this.inflight = null;
          return crumb;
        })
        .catch((err: unknown) => {
          this.inflight = null;
          throw err;
        });
    }
    return this.inflight;
  }

  private async storeSetCookies(res: Response, url: string): Promise<void> {
    for (const header of res.headers.getSetCookie()) {
      const cookie = Cookie.parse(header);
      if (cookie) await this.jar.setCookie(cookie, url);
    }
  }

  private async fetchSeed(url: string): Promise<Response> {
    const res = await this.fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": this.userAgent,
        // Required to receive Set-Cookie from the seed page.
        accept: "text/html,application/xhtml+xml,application/xml",
        "accept-language": "en-US,en;q=0.9",
        cookie: await this.cookieHeader(url),
      },
    });
    await this.storeSetCookies(res, url);
    return res;
  }

  /** Walk Yahoo's EU consent redirect chain, accumulating consent cookies. */
  private async clearConsent(location: string): Promise<void> {
    this.logger?.debug?.("[yahoo] clearing EU consent wall");
    const consent = await this.fetchSeed(location);
    const collectLocation = consent.headers.get("location");
    if (!collectLocation?.match(/collectConsent/)) {
      throw new YahooCrumbError(`Unexpected consent redirect to ${collectLocation ?? "<none>"}`);
    }

    const collectRes = await this.fetchSeed(collectLocation);
    const body = await collectRes.text();
    const fields = [...body.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)]
      .map(([, name, value]) => `${name}=${encodeURIComponent(parseHtmlEntities(value!))}`)
      .join("&");
    const formBody = `${fields}&agree=agree&agree=agree`;

    const submitRes = await this.fetchImpl(collectLocation, {
      method: "POST",
      redirect: "manual",
      headers: {
        "user-agent": this.userAgent,
        "content-type": "application/x-www-form-urlencoded",
        cookie: await this.cookieHeader(collectLocation),
      },
      body: formBody,
    });
    await this.storeSetCookies(submitRes, collectLocation);

    let next = submitRes.headers.get("location");
    // Follow copyConsent → finance.yahoo.com, collecting cookies at each hop.
    for (let hops = 0; next && hops < 5; hops++) {
      const res = await this.fetchSeed(next);
      const loc = res.headers.get("location");
      if (!loc) break;
      next = loc;
    }
  }

  /** Hit the seed page (and consent chain) to collect Yahoo's session cookies. */
  private async fetchCookies(): Promise<void> {
    this.logger?.debug?.("[yahoo] warming session cookies");
    const seed = await this.fetchSeed(CRUMB_SEED_URL);
    const location = seed.headers.get("location");
    if (location?.match(/guce\.yahoo/)) {
      await this.clearConsent(location);
    }
  }

  private async handshake(): Promise<string> {
    await this.ensureCookies();
    this.logger?.debug?.("[yahoo] fetching crumb");

    const res = await this.fetchImpl(GET_CRUMB_URL, {
      method: "GET",
      headers: {
        "user-agent": this.userAgent,
        accept: "*/*",
        origin: "https://finance.yahoo.com",
        referer: CRUMB_SEED_URL,
        cookie: await this.cookieHeader(GET_CRUMB_URL),
      },
    });
    if (res.status === 429) {
      throw new YahooCrumbError(
        "Yahoo Finance rate limit hit while fetching a crumb (HTTP 429). Retry later, lower " +
          "YAHOO_FINANCE_CONCURRENCY, or set YAHOO_FINANCE_COOKIE + YAHOO_FINANCE_CRUMB.",
      );
    }
    if (res.status !== 200) {
      throw new YahooCrumbError(`Crumb request failed (status ${res.status})`);
    }
    const crumb = (await res.text()).trim();
    if (!crumb || crumb.includes("<html")) {
      throw new YahooCrumbError();
    }
    this.logger?.debug?.(`[yahoo] obtained crumb (${crumb.length} chars)`);
    return crumb;
  }
}
