/**
 * 窗口管理领域服务：校验请求、准备计划、执行并持久化结果、核对后置状态。
 * CLI 与 MCP 都调用这里；执行器不通过重发写请求来“修复”超时。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BitAPI, SkillError } from '../client/bitbrowser-api.js';
import { withBrowser } from '../runtime/session.js';
import { listTabs, selectTab } from './tabs.js';
import { waitForState } from '../runtime/coordination.js';
import { withWindowLocks } from '../runtime/window-locks.js';
import { phaseTwoActions, phaseTwoRequest } from '../contracts/window-operations.js';
import {
  checkLayout,
  readFingerprint,
  fingerprintConfiguration,
  fingerprintProof,
} from './window-operations.js';
const fail = (code, message) => {
  throw new SkillError(code, message);
};
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys = (o, k) =>
  o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((x) => k.includes(x));
/** 管理客户端显式扩展可调用接口，不向 Agent 提供任意路由透传。 */
export class ManagementAPI extends BitAPI {
  constructor(...args) {
    super(...args);
    this.paths = [
      '/health',
      '/browser/list',
      '/browser/pids/all',
      '/browser/open',
      '/browser/add',
      '/browser/close',
      '/browser/delete',
      '/browser/detail',
      '/browser/update/partial',
      '/browser/fingerprint/random',
      '/windowbounds',
      '/windowbounds/flexable',
      '/alldisplays',
    ];
  }
}
/** 校验网页 URL，拒绝凭据与非 HTTP 协议。 */
function httpURL(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail('INVALID_URL', '需要完整 http/https URL');
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    fail('INVALID_URL', 'URL 不允许凭据或非网页协议');
  return u.href;
}
/** 校验非空、无重复的窗口 ID 列表。 */
function idList(ids) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 100 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(id))
  )
    fail('INVALID_IDS', '需要 1–100 个不重复的窗口 ID');
  return ids;
}
/**
 * 只读评估窗口数量与选择缺口，未知额度保持未知。
 * @param {{count:number,ids?:string[],api?:ManagementAPI}} options
 * @returns {Promise<object>} 候选、缺口、运行数量及下一步建议。
 */
export async function assessWindows({ count, ids, api = new ManagementAPI() } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 100)
    fail('INVALID_COUNT', '窗口数量需为 1–100');
  if (ids) idList(ids);
  const windows = await api.list(),
    running = await api.running();
  const selected = ids ? windows.filter((w) => ids.includes(w.id)) : windows;
  const missingIds = ids ? ids.filter((id) => !windows.some((w) => w.id === id)) : [];
  const missing = Math.max(0, count - selected.length);
  return {
    requested: count,
    total: windows.length,
    available: selected.length,
    running: selected.filter((w) => Number(running[w.id]) > 0).length,
    missing,
    missingIds,
    status: missingIds.length
      ? 'selection-missing'
      : missing
        ? 'creation-decision-required'
        : selected.length > count
          ? 'selection-required'
          : 'available',
    windows: selected.map((w) => ({ ...w, running: Number(running[w.id]) > 0 })),
    creationPermission: 'unknown',
    remainingQuota: null,
    nextStep: missing
      ? '告知现有数量与缺口，询问是否创建缺少窗口；等待用户同意后执行创建计划'
      : '按用户指定账号用途确认目标窗口，启动与网站登录分别检查',
  };
}
/**
 * 查询并返回允许暴露的详情字段，过滤凭据。
 * @param {{id:string,api?:ManagementAPI}} options
 */
export async function getWindow({ id, api = new ManagementAPI() }) {
  idList([id]);
  const d = await api.post('/browser/detail', { id });
  if (!d || d.id !== id) fail('DETAIL_CHANGED', '详情 ID 不匹配');
  return {
    id: d.id,
    name: d.name,
    seq: d.seq,
    remark: d.remark || '',
    groupId: d.groupId || null,
    platform: d.platform || null,
    proxyType: d.proxyType || null,
  };
}
/** 校验每种管理动作的参数边界。 */
function validateRequest(request) {
  if (phaseTwoActions.includes(request?.action)) {
    const parsed = phaseTwoRequest.safeParse(request);
    if (!parsed.success || new Set(parsed.data.ids).size !== parsed.data.ids.length) {
      fail('INVALID_REQUEST', '指纹或排列参数无效，请检查目标、尺寸及支持的字段');
    }
    return parsed.data;
  }
  if (
    !keys(request, [
      'action',
      'names',
      'count',
      'namePrefix',
      'startIndex',
      'groupId',
      'url',
      'startupUrl',
      'ids',
      'data',
      'changes',
      'targetId',
    ])
  )
    fail('INVALID_REQUEST', '管理请求含未知字段');
  const r = structuredClone(request);
  if (
    ![
      'create',
      'start',
      'close',
      'delete',
      'clear',
      'open-url',
      'update',
      'tab-activate',
      'tab-reload',
      'tab-close',
    ].includes(r.action)
  )
    fail('INVALID_ACTION', '不支持的窗口管理动作');
  if (r.action !== 'create' && r.startupUrl !== undefined)
    fail('INVALID_REQUEST', 'startupUrl 仅用于创建');
  if (r.action !== 'update' && r.changes !== undefined)
    fail('INVALID_REQUEST', 'changes 仅用于修改');
  if (!r.action.startsWith('tab-') && r.targetId !== undefined)
    fail('INVALID_REQUEST', 'targetId 仅用于标签操作');
  if (r.action === 'update') {
    if (!keys(r.changes, ['name', 'remark']) || !Object.keys(r.changes).length)
      fail('INVALID_CHANGES', '仅支持指定 name 或 remark');
    if (
      r.changes.name !== undefined &&
      (typeof r.changes.name !== 'string' || !r.changes.name.trim() || r.changes.name.length > 100)
    )
      fail('INVALID_NAMES', '名称需非空且最多 100 字符');
    if (
      r.changes.remark !== undefined &&
      (typeof r.changes.remark !== 'string' || r.changes.remark.length > 2000)
    )
      fail('INVALID_CHANGES', '备注需为最多 2000 字符的字符串');
    if (r.changes.name !== undefined) r.changes.name = r.changes.name.trim();
  }
  if (
    r.action.startsWith('tab-') &&
    (typeof r.targetId !== 'string' || !r.targetId.trim() || r.ids?.length !== 1)
  )
    fail('INVALID_TAB', '标签操作需要单个窗口 ID 和 targetId');
  if (r.action === 'create') {
    if (r.startupUrl !== undefined && r.url !== undefined)
      fail('INVALID_URL', 'startupUrl 与旧版 url 参数不能并用');
    if (r.startupUrl !== undefined) r.startupUrl = httpURL(r.startupUrl);
    if (r.url !== undefined) {
      r.startupUrl = httpURL(r.url);
      delete r.url;
    }
    if (['ids', 'data'].some((k) => r[k] !== undefined))
      fail('INVALID_REQUEST', '创建请求不接受 ids/data');
    if (r.names) {
      if (['count', 'namePrefix', 'startIndex'].some((k) => r[k] !== undefined))
        fail('INVALID_NAMES', 'names 不与自动命名参数并用');
    } else {
      if (
        !Number.isInteger(r.count) ||
        r.count < 1 ||
        r.count > 100 ||
        (r.namePrefix !== undefined && typeof r.namePrefix !== 'string') ||
        (r.startIndex !== undefined &&
          (!Number.isInteger(r.startIndex) || r.startIndex < 1 || r.startIndex > 1000000))
      )
        fail('INVALID_COUNT', '创建数量需为 1–100，起始编号需正整数');
      r.names = Array.from(
        { length: r.count },
        (_, i) => (r.namePrefix || '') + ((r.startIndex ?? 1) + i),
      );
      delete r.count;
      delete r.namePrefix;
      delete r.startIndex;
    }
    if (
      !Array.isArray(r.names) ||
      !r.names.length ||
      r.names.length > 100 ||
      r.names.some((n) => typeof n !== 'string' || !n.trim() || n.length > 100) ||
      new Set(r.names.map((n) => n.trim())).size !== r.names.length
    )
      fail('INVALID_NAMES', '窗口名称需非空且不重复');
    r.names = r.names.map((n) => n.trim());
    if (r.groupId !== undefined && (typeof r.groupId !== 'string' || !r.groupId.trim()))
      fail('INVALID_GROUP', 'groupId 需非空字符串');
  } else {
    idList(r.ids);
    if (['names', 'count', 'namePrefix', 'startIndex', 'groupId'].some((k) => r[k] !== undefined))
      fail('INVALID_REQUEST', '该动作不接受创建参数');
    if (r.action === 'clear' && !['cookies', 'cache', 'both'].includes(r.data))
      fail('CLEAR_SCOPE_REQUIRED', '明确选择 cookies、cache 或 both');
    if (r.action !== 'clear' && r.data !== undefined) fail('INVALID_REQUEST', '该动作不接受 data');
    if (r.action === 'open-url' && !r.url) fail('INVALID_URL', 'open-url 需要 url');
    if (r.action !== 'open-url' && r.url !== undefined)
      fail('INVALID_REQUEST', '仅 create/open-url 接受 url');
  }
  if (r.url !== undefined) r.url = httpURL(r.url);
  return r;
}
/**
 * 校验请求并生成有时效的计划；准备过程不写入窗口。
 * @param {object} request 各 action 的字段见 references/management.md。
 * @param {{api?:ManagementAPI,now?:number}} options
 * @returns {Promise<object>} 带摘要、目标快照和 15 分钟有效期的计划。
 */
export async function prepareManagement(
  request,
  { api = new ManagementAPI(), now = Date.now() } = {},
) {
  const r = validateRequest(request),
    windows = await api.list(),
    running = await api.running();
  let targets = [];
  if (r.action === 'create') {
    if (windows.some((w) => r.names.includes(w.name)))
      fail('NAME_EXISTS', '拟创建名称已存在，请选择新名称或复用现有窗口');
  } else {
    targets = r.ids.map((id) => {
      const w = windows.find((w) => w.id === id);
      if (!w) fail('WINDOW_NOT_FOUND', '所选窗口不存在');
      return { ...w, running: Number(running[id]) > 0 };
    });
    if (r.action === 'fingerprint-random') {
      if (targets.some((w) => w.running))
        fail('WINDOW_RUNNING', '随机指纹前请关闭目标窗口；不会自动关闭或重启');
      for (const target of targets) {
        target.previousFingerprintDigest = fingerprintProof(
          await readFingerprint(api, target.id),
        ).digest;
      }
    }
    if (['arrange', 'arrange-flexible'].includes(r.action))
      await checkLayout(r, windows, running, api);
    if (r.action === 'delete' && targets.some((w) => w.running))
      fail('WINDOW_RUNNING', '删除前请先关闭指定窗口');
    if (
      (['clear', 'open-url'].includes(r.action) || r.action.startsWith('tab-')) &&
      targets.some((w) => !w.running)
    )
      fail('WINDOW_NOT_RUNNING', '该操作要求目标窗口已运行；不会自动启动');
    if (r.action === 'update') {
      if (
        r.changes.name &&
        (r.ids.length !== 1 ||
          windows.some((w) => !r.ids.includes(w.id) && w.name === r.changes.name))
      )
        fail('NAME_EXISTS', '重命名仅支持单个窗口且不能与其他窗口重名');
      for (const target of targets)
        target.previous = Object.fromEntries(Object.keys(r.changes).map((k) => [k, null]));
      for (const target of targets) {
        const detail = await getWindow({ id: target.id, api });
        for (const k of Object.keys(r.changes)) target.previous[k] = detail[k];
      }
    }
  }
  const effects = {
    create: '创建独立窗口配置；随机生成一次指纹，不自动启动或登录',
    start: '启动指定窗口，可能占用套餐启动次数',
    close: '关闭指定窗口，页面及未保存输入可能丢失',
    delete: '删除指定窗口配置，可能失去该窗口数据',
    clear: '清理运行窗口的 Cookie 或 HTTP 缓存；Cookie 清理可能退出登录',
    'open-url': '在指定窗口复用相同 URL 标签，或打开新标签访问网页',
  };
  Object.assign(effects, {
    update: '只修改指定名称或备注，保留其余配置',
    'tab-activate': '激活指定标签页',
    'tab-reload': '刷新指定标签页，可能丢失未保存输入',
    'tab-close': '关闭指定标签页，可能丢失未保存输入',
    'fingerprint-random': '对已关闭窗口随机一次指纹并回读配置；不自动启动，不改变每次启动随机开关',
    arrange: '排列并调整指定运行窗口；结果仅证明 API 确认，不证明实际屏幕布局',
    'arrange-flexible': '按核对后的窗口序号自适应排列；结果仅证明 API 确认',
  });
  const body = {
    version: 1,
    kind: 'bitbrowser-management-plan',
    id: randomUUID(),
    service: api.base || null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 900000).toISOString(),
    request: r,
    targets,
    effect: effects[r.action],
    creationPermission: 'unknown',
    remainingQuota: null,
  };
  return { ...body, digest: hash(body) };
}
/** 原子替换操作记录，写入落盘后才继续后续步骤。 */
async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp',
    h = await open(temp, 'wx');
  try {
    await h.writeFile(JSON.stringify(value, null, 2));
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(temp, file);
}
/** 在执行期间占用指定锁，并在正常退出时释放。 */
async function lock(workspace, key, fn) {
  const dir = path.join(workspace, 'locks');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, key + '.lock');
  let h;
  try {
    h = await open(file, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') fail('WINDOW_BUSY', '管理操作或站点任务正在占用窗口');
    throw e;
  }
  try {
    await h.writeFile(JSON.stringify({ pid: process.pid }));
    return await fn();
  } finally {
    await h.close();
    await unlink(file);
  }
}
/** 按稳定顺序取得多窗口锁，避免交叉锁定。 */
async function locks(workspace, ids, fn) {
  if (!ids.length) return fn();
  return lock(workspace, ids[0], () => locks(workspace, ids.slice(1), fn));
}
/** 通过临时页面发送指定的 Cookie/缓存清理命令，并释放临时资源。 */
export async function clearRunningData(browser, data) {
  if (!['cookies', 'cache', 'both'].includes(data))
    fail('CLEAR_SCOPE_REQUIRED', '必须明确清理范围');
  // A temporary blank page provides a Network session in the default profile.
  const page = await browser.newPage();
  let session;
  try {
    session = await page.createCDPSession();
    if (data === 'cookies' || data === 'both') await session.send('Network.clearBrowserCookies');
    if (data === 'cache' || data === 'both') await session.send('Network.clearBrowserCache');
    return { status: 'acknowledged', scope: data, verification: 'protocol-acknowledgement' };
  } finally {
    if (session) await session.detach();
    await page.close();
  }
}
/** 复用唯一的同 URL 标签，否则新建页面并等待导航。 */
export async function visitURL(browser, url) {
  const pages = await browser.pages(),
    matches = pages.filter((p) => p.url() === url);
  if (matches.length > 1) fail('AMBIGUOUS_TAB', '相同 URL 存在多个标签页');
  if (matches.length) return { status: 'skipped-existing-tab', url };
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { status: 'visited', url: page.url() };
}
/** 只操作明确 targetId 指定的标签，关闭后核对结果。 */
export async function operateTab(browser, { action, targetId }, { timeoutMs = 15000 } = {}) {
  const tab = selectTab(await listTabs(browser), { targetId });
  if (action === 'tab-activate') {
    await tab.page.bringToFront();
    return { status: 'activated', targetId };
  }
  if (action === 'tab-reload') {
    await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { status: 'reloaded', targetId, url: tab.page.url() };
  }
  if (action === 'tab-close') {
    await tab.page.close();
    if ((await listTabs(browser)).some((t) => t.targetId === targetId))
      fail('TAB_CLOSE_UNVERIFIED', '标签页仍然存在');
    return { status: 'closed', targetId };
  }
  fail('INVALID_ACTION', '不支持的标签动作');
}
/**
 * 执行已确认计划，持久化每一步并验证结果；不确定写入不重放。
 * @param {object} plan prepareManagement 返回的原计划。
 * @param {object} options workspace 必填；approval 是完整性摘要，不是授权凭据。
 * @returns {Promise<object>} completed/partial/needs-attention 与逐项操作记录。
 */
export async function executeManagement(
  plan,
  {
    workspace,
    approval,
    api = new ManagementAPI(),
    attach = withBrowser,
    now = Date.now(),
    timeoutMs = 15000,
    pollIntervalMs = 300,
  } = {},
) {
  if (!workspace) fail('WORKSPACE_REQUIRED', '管理执行需要显式 workspace');
  if (plan?.kind !== 'bitbrowser-management-plan' || plan.version !== 1)
    fail('INVALID_PLAN', '需要窗口管理计划');
  const { digest, ...body } = plan;
  if (digest !== hash(body) || !/^[-a-f0-9]{36}$/.test(plan.id))
    fail('PLAN_CHANGED', '计划内容被修改');
  validateRequest(plan.request);
  if (approval !== digest) fail('APPROVAL_REQUIRED', '用户确认具体计划后才可传入对应 digest');
  if ((api.base || null) !== plan.service) fail('SERVICE_CHANGED', '本地服务地址与计划不一致');
  if (!Number.isFinite(Date.parse(plan.expiresAt)) || now > Date.parse(plan.expiresAt))
    fail('PLAN_EXPIRED', '计划过期，重新检查窗口');
  await waitForState(async () => true, { timeoutMs, pollIntervalMs });
  const r = validateRequest(plan.request),
    file = path.join(workspace, 'bitbrowser', 'operations', plan.id + '.json');
  const verify = (check) => waitForState(check, { timeoutMs, pollIntervalMs });
  return lock(workspace, 'management-' + plan.id, () =>
    withWindowLocks(
      api.base,
      r.action === 'create' ? ['management-create'] : [...r.ids].sort(),
      async () => {
        try {
          const prior = JSON.parse(await readFile(file, 'utf8'));
          if (prior.planDigest !== digest) fail('RECORD_MISMATCH', '操作记录与计划不匹配');
          return {
            ...prior,
            status: prior.status === 'running' ? 'needs-attention' : prior.status,
            replayed: true,
          };
        } catch (e) {
          if (e.code !== 'ENOENT') fail('RECORD_UNREADABLE', '操作记录损坏或不匹配，禁止重跑');
        }
        // Check the whole target set again before the first mutation.
        const current = await prepareManagement(r, { api });
        if (
          r.action !== 'create' &&
          hash(current.targets.map(({ running, ...w }) => w)) !==
            hash(plan.targets.map(({ running, ...w }) => w))
        )
          fail('TARGET_CHANGED', '窗口身份或名称已变化');
        const state = {
          planId: plan.id,
          planDigest: digest,
          action: r.action,
          status: 'running',
          items: [],
        };
        await save(file, state);
        if (['arrange', 'arrange-flexible'].includes(r.action)) {
          // One official batch call for the whole plan. Persist all pending targets first.
          state.items = r.ids.map((target) => ({ target, status: 'pending' }));
          await save(file, state);
          try {
            const windows = await api.list();
            const payload = await checkLayout(r, windows, await api.running(), api);
            if (
              r.ids.some((id) => {
                const before = plan.targets.find((w) => w.id === id);
                const after = windows.find((w) => w.id === id);
                return before.seq !== after.seq || before.name !== after.name;
              })
            )
              fail('TARGET_CHANGED', '排列前目标身份或序号变化');
            await api.post(
              r.action === 'arrange' ? '/windowbounds' : '/windowbounds/flexable',
              payload,
            );
            for (const row of state.items) {
              row.status = 'api-acknowledged';
              row.verification = 'api-acknowledged';
            }
            state.status = 'completed';
          } catch (error) {
            for (const row of state.items) {
              row.status = 'uncertain';
              row.code = error instanceof SkillError ? error.code : 'OPERATION_FAILED';
            }
            state.status = 'needs-attention';
          }
          await save(file, state);
          return { ...state, recordFile: file };
        }
        for (const target of r.action === 'create' ? r.names : r.ids) {
          const row = { target, status: 'pending' };
          state.items.push(row);
          await save(file, state);
          try {
            const running = await api.running();
            if (r.action === 'create') {
              if ((await api.list()).some((w) => w.name === target))
                fail('NAME_EXISTS', '名称已被其他操作创建');
              const data = await api.post('/browser/add', {
                name: target,
                platform: r.startupUrl || '',
                platformIcon: r.startupUrl ? new URL(r.startupUrl).hostname : '',
                url: '',
                remark: '',
                userName: '',
                password: '',
                proxyMethod: 2,
                proxyType: 'noproxy',
                browserFingerPrint: {},
                randomFingerprint: false,
                ...(r.groupId ? { groupId: r.groupId } : {}),
              });
              row.id = data?.id;
              await save(file, state);
              if (
                !row.id ||
                !(await verify(
                  async () =>
                    (await api.list()).filter((w) => w.id === row.id && w.name === target)
                      .length === 1,
                ))
              )
                fail('CREATE_UNVERIFIED', '未取得唯一创建结果，不重试');
              row.status = 'created';
            } else if (r.action === 'start' || r.action === 'close') {
              const desired = r.action === 'start',
                isRunning = Number(running[target]) > 0;
              if (desired === isRunning)
                row.status = 'skipped-already-' + (desired ? 'running' : 'closed');
              else {
                await api.post(desired ? '/browser/open' : '/browser/close', { id: target });
                if (
                  !(await verify(async () => Number((await api.running())[target]) > 0 === desired))
                )
                  fail('STATE_UNVERIFIED', '未确认窗口运行状态');
                row.status = desired ? 'started' : 'closed';
              }
            } else if (r.action === 'delete') {
              if (Number(running[target]) > 0) fail('WINDOW_RUNNING', '窗口重新启动，拒绝删除');
              await api.post('/browser/delete', { id: target });
              if (!(await verify(async () => !(await api.list()).some((w) => w.id === target))))
                fail('DELETE_UNVERIFIED', '删除后窗口仍可见');
              row.status = 'deleted';
            } else if (r.action === 'fingerprint-random') {
              if (Number(running[target]) > 0)
                fail('WINDOW_RUNNING', '目标窗口已启动，拒绝随机指纹');
              const before = fingerprintProof(await readFingerprint(api, target)).digest;
              if (before !== plan.targets.find((w) => w.id === target).previousFingerprintDigest) {
                fail('TARGET_CHANGED', '随机前指纹配置已经变化');
              }
              const generated = fingerprintConfiguration(
                await api.post('/browser/fingerprint/random', { browserId: target }),
              );
              row.fingerprintProof = fingerprintProof(generated);
              await save(file, state);
              if (
                !(await verify(async () => {
                  const actual = await readFingerprint(api, target);
                  return (
                    fingerprintProof(actual, row.fingerprintProof.keys).digest ===
                    row.fingerprintProof.digest
                  );
                }))
              )
                fail('FINGERPRINT_UNVERIFIED', '随机接口已返回，但未确认指纹配置已保存；不重试');
              row.status = 'fingerprint-randomized';
              row.verification = 'configuration-readback';
            } else if (r.action === 'update') {
              const before = await getWindow({ id: target, api }),
                expected = plan.targets.find((w) => w.id === target).previous;
              if (Object.keys(r.changes).some((k) => before[k] !== expected[k]))
                fail('TARGET_CHANGED', '拟修改字段已经变化');
              await api.post('/browser/update/partial', {
                ids: [target],
                browserFingerPrint: {},
                ...r.changes,
              });
              if (
                !(await verify(async () => {
                  const d = await getWindow({ id: target, api });
                  return Object.entries(r.changes).every(([k, v]) => d[k] === v);
                }))
              )
                fail('UPDATE_UNVERIFIED', '未确认字段修改结果');
              row.status = 'updated';
            } else if (r.action.startsWith('tab-')) {
              row.result = await attach({ id: target }, (b) => operateTab(b, r, { timeoutMs }), {
                api,
              });
              row.status = row.result.status;
            } else {
              row.result = await attach(
                { id: target },
                (browser) =>
                  r.action === 'clear'
                    ? clearRunningData(browser, r.data)
                    : visitURL(browser, r.url),
                { api },
              );
              row.status = row.result.status;
            }
          } catch (e) {
            row.status = [
              'PERMISSION_DENIED',
              'QUOTA_EXCEEDED',
              'RESOURCE_EXHAUSTED',
              'API_REJECTED',
              'NAME_EXISTS',
              'WINDOW_RUNNING',
            ].includes(e.code)
              ? 'rejected'
              : 'uncertain';
            row.code = e.code || 'OPERATION_FAILED';
            state.status = state.items.length > 1 ? 'partial' : 'needs-attention';
            await save(file, state);
            return { ...state, recordFile: file };
          }
          await save(file, state);
        }
        state.status = 'completed';
        await save(file, state);
        return { ...state, recordFile: file };
      },
    ),
  );
}
