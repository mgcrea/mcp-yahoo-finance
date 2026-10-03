import { describe, expect, it, vi } from "vitest";

import type { YahooClient } from "#/client/http";
import { type Contract, projectFields, windowStrikes } from "#/lib/options";
import { registerTools } from "#/tools/index";
import type { ToolResult } from "#/tools/util";

const contract = (strike: number): Contract => ({
  contractSymbol: `AAPL261016C00${strike}000`,
  strike,
  bid: strike / 10,
  ask: strike / 10 + 0.1,
  impliedVolatility: 0.3,
  volume: 10,
});
const CHAIN = [50, 80, 95, 100, 105, 120, 150].map(contract);
const strikes = (chain: Contract[]) => chain.map((c) => c.strike);

describe("windowStrikes", () => {
  it("keeps strikes within ± pct of spot, bounds inclusive", () => {
    expect(strikes(windowStrikes(CHAIN, 100, 0.2))).toEqual([80, 95, 100, 105, 120]);
  });

  it("returns the chain unchanged without a window or a usable spot", () => {
    expect(windowStrikes(CHAIN, 100, undefined)).toBe(CHAIN);
    expect(windowStrikes(CHAIN, undefined, 0.1)).toBe(CHAIN);
    expect(windowStrikes(CHAIN, 0, 0.1)).toBe(CHAIN);
  });

  it("falls back to the full chain rather than returning nothing", () => {
    expect(windowStrikes(CHAIN, 1000, 0.01)).toBe(CHAIN);
  });
});

describe("projectFields", () => {
  it("keeps only the requested columns plus strike", () => {
    expect(projectFields([contract(100)], ["bid", "ask"])).toEqual([
      { strike: 100, bid: 10, ask: 10.1 },
    ]);
  });

  it("returns the chain unchanged for no or empty fields", () => {
    expect(projectFields(CHAIN, undefined)).toBe(CHAIN);
    expect(projectFields(CHAIN, [])).toBe(CHAIN);
  });
});

describe("yahoo_get_option_chain handler", () => {
  type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

  const setup = () => {
    const tools = new Map<string, Handler>();
    const server = {
      registerTool: (name: string, _def: unknown, handler: Handler) => tools.set(name, handler),
    };
    const options = vi.fn().mockResolvedValue({
      quote: { regularMarketPrice: 100 },
      options: [{ calls: CHAIN, puts: [] }],
    });
    registerTools(server as never, { options } as unknown as YahooClient);
    return { handler: tools.get("yahoo_get_option_chain")!, options };
  };

  it("windows on the spot price from the options payload and projects fields", async () => {
    const { handler, options } = setup();
    const result = await handler({
      ticker: "AAPL",
      expiration_date: "2026-10-16",
      option_type: "calls",
      strike_window_pct: 0.1,
      fields: ["bid"],
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual([
      { strike: 95, bid: 9.5 },
      { strike: 100, bid: 10 },
      { strike: 105, bid: 10.5 },
    ]);
    // One request: the spot comes from the same payload, not a second quote call.
    expect(options).toHaveBeenCalledTimes(1);
  });

  it("returns every strike and column when neither option is given", async () => {
    const { handler } = setup();
    const result = await handler({
      ticker: "AAPL",
      expiration_date: "2026-10-16",
      option_type: "calls",
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(CHAIN);
  });
});
