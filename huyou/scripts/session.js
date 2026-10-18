/** 狐友：浏览器会话连接与资源释放。 */
import { withBrowser, listTabs, selectTab } from "./lib/browser.js";
import { bindingFor, withLock } from "./lib/runner.js";
import { readSnapshot, assertContext } from "./lib/snapshot.js";
import { workspacePath } from "./config.js";
/** 连接已有窗口并选择明确标签，在窗口锁内调用业务函数；结束后释放连接，保留浏览器窗口。 */
export async function withHuyou(
  { workspace, binding, targetId, page, requireContext = true },
  callback,
) {
  if (page) {
    if (!binding || typeof binding !== "object")
      throw Object.assign(Error("传入 page 时需要绑定对象"), {
        code: "BINDING_REQUIRED",
      });
    if (requireContext) assertContext(await readSnapshot(page), binding);
    return callback({
      page,
      binding,
      workspace,
      targetId,
      ownership: "caller-managed",
    });
  }
  workspace = workspacePath(workspace);
  const expected = await bindingFor(workspace, binding);
  return withLock(workspace, expected.browserId, () =>
    withBrowser({ id: expected.browserId }, async (browser) => {
      const tab = selectTab(await listTabs(browser), {
        origin: "https://hy.sns.sohu.com",
        targetId,
      });
      await tab.page.bringToFront();
      if (requireContext) assertContext(await readSnapshot(tab.page), expected);
      return callback({
        page: tab.page,
        binding: expected,
        workspace,
        targetId: tab.targetId,
      });
    }),
  );
}
