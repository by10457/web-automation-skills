/**
 * 复用比特窗口的 CDP 连接；核对进程身份，持有窗口锁，并保证断开连接。
 */
import { loadPuppeteer } from './dependencies.js';
import { withWindowLocks } from './window-locks.js';
import { BitAPI, SkillError, resolveWindow, localURL } from '../client/bitbrowser-api.js';
export { BitAPI, SkillError, resolveWindow } from '../client/bitbrowser-api.js';
export { listTabs, selectTab } from '../services/tabs.js';

// Never launch or close a browser. /open is used only after checking its live PID.
/**
 * 连接正在运行的窗口，在回调结束或失败后断开调试连接，保留浏览器。
 * @param {{id?:string,name?:string}} selector 二选一；名称必须唯一。
 * @param {Function} callback 接收 (browser, windowInfo)，返回调用方结果。
 * @param {{api?:BitAPI,connect?:Function}} options 可注入客户端/连接函数。
 * @returns {Promise<unknown>} 回调结果，不把 Puppeteer 对象用于 MCP 输出。
 */
export async function withBrowser(selector, callback, { api = new BitAPI(), connect } = {}) {
  if (!connect) {
    const puppeteer = loadPuppeteer();
    connect = puppeteer.connect.bind(puppeteer);
  }
  const window = resolveWindow(await api.list(), selector);
  return withWindowLocks(api.base, [window.id], async () => {
    const before = await api.running();
    if (!(Number(before[window.id]) > 0))
      throw new SkillError('WINDOW_NOT_RUNNING', '窗口未运行，请先执行 start 管理操作或手动启动');
    const opened = await api.post('/browser/open', { id: window.id });
    if (!opened?.ws) throw new SkillError('NO_ENDPOINT', '接口未返回浏览器连接地址');
    localURL(opened.ws, ['ws:']);
    const after = await api.running();
    if (String(before[window.id]) !== String(after[window.id]))
      throw new SkillError('WINDOW_RESTARTED', '获取连接期间窗口进程发生变化，停止读取');
    let browser;
    try {
      browser = await connect({
        browserWSEndpoint: opened.ws,
        defaultViewport: null,
        protocolTimeout: 15000,
      });
    } catch {
      throw new SkillError('CONNECT_FAILED', '无法连接已有窗口，请检查窗口运行状态');
    }
    try {
      return await callback(browser, { ...window, pid: Number(after[window.id]) });
    } finally {
      await browser.disconnect();
    }
  });
}
