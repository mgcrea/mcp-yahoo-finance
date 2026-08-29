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
- 🌐 **Raw HTTP** to `query{1,2}.finance.yahoo.com` over native `fetch` — no
  third-party data SDK
- 🧰 Built the same way as the sibling `@mgcrea` MCPs: ESM, tsdown, oxlint/oxfmt,
  vitest, Docker + CI

## Stack

Node ≥ 24 · TypeScript · ESM · [`@modelcontextprotocol/sdk`] · `zod` ·
`tough-cookie` · tsdown · oxlint + oxfmt · vitest

## Install & build

```bash
pnpm install
pnpm build        # → dist/cli.js (bin) + dist/index.js (library)
```

## Run

```bash
pnpm start        # speaks MCP JSON-RPC over stdio
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
| `yahoo_get_option_chain`            | Calls or puts for a given expiration date.                                                                   |
| `yahoo_get_recommendations`         | Analyst recommendation trend, or upgrades/downgrades (deduped per firm).                                     |

## Configuration

All environment variables are optional — see [`.env.example`](.env.example):

| Variable                                       | Default | Purpose                                              |
| ---------------------------------------------- | ------- | ---------------------------------------------------- |
| `YAHOO_FINANCE_DEBUG`                          | –       | Verbose stderr logging.                              |
| `YAHOO_FINANCE_CONCURRENCY`                    | `4`     | Max concurrent requests (avoid 429s).                |
| `YAHOO_FINANCE_REQUEST_TIMEOUT_MS`             | `30000` | Per-request timeout.                                 |
| `YAHOO_FINANCE_COOKIE` / `YAHOO_FINANCE_CRUMB` | –       | Skip the automatic handshake with values you supply. |

> **Rate limiting.** Yahoo throttles bursts (HTTP 429), especially from
> datacenter IPs. Keep `YAHOO_FINANCE_CONCURRENCY` low, and if you are
> persistently blocked, provide `YAHOO_FINANCE_COOKIE` + `YAHOO_FINANCE_CRUMB`
> captured from a browser session.

## Wire up to Claude Code / Desktop

```json
{
  "mcpServers": {
    "yahoo-finance": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-yahoo-finance/dist/cli.js"]
    }
  }
}
```

Or, after `pnpm build`, link the bin globally and use `yahoo-finance-mcp` as the
command.

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

[`@modelcontextprotocol/sdk`]: https://github.com/modelcontextprotocol/typescript-sdk
