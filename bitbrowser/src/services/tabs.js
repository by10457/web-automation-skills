/**
 * 比特浏览器模块：src/services/tabs.js。普通 JavaScript ESM，无构建或压缩步骤。
 */
import { SkillError } from '../client/bitbrowser-api.js';

/** 读取真实标签 targetId；内部结果包含 Page，仅供同进程调用。 */
export async function listTabs(browser) {
  const result = [];
  for (const page of await browser.pages()) {
    const session = await page.createCDPSession();
    let targetId;
    try {
      targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId;
    } finally {
      await session.detach();
    }
    result.push({ page, targetId, url: page.url(), title: await page.title() });
  }
  return result;
}

/** 要求筛选结果唯一，避免误选标签页。 */
export function selectTab(tabs, { origin, targetId, url } = {}) {
  const matches = tabs.filter((tab) => {
    let current;
    try {
      current = new URL(tab.url);
    } catch {
      return false;
    }
    return (
      (!origin || current.origin === origin) &&
      (!targetId || tab.targetId === targetId) &&
      (!url || tab.url === url)
    );
  });
  if (matches.length !== 1)
    throw new SkillError(
      matches.length ? 'AMBIGUOUS_TAB' : 'TAB_NOT_FOUND',
      '请保留唯一目标标签页，或用 --target 指定本次标签页 ID',
    );
  return matches[0];
}
