import { z } from "zod";

const ConfigSchema = z.object({
  debug: z.boolean().default(false),
  // Cap on in-flight Yahoo requests (handshake included), to stay under the 429 threshold.
  concurrency: z.number().int().positive().max(32).default(4),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  // Optional manual cookie/crumb override — bypasses the automatic handshake.
  cookie: z.string().optional(),
  crumb: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const isTruthy = (value: string | undefined): boolean =>
  value === "1" || value?.toLowerCase() === "true";

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
  });
