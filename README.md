# @mgcrea/mcp-yahoo-finance

> Model Context Protocol (MCP) server for Yahoo Finance market data.

A TypeScript MCP server that exposes Yahoo Finance data — historical prices,
company info, news, financial statements, holders, options and analyst
recommendations — to MCP clients like Claude. **No API key or account is
required**: the cookie/crumb handshake Yahoo expects is handled automatically.

## Features

- 📈 **9 tools** covering prices, fundamentals, options, holders and analyst data
- 🔓 **No auth** — the Yahoo cookie + crumb handshake (incl. the EU consent wall)
  is performed transparently; an optional manual override is available
- 🌐 **Raw HTTP** to `query{1,2}.finance.yahoo.com` over `node:https` with a
  browser TLS fingerprint — no third-party data SDK
- 🧰 Built the same way as the sibling `@mgcrea` MCPs: ESM, tsdown, oxlint/oxfmt,
  vitest, Docker + CI

## Stack

Node ≥ 24 · TypeScript · ESM · [`@modelcontextprotocol/server`] · `zod` ·
`tough-cookie` · tsdown · oxlint + oxfmt · vitest

## Install

```bash
npx -y @mgcrea/mcp-yahoo-finance   # speaks MCP JSON-RPC over stdio
```

From source:

```bash
pnpm install
pnpm build        # → dist/cli.js (bin) + dist/index.js (library)
pnpm start
```

## Tools

| Tool                                | Description                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `yahoo_get_historical_stock_prices` | OHLCV history for a ticker (`period`, `interval`). Intraday intervals (`1m`–`90m`) return ~the last 60 days. |
| `yahoo_get_stock_actions`           | Dividend and stock-split history.                                                                            |
| `yahoo_get_stock_info`              | Comprehensive info: price, profile, key stats, financial metrics (≈ yfinance `.info`).                       |
| `yahoo_get_yahoo_finance_news`      | Recent news articles for a ticker.                                                                           |
| `yahoo_get_financial_statement`     | Income / balance-sheet / cash-flow statement, annual or quarterly.                                           |
| `yahoo_get_holder_info`             | Major / institutional / mutual-fund holders, insider transactions / purchases / roster.                      |
| `yahoo_get_option_expiration_dates` | Available option expiration dates.                                                                           |
| `yahoo_get_option_chain`            | Calls or puts for an expiration date. `strike_window_pct` keeps strikes near spot; `fields` picks columns.   |
| `yahoo_get_recommendations`         | Analyst recommendation trend, or upgrades/downgrades (deduped per firm).                                     |

### Watchlists and portfolios (signed-in cookie only)

These appear only when `YAHOO_FINANCE_COOKIE` holds a signed-in session — the
`A3`, `T` and `Y` cookies from a finance.yahoo.com tab where you are logged in.
The two reads need nothing more; the tools that change the account also need
`YAHOO_FINANCE_ALLOW_WRITES=1`.

In a manual portfolio a position carries lots and transactions, and removing the
position deletes them. So removing such a position, or deleting a portfolio that
holds any, is refused unless the call passes `delete_history: true`, and the
reply lists what went.

Yahoo does not say when a login cookie expires. Once it does, the account tools
fail with an error naming `YAHOO_FINANCE_COOKIE`, and `yahoo_auth_status` (registered
whenever a cookie is set) checks it live: it lists the account and reports
`signedIn`, the cookie names it found (never their values), and what to do next.

| Tool                                 | Description                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `yahoo_auth_status`                  | Whether the cookie is still signed in, checked live against the account.             |
| `yahoo_list_watchlists`              | Every watchlist and portfolio on the account, with its `pfId` and symbols.           |
| `yahoo_create_watchlist`             | Create a watchlist, or a portfolio with `type: "MANUAL_PORTFOLIO"`.                  |
| `yahoo_add_to_watchlist`             | Append symbols to a watchlist or portfolio; those already on it are skipped.         |
| `yahoo_remove_from_watchlist`        | Remove symbols. Positions with lots or transactions need `delete_history: true`.     |
| `yahoo_delete_watchlist`             | Delete a list, returning its name and symbols so it can be recreated.                |
| `yahoo_get_portfolio_transactions`   | The buys and sells recorded for a symbol in a portfolio.                             |
| `yahoo_add_portfolio_transaction`    | Record a buy or sell (date, quantity, price, commission); adds the symbol if needed. |
| `yahoo_update_portfolio_transaction` | Change a recorded trade; fields not given are kept.                                  |
| `yahoo_delete_portfolio_transaction` | Delete a recorded trade, returning it so it can be recorded again.                   |

## Configuration

All environment variables are optional — see [`.env.example`](.env.example):

| Variable                           | Default | Purpose                                                                                          |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `YAHOO_FINANCE_DEBUG`              | –       | Verbose stderr logging.                                                                          |
| `YAHOO_FINANCE_CONCURRENCY`        | `4`     | Max in-flight requests to Yahoo (avoid 429s).                                                    |
| `YAHOO_FINANCE_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout, body included.                                                              |
| `YAHOO_FINANCE_COOKIE`             | –       | Use this browser cookie instead of the automatic handshake; the crumb is fetched for it.         |
| `YAHOO_FINANCE_CRUMB`              | –       | Rarely needed: a crumb is derived from the cookie, and replaced if Yahoo rejects it.             |
| `YAHOO_FINANCE_ALLOW_WRITES`       | –       | `1` registers the watchlist and portfolio tools that change the account (signed-in cookie only). |

> **HTTP 429.** Yahoo answers 429 for two reasons. One is a burst limit: wait,
> and keep `YAHOO_FINANCE_CONCURRENCY` low when fetching many tickers. The other
> is a TLS handshake that does not look like a browser's, which Yahoo refuses on
> every request and from any IP — cookies and a crumb do not get past it. This
> server presents Chrome's TLS parameters for that reason (see
> [`src/client/transport.ts`](src/client/transport.ts)). If every call starts
> failing with 429, Yahoo has moved what it accepts: upgrade, or open an issue.

## Wire up to Claude Code / Desktop

```json
{
  "mcpServers": {
    "yahoo-finance": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@mgcrea/mcp-yahoo-finance"]
    }
  }
}
```

Tickers are normalized before they reach Yahoo: US share classes typed as
`BRK.B` or `BRK/B` become `BRK-B`, while exchange suffixes such as `SHOP.TO` or
`RIO.L` pass through unchanged.

## Docker

```bash
pnpm docker:build                  # local single-arch image
pnpm docker:release                # multi-arch build & push
docker run -i --rm mgcrea/mcp-yahoo-finance:latest
```

## Development

```bash
pnpm dev            # tsdown --watch
pnpm typecheck
pnpm lint
pnpm format
pnpm test
```

## License

MIT — © Olivier Louvignes

[`@modelcontextprotocol/server`]: https://github.com/modelcontextprotocol/typescript-sdk
