/** QQ 频道：浏览器会话连接与资源释放。 */
import { storage } from "./storage.js";
import path from "node:path";
import { workspacePath, readJSON, fail, withWindowLock } from "./lib/core.js";
import { withBrowser, listTabs } from "./lib/browser.js";
import { readSnapshot, assertContext } from "./lib/dom.js";
export function validateBinding(b, { requireChannel = true } = {}) {
  if (
    !b ||
    !b.expectedAccountName ||
    (requireChannel &&
      (!b.expectedChannelName || !b.channelId || !/^[-\w]+$/.test(b.channelId)))
  )
    fail(
      "INVALID_BINDING",
      "需要 expectedAccountName；频道操作还需要 expectedChannelName、channelId",
    );
  return structuredClone(b);
}
export async function bindingFor(root, value, options) {
  return validateBinding(
    typeof value === "string"
      ? (await readJSON(storage(root, "config", "qq-channel-bindings.json")))
          .bindings?.[value]
      : value,
    options,
  );
}
export async function withQQChannel(options, fn) {
  const root = workspacePath(options.workspace),
    binding = await bindingFor(root, options.binding, {
      requireChannel: options.requireContext !== false,
    });
  if (options.page) {
    if (options.managedOnly)
      fail("MANAGED_SESSION_REQUIRED", "发送动作必须使用受锁保护的浏览器会话");
    if (options.requireContext !== false)
      assertContext(await readSnapshot(options.page), binding);
    return fn({
      page: options.page,
      binding,
      workspace: root,
      targetId: options.targetId,
    });
  }
  return withWindowLock(root, binding.browserId, () =>
    withBrowser({ id: binding.browserId }, async (browser) => {
      const tabs = (await listTabs(browser)).filter((t) => {
        try {
          return (
            new URL(t.url).origin === "https://pd.qq.com" &&
            (!options.targetId || t.targetId === options.targetId)
          );
        } catch {
          return false;
        }
      });
      if (tabs.length !== 1)
        fail(
          tabs.length ? "AMBIGUOUS_TAB" : "TAB_NOT_FOUND",
          "需要唯一 QQ 频道标签或显式 targetId",
        );
      const tab = tabs[0];
      await tab.page.bringToFront();
      if (options.requireContext !== false)
        assertContext(await readSnapshot(tab.page), binding);
      return fn({
        page: tab.page,
        binding,
        workspace: root,
        targetId: tab.targetId,
      });
    }),
  );
}
