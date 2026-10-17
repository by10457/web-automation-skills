/** Shared services and coordination must behave the same for CLI and MCP callers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withWindowLocks } from '../src/runtime/window-locks.js';
import { requestSlot } from '../src/runtime/coordination.js';
import { readdir } from 'node:fs/promises';

test('nested child locks do not leak ownership to sibling calls', async () => {
  await withWindowLocks('http://127.0.0.1:56490', ['outer'], async () => {
    let entered, release;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const holder = withWindowLocks('http://127.0.0.1:56490', ['inner'], async () => {
      entered();
      await wait;
    });
    await ready;
    try {
      await assert.rejects(
        withWindowLocks('http://127.0.0.1:56490', ['inner'], async () => 'overlap'),
        { code: 'WINDOW_BUSY' },
      );
    } finally {
      release();
      await holder;
    }
  });
});

test('loopback aliases share window locks and request coordination', async () => {
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const holder = withWindowLocks('http://127.0.0.1:56491', ['one'], async () => {
    entered();
    await wait;
  });
  await ready;
  try {
    await assert.rejects(
      withWindowLocks('http://[::1]:56491', ['one'], async () => 'overlap'),
      { code: 'WINDOW_BUSY' },
    );
  } finally {
    release();
    await holder;
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'bitbrowser-alias-'));
  try {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      await requestSlot(`http://${host}:56491`, { directory, interval: 1 });
    }
    assert.equal((await readdir(directory)).filter((name) => name.endsWith('.time')).length, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('management in different workspaces respects an active connection lock', async () => {
  const api = {
    base: 'http://127.0.0.1:56482',
    list: async () => [{ id: 'one', name: 'one' }],
    running: async () => ({ one: 123 }),
    post: async () => assert.fail('busy window must not be changed'),
  };
  const plan = await core.prepareManagement({ action: 'close', ids: ['one'] }, { api });
  let entered, release;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const holder = withWindowLocks(api.base, ['one'], async () => {
    entered();
    await wait;
  });
  await ready;
  const dirs = [];
  try {
    for (let n = 0; n < 2; n++) {
      const workspace = await mkdtemp(path.join(tmpdir(), 'bitbrowser-workspace-'));
      dirs.push(workspace);
      await assert.rejects(
        core.executeManagement(plan, { workspace, api, approval: plan.digest }),
        { code: 'WINDOW_BUSY' },
      );
    }
  } finally {
    release();
    await holder;
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true })));
  }
});

test('window locks exclude another process and allow nested connection work', async () => {
  const service = 'http://127.0.0.1:56483';
  const moduleUrl = new URL('../src/runtime/window-locks.js', import.meta.url).href;
  const source = `import {withWindowLocks} from ${JSON.stringify(moduleUrl)};
    try {await withWindowLocks(${JSON.stringify(service)}, ['one'], async () => console.log('unexpected'));}
    catch (error) {console.log(error.code);}`;
  await withWindowLocks(service, ['one'], async () => {
    assert.equal(await withWindowLocks(service, ['one'], async () => 'nested'), 'nested');
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', source],
      { env: process.env },
    );
    assert.equal(stdout.trim(), 'WINDOW_BUSY');
  });
});

test('window state is explicit and an unknown ID never becomes stopped', async () => {
  assert.equal(typeof core.getWindowState, 'function');
  const api = {
    list: async () => [{ id: 'one', name: 'first' }],
    running: async () => ({ one: 123 }),
  };
  assert.equal((await core.getWindowState({ id: 'one', api })).state, 'running');
  api.running = async () => ({});
  assert.equal((await core.getWindowState({ id: 'one', api })).state, 'stopped');
  await assert.rejects(core.getWindowState({ id: 'missing', api }), { code: 'WINDOW_NOT_FOUND' });
});

test('public tab queries return JSON data without Page objects', async () => {
  assert.equal(typeof core.getTabs, 'function');
  const page = {
    url: () => 'https://example.com/',
    title: async () => 'Example',
    createCDPSession: async () => ({
      send: async () => ({ targetInfo: { targetId: 'tab-one' } }),
      detach: async () => {},
    }),
  };
  const result = await core.getTabs({
    id: 'one',
    attach: async (selector, fn) => fn({ pages: async () => [page] }),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    windowId: 'one',
    tabs: [{ targetId: 'tab-one', url: 'https://example.com/', title: 'Example' }],
  });
  assert.equal('page' in result.tabs[0], false);
});

test('independent callers cannot attach to the same busy window and release on callback failure', async () => {
  const api = {
    base: 'http://127.0.0.1:56481',
    list: async () => [{ id: 'one', name: 'one' }],
    running: async () => ({ one: 123 }),
    post: async () => ({ ws: 'ws://127.0.0.1:9222/devtools/browser/one' }),
  };
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  let disconnected = 0;
  const connect = async () => ({
    disconnect: async () => {
      disconnected++;
    },
  });
  const first = core.withBrowser(
    { id: 'one' },
    async () => {
      entered();
      await wait;
      throw Error('callback failed');
    },
    { api, connect },
  );
  await ready;
  try {
    await assert.rejects(
      core.withBrowser({ id: 'one' }, async () => 'unexpected', { api, connect }),
      { code: 'WINDOW_BUSY' },
    );
  } finally {
    release();
    await assert.rejects(first, /callback failed/);
  }
  assert.equal(
    await core.withBrowser({ id: 'one' }, async () => 'recovered', { api, connect }),
    'recovered',
  );
  assert.equal(disconnected, 2);
});
