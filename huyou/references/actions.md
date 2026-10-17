# 单项操作与任务

以下示例从项目根目录执行，采用 skills/ 和 workspace/ 布局；路径按实际位置替换。输出统一为 JSON；正常退出 0，参数/上下文错误退出 1，提交不确定或历史 pending 阻止执行退出 2。

```powershell
node web-automation-skills/huyou/scripts/cli.mjs comments --binding my-circle --post POST_ID --workspace workspace
node web-automation-skills/huyou/scripts/cli.mjs prepare --task workspace/tasks/my-comment.json --workspace workspace
# 使用返回的 planFile（plan.json，不是 result.json）：
node web-automation-skills/huyou/scripts/cli.mjs rehearse --plan workspace/runs/huyou/RUN_ID/plan.json --workspace workspace
# 仅当用户已授权这项具体操作：
node web-automation-skills/huyou/scripts/cli.mjs execute --plan workspace/runs/huyou/RUN_ID/plan.json --workspace workspace
node web-automation-skills/huyou/scripts/cli.mjs reconcile --plan workspace/runs/huyou/RUN_ID/plan.json --workspace workspace
```

## 任务格式

帖子点赞（发送快捷菜单中的点赞表情）：
```json
{"version":2,"binding":"my-circle","action":"like-post","target":{"postId":"POST_ID"}}
```

帖子点赞使用快捷菜单中标为“点赞”的表情；实现按标签及图片文件标识定位，顺序变化不影响选择。点击此表情会立即提交，所以只有 execute 点击。prepare/rehearse 仅展开并核对，结束收起。与 like-comment 的评论点赞不同，该操作不具有可推定的取消点赞状态；重复记录或已加载评论中同账号的同表情会阻止重发。成功核对要求新增的同账号点赞表情图片评论，公共计数增加不能单独证明成功。无法识别提交结果时返回 uncertain，不重试。

评论：
```json
{"version":2,"binding":"my-circle","action":"comment","target":{"postId":"POST_ID"},"content":{"text":"由用户确定的评论正文"}}
```

回复顶层评论：
```json
{"version":2,"binding":"my-circle","action":"reply","target":{"postId":"POST_ID","comment":{"authorName":"COMMENT_AUTHOR","text":"COMMENT_TEXT"}},"content":{"text":"针对该评论的具体回复"}}
```

评论点赞：
```json
{"version":2,"binding":"my-circle","action":"like-comment","target":{"postId":"POST_ID","comment":{"authorName":"COMMENT_AUTHOR","text":"COMMENT_TEXT"}}}
```

纯文本发布：
```json
{"version":2,"binding":"my-circle","action":"publish","content":{"text":"由用户确定的发布正文"},"publication":{"statement":"内容由AI生成"}}
```

声明使用页面原文：无需声明、内容由AI生成、内容为个人观点和见解、内容为转载信息、内容为虚构演绎、内容含营销信息。根据实际内容选择，不自动伪造来源。在已选圈子发布，可通过 publication.board 选择该圈子中实际存在的分区；附件尚不支持，不能静默忽略参数。

POST_ID、COMMENT_AUTHOR、COMMENT_TEXT 和 my-circle 均为占位符，运行前替换为查询目标和配置绑定。示例不授予发送权限。

## 文件与状态

- runs/huyou/运行ID/request.json：本次命令。
- runs/huyou/运行ID/plan.json：prepare 生成的计划，含账号头像、完整目标、正文及 SHA-256 摘要。摘要用于检测误改，不是身份签名或授权凭据。
- runs/huyou/运行ID/result.json：结果、证据与清理警告。
- operations/huyou/操作键.json：提交前持久化 pending，完成后更新 verified-ui/uncertain。任务内容、账号、圈子、帖子及评论目标共同决定操作键；重建计划仍会遇到已有记录。
- locks/窗口ID.lock：同 workspace 下该窗口串行。崩溃遗留锁只在确认旧进程已退出后人工清理。

状态：ready=可供授权执行的计划；rehearsed=填表验证但 submitted:false；verified-ui=得到页面证据；skipped-already-liked/skipped-duplicate=未再提交；uncertain/blocked-uncertain=不能重发。reconcile 仅凭肯定证据更新结果，不能因为“没看到”就允许重试。计划过期仍可只读 reconcile。

## 证据与局限

评论/回复检查出现新增的同账号昵称与头像、同文内容，回复还要求位于原评论的 replies 容器；点赞检查 aria 状态或图标变化加计数增长。发布要求返回圈子列表，出现近期的同账号同文新帖子 ID。均再次短暂等待并复读，以发现立即回滚；这些是 UI 证据，不是直接服务端回执。点赞图标既非适配器支持的未赞图标，又无明确 aria 状态时停止，不能根据计数猜测已赞。

没有评论 UID 时，昵称+头像+完整正文必须唯一。当前只支持目标为顶层评论，回复结果可出现在楼中楼。评论列表只读已加载部分，不自动滚动或扩展更多评论。帖子删除、修改、账号变化、输入框禁用、验证挑战等都会停止或标为不确定，不绕过验证。

保留原有草稿：prepare/rehearse/execute 开始时检测已有文本/附件；不覆盖。演练结束只清理仍与工具输入一致的文本。提交不确定时保留现场。如果出现 cleanupWarning，先人工检查页面，不把演练结果当作页面已恢复。

## 验证

纯单元测试：`node --test bitbrowser-agent-kit/tests/*.test.js web-automation-skills/huyou/tests/*.test.mjs`。

离线浏览器测试：`node web-automation-skills/huyou/tests/browser.mjs --id 已运行窗口ID`。会创建隔离浏览器上下文，所有请求都由本地夹具应答或拦截；不使用真实登录数据、不提交网站内容，结束关闭该上下文并保留原窗口。

发布支持 publication.board 指定页面实际存在的分区名称。页面列出分区但没有选中时，prepare 返回 BOARD_REQUIRED，必须选择后才能提交；提交前重新核对分区。
