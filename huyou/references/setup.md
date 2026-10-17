# 独立接入

整个 huyou 文件夹是分发单元，不携带依赖包、账号配置或运行记录。Node.js 版本见 package.json。

浏览器连接支持三种方式：

1. 设置 HUYOU_BROWSER_MODULE 为浏览器技能 scripts/index.js 的绝对路径。模块需导出 withBrowser、listTabs、selectTab；采用独立 bitbrowser-agent-kit 时，在该项目内安装依赖，见其接入说明。
2. 调用 configureBrowser(adapter)，注入相同接口。withBrowser(selector,callback) 负责连接、调用及断开，保留原窗口；listTabs 返回 page、targetId、url、title。
3. 读取与导航直接调用函数传入 Puppeteer 兼容 page，或 withHuyou({page,binding},callback)。调用方负责页面生命周期与同窗口互斥，不自动加锁或断开外部 page。动作计划与批次仍通过浏览器适配器取得窗口。

默认布局为 web-automation-skills 与 bitbrowser-agent-kit 位于同一父目录，huyou 位于前者内部；先克隆 https://github.com/by10457/bitbrowser-agent-kit 并在其中运行 node setup.js。其他布局使用上述环境变量或注入接口。纯查询筛选函数和导入本技能不要求比特模块存在。

绑定对象：`{browserId,expectedAccountName,expectedCircleName}`，可选 tabUrl。withHuyou 和单项动作的 binding 可直接传对象，或传 workspace/config/huyou-bindings.json 中的绑定名称。直接传入 page 时读取绑定只需要预期账号、圈子；发送动作需要 browserId。

运行目录必须通过 workspace 或 HUYOU_WORKSPACE 明确指定，不再由技能位置推导。与比特管理任务共用 workspace 时共享窗口锁。若迁移旧调用，补上 workspace 即可。发布正文与动作授权仍由调用方决定。

存储按平台隔离：操作账本 operations/huyou，运行证据 runs/huyou；workspace 始终为宿主工作区根目录，locks 保持共享。升级前暂停任务，将旧账本原样迁入新路径，保留操作键和内容；发现旧账本时报 STORAGE_MIGRATION_REQUIRED，不能通过删除账本绕过。历史结果中的 runDir/planFile 可能仍是旧路径，按迁移清单定位，勿改已封存计划。
草稿归属记录使用 drafts/huyou，恢复证据使用 recovery/huyou；升级时同步迁移旧 drafts 和 recovery。

## 可选平台项目布局

宿主 config/storage.json 可配置：
```json
{"version":1,"platforms":{"huyou":"project/huyou","qq-channel":"project/qq-channel"}}
```
配置后，绑定从平台项目的 config 读取，operations/runs/drafts/recovery 存于平台项目内部。workspace 仍传宿主根目录，locks 两平台共享。没有配置文件时保持默认按平台分类布局。修改配置前迁移既有账本；不能只切路径开始新账本。配置路径相对于宿主根目录，不依赖命令的当前目录。
