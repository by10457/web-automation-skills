/** 狐友：关注作者动作封装。 */
import { pauseBeforeOperation } from "../lib/pacing.js";
import {
  checkAccount,
  ensureNoDraft,
  openDetail,
  readDetail,
  uniqueClick,
} from "../lib/actions/dom.js";
import { hash, fail } from "../lib/actions/schema.js";
import { Journal } from "../lib/actions/journal.js";
import { workspacePath } from "../config.js";

const control = ".feed-detail-content .feed-header__follow-btn";
async function state(page) {
  const els = await page.$$(control);
  if (els.length !== 1)
    fail(
      "FOLLOW_UNAVAILABLE",
      "未找到唯一关注按钮，可能是自己的帖子或页面结构变化",
    );
  return els[0].evaluate((e) => ({
    label: e.textContent.trim(),
    pressed: e.getAttribute("aria-pressed"),
    disabled: e.disabled,
  }));
}
const followed = (s) => s.label === "已关注" && s.pressed === "true";
export async function prepareFollowUser(page, binding, { postId } = {}) {
  await pauseBeforeOperation();
  if (typeof postId !== "string" || !/^\d+$/.test(postId))
    fail("INVALID_TARGET", "需要帖子 ID");
  await ensureNoDraft(page);
  const account = await checkAccount(page, binding.expectedAccountName);
  await openDetail(page, postId);
  const d = await readDetail(page);
  if (d.circleName !== binding.expectedCircleName)
    fail("CIRCLE_MISMATCH", "帖子圈子不符");
  const avatar = await page.$eval(
    ".feed-detail-content .feed-header__avatar",
    (e) => e.getAttribute("src"),
  );
  const s = await state(page);
  if (
    !followed(s) &&
    (s.label !== "关注" || s.pressed !== "false" || s.disabled)
  )
    fail("FOLLOW_STATE_UNKNOWN", "无法确认关注状态");
  const p = {
    kind: "huyou-follow",
    postId,
    account,
    author: { name: d.authorName, avatar },
    circle: d.circleName,
    followState: followed(s) ? "followed" : "not-followed",
    expiresAt: Date.now() + 900000,
  };
  return { ...p, digest: hash(p) };
}
export async function followUser(page, binding, plan, { workspace } = {}) {
  await pauseBeforeOperation();
  const { digest, ...body } = plan;
  if (
    plan.kind !== "huyou-follow" ||
    hash(body) !== digest ||
    Date.now() > plan.expiresAt
  )
    fail("INVALID_PLAN", "关注计划已变化或过期，请重新准备");
  const current = await prepareFollowUser(page, binding, {
    postId: plan.postId,
  });
  if (
    hash([current.account, current.author, current.circle]) !==
    hash([plan.account, plan.author, plan.circle])
  )
    fail("TARGET_CHANGED", "账号或作者变化");
  if (current.followState === "followed")
    return { status: "skipped-already-followed", author: current.author };
  const journal = new Journal(workspacePath(workspace));
  const key = hash([
    "follow-user",
    binding.browserId,
    current.account,
    current.author,
  ]);
  if (await journal.get(key))
    return { status: "blocked-previous-operation", operationKey: key };
  await pauseBeforeOperation();
  await checkAccount(page, binding.expectedAccountName, plan.account);
  if (new URL(page.url()).searchParams.get("feedDetail") !== plan.postId)
    fail("TARGET_CHANGED", "当前帖子变化");
  const d = await readDetail(page);
  const avatar = await page.$eval(
    ".feed-detail-content .feed-header__avatar",
    (e) => e.getAttribute("src"),
  );
  if (
    d.authorName !== plan.author.name ||
    avatar !== plan.author.avatar ||
    d.circleName !== plan.circle
  )
    fail("TARGET_CHANGED", "作者或圈子变化");
  const s = await state(page);
  if (followed(s)) return { status: "skipped-already-followed" };
  if (s.label !== "关注" || s.pressed !== "false" || s.disabled)
    fail("FOLLOW_STATE_UNKNOWN", "关注状态变化");
  await journal.begin(key, {
    status: "pending",
    plan,
    at: new Date().toISOString(),
  });
  let result;
  try {
    await uniqueClick(page, control);
    await page.waitForFunction(
      (css) => {
        const e = document.querySelector(css);
        return (
          e?.textContent.trim() === "已关注" &&
          e.getAttribute("aria-pressed") === "true"
        );
      },
      { timeout: 10000 },
      control,
    );
    await checkAccount(page, binding.expectedAccountName, plan.account);
    if (new URL(page.url()).searchParams.get("feedDetail") !== plan.postId)
      throw Error("Target changed");
    const after = await readDetail(page);
    if (
      after.authorName !== plan.author.name ||
      after.circleName !== plan.circle
    )
      throw Error("Author changed");
    result = { status: "verified-ui", author: plan.author };
  } catch (e) {
    result = { status: "uncertain", code: e.code || "FOLLOW_NOT_VERIFIED" };
  }
  try {
    await journal.finish(key, {
      ...result,
      plan,
      at: new Date().toISOString(),
    });
  } catch {
    result = { status: "uncertain", code: "JOURNAL_UPDATE_FAILED" };
  }
  return { ...result, operationKey: key };
}
