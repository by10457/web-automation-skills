# 多窗口批次

批次将明确的单项任务按窗口排队执行，并保存检查点和汇总结果。不会自动生成评论、改变账号绑定、定时运行或自动选择“最新 10 人”。需要先用 queryPosts 或 preview 读取候选，再把确定的目标和正文写进任务清单；这样准备与执行之间不会偷偷换目标。

## 任务

version:3 的 items 各自含唯一 id 和完整 version:2 task，可选 targetId 用于同窗口多个狐友标签。支持全部五类单项操作。最多 100 项，concurrency 默认 1，可设 1–4；intervalMs 默认 1000，可设 0–60000，表示同一窗口任务完成后的等待时间。不同窗口不保证全局任务顺序；同一物理窗口即使有多个绑定名称也串行。

```json
{
  "version": 3,
  "concurrency": 1,
  "intervalMs": 1000,
  "items": [
    {"id":"first-post-like","task":{"version":2,"binding":"my-circle","action":"like-post","target":{"postId":"POST_ID"}}},
    {"id":"second-window-publish","task":{"version":2,"binding":"other-circle","action":"publish","content":{"text":"由用户确定的正文"},"publication":{"statement":"内容为个人观点和见解"}}}
  ]
}
```

示例中的绑定和 POST_ID 为占位符，运行前替换。另见 [batch.example.json](../examples/batch.example.json)。

## 命令

以下示例从项目根目录执行，路径按实际布局替换：

```powershell
node web-automation-skills/huyou/scripts/cli.js batch-prepare --task workspace/tasks/batch.json --workspace workspace
# 用上一步返回的 planFile 替换下面的路径
node web-automation-skills/huyou/scripts/cli.js batch-rehearse --plan workspace/batches/BATCH_ID/plan.json --workspace workspace
# 用户已明确授权清单中的账号、目标与内容后，执行真实操作
node web-automation-skills/huyou/scripts/cli.js batch-execute --plan workspace/batches/BATCH_ID/plan.json --workspace workspace
# 只核对未确定操作，不重新提交
node web-automation-skills/huyou/scripts/cli.js batch-reconcile --plan workspace/batches/BATCH_ID/plan.json --workspace workspace
```

已有具体授权不重复确认。开发、测试或生成任务清单不意味着授权发送测试内容。

prepare 对所有任务准备子计划，任何准备失败使整份批次 blocked，不能执行。计划仍保持单项 15 分钟有效期，从各项 prepare 时计算；长批次可能在运行中到期，需拆成较小批次。不会自动延期或刷新目标。

## 保存与恢复

`workspace/batches/批次ID/` 中保存 request.json、带摘要的 plan.json、rehearsal.json 和 execution.json。单项详情仍保存在 runs，真实操作记录仍在 operations。不要手工改检查点或删除操作记录。

再次运行相同 batch-execute/ batch-rehearse 命令即继续该模式的 queued 项；已完成项跳过。演练和真实执行使用独立检查点。调用子任务前保存 running；崩溃残留 running 在恢复时转为 uncertain，不自动重试。摘要仅检测误改，不是授权签名。

同一窗口出现 failed、uncertain、blocked-uncertain 或清理警告后，其后续 queued 项停止，其他窗口可继续。batch-reconcile 只核对 uncertain 项；取得肯定证据后，再运行 batch-execute 可继续该窗口后续项。找不到操作记录或证据不足时保留 uncertain，不据此重发。failed、计划过期或清理警告需人工处理页面，再为剩余明确任务准备新批次，已提交操作仍受单项防重约束。

创建批次目录中的 STOP 文件可要求停止派发新任务：

```powershell
New-Item -ItemType File -Path workspace/batches/BATCH_ID/STOP
# 要恢复时，确认具体批次路径后删除该标记，再运行原命令
Remove-Item -LiteralPath workspace/batches/BATCH_ID/STOP
```

STOP 在每次派发前检查；已经开始的操作会完成及核对，不强行中断点击。reconcile 是只读核对，不受 STOP 限制。间隔等待期间最多延迟 intervalMs 才检查；直接终止进程可能留下锁与 uncertain 项。确认旧进程结束后才能清理对应锁。

## 结果

ready：准备完毕；completed：该模式下所有任务完成且没有清理警告；needs-attention：有 queued/failed/uncertain 或清理警告。counts 汇总各状态，items 包含各任务结果和 runDir。非完整成功的批次退出码为 2，格式/锁等错误为 1。

只在同一 workspace 内协调锁与防重。不同批次争用同一窗口可能因 WINDOW_BUSY 停止，不构成跨进程全局队列。默认并发 1；并发控制不协调人工操作或其他软件的窗口使用。
