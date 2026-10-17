/** Official API contract regression tests. No real browser is mutated. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BitAPI } from '../src/client/bitbrowser-api.js';
import { ManagementAPI, prepareManagement, executeManagement } from '../src/services/management.js';

test('client memory refusal is a non-retried resource error rather than a quota diagnosis', async () => {
  let calls = 0;
  const api = new ManagementAPI(
    'http://127.0.0.1:54345',
    async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: false, msg: '窗口 4 启动失败，内存使用率超出 95%' }),
      };
    },
    { coordinate: false },
  );
  await assert.rejects(api.post('/browser/open', { id: 'test' }), (error) => {
    assert.equal(error.code, 'RESOURCE_EXHAUSTED');
    assert.match(error.message, /内存/);
    return true;
  });
  assert.equal(calls, 1);
});

test('creation uses browser/add exactly once and never the deprecated update route', async () => {
  const calls = [];
  let windows = [];
  const api = {
    list: async () => windows,
    running: async () => ({}),
    post: async (route, body) => {
      calls.push(route);
      windows = [{ id: 'new-window', name: body.name }];
      return { id: 'new-window' };
    },
  };
  const workspace = await mkdtemp(path.join(tmpdir(), 'bitbrowser-contract-'));
  try {
    const plan = await prepareManagement({ action: 'create', names: ['contract'] }, { api });
    const result = await executeManagement(plan, { api, workspace, approval: plan.digest });
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, ['/browser/add']);
  } finally {
    await rm(workspace, { recursive: true });
  }
});

test('management client accepts browser/add', async () => {
  const api = new ManagementAPI(
    undefined,
    async () => Response.json({ success: true, data: { id: 'one' } }),
    { coordinate: false },
  );
  assert.deepEqual(await api.post('/browser/add', { name: 'one', browserFingerPrint: {} }), {
    id: 'one',
  });
});

test('non-JSON and null envelopes produce stable schema errors', async () => {
  for (const response of [new Response('<html>failure</html>'), Response.json(null)]) {
    const api = new BitAPI(undefined, async () => response, { coordinate: false });
    await assert.rejects(api.post('/health'), { code: 'API_SCHEMA_CHANGED' });
  }
});

test('invalid window identity and PID maps are rejected rather than reporting stopped', async () => {
  for (const data of [
    { list: [{ name: 'missing-id' }] },
    { list: [{ id: 'one' }, { id: 'one' }] },
  ]) {
    const api = new BitAPI(undefined, async () => Response.json({ success: true, data }), {
      coordinate: false,
    });
    await assert.rejects(api.list(), { code: 'API_SCHEMA_CHANGED' });
  }
  const api = new BitAPI(
    undefined,
    async () => Response.json({ success: true, data: { one: 'not-a-pid' } }),
    { coordinate: false },
  );
  await assert.rejects(api.running(), { code: 'API_SCHEMA_CHANGED' });
});

test('HTTP 429 on mutations is rate limited and never retried', async () => {
  let calls = 0;
  const api = new ManagementAPI(
    undefined,
    async () => {
      calls++;
      return new Response('', { status: 429 });
    },
    { coordinate: false },
  );
  await assert.rejects(api.post('/browser/close', { id: 'one' }), { code: 'RATE_LIMITED' });
  assert.equal(calls, 1);
});

test('loopback aliases share a coordination identity', () => {
  assert.equal(
    new BitAPI('http://localhost:54345').base,
    new BitAPI('http://127.0.0.1:54345').base,
  );
});
