/** 狐友：账号、圈子和页面上下文检查及导航。 */
import { pauseBeforeOperation } from "./lib/pacing.js";
import { readSnapshot, assertContext } from "./lib/snapshot.js";
import {
  ensureNoDraft,
  exactTextClick,
  uniqueClick,
  closeDetail,
} from "./lib/actions/dom.js";
import { assertFeed } from "./navigation.js";
export async function inspect(page) {
  await pauseBeforeOperation();
  const s = await readSnapshot(page);
  return {
    account: s.account,
    circle: s.circle,
    feed: s.feed,
    loadedCount: s.posts.length,
    url: s.url,
    capturedAt: s.capturedAt,
  };
}
export async function diagnoseHuyou(page, binding) {
  await pauseBeforeOperation();
  const checks = [];
  let snapshot;
  try {
    snapshot = await readSnapshot(page);
    checks.push({ check: "page", status: "ok" });
  } catch (e) {
    return {
      status: "blocked",
      checks: [{ check: "page", status: "failed", code: e.code }],
    };
  }
  try {
    if (binding) assertContext(snapshot, binding);
    else if (snapshot.account.state !== "logged-in")
      throw { code: "LOGIN_REQUIRED" };
    checks.push({ check: "context", status: "ok" });
  } catch (e) {
    checks.push({ check: "context", status: "failed", code: e.code });
  }
  try {
    await ensureNoDraft(page);
    checks.push({ check: "draft", status: "clear" });
  } catch (e) {
    checks.push({ check: "draft", status: "failed", code: e.code });
  }
  return {
    status: checks.some((c) => c.status === "failed") ? "blocked" : "ready",
    checks,
    account: snapshot.account,
    circle: snapshot.circle,
    feed: snapshot.feed,
    capabilities: {
      queryPosts: snapshot.feed.sort === "新发",
      availableCircles: snapshot.circle.availableNames,
    },
    identityStrength: "display-name-not-uid",
  };
}
export async function listCircles(page) {
  await pauseBeforeOperation();
  const s = await readSnapshot(page);
  return {
    names: s.circle.availableNames,
    selected: s.circle.name,
    scope: "visible-circle-buttons",
  };
}
/** 核对预期账号后切换圈子，等待页面确认目标圈子；不执行互动。 */
export async function selectCircle(page, name, { expectedAccountName } = {}) {
  await pauseBeforeOperation();
  if (typeof name !== "string" || !name.trim())
    throw Object.assign(Error("需要圈子名称"), { code: "INVALID_CIRCLE" });
  await assertFeed(page);
  const before = await readSnapshot(page);
  if (
    before.account.state !== "logged-in" ||
    (expectedAccountName && before.account.displayName !== expectedAccountName)
  )
    throw Object.assign(Error("账号不符"), { code: "ACCOUNT_MISMATCH" });
  if (before.circle.name !== name) {
    await exactTextClick(page, ".main-header__circle-info", name);
    await page.waitForFunction(
      (n) =>
        document
          .querySelector(
            ".main-header__circle--active .main-header__circle-name",
          )
          ?.textContent.trim() === n &&
        document
          .querySelector(".circle-info-card__name")
          ?.textContent.trim() === n,
      { timeout: 10000 },
      name,
    );
  }
  const after = await readSnapshot(page);
  if (after.account.displayName !== before.account.displayName)
    throw Object.assign(Error("账号变化"), { code: "ACCOUNT_CHANGED" });
  return { status: "selected", circle: after.circle };
}
/** 切换列表排序，已经处于目标排序时不重复点击。 */
export async function setFeedSort(page, sort) {
  await pauseBeforeOperation();
  if (!["新发", "新回", "热门", "精华"].includes(sort))
    throw Object.assign(Error("不支持的排序"), { code: "INVALID_SORT" });
  await assertFeed(page);
  const current = (await readSnapshot(page)).feed.sort;
  if (current === sort) return { status: "unchanged", sort };
  await uniqueClick(page, ".circle-tab__sort");
  await exactTextClick(page, ".circle-tab__sort-option", sort);
  await page.waitForFunction(
    (s) =>
      document.querySelector(".circle-tab__sort")?.textContent.trim() === s,
    { timeout: 10000 },
    sort,
  );
  return { status: "selected", sort };
}
export async function closePost(page) {
  await pauseBeforeOperation();
  return closeDetail(page);
}
