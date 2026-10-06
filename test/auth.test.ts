import { describe, expect, it, vi } from "vitest";

import { YahooCookieRejectedError } from "#/client/errors";
import { YahooClient } from "#/client/http";
import { loadConfig } from "#/config";
import { registerTools } from "#/tools/index";
import type { ToolResult } from "#/tools/util";

// What the portfolio endpoints answered on 2026-10-06 for a cookie whose `T`
// login was missing or bogus, while the crumb was still issued.
const signedOut = () =>
  new Response(
    JSON.stringify({
      finance: {
        result: null,
        error: {
          code: "Forbidden",
          description: "Unable to authenticate user against member profile.",
        },
      },
    }),
    { status: 403, statusText: "" },
  );

const ACCOUNT = { userId: "U1", portfolios: [{ pfId: "p_1" }, { pfId: "p_3" }] };

// Answers getcrumb, then `reply` for everything else; records the other paths.
const clientFor = (cookie: string | undefined, reply: () => Response) => {
  const paths: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/test/getcrumb") return new Response("c1");
    paths.push(url.pathname);
    return reply();
  }) as typeof globalThis.fetch;
  const env = cookie ? { YAHOO_FINANCE_COOKIE: cookie } : {};
  return { client: new YahooClient({ config: loadConfig(env), fetch }), paths };
};

const unauthorized = () =>
  new Response(JSON.stringify({ finance: { error: { code: "Unauthorized" } } }), { status: 401 });

const ok = (body: unknown) => () => new Response(JSON.stringify(body));

describe("YahooClient with a signed-out cookie", () => {
  it("says the login in YAHOO_FINANCE_COOKIE expired when an account endpoint refuses it", async () => {
    const { client } = clientFor("A3=a; T=expired; Y=y", signedOut);
    const err = await client.portfolios().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(YahooCookieRejectedError);
    const { message, status, code } = err as YahooCookieRejectedError;
    expect(message).toContain("YAHOO_FINANCE_COOKIE");
    expect(message).toContain("signed in");
    expect(message).toContain("Unable to authenticate user against member profile.");
    expect(status).toBe(403);
    expect(code).toBe("Forbidden");
  });

  it("uses the same error when even a fresh crumb is refused for the cookie", async () => {
    const { client } = clientFor("A3=stale", unauthorized);

    await expect(client.quote(["AAPL"])).rejects.toBeInstanceOf(YahooCookieRejectedError);
  });
});

describe("YahooClient.authStatus", () => {
  it("confirms a live login and counts the account's lists, naming cookies but never values", async () => {
    const { client } = clientFor(
      "A3=secret; T=secret; Y=secret",
      ok({ finance: { result: [ACCOUNT] } }),
    );
    const status = await client.authStatus();

    expect(status).toEqual({
      signedIn: true,
      loginCookie: true,
      cookies: ["A3", "T", "Y"],
      lists: 2,
    });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("reports a refused login as signed out, with what to do", async () => {
    const { client } = clientFor("A3=a; T=expired", signedOut);

    expect(await client.authStatus()).toEqual({
      signedIn: false,
      loginCookie: true,
      cookies: ["A3", "T"],
      action: expect.stringContaining("YAHOO_FINANCE_COOKIE"),
    });
  });

  it("does not ask Yahoo when the cookie has no T login cookie", async () => {
    const { client, paths } = clientFor("A3=a; A1=b", ok({}));
    const status = await client.authStatus();

    expect(status).toMatchObject({ signedIn: false, loginCookie: false, cookies: ["A3", "A1"] });
    expect(status.action).toContain("T");
    expect(paths).toEqual([]);
  });

  it("lets other failures through rather than calling them a sign-out", async () => {
    const { client } = clientFor("T=t", () => new Response("Too Many Requests", { status: 429 }));

    await expect(client.authStatus()).rejects.not.toBeInstanceOf(YahooCookieRejectedError);
  });
});

const register = (client: Partial<YahooClient>, allowWrites = false) => {
  const tools = new Map<string, () => Promise<ToolResult>>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: () => Promise<ToolResult>) =>
      tools.set(name, handler),
  };
  registerTools(server as never, client as YahooClient, { allowWrites });
  return tools;
};

describe("yahoo_auth_status tool", () => {
  it("is registered only when YAHOO_FINANCE_COOKIE is set", () => {
    expect(register({ manualAuth: false }).has("yahoo_auth_status")).toBe(false);
    expect(register({ manualAuth: true }).has("yahoo_auth_status")).toBe(true);
  });

  it("returns the client's status plus whether writes are enabled", async () => {
    const status = { signedIn: true, loginCookie: true, cookies: ["T"], lists: 1 };
    const tools = register(
      { manualAuth: true, signedIn: true, authStatus: vi.fn().mockResolvedValue(status) },
      true,
    );
    const result = await tools.get("yahoo_auth_status")!();

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ...status, writes: true });
  });
});
