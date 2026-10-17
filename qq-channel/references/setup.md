# 接入

Node.js 版本见 package.json。本包没有运行时第三方依赖；默认使用与 skills 仓库同一父目录的 bitbrowser-agent-kit 提供 Puppeteer 页面。先克隆 https://github.com/by10457/bitbrowser-agent-kit 并在其目录执行 node setup.js，依赖由该项目管理；其他布局设置 QQ_CHANNEL_BROWSER_MODULE 为其 scripts/index.js 的绝对路径。整个 qq-channel 文件夹可移动，不依赖原父目录名称。

浏览器适配器可通过 `configureBrowser({withBrowser,listTabs})` 注入，或把 QQ_CHANNEL_BROWSER_MODULE 设置为适配器入口的绝对路径。withBrowser(selector,callback) 连接并最终断开，但不关闭用户窗口；listTabs(browser) 返回含 page、targetId、url 的数组。

`withQQChannel({workspace,binding,targetId?}, callback)` 在回调内提供 page、binding、workspace、targetId。读取接口也可直接使用外部 Puppeteer page；传外部 page 时调用方负责互斥和生命周期。动作接口不接受外部 page，始终通过浏览器适配器取得窗口锁。

绑定对象：

```js
{
  browserId: '真实比特窗口 ID',
  channelId: '频道网址中 /g/ 后的标识',
  expectedChannelName: '频道完整名称',
  expectedAccountName: '左侧底部全局昵称',
  expectedChannelAccountName: '发帖或回复时的频道昵称',
  expectedInteractionAccountName: '可选：互动准备时编辑器显示的昵称',
  expectedInteractionAccountAvatar: '可选：已核验的互动编辑器头像',
  expectedCommentAuthorName: '可选：实际评论署名',
  expectedCommentAuthorAvatar: '可选：实际评论头像',
  directPostPreparation: false
}
```

expectedChannelAccountName 在发送时必需；只读可省略。若评论、点赞准备时编辑器显示不同昵称，设置 expectedInteractionAccountName；未设置时沿用 expectedChannelAccountName。若评论在帖子下实际使用另一署名，设置 expectedCommentAuthorName 和可选的 expectedCommentAuthorAvatar 供去重与核验。技能不会自行猜测或切换身份。可选 expectedAccountAvatar 用于额外核对全局头像。频道 avatar 只是页面身份证据，不能当作 UID。

大量逐帖评论/点赞时，可显式设置 `directPostPreparation:true`，并同时填写上述互动昵称、互动头像、评论署名和评论头像。此时准备阶段在当前详情页核对全局账号后直接打开目标详情 URL，不为了读取列表编辑器身份而返回频道。配置前应从已确认的页面及历史成功操作核对四项身份信息；不满足条件时保持默认路径，不猜测身份。

仅发现频道时可以使用 `withQQChannel({workspace,binding:{browserId,expectedAccountName},requireContext:false}, ...)` 配合 inspect / listChannels，无需先知道目标频道。频道操作和发送仍必须补全绑定。

binding 也可为配置名称，查找 workspace/config/qq-channel-bindings.json：`{"version":1,"bindings":{"operator":{...}}}`。不要把账号绑定放在技能目录。

workspace 必須显式传入或通过 QQ_CHANNEL_WORKSPACE 指定。动作记录在 workspace/operations/qq-channel，运行记录与计划在 workspace/runs/qq-channel。窗口锁为 workspace/locks/<browserId>.lock；同一窗口的任务应使用相同 workspace。

多个 pd.qq.com 标签时需要 targetId。浏览器断开连接后保留用户页面，不自动关闭或切换其他窗口。

存储按平台隔离：操作账本 operations/qq-channel，运行证据 runs/qq-channel；workspace 始终为宿主工作区根目录，locks 保持共享。升级前暂停任务，将旧账本原样迁入新路径，保留操作键和内容；发现旧账本时报 STORAGE_MIGRATION_REQUIRED，不能通过删除账本绕过。历史结果中的 runDir/planFile 可能仍是旧路径，按迁移清单定位，勿改已封存计划。

## 可选平台项目布局

宿主 config/storage.json 可配置：
```json
{"version":1,"platforms":{"huyou":"project/huyou","qq-channel":"project/qq-channel"}}
```
配置后，绑定从平台项目的 config 读取，operations/runs/drafts/recovery 存于平台项目内部。workspace 仍传宿主根目录，locks 两平台共享。没有配置文件时保持默认按平台分类布局。修改配置前迁移既有账本；不能只切路径开始新账本。配置路径相对于宿主根目录，不依赖命令的当前目录。
