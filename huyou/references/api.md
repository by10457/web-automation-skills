# 给调用方 Agent 的公开接口

查询抽样、固定评论、批次执行和文件交接可使用新增的 `createPostWorkflow`，详细参数见 [帖子互动工作流](post-workflow.md)。实现及专用 CLI 使用普通 `.js`；本文件下方原接口保持兼容。

使用 Node.js 22.12+。以文件路径/file URL 导入 huyou/scripts/index.js；浏览器模块及外部 page 接入见 [接入说明](setup.md)。公开接口由 index.js 导出，不依赖 lib 内部路径。

## 连接和读取

```js
import {withHuyou,queryPosts,resolvePost,getPost} from './web-automation-skills/huyou/scripts/index.js';
const result = await withHuyou(
  {workspace:'./workspace',binding:'my-circle'},
  ({page,binding}) => queryPosts(page,binding,{limit:10,maxLoads:10})
);
```

`withHuyou({workspace,binding,targetId?}, callback)` 校验账号和圈子、锁定窗口，给 callback 传入 page、解析后的 binding、workspace、targetId；结束只断开连接，保留浏览器。不要在 callback 内再调用会获取同一窗口锁的高层动作函数。读取结束释放锁后再 prepare 动作。

`queryPosts(page,binding,query)` 以“新发”排序读取并按需加载，返回 posts、complete、stopReason、loads、scanned、warnings、query。不会替用户切换圈子或排序，不刷新缓存列表。会回到顶部并可能滚动；完成后可显式 backToTop。

| 查询参数 | 含义 |
|---|---|
| limit | 返回数量上限，默认 10，最大 1000 |
| date | yesterday 或 YYYY-MM-DD，以 Asia/Shanghai 解释 |
| since / until | 带时区 ISO 时间，左闭右开；不与 date 并用 |
| authorName | 作者昵称精确匹配，不等于 UID |
| textIncludes / textEquals | 正文包含 / 完整正文精确匹配 |
| excludeHot | 默认 true，排除插入的热门帖；置顶横幅本身不是帖子卡片 |
| maxLoads | 最多加载次数，默认 10，最大 100 |
| timeoutMs | 查询循环时间预算，默认 30000，最大 300000；单次页面读取另有超时，非硬中断时限 |

`complete:true` 表示在当前新发列表中满足要求的数量，或到达时间范围下界且没有已知歧义；不表示全站或服务器绝对完整。`coverage:requested-count` 不能解释为该日期的全部帖子。需要日期范围尽量完整时使用较高 limit，并检查 stopReason 是否为 time-boundary。列表乱序、时间不明、正文截断、加载无进展或达到上限时会如实报告。

时间解析返回精度区间，支持“刚刚”“N分钟前/小时前”“今天/昨天 HH:MM”“MM-DD HH:MM”“YYYY-MM-DD HH:MM”。省略年份的标签解释为最近一次不晚于查询时间的该日期；跨多年历史无法据此可靠恢复年份。相对时间跨查询边界时不猜测归属。未知标签不会悄悄当成今天。

`resolvePost(posts,{id?,textEquals?,authorName?})` 要求 ID 或完整正文；返回唯一帖子，否则 POST_NOT_FOUND / AMBIGUOUS_POST。帖子 ID 为字符串，不转 Number。按正文匹配拒绝截断文本。`getPost(page,postId)` 从已加载列表打开详情，读取完整正文和评论，随后恢复页面；不会用猜测 URL 导航。查到的帖若已从 DOM 移除，需要重新定位/加载后操作。

## 页面辅助函数

- `loadMore(page,{timeoutMs:5000})`：滚动至列表加载触发区域，等待新帖子 ID；返回 progress 和 added，或 no-progress/load-control-missing。无进展不等于没有更多。
- `backToTop(page)`：滚回页面顶部。
- `refreshFeed(page)`：显式刷新当前列表并等待列表出现。

辅助操作要求列表页、没有详情弹窗和未提交草稿；不会丢弃草稿去刷新。它们修改视口或重新加载页面，不提交社交内容。

## 独立动作

新任务可以统一使用 prepareInteraction/executeInteraction，包括 follow-user。批次便捷入口、操作历史、人工确认和页面恢复见 [通用编排](orchestration.md)。

公开函数对：prepareLikePost / likePost、prepareLikeComment / likeComment、prepareComment / comment、prepareReply / reply、preparePublish / publish。各自位于 scripts/actions 中独立文件，复用同一套验证与防重实现。

```js
const plan = await prepareLikePost({
  workspace:'./workspace',binding:'my-circle',target:{postId:selected.id}
});
await likePost({workspace:'./workspace',plan,mode:'rehearse'});
// 用户已授权该账号对选定帖子点赞时：
await likePost({workspace:'./workspace',plan,mode:'execute'});
```

prepare 参数与 version:2 task 字段对应，另有 workspace、targetId；自动填写 action/version。动作函数接受 prepare 返回值或 plan.json 内容，mode 为 execute（默认）、rehearse、reconcile。prepare 返回的账号、目标和正文必须与用户需求一致，不能将生成计划当成发送授权。错误带 code；verified-ui/uncertain 等含义见 actions.md。

`prepareBatch` / `runBatch` 也在统一入口导出，参数和清单见 batches.md。批次 workspace 需显式提供。单项与批次共用 operations，不删除历史来重发。

## CLI 对应关系

前缀 `node <技能路径>/scripts/cli.js`，不要求当前目录是某个固定磁盘目录：

```text
query --binding NAME --query QUERY_JSON --workspace DIR [--target TAB_ID]
post --binding NAME --post POST_ID --workspace DIR
load-more --binding NAME --workspace DIR
top --binding NAME --workspace DIR
refresh --binding NAME --workspace DIR
```

query 不传 --query 默认最新 10 条。动作和批次 CLI 保持 actions.md、batches.md 的命令；函数和 CLI 复用实现。所有 query 参数放 JSON，避免临时拼装复杂命令。

`api-help` 与 `help` 显示统一能力目录。新增诊断、导航、评论查询和范围查询见 [扩展接口](reading.md)。
