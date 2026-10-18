/** 狐友：操作计划生成。 */
import { SkillError } from "./browser.js";
import { assertContext } from "./snapshot.js";

export function validateTask(task) {
  if (
    !task ||
    task.version !== 1 ||
    typeof task.binding !== "string" ||
    !task.binding.trim()
  )
    throw new SkillError("INVALID_TASK", "任务必须包含 version:1 和 binding");
  if (task.action !== "inspect-posts" || task.execution?.mode !== "preview")
    throw new SkillError(
      "READ_ONLY_PHASE",
      "该接口仅支持 inspect-posts / preview，不执行点赞、评论或发布",
    );
  const s = task.selection;
  if (
    !s ||
    !Number.isInteger(s.limit) ||
    s.limit < 1 ||
    s.limit > 100 ||
    !["newest", "display"].includes(s.order) ||
    !["none", "authorName", "author"].includes(s.distinctBy)
  )
    throw new SkillError(
      "INVALID_SELECTION",
      "selection 需要 limit:1–100、order:newest/display、distinctBy:none/authorName/author",
    );
  return task;
}

export function makePlan(snapshot, binding, task) {
  validateTask(task);
  assertContext(snapshot, binding);
  if (task.selection.order === "newest" && snapshot.feed.sort !== "新发")
    throw new SkillError(
      "ORDER_NOT_VERIFIED",
      "当前列表未显示新发排序，请手动切换后重试",
    );
  if (snapshot.posts.length === 0)
    throw new SkillError(
      "NO_POSTS",
      "没有读取到帖子：可能正在加载、圈子为空或页面结构变化",
    );
  if (snapshot.posts.some((p) => !p.author.name || !p.publishedLabel))
    throw new SkillError(
      "POST_SCHEMA_CHANGED",
      "帖子缺少作者或时间，无法可靠生成预览",
    );
  const selected = [],
    skipped = [],
    seenPosts = new Set(),
    seenAuthors = new Set();
  for (const post of snapshot.posts) {
    const postKey = post.id || post.snapshotKey;
    let reason;
    if (task.selection.order === "newest" && post.recommended)
      reason = "inserted-hot-post";
    else if (seenPosts.has(postKey)) reason = "duplicate-snapshot";
    else if (task.selection.distinctBy === "author" && !post.author.id)
      throw new SkillError(
        "AUTHOR_ID_UNAVAILABLE",
        "页面未暴露稳定作者 ID；可改用 authorName 进行明确标注的昵称去重预览",
      );
    else {
      const authorKey =
        task.selection.distinctBy === "author"
          ? post.author.id
          : post.author.name;
      if (task.selection.distinctBy !== "none" && seenAuthors.has(authorKey))
        reason = "duplicate-author";
      else if (selected.length >= task.selection.limit)
        reason = "limit-reached";
      else {
        selected.push(post);
        seenAuthors.add(authorKey);
        seenPosts.add(postKey);
      }
    }
    if (reason) skipped.push({ snapshotKey: post.snapshotKey, reason });
  }
  return {
    version: 1,
    mode: "preview",
    executable: false,
    account: snapshot.account,
    circle: snapshot.circle,
    feed: snapshot.feed,
    selection: task.selection,
    requested: task.selection.limit,
    selectedCount: selected.length,
    completeness:
      selected.length === task.selection.limit
        ? "requested-count-from-loaded-list"
        : "partial-loaded-list",
    selected,
    skipped,
    limitations: [
      "仅对当前已加载列表取样；不刷新、不滚动，不保证覆盖服务器最新全部帖子。",
      "账号仅核对头像昵称，未取得稳定账号 ID；同名账号不能可靠区分。",
      "帖子 ID 来自 DOM 的 data-feed-id；snapshotKey 仅为内容摘要，未来提交仍需重新核对。",
      "列表不提供本账号点赞状态；帖子点赞需使用like-post，发送快捷菜单中的点赞表情。",
      ...(task.selection.distinctBy === "authorName"
        ? ["按昵称近似去重，同名不同用户可能被合并。"]
        : []),
    ],
  };
}
