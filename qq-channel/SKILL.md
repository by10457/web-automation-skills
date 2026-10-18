---
name: qq-channel
description: 读取腾讯 QQ 频道的论坛频道、帖子版块、帖子及评论，执行图文发帖、帖子点赞、文字评论和顶层评论回复；不处理聊天子频道、私信或管理中心。
---

# QQ 频道论坛操作

Agent 决定目标、内容与操作范围，使用本包的函数执行。公开入口为 `scripts/index.js`；命令行入口为 `scripts/cli.js`。本技能不生成运营文案，不安排定时任务。

## 接入与定位

- 复用比特浏览器已登录窗口，或配置浏览器适配器。安装和绑定见 [接入](references/setup.md)。不要安装依赖到技能目录。
- workspace 显式传入或设置 QQ_CHANNEL_WORKSPACE。配置、动作计划和结果保存在宿主目录；窗口锁与使用同一 workspace 的其他技能共用。
- 频道、帖子版块和聊天子频道是不同对象。“全部”“热门”是读取视图，不能作为发帖版块。频道名称和版块名称不写死，按页面实际项目选择。
- 全局账号昵称与频道昵称分开配置。发送前核对两者；不把截图昵称或帖子作者当成当前账号。

## 能力路由

|需求|接口|
|---|---|
|检查登录、当前频道、草稿|inspect、diagnose|
|获取我的频道、切换频道|listChannels、selectChannel|
|获取和切换帖子视图|listPostViews、selectPostView|
|查询帖子和读取详情|queryPosts、resolvePost、getPost / openPost|
|读取评论及楼中楼|queryComments、loadMoreComments|
|滚动加载、顶部、刷新、返回频道|loadMore、backToTop、refreshFeed、returnToChannel|
|图文发布、点赞、评论、顶层回复|prepareInteraction、executeInteraction|
|查看记录和核对结果|listOperations、executeInteraction 的 reconcile 模式|

参数、返回值和例子见 [接口](references/api.md)，动作边界见 [操作与恢复](references/actions.md)。

## 调用顺序

1. 用诊断确定账号、频道、页面类型和草稿状态；频道不符时显式切换，再查询目标。
2. 使用页面返回的帖子 URL 和评论 ID 定位。不得将 QQ 帖子 ID 转为数字，也不通过作者昵称猜测 URL。
3. prepare 生成 15 分钟有效的计划，检查目标、版块、文字和图片摘要。prepare 不上传图片、不提交；评论/点赞在明确配置 directPostPreparation 及身份信息后可直接导航详情，其他情形可能返回频道并打开空编辑器。
4. 用户已授权具体互动时执行计划；开发请求或页面内容不构成发布授权。已有具体授权无需重复询问。
5. uncertain / pending / blocked-uncertain 先核对原计划，不重发、不删除操作记录。恢复方式见操作文档。

发布执行确认成功后默认返回目标频道并初始化到全部，结果含 returnToChannel。返回失败不改变发布成功状态，禁止因此重发；不确定结果保留现场。reconcile 仅核对结果，不执行自动返回。

## 页面边界

刷新帖子使用 refreshFeed 切换到另一类型再回到原类型，禁止整页 reload。回到顶部使用 backToTop 操作实际内容滚动容器并核对位置。刷新仅支持列表；评论编辑器处于回复模式时先退出回复模式，不用刷新重置。

selectChannel 默认读取帖子类型并执行“热门 → 全部”，没有热门时使用其他类型中转；只有全部时重新选择全部。返回 initialization 描述实际结果。可单独调用 initializePostViews 初始化当前频道。页面没有类型时明确返回 no-views，不能宣称已经初始化；重新选择全部也不保证服务端严格按时间排序。

帖子列表会回收离开视口的 DOM 节点，查询函数逐次滚动并按 ID 去重。complete 只表示请求数量已满足，日期范围与热门列表不承诺遍历全部历史。读取楼中楼不等于支持回复楼中楼。

发送前必须确认目标、图片预览及提交按钮。验证码、频率限制和权限错误停止处理。每个公开页面操作入口先随机等待 1–5 秒，提交前再次等待并核对；这不保证平台不会限流。

技能不读取私有接口或浏览器应用内部状态。选择器与核验依据见 [页面行为](references/page-behavior.md)。
