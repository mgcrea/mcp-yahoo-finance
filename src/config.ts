import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const ConfigSchema = z.object({
  debug: z.boolean().default(false),
  // Cap on in-flight Yahoo requests (handshake included), to stay under the 429 threshold.
  concurrency: z.number().int().positive().max(32).default(4),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  // Optional browser cookie — replaces the automatic handshake. The crumb is
  // derived from it unless supplied, and re-derived if Yahoo rejects it.
  cookie: z.string().optional(),
  crumb: z.string().optional(),
  // Where the cookie's renewed session is kept between runs. Set whenever a
  // cookie is supplied; the variable overrides the default location.
  cookieFile: z.string().optional(),
  // Registers the watchlist write tools. Bastion's per-profile write toggle.
  allowWrites: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

const isTruthy = (value: string | undefined): boolean =>
  value === "1" || value?.toLowerCase() === "true";

// Bastion writes "1" and "0"; unset falls through to the schema default.
const parseBool = (value: string | undefined): boolean | undefined => {
  const t = value?.trim();
  if (!t) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

// Under XDG_CONFIG_HOME so Bastion, which points it at each profile's own
// folder, keeps two profiles' logins apart without being told a path.
const defaultCookieFile = (env: NodeJS.ProcessEnv): string =>
  join(
    env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"),
    "mcp-yahoo-finance",
    "cookies.json",
  );

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  ConfigSchema.parse({
    debug: isTruthy(env.YAHOO_FINANCE_DEBUG),
    concurrency: parseIntOpt(env.YAHOO_FINANCE_CONCURRENCY),
    requestTimeoutMs: parseIntOpt(env.YAHOO_FINANCE_REQUEST_TIMEOUT_MS),
    cookie: env.YAHOO_FINANCE_COOKIE || undefined,
    crumb: env.YAHOO_FINANCE_CRUMB || undefined,
    cookieFile: env.YAHOO_FINANCE_COOKIE
      ? env.YAHOO_FINANCE_COOKIE_FILE?.trim() || defaultCookieFile(env)
      : undefined,
    allowWrites: parseBool(env.YAHOO_FINANCE_ALLOW_WRITES),
  });
