# 通用调用、恢复与记录

所有接口从 scripts/index.js 导入。workspace 始终表示配置、锁和结果的宿主目录，相对路径相对于进程工作目录；从不同目录启动时建议传绝对路径。

## 统一动作入口

`prepareInteraction({workspace,binding,action,target?,content?,publication?,targetId?})` 与 `executeInteraction({workspace,plan,mode?,targetId?})` 支持 like-post、like-comment、comment、reply、publish、follow-user。mode 为 execute（默认）、rehearse 或 reconcile。接口自行获取窗口锁，不要放在 withHuyou 的回调内调用。准备结果同时包含计划和 runDir/planFile；执行入口负责去掉这些元数据。

原 prepareLikePost/likePost 等接口保留。原 prepareFollowUser(page,binding,target)/followUser(page,binding,plan,{workspace}) 保留为会话内兼容接口；新编排统一使用 prepareInteraction/executeInteraction。follow-user 的 target 为 `{postId:'字符串 ID'}`，在详情弹窗关注作者。它也可通过 prepare/execute CLI 和已有批次接口执行。

## 批量指定帖子及作者

先完成 withHuyou + queryPosts 并释放窗口锁，再调用：

```js
const prepared = await preparePostInteractions({
  workspace, binding, queryResult, action:'follow-user',
  excludeSelfName:'本账号昵称', targetId
});
// prepared.planFile 是文件路径，读取 JSON 后传给已有 runBatch。
```

action 支持 like-post、follow-user；follow-user 默认按作者昵称与头像文件标识去重，非 UID 去重。点赞默认每个帖子一次。excludeSelfName 为可选任务策略；同名不能证明同一用户。queryResult.complete=false 默认拒绝，只有明确接受部分范围才设置 allowPartial:true。此入口只准备，不自动执行。批次每条保存检查点，不确定或恢复警告会停止该窗口后续任务；其他窗口独立处理。

## 不确定结果与页面恢复

`classifyInteractionResult(result)` 返回 decision：continue、reconcile、stop；未知错误默认 stop，所有结果都不建议自动重发。先保存并分析结果，不要用空 catch 忽略账号变化、草稿或页面错误。

`recoverInteractionPage({workspace,binding,targetId?})` 会检查登录账号及草稿，将当前详情和截图保存到 workspace/recovery，然后关闭详情。存在草稿则停止，不清空输入。它不改变任何操作记录，也不把 uncertain 变成成功。恢复后只能核对原操作或处理另外明确的目标，不得重发原操作。

快捷点赞是表情评论。当前自动核对只覆盖已加载普通评论中能识别的本人点赞表情，不能保证覆盖独立表情评论区。uncertain 结果附 verification，包含核对方法及提交期间观察到的 POST 响应路径和状态；不保存请求体、Cookie 或 URL 查询参数。响应可能包含其他页面请求，HTTP 200 或计数增长都不能单独判成功。缺少证据时保留 uncertain，使用独立核对或用户确认。

## 操作历史与外部执行记录

- `listOperations({workspace,status?,limit?})`：读取历史，返回 operations、complete、total；limit 默认100，最多1000。
- `recordOperationEvidence({workspace,plan,source,note,confirmed?})`：按原计划的操作键写入记录，不触发网页操作。source 为 external-execution 或 user-confirmation，note 必填。外部点击默认 external-unverified 并阻止重发；用户明确确认成功后才传 confirmed:true，标记 confirmed-by-user，保留来源和历史。

必须使用对应的真实计划，不凭昵称或硬编码跳过列表伪造计划。外部记录缺少提交前基线时，reconcile 不会猜测成功。此接口不提供删除记录或解除防重。人工确认是调用方传递的用户证据，不是脚本独立验证。

## 返回字段

帖子使用 `p.id`、`p.author.name`、`p.publishedLabel`；评论使用 `c.authorName`、`c.time`、`c.stickers`，不能用帖子的结构套评论。数据类型见 scripts/contracts.d.ts。例如：

```js
queryResult.posts.map(p => ({postId:p.id,authorName:p.author.name,time:p.publishedLabel,text:p.text}));
commentsResult.comments.map(c => ({authorName:c.authorName,text:c.text,stickers:c.stickers}));
```
## 残留草稿与核对

文本动作在输入前记录意图，完整输入后将归属写入 workspace/drafts。记录包含原计划摘要、窗口绑定、标签 ID、完整文本和输入框目标。输入中断、文本被修改、标签被重新创建或旧版本未保存归属时，不能自动认领。

`recoverOwnedDraft({workspace, plan, targetId})` 仅清理原计划拥有的完整草稿，清理前保存截图和记录。它重新检查账号、圈子、帖子/回复目标和表单；其他草稿、附件或无法核实的表单会阻止清理。此接口自己连接并锁定窗口，不接受 page，不应在 withHuyou 回调中调用。

```js
await recoverOwnedDraft({workspace, plan, targetId});
const result = await executeInteraction({workspace, plan, targetId, mode:'reconcile'});
```

恢复不会删除 operations 记录，也不代表提交失败。曾进入提交阶段的动作只能先核对，不能因为草稿清空而重发。没有提交记录时，reconcile 返回 NO_OPERATION；此时检查原运行记录，按正常执行流程处理。

reconcile 先读取当前目标的结果，再尝试准备读取位置。草稿挡住核对时返回 uncertain、error.code 和 nextAction，并在操作日志保存 lastReconciliation；不会点击提交。旧计划仍可核对，但过期计划不能重新提交。快捷点赞仍不能仅凭计数增长或 HTTP 成功确认本人操作。
