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
});
