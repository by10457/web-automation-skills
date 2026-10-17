/**
 * 共享核心回归测试；使用模拟依赖，不修改真实浏览器。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BitAPI, resolveWindow, withBrowser, selectTab } from '../src/runtime/session.js';
import { localURL } from '../src/client/bitbrowser-api.js';
import { parseArgs } from '../adapters/cli/helpers.js';

const windows = [{ id: 'abc', name: '001', seq: 1 }];
/** 模块内部辅助函数。 */
function fixture(pid = 123) {
  const calls = [];
  let disconnected = false;
  const api = {
    list: async () => windows,
    running: async () => ({ abc: pid }),
    post: async (...args) => {
      calls.push(args);
      return { ws: 'ws://127.0.0.1:9222/devtools/browser/test' };
    },
  };
  return {
    api,
    calls,
    disconnected: () => disconnected,
    connect: async () => ({
      disconnect: async () => {
        disconnected = true;
      },
    }),
  };
}
test('names must be unique; IDs remain separate from names', () => {
  assert.equal(resolveWindow(windows, { name: '001' }).id, 'abc');
  assert.throws(() => resolveWindow(windows, { id: '001' }), { code: 'WINDOW_NOT_FOUND' });
  assert.throws(() => resolveWindow([...windows, { id: 'def', name: '001' }], { name: '001' }), {
    code: 'AMBIGUOUS_WINDOW',
  });
});
test('stopped windows never call open', async () => {
  const f = fixture(0);
  await assert.rejects(
    withBrowser({ id: 'abc' }, () => {}, f),
    { code: 'WINDOW_NOT_RUNNING' },
  );
  assert.equal(f.calls.length, 0);
});
test('disconnect happens on callback failure, no close or launch', async () => {
  const f = fixture();
  await assert.rejects(
    withBrowser(
      { id: 'abc' },
      () => {
        throw new Error('test');
      },
      f,
    ),
    /test/,
  );
  assert.equal(f.disconnected(), true);
  assert.deepEqual(f.calls, [['/browser/open', { id: 'abc' }]]);
});
test('PID change stops before connection', async () => {
  const f = fixture();
  let n = 0,
    connected = false;
  f.api.running = async () => ({ abc: ++n });
  f.connect = async () => {
    connected = true;
  };
  await assert.rejects(
    withBrowser({ id: 'abc' }, () => {}, f),
    { code: 'WINDOW_RESTARTED' },
  );
  assert.equal(connected, false);
});
test('tab ambiguity fails instead of choosing first', () => {
  const tabs = [
    { targetId: 'a', url: 'https://hy.sns.sohu.com/' },
    { targetId: 'b', url: 'https://hy.sns.sohu.com/' },
  ];
  assert.throws(() => selectTab(tabs, { origin: 'https://hy.sns.sohu.com' }), {
    code: 'AMBIGUOUS_TAB',
  });
  assert.equal(selectTab(tabs, { origin: 'https://hy.sns.sohu.com', targetId: 'b' }).targetId, 'b');
  assert.throws(
    () =>
      selectTab([{ url: 'https://hy.sns.sohu.com.evil.test/' }], {
        origin: 'https://hy.sns.sohu.com',
      }),
    { code: 'TAB_NOT_FOUND' },
  );
});
test('window inventory redacts credentials returned by server', async () => {
  const api = new BitAPI(undefined, async () => ({
    ok: true,
    json: async () => ({
      success: true,
      data: { list: [{ ...windows[0], password: 'secret', cookie: 'secret' }] },
    }),
  }));
  assert.deepEqual(await api.list(), windows);
});
test('API mutation allowlist and local endpoints', async () => {
  assert.throws(() => localURL('http://example.com:54345'), { code: 'NON_LOCAL_ENDPOINT' });
  assert.throws(() => localURL('http://u:p@127.0.0.1'), { code: 'NON_LOCAL_ENDPOINT' });
  await assert.rejects(new BitAPI().post('/browser/delete'), { code: 'UNSUPPORTED_API' });
});
test('CLI rejects duplicate and unknown arguments', () => {
  assert.throws(() => parseArgs(['--id', 'a', '--id', 'b'], ['id']), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseArgs(['--execute', 'yes'], ['id']), { code: 'INVALID_ARGUMENT' });
});
