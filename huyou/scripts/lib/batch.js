/** 狐友：多窗口批次准备、执行与检查点恢复。 */
import path from "node:path";
import { mkdir, open, rename, readFile, access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { bindingFor, withLock } from "./runner.js";
import { runAction } from "./actions/runner.js";
import {
  hash,
  fail,
  validateActionTask,
  verifyPlan,
  operationKey,
} from "./actions/schema.js";

const success = new Set([
  "verified-ui",
  "skipped-duplicate",
  "skipped-already-liked",
  "skipped-already-followed",
  "confirmed-by-user",
  "rehearsed",
]);
const uncertain = new Set(["running", "uncertain", "blocked-uncertain"]);
const allowed = (obj, keys) =>
  obj &&
  typeof obj === "object" &&
  !Array.isArray(obj) &&
  Object.keys(obj).every((k) => keys.includes(k));
/** 检查批次数量、调度参数、唯一条目 ID 和每个动作的契约。 */
export function validateBatch(input) {
  if (
    !allowed(input, ["version", "concurrency", "intervalMs", "items"]) ||
    input.version !== 3 ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > 100
  )
    fail("INVALID_BATCH", "批次需要 version:3 和 1–100 项明确任务");
  const concurrency = input.concurrency ?? 1,
    intervalMs = input.intervalMs ?? 1000;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 0 ||
    intervalMs > 60000
  )
    fail("INVALID_BATCH", "concurrency 为 1–4，intervalMs 为 0–60000");
  const ids = new Set();
  const items = input.items.map((item) => {
    if (
      !allowed(item, ["id", "task", "targetId"]) ||
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ||
      ids.has(item.id) ||
      (item.targetId !== undefined &&
        (typeof item.targetId !== "string" || !item.targetId))
    )
      fail("INVALID_BATCH_ITEM", "条目需要唯一 id、task 及可选 targetId");
    ids.add(item.id);
    return { ...item, task: validateActionTask(item.task) };
  });
  return { version: 3, concurrency, intervalMs, items };
}
async function atomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  const h = await open(tmp, "wx");
  try {
    await h.writeFile(JSON.stringify(data, null, 2) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(tmp, file);
}
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
function location(workspace, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail("INVALID_BATCH_ID", "批次 ID 无效");
  return path.join(workspace, "batches", id);
}
function seal(body) {
  return { ...body, digest: hash(body) };
}
function checkManifest(manifest) {
  if (manifest?.kind !== "huyou-batch-plan" || manifest.version !== 3)
    fail("INVALID_BATCH_PLAN", "需要 version:3 批次计划");
  const { digest, ...body } = manifest;
  if (digest !== hash(body))
    fail("BATCH_CHANGED", "批次计划被修改，请重新生成");
  if (manifest.status !== "ready")
    fail("BATCH_NOT_READY", "批次包含准备失败条目，不能执行");
  validateBatch({
    version: 3,
    concurrency: manifest.concurrency,
    intervalMs: manifest.intervalMs,
    items: manifest.items.map((i) => ({
      id: i.id,
      task: i.plan.task,
      ...(i.targetId ? { targetId: i.targetId } : {}),
    })),
  });
  for (const i of manifest.items) {
    verifyPlan(i.plan, 0);
    if (i.browserId !== i.plan.binding.browserId)
      fail("INVALID_BATCH_PLAN", "窗口与子计划不一致");
  }
}
// 按真实浏览器 ID 分组，同一窗口的不同别名仍属于一组。
export async function grouped(items, concurrency, fn) {
  const groups = new Map();
  for (const i of items) {
    if (!groups.has(i.browserId)) groups.set(i.browserId, []);
    groups.get(i.browserId).push(i);
  }
  const queues = [...groups.values()];
  let cursor = 0;
  const done = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, queues.length) }, async () => {
      while (cursor < queues.length) {
        const q = queues[cursor++];
        await fn(q);
      }
    }),
  );
  const error = done.find((r) => r.status === "rejected");
  if (error) throw error.reason;
}
/** 校验任务并按窗口串行准备子计划，持久化原始任务及密封批次。 */
export async function prepareBatch({
  workspace,
  task,
  action = runAction,
  resolveBinding = bindingFor,
}) {
  task = validateBatch(task);
  const id = randomUUID(),
    dir = location(workspace, id);
  // 检查浏览器前先解析全部绑定。
  const items = [];
  for (const i of task.items) {
    const b = await resolveBinding(workspace, i.task.binding);
    items.push({ ...i, browserId: b.browserId });
  }
  const seen = new Set();
  for (const i of items) {
    const key = hash({
      browser: i.browserId,
      task: { ...i.task, binding: undefined },
    });
    if (seen.has(key)) fail("DUPLICATE_BATCH_ITEM", "同一窗口存在重复任务");
    seen.add(key);
  }
  await atomic(path.join(dir, "request.json"), task);
  const results = new Map();
  await grouped(items, task.concurrency, async (queue) => {
    for (const i of queue) {
      try {
        const r = await action({
          workspace,
          command: "prepare",
          task: i.task,
          targetId: i.targetId,
        });
        if (r.cleanupWarning) fail("PAGE_NOT_RESTORED", "准备后页面未恢复");
        const { runId, runDir, planFile, cleanupWarning, ...plan } = r;
        verifyPlan(plan);
        results.set(i.id, {
          id: i.id,
          browserId: i.browserId,
          ...(i.targetId ? { targetId: i.targetId } : {}),
          plan,
          sourceRun: runDir,
        });
      } catch (e) {
        results.set(i.id, {
          id: i.id,
          browserId: i.browserId,
          error: {
            code: e.code || "PREPARE_FAILED",
            message: e.code ? e.message : "准备失败",
          },
        });
      }
    }
  });
  const entries = items.map((i) => results.get(i.id));
  const manifest = seal({
    version: 3,
    kind: "huyou-batch-plan",
    id,
    status: entries.some((i) => i.error) ? "blocked" : "ready",
    createdAt: new Date().toISOString(),
    concurrency: task.concurrency,
    intervalMs: task.intervalMs,
    items: entries,
  });
  const planFile = path.join(dir, "plan.json");
  await atomic(planFile, manifest);
  return {
    status: manifest.status,
    batchId: id,
    planFile,
    total: items.length,
    prepared: entries.filter((i) => i.plan).length,
    errors: entries.filter((i) => i.error),
  };
}
/** 按显式模式处理原计划，复用检查点跳过已完成任务；不确定提交先核对。 */
export async function runBatch({
  workspace,
  manifest,
  mode,
  action = runAction,
}) {
  checkManifest(manifest);
  if (!["rehearse", "execute", "reconcile"].includes(mode))
    fail("INVALID_BATCH_MODE", "不支持的批次模式");
  const dir = location(workspace, manifest.id),
    file = path.join(
      dir,
      mode === "rehearse" ? "rehearsal.json" : "execution.json",
    );
  return withLock(workspace, `batch-${manifest.id}`, async () => {
    let state;
    try {
      state = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT")
        fail("BATCH_STATE_UNREADABLE", "批次记录无法读取，禁止自动重跑");
    }
    if (!state) {
      if (mode === "reconcile") fail("NO_BATCH_EXECUTION", "没有执行记录");
      state = {
        version: 1,
        planDigest: manifest.digest,
        items: manifest.items.map((i) => ({ id: i.id, status: "queued" })),
      };
    }
    if (
      state.planDigest !== manifest.digest ||
      !Array.isArray(state.items) ||
      state.items.length !== manifest.items.length ||
      state.items.some((i, n) => i.id !== manifest.items[n].id)
    )
      fail("BATCH_STATE_CHANGED", "检查点与批次计划不匹配");
    const rows = new Map(state.items.map((i) => [i.id, i]));
    for (const r of state.items)
      if (r.status === "running") {
        r.status = "uncertain";
        r.code = "INTERRUPTED_IN_FLIGHT";
      }
    // 跨工作线程串行写入检查点，派发前持久化运行状态。
    let writes = Promise.resolve();
    const save = () => {
      writes = writes.then(() => atomic(file, state));
      return writes;
    };
    await save();
    await grouped(manifest.items, manifest.concurrency, async (queue) => {
      let blocked = false;
      for (const item of queue) {
        const row = rows.get(item.id);
        if (mode === "reconcile") {
          if (!uncertain.has(row.status)) continue;
        } else {
          if (success.has(row.status)) {
            if (row.needsAttention) blocked = true;
            continue;
          }
          if (row.status !== "queued") {
            blocked = true;
            continue;
          }
          if (blocked || (await exists(path.join(dir, "STOP")))) continue;
        }
        let dispatched = false;
        try {
          // 排队计划过期后不自动换目标重新生成。
          if (mode !== "reconcile") verifyPlan(item.plan);
          row.status = "running";
          row.startedAt = new Date().toISOString();
          await save();
          dispatched = true;
          const result = await action({
            workspace,
            command: mode,
            plan: item.plan,
            targetId: item.targetId,
          });
          row.status = result.status;
          row.result = result;
          row.finishedAt = new Date().toISOString();
          if (result.cleanupWarning) {
            row.needsAttention = true;
            blocked = true;
          }
          if (!success.has(row.status)) blocked = true;
        } catch (e) {
          row.status =
            dispatched && (mode === "execute" || mode === "reconcile")
              ? "uncertain"
              : "failed";
          row.code = e.code || "BATCH_ITEM_FAILED";
          blocked = true;
        }
        await save();
        if (row.needsAttention) blocked = true;
        if (mode !== "reconcile" && !blocked && manifest.intervalMs)
          await new Promise((r) => setTimeout(r, manifest.intervalMs));
      }
    });
    const counts = {};
    for (const r of state.items) counts[r.status] = (counts[r.status] || 0) + 1;
    state.status = state.items.every(
      (r) => success.has(r.status) && !r.needsAttention,
    )
      ? "completed"
      : "needs-attention";
    state.updatedAt = new Date().toISOString();
    state.counts = counts;
    await save();
    return {
      ...state,
      batchId: manifest.id,
      stateFile: file,
      stopFile: path.join(dir, "STOP"),
      operations: manifest.items.map((i) => ({
        id: i.id,
        operationKey: operationKey(i.plan),
      })),
    };
  });
}
