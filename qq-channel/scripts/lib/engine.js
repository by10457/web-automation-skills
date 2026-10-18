/** QQ 频道：动作状态机及结果核对。 */
import { verifyPlan, operationKey, successful } from "./plans.js";
import { fail } from "./core.js";
export async function executePlan(
  plan,
  adapter,
  journal,
  { mode = "execute" } = {},
) {
  if (!["execute", "reconcile"].includes(mode))
    fail("INVALID_MODE", "mode 为 execute 或 reconcile");
  verifyPlan(plan);
  const key = operationKey(plan),
    prior = await journal.get(key);
  if (mode === "reconcile") {
    if (!prior) fail("NO_OPERATION", "没有提交记录");
    if (successful(prior.status))
      return { status: prior.status, operationKey: key };
    let evidence, error;
    try {
      evidence = await adapter.reconcile(plan, prior);
    } catch (e) {
      error = { code: e.code || "RECONCILE_FAILED", message: e.message };
    }
    const result = evidence
      ? { status: "verified-ui", evidence }
      : { status: "uncertain", error, reason: "没有足够证据，不重发" };
    await journal.finish(key, {
      ...prior,
      ...result,
      reconciledAt: new Date().toISOString(),
    });
    return { ...result, operationKey: key };
  }
  if (prior)
    return {
      status: successful(prior.status)
        ? "skipped-duplicate"
        : "blocked-uncertain",
      previous: prior.status,
      operationKey: key,
    };
  verifyPlan(plan, { submission: true });
  await adapter.preflight(plan);
  if (await adapter.alreadySatisfied(plan)) {
    const r = { status: "skipped-already-liked", operationKey: key };
    await journal.begin(key, r);
    return r;
  }
  const baseline = await adapter.stage(plan);
  await adapter.assertStaged(plan);
  const pending = {
    status: "pending",
    operationKey: key,
    planDigest: plan.digest,
    baseline,
    createdAt: new Date().toISOString(),
  };
  await journal.begin(key, pending);
  let result;
  try {
    await adapter.submit(plan);
    result = await adapter.verify(plan, baseline);
  } catch (e) {
    result = {
      status: "uncertain",
      code: e.code || "SUBMIT_FAILED",
      reason: "可能已经提交，先核对结果",
    };
  }
  try {
    await journal.finish(key, {
      ...pending,
      ...result,
      finishedAt: new Date().toISOString(),
    });
  } catch {
    return {
      status: "uncertain",
      code: "JOURNAL_UPDATE_FAILED",
      operationKey: key,
    };
  }
  return { ...result, operationKey: key };
}
