/** 狐友：绑定解析与操作调度。 */
import { storage } from "../storage.js";
import { pauseBeforeOperation } from "./pacing.js";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withBrowser, listTabs, selectTab, SkillError } from "./browser.js";
import { readSnapshot } from "./snapshot.js";
import { validateTask, makePlan } from "./planner.js";

export async function readJSON(file) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    throw new SkillError("INVALID_JSON", `无法读取 JSON 文件：${file}`);
  }
}
export async function bindingFor(workspace, name) {
  if (name && typeof name === "object" && !Array.isArray(name)) {
    if (
      !/^[a-zA-Z0-9-]+$/.test(name.browserId || "") ||
      !name.expectedAccountName ||
      !name.expectedCircleName
    )
      throw new SkillError(
        "BINDING_INCOMPLETE",
        "绑定对象需要 browserId、expectedAccountName、expectedCircleName",
      );
    return structuredClone(name);
  }
  const config = await readJSON(
    storage(workspace, "config", "huyou-bindings.json"),
  );
  const binding = config.bindings?.[name];
  if (config.version !== 1 || !binding?.browserId)
    throw new SkillError("BINDING_NOT_FOUND", "绑定不存在或缺少 browserId");
  if (!/^[a-zA-Z0-9-]+$/.test(binding.browserId))
    throw new SkillError("INVALID_BROWSER_ID", "browserId 格式不正确");
  return binding;
}
export async function withLock(workspace, id, fn) {
  if (!/^[a-zA-Z0-9-]+$/.test(id))
    throw new SkillError("INVALID_BROWSER_ID", "锁文件需要真实窗口 ID");
  const locks = path.join(workspace, "locks");
  await mkdir(locks, { recursive: true });
  const file = path.join(locks, `${id}.lock`);
  let handle;
  try {
    handle = await open(file, "wx");
  } catch (e) {
    if (e.code === "EEXIST")
      throw new SkillError(
        "WINDOW_BUSY",
        "该窗口已有任务或遗留锁；确认原任务退出后再清理锁文件",
      );
    throw e;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    return await fn();
  } finally {
    await handle.close();
    await unlink(file);
  }
}
export async function preview({ workspace, task, targetId }) {
  await pauseBeforeOperation();
  validateTask(task);
  const binding = await bindingFor(workspace, task.binding);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const runDir = storage(workspace, "runs", runId);
  await mkdir(runDir, { recursive: true });
  const save = (name, data) =>
    writeFile(
      path.join(runDir, name),
      JSON.stringify(data, null, 2) + "\n",
      "utf8",
    );
  await save("task.json", task);
  try {
    const result = await withLock(workspace, binding.browserId, () =>
      withBrowser({ id: binding.browserId }, async (browser, window) => {
        const tab = selectTab(await listTabs(browser), {
          origin: "https://hy.sns.sohu.com",
          targetId,
        });
        const snapshot = await readSnapshot(tab.page);
        const plan = makePlan(snapshot, binding, task);
        await save("snapshot.json", snapshot);
        await save("plan.json", plan);
        return {
          status: "preview",
          runId,
          runDir,
          window,
          tab: { targetId: tab.targetId, url: tab.url },
          account: snapshot.account.displayName,
          circle: snapshot.circle.name,
          loadedCount: snapshot.posts.length,
          selectedCount: plan.selectedCount,
          completeness: plan.completeness,
          executable: false,
        };
      }),
    );
    await save("result.json", result);
    return result;
  } catch (e) {
    await save("result.json", {
      status: "failed",
      runId,
      code: e.code || "UNEXPECTED_ERROR",
      message: e.code ? e.message : "读取失败",
      executable: false,
    });
    throw e;
  }
}
