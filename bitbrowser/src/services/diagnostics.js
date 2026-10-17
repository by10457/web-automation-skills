/**
 * 比特浏览器模块：src/services/diagnostics.js。普通 JavaScript ESM，无构建或压缩步骤。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ManagementAPI, getWindow } from './management.js';
import { withBrowser } from '../runtime/session.js';
import { loadPuppeteer } from '../runtime/dependencies.js';
import { SkillError } from '../client/bitbrowser-api.js';
import { readFingerprint, fingerprintProof } from './window-operations.js';

const advice = {
  DEPENDENCY_MISSING: '在 bitbrowser 目录运行 npm ci；显式依赖覆盖可使用 SKILL_PROJECT_ROOT',
  API_UNAVAILABLE: '检查比特软件、本地服务开关和端口',
  WINDOW_NOT_RUNNING: '执行 start 管理操作或手动启动',
  CONNECT_FAILED: '检查窗口状态和调试连接权限',
  RATE_LIMITED: '降低并发，稍后重新查询',
  RESOURCE_EXHAUSTED: '系统内存不足或使用率过高；释放内存后重新核对状态，不自动关闭其他窗口',
  COORDINATION_BUSY: '检查占用协调锁的进程；不要删除仍在使用的锁',
};
/** 收集环境、服务与可选连接检查；诊断不会启动停止的窗口。 */
export async function doctor({
  id,
  api = new ManagementAPI(),
  attach = withBrowser,
  load = loadPuppeteer,
  nodeVersion = process.versions.node,
} = {}) {
  const checks = [];
  const [major, minor] = nodeVersion.split('.').map(Number);
  checks.push({
    check: 'node',
    status: major > 22 || (major === 22 && minor >= 12) ? 'ok' : 'failed',
    version: nodeVersion,
    nextStep: '需要 Node.js 22.12 或更高版本',
  });
  const run = async (check, fn) => {
    try {
      checks.push({ check, status: 'ok', ...(await fn()) });
      return true;
    } catch (e) {
      checks.push({
        check,
        status: 'failed',
        code: e.code || 'CHECK_FAILED',
        nextStep: advice[e.code] || '根据错误代码检查配置；不自动更改窗口',
      });
      return false;
    }
  };
  const dependency = await run('dependency', async () => {
    load();
    return { package: 'puppeteer-core' };
  });
  const service = await run('service', async () => {
    await api.post('/health');
    return {};
  });
  if (service) {
    await run('windows', async () => ({ count: (await api.list()).length }));
    if (id && dependency)
      await run('connection', () =>
        attach({ id }, async (browser) => ({ id, tabCount: (await browser.pages()).length }), {
          api,
        }),
      );
    else if (id)
      checks.push({ check: 'connection', status: 'skipped', reason: 'dependency unavailable' });
  }
  return {
    status: checks.some((c) => c.status === 'failed') ? 'needs-attention' : 'ready',
    checks,
  };
}

/** 结合历史记录与当前状态核对操作，不将未知当作可重试。 */
export async function inspectOperation(plan, { workspace, api = new ManagementAPI() } = {}) {
  const { digest, ...body } = plan || {};
  if (
    !workspace ||
    body.kind !== 'bitbrowser-management-plan' ||
    body.version !== 1 ||
    !/^[-a-f0-9]{36}$/.test(body.id) ||
    digest !== createHash('sha256').update(JSON.stringify(body)).digest('hex')
  )
    throw new SkillError('INVALID_PLAN', '需要原始计划和 workspace');
  if ((api.base || null) !== body.service)
    throw new SkillError('SERVICE_CHANGED', '核对服务地址与计划不同');
  let record = null;
  try {
    record = JSON.parse(
      await readFile(path.join(workspace, 'bitbrowser', 'operations', body.id + '.json'), 'utf8'),
    );
    if (record.planDigest !== digest || !Array.isArray(record.items)) throw Error('mismatch');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new SkillError('RECORD_UNREADABLE', '无法核对操作记录');
  }
  const windows = await api.list(),
    pids = await api.running(),
    r = body.request;
  const items = [];
  for (const target of r.action === 'create' ? r.names : r.ids) {
    const row = record?.items.find((i) => i.target === target);
    let state = 'unknown',
      reason = '当前状态不能证明历史动作是否完成';
    const w = windows.find((w) => w.id === target);
    if (r.action === 'create') {
      const matches = windows.filter((w) => w.name === target);
      if (row?.id && matches.some((w) => w.id === row.id)) {
        state = 'desired-state';
        reason = '记录中的创建 ID 和名称匹配';
      } else if (!matches.length) {
        state = 'not-in-desired-state';
        reason = '当前没有同名窗口；不能证明此前从未创建';
      } else reason = '同名窗口不能证明是本次操作创建，请核对来源';
    } else if (r.action === 'delete') {
      state = w ? 'not-in-desired-state' : 'desired-state';
      reason = w ? '窗口仍存在' : '指定 ID 当前不存在';
    } else if (['start', 'close'].includes(r.action)) {
      state = !w
        ? 'unknown'
        : Number(pids[target]) > 0 === (r.action === 'start')
          ? 'desired-state'
          : 'not-in-desired-state';
      reason = '仅反映当前运行状态';
    } else if (r.action === 'fingerprint-random' && w && row?.fingerprintProof) {
      const actual = await readFingerprint(api, target);
      state =
        fingerprintProof(actual, row.fingerprintProof.keys).digest === row.fingerprintProof.digest
          ? 'desired-state'
          : 'not-in-desired-state';
      reason = '当前保存配置与随机接口返回摘要比较；不证明运行时或网站观察结果';
    } else if (['arrange', 'arrange-flexible'].includes(r.action)) {
      reason = '官方未提供布局回读接口；历史 API 确认不能证明当前屏幕位置';
    } else if (r.action === 'update' && w) {
      const d = await getWindow({ id: target, api });
      state = Object.entries(r.changes).every(([k, v]) => d[k] === v)
        ? 'desired-state'
        : 'not-in-desired-state';
      reason = '当前字段值与请求比较';
    }
    items.push({ target, recordedStatus: row?.status || 'not-recorded', state, reason });
  }
  return {
    planId: body.id,
    recordedStatus: record?.status || 'no-record',
    readOnly: true,
    items,
    nextStep: '核对当前状态与历史记录；不自动执行或修改原记录。unknown 不代表可以重试。',
  };
}
