# 上下文读取与快照预览

以下示例从项目根目录执行，采用 skills/ 和 workspace/ 布局；路径可替换。查询接口见 [api.md](api.md)，写操作见 [actions.md](actions.md)。

```powershell
node bitbrowser-agent-kit/scripts/cli.js windows
node skills/huyou/scripts/cli.mjs inspect --id WINDOW_ID
node skills/huyou/scripts/cli.mjs preview --task workspace/tasks/preview.json --workspace workspace
```

inspect 返回账号、圈子和数量。preview 使用 config/huyou-bindings.json 中指定的绑定，保存 task、snapshot、plan、result；仅对已加载列表选候选，不滚动或提交。

任务格式见 [task.example.json](../examples/task.example.json)：version=1、action=inspect-posts、execution.mode=preview。selection.limit 为 1–100；order 为 newest/display；distinctBy 为 none/authorName/author。author 要求稳定作者 UID，缺失时返回 AUTHOR_ID_UNAVAILABLE；authorName 按昵称近似去重。

预览计划不可直接执行。单项 prepare 生成 version:2 计划，批次使用 version:3 清单；这些数字表示数据格式版本，不是执行顺序。

CLI 成功输出 `{ok:true,data:...}`，异常输出 `{ok:false,error:{code,message}}` 并退出 1。LOGIN_REQUIRED 要求手动登录；ACCOUNT_MISMATCH/CIRCLE_MISMATCH 要求核对绑定；ORDER_NOT_VERIFIED 要求切换新发；WINDOW_BUSY 要求检查占用。崩溃遗留锁仅在确认旧进程结束后清理。
