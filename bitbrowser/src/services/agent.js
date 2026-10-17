/** Shared Agent facade. Owns orchestration and storage; has no MCP transport dependency. */
import { health, listWindows } from '../index.js';
import {
  ManagementAPI,
  assessWindows,
  getWindow,
  prepareManagement,
  executeManagement,
} from './management.js';
import { doctor, inspectOperation } from './diagnostics.js';
import { getWindowState, getTabs } from './windows.js';
import { listDisplays } from './window-operations.js';
import { PlanStore } from '../runtime/plan-store.js';
import { stateDirectory } from '../runtime/paths.js';
import { findTool } from '../contracts/tools.js';
import { SkillError } from '../client/bitbrowser-api.js';
import { saveTabSnapshot, exportHandoff } from './handoff.js';

/**
 * Create an isolated facade backed by shared services and persistent state.
 * @param {{api?:ManagementAPI,stateDir?:string}} options
 * @returns {{call: function(string, object): Promise<object>}}
 */
export function createAgentService({
  api = new ManagementAPI(),
  stateDir = stateDirectory(),
} = {}) {
  const store = new PlanStore(stateDir);
  const handlers = {
    bitbrowser_list_displays: () => listDisplays({ api }),
    bitbrowser_health: () => health({ api }),
    bitbrowser_doctor: (args) => doctor({ ...args, api }),
    bitbrowser_list_windows: () => listWindows({ api }),
    bitbrowser_get_window: (args) => getWindow({ ...args, api }),
    bitbrowser_get_window_state: (args) => getWindowState({ ...args, api }),
    bitbrowser_list_tabs: async (args) =>
      saveTabSnapshot(await getTabs({ ...args, api }), { stateDir }),
    bitbrowser_export_handoff: async (args) => {
      const { rows, ...delivery } = await exportHandoff(args, { stateDir });
      // MCP 只交付文件和生成的回复文本，减少模型再次手写 ID 表的机会；共享 JS 仍返回 rows。
      return { ...delivery, rowCount: rows.length };
    },
    bitbrowser_assess_windows: (args) => assessWindows({ ...args, api }),
    bitbrowser_prepare_management: async ({ request }) => {
      const plan = await prepareManagement(request, { api });
      await store.save(plan);
      return {
        planId: plan.id,
        // 可直接传给对应工具，不要求模型重新提取或拼写 UUID；仍绑定这一具体计划。
        executeArguments: { planId: plan.id },
        inspectArguments: { planId: plan.id },
        expiresAt: plan.expiresAt,
        request: plan.request,
        targets: plan.targets,
        effect: plan.effect,
        status: 'prepared',
      };
    },
    bitbrowser_execute_management: async ({ planId }) => {
      const plan = await store.load(planId);
      // Digest verifies unchanged intent. Host authorization must already cover this invocation.
      const { recordFile, ...result } = await executeManagement(plan, {
        api,
        workspace: stateDir,
        approval: plan.digest,
      });
      return result;
    },
    bitbrowser_inspect_operation: async ({ planId }) =>
      inspectOperation(await store.load(planId), { api, workspace: stateDir }),
  };
  return {
    async call(name, args = {}) {
      const tool = findTool(name);
      if (!tool) throw new SkillError('UNKNOWN_TOOL', '未知工具，请使用工具列表中的名称');
      const parsed = tool.schema.safeParse(args);
      if (!parsed.success)
        throw new SkillError('INVALID_ARGUMENT', '参数不符合工具 Schema；请检查字段、类型和必填项');
      return handlers[name](parsed.data);
    },
  };
}
