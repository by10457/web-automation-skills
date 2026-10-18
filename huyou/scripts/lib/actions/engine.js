/** 狐友：动作状态机及结果核对。 */
import {
  validateActionTask,
  sealPlan,
  verifyPlan,
  hash,
  operationKey,
  fail,
} from "./schema.js";
export async function buildActionPlan(
  task,
  binding,
  adapter,
  { now = Date.now() } = {},
) {
  task = validateActionTask(task);
  const evidence = await adapter.prepare(task);
  return sealPlan({
    version: 2,
    kind: "huyou-action-plan",
    status: "ready",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
    task,
    binding,
    evidence,
    limitations: [
      "身份依据昵称和头像，不是用户 UID。",
      "页面验证不等于服务端持久化保证；提交不确定时不重发。",
      "评论目标只覆盖已加载顶层评论；同名同文且无法区分的目标拒绝执行。",
    ],
  });
}
export async function executePlan(
  plan,
  adapter,
  journal,
  { now = Date.now() } = {},
) {
  verifyPlan(plan, now);
  const key = operationKey(plan);
  const prior = await journal.get(key);
  if (prior)
    return {
      status: [
        "verified-ui",
        "skipped-already-liked",
        "skipped-already-followed",
        "confirmed-by-user",
      ].includes(prior.status)
        ? "skipped-duplicate"
        : "blocked-uncertain",
      operationKey: key,
      previous: prior.status,
    };
  const current = await adapter.prepare(plan.task, plan.evidence);
  if (hash(current.account) !== hash(plan.evidence.account))
    fail("ACCOUNT_CHANGED", "账号变化");
  if (
    plan.task.action === "follow-user" &&
    current.follow.followState === "followed"
  ) {
    const result = { status: "skipped-already-followed", operationKey: key };
    await journal.begin(key, result);
    return result;
  }
  if (
    plan.task.action === "like-comment" &&
    current.comment.like.state === "liked"
  ) {
    const result = {
      status: "skipped-already-liked",
      operationKey: key,
      at: new Date().toISOString(),
    };
    await journal.begin(key, result);
    return result;
  }
  const baseline = await adapter.stage(plan.task, current);
  await adapter.assertStaged(plan.task, current);
  const record = {
    status: "pending",
    operationKey: key,
    planDigest: plan.digest,
    createdAt: new Date().toISOString(),
    baseline,
  };
  await journal.begin(key, record);
  let result;
  try {
    // 待提交状态持久化后，任何异常均视为不确定，包括点击超时。
    const submitted = await adapter.submit(plan.task, current);
    result = submitted.alreadyFollowed
      ? { status: "skipped-already-followed" }
      : submitted.alreadyLiked
        ? { status: "skipped-already-liked" }
        : await adapter.verify(plan.task, current, baseline);
  } catch (e) {
    result = {
      status: "uncertain",
      code: e.code || "SUBMIT_OR_VERIFY_FAILED",
      reason: "可能已经提交，先核对结果，不自动重发",
    };
  }
  try {
    await journal.finish(key, {
      ...record,
      ...result,
      finishedAt: new Date().toISOString(),
    });
  } catch {
    return {
      status: "uncertain",
      operationKey: key,
      code: "JOURNAL_UPDATE_FAILED",
      reason: "提交后的记录更新失败，pending 记录保留，禁止重发",
    };
  }
  return { ...result, operationKey: key };
}
export async function reconcilePlan(plan, adapter, journal) {
  verifyPlan(plan, 0); // Expiry only limits submissions; reconciliation is read-only.
  const key = operationKey(plan),
    prior = await journal.get(key);
  if (!prior) fail("NO_OPERATION", "没有需要核对的提交记录");
  if (
    [
      "verified-ui",
      "skipped-already-liked",
      "skipped-already-followed",
      "confirmed-by-user",
    ].includes(prior.status)
  )
    return { status: prior.status, operationKey: key };
  if (!prior.baseline)
    return {
      status: "uncertain",
      operationKey: key,
      reason:
        "外部记录缺少提交前基线，不能自动核验；保留记录，等待独立证据或用户确认",
    };
  // 先读取现有目标，避免残留草稿掩盖成功结果。
  let evidence, blocked;
  try {
    evidence = await adapter.verifyOnce(
      plan.task,
      plan.evidence,
      prior.baseline,
    );
    if (!evidence && plan.task.action !== "publish") {
      await adapter.prepare(plan.task, plan.evidence);
      evidence = await adapter.verifyOnce(
        plan.task,
        plan.evidence,
        prior.baseline,
      );
    }
  } catch (e) {
    blocked = { code: e.code || "RECONCILE_FAILED", message: e.message };
  }
  if (!evidence) {
    const result = {
      status: "uncertain",
      operationKey: key,
      reason: "仍未取得肯定证据，未重新提交",
      ...(blocked ? { error: blocked } : {}),
      nextAction:
        blocked?.code === "EXISTING_DRAFT"
          ? "inspect-owned-draft"
          : "inspect-evidence",
    };
    await journal.finish(key, {
      ...prior,
      lastReconciliation: { at: new Date().toISOString(), ...result },
    });
    return result;
  }
  await journal.finish(key, {
    ...prior,
    status: "verified-ui",
    evidence,
    reconciledAt: new Date().toISOString(),
  });
  return { status: "verified-ui", operationKey: key, evidence };
}
