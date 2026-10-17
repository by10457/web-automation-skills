/** Phase two behavior tests use controlled APIs; never mutate real browser windows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as core from '../src/index.js';
import { withWindowLocks } from '../src/runtime/window-locks.js';

test('official new writes are allowed but never retried on rate limits', async () => {
  for (const route of ['/browser/fingerprint/random', '/windowbounds', '/windowbounds/flexable']) {
    let calls = 0;
    const api = new core.ManagementAPI(
      'http://127.0.0.1:54345',
      async () => {
        calls++;
        return { status: 429, ok: false };
      },
      { coordinate: false },
    );
    await assert.rejects(api.post(route, {}), { code: 'RATE_LIMITED' });
    assert.equal(calls, 1);
  }
});

test('display reads recover from a bounded rate limit', async () => {
  let calls = 0;
  const api = new core.ManagementAPI(
    'http://127.0.0.1:54345',
    async () => {
      calls++;
      return calls === 1
        ? { status: 429, ok: false }
        : { status: 200, ok: true, json: async () => ({ success: true, data: [] }) };
    },
    { coordinate: false },
  );
  assert.deepEqual(await core.listDisplays({ api }), []);
  assert.equal(calls, 2);
});

const layout = {
  type: 'box',
  startX: -500,
  startY: 0,
  width: 500,
  height: 200,
  col: 2,
  spaceX: 0,
  spaceY: 0,
  offsetX: 20,
  offsetY: 20,
  orderBy: 'asc',
};
const display = {
  id: 7,
  label: 'Left',
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
};

/** Supply mutable external state so tests can simulate changes between plan and execution. */
function fixture() {
  const api = {
    windows: [
      { id: 'one', name: 'One', seq: 11 },
      { id: 'two', name: 'Two', seq: 22 },
    ],
    pids: {},
    calls: [],
    displays: [display],
    fingerprint: { userAgent: 'old', canvasValue: 1 },
    list: async () => structuredClone(api.windows),
    running: async () => ({ ...api.pids }),
    post: async (route, body) => {
      api.calls.push([route, structuredClone(body)]);
      if (route === '/alldisplays') return structuredClone(api.displays);
      if (route === '/browser/detail')
        return { id: body.id, browserFingerPrint: { ...api.fingerprint } };
      if (route === '/browser/fingerprint/random') {
        const next = { userAgent: 'new', canvasValue: 2 };
        if (!api.noPersist) api.fingerprint = next;
        if (api.timeout) throw new core.SkillError('API_UNAVAILABLE', 'timeout');
        return next;
      }
      if (api.timeout) throw new core.SkillError('API_UNAVAILABLE', 'timeout');
      return undefined;
    },
  };
  return api;
}

/** Each case owns a scratch workspace; cleanup is limited to that generated directory. */
async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'bitbrowser-phase2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('display queries validate official response and strip unknown fields', async () => {
  assert.equal(typeof core.listDisplays, 'function');
  const api = fixture();
  api.displays = [{ ...display, secret: 'hidden' }];
  assert.deepEqual(await core.listDisplays({ api }), [display]);
  assert.deepEqual(api.calls, [['/alldisplays', {}]]);
  for (const invalid of [
    null,
    {},
    [{ ...display, id: '7' }],
    [display, display],
    [{ ...display, bounds: { ...display.bounds, width: -1 } }],
  ]) {
    api.displays = invalid;
    await assert.rejects(core.listDisplays({ api }), { code: 'API_SCHEMA_CHANGED' });
  }
});

test('invalid phase two requests fail before inventory or HTTP access', async () => {
  let reads = 0;
  const api = {
    list: async () => {
      reads++;
      return [];
    },
    running: async () => ({}),
  };
  for (const request of [
    { action: 'arrange', ids: [], layout },
    { action: 'arrange', ids: ['one'], layout: { ...layout, width: 499 } },
    { action: 'arrange', ids: ['one'], layout: { ...layout, col: 0 } },
    { action: 'arrange', ids: ['one'], layout: { ...layout, screenId: '7' } },
    { action: 'arrange-flexible', ids: ['one'], screenId: 7 },
    { action: 'fingerprint-random', ids: ['one'], changes: { userAgent: 'x' } },
    { action: 'fingerprint-random', ids: ['one', 'one'] },
  ])
    await assert.rejects(core.prepareManagement(request, { api }), { code: 'INVALID_REQUEST' });
  assert.equal(reads, 0);
});

test('random fingerprint prepares read-only then verifies saved configuration and prevents replay', async (t) => {
  const api = fixture(),
    dir = await workspace(t);
  const plan = await core.prepareManagement(
    { action: 'fingerprint-random', ids: ['one'] },
    { api },
  );
  assert(api.calls.every(([route]) => route === '/browser/detail'));
  assert(!JSON.stringify(plan).includes('userAgent'));
  const result = await core.executeManagement(plan, { api, workspace: dir, approval: plan.digest });
  assert.equal(result.status, 'completed');
  assert.equal(result.items[0].status, 'fingerprint-randomized');
  assert.equal(result.items[0].verification, 'configuration-readback');
  assert(!JSON.stringify(result).includes('userAgent":"new'));
  await core.executeManagement(plan, { api, workspace: dir, approval: plan.digest });
  assert.equal(api.calls.filter(([r]) => r === '/browser/fingerprint/random').length, 1);
  const inspection = await core.inspectOperation(plan, { api, workspace: dir });
  assert.equal(inspection.items[0].state, 'desired-state');
  api.fingerprint.userAgent = 'later';
  assert.equal(
    (await core.inspectOperation(plan, { api, workspace: dir })).items[0].state,
    'not-in-desired-state',
  );
});

test('random fingerprint rejects running windows and configuration drift before writing', async (t) => {
  const api = fixture(),
    dir = await workspace(t);
  api.pids.one = 123;
  await assert.rejects(
    core.prepareManagement({ action: 'fingerprint-random', ids: ['one'] }, { api }),
    { code: 'WINDOW_RUNNING' },
  );
  delete api.pids.one;
  const plan = await core.prepareManagement(
    { action: 'fingerprint-random', ids: ['one'] },
    { api },
  );
  api.fingerprint.canvasValue = 3;
  await assert.rejects(
    core.executeManagement(plan, { api, workspace: dir, approval: plan.digest }),
    { code: 'TARGET_CHANGED' },
  );
  assert(!api.calls.some(([r]) => r === '/browser/fingerprint/random'));
});

test('missing fingerprint fields cannot match a JSON-shaped missing sentinel', async (t) => {
  const api = fixture(),
    dir = await workspace(t);
  api.fingerprint = { canvasValue: 1 };
  const originalPost = api.post;
  api.post = async (route, body) => {
    if (route === '/browser/fingerprint/random') {
      api.calls.push([route, body]);
      api.fingerprint = { canvasValue: 2 };
      return { canvasValue: 2, extensionField: { missing: true } };
    }
    return originalPost(route, body);
  };
  const plan = await core.prepareManagement(
    { action: 'fingerprint-random', ids: ['one'] },
    { api },
  );
  const result = await core.executeManagement(plan, {
    api,
    workspace: dir,
    approval: plan.digest,
    timeoutMs: 20,
    pollIntervalMs: 1,
  });
  assert.equal(result.status, 'needs-attention');
  assert.equal(result.items[0].code, 'FINGERPRINT_UNVERIFIED');
  const inspection = await core.inspectOperation(plan, { api, workspace: dir });
  assert.equal(inspection.items[0].state, 'not-in-desired-state');
});

test('7.1.5 random response helper defaults do not hide successfully saved fingerprint changes', async (t) => {
  const api = fixture(),
    dir = await workspace(t);
  api.fingerprint = {
    userAgent: 'old',
    canvasValue: 1,
    firefoxVersionMap: null,
    defaultAccuracy: 10,
  };
  const originalPost = api.post;
  api.post = async (route, body) => {
    if (route === '/browser/fingerprint/random') {
      api.calls.push([route, body]);
      api.fingerprint = {
        userAgent: 'new',
        canvasValue: 2,
        firefoxVersionMap: null,
        defaultAccuracy: 10,
      };
      return {
        ...api.fingerprint,
        firefoxVersionMap: { 128: '132,131,130,129,128,127,126,125' },
        defaultAccuracy: null,
      };
    }
    return originalPost(route, body);
  };
  const plan = await core.prepareManagement(
    { action: 'fingerprint-random', ids: ['one'] },
    { api },
  );
  const result = await core.executeManagement(plan, {
    api,
    workspace: dir,
    approval: plan.digest,
    timeoutMs: 20,
    pollIntervalMs: 1,
  });
  assert.equal(result.status, 'completed');
  assert.equal(
    (await core.inspectOperation(plan, { api, workspace: dir })).items[0].state,
    'desired-state',
  );
  api.fingerprint.canvasValue = 3;
  assert.equal(
    (await core.inspectOperation(plan, { api, workspace: dir })).items[0].state,
    'not-in-desired-state',
  );
  assert.equal(api.calls.filter(([route]) => route === '/browser/fingerprint/random').length, 1);
});

for (const mode of ['noPersist', 'timeout'])
  test(`random ${mode} remains uncertain and cannot be replayed`, async (t) => {
    const api = fixture(),
      dir = await workspace(t);
    const plan = await core.prepareManagement(
      { action: 'fingerprint-random', ids: ['one', 'two'] },
      { api },
    );
    api[mode] = true;
    const options = {
      api,
      workspace: dir,
      approval: plan.digest,
      timeoutMs: 20,
      pollIntervalMs: 1,
    };
    const result = await core.executeManagement(plan, options);
    assert.equal(result.status, 'needs-attention');
    assert.equal(result.items[0].status, 'uncertain');
    await core.executeManagement(plan, options);
    assert.equal(api.calls.filter(([r]) => r === '/browser/fingerprint/random').length, 1);
  });

for (const action of ['arrange', 'arrange-flexible'])
  test(`${action} sends one explicit batch and records API-only evidence`, async (t) => {
    const api = fixture(),
      dir = await workspace(t);
    api.pids = { one: 123, two: 456 };
    const request = { action, ids: ['one', 'two'], ...(action === 'arrange' ? { layout } : {}) };
    const plan = await core.prepareManagement(request, { api });
    assert.equal(api.calls.length, 0);
    const result = await core.executeManagement(plan, {
      api,
      workspace: dir,
      approval: plan.digest,
    });
    const route = action === 'arrange' ? '/windowbounds' : '/windowbounds/flexable';
    assert.deepEqual(api.calls, [
      [route, action === 'arrange' ? { ...layout, ids: ['one', 'two'] } : { seqlist: [11, 22] }],
    ]);
    assert.equal(result.status, 'completed');
    assert.equal(result.items.length, 2);
    assert(
      result.items.every(
        (row) => row.status === 'api-acknowledged' && row.verification === 'api-acknowledged',
      ),
    );
    await core.executeManagement(plan, { api, workspace: dir, approval: plan.digest });
    assert.equal(api.calls.length, 1);
    const inspection = await core.inspectOperation(plan, { api, workspace: dir });
    assert(
      inspection.items.every(
        (row) => row.state === 'unknown' && row.recordedStatus === 'api-acknowledged',
      ),
    );
  });

test('arrangement rejects stopped targets, missing monitors and ambiguous flexible sequences', async () => {
  const api = fixture();
  await assert.rejects(
    core.prepareManagement({ action: 'arrange', ids: ['one'], layout }, { api }),
    { code: 'WINDOW_NOT_RUNNING' },
  );
  api.pids = { one: 123, two: 456 };
  await assert.rejects(
    core.prepareManagement(
      { action: 'arrange', ids: ['one'], layout: { ...layout, screenId: 99 } },
      { api },
    ),
    { code: 'DISPLAY_NOT_FOUND' },
  );
  api.windows[1].seq = 11;
  await assert.rejects(
    core.prepareManagement({ action: 'arrange-flexible', ids: ['one'] }, { api }),
    { code: 'INVALID_SEQUENCE' },
  );
  api.windows[0].seq = undefined;
  await assert.rejects(
    core.prepareManagement({ action: 'arrange-flexible', ids: ['one'] }, { api }),
    { code: 'INVALID_SEQUENCE' },
  );
});

test('layout target drift and removed screen are rejected before a batch write', async (t) => {
  const api = fixture(),
    dir = await workspace(t);
  api.pids = { one: 123, two: 456 };
  const plan = await core.prepareManagement({ action: 'arrange-flexible', ids: ['one'] }, { api });
  api.windows[0].seq = 33;
  await assert.rejects(
    core.executeManagement(plan, { api, workspace: dir, approval: plan.digest }),
    { code: 'TARGET_CHANGED' },
  );
  const screenPlan = await core.prepareManagement(
    { action: 'arrange', ids: ['one'], layout: { ...layout, screenId: 7 } },
    { api },
  );
  api.displays = [];
  await assert.rejects(
    core.executeManagement(screenPlan, { api, workspace: dir, approval: screenPlan.digest }),
    { code: 'DISPLAY_NOT_FOUND' },
  );
  assert(api.calls.every(([route]) => route === '/alldisplays'));
});

test('batch timeout marks every target uncertain and does not replay', async (t) => {
  const api = fixture(),
    dir = await workspace(t);
  api.pids = { one: 123, two: 456 };
  const plan = await core.prepareManagement(
    { action: 'arrange-flexible', ids: ['one', 'two'] },
    { api },
  );
  api.timeout = true;
  const options = { api, workspace: dir, approval: plan.digest };
  const result = await core.executeManagement(plan, options);
  assert.equal(result.status, 'needs-attention');
  assert(result.items.every((row) => row.status === 'uncertain'));
  await core.executeManagement(plan, options);
  assert.equal(api.calls.length, 1);
});

test('arrangement respects the shared window lock before HTTP mutation', async (t) => {
  const api = fixture(),
    dir = await workspace(t);
  api.base = 'http://127.0.0.1:56494';
  api.pids.one = 123;
  const plan = await core.prepareManagement({ action: 'arrange', ids: ['one'], layout }, { api });
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
  try {
    await assert.rejects(
      core.executeManagement(plan, { api, workspace: dir, approval: plan.digest }),
      { code: 'WINDOW_BUSY' },
    );
  } finally {
    release();
    await holder;
  }
  assert.equal(api.calls.length, 0);
});
