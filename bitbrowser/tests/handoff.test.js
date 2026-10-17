/** 交接回归：保存真实元数据再经 MCP 导出，证明字段不依赖模型重抄且导出不访问浏览器。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveTabSnapshot, exportHandoff } from '../src/services/handoff.js';
import { createAgentService } from '../src/services/agent.js';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'handoff-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const snapshot = await saveTabSnapshot(
    {
      windowId: 'real-D-id',
      tabs: [
        { targetId: 'real-target', url: 'http://localhost/account', title: 'Account: delta' },
        { targetId: 'console', url: 'https://console.example/', title: 'console' },
      ],
    },
    { stateDir },
  );
  const selection = { snapshotId: snapshot.snapshotId, url: 'http://localhost/account' };
  return { stateDir, snapshot, selection };
}

test('handoff service generates complete files from stored results without browser API calls', async (t) => {
  const { stateDir, selection } = await fixture(t);
  const api = new Proxy(
    {},
    {
      get() {
        throw Error('Browser must not be accessed');
      },
    },
  );
  const service = createAgentService({ stateDir, api });
  const result = await service.call('bitbrowser_export_handoff', {
    selections: [{ ...selection, titleEvidence: { account: 'delta', equals: 'Account: delta' } }],
  });
  const saved = JSON.parse(await readFile(result.jsonPath, 'utf8'));
  assert.equal(result.rows, undefined);
  assert.equal(result.rowCount, saved.rows.length);
  const links = [...result.finalResponse.matchAll(/\]\(<([^>]+)>\)/g)].map((match) => match[1]);
  assert.deepEqual(
    links,
    [result.markdownPath, result.jsonPath].map((file) => file.replaceAll('\\', '/')),
  );
  for (const file of links) assert((await readFile(file, 'utf8')).length > 0);
  assert(!result.finalResponse.includes('real-D-id'));
  assert.equal(saved.rows[0].windowId, 'real-D-id');
  assert.equal(saved.rows[0].targetId, 'real-target');
  assert.equal(saved.rows[0].url, selection.url);
  assert.equal(saved.rows[0].loginStatus, 'title-matched');
  const md = await readFile(result.markdownPath, 'utf8');
  for (const value of ['real-D-id', 'real-target', selection.url, 'delta', 'Account: delta'])
    assert(md.includes(value));
  await assert.rejects(
    service.call('bitbrowser_export_handoff', {
      selections: [{ ...selection, windowId: 'invented' }],
    }),
    { code: 'INVALID_ARGUMENT' },
  );
});

test('handoff keeps unknown login and rejects stale, ambiguous, duplicated and mismatched evidence', async (t) => {
  const { stateDir, selection, snapshot } = await fixture(t);
  const call = (selections, options = {}) =>
    exportHandoff({ selections }, { stateDir, ...options });
  assert.equal((await call([selection])).rows[0].loginStatus, 'unknown');
  await assert.rejects(call([selection, selection]), { code: 'DUPLICATE_WINDOW' });
  await assert.rejects(call([{ ...selection, url: 'http://localhost/missing' }]), {
    code: 'AMBIGUOUS_HANDOFF',
  });
  await assert.rejects(
    call([{ ...selection, titleEvidence: { account: 'alpha', equals: 'Account: alpha' } }]),
    { code: 'ACCOUNT_EVIDENCE_MISMATCH' },
  );
  await assert.rejects(call([selection], { now: Date.parse(snapshot.observedAt) + 1800001 }), {
    code: 'STALE_SNAPSHOT',
  });
  await assert.rejects(call([{ ...selection, snapshotId: '../escape' }]), { code: 'INVALID_PLAN' });
  const duplicated = await saveTabSnapshot(
    { windowId: 'two', tabs: [snapshot.tabs[0], snapshot.tabs[0]] },
    { stateDir },
  );
  await assert.rejects(call([{ ...selection, snapshotId: duplicated.snapshotId }]), {
    code: 'AMBIGUOUS_HANDOFF',
  });
});
