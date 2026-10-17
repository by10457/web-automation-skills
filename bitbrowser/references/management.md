# 窗口管理

公开接口从 scripts/index.js 导出，实现在 src/services/management.js。管理与连接分开：withBrowser 只连接已运行窗口，prepareManagement/executeManagement 用于显式改变窗口状态。

## Agent 决策流程

1. health 检查本地服务，assessWindows({count}) 查询现有窗口数量与缺口。软件不可用时报告原因，不创建环境绕过错误。
2. 根据用户指定账号和用途选定窗口。数量足够不等于账号正确；候选多于需求时要求选择，不自动取前几个。
3. 用户要求使用 N 个窗口但窗口不足时，说明现有数量、缺口及拟创建名称，询问是否创建缺少的窗口，停在这里等待回复。例如需要 3 个、现有 2 个可用，询问创建 1 个，而非再创建 3 个。只有用户明确要求全新窗口时按全新数量准备。
4. 生成具体计划，说明作用范围。创建、删除、清 Cookie 必须有相应的明确用户授权；仅要求访问网站或发帖不代表同意创建环境、删除窗口或清理登录状态。已有针对该具体操作的同意无需重复询问。
5. 用户同意后执行计划，核对返回结果。用户不同意则停止相关操作。数字摘要和 CLI 参数只能记录调用方已取得授权，不能作为用户同意的替代证据。
6. 窗口就绪后再调用网站技能。新窗口没有自动继承网站登录；要求用户完成登录后再核对账号及站点任务。

窗口列表不提供可靠的套餐剩余额度和员工创建权限，assess 返回 unknown/null。不要把截图套餐数或历史数据当实时配额。接口返回 PERMISSION_DENIED/QUOTA_EXCEEDED 时报告对应限制；普通 API_REJECTED 不要猜原因，不自动购买套餐、改权限或反复尝试创建。子账号若需要分组，先确定有权限的 groupId，再创建。

## 请求格式

| action | 参数 | 行为 |
|---|---|---|
| create | names 数组，或 count + namePrefix? + startIndex?；startupUrl?、groupId? | 创建窗口配置，默认名称 1、2、3；不自动启动 |
| start | ids | 启动指定窗口；已运行则跳过 |
| close | ids | 关闭指定窗口；已关闭则跳过 |
| delete | ids | 删除已关闭窗口；运行中拒绝删除，不自动关闭 |
| clear | ids、data=cookies/cache/both | 清理已运行窗口的指定浏览器数据 |
| open-url | ids、url | 在已运行窗口复用完全相同 URL 的标签，或新建标签访问 |
| update | ids、changes={name?,remark?} | 仅更新指定字段；改名要求单个窗口，且不能与其他窗口重名 |
| fingerprint-random | ids | 已关闭窗口随机一次指纹，回读配置；不自动重启 |
| arrange | ids、layout | 按宫格或对角线排列已运行目标，API 确认级别 |
| arrange-flexible | ids | 将 ID 转为经核对的唯一序号后自适应排列，不允许空目标 |
| tab-activate | ids=[单个窗口ID]、targetId | 激活指定标签 |
| tab-reload | ids=[单个窗口ID]、targetId | 刷新指定标签，等待 DOM 加载 |
| tab-close | ids=[单个窗口ID]、targetId | 关闭指定标签并核对它已不存在 |

startupUrl 设置窗口的账号平台网址，影响后续启动；open-url 只作用于当前运行窗口的标签，不修改启动配置。创建时旧参数 url 作为 startupUrl 的兼容别名保留，两者不能同时提供。省略 startupUrl 不配置业务网站，客户端仍可能打开自己的工作台。

修改使用官方 /browser/update/partial，只提交 ids、空 browserFingerPrint 与指定 name/remark，不读取并回写整个配置。执行前核对字段未发生变化；备注可设为空字符串。标签 targetId 来自 listTabs，窗口重启后必须重新查询；不以标题或索引替代 ID。刷新、关闭可能丢失未保存输入。

executeManagement 可传 timeoutMs（默认 15000，最大 120000）和 pollIntervalMs（默认 300）。CLI 对应 --timeout-ms、--poll-interval-ms。创建、删除、启动、关闭和字段修改均通过有限轮询核对结果，只重复查询，不重复写入；单次 API 请求的等待可能让实际总时长超过该轮询时限。

名称和 ID 列表最多 100 项。同名创建请求停止，不覆盖既有环境。创建只提供基础配置：直连网络、创建时随机指纹、可选网站与分组。通过空 browserFingerPrint 对象请求生成随机指纹；randomFingerprint=false 表示不要求每次启动重新随机。不会填写登录凭据、克隆 Cookie 或修改已有窗口指纹。需要高级代理等配置时扩展明确的参数接口，不传未知字段。

清理范围为运行窗口的 Cookie 和 HTTP 缓存，通过浏览器调试协议执行。Cookie 清理可能导致该窗口各网站退出登录；cache 不等于浏览历史、localStorage、IndexedDB 或账号密码。不会清除比特云端同步副本或预配置 Cookie；这些数据可能在后续同步中恢复。返回 acknowledged 仅表示协议接受，不保证清理后数据不会由活动网页重新生成。清理临时创建并关闭一个空白标签，保留其余标签。

## 函数调用

```js
import {assessWindows,prepareManagement,executeManagement}
  from './skills/bitbrowser/scripts/index.js';

const inventory=await assessWindows({count:3});
// 根据 inventory 向用户说明缺口，并确定是否创建及名称。
const plan=await prepareManagement({action:'create',names:['1','2','3']});
// 仅在用户同意该具体计划后执行：
const result=await executeManagement(plan,{
  workspace:'./workspace',approval:plan.digest
});
```

prepare 不改变窗口；计划含目标、效果、服务地址和 15 分钟有效期。execute 校验摘要、服务地址、目标身份与状态。审批期间目标变化或计划过期时重新准备。getWindow({id}) 只返回基本详情，不返回 Cookie、账号密码或代理密码。

## CLI

在项目根目录执行，路径按实际布局替换。示例中的 WINDOW_ID、example.com 和创建数量需按实际需求填写。

```powershell
node skills/bitbrowser/scripts/cli.js assess --count 3
node skills/bitbrowser/scripts/cli.js detail --id WINDOW_ID
node skills/bitbrowser/scripts/cli.js manage-prepare --request skills/bitbrowser/examples/create-three.json --out workspace/window-plan.json
# 取得用户同意后，将 DIGEST 替换为该计划的 digest
node skills/bitbrowser/scripts/cli.js manage-execute --plan workspace/window-plan.json --workspace workspace --approved-digest DIGEST
```

输出文件必须使用未占用路径，避免覆盖待确认计划。可复用请求见 [创建](../examples/create-three.json)、[启动](../examples/start.json)、[关闭](../examples/close.json)、[删除](../examples/delete.json)、[清 Cookie](../examples/clear-cookies.json)、[访问网页](../examples/open-url.json)。

新增请求示例：[修改名称与备注](../examples/update.json)、[刷新标签](../examples/tab-reload.json)。标签激活和关闭使用相同参数，将 action 分别设为 tab-activate 或 tab-close。

## 记录与失败

同一服务地址的多个实例通过本机共享文件协调请求，默认间隔 300 ms。协调位置见 [接入说明](setup.md)。该机制只约束使用本技能且共享配置的调用方，不约束其他工具。遇到明确限流时，只读接口最多退避重试 3 次；写入不自动重试，返回 RATE_LIMITED。执行后额外查询失败时，用 [结果核对](diagnostics.md) 检查状态，不重复执行已完成动作。

管理记录保存在 workspace/bitbrowser/operations/计划ID.json，窗口互斥使用共享协调目录。点击或 API 调用前记录 pending。一般动作按目标顺序执行，失败后停止；排列先为全部目标写 pending，再发一次整批请求。保留已完成项，不自动回滚删除。

completed 表示各项完成或被正确跳过；partial/needs-attention 表示需处理。超时或缺少证据返回 uncertain，再运行同一计划只返回记录，不重新操作。检查实际窗口后，只为尚未完成且结果已确定的部分生成新计划，不盲目重建整批。记录损坏、遗留锁或落盘失败时停止。锁不协调人工或其他程序操作；不同 workspace 不共享防重。

## 随机指纹与排列

随机指纹调用官方 `/browser/fingerprint/random`，body 使用 browserId；返回的是指纹对象。核心保存期望字段摘要并回读 `/browser/detail`，匹配后标记 `fingerprint-randomized` 和 `configuration-readback`。无法确认保存时返回 uncertain，不额外调用修改接口猜测补救。关闭要求是本封装的保守约束，不声称官方硬性要求；不改变每次启动随机开关，不保证下次启动或网站观察到的具体值。

指纹回读摘要排除响应表示可能不同的 firefoxVersionMap/defaultAccuracy 辅助字段及记录元数据，其他配置差异仍会导致验证失败。RESOURCE_EXHAUSTED 表示客户端因内存不足或使用率过高拒绝请求；释放资源后先检查状态，不自动关闭其他应用或重放旧计划。

`arrange` 的 layout 全字段示例：

```json
{"action":"arrange","ids":["WINDOW_ID"],"layout":{"type":"box","startX":0,"startY":0,"width":500,"height":400,"col":2,"spaceX":0,"spaceY":0,"offsetX":30,"offsetY":30,"orderBy":"asc"}}
```

type 支持 box/diagonal；宽 >=500、高 >=200、col >=1；整数坐标允许负值。可选 screenId 必须来自 displays 查询。自适应请求 `{ "action":"arrange-flexible", "ids":["WINDOW_ID"] }` 不接受 screenId，官方该接口仅支持 seqlist，核心按真实 ID 转换并校验。

排列返回每项 `status:api-acknowledged`、`verification:api-acknowledged`。completed 只表示 API 操作已确认，不能说实际布局已验证；官方没有布局回读接口，inspect 当前布局保持 unknown。

请求文件：[随机指纹](../examples/fingerprint-random.json)、[宫格排列](../examples/arrange.json)、[自适应排列](../examples/arrange-flexible.json)。将占位 ID 替换为真实目标后，通过原有 manage-prepare/manage-execute 执行。

官方依据：[比特浏览器接口](https://doc.bitbrowser.cn/api-jie-kou-wen-dang/liu-lan-qi-jie-kou)、[浏览器调试协议 Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)。


MCP 入口使用服务端保存的 planId，无需向模型提供文件路径或 approved-digest。CLI 的 approved-digest 仅检查计划内容一致，不验证授权来源。创建已迁移到官方 `/browser/add`，不会自动回退到旧接口。窗口互斥由共享协调目录控制，workspace 只负责操作记录和计划重放。
