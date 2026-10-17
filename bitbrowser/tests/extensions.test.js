/**
 * 共享核心回归测试；使用模拟依赖，不修改真实浏览器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ManagementAPI,
  prepareManagement,
  executeManagement,
  operateTab,
} from '../src/services/management.js';
import { doctor, inspectOperation } from '../src/services/diagnostics.js';
import { waitForState } from '../src/runtime/coordination.js';
/** 模块内部辅助函数。 */
async function temp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bitbrowser-extension-'));
  try {
    return await fn(dir);
  } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()))
      throw Error('Unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  }
}
/** 模块内部辅助函数。 */
function fixture() {
  const w = { id: 'one', name: 'old', seq: 1, remark: 'keep', proxyPassword: 'secret' },
    calls = [];
  return {
    w,
    calls,
    base: null,
    list: async () => [{ id: w.id, name: w.name, seq: w.seq }],
    running: async () => ({ one: 123 }),
    post: async (route, body) => {
      calls.push({ route, body });
      if (route === '/browser/detail') return { ...w };
      if (route === '/browser/update/partial') Object.assign(w, body);
      return {};
    },
  };
}
test('doctor collects dependency failures but still diagnoses service; never starts', async () => {
  const api = fixture();
  const d = await doctor({
    id: 'one',
    api,
    load: () => {
      throw Object.assign(Error(), { code: 'DEPENDENCY_MISSING' });
    },
    attach: () => assert.fail('attach'),
  });
  assert.equal(d.status, 'needs-attention');
  assert(d.checks.some((c) => c.check === 'service' && c.status === 'ok'));
  assert.deepEqual(
    api.calls.map((c) => c.route),
    ['/health'],
  );
});
test('doctor supports optional attach and reports a stopped window', async () => {
  const d = await doctor({
    id: 'one',
    api: fixture(),
    load: () => {},
    attach: async () => {
      throw Object.assign(Error(), { code: 'WINDOW_NOT_RUNNING' });
    },
  });
  assert.equal(d.checks.at(-1).code, 'WINDOW_NOT_RUNNING');
});
test('startup URL has canonical meaning and conflicting aliases are rejected', async () => {
  const api = fixture();
  const p = await prepareManagement(
    { action: 'create', names: ['new'], url: 'https://example.com' },
    { api },
  );
  assert.equal(p.request.startupUrl, 'https://example.com/');
  assert(!('url' in p.request));
  await assert.rejects(
    prepareManagement(
      {
        action: 'create',
        names: ['new'],
        url: 'https://example.com',
        startupUrl: 'https://example.org',
      },
      { api },
    ),
    { code: 'INVALID_URL' },
  );
});
test('partial updates send only selected fields, preserve settings, and verify result', () =>
  temp(async (workspace) => {
    const api = fixture(),
      p = await prepareManagement(
        { action: 'update', ids: ['one'], changes: { name: 'new' } },
        { api },
      );
    const r = await executeManagement(p, { workspace, api, approval: p.digest });
    assert.equal(r.status, 'completed');
    assert.deepEqual(api.calls.find((c) => c.route === '/browser/update/partial').body, {
      ids: ['one'],
      browserFingerPrint: {},
      name: 'new',
    });
    assert.equal(api.w.remark, 'keep');
    assert.equal(api.w.proxyPassword, 'secret');
  }));
test('update rejects credential fields and changed remarks before writing', () =>
  temp(async (workspace) => {
    const api = fixture();
    await assert.rejects(
      prepareManagement({ action: 'update', ids: ['one'], changes: { password: 'x' } }, { api }),
      { code: 'INVALID_CHANGES' },
    );
    const p = await prepareManagement(
      { action: 'update', ids: ['one'], changes: { remark: '' } },
      { api },
    );
    api.w.remark = 'edited';
    await assert.rejects(executeManagement(p, { workspace, api, approval: p.digest }), {
      code: 'TARGET_CHANGED',
    });
    assert(!api.calls.some((c) => c.route === '/browser/update/partial'));
  }));
test('state polling handles delayed visibility without repeating deletion', () =>
  temp(async (workspace) => {
    const api = fixture();
    api.running = async () => ({});
    let deleted = false,
      reads = 0;
    api.post = async () => {
      deleted = true;
    };
    api.list = async () => (deleted && ++reads > 2 ? [] : [{ id: 'one', name: 'old', seq: 1 }]);
    const p = await prepareManagement({ action: 'delete', ids: ['one'] }, { api });
    assert.equal(
      (
        await executeManagement(p, {
          workspace,
          api,
          approval: p.digest,
          timeoutMs: 100,
          pollIntervalMs: 1,
        })
      ).status,
      'completed',
    );
    assert.equal(reads, 3);
    await assert.rejects(
      waitForState(async () => false, { timeoutMs: 0 }),
      { code: 'INVALID_WAIT' },
    );
    assert.equal(await waitForState(async () => false, { timeoutMs: 3, pollIntervalMs: 1 }), false);
  }));
test('inspection distinguishes current state and cannot infer creation from name alone', () =>
  temp(async (workspace) => {
    const api = fixture();
    const p = await prepareManagement({ action: 'create', names: ['new'] }, { api });
    api.w.name = 'new';
    const r = await inspectOperation(p, { workspace, api });
    assert.equal(r.items[0].state, 'unknown');
    assert.equal(api.calls.length, 0);
    await assert.rejects(inspectOperation({ ...p, digest: 'bad' }, { workspace, api }), {
      code: 'INVALID_PLAN',
    });
  }));
test('inspection reads recorded creation ID and never mutates logs', () =>
  temp(async (workspace) => {
    const api = fixture(),
      p = await prepareManagement({ action: 'start', ids: ['one'] }, { api });
    await executeManagement(p, { workspace, api, approval: p.digest });
    api.calls.length = 0;
    const r = await inspectOperation(p, { workspace, api });
    assert.equal(r.items[0].state, 'desired-state');
    assert.equal(r.items[0].recordedStatus, 'skipped-already-running');
    assert.equal(api.calls.length, 0);
  }));
test('tab operations address the exact target and reject missing targets', async () => {
  const calls = [];
  let live = true;
  const page = {
    createCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: 'tab' } }),
      detach: async () => {},
    }),
    url: () => 'https://example.com/',
    title: async () => 'Example',
    bringToFront: async () => calls.push('activate'),
    reload: async () => calls.push('reload'),
    close: async () => {
      live = false;
      calls.push('close');
    },
  };
  const b = { pages: async () => (live ? [page] : []) };
  await assert.rejects(operateTab(b, { action: 'tab-close', targetId: 'missing' }), {
    code: 'TAB_NOT_FOUND',
  });
  for (const action of ['tab-activate', 'tab-reload', 'tab-close'])
    await operateTab(b, { action, targetId: 'tab' });
  assert.deepEqual(calls, ['activate', 'reload', 'close']);
});
test('cross-process coordination spaces requests to one service', () =>
  temp(async (directory) => {
    const moduleURL = new URL('../src/runtime/coordination.js', import.meta.url).href;
    const script = `import {requestSlot} from ${JSON.stringify(moduleURL)}; await requestSlot('test-service',{directory:${JSON.stringify(directory)},interval:120}); console.log(Date.now());`;
    const child = () =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', script]);
        let out = '',
          err = '';
        p.stdout.on('data', (b) => (out += b));
        p.stderr.on('data', (b) => (err += b));
        p.on('error', reject);
        p.on('exit', (c) => (c ? reject(Error(err)) : resolve(Number(out.trim()))));
      });
    const times = (await Promise.all([child(), child(), child()])).sort();
    assert(times[1] - times[0] >= 100);
    assert(times[2] - times[1] >= 100);
  }));
