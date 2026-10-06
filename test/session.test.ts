import { describe, expect, it } from "vitest";

import { CrumbSession } from "#/client/session";

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
