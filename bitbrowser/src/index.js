/**
 * 比特浏览器模块：src/index.js。普通 JavaScript ESM，无构建或压缩步骤。
 */
export {
  withBrowser,
  BitAPI,
  SkillError,
  resolveWindow,
  listTabs,
  selectTab,
} from './runtime/session.js';
export {
  ManagementAPI,
  assessWindows,
  getWindow,
  prepareManagement,
  executeManagement,
} from './services/management.js';
export { doctor, inspectOperation } from './services/diagnostics.js';
export { getWindowState, getTabs } from './services/windows.js';
export { listDisplays } from './services/window-operations.js';
export { saveTabSnapshot, exportHandoff } from './services/handoff.js';
import { BitAPI } from './client/bitbrowser-api.js';
/** 返回脱敏窗口清单及当前进程运行状态。 */
export async function listWindows({ api = new BitAPI() } = {}) {
  const windows = await api.list(),
    running = await api.running();
  return windows.map((w) => ({ ...w, running: Number(running[w.id]) > 0 }));
}
/** 检查本地 API 可达性，不推断安装状态或网站登录状态。 */
export async function health({ api = new BitAPI() } = {}) {
  await api.post('/health');
  return { available: true };
}
