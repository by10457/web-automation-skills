# 接口

全部接口从 scripts/index.js 导入，浏览器操作为异步函数。常规读取方式：

```js
await withQQChannel({workspace,binding,targetId}, async ({page,binding}) => {
  const status = await diagnose(page,binding);
  const views = await listPostViews(page,binding);
  await selectPostView(page,binding,'全部');
  return queryPosts(page,binding,{limit:10,maxLoads:20});
});
```

## 读取和导航

- `inspect(page)` 返回 account、channel、pageType、channels、views、posts、detail、composer、draft、notices。
- `diagnose(page,binding)` 返回 ready / draft-present / blocked。capabilities 表示当前页面对应的动作入口，不代表已经证明该账号拥有发布权限。
- `listChannels(page)` 返回已渲染频道列表，complete=false，未声称拿到服务器全部频道。项目包含 name、avatar、selected、可观察的 url（可能为空）。
- `selectChannel(page,binding,{name,avatar?})` 通过唯一名称/头像选择；binding 描述切换后的目标频道。切换前只核对全局账号，切换后核对频道 ID 和名称。
- `listPostViews(page,binding)` 返回 views；每项含 name、kind（aggregate / board）、selected。版块异步加载，complete=false 表示仅描述已渲染选项；名称切换会等待指定项出现。
- `selectPostView(page,binding,name)` 返回选中视图和当前网址。读取视图切换不改变发帖版块。
- `queryPosts(page,binding,query)`：limit 默认10、最大1000；maxLoads 默认20、最大100；timeoutMs 默认120000、最大300000。支持 authorName、textIncludes、textEquals、date（YYYY-MM-DD），或带时区的 since / until。
- queryPosts 返回 posts、complete、stopReason、warnings、loads、scanned、view、scope、ordering、freshness。它不会刷新页面，必要时先 refreshFeed。日期边界不确定、截断全文匹配等会返回 warning。
- `resolvePost(posts,{id?,authorName?,textEquals?})` 要求唯一匹配。
- `getPost(page,binding,url)` / `openPost` 导航至完整详情 URL，返回 detail，并停留在详情页。
- `queryComments(page,binding,{limit=200,maxLoads=10})` 要求当前为详情页；返回 comments、postId、complete、stopReason、loads、warnings。包含已加载楼中楼和 parentId；只在页面明确显示没有更多评论时返回完整。
- `resolveComment(comments,{id? ,authorName?,text?,avatar?})` 返回唯一顶层评论。ID 优先，附加条件也会核对；非唯一或楼中楼目标抛错。
- `loadMore(page,binding,{timeoutMs=8000})` 每次滚动约一个视口，返回 progress、stopReason。loadMoreComments 用于详情评论区。
- `selectChannel` 成功后自动初始化帖子类型，返回 initialization（status、via、selectedView、views、warnings）。`initializePostViews(page,binding)` 可单独初始化当前频道：优先热门 → 全部；没有热门用其他类型中转；只有全部时重新选择。没有类型返回 no-views；有类型却没有全部时停止。
- `backToTop(page,binding)` 操作列表或详情自身的滚动容器，核对到顶后返回 container、from、to；不滚动频道侧栏。
- `returnToChannel(page,binding)` 在详情页点击“去频道”并核对频道列表，不切换帖子类型；已在频道列表时返回 already-in-channel。用于一批互动完成后返回，下一轮扫描再初始化类型。
- `refreshFeed(page,binding)` 仅支持帖子列表：全部 → 另一类型 → 全部；其他类型 → 全部 → 原类型。禁止整页刷新，不改变最终选中类型。返回 originalView、alternateView、selectedView、method、url；complete:false 表示重新选择类型不保证服务端全量或最新数据。没有替代类型、已有草稿、频道变化时停止；中途失败需核对当前类型后再继续。

帖子对象包含原始字符串 id、url、channelId、boardId、author、text、textTruncated、publishedLabel、images。时间筛选返回 publishedTime 时间区间，默认按上海时区解释页面日期。热门列表不能用于推断最新顺序。

## 动作

```js
const plan = await prepareInteraction({
  workspace,binding,targetId,
  action:'publish',board:'实际版块名称',
  content:{text:'经用户授权的正文',images:['本地图片绝对路径']}
});
// 保存并检查 plan，用户已授权具体内容后执行。
const result = await executeInteraction({workspace,targetId,plan,mode:'execute'});
```

评论：`action:'comment',target:{url},content:{text}`。
顶层回复：`action:'reply',target:{url,comment:{id}},content:{text}`。
帖子点赞：`action:'like-post',target:{url}`，不传 content。

便捷准备接口 preparePublish / prepareLikePost / prepareComment / prepareReply 接收相同参数但省略 action；执行接口 publish / likePost / comment / reply 必须传相符动作的 plan。所有发送接口自行锁定窗口，不要放在 withQQChannel 回调内。

结果状态：verified-ui、skipped-already-liked、skipped-duplicate、uncertain、blocked-uncertain。执行结果包含 runDir；不确定结果会尽力保存现场快照和截图。错误通过包含 code 的异常返回；CLI 输出 JSON 错误及可用的 runDir，并设置非零退出码。

## CLI

`node <skill>/scripts/cli.js <command> --input request.json [--output result.json]`

命令见 `--help`。请求 JSON 含 workspace、binding、targetId；posts 的条件放 query，select-view 的名称放 view，post 的地址放 url。prepare 的动作字段与函数一致。execute / reconcile 使用 plan 对象或 planFile 路径，命令明确决定执行或仅核对。没有默认发送命令。
