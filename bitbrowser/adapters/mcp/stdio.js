#!/usr/bin/env node
/** Executable MCP entry. stdout is reserved exclusively for JSON-RPC messages. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

try {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  process.once('SIGINT', () => {
    void server.close();
  });
  process.once('SIGTERM', () => {
    void server.close();
  });
} catch {
  console.error('BitBrowser MCP 无法启动，请检查 Node 版本、依赖及本机端点配置。');
  process.exitCode = 1;
}
