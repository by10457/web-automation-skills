# 公开函数

公开接口位于 `scripts/index.js`。通过文件路径或 file URL 导入，示例采用项目根目录下的 skills/ 布局。

| 函数 | 参数 | 返回 |
|---|---|---|
| health | 可选 {api} | {available:true}，失败抛带 code 错误 |
| listWindows | 可选 {api} | [{id,name,seq,running}]，不含凭据 |
| listDisplays | 可选 {api} | [{id,label,bounds,workArea}]，可用于排列的 screenId |
| withBrowser | {id} 或 {name}, callback | callback 的返回值；finally disconnect |
| listTabs | browser | 含 targetId、url、title、page 的标签列表 |
| selectTab | tabs, {origin?,targetId?,url?} | 唯一匹配标签；歧义报错 |
| assessWindows | {count,ids?,api?} | 窗口候选、数量缺口及下一步，权限和配额未知时明确标记 |
| getWindow | {id,api?} | 不含凭据的基本详情 |
| prepareManagement | request, {api?,now?}? | 可供用户确认的管理计划，无写操作 |
| executeManagement | plan, {workspace,approval,api?} | 逐项管理结果及持久化记录 |
| doctor | {id?,api?}? | 环境检查列表和处理建议，不启动停止的窗口 |
| inspectOperation | plan, {workspace,api?} | 历史记录与当前状态的只读比较 |
| getWindowState | {id,api?} | windowId、state、pid、observedAt；缺少窗口时报错 |
| getTabs | {id,api?} | 纯 JSON 的 windowId 与 tabs；不返回 Page |

需要自定义本机端口时配置 BITBROWSER_API_URL，或构造 BitAPI 并传入 withBrowser 的第三参数 {api}。默认 127.0.0.1:54345。窗口名字可重复，执行时优先使用 ID。withBrowser 仅连接；管理接口使用 ManagementAPI，动作参数见 [窗口管理](management.md)。

```js
import {listWindows,withBrowser,listTabs,selectTab} from './skills/bitbrowser/scripts/index.js';
const windows=await listWindows();
// 由调用方根据用户指定名称/ID选择窗口，不默认取第一个账号。
await withBrowser({id:selectedId},async browser=>{
  const tabs=await listTabs(browser);
  const tab=selectTab(tabs,{origin:'https://example.com'});
  return {targetId:tab.targetId,url:tab.url};
});
```

## 交接快照

共享 API 导出 `saveTabSnapshot(result, { stateDir })` 和 `exportHandoff({ selections }, { stateDir })`。前者接收 getTabs 结果保存快照；后者从快照提取真实 ID、URL 和标题生成本地 JSON/Markdown，不访问浏览器。MCP 已自动完成快照保存，通常无需自行编写脚本。参数与证据边界见 [任务编排](workflows.md)。

共享 JS 导出结果保留 rows，并增加 finalResponse（生成文件的 Markdown 链接文本）。MCP facade 不展开 rows，改为 rowCount；完整数据读取 jsonPath。这是为避免自然语言交接再次手抄 ID 的响应差异，不改变生成文件内容。
