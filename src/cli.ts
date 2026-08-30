#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { BUILD_INFO } from "#/build-info";
import { loadConfig } from "#/config";
import { createServer } from "#/server";

// All logging goes to stderr — stdout carries the JSON-RPC stream and any stray
// write there corrupts the MCP protocol.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.YAHOO_FINANCE_DEBUG) console.error("[yahoo-finance-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[yahoo-finance-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[yahoo-finance-mcp]", ...args),
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const { server } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLogger.warn("yahoo-finance-mcp connected");

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error("[yahoo-finance-mcp] fatal:", err);
  process.exit(1);
});
