/** 狐友：参数契约、摘要及计划校验。 */
import { createHash } from "node:crypto";
import { SkillError } from "./../browser.js";
export const fail = (code, message) => {
  throw new SkillError(code, message);
};
export const normalizeText = (text) =>
  String(text ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
export function avatarKey(src) {
  try {
    return new URL(src).pathname.split("/").pop();
  } catch {
    return src || null;
  }
}
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function validateActionTask(input) {
  const t = structuredClone(input);
  if (
    !t ||
    t.version !== 2 ||
    !(
      (typeof t.binding === "string" && t.binding.trim()) ||
      (t.binding &&
        typeof t.binding === "object" &&
        !Array.isArray(t.binding) &&
        t.binding.browserId &&
        t.binding.expectedAccountName &&
        t.binding.expectedCircleName)
    )
  )
    fail("INVALID_TASK", "操作任务需要 version:2 和 binding 名称或对象");
  if (
    ![
      "comment",
      "reply",
      "publish",
      "like-comment",
      "like-post",
      "follow-user",
    ].includes(t.action)
  )
    fail("INVALID_ACTION", "不支持的操作类型");
  const allowed = [
    "version",
    "binding",
    "action",
    "target",
    "content",
    "publication",
  ];
  if (Object.keys(t).some((k) => !allowed.includes(k)))
    fail("INVALID_TASK", "任务包含未知字段；提交仅通过 execute 命令触发");
  if (t.action !== "publish") {
    if (
      !/^\d+$/.test(t.target?.postId || "") ||
      typeof t.target.postId !== "string"
    )
      fail("INVALID_TARGET", "postId 必须是数字字符串");
    if (Object.keys(t.target).some((k) => !["postId", "comment"].includes(k)))
      fail("INVALID_TARGET", "target 包含未知字段");
  } else if (t.target) fail("INVALID_TARGET", "发布任务不指定帖子 target");
  if (["reply", "like-comment"].includes(t.action)) {
    const c = t.target.comment;
    if (
      !c ||
      typeof c.authorName !== "string" ||
      !c.authorName.trim() ||
      typeof c.text !== "string" ||
      !c.text.trim()
    )
      fail(
        "INVALID_COMMENT_TARGET",
        "回复或评论点赞需要作者昵称和完整评论文本",
      );
    if (
      Object.keys(c).some((k) => !["authorName", "text", "avatar"].includes(k))
    )
      fail("INVALID_COMMENT_TARGET", "评论目标包含未知字段");
    c.text = normalizeText(c.text);
  } else if (t.target?.comment) fail("INVALID_TARGET", "该操作不接受评论目标");
  if (["comment", "reply", "publish"].includes(t.action)) {
    if (
      !t.content ||
      Object.keys(t.content).some((k) => k !== "text") ||
      typeof t.content.text !== "string"
    )
      fail("INVALID_CONTENT", "当前支持纯文本 content.text");
    t.content.text = normalizeText(t.content.text);
    if (!t.content.text || t.content.text.length > 5000)
      fail("INVALID_CONTENT", "文本需为 1–5000 字符；实际输入框限制也会检查");
  } else if (t.content) fail("INVALID_CONTENT", "点赞任务不接受内容");
  if (t.action === "publish") {
    t.publication ??= {};
    if (
      Object.keys(t.publication).some(
        (k) => !["statement", "board"].includes(k),
      )
    )
      fail(
        "UNSUPPORTED_PUBLICATION",
        "当前发布支持纯文本、声明和分区，不支持附件",
      );
    if (
      t.publication.board !== undefined &&
      (typeof t.publication.board !== "string" || !t.publication.board.trim())
    )
      fail("INVALID_BOARD", "分区名称需非空");
    const options = [
      "无需声明",
      "内容由AI生成",
      "内容为个人观点和见解",
      "内容为转载信息",
      "内容为虚构演绎",
      "内容含营销信息",
    ];
    if (!options.includes(t.publication.statement))
      fail("STATEMENT_REQUIRED", "发布任务需要明确的 publication.statement");
  } else if (t.publication)
    fail("INVALID_TASK", "只有 publish 接受 publication");
  return t;
}
export function matchComment(comments, target) {
  const matches = comments.filter(
    (c) =>
      c.authorName === target.authorName &&
      normalizeText(c.text) === normalizeText(target.text) &&
      (!target.avatar || avatarKey(c.avatar) === avatarKey(target.avatar)),
  );
  if (matches.length !== 1)
    fail(
      matches.length ? "AMBIGUOUS_COMMENT" : "COMMENT_NOT_LOADED",
      "评论不存在于已加载列表或匹配不唯一；不按位置猜选",
    );
  if (matches[0].isReply)
    fail(
      "NESTED_REPLY_UNSUPPORTED",
      "当前只接受顶层评论目标，避免楼中楼目标歧义",
    );
  return matches[0];
}
export function identity(comment) {
  return {
    authorName: comment.authorName,
    text: normalizeText(comment.text),
    avatar: avatarKey(comment.avatar),
    isReply: comment.isReply,
  };
}
export function sealPlan(plan) {
  return { ...plan, digest: hash(plan) };
}
export function verifyPlan(plan, now = Date.now()) {
  if (!plan || plan.version !== 2 || plan.kind !== "huyou-action-plan")
    fail("INVALID_PLAN", "仅接受 version:2 单项操作计划");
  const { digest, ...body } = plan;
  if (digest !== hash(body)) fail("PLAN_CHANGED", "计划被修改，请重新 prepare");
  validateActionTask(plan.task);
  if (
    !Number.isFinite(Date.parse(plan.expiresAt)) ||
    now > Date.parse(plan.expiresAt)
  )
    fail("PLAN_EXPIRED", "计划已过期，请重新 prepare");
  if (plan.status !== "ready") fail("PLAN_NOT_READY", "计划尚不可执行");
  return plan;
}
export function operationKey(plan) {
  if (plan.task.action === "follow-user")
    return hash([
      "follow-user",
      plan.binding.browserId,
      plan.evidence.account,
      plan.evidence.follow.author,
    ]);
  return hash({
    browserId: plan.binding.browserId,
    account: plan.evidence.account,
    circle: plan.binding.expectedCircleName,
    action: plan.task.action,
    postId: plan.task.target?.postId,
    comment: plan.evidence.comment ? identity(plan.evidence.comment) : null,
    content: plan.task.content,
    publication: plan.task.publication,
  });
}
