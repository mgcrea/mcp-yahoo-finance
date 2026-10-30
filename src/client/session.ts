import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Cookie, CookieJar } from "tough-cookie";

import { RATE_LIMIT_MESSAGE, YahooCrumbError } from "#/client/errors";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type CrumbSessionOptions = {
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
  /**
   * Use this cookie instead of warming anonymous ones. The crumb is then asked
   * of Yahoo for that cookie, unless one is supplied too.
   */
  cookie?: string;
  crumb?: string;
  /**
   * Where to keep the supplied cookie's session between runs. Yahoo renews the
   * login cookies as it goes; a copy pasted from a browser goes stale unless
   * what Yahoo sends back is kept. Ignored without a `cookie`.
   */
  cookieFile?: string;
};

// A realistic desktop browser User-Agent — Yahoo gates the cookie/crumb
// handshake on a browser-like UA and `accept: text/html`.
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CRUMB_SEED_URL = "https://finance.yahoo.com/quote/AAPL";
const GET_CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";

const fingerprint = (cookie: string): string => createHash("sha256").update(cookie).digest("hex");

const cookieFileFormat = 1;

/** The jar saved for exactly this supplied cookie, or null (missing, unreadable, or for another cookie). */
const loadJar = (path: string, source: string, logger: Logger | undefined): CookieJar | null => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const saved = JSON.parse(text) as { version?: number; source?: string; jar?: unknown };
    // A different cookie was supplied: it was copied again, so it wins.
    if (saved.version !== cookieFileFormat || saved.source !== source || !saved.jar) return null;
    return CookieJar.deserializeSync(saved.jar as never);
  } catch {
    logger?.warn?.(`[yahoo] ignoring the unreadable cookie file ${path}`);
    return null;
  }
};

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
  private readonly manualCookie: boolean;
  private readonly cookieFile: string | undefined;
  private readonly source: string | undefined;
  private crumb: string | null = null;
  private inflight: Promise<string> | null = null;
  private cookiesReady = false;
  private cookieInflight: Promise<void> | null = null;

  constructor(opts: CrumbSessionOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.manualCookie = Boolean(opts.cookie);
    this.cookieFile = opts.cookie ? opts.cookieFile : undefined;
    this.source = opts.cookie ? fingerprint(opts.cookie) : undefined;
    const restored =
      this.cookieFile && this.source ? loadJar(this.cookieFile, this.source, this.logger) : null;
    this.jar = restored ?? new CookieJar();
    if (opts.crumb) this.crumb = opts.crumb;
    if (opts.cookie) {
      // Seed the jar so the very first request already carries the override,
      // unless a saved session for this very cookie already holds its renewals.
      // Scope it to all of yahoo.com: it is copied from a finance.yahoo.com tab,
      // but the API answers on query1/query2, which a host-only cookie misses.
      if (!restored) {
        for (const part of opts.cookie.split(/;\s*/)) {
          if (part) this.jar.setCookieSync(`${part}; Domain=yahoo.com; Path=/`, CRUMB_SEED_URL);
        }
      }
      // Trust the supplied cookie — don't run the automatic warm-up.
      this.cookiesReady = true;
    }
  }

  /** Cookie header value for a given URL, as stored in the jar. */
  cookieHeader(url: string): Promise<string> {
    return this.jar.getCookieString(url, { allPaths: true });
  }

  /**
   * Drop the cached crumb — supplied or not — so the next {@link get} asks Yahoo
   * for a fresh one. A supplied cookie is the session's identity and is kept;
   * only anonymous cookies are warmed again.
   */
  invalidate(): void {
    this.crumb = null;
    if (!this.manualCookie) this.cookiesReady = false;
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

  /**
   * Keep whatever cookies Yahoo sent back on a response, and save the session
   * when that changed it. Yahoo renews its login cookies on ordinary calls, so
   * this is what keeps a copied cookie alive.
   */
  async absorb(res: Response, url: string): Promise<void> {
    const before = this.fingerprintJar();
    await this.storeSetCookies(res, url);
    if (this.cookieFile && this.fingerprintJar() !== before) this.persist(this.cookieFile);
  }

  // Name, value and scope only: re-sending the same cookie is not a change.
  private fingerprintJar(): string {
    const { cookies } = this.jar.serializeSync() ?? { cookies: [] };
    return JSON.stringify(
      cookies.map((c) => [c.key, c.value, c.domain, c.path]).toSorted((a, b) => (a < b ? -1 : 1)),
    );
  }

  private persist(path: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const saved = {
        version: cookieFileFormat,
        source: this.source,
        jar: this.jar.serializeSync(),
      };
      // A live login: readable by its owner only, and never half-written.
      writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing to clean up if the folder itself was the problem.
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`[yahoo] could not write the cookie file ${path}: ${reason}`);
    }
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
      throw new YahooCrumbError(`${RATE_LIMIT_MESSAGE} (While fetching a crumb.)`);
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
