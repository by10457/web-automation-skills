/**
 * 共享核心回归测试；使用模拟依赖，不修改真实浏览器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assessWindows,
  prepareManagement,
  executeManagement,
  clearRunningData,
  getWindow,
  visitURL,
  ManagementAPI,
} from '../src/services/management.js';
/** 模块内部辅助函数。 */
function fixture() {
  const windows = [{ id: 'one', name: 'existing', seq: 1 }],
    pids = {};
  let calls = [];
  return {
    windows,
    pids,
    calls,
    list: async () => structuredClone(windows),
    running: async () => ({ ...pids }),
    post: async (route, body) => {
      calls.push([route, body]);
      if (route === '/browser/add') {
        const id = 'new' + windows.length;
        windows.push({ id, name: body.name });
        return { id };
      }
      if (route === '/browser/open') pids[body.id] = 123;
      if (route === '/browser/close') delete pids[body.id];
      if (route === '/browser/delete')
        windows.splice(
          windows.findIndex((w) => w.id === body.id),
          1,
        );
      return {};
    },
  };
}
/** 模块内部辅助函数。 */
async function temp(fn) {
  const d = await mkdtemp(path.join(os.tmpdir(), 'bitbrowser-management-'));
  try {
    await fn(d);
  } finally {
    if (path.dirname(path.resolve(d)) !== path.resolve(os.tmpdir())) throw Error('Unsafe cleanup');
    await rm(d, { recursive: true, force: true });
  }
}
test('assess reports shortage and unknown permission without mutation', async () => {
  const api = fixture();
  const r = await assessWindows({ count: 3, api });
  assert.equal(r.missing, 2);
  assert.equal(r.status, 'creation-decision-required');
  assert.equal(r.remainingQuota, null);
  assert.equal(api.calls.length, 0);
});
test('creation requires approved digest, creates random fingerprints and is not replayed', () =>
  temp(async (workspace) => {
    const api = fixture(),
      plan = await prepareManagement({ action: 'create', count: 3 }, { api });
    await assert.rejects(executeManagement(plan, { workspace, api }), {
      code: 'APPROVAL_REQUIRED',
    });
    assert.equal(api.calls.length, 0);
    const r = await executeManagement(plan, { workspace, api, approval: plan.digest });
    assert.equal(r.status, 'completed');
    assert.deepEqual(
      api.calls.map((c) => c[1].name),
      ['1', '2', '3'],
    );
    for (const [, body] of api.calls) {
      assert.deepEqual(body.browserFingerPrint, {});
      assert.equal(body.randomFingerprint, false);
      assert(!('id' in body));
    }
    await executeManagement(plan, { workspace, api, approval: plan.digest });
    assert.equal(api.calls.length, 3);
  }));
test('changed target and running deletion stop before mutation', () =>
  temp(async (workspace) => {
    const api = fixture(),
      p = await prepareManagement({ action: 'delete', ids: ['one'] }, { api });
    api.pids.one = 3;
    await assert.rejects(executeManagement(p, { workspace, api, approval: p.digest }), {
      code: 'WINDOW_RUNNING',
    });
    delete api.pids.one;
    api.windows[0].name = 'changed';
    await assert.rejects(executeManagement(p, { workspace, api, approval: p.digest }), {
      code: 'TARGET_CHANGED',
    });
    assert.equal(api.calls.length, 0);
  }));
test('create timeout stops remaining work and replay cannot create duplicates', () =>
  temp(async (workspace) => {
    const api = fixture();
    api.post = async () => {
      api.calls.push('attempt');
      throw Error('timeout');
    };
    const p = await prepareManagement({ action: 'create', count: 3 }, { api });
    let r = await executeManagement(p, { workspace, api, approval: p.digest });
    assert.equal(r.items[0].status, 'uncertain');
    r = await executeManagement(p, { workspace, api, approval: p.digest });
    assert.equal(r.replayed, true);
    assert.equal(api.calls.length, 1);
  }));
test('partial quota rejection preserves created IDs and stops', () =>
  temp(async (workspace) => {
    const api = fixture(),
      post = api.post;
    let n = 0;
    api.post = async (...args) => {
      if (++n === 2) throw Object.assign(Error('quota'), { code: 'QUOTA_EXCEEDED' });
      return post(...args);
    };
    const p = await prepareManagement({ action: 'create', count: 3 }, { api });
    const r = await executeManagement(p, { workspace, api, approval: p.digest });
    assert.equal(r.status, 'partial');
    assert(r.items[0].id);
    assert.equal(r.items[1].code, 'QUOTA_EXCEEDED');
    assert.equal(n, 2);
  }));
test('start close delete lifecycle verifies states', () =>
  temp(async (workspace) => {
    const api = fixture();
    for (const action of ['start', 'close', 'delete']) {
      const p = await prepareManagement({ action, ids: ['one'] }, { api });
      assert.equal(
        (await executeManagement(p, { workspace, api, approval: p.digest })).status,
        'completed',
      );
    }
    assert.equal(api.windows.length, 0);
  }));
test('cookie cleanup only invokes requested protocol method and closes temporary page', async () => {
  const calls = [];
  const browser = {
    newPage: async () => ({
      createCDPSession: async () => ({
        send: async (name) => calls.push(name),
        detach: async () => calls.push('detach'),
      }),
      close: async () => calls.push('close-page'),
    }),
  };
  await clearRunningData(browser, 'cookies');
  assert.deepEqual(calls, ['Network.clearBrowserCookies', 'detach', 'close-page']);
  await assert.rejects(clearRunningData(browser, 'all'), { code: 'CLEAR_SCOPE_REQUIRED' });
});
test('details redact credentials and cookies', async () => {
  const d = await getWindow({
    id: 'one',
    api: {
      post: async () => ({
        id: 'one',
        name: 'x',
        password: 'secret',
        cookie: 'secret',
        proxyPassword: 'secret',
      }),
    },
  });
  assert(!JSON.stringify(d).includes('secret'));
});
test('invalid create fields and URL are rejected before API calls', async () => {
  const api = fixture();
  await assert.rejects(prepareManagement({ action: 'create', names: ['x', 'x'] }, { api }), {
    code: 'INVALID_NAMES',
  });
  await assert.rejects(
    prepareManagement({ action: 'create', count: 1, url: 'javascript:alert(1)' }, { api }),
    { code: 'INVALID_URL' },
  );
  await assert.rejects(prepareManagement({ action: 'create', count: 1, id: 'one' }, { api }), {
    code: 'INVALID_REQUEST',
  });
});
test('service changes and expired plans do not mutate windows', () =>
  temp(async (workspace) => {
    const api = fixture(),
      p = await prepareManagement({ action: 'start', ids: ['one'] }, { api });
    api.base = 'http://127.0.0.1:54346';
    await assert.rejects(executeManagement(p, { workspace, api, approval: p.digest }), {
      code: 'SERVICE_CHANGED',
    });
    delete api.base;
    await assert.rejects(
      executeManagement(p, { workspace, api, approval: p.digest, now: Date.now() + 1000000 }),
      { code: 'PLAN_EXPIRED' },
    );
    assert.equal(api.calls.length, 0);
  }));
test('navigation reuses exact URL and rejects ambiguous tabs', async () => {
  let opened = 0;
  const page = { url: () => 'https://example.com/' };
  const browser = {
    pages: async () => [page],
    newPage: async () => {
      opened++;
    },
  };
  assert.equal((await visitURL(browser, 'https://example.com/')).status, 'skipped-existing-tab');
  browser.pages = async () => [page, page];
  await assert.rejects(visitURL(browser, 'https://example.com/'), { code: 'AMBIGUOUS_TAB' });
  assert.equal(opened, 0);
});
test('API rejection exposes category without server payload', async () => {
  const api = new ManagementAPI(undefined, async () => ({
    ok: true,
    json: async () => ({ success: false, msg: '没有权限 secret-token' }),
  }));
  await assert.rejects(
    api.post('/browser/add', {}),
    (e) => e.code === 'PERMISSION_DENIED' && !e.message.includes('secret-token'),
  );
});
test('rate-limited reads retry but writes are never replayed', async () => {
  let reads = 0;
  const api = new ManagementAPI(undefined, async () => ({
    ok: true,
    json: async () =>
      ++reads === 1
        ? { success: false, msg: '请求频繁，请调整请求频率' }
        : { success: true, data: { list: [] } },
  }));
  assert.deepEqual(await api.list(), []);
  assert.equal(reads, 2);
  let writes = 0;
  const writer = new ManagementAPI(undefined, async () => {
    writes++;
    return { ok: true, json: async () => ({ success: false, msg: '请求频繁，请调整请求频率' }) };
  });
  await assert.rejects(writer.post('/browser/add', { name: 'x' }), { code: 'RATE_LIMITED' });
  assert.equal(writes, 1);
});
test('persistent read rate limits stop after bounded retries', async () => {
  let calls = 0;
  const api = new ManagementAPI(undefined, async () => {
    calls++;
    return { ok: true, json: async () => ({ success: false, msg: '请求频繁，请调整请求频率' }) };
  });
  await assert.rejects(api.list(), { code: 'RATE_LIMITED' });
  assert.equal(calls, 4);
});
