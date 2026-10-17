/** Protocol integration tests use the official SDK and real local HTTP transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveTabSnapshot } from '../src/services/handoff.js';

test('MCP exports persisted handoff with exact IDs and no HTTP request', async (t) => {
  const { client, stateDir, calls } = await fixture(t);
  const snapshot = await saveTabSnapshot(
    {
      windowId: 'original-window',
      tabs: [{ targetId: 'original-target', url: 'https://example.org/account', title: 'Account' }],
    },
    { stateDir },
  );
  const result = await client.callTool({
    name: 'bitbrowser_export_handoff',
    arguments: {
      selections: [{ snapshotId: snapshot.snapshotId, url: 'https://example.org/account' }],
    },
  });
  assert.equal(result.structuredContent.ok, true);
  const delivery = result.structuredContent.data;
  assert.equal(delivery.rows, undefined);
  assert.equal(delivery.rowCount, 1);
  const saved = JSON.parse(await readFile(delivery.jsonPath, 'utf8'));
  assert.equal(saved.rows[0].windowId, 'original-window');
  assert.equal(saved.rows[0].targetId, 'original-target');
  assert.equal(saved.rows[0].loginStatus, 'unknown');
  assert.deepEqual(calls, []);
});

/** Fake only the external BitBrowser boundary; all project and MCP code remains real. */
async function fixture(t) {
  assert(
    existsSync(new URL('../adapters/mcp/server.js', import.meta.url)),
    'MCP server must exist',
  );
  const { createMcpServer } = await import('../adapters/mcp/server.js');
  const { createAgentService } = await import('../src/services/agent.js');
  const { ManagementAPI } = await import('../src/services/management.js');
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bitbrowser-mcp-'));
  const calls = [];
  const windows = [];
  const pids = {};
  const payloads = [];
  let fingerprint = { userAgent: 'old', canvasValue: 1 };
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const args = JSON.parse(body || '{}');
    calls.push(req.url);
    payloads.push([req.url, args]);
    let data;
    if (req.url === '/browser/list') data = { list: windows };
    else if (req.url === '/browser/pids/all') data = pids;
    else if (req.url === '/alldisplays')
      data = [
        {
          id: 7,
          label: 'Screen',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        },
      ];
    else if (req.url === '/browser/detail') data = { id: args.id, browserFingerPrint: fingerprint };
    else if (req.url === '/browser/fingerprint/random') {
      fingerprint = { userAgent: 'new', canvasValue: 2 };
      data = fingerprint;
    } else if (['/windowbounds', '/windowbounds/flexable'].includes(req.url)) data = undefined;
    else if (req.url === '/browser/add') {
      windows.push({ id: 'created-one', name: args.name });
      data = { id: 'created-one' };
    } else if (req.url !== '/health') {
      res.writeHead(400);
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, data }));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  const api = new ManagementAPI(base, fetch, { coordinate: false });
  const server = createMcpServer({ service: createAgentService({ api, stateDir }) });
  const client = new Client({ name: 'phase-one-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
    await new Promise((resolve) => http.close(resolve));
    await rm(stateDir, { recursive: true });
  });
  return { client, calls, stateDir, base, windows, pids, payloads };
}

test('MCP discovers strict tools and returns structured health data', async (t) => {
  const { client } = await fixture(t);
  const tools = (await client.listTools()).tools;
  assert(
    tools.some((tool) => tool.name === 'bitbrowser_list_displays' && tool.annotations.readOnlyHint),
  );
  assert(tools.every((tool) => tool.inputSchema.additionalProperties === false));
  const result = await client.callTool({ name: 'bitbrowser_health', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.available, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('MCP rejects unknown arguments and unknown tools without HTTP calls', async (t) => {
  const { client, calls } = await fixture(t);
  for (const call of [
    { name: 'bitbrowser_health', arguments: { endpoint: 'http://example.com' } },
    { name: 'bitbrowser_execute_management', arguments: { planId: '../escape' } },
    { name: 'arbitrary_api', arguments: {} },
    {
      name: 'bitbrowser_prepare_management',
      arguments: { request: { action: 'create', count: 0 } },
    },
  ]) {
    const result = await client.callTool(call);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
  }
  assert.deepEqual(calls, []);
});

test('MCP stores plans internally and replays a completed plan without creating twice', async (t) => {
  const { client, calls } = await fixture(t);
  const prepared = await client.callTool({
    name: 'bitbrowser_prepare_management',
    arguments: { request: { action: 'create', names: ['new'] } },
  });
  const planId = prepared.structuredContent.data.planId;
  assert.equal(typeof planId, 'string');
  // 另一计划的准备不能改变先前返回对象所指向的计划；不使用全局“最近计划”。
  await client.callTool({
    name: 'bitbrowser_prepare_management',
    arguments: { request: { action: 'create', names: ['other'] } },
  });
  assert.deepEqual(prepared.structuredContent.data.executeArguments, { planId });
  const call = {
    name: 'bitbrowser_execute_management',
    arguments: prepared.structuredContent.data.executeArguments,
  };
  assert.equal((await client.callTool(call)).structuredContent.data.status, 'completed');
  assert.equal((await client.callTool(call)).structuredContent.data.replayed, true);
  assert.equal(calls.filter((route) => route === '/browser/add').length, 1);
  const inspected = await client.callTool({
    name: 'bitbrowser_inspect_operation',
    arguments: prepared.structuredContent.data.inspectArguments,
  });
  assert.equal(inspected.structuredContent.data.items[0].state, 'desired-state');
});

test('MCP rejects a stored plan whose digest no longer matches', async (t) => {
  const { client, stateDir, calls } = await fixture(t);
  const prepared = await client.callTool({
    name: 'bitbrowser_prepare_management',
    arguments: { request: { action: 'create', names: ['new'] } },
  });
  const planId = prepared.structuredContent.data.planId;
  const file = path.join(stateDir, 'plans', planId + '.json');
  const plan = JSON.parse(await readFile(file, 'utf8'));
  plan.request.names = ['changed'];
  await writeFile(file, JSON.stringify(plan));
  const result = await client.callTool({
    name: 'bitbrowser_execute_management',
    arguments: { planId },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'PLAN_CHANGED');
  assert(!calls.includes('/browser/add'));
});

test('real stdio subprocess initializes and serves tool calls without log pollution', async (t) => {
  const { base } = await fixture(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../adapters/mcp/stdio.js', import.meta.url))],
    env: { ...process.env, BITBROWSER_API_URL: base },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const result = await client.callTool({ name: 'bitbrowser_health', arguments: {} });
  assert.equal(result.structuredContent.ok, true);
});

test('MCP exposes displays and phase two plans through real official HTTP payloads', async (t) => {
  const { client, windows, pids, payloads } = await fixture(t);
  windows.push({ id: 'one', name: 'One', seq: 11 });
  const displays = await client.callTool({ name: 'bitbrowser_list_displays', arguments: {} });
  assert.equal(displays.structuredContent.data[0].id, 7);
  const layout = {
    type: 'diagonal',
    startX: 0,
    startY: 0,
    width: 500,
    height: 200,
    col: 1,
    spaceX: 0,
    spaceY: 0,
    offsetX: 20,
    offsetY: 20,
    orderBy: 'desc',
    screenId: 7,
  };
  for (const request of [
    { action: 'fingerprint-random', ids: ['one'] },
    { action: 'arrange', ids: ['one'], layout },
    { action: 'arrange-flexible', ids: ['one'] },
  ]) {
    if (request.action !== 'fingerprint-random') pids.one = 123;
    const prepared = await client.callTool({
      name: 'bitbrowser_prepare_management',
      arguments: { request },
    });
    assert.equal(prepared.isError, false);
    const result = await client.callTool({
      name: 'bitbrowser_execute_management',
      arguments: { planId: prepared.structuredContent.data.planId },
    });
    assert.equal(result.isError, false);
    assert.equal(
      result.structuredContent.data.items[0].verification,
      request.action === 'fingerprint-random' ? 'configuration-readback' : 'api-acknowledged',
    );
  }
  assert(
    payloads.some(
      ([route, body]) =>
        route === '/browser/fingerprint/random' && body.browserId === 'one' && !('id' in body),
    ),
  );
  assert.deepEqual(payloads.find(([route]) => route === '/windowbounds')[1], {
    ...layout,
    ids: ['one'],
  });
  assert.deepEqual(payloads.find(([route]) => route === '/windowbounds/flexable')[1], {
    seqlist: [11],
  });
});

test('MCP rejects unsupported layout targeting without reaching the API', async (t) => {
  const { client, calls } = await fixture(t);
  for (const request of [
    { action: 'arrange-flexible', ids: [] },
    { action: 'arrange-flexible', ids: ['one'], screenId: 7 },
    { action: 'fingerprint-random', ids: ['one'], launch: true },
  ]) {
    const result = await client.callTool({
      name: 'bitbrowser_prepare_management',
      arguments: { request },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENT');
  }
  assert.deepEqual(calls, []);
});

test('CLI displays calls the shared service and rejects unknown options', async (t) => {
  const { base, calls } = await fixture(t);
  const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));
  const options = { env: { ...process.env, BITBROWSER_API_URL: base } };
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'displays'], options);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.data[0].id, 7);
  const before = calls.length;
  await assert.rejects(
    promisify(execFile)(process.execPath, [cli, 'displays', '--all', 'true'], options),
  );
  assert.equal(calls.length, before);
});
