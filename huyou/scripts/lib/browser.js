/** 狐友：浏览器适配器与标签选择。 */
import { pathToFileURL } from "node:url";
import path from "node:path";
export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
let configured;
export function configureBrowser(adapter) {
  if (
    typeof adapter?.withBrowser !== "function" ||
    typeof adapter?.listTabs !== "function" ||
    typeof adapter?.selectTab !== "function"
  )
    throw new SkillError(
      "INVALID_BROWSER_ADAPTER",
      "需要 withBrowser/listTabs/selectTab",
    );
  configured = adapter;
}
async function adapter() {
  if (configured) return configured;
  const source = process.env.HUYOU_BROWSER_MODULE;
  try {
    return await import(
      source
        ? pathToFileURL(path.resolve(source)).href
        : new URL(
            "../../../../bitbrowser-agent-kit/scripts/index.js",
            import.meta.url,
          ).href
    );
  } catch {
    throw new SkillError(
      "BROWSER_DEPENDENCY_MISSING",
      "配置 HUYOU_BROWSER_MODULE 为浏览器技能入口路径，或调用 configureBrowser",
    );
  }
}
export const withBrowser = async (...args) =>
  (await adapter()).withBrowser(...args);
export const listTabs = async (...args) => (await adapter()).listTabs(...args);
// 标签选择是纯函数，与传输层无关。
export function selectTab(tabs, { origin, targetId, url } = {}) {
  const found = tabs.filter((t) => {
    try {
      return (
        (!origin || new URL(t.url).origin === origin) &&
        (!targetId || t.targetId === targetId) &&
        (!url || t.url === url)
      );
    } catch {
      return false;
    }
  });
  if (found.length !== 1)
    throw new SkillError(
      found.length ? "AMBIGUOUS_TAB" : "TAB_NOT_FOUND",
      "需要唯一目标标签或显式 targetId",
    );
  return found[0];
}
