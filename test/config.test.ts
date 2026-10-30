import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  // A file holding one Cookie header value, as apple_safari_cookies saves it.
  describe("cookie import file", () => {
    const FAKE = "A3=fake-a; T=fake-t; Y=fake-y";
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "yahoo-import-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const write = (text: string): string => {
      const path = join(dir, "cookie.txt");
      writeFileSync(path, text, { mode: 0o600 });
      return path;
    };

    it("is used exactly as YAHOO_FINANCE_COOKIE is, trimmed", () => {
      const env = { YAHOO_FINANCE_COOKIE_IMPORT_FILE: write(`  ${FAKE}\n`) };
      const config = loadConfig({ ...env, XDG_CONFIG_HOME: "/profiles/me" });
      expect(config.cookie).toBe(FAKE);
      expect(config.cookieFile).toBe("/profiles/me/mcp-yahoo-finance/cookies.json");
    });

    it("refuses to start beside YAHOO_FINANCE_COOKIE, saying which to drop", () => {
      const env = { YAHOO_FINANCE_COOKIE: FAKE, YAHOO_FINANCE_COOKIE_IMPORT_FILE: write(FAKE) };
      expect(() => loadConfig(env)).toThrow(
        /YAHOO_FINANCE_COOKIE and YAHOO_FINANCE_COOKIE_IMPORT_FILE.*Drop one/,
      );
    });

    it("names the setting and the path when the file is missing", () => {
      const path = join(dir, "absent.txt");
      expect(() => loadConfig({ YAHOO_FINANCE_COOKIE_IMPORT_FILE: path })).toThrow(
        `YAHOO_FINANCE_COOKIE_IMPORT_FILE: cannot read ${path}`,
      );
    });

    it("names the setting and the path when the file is empty, never its content", () => {
      const path = write("  \n");
      expect(() => loadConfig({ YAHOO_FINANCE_COOKIE_IMPORT_FILE: path })).toThrow(
        `YAHOO_FINANCE_COOKIE_IMPORT_FILE: ${path} is empty`,
      );
    });

    it("keeps the cookie out of the error when the path is not a file", () => {
      expect(() => loadConfig({ YAHOO_FINANCE_COOKIE_IMPORT_FILE: dir })).toThrow(
        `YAHOO_FINANCE_COOKIE_IMPORT_FILE: cannot read ${dir}`,
      );
    });

    it("ignores a blank setting", () => {
      expect(loadConfig({ YAHOO_FINANCE_COOKIE_IMPORT_FILE: "  " }).cookie).toBeUndefined();
    });
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
