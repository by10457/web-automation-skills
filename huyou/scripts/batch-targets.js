/** 狐友：从已查询帖子构造批次目标。 */
import { fail, avatarKey } from "./lib/actions/schema.js";
import { prepareBatch } from "./lib/batch.js";
export function interactionBatchFromPosts({
  posts,
  binding,
  action,
  excludeSelfName,
  deduplicateAuthors = action === "follow-user",
  allowPartial = false,
  complete = true,
}) {
  if (
    !["like-post", "follow-user"].includes(action) ||
    !Array.isArray(posts) ||
    !posts.length
  )
    fail("INVALID_TARGETS", "需要帖子数组及 like-post/follow-user");
  if (!complete && !allowPartial)
    fail("INCOMPLETE_QUERY", "查询不完整，明确接受部分结果后再生成批次");
  const seen = new Set(),
    items = [];
  for (const p of posts) {
    if (
      typeof p.id !== "string" ||
      !/^\d+$/.test(p.id) ||
      !p.author?.name ||
      !p.author.avatar
    )
      fail("INVALID_POST", "帖子需要 id、author.name、author.avatar");
    if (excludeSelfName && p.author.name === excludeSelfName) continue;
    const key = deduplicateAuthors
      ? JSON.stringify([p.author.name, avatarKey(p.author.avatar)])
      : p.id;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: `post-${p.id}`,
      task: { version: 2, binding, action, target: { postId: p.id } },
    });
  }
  if (!items.length) fail("NO_TARGETS", "筛选后没有目标");
  return { version: 3, concurrency: 1, items };
}
export function preparePostInteractions({
  workspace,
  targetId,
  queryResult,
  ...options
}) {
  if (!queryResult || typeof queryResult.complete !== "boolean")
    fail("QUERY_REQUIRED", "需要完整查询返回对象");
  const task = interactionBatchFromPosts({
    ...options,
    posts: queryResult.posts,
    complete: queryResult.complete,
  });
  if (targetId) task.items = task.items.map((i) => ({ ...i, targetId }));
  return prepareBatch({ workspace, task });
}
