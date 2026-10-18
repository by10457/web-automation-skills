# 上下文、导航与完整性

所有函数从 scripts/index.js 导出。page 参数需要 Puppeteer 兼容页面；不会直接接受其他工具的 Tab 句柄。

| 函数 | 参数与结果 |
|---|---|
| inspect | (page)，返回账号、圈子、列表、加载数量及时间 |
| diagnoseHuyou | (page,binding?)，检查页面、账号圈子和草稿，返回 checks、能力提示；ready 不表示已取得发送授权 |
| listCircles | (page)，仅列出当前页面圈子按钮名称，不表示全站圈子 |
| selectCircle | (page,name,{expectedAccountName?})，唯一匹配圈子按钮并核对选中圈子与侧栏；不改绑定配置 |
| setFeedSort | (page,sort)，支持页面的 新发/新回/热门/精华；选择后核对标签 |
| locatePost | (page,binding,postId,{maxLoads?,timeoutMs?})，从当前列表限定加载寻找 ID；返回 found 和停止原因 |
| openPost | 与 locatePost 相同，找到后打开详情并返回 detail，保留详情供后续读取 |
| closePost | (page)，关闭详情，不清除已有草稿 |
| queryComments | (page,binding,postId,query?)，打开已加载帖子、分页读取评论并恢复原详情状态 |
| loadMoreComments | (page,{timeoutMs?})，在已打开详情中滚动评论加载区域，返回 progress/added 或停止原因 |
| resolveComment | (comments,{authorName,text,avatar?,isReply?})，按完整内容与身份线索唯一匹配；歧义停止 |

queryComments 参数：limit 默认100、最大1000，maxLoads 默认10、最大100，timeoutMs 默认30000、最大300000；可用 authorName、textIncludes 筛选，includeReplies 默认 true。结果包含 comments、complete、stopReason、scanned、loads、scope、warnings。complete 只表示满足所需数量，不表示所有评论。无进展、无加载区域或达到上限都不等于没有更多。评论无稳定 ID，保留重复评论，不按昵称正文去重冒充不同用户。

已加载楼中楼随评论一起读取；当前尚未确认独立“展开更多回复”的稳定控件，因此不提供猜测点击或楼中楼写入。对于未加载帖子，先 locatePost，再 queryComments。发送动作的 prepare 会在限定范围内重新定位帖子，不猜测帖子永久链接。

queryPosts 增加 mode：默认 count，达到 limit 可表示数量满足；range 要求 date 或 since，只有扫描到时间下界才可能 complete。range 默认 limit=1000，达到上限返回 record-limit 且 complete=false。即便 complete，也只描述当前列表覆盖范围，不承诺服务器全部历史。

导航前检测草稿；切换圈子之后用该圈子的预期绑定执行查询。withHuyou 的 requireContext:false 只用于诊断或切换圈子的入口，发送动作仍自行核对账号和圈子。普通读取默认核对上下文，不自动切换圈子。

旧 preview 保留为兼容入口，只读取已加载快照且不可执行。新任务优先 queryPosts 加独立动作计划；help 与 api-help 统一显示主要命令。
