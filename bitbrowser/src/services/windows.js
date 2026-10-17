/** JSON-facing read services used by both CLI and MCP adapters. */
import { BitAPI, resolveWindow } from '../client/bitbrowser-api.js';
import { withBrowser } from '../runtime/session.js';
import { listTabs } from './tabs.js';

/**
 * Return a snapshot of the specified window's process state.
 * Missing IDs and unavailable API calls fail explicitly; they are not 'stopped'.
 * @param {{id:string, api?:BitAPI}} options
 * @returns {Promise<{windowId:string,state:string,pid:number|null,observedAt:string}>}
 */
export async function getWindowState({ id, api = new BitAPI() }) {
  const window = resolveWindow(await api.list(), { id });
  const pids = await api.running();
  const pid = Number(pids[window.id]) || null;
  return {
    windowId: window.id,
    state: pid ? 'running' : 'stopped',
    pid,
    observedAt: new Date().toISOString(),
  };
}

/**
 * List page metadata without leaking browser objects or debugging endpoints.
 * @param {{id:string, api?:BitAPI, attach?:Function}} options
 */
export async function getTabs({ id, api = new BitAPI(), attach = withBrowser }) {
  return attach(
    { id },
    async (browser) => ({
      windowId: id,
      tabs: (await listTabs(browser)).map(({ targetId, url, title }) => ({ targetId, url, title })),
    }),
    { api },
  );
}
