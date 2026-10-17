/** stdio-independent MCP adapter. The SDK handles protocol negotiation and request transport. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolDefinitions } from '../../src/contracts/tools.js';
import { successResult, errorResult } from '../../src/contracts/results.js';
import { createAgentService } from '../../src/services/agent.js';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

/**
 * Build an MCP server on the supplied domain service.
 * Low-level SDK handlers preserve one consistent structured error envelope, including schema errors.
 * @param {{service?:ReturnType<typeof createAgentService>}} options
 */
export function createMcpServer({ service = createAgentService() } = {}) {
  const server = new Server(
    { name: 'bitbrowser', version },
    {
      capabilities: { tools: {} },
      instructions:
        '先查询真实窗口 ID。管理操作先 prepare，再按用户授权 execute；结果不确定时 inspect，不盲目重试。',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema),
      annotations: {
        readOnlyHint: tool.readOnly,
        destructiveHint: !tool.readOnly,
        openWorldHint: true,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let result;
    try {
      result = successResult(
        await service.call(request.params.name, request.params.arguments || {}),
      );
    } catch (error) {
      result = errorResult(error);
    }
    return {
      isError: !result.ok,
      structuredContent: result,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  });
  return server;
}
