/** QQ 频道：计划生成与校验。 */
import { fail, hash, route } from "./core.js";
export function validateTask(input, binding) {
  if (
    !input ||
    !["publish", "like-post", "comment", "reply"].includes(input.action)
  )
    fail("INVALID_ACTION", "支持 publish、like-post、comment、reply");
  const allowed = ["action", "target", "content", "board"];
  if (Object.keys(input).some((k) => !allowed.includes(k)))
    fail("INVALID_TASK", "含未知动作字段");
  const task = structuredClone(input);
  if (task.action === "publish") {
    if (
      task.target ||
      typeof task.board !== "string" ||
      !task.board.trim() ||
      ["全部", "热门"].includes(task.board)
    )
      fail("INVALID_BOARD", "发布必须指定具体版块，不使用全部或热门");
  } else {
    if (task.board) fail("INVALID_TASK", "只有发布指定 board");
    const r = route(task.target?.url);
    if (!r.postId || r.channelId !== binding.channelId)
      fail("INVALID_TARGET", "目标须为绑定频道详情网址");
    if (Object.keys(task.target).some((k) => !["url", "comment"].includes(k)))
      fail("INVALID_TARGET", "target 含未知字段");
    if (task.action === "reply" && !task.target.comment)
      fail("INVALID_COMMENT", "回复需要 target.comment");
    if (task.action !== "reply" && task.target.comment)
      fail("INVALID_TARGET", "仅 reply 接受 comment");
  }
  if (task.action === "like-post") {
    if (task.content) fail("INVALID_CONTENT", "点赞不接受正文");
  } else {
    if (
      !task.content ||
      typeof task.content.text !== "string" ||
      !task.content.text.trim() ||
      Object.keys(task.content).some((k) => !["text", "images"].includes(k))
    )
      fail("INVALID_CONTENT", "需要非空正文");
    task.content.text = task.content.text.replace(/\r\n/g, "\n").trim();
    if (task.action !== "publish" && task.content.images?.length)
      fail("UNSUPPORTED_CONTENT", "首版评论回复仅支持文字");
    if (
      task.content.images !== undefined &&
      !Array.isArray(task.content.images)
    )
      fail("INVALID_IMAGES", "images 必须为数组");
  }
  return task;
}
export function sealPlan(value) {
  return { ...value, digest: hash(value) };
}
export function verifyPlan(plan, { submission = false } = {}) {
  if (plan?.kind !== "qq-channel-action-plan" || plan.version !== 1)
    fail("INVALID_PLAN", "仅接受 QQ 频道 version:1 计划");
  const { digest, ...body } = plan;
  if (digest !== hash(body)) fail("PLAN_CHANGED", "计划被修改");
  validateTask(plan.task, plan.binding);
  if (
    !Number.isFinite(Date.parse(plan.expiresAt)) ||
    (submission && Date.now() > Date.parse(plan.expiresAt))
  )
    fail("PLAN_EXPIRED", "计划过期，禁止提交");
  return plan;
}
export function operationKey(plan) {
  return hash({
    browserId: plan.binding.browserId,
    account: plan.evidence.account,
    channelId: plan.binding.channelId,
    action: plan.task.action,
    postId: plan.evidence.post?.id,
    comment: plan.evidence.comment,
    board: plan.task.board,
    text: plan.task.content?.text,
    images: plan.images.map((i) => i.sha256),
  });
}
export const successful = (s) =>
  ["verified-ui", "skipped-already-liked"].includes(s);
