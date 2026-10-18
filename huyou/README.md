# 狐友平台自动化

本模块封装狐友圈子的页面读取、导航、互动和结果核对能力。Agent 先读 [Skill](SKILL.md)，再通过 `scripts/index.js` 编写可复用的业务编排脚本；CLI 是可选调用入口。

## 能力与边界

- 账号与圈子检查，帖子、评论、用户主页读取，圈子和排序切换。
- 帖子点赞、文字评论、顶层回复、评论点赞、关注作者和纯文本发布。
- 最新帖子采集、可复现抽样、固定任务、批次执行及文件交接。

复用已有登录状态，不包含通用自动登录或注册。发布不支持附件；查询完成状态描述当前扫描范围，不保证读到服务器全部数据。页面身份核对依赖昵称和页面证据，不等同于服务端 UID。页面改版、登录失效或限流时应诊断，不盲目重试提交。

## 首次接入

需要 Node.js 22.12+。以 bitbrowser 适配器为例，在同一父目录克隆两个仓库：

```sh
git clone https://github.com/by10457/web-automation-skills.git
git clone https://github.com/by10457/bitbrowser-agent-kit.git
node bitbrowser-agent-kit/setup.js
```

比特浏览器及其本地 API 需就绪，账号由用户登录。setup 的宿主接入要求及依赖安装见[浏览器项目说明](https://github.com/by10457/bitbrowser-agent-kit/blob/main/README.md)。其他目录布局设置 `HUYOU_BROWSER_MODULE` 为浏览器项目 `scripts/index.js` 的绝对路径，或使用[适配器接入](references/setup.md)。

以下命令从两个仓库的父目录运行，只查询浏览器状态：

```sh
node bitbrowser-agent-kit/scripts/cli.js health
node bitbrowser-agent-kit/scripts/cli.js windows
node bitbrowser-agent-kit/scripts/cli.js tabs --id '替换为真实窗口ID'
```

API 默认地址为 `http://127.0.0.1:54345`，其他端口通过 `BITBROWSER_API_URL` 配置。窗口 ID 以查询结果为准；后续任务复用有效快照，不机械重复查询标签。

## 任务目录与绑定

按照[任务工作空间约定](../docs/workspaces.md)，在仓库外为本次独立任务创建 `workspace-<任务短名>-<唯一标识>`，禁止使用裸 workspace 或复用其他对话目录。设置其 `config/storage.json` 平台映射，然后将以下配置保存到该任务目录的 `huyou/config/huyou-bindings.json`：

```json
{
  "version": 1,
  "bindings": {
    "account-a": {
      "browserId": "REPLACE_WITH_REAL_WINDOW_ID",
      "expectedAccountName": "账号昵称",
      "expectedCircleName": "目标圈子名称",
      "tabUrl": "https://hy.sns.sohu.com/"
    }
  }
}
```

在对应窗口打开狐友并登录后，核对页面账号、圈子和标签。以下路径为示例，必须替换为本任务生成并保存的真实路径，不能照抄标识：

```sh
node web-automation-skills/huyou/scripts/cli.js diagnose --binding account-a --workspace ./workspace-campus-ops-20261019-a3f82c91
node web-automation-skills/huyou/scripts/cli.js query --binding account-a --workspace ./workspace-campus-ops-20261019-a3f82c91
```

多个账号配置不同绑定条目。存在多个狐友标签时显式指定 `--target`。workspace 始终传任务根目录；没有平台映射时绑定默认位于根目录的 `config/huyou-bindings.json`。

## 业务脚本与执行阶段

- [可重复业务脚本](references/reusable-business.md)：导入公共函数，分阶段采集、独立抽样、生成固定任务和执行批次。
- [只读采集与交接](references/readonly-handoff.md)：双窗口并行采集，初稿保留 itemRef，核对正文主题与依据，通过公共函数生成交接；不提交点赞或评论。
- [帖子互动工作流](references/post-workflow.md)：同一组目标逐帖点赞并评论的工作流；与两组独立抽样区分使用。

写操作遵循 prepare → 按需 rehearse → 已授权 execute → 结果不确定时 reconcile。rehearse 会检查表单，不等同于只读采集。记录原计划与固定正文，重试先核对结果，不重新抽样或重发不确定操作。同窗口工作串行，不通过更换 workspace 绕过防重记录。

具体接口见[查询 API](references/api.md)、[导航与读取](references/reading.md)、[单项操作](references/actions.md)、[批次操作](references/batches.md)和[示例脚本](examples)。连接结束时断开自动化连接并保留窗口，窗口启动和关闭由独立浏览器接口管理。
