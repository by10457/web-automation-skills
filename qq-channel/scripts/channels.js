/** QQ 频道：频道和版块查询。 */
import { pace, fail, unique, avatarIdentity } from "./lib/core.js";
import {
  readSnapshot,
  assertContext,
  assertNoDraft,
  clickText,
  selectors,
  ready,
} from "./lib/dom.js";
export async function inspect(page) {
  await pace();
  return ready(page);
}
export async function diagnose(page, binding) {
  await pace();
  try {
    const s = await ready(page);
    assertContext(s, binding);
    return {
      status: s.draft ? "draft-present" : "ready",
      snapshot: s,
      capabilities: {
        read: true,
        publish: s.pageType === "feed",
        interact: s.pageType === "post",
      },
    };
  } catch (e) {
    return {
      status: "blocked",
      code: e.code || "READ_FAILED",
      message: e.message,
    };
  }
}
export async function listChannels(page) {
  await pace();
  const s = await ready(page);
  return {
    channels: s.channels,
    complete: false,
    scope: "rendered-sidebar",
    identity: "name-and-avatar; route-only-if-exposed",
  };
}
export async function selectChannel(
  page,
  binding,
  target = { name: binding.expectedChannelName },
) {
  await pace();
  const s = await ready(page);
  assertContext(s, binding, { channel: false });
  assertNoDraft(s);
  const chosen = unique(
    s.channels,
    (c) =>
      (!target.name || c.name === target.name) &&
      (!target.avatar ||
        avatarIdentity(c.avatar) === avatarIdentity(target.avatar)),
    "频道",
  );
  const handles = await page.$$(selectors.channel);
  const matching = [];
  for (const e of handles)
    if (
      await e.evaluate(
        (n, c) =>
          (n.getAttribute("title") ||
            n.querySelector(".item-name")?.textContent.trim()) === c.name &&
          (n.querySelector("img")?.getAttribute("src") || null) === c.avatar,
        chosen,
      )
    )
      matching.push(e);
  if (matching.length !== 1) fail("AMBIGUOUS_CHANNEL", "频道不可唯一定位");
  await matching[0].click();
  await page.waitForFunction(
    (id) =>
      location.pathname === `/g/${id}` || location.pathname === `/g/${id}/`,
    { timeout: 15000 },
    binding.channelId,
  );
  const after = await ready(page);
  assertContext(after, binding);
  const initialization = await initializePostViews(page, binding);
  return { selected: after.channel, url: page.url(), initialization };
}
export async function initializePostViews(page, binding) {
  await pace();
  let s = await ready(page);
  assertContext(s, binding);
  assertNoDraft(s);
  if (s.pageType !== "feed") fail("FEED_REQUIRED", "类型初始化需要频道列表");
  try {
    await page.waitForFunction(
      () => document.querySelectorAll(".tab-bar__item").length > 0,
      { timeout: 15000 },
    );
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
  }
  s = await readSnapshot(page);
  assertContext(s, binding);
  assertNoDraft(s);
  if (!s.views.length)
    return {
      status: "no-views",
      views: [],
      warnings: ["页面未出现帖子类型，未执行类型初始化"],
    };
  unique(s.views, (v) => v.name === "全部", "全部类型");
  const alternate = s.views.some((v) => v.name === "热门")
    ? "热门"
    : s.views.find((v) => v.name !== "全部")?.name;
  if (alternate) await selectPostView(page, binding, alternate);
  const selected = await selectPostView(page, binding, "全部");
  const after = await readSnapshot(page);
  assertContext(after, binding);
  return {
    status: alternate ? "reset-to-all" : "selected-all",
    via: alternate || null,
    selectedView: selected.selected.name,
    views: after.views,
    warnings: ["已重新选择全部；帖子时间顺序仍以网站实际返回为准"],
  };
}
export async function listPostViews(page, binding) {
  await pace();
  const s = await ready(page);
  assertContext(s, binding);
  if (s.pageType !== "feed") fail("FEED_REQUIRED", "需要论坛列表");
  return {
    views: s.views,
    complete: false,
    scope: "rendered-tabs",
    warning: "版块异步加载，名称选择会等待目标出现",
  };
}
export async function selectPostView(page, binding, name) {
  await pace();
  const s = await ready(page);
  assertContext(s, binding);
  assertNoDraft(s);
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll(".tab-bar__item")].some(
        (e) => e.textContent.trim() === n,
      ),
    { timeout: 15000 },
    name,
  );
  unique((await readSnapshot(page)).views, (v) => v.name === name, "帖子视图");
  await clickText(page, selectors.view, name);
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll(".tab-bar__item.is-active")].some(
        (e) => e.textContent.trim() === n,
      ),
    { timeout: 10000 },
    name,
  );
  const after = await readSnapshot(page);
  assertContext(after, binding);
  const selected = unique(after.views, (v) => v.selected, "选中视图");
  if (selected.name !== name) fail("VIEW_CHANGED", "选中类型与目标不符");
  return { selected, url: after.url };
}
