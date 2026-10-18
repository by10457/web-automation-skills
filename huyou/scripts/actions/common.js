/** 狐友：动作结果与计划的共享处理。 */
import { runAction } from "../lib/actions/runner.js";
import { workspacePath } from "../config.js";
import { fail } from "../lib/actions/schema.js";
export function prepareAction(action, { workspace, targetId, ...task }) {
  return runAction({
    workspace: workspacePath(workspace),
    command: "prepare",
    targetId,
    task: { ...task, version: 2, action },
  });
}
export function performAction(
  action,
  { workspace, targetId, plan, mode = "execute" },
) {
  if (
    plan?.task?.action !== action ||
    !["execute", "rehearse", "reconcile"].includes(mode)
  )
    fail("INVALID_ACTION", "计划类型或执行模式不匹配");
  // 准备结果同时包含密封计划和元数据，只移除已知结果元数据。
  const { runId, runDir, planFile, cleanupWarning, ...sealed } = plan;
  if (cleanupWarning)
    fail("PAGE_NOT_RESTORED", "先处理计划准备时的页面恢复警告");
  return runAction({
    workspace: workspacePath(workspace),
    command: mode,
    targetId,
    plan: sealed,
  });
}
