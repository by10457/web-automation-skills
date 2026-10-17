/** 从服务端标签快照生成交接文件；不接受模型提供的 windowId/targetId，不连接浏览器。 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PlanStore } from '../runtime/plan-store.js';
import { SkillError } from '../client/bitbrowser-api.js';

/** 快照与操作计划隔离存储，复用 UUID 路径校验及排他写入。 */
function snapshotStore(stateDir) {
  return new PlanStore(path.join(stateDir, 'tab-snapshots'));
}

/** 保存 getTabs 原始结果，返回短引用；调用者不能用外部路径替换快照。 */
export async function saveTabSnapshot(result, { stateDir, now = Date.now() }) {
  const snapshotId = randomUUID();
  const observedAt = new Date(now).toISOString();
  await snapshotStore(stateDir).save({ id: snapshotId, observedAt, ...result });
  return { ...result, snapshotId, observedAt };
}

/** 转义网页可控标题及账号中的 Markdown 表格字符，避免破坏交接行。 */
function cell(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;')
    .replace(/[\r\n]/g, ' ')
    .replace(/`/g, '&#96;');
}

/**
 * 从已保存快照筛选唯一 URL 并输出完整行；重复窗口、过期快照、歧义和标题不匹配直接失败。
 * titleEvidence 是调用者提供的业务约定，不是通用登录证明；没有约定时账号状态为 unknown。
 * @param {{selections:Array<{snapshotId:string,url:string,titleEvidence?:{account:string,equals:string}}>}} request
 * @param {{stateDir:string,now?:number}} options
 */
export async function exportHandoff({ selections }, { stateDir, now = Date.now() }) {
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 100)
    throw new SkillError('INVALID_ARGUMENT', '需要 1 至 100 个快照选择');
  const rows = [],
    seen = new Set();
  for (const selection of selections) {
    const snapshot = await snapshotStore(stateDir).load(selection.snapshotId);
    const age = now - Date.parse(snapshot.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000)
      throw new SkillError('STALE_SNAPSHOT', '快照超过 30 分钟或时间无效，请重新核验目标');
    if (seen.has(snapshot.windowId))
      throw new SkillError('DUPLICATE_WINDOW', '每个窗口只允许一行交接');
    seen.add(snapshot.windowId);
    const matches = snapshot.tabs.filter((tab) => tab.url === selection.url);
    if (matches.length !== 1)
      throw new SkillError('AMBIGUOUS_HANDOFF', '快照中目标 URL 必须唯一匹配');
    const tab = matches[0],
      proof = selection.titleEvidence;
    if (!snapshot.windowId || !tab.targetId || !tab.url)
      throw new SkillError('INVALID_SNAPSHOT', '快照缺少真实 ID 或 URL');
    if (proof && (!proof.account?.trim() || !proof.equals || proof.equals !== tab.title))
      throw new SkillError('ACCOUNT_EVIDENCE_MISMATCH', '账号标题证据与快照不匹配');
    rows.push({
      windowId: snapshot.windowId,
      targetId: tab.targetId,
      url: tab.url,
      account: proof?.account || 'unknown',
      loginStatus: proof ? 'title-matched' : 'unknown',
      evidence: { type: proof ? 'caller-defined-title-match' : 'unverified', title: tab.title },
      observedAt: snapshot.observedAt,
      snapshotId: snapshot.id,
    });
  }
  const handoffId = randomUUID();
  const directory = path.resolve(stateDir, 'handoffs');
  await mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, handoffId + '.json');
  const markdownPath = path.join(directory, handoffId + '.md');
  const document = {
    handoffId,
    generatedAt: new Date(now).toISOString(),
    rows,
    validity:
      '历史快照，不保证当前状态；导航、登录变化、重启或外部改动后重新核验。title-matched 仅代表调用者约定的标题匹配。',
  };
  const markdown =
    '# 浏览器任务交接\n\n' +
    document.validity +
    '\n\n' +
    '| windowId | targetId | URL | 账号 | 状态 | 标题证据 | 核验时间 |\n' +
    '| --- | --- | --- | --- | --- | --- | --- |\n' +
    rows
      .map(
        (r) =>
          '| ' +
          [r.windowId, r.targetId, r.url, r.account, r.loginStatus, r.evidence.title, r.observedAt]
            .map(cell)
            .join(' | ') +
          ' |',
      )
      .join('\n') +
    '\n';
  await writeFile(jsonPath, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  await writeFile(markdownPath, markdown, { flag: 'wx' });
  // 使用正斜线及尖括号兼容 Windows 路径和空格；最终回复可直接复用，不重复表格。
  const finalResponse = `[Markdown 交接文件](<${markdownPath.replaceAll('\\', '/')}>)\n\n[JSON 交接文件](<${jsonPath.replaceAll('\\', '/')}>)`;
  return { ...document, jsonPath, markdownPath, finalResponse };
}
