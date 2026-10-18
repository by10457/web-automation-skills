/** QQ 频道：评论读取、分页与定位。 */
import { pace, unique, fail, avatarIdentity } from "./lib/core.js";
import { readSnapshot, assertContext } from "./lib/dom.js";
import { loadMore } from "./navigation.js";
export function resolveComment(comments, target) {
  if (!target?.id && !(target?.authorName && typeof target.text === "string"))
    fail("INVALID_COMMENT", "需要 comment.id 或作者和完整正文");
  const found = unique(
    comments,
    (c) =>
      (!target.id || c.id === target.id) &&
      (!target.authorName || c.author.name === target.authorName) &&
      (target.text === undefined || c.text === target.text) &&
      (!target.avatar ||
        avatarIdentity(c.author.avatar) === avatarIdentity(target.avatar)),
    "评论",
  );
  if (found.isReply) fail("NESTED_REPLY_UNSUPPORTED", "首版只回复顶层评论");
  return found;
}
export async function loadMoreComments(page, binding, options) {
  await pace();
  const s = await readSnapshot(page);
  assertContext(s, binding);
  if (!s.detail) fail("POST_REQUIRED", "需要帖子详情");
  if (s.detail.commentsEnd)
    return { progress: false, stopReason: "end-visible" };
  return loadMore(page, binding, options);
}
export async function queryComments(
  page,
  binding,
  { maxLoads = 10, limit = 200 } = {},
) {
  await pace();
  if (
    !Number.isInteger(maxLoads) ||
    maxLoads < 0 ||
    maxLoads > 100 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    fail("INVALID_QUERY", "评论查询范围无效");
  await page.waitForSelector(".comment-bar__comment-count,.has-no-comment", {
    timeout: 15000,
  });
  const seen = new Map();
  let postId,
    loads = 0,
    stopReason;
  while (true) {
    const s = await readSnapshot(page);
    assertContext(s, binding);
    if (!s.detail) fail("POST_REQUIRED", "需要详情");
    postId ??= s.detail.id;
    if (s.detail.id !== postId) fail("POST_CHANGED", "详情变化");
    for (const c of s.detail.comments) seen.set(c.id || JSON.stringify(c), c);
    if (seen.size > limit) {
      stopReason = "record-limit";
      break;
    }
    if (s.detail.commentsEnd) {
      stopReason = "end-visible";
      break;
    }
    if (loads >= maxLoads) {
      stopReason = "load-limit";
      break;
    }
    const p = await loadMoreComments(page, binding);
    loads++;
    if (!p.progress) {
      stopReason = p.stopReason;
      break;
    }
  }
  const warnings = [...seen.values()].some((c) => !c.id)
    ? ["missing-comment-id"]
    : [];
  return {
    comments: [...seen.values()].slice(0, limit),
    complete: stopReason === "end-visible" && !warnings.length,
    stopReason,
    loads,
    postId,
    warnings,
  };
}
