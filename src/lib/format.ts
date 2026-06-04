/** Replace `NaN` with `null` (everything else passes through unchanged). */
export const nanToNull = (value: unknown): unknown =>
  typeof value === "number" && Number.isNaN(value) ? null : value;

/**
 * Normalize Yahoo's mixed date encodings (unix seconds, unix millis, `Date`,
 * ISO string) into an ISO-8601 string. Returns `null` for unparseable input.
 */
export const toISO = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Heuristic: values past ~2001 in ms are >1e12; smaller numbers are seconds.
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toISOString();
  }
  return null;
};

/**
 * Unwrap Yahoo's `{ raw, fmt, longFmt }` number wrappers to their `raw` value.
 * Leaves plain values untouched. Used defensively across quoteSummary output.
 */
export const unwrap = (value: unknown): unknown => {
  if (value && typeof value === "object" && !Array.isArray(value) && "raw" in value) {
    return (value as { raw: unknown }).raw;
  }
  return value;
};

/**
 * Deep-walk a payload making it safe + tidy for JSON output: unwrap `{raw}`
 * wrappers, convert `Date`/epoch-looking values left as Dates to ISO, and map
 * `NaN` to `null`.
 */
export const sanitize = (input: unknown): unknown => {
  if (input instanceof Date) return toISO(input);
  if (typeof input === "number") return Number.isNaN(input) ? null : input;
  if (Array.isArray(input)) return input.map(sanitize);
  if (input && typeof input === "object") {
    if ("raw" in input && ("fmt" in input || "longFmt" in input)) {
      return sanitize((input as { raw: unknown }).raw);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = sanitize(value);
    }
    return out;
  }
  return input;
};
