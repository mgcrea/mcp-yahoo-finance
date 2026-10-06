import { describe, expect, it } from "vitest";

import { YahooCrumbError } from "#/client/errors";
import { CrumbSession } from "#/client/session";

type Call = { url: string; method: string; cookie: string; body: string };

// A scripted Yahoo: each handler answers the first URL it matches, and every
// request is recorded with the cookies it carried.
const fakeYahoo = (routes: [RegExp, (call: Call) => Response][]) => {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      cookie: headers.get("cookie") ?? "",
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(call.url));
    if (!route) throw new Error(`unexpected request to ${call.url}`);
    return route[1](call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const redirect = (location: string, setCookie: string[] = []) => {
  const headers = new Headers({ location });
  for (const c of setCookie) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

describe("CrumbSession with a supplied cookie", () => {
  // The cookie is copied from a finance.yahoo.com tab, but the API lives on
  // query1/query2 — a host-only cookie would never reach it.
  it.each([
    "https://finance.yahoo.com/quote/AAPL",
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    "https://query2.finance.yahoo.com/v7/finance/quote?symbols=AAPL",
  ])("sends every supplied cookie to %s", async (url) => {
    const session = new CrumbSession({ cookie: "A1=one; A3=d=AQAB&S=AQAA", crumb: "c" });
    expect(await session.cookieHeader(url)).toBe("A1=one; A3=d=AQAB&S=AQAA");
  });

  it("keeps it off other sites", async () => {
    const session = new CrumbSession({ cookie: "A3=three", crumb: "c" });
    expect(await session.cookieHeader("https://example.com/")).toBe("");
  });
});

describe("CrumbSession through the EU consent wall", () => {
  const SEED = /finance\.yahoo\.com\/quote\/AAPL/;
  const CONSENT = "https://guce.yahoo.com/consent?brandType=nonEu&gcrumb=g1";
  const COLLECT = "https://consent.yahoo.com/v2/collectConsent?sessionId=s1";
  const COPY = "https://guce.yahoo.com/copyConsent?sessionId=s1";

  const consentWall = (collectRedirect = COLLECT) =>
    fakeYahoo([
      [SEED, (c) => (c.cookie.includes("A1=") ? new Response("<html/>") : redirect(CONSENT))],
      [/guce\.yahoo\.com\/consent/, () => redirect(collectRedirect)],
      [
        /collectConsent/,
        (c) =>
          c.method === "POST"
            ? redirect(COPY)
            : new Response(
                '<form><input type="hidden" name="csrfToken" value="tok">' +
                  '<input type="hidden" name="originalDoneUrl" value="https:&#x2F;&#x2F;finance.yahoo.com&#x2F;">' +
                  "</form>",
                { headers: { "set-cookie": "GUCS=gucs; Path=/" } },
              ),
      ],
      [
        /copyConsent/,
        () =>
          redirect("https://finance.yahoo.com/quote/AAPL", [
            "A1=consented; Domain=.yahoo.com; Path=/",
            "A3=consented; Domain=.yahoo.com; Path=/",
          ]),
      ],
      [/getcrumb/, (c) => new Response(c.cookie.includes("A3=consented") ? "eu-crumb" : "")],
    ]);

  it("agrees to the consent form and gets a crumb with the cookies it set", async () => {
    const { fetch, calls } = consentWall();
    const session = new CrumbSession({ fetch });
    expect(await session.get()).toBe("eu-crumb");

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(COLLECT);
    expect(post.cookie).toContain("GUCS=gucs");
    // Hidden fields go back decoded from HTML entities, then URL-encoded.
    expect(post.body).toBe(
      "csrfToken=tok&originalDoneUrl=https%3A%2F%2Ffinance.yahoo.com%2F&agree=agree&agree=agree",
    );
    expect(calls.at(-1)!.url).toMatch(/getcrumb/);
  });

  it("fails with a crumb error when the consent page leads somewhere unexpected", async () => {
    const { fetch } = consentWall("https://login.yahoo.com/");
    const err = await new CrumbSession({ fetch }).get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YahooCrumbError);
    expect((err as Error).message).toContain("https://login.yahoo.com/");
  });
});
