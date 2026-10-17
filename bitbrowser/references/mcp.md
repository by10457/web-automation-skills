# MCP 工具契约

入口为 adapters/mcp/stdio.js，使用官方 @modelcontextprotocol/sdk，协议能力由固定 SDK 版本决定。MCP 工具与 CLI 复用共享服务。输入对象拒绝未知字段。

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| bitbrowser_health | {} | available，仅表示 API 可达 |
| bitbrowser_doctor | {id?} | 环境检查；id 可选检查已有连接 |
| bitbrowser_list_windows | {} | 脱敏窗口数组 |
| bitbrowser_list_displays | {} | 显示器数组：id、label、bounds、workArea |
| bitbrowser_get_window | {id} | 脱敏详情 |
| bitbrowser_get_window_state | {id} | windowId、state、pid、observedAt |
| bitbrowser_list_tabs | {id} | windowId、tabs、snapshotId、observedAt，只有 JSON 数据 |
| bitbrowser_export_handoff | {selections:[{snapshotId,url,titleEvidence?}]} | rowCount、markdownPath、jsonPath、finalResponse；完整 rows 存在文件中 |
| bitbrowser_assess_windows | {count,ids?} | 数量、状态与缺口 |
| bitbrowser_prepare_management | {request} | planId、expiresAt、request、targets、effect |
| bitbrowser_execute_management | {planId} | 操作状态与逐项结果 |
| bitbrowser_inspect_operation | {planId} | 原操作记录和当前状态比较 |

request 的 action 支持 create/start/close/delete/clear/open-url/update/tab-activate/tab-reload/tab-close/fingerprint-random/arrange/arrange-flexible。参数见 [管理说明](management.md)；MCP 创建请使用 startupUrl，旧 url 别名只保留在 JS/CLI 兼容层。

随机指纹返回 `verification:configuration-readback`，证明配置回读一致，不证明网站运行时观察结果。排列返回 `verification:api-acknowledged`，仅证明 API 成功响应；inspect 对当前布局返回 unknown。即使顶层 completed，也必须向用户说明该验证级别。

```json
{"name":"bitbrowser_prepare_management","arguments":{"request":{"action":"start","ids":["真实窗口ID"]}}}
```

准备返回 planId 后，仅在授权覆盖目标和动作时调用 execute。计划默认 15 分钟有效。服务端保存计划，执行时再次校验摘要、服务、窗口身份和状态。摘要和 ID 不构成用户授权证明，宿主应配置自己的工具执行策略。

成功返回 `{ok:true,data}`。失败返回 `{ok:false,error:{code,message,retryable}}`，MCP 设置 isError，content 文本和 structuredContent 使用相同结果。部分完成或结果不确定时保留 data 并返回 OPERATION_UNCERTAIN，不要因为收到 HTTP 响应就当成任务成功。

窗口连接通过 /browser/open 获取地址，存在外部关闭窗口导致的竞态，因此 list_tabs 和带连接的 doctor 使用保守工具注解，不将其标记为绝对无副作用。工具注解仅是提示，不替代服务端检查或宿主授权策略。

所有客户端应使用一致的 BITBROWSER_COORDINATION_DIR；同一计划恢复还必须使用原 BITBROWSER_STATE_DIR。未知锁占用应先核对持有进程，不自动删除。未提供任意 API、任意 JS、Cookie 读取或调试地址导出工具。

## 交接文件扩展

`bitbrowser_list_tabs` 额外返回服务端 `snapshotId`、`observedAt`。`bitbrowser_export_handoff` 接受 `selections` 数组（每项 snapshotId、唯一匹配的 url，可选 titleEvidence.account/equals），返回 rowCount、markdownPath、jsonPath、finalResponse。完整 rows 保存在 JSON/Markdown，不在 MCP 响应重复展开；需要机器读取时读取 jsonPath。共享 JS exportHandoff 仍返回 rows。该工具只读取快照并写本地文件，不连接或修改浏览器；readOnlyHint 为 false 是因为写文件。没有标题业务约定时状态 unknown；title-matched 不是通用登录证明。最终交接直接使用 finalResponse 的两个链接，不附手写表格。旧 MCP 进程需重新加载才能使用新返回格式。

prepare 同时返回 executeArguments、inspectArguments，与原 planId 指向同一具体计划。优先原样复用对应对象作为 execute/inspect 参数；不使用隐式“最近计划”，不改变授权、摘要、有效期或幂等检查。直接传 `{planId}` 的旧调用仍兼容。
