import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "#/config";

describe("loadConfig", () => {
  it("applies sensible defaults on an empty env", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      debug: false,
      concurrency: 4,
      requestTimeoutMs: 30_000,
      cookie: undefined,
      crumb: undefined,
      allowWrites: false,
      cookieFile: undefined,
    });
  });

  it("reads overrides from the environment", () => {
    const config = loadConfig({
      YAHOO_FINANCE_DEBUG: "1",
      YAHOO_FINANCE_CONCURRENCY: "8",
      YAHOO_FINANCE_REQUEST_TIMEOUT_MS: "5000",
      YAHOO_FINANCE_COOKIE: "A1=token",
      YAHOO_FINANCE_CRUMB: "abc123",
    });
    expect(config.debug).toBe(true);
    expect(config.concurrency).toBe(8);
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.cookie).toBe("A1=token");
    expect(config.crumb).toBe("abc123");
  });

  it("ignores blank/invalid numeric overrides", () => {
    const config = loadConfig({ YAHOO_FINANCE_CONCURRENCY: "", YAHOO_FINANCE_COOKIE: "" });
    expect(config.concurrency).toBe(4);
    expect(config.cookie).toBeUndefined();
  });

  // Bastion's write toggle sends "1" and "0"; people type the other spellings.
  it.each([
    ["1", true],
    ["true", true],
    ["yes", true],
    ["on", true],
    ["0", false],
    ["false", false],
    ["off", false],
    ["", false],
  ])("reads YAHOO_FINANCE_ALLOW_WRITES=%j as %s", (value, expected) => {
    expect(loadConfig({ YAHOO_FINANCE_ALLOW_WRITES: value }).allowWrites).toBe(expected);
  });

  describe("cookie file", () => {
    const COOKIE = "A3=a; T=login";

    it("is the one named, when a cookie is supplied", () => {
      const env = { YAHOO_FINANCE_COOKIE: COOKIE, YAHOO_FINANCE_COOKIE_FILE: "/state/c.json" };
      expect(loadConfig(env).cookieFile).toBe("/state/c.json");
    });

    // Bastion points XDG_CONFIG_HOME at the profile's own folder, so the default
    // keeps two profiles' logins apart without anyone configuring a path.
    it("defaults beside XDG_CONFIG_HOME, so each Bastion profile gets its own", () => {
      const env = { YAHOO_FINANCE_COOKIE: COOKIE, XDG_CONFIG_HOME: "/profiles/me" };
      expect(loadConfig(env).cookieFile).toBe("/profiles/me/mcp-yahoo-finance/cookies.json");
    });

    it("defaults under ~/.config without XDG_CONFIG_HOME, and for a blank name", () => {
      const expected = join(homedir(), ".config", "mcp-yahoo-finance", "cookies.json");
      expect(loadConfig({ YAHOO_FINANCE_COOKIE: COOKIE }).cookieFile).toBe(expected);
      const blank = { YAHOO_FINANCE_COOKIE: COOKIE, YAHOO_FINANCE_COOKIE_FILE: "  " };
      expect(loadConfig(blank).cookieFile).toBe(expected);
    });

    it("is unset without a cookie, since there is no session to keep", () => {
      expect(loadConfig({ XDG_CONFIG_HOME: "/profiles/me" }).cookieFile).toBeUndefined();
      expect(loadConfig({ YAHOO_FINANCE_COOKIE_FILE: "/state/c.json" }).cookieFile).toBeUndefined();
    });
  });
});
