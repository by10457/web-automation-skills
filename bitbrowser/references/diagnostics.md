# 环境诊断与结果核对

`doctor({id?})` 返回 `{status,checks}`，检查 Node 版本、依赖可加载性、本地服务、窗口列表。id 可选；提供后检查已有窗口连接并返回标签数量。连接检查沿用 withBrowser，不自动启动停止的窗口，不读取登录存储。ready 仅表示这些检查通过，不表示网站已登录、权限或套餐额度足够。

`inspectOperation(plan,{workspace})` 读取原计划、操作记录和当前窗口状态，不执行写入、不修改记录、不自动生成重试任务。支持自定义 `{api}`。

每项分别返回 recordedStatus 和 state：

- desired-state：当前已达到所需状态，不等于可以证明是该次操作造成的。
- not-in-desired-state：当前没有达到目标，不等于历史上从未成功。
- unknown：证据不足；禁止把它理解为可安全重复操作。

创建有记录中的 ID 且名称匹配时才能确认当前结果；仅发现同名窗口仍为 unknown。启动、关闭、删除和修改字段按当前状态核对。清理、访问和标签操作不根据瞬时状态推断历史成功，返回 unknown 并保留 recordedStatus。页面可能重新生成缓存，窗口和标签也可能被人工改变。

```powershell
node scripts/cli.js doctor
node scripts/cli.js doctor --id WINDOW_ID
node scripts/cli.js inspect-operation --plan PLAN_FILE --workspace WORKSPACE_DIRECTORY
```

限流只读查询最多退避重试 3 次；写入请求不自动重试。COORDINATION_BUSY 表示共享请求锁等待超时；检查协调目录锁文件中的进程是否仍然运行，无法确认时停止，不自动抢占锁。API 超时后的写入结果必须先核对。
