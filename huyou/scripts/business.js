/**
 * 可重复业务脚本的组合层：采集最新帖子、独立抽样、生成固定批次。
 * 本模块不自动执行互动；调用方保存中间文件，在 AI 填写评论后再准备和执行计划。
 */
import { randomUUID } from "node:crypto";
import { withHuyou } from "./session.js";
import { selectCircle, setFeedSort } from "./context.js";
import { queryPosts } from "./posts.js";
import { shuffled } from "./workflow.js";
import { hash, fail } from "./lib/actions/schema.js";
import { validateBatch } from "./lib/batch.js";

/**
 * 采集一个已登录窗口的最新帖子。先核对账号并进入目标圈子，再选择新发排序。
 * binding 是带预期账号、圈子和 browserId 的对象；targetId 来自浏览器项目。
 * 此步骤会导航页面，但不点赞或发表评论。
 */
export async function collectLatestPosts({
  workspace,
  binding,
  targetId,
  limit = 50,
}) {
  if (
    !binding?.browserId ||
    !binding.expectedAccountName ||
    !binding.expectedCircleName ||
    !targetId
  )
    fail("BINDING_REQUIRED", "需要完整绑定对象及明确的 targetId");
  return withHuyou(
    { workspace, binding, targetId, requireContext: false },
    async (context) => {
      await selectCircle(context.page, binding.expectedCircleName, {
        expectedAccountName: binding.expectedAccountName,
      });
      await setFeedSort(context.page, "新发");
      return {
        binding: context.binding,
        targetId: context.targetId,
        url: context.page.url(),
        collectedAt: new Date().toISOString(),
        result: await queryPosts(context.page, context.binding, { limit }),
      };
    },
  );
}

/**
 * 对单个窗口快照独立抽样。每组内部不重复，两组之间允许交集。
 * 数量按窗口计算；同一 seed 和快照得到相同结果。保存返回对象后再生成评论。
 */
export function selectIndependentPosts({
  snapshot,
  likeCount = 10,
  commentCount = 10,
  seed = randomUUID(),
}) {
  const { binding, targetId, result } = snapshot || {};
  if (
    !binding?.browserId ||
    !binding.expectedAccountName ||
    !binding.expectedCircleName ||
    !targetId ||
    !result?.complete
  )
    fail("INCOMPLETE_SNAPSHOT", "需要完整查询快照、账号圈子绑定及标签 ID");
  if (!Array.isArray(result.posts) || typeof seed !== "string" || !seed)
    fail("INVALID_SAMPLE", "需要帖子数组和非空 seed");
  const posts = structuredClone(result.posts),
    ids = new Set();
  for (const post of posts) {
    if (
      typeof post.id !== "string" ||
      !/^\d+$/.test(post.id) ||
      ids.has(post.id)
    )
      fail("INVALID_POST", "快照帖子 ID 必须是唯一数字字符串");
    ids.add(post.id);
  }
  const commentable = posts.filter(
    (p) => typeof p.text === "string" && p.text.trim() && !p.textTruncated,
  );
  for (const [count, pool] of [
    [likeCount, posts],
    [commentCount, commentable],
  ])
    if (!Number.isInteger(count) || count < 0 || count > pool.length)
      fail("INVALID_COUNT", "数量必须为非负整数且不能超过可用候选数");
  if ((!likeCount && !commentCount) || likeCount + commentCount > 100)
    fail("INVALID_COUNT", "每批需要 1–100 个动作");
  const body = {
    kind: "huyou-independent-selection",
    version: 1,
    snapshot: structuredClone(snapshot),
    seed,
    likes: shuffled(posts, seed + ":likes")
      .slice(0, likeCount)
      .map((p) => p.id),
    comments: shuffled(commentable, seed + ":comments")
      .slice(0, commentCount)
      .map((p) => p.id),
  };
  return { ...body, digest: hash(body) };
}

/**
 * 将 AI 给出的 [{postId,text}] 固定为批次任务；拒绝漏项、重复和额外目标。
 * 返回值交给现有 prepareBatch。保存一次后重试应复用原计划，不重新抽样或改正文。
 * 摘要检查用于发现意外修改，不代表授权，也不代替执行时的账号和目标核对。
 */
export function buildIndependentBatch({
  selection,
  comments,
  intervalMs = 1000,
}) {
  const { digest, ...body } = selection || {};
  if (
    body.kind !== "huyou-independent-selection" ||
    body.version !== 1 ||
    digest !== hash(body)
  )
    fail("SELECTION_CHANGED", "抽样文件缺失或被修改");
  const texts = new Map();
  if (!Array.isArray(comments)) fail("COMMENTS_REQUIRED", "需要固定评论数组");
  for (const entry of comments) {
    if (
      !entry ||
      !body.comments.includes(entry.postId) ||
      texts.has(entry.postId) ||
      typeof entry.text !== "string" ||
      !entry.text.trim()
    )
      fail("INVALID_COMMENTS", "评论必须一一对应已抽中的目标且正文非空");
    texts.set(entry.postId, entry.text);
  }
  if (texts.size !== body.comments.length)
    fail("COMMENTS_REQUIRED", "评论正文尚未补齐");
  const { binding, targetId } = body.snapshot;
  const items = [
    ...body.likes.map((postId) => ({ action: "like-post", postId })),
    ...body.comments.map((postId) => ({ action: "comment", postId })),
  ].map(({ action, postId }) => ({
    id: `${action}-${postId}`,
    targetId,
    task: {
      version: 2,
      binding,
      action,
      target: { postId },
      ...(action === "comment" ? { content: { text: texts.get(postId) } } : {}),
    },
  }));
  return validateBatch({ version: 3, concurrency: 1, intervalMs, items });
}
