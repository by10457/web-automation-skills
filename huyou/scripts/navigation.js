/** 狐友：页面导航、加载和滚动。 */
import { pauseBeforeOperation } from "./lib/pacing.js";
import { ensureNoDraft } from "./lib/actions/dom.js";
import { fail } from "./lib/actions/schema.js";
export async function assertFeed(page) {
  if (
    new URL(page.url()).origin !== "https://hy.sns.sohu.com" ||
    new URL(page.url()).pathname !== "/" ||
    (await page.$(".feed-detail"))
  )
    fail("FEED_REQUIRED", "需位于圈子列表且关闭详情");
  await ensureNoDraft(page);
  if (!(await page.$(".feed-list"))) fail("FEED_REQUIRED", "圈子列表尚未就绪");
}
export async function backToTop(page) {
  await pauseBeforeOperation();
  await assertFeed(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  return { status: "scrolled-to-top" };
}
export async function refreshFeed(page) {
  await pauseBeforeOperation();
  await assertFeed(page);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".feed-list", { timeout: 10000 });
  return { status: "refreshed" };
}
export async function loadMore(page, { timeoutMs = 5000 } = {}) {
  await pauseBeforeOperation();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    fail("INVALID_TIMEOUT", "加载等待需为 100–10000ms");
  await assertFeed(page);
  const ids = () =>
    page.$$eval(".feed-list > [data-feed-id]", (els) =>
      els.map((e) => e.getAttribute("data-feed-id")),
    );
  const before = await ids();
  const sentinel = await page.$(".feed-list__sentinel");
  if (!sentinel) return { progress: false, stopReason: "load-control-missing" };
  await sentinel.evaluate((e) =>
    e.scrollIntoView({ block: "end", behavior: "instant" }),
  );
  const until = Date.now() + timeoutMs;
  do {
    const after = await ids();
    if (after.some((id) => !before.includes(id)))
      return {
        progress: true,
        added: after.filter((id) => !before.includes(id)).length,
      };
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < until);
  // 加载标记没有变化，不代表服务器已没有更多帖子。
  return { progress: false, stopReason: "no-progress" };
}
