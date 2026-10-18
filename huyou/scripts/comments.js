/** 狐友：评论读取、分页与定位。 */
import { pauseBeforeOperation } from "./lib/pacing.js";
import {
  readDetail,
  openDetail,
  restorePage,
  ensureNoDraft,
} from "./lib/actions/dom.js";
import { readSnapshot, assertContext } from "./lib/snapshot.js";
import { normalizeText, avatarKey, fail } from "./lib/actions/schema.js";
export function resolveComment(
  comments,
  { authorName, text, avatar, isReply } = {},
) {
  if (!authorName || typeof text !== "string")
    fail("INVALID_COMMENT_TARGET", "需要昵称和完整正文");
  const matches = comments.filter(
    (c) =>
      c.authorName === authorName &&
      normalizeText(c.text) === normalizeText(text) &&
      (!avatar || avatarKey(c.avatar) === avatarKey(avatar)) &&
      (isReply === undefined || c.isReply === isReply),
  );
  if (matches.length !== 1)
    fail(
      matches.length ? "AMBIGUOUS_COMMENT" : "COMMENT_NOT_LOADED",
      "评论未加载或匹配不唯一",
    );
  return matches[0];
}
export async function loadMoreComments(page, { timeoutMs = 5000 } = {}) {
  await pauseBeforeOperation();
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000)
    fail("INVALID_TIMEOUT", "等待需为 100–10000 ms");
  await ensureNoDraft(page);
  const before = (await readDetail(page)).comments.length;
  const sentinel = await page.$(
    ".feed-detail-comments .comment-list__sentinel",
  );
  if (!sentinel) return { progress: false, stopReason: "load-control-missing" };
  await sentinel.evaluate((e) => e.scrollIntoView({ block: "end" }));
  const end = Date.now() + timeoutMs;
  do {
    const count = await page.$$eval(
      ".feed-detail .comment-item",
      (els) => els.length,
    );
    if (count > before) return { progress: true, added: count - before };
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < end);
  return { progress: false, stopReason: "no-progress" };
}
export async function queryComments(page, binding, postId, query = {}) {
  await pauseBeforeOperation();
  if (
    !query ||
    typeof query !== "object" ||
    Array.isArray(query) ||
    Object.keys(query).some(
      (k) =>
        ![
          "limit",
          "maxLoads",
          "timeoutMs",
          "authorName",
          "textIncludes",
          "includeReplies",
        ].includes(k),
    )
  )
    fail("INVALID_QUERY", "评论查询含未知字段");
  const {
    limit = 100,
    maxLoads = 10,
    timeoutMs = 30000,
    authorName,
    textIncludes,
    includeReplies = true,
  } = query;
  if (
    typeof includeReplies !== "boolean" ||
    [authorName, textIncludes].some(
      (v) => v !== undefined && (typeof v !== "string" || !v.trim()),
    )
  )
    fail("INVALID_QUERY", "评论筛选字段无效");
  if (
    typeof postId !== "string" ||
    !/^\d+$/.test(postId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isInteger(maxLoads) ||
    maxLoads < 0 ||
    maxLoads > 100 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 300000
  )
    fail("INVALID_QUERY", "评论查询参数无效");
  await ensureNoDraft(page);
  assertContext(await readSnapshot(page), binding);
  const original = page.url(),
    start = Date.now();
  let loads = 0,
    stopReason = "load-limit",
    d,
    comments;
  try {
    await openDetail(page, postId);
    while (true) {
      assertContext(await readSnapshot(page), binding);
      d = await readDetail(page);
      if (d.postId !== postId || d.circleName !== binding.expectedCircleName)
        fail("POST_CONTEXT_MISMATCH", "详情变化");
      comments = d.comments.filter(
        (c) =>
          (includeReplies || !c.isReply) &&
          (!authorName || c.authorName === authorName) &&
          (!textIncludes || c.text.includes(textIncludes)),
      );
      if (comments.length >= limit) {
        stopReason = "limit-reached";
        break;
      }
      if (loads >= maxLoads) break;
      if (Date.now() - start >= timeoutMs - 100) {
        stopReason = "time-limit";
        break;
      }
      const result = await loadMoreComments(page, {
        timeoutMs: Math.min(5000, timeoutMs - (Date.now() - start)),
      });
      loads++;
      if (!result.progress) {
        stopReason = result.stopReason;
        break;
      }
    }
    return {
      postId,
      comments: comments.slice(0, limit),
      complete: stopReason === "limit-reached",
      stopReason,
      loads,
      scanned: d.comments.length,
      scope: "loaded-detail-comments",
      identityStrength: "name-avatar-content-not-id",
      warnings: [
        "comment-ids-unavailable",
        "does-not-prove-all-comments-loaded",
      ],
    };
  } finally {
    await restorePage(page, original);
  }
}
