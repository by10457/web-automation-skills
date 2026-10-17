/** Agent-facing tool contracts. Strict schemas keep accidental fields away from browser APIs. */
import { z } from 'zod';
import { phaseTwoSchemas } from './window-operations.js';

const id = z
  .string()
  .regex(/^[a-zA-Z0-9-]+$/)
  .min(1)
  .max(128);
const ids = z.array(id).min(1).max(100);
const pageUrl = z.url().max(8192);
const selector = z.strictObject({ id });
const planSelector = z.strictObject({ planId: z.uuid() });

/** Management semantics remain validated again by the shared domain service. */
const managementRequest = z.discriminatedUnion('action', [
  ...phaseTwoSchemas,
  z.strictObject({
    action: z.literal('create'),
    // 在工具字段说明中明确两种创建方式互斥，避免调用方同时传入 names/count。
    names: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(100)
      .describe('指定名称创建。与 count、namePrefix、startIndex 互斥；数量由数组长度决定。')
      .optional(),
    count: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe('自动命名创建的数量。仅未提供 names 时使用，可搭配 namePrefix/startIndex。')
      .optional(),
    namePrefix: z.string().max(100).optional(),
    startIndex: z.number().int().min(1).max(1000000).optional(),
    groupId: id.optional(),
    startupUrl: pageUrl.optional(),
  }),
  ...['start', 'close', 'delete'].map((action) =>
    z.strictObject({ action: z.literal(action), ids }),
  ),
  z.strictObject({ action: z.literal('clear'), ids, data: z.enum(['cookies', 'cache', 'both']) }),
  z.strictObject({ action: z.literal('open-url'), ids, url: pageUrl }),
  z.strictObject({
    action: z.literal('update'),
    ids,
    changes: z.strictObject({
      name: z.string().trim().min(1).max(100).optional(),
      remark: z.string().max(2000).optional(),
    }),
  }),
  ...['tab-activate', 'tab-reload', 'tab-close'].map((action) =>
    z.strictObject({
      action: z.literal(action),
      ids: z.array(id).length(1),
      targetId: z.string().min(1).max(256),
    }),
  ),
]);

/** Stable, deliberately small tool surface; no arbitrary HTTP or JavaScript execution tool. */
export const toolDefinitions = [
  {
    name: 'bitbrowser_list_displays',
    description: '读取官方显示器 ID、名称及工作区尺寸；排列窗口的 screenId 必须从这里获取。',
    schema: z.strictObject({}),
    readOnly: true,
  },
  {
    name: 'bitbrowser_health',
    description: '检查比特本地 API 是否可达；不能据此判断软件是否安装或网站是否登录。',
    schema: z.strictObject({}),
    readOnly: true,
  },
  {
    name: 'bitbrowser_doctor',
    description:
      '检查 Node、Puppeteer、本地 API；可选 id 检查已运行窗口连接。不会主动启动停止的窗口。',
    schema: z.strictObject({ id: id.optional() }),
    readOnly: false,
  },
  {
    name: 'bitbrowser_list_windows',
    description: '查询真实窗口 ID、名称、序号和运行状态。先查询，再按用户用途选择；不要猜测 ID。',
    schema: z.strictObject({}),
    readOnly: true,
  },
  {
    name: 'bitbrowser_get_window',
    description: '查询指定窗口的脱敏详情。id 是窗口 ID，不是序号或标签页 targetId。',
    schema: selector,
    readOnly: true,
  },
  {
    name: 'bitbrowser_get_window_state',
    description: '查询指定窗口当前进程状态。API 错误或窗口不存在会报错，不会伪报 stopped。',
    schema: selector,
    readOnly: true,
  },
  {
    name: 'bitbrowser_list_tabs',
    description:
      '读取已运行窗口标签及 snapshotId。保留快照引用，用 export_handoff 自动生成完整交接文件，避免手抄 ID/URL。连接结束后断开调试连接，保留窗口。',
    schema: selector,
    readOnly: false,
  },
  {
    name: 'bitbrowser_export_handoff',
    description:
      '从 list_tabs 快照生成完整交接文件，不再次查询浏览器。成功后直接使用 finalResponse 作为交接回复，只提供两个文件链接，不附加手写表格、ID/URL 摘要。完整 rows 在文件中。titleEvidence 仅用于明确约定标题可证明账号的站点；缺省状态 unknown。目标变化后先重新核验。',
    schema: z.strictObject({
      selections: z
        .array(
          z.strictObject({
            snapshotId: z.uuid(),
            url: pageUrl,
            titleEvidence: z
              .strictObject({
                account: z.string().trim().min(1).max(200),
                equals: z.string().min(1).max(2000),
              })
              .optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    readOnly: false,
  },
  {
    name: 'bitbrowser_assess_windows',
    description: '只读评估所需窗口数量、候选和缺口；不创建或启动窗口。',
    schema: z.strictObject({ count: z.number().int().min(1).max(100), ids: ids.optional() }),
    readOnly: true,
  },
  {
    name: 'bitbrowser_prepare_management',
    description:
      '生成并保存具体计划，返回目标、影响及 executeArguments/inspectArguments。核对授权后原样复用 executeArguments 调用 execute，不手打或截取 planId。准备不修改浏览器。支持 fingerprint-random、arrange、arrange-flexible；排列成功仅代表 API 确认。',
    schema: z.strictObject({ request: managementRequest }),
    readOnly: false,
  },
  {
    name: 'bitbrowser_execute_management',
    description:
      '原样使用 prepare 返回的 executeArguments 执行具体计划。仅在用户已授权目标和动作后调用；planId 不是授权证明。无效 UUID 先检查原始引用；不确定时用原 inspectArguments 核对，不新建计划盲目重试。',
    schema: planSelector,
    readOnly: false,
  },
  {
    name: 'bitbrowser_inspect_operation',
    description: '只读核对原计划、操作记录和当前状态。unknown 不代表可以重新执行。',
    schema: planSelector,
    readOnly: true,
  },
];

/** Find a public tool by its stable name; unknown tools are never dispatched. */
export function findTool(name) {
  return toolDefinitions.find((tool) => tool.name === name);
}
