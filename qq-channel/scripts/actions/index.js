/** QQ 频道：公开导出入口，供业务脚本组合调用已封装能力。 */
import { storage } from "../storage.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { withQQChannel } from "../session.js";
import { workspacePath, saveJSON, pace, fail } from "../lib/core.js";
import { describeImages } from "../lib/files.js";
import { validateTask, sealPlan, verifyPlan } from "../lib/plans.js";
import { ActionAdapter } from "../lib/action-adapter.js";
import { executePlan } from "../lib/engine.js";
import { Journal } from "../lib/journal.js";
import { readSnapshot } from "../lib/dom.js";
import { selectChannel } from "../channels.js";
import { finishPublishedPost } from "../lib/completion.js";
async function run(options, fn) {
  await pace();
  const root = workspacePath(options.workspace),
    runDir = storage(root, "runs", randomUUID());
  return withQQChannel(
    { ...options, workspace: root, managedOnly: true },
    async (session) => {
      const adapter = new ActionAdapter(session.page, session.binding, {
        workspace: root,
        runDir,
      });
      try {
        let result = await fn(adapter, session, runDir);
        if (result.kind !== "qq-channel-action-plan")
          result = { ...result, runDir };
        await saveJSON(path.join(runDir, "result.json"), result);
        if (["uncertain", "blocked-uncertain"].includes(result.status))
          try {
            await saveJSON(
              path.join(runDir, "snapshot.json"),
              await readSnapshot(session.page),
            );
            await session.page.screenshot({
              path: path.join(runDir, "page.png"),
            });
          } catch {
            result.evidenceWarning = "现场截图或快照保存失败，提交记录仍保留";
          }
        return result;
      } catch (e) {
        e.runDir = runDir;
        await saveJSON(path.join(runDir, "result.json"), {
          status: "blocked",
          code: e.code || "UNEXPECTED_ERROR",
          message: e.message,
        });
        try {
          await session.page.screenshot({
            path: path.join(runDir, "page.png"),
          });
        } catch {}
        throw e;
      }
    },
  );
}
export async function prepareInteraction({
  action,
  target,
  content,
  board,
  ...options
}) {
  return run(options, async (adapter, { binding }, runDir) => {
    const task = validateTask(
        {
          action,
          ...(target ? { target } : {}),
          ...(content ? { content } : {}),
          ...(board ? { board } : {}),
        },
        binding,
      ),
      images = await describeImages(task.content?.images || []),
      evidence = await adapter.prepare(task);
    const plan = sealPlan({
      kind: "qq-channel-action-plan",
      version: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
      binding,
      task,
      images,
      evidence,
    });
    await saveJSON(path.join(runDir, "plan.json"), plan);
    return plan;
  });
}
export async function executeInteraction({
  plan,
  mode = "execute",
  ...options
}) {
  verifyPlan(plan);
  return run(
    { ...options, binding: plan.binding },
    async (adapter, { workspace, page, binding }) => {
      const result = await executePlan(plan, adapter, new Journal(workspace), {
        mode,
      });
      if (mode !== "execute") return result;
      return finishPublishedPost(plan, result, () =>
        selectChannel(page, binding),
      );
    },
  );
}
export async function listOperations({ workspace } = {}) {
  const j = new Journal(workspacePath(workspace));
  let names;
  try {
    names = await readdir(j.dir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return Promise.all(
    names
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .map((n) => j.get(n.slice(0, -5))),
  );
}
export const preparePublish = (o) =>
  prepareInteraction({ ...o, action: "publish" });
export const prepareLikePost = (o) =>
  prepareInteraction({ ...o, action: "like-post" });
export const prepareComment = (o) =>
  prepareInteraction({ ...o, action: "comment" });
export const prepareReply = (o) =>
  prepareInteraction({ ...o, action: "reply" });
const perform = (action) => (o) => {
  if (o.plan?.task?.action !== action)
    fail("ACTION_MISMATCH", "计划动作与接口不符");
  return executeInteraction(o);
};
export const publish = perform("publish"),
  likePost = perform("like-post"),
  comment = perform("comment"),
  reply = perform("reply");
