/** 狐友：用户主页读取与标签生命周期管理。 */
import { pauseBeforeOperation } from "./lib/pacing.js";
import {
  checkAccount,
  ensureNoDraft,
  openDetail,
  readDetail,
  uniqueClick,
} from "./lib/actions/dom.js";
import { fail } from "./lib/actions/schema.js";

const visits = new WeakMap();
const profilePath = /^\/profile\/(\d+)\/?$/;
export async function readUserProfile(page) {
  await pauseBeforeOperation();
  const url = new URL(page.url());
  if (
    url.origin !== "https://hy.sns.sohu.com" ||
    !profilePath.test(url.pathname)
  )
    fail("WRONG_PROFILE", "当前不是带用户 ID 的狐友主页");
  await page.waitForSelector(".profile-hero", {
    visible: true,
    timeout: 10000,
  });
  const data = await page.$eval(".profile-hero", (e) => ({
    name: e.querySelector("h1")?.textContent.trim(),
    avatar: e.querySelector(".profile-hero__avatar")?.getAttribute("src"),
    location: e.querySelector(".profile-hero__location")?.textContent.trim(),
    stats: e.querySelector(".profile-hero__stats")?.textContent.trim(),
    followLabel: e.querySelector(".profile-hero__follow")?.textContent.trim(),
    pressed: e
      .querySelector(".profile-hero__follow")
      ?.getAttribute("aria-pressed"),
  }));
  if (page.url() !== url.href) fail("PROFILE_CHANGED", "读取期间主页变化");
  return {
    userId: url.pathname.match(profilePath)[1],
    url: url.href,
    ...data,
    followState:
      data.pressed === "true" && data.followLabel === "已关注"
        ? "followed"
        : data.pressed === "false" && data.followLabel === "关注"
          ? "not-followed"
          : "unknown",
  };
}

// 访问记录只拥有本次创建的弹出页，不拥有预先存在的标签。
export async function openUserProfile(
  page,
  binding,
  { postId, timeoutMs = 10000 } = {},
) {
  await pauseBeforeOperation();
  if (typeof postId !== "string" || !/^\d+$/.test(postId))
    fail("INVALID_TARGET", "需要帖子 ID");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    fail("INVALID_TIMEOUT", "等待时间需为 1000–60000 毫秒");
  await ensureNoDraft(page);
  await checkAccount(page, binding.expectedAccountName);
  await openDetail(page, postId);
  const author = await readDetail(page);
  let popup, listener, timer;
  const arrived = new Promise((resolve) => {
    listener = (p) => {
      popup = p;
      resolve(p);
    };
    page.once("popup", listener);
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    await uniqueClick(page, ".feed-detail-content .feed-header__avatar");
    popup = await arrived;
    if (!popup)
      fail(
        "PROFILE_POPUP_TIMEOUT",
        "未收到来源页的新主页标签，请检查窗口后重试",
      );
    await popup.waitForFunction(
      () => /^\/profile\/\d+\/?$/.test(location.pathname),
      { timeout: timeoutMs },
    );
    const profile = await readUserProfile(popup);
    if (profile.name !== author.authorName)
      fail("PROFILE_MISMATCH", "主页作者与帖子不符");
    await checkAccount(popup, binding.expectedAccountName);
    const visit = Object.freeze({ page: popup, profile });
    visits.set(visit, { source: page, popup });
    return visit;
  } catch (error) {
    if (popup && !popup.isClosed()) await popup.close();
    throw error;
  } finally {
    clearTimeout(timer);
    page.off("popup", listener);
  }
}
export async function closeUserProfile(visit) {
  await pauseBeforeOperation();
  const owned = visits.get(visit);
  if (!owned)
    fail("UNOWNED_PROFILE", "只允许关闭 openUserProfile 返回的访问句柄");
  if (!owned.popup.isClosed()) {
    await ensureNoDraft(owned.popup);
    await owned.popup.close();
  }
  if (!owned.source.isClosed()) await owned.source.bringToFront();
  return { status: "closed" };
}
export async function withUserProfile(page, binding, target, callback) {
  const visit = await openUserProfile(page, binding, target);
  try {
    return await callback(visit);
  } finally {
    await closeUserProfile(visit);
  }
}
