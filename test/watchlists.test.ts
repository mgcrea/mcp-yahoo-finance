import { describe, expect, it, vi } from "vitest";

import type { Portfolio, YahooClient } from "#/client/http";
import { registerTools } from "#/tools/index";
import type { ToolResult } from "#/tools/util";

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type Def = { annotations?: Record<string, boolean> };

const fakeServer = () => {
  const tools = new Map<string, { def: Def; handler: Handler }>();
  const server = {
    registerTool: (name: string, def: Def, handler: Handler) => tools.set(name, { def, handler }),
  };
  return { server, tools };
};

const parse = (result: ToolResult) => ({
  data: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  isError: result.isError ?? false,
});

// Positions arrive in insertion order, not display order — sortOrder decides.
const watch = (): Portfolio => ({
  pfId: "p_3",
  pfName: "Watch",
  pfType: "WATCHLIST",
  positions: [
    { posId: "pos_1", symbol: "NVDA", sortOrder: 1 },
    { posId: "pos_0", symbol: "AAPL", sortOrder: 0 },
  ],
});
const holdings = (): Portfolio => ({
  pfId: "p_1",
  pfName: "Portfolio",
  pfType: "MANUAL_PORTFOLIO",
  positions: [{ posId: "pos_0", symbol: "MSFT", sortOrder: 0 }],
});

const account = (overrides: Partial<YahooClient> = {}) => {
  const client = {
    signedIn: true,
    portfolios: vi.fn().mockResolvedValue({
      userId: "U1",
      hasMigratedToNewModel: true,
      portfolios: [holdings(), watch()],
    }),
    updatePortfolio: vi.fn(),
    deletePortfolio: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const { server, tools } = fakeServer();
  registerTools(server as never, client as unknown as YahooClient);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    parse(await tools.get(name)!.handler(args));
  return { client, tools, call };
};

const WRITE_TOOLS = [
  "yahoo_add_to_watchlist",
  "yahoo_create_watchlist",
  "yahoo_delete_watchlist",
  "yahoo_remove_from_watchlist",
];

describe("watchlist tool registration", () => {
  it("adds the watchlist tools only for a signed-in cookie", () => {
    const anonymous = fakeServer();
    registerTools(anonymous.server as never, { signedIn: false } as unknown as YahooClient);
    expect([...anonymous.tools.keys()].filter((n) => n.includes("watchlist"))).toEqual([]);

    const { tools } = account();
    expect([...tools.keys()].filter((n) => n.includes("watchlist")).toSorted()).toEqual([
      ...WRITE_TOOLS.slice(0, 3),
      "yahoo_list_watchlists",
      WRITE_TOOLS[3],
    ]);
  });

  it("marks reads read-only, writes as writes, and removals as destructive", () => {
    const { tools } = account();
    const hints = (name: string) => tools.get(name)!.def.annotations;
    expect(hints("yahoo_list_watchlists")).toMatchObject({ readOnlyHint: true });
    for (const name of WRITE_TOOLS) expect(hints(name)).toMatchObject({ readOnlyHint: false });
    expect(hints("yahoo_add_to_watchlist")).toMatchObject({ destructiveHint: false });
    expect(hints("yahoo_create_watchlist")).toMatchObject({ destructiveHint: false });
    expect(hints("yahoo_remove_from_watchlist")).toMatchObject({ destructiveHint: true });
    expect(hints("yahoo_delete_watchlist")).toMatchObject({ destructiveHint: true });
  });
});

describe("yahoo_list_watchlists", () => {
  it("lists every list with its symbols in display order", async () => {
    const { data, isError } = await account().call("yahoo_list_watchlists");
    expect(isError).toBe(false);
    expect(data).toEqual([
      { pfId: "p_1", name: "Portfolio", type: "MANUAL_PORTFOLIO", symbols: ["MSFT"] },
      { pfId: "p_3", name: "Watch", type: "WATCHLIST", symbols: ["AAPL", "NVDA"] },
    ]);
  });
});

describe("yahoo_add_to_watchlist", () => {
  it("appends new symbols after the existing ones and skips those already there", async () => {
    const updatePortfolio = vi.fn().mockResolvedValue([
      {
        ...watch(),
        positions: [...watch().positions!, { posId: "pos_2", symbol: "BRK-B", sortOrder: 2 }],
      },
    ]);
    const { call } = account({ updatePortfolio });

    const { data } = await call("yahoo_add_to_watchlist", {
      pfId: "p_3",
      symbols: ["nvda", "brk.b"],
    });
    expect(updatePortfolio).toHaveBeenCalledWith({
      pfId: "p_3",
      userId: "U1",
      operations: [{ operation: "position_insert", symbol: "BRK-B", sortOrder: 2 }],
    });
    expect(data).toEqual({
      watchlist: {
        pfId: "p_3",
        name: "Watch",
        type: "WATCHLIST",
        symbols: ["AAPL", "NVDA", "BRK-B"],
      },
      skipped: ["NVDA"],
    });
  });

  it("sends nothing when every symbol is already on the list", async () => {
    const { client, call } = account();
    const { data } = await call("yahoo_add_to_watchlist", { pfId: "p_3", symbols: ["AAPL"] });
    expect(client.updatePortfolio).not.toHaveBeenCalled();
    expect(data).toMatchObject({ skipped: ["AAPL"] });
  });

  it("refuses a manual portfolio, whose positions carry lots", async () => {
    const { client, call } = account();
    const { data, isError } = await call("yahoo_add_to_watchlist", {
      pfId: "p_1",
      symbols: ["TSLA"],
    });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/p_1 is a MANUAL_PORTFOLIO/);
    expect(client.updatePortfolio).not.toHaveBeenCalled();
  });

  it("names the lists that exist when the pfId is unknown", async () => {
    const { data, isError } = await account().call("yahoo_add_to_watchlist", {
      pfId: "p_9",
      symbols: ["TSLA"],
    });
    expect(isError).toBe(true);
    expect(data.error).toBe("No list with pfId p_9. Lists: p_1 (Portfolio), p_3 (Watch).");
  });
});

describe("yahoo_remove_from_watchlist", () => {
  it("removes by Yahoo's posId and reports symbols that were not on the list", async () => {
    const updatePortfolio = vi
      .fn()
      .mockResolvedValue([
        { ...watch(), positions: [{ posId: "pos_1", symbol: "NVDA", sortOrder: 1 }] },
      ]);
    const { call } = account({ updatePortfolio });

    const { data } = await call("yahoo_remove_from_watchlist", {
      pfId: "p_3",
      symbols: ["aapl", "GOOG"],
    });
    expect(updatePortfolio).toHaveBeenCalledWith({
      pfId: "p_3",
      userId: "U1",
      operations: [{ operation: "position_delete", posId: "pos_0" }],
    });
    expect(data).toEqual({
      watchlist: { pfId: "p_3", name: "Watch", type: "WATCHLIST", symbols: ["NVDA"] },
      notFound: ["GOOG"],
    });
  });

  it("refuses a manual portfolio, where removing a position deletes its lots", async () => {
    const { client, call } = account();
    const { isError } = await call("yahoo_remove_from_watchlist", {
      pfId: "p_1",
      symbols: ["MSFT"],
    });
    expect(isError).toBe(true);
    expect(client.updatePortfolio).not.toHaveBeenCalled();
  });
});

describe("yahoo_create_watchlist", () => {
  it("creates the list with its symbols in one request and returns the new list", async () => {
    const created: Portfolio = {
      pfId: "p_5",
      pfName: "Semis",
      pfType: "WATCHLIST",
      positions: [
        { posId: "pos_0", symbol: "AMD", sortOrder: 0 },
        { posId: "pos_1", symbol: "NVDA", sortOrder: 1 },
      ],
    };
    const updatePortfolio = vi.fn().mockResolvedValue([holdings(), watch(), created]);
    const { call } = account({ updatePortfolio });

    const { data } = await call("yahoo_create_watchlist", {
      name: "Semis",
      symbols: ["amd", "NVDA"],
    });
    expect(updatePortfolio).toHaveBeenCalledWith({
      userId: "U1",
      operations: [
        {
          operation: "portfolio_update",
          pfName: "Semis",
          baseCurrency: "USD",
          defaultPf: false,
          pfType: "WATCHLIST",
          hasMigratedToNewModel: true,
        },
        { operation: "position_insert", symbol: "AMD", sortOrder: 0, onePortfolio: true },
        { operation: "position_insert", symbol: "NVDA", sortOrder: 1, onePortfolio: true },
      ],
    });
    expect(data).toEqual({
      pfId: "p_5",
      name: "Semis",
      type: "WATCHLIST",
      symbols: ["AMD", "NVDA"],
    });
  });
});

describe("yahoo_delete_watchlist", () => {
  it("deletes the list and returns what it held, so it can be recreated", async () => {
    const { client, call } = account();
    const { data } = await call("yahoo_delete_watchlist", { pfId: "p_3" });
    expect(client.deletePortfolio).toHaveBeenCalledWith("p_3", "U1");
    expect(data).toEqual({
      deleted: { pfId: "p_3", name: "Watch", type: "WATCHLIST", symbols: ["AAPL", "NVDA"] },
    });
  });

  it("refuses to delete a manual portfolio", async () => {
    const { client, call } = account();
    const { isError } = await call("yahoo_delete_watchlist", { pfId: "p_1" });
    expect(isError).toBe(true);
    expect(client.deletePortfolio).not.toHaveBeenCalled();
  });
});
