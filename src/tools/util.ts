import { YahooFinanceApiError } from "#/client/errors";
import { sanitize } from "#/lib/format";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(sanitize(data), null, 2) }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2),
    },
  ],
  isError: true,
});

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof YahooFinanceApiError) {
      return fail(
        err.message,
        err.status || err.code ? { status: err.status, code: err.code } : undefined,
      );
    }
    if (err instanceof Error) {
      return fail(err.message);
    }
    return fail("Unknown error", err);
  }
};
