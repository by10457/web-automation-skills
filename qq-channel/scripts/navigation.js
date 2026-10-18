/** QQ 频道：页面导航、加载和滚动。 */
import { pace, fail, unique, route } from "./lib/core.js";
import { selectPostView } from "./channels.js";
import {
  ready,
  readSnapshot,
  assertNoDraft,
  assertContext,
  clickUnique,
  selectors,
} from "./lib/dom.js";
export async function returnToChannel(page, binding) {
  await pace();
  const before = await ready(page);
  assertContext(before, binding);
  assertNoDraft(before);
  if (before.pageType === "feed")
    return { status: "already-in-channel", url: before.url };
  if (before.pageType !== "post")
    fail("UNSUPPORTED_PAGE", "返回频道需要帖子详情页");
  const selector = ".game-guild-detail-title-bar a.bar-left[href]";
  const links = await page.$$(selector);
  if (links.length !== 1)
    fail("CHANNEL_LINK_AMBIGUOUS", "未找到唯一的去频道入口");
  const href = await links[0].evaluate((e) => e.href);
  const target = route(href);
  if (target.channelId !== binding.channelId || target.postId)
    fail("CHANNEL_LINK_CHANGED", "去频道入口不是绑定频道");
  await clickUnique(page, selector);
  await page.waitForFunction(
    (id) =>
      location.pathname === `/g/${id}` || location.pathname === `/g/${id}/`,
    { timeout: 15000 },
    binding.channelId,
  );
  const after = await ready(page);
  assertContext(after, binding);
  if (after.pageType !== "feed")
    fail("CHANNEL_RETURN_FAILED", "未返回频道列表");
  return { status: "returned", url: after.url, viewsInitialized: false };
}
export async function backToTop(page, binding) {
  await pace();
  const s = await ready(page);
  assertContext(s, binding);
  assertNoDraft(s);
  const css =
    s.pageType === "feed" ? selectors.feedScroll : selectors.detailScroll;
  const containers = await page.$$(css);
  if (containers.length !== 1)
    fail("SCROLL_CONTAINER_AMBIGUOUS", "滚动容器不存在或不唯一");
  const from = await containers[0].evaluate((e) => {
    const from = e.scrollTop;
    e.scrollTo({ top: 0, behavior: "instant" });
    return from;
  });
  await page.waitForFunction(
    (css) => {
      const es = document.querySelectorAll(css);
      return es.length === 1 && Math.abs(es[0].scrollTop) < 1;
    },
    { timeout: 5000 },
    css,
  );
  assertContext(await readSnapshot(page), binding);
  const to = await page.$eval(css, (e) => e.scrollTop);
  if (Math.abs(to) >= 1) fail("SCROLL_NOT_AT_TOP", "滚动位置变化，尚未到顶部");
  return { status: "at-top", container: css, from, to };
}
export async function refreshFeed(page, binding) {
  await pace();
  const s = await ready(page);
  assertContext(s, binding);
  assertNoDraft(s);
  if (s.pageType !== "feed")
    fail("FEED_REQUIRED", "帖子列表刷新需要先返回频道列表");
  const original = unique(s.views, (v) => v.selected, "当前帖子类型").name;
  const alternate =
    original === "全部"
      ? s.views.find((v) => v.name !== original)?.name
      : "全部";
  if (!alternate) fail("NO_ALTERNATE_VIEW", "没有可切换的帖子类型");
  unique(s.views, (v) => v.name === alternate, "临时帖子类型");
  try {
    await selectPostView(page, binding, alternate);
    await selectPostView(page, binding, original);
    const after = await readSnapshot(page);
    assertContext(after, binding);
    if (
      unique(after.views, (v) => v.selected, "当前帖子类型").name !== original
    )
      fail("VIEW_CHANGED", "未回到原帖子类型");
    return {
      status: "refreshed",
      method: "switch-view",
      originalView: original,
      alternateView: alternate,
      selectedView: original,
      url: after.url,
      complete: false,
      scope: "view-reselected",
      warnings: ["已重新选择原类型；不保证服务端返回全量或最新帖子"],
    };
  } catch (error) {
    error.refreshContext = { originalView: original, alternateView: alternate };
    error.message += `；刷新未完成，原类型为「${original}」，请先核对当前类型`;
    throw error;
  }
}
export async function loadMore(page, binding, { timeoutMs = 8000 } = {}) {
  await pace();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)
    fail("INVALID_TIMEOUT", "timeoutMs 必须为 100–30000");
  const before = await ready(page);
  assertContext(before, binding);
  assertNoDraft(before);
  const css =
    before.pageType === "feed" ? selectors.feedScroll : selectors.detailScroll;
  const ids =
    before.pageType === "feed"
      ? before.posts.map((p) => p.id)
      : before.detail.comments.map((c) => c.id);
  const movement = await page.$eval(css, (e) => {
    const from = e.scrollTop;
    e.scrollTop += Math.max(200, e.clientHeight * 0.8);
    return { from, to: e.scrollTop };
  });
  let progressed = false;
  try {
    await page.waitForFunction(
      ({ css, ids, detail }) => {
        const nodes = [
          ...document.querySelectorAll(
            detail
              ? ".comment-list-item"
              : 'a.game-guild-main__short-content[href*="/post/"]',
          ),
        ];
        return nodes.some(
          (e) =>
            !ids.includes(
              detail
                ? e.id
                : /\/post\/([^/?]+)/.exec(e.getAttribute("href"))?.[1],
            ),
        );
      },
      { timeout: timeoutMs },
      { css, ids, detail: before.pageType === "post" },
    );
    progressed = true;
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
  }
  const after = await readSnapshot(page);
  assertContext(after, binding);
  return {
    progress: progressed || movement.to > movement.from,
    stopReason: after.detail?.commentsEnd
      ? "end-visible"
      : progressed
        ? "new-items"
        : movement.to > movement.from
          ? "scrolled"
          : "no-progress",
    snapshot: after,
  };
}
