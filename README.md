# browser-ops-skills

基于比特浏览器的多窗口、多账号社交平台自动化运营技能集，供 AI Agent 和 Node.js 程序调用。

项目把浏览器窗口管理与平台操作拆成独立技能：比特浏览器负责窗口与连接，平台技能负责页面读取、账号核对、内容操作及执行结果核对。本仓库包含 **狐友社区** 和 **QQ 频道论坛**；比特浏览器核心已迁至独立仓库 **bitbrowser-agent-kit**，后续可按相同结构扩展其他平台。

> 项目仓库：[by10457/browser-ops-skills](https://github.com/by10457/browser-ops-skills)。

## 当前能力

仅接入比特浏览器时，无需先配置站点技能。新电脑准备 Node.js >=22.12（含 npm）、Codex CLI 和已启用本地 API 的比特浏览器；另外克隆 `https://github.com/by10457/bitbrowser-agent-kit.git`，在其目录运行 `node setup.js`，安装依赖并接入 Skill/MCP。也可以让 Codex 阅读 [首次接入入口](https://github.com/by10457/bitbrowser-agent-kit/blob/main/AGENTS.md) 后完成初始化。重复运行保留已有配置，默认验证仅查询在线状态和窗口列表。详见 [比特浏览器项目说明](https://github.com/by10457/bitbrowser-agent-kit/blob/main/README.md) 和 [接入参数](https://github.com/by10457/bitbrowser-agent-kit/blob/main/references/setup.md)。

| 模块 | 状态 | 能力 |
| --- | --- | --- |
| [bitbrowser](https://github.com/by10457/bitbrowser-agent-kit/blob/main/SKILL.md) | 已实现 | 本地服务诊断、窗口查询与数量检查、创建/启动/关闭/删除窗口、清理 Cookie 或缓存、修改名称与备注、打开网页、标签页管理及浏览器连接 |
| [huyou](huyou/SKILL.md) | 已实现 | 账号和圈子检查、帖子与评论查询、作者主页读取、帖子点赞、评论及回复、评论点赞、关注作者、纯文本发布、多窗口批次和结果核对 |
| [qq-channel](qq-channel/SKILL.md) | 首版 | 我的频道与帖子版块、帖子及评论读取、图文发帖、帖子点赞、文字评论、顶层回复和结果核对；真实提交验收见宿主测试记录 |
| 抖音、小红书、微博等 | 扩展方向，尚未实现 | 后续分别增加平台适配与测试 |

多账号任务通过“浏览器窗口 ID + 预期账号 + 平台上下文”区分操作对象。当前项目复用窗口中已有的登录状态，**不包含自动注册或通用自动登录功能**；遇到登录失效，需要先在对应窗口完成登录。

## 工作方式

1. 检查比特浏览器本地服务，获取真实窗口 ID 和运行状态。
2. 准备所需窗口，在各窗口登录相应账号。
3. 配置窗口、账号及圈子绑定，核对当前页面上下文。
4. 查询内容，根据任务生成单项计划或多窗口批次计划。
5. 在明确操作目标和内容后执行，记录结果；结果不确定时先核对，避免重复提交。

浏览器连接结束时断开自动化连接并保留窗口。创建、启动、关闭等窗口管理操作由独立接口执行，连接已有窗口不会代替显式启动操作。

## 目录结构

```text
workspace/
├── bitbrowser-agent-kit/  # 独立克隆的浏览器核心、MCP 和 Skill
└── skills/                # 本仓库
    ├── README.md
    ├── qq-channel/        # QQ 频道论坛技能
    └── huyou/             # 狐友技能
```

每个技能目录可作为独立分发单元。真实账号绑定、任务、执行记录和依赖包放在仓库外的宿主项目中。

分发时直接复制或压缩所需技能目录即可，不需要专用打包脚本；不要包含 `node_modules`、真实账号配置或运行记录。

## 快速开始

需要 **Node.js 22.12+**，以及已安装且本地 API 服务可用的比特浏览器；使用克隆方式获取仓库时还需要 Git。依赖以各技能的 `package.json` 为准，当前浏览器连接需要 `puppeteer-core@25.11.0`。以下命令可用于 PowerShell、bash 或 zsh，不依赖操作系统专用安装脚本；比特浏览器本身需支持目标系统。

### 1. 创建宿主项目并获取技能

在你选择的工作目录执行：

```sh
mkdir browser-ops-workspace
cd browser-ops-workspace
npm init -y
npm install --save-exact puppeteer-core@25.11.0
git clone https://github.com/by10457/browser-ops-skills.git skills
git clone https://github.com/by10457/bitbrowser-agent-kit.git
node bitbrowser-agent-kit/setup.js

node -e "require('node:fs').mkdirSync('workspace/config', { recursive: true })"
```

后续命令均从宿主项目根目录执行。bitbrowser 已独立为共享核心与 MCP 包，首次接入额外运行 `npm --prefix bitbrowser-agent-kit ci`；其他站点技能继续使用宿主依赖。已有宿主项目时可直接安装依赖并放入技能，无需重新初始化。将 bitbrowser-agent-kit 与本仓库 skills 放在同一父目录即可使用默认适配器；其他布局请设置 HUYOU_BROWSER_MODULE / QQ_CHANNEL_BROWSER_MODULE 为独立项目 scripts/index.js 的绝对路径。

### 2. 检查比特浏览器

```sh
node bitbrowser-agent-kit/scripts/cli.js health
node bitbrowser-agent-kit/scripts/cli.js doctor
node bitbrowser-agent-kit/scripts/cli.js windows
```

默认本地 API 地址为 `http://127.0.0.1:54345`。如本机使用其他端口，可设置 `BITBROWSER_API_URL`。窗口 ID 以查询结果为准，窗口名称和序号不能替代 ID。

在比特浏览器中启动所需窗口，打开狐友网页并完成登录。已有窗口的标签页可这样查询：

```sh
node bitbrowser-agent-kit/scripts/cli.js tabs --id '替换为真实窗口ID'
```

### 3. 配置狐友账号绑定

将以下示例保存为宿主项目中的 `workspace/config/huyou-bindings.json`，替换占位值：

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

多个账号在 `bindings` 中添加不同名称的条目，并分别填写其窗口 ID 和预期账号信息。页面身份核对依赖昵称、头像等页面信息，不等同于服务端账号 UID 验证。

### 4. 验证上下文并查询

```sh
node skills/huyou/scripts/cli.mjs diagnose --binding account-a --workspace ./workspace
node skills/huyou/scripts/cli.mjs query --binding account-a --workspace ./workspace
```

查询条件和任务格式见 [狐友示例](huyou/examples) 与 [查询接口](huyou/references/api.md)。如果一个窗口里有多个匹配的平台标签页，需要通过相应接口指定 `targetId`，CLI 使用 `--target`。

## 操作计划与批次

狐友写入操作采用以下流程：

| 阶段 | 用途 |
| --- | --- |
| `prepare` | 生成包含账号、目标和正文的操作计划 |
| `rehearse` | 检查表单并清理工具输入，不提交内容 |
| `execute` | 执行已明确授权的操作 |
| `reconcile` | 核对先前执行结果，处理不确定状态 |

多窗口、多目标任务提供对应的 `batch-prepare`、`batch-rehearse`、`batch-execute`、`batch-reconcile` 命令。详细参数见 [单项操作](huyou/references/actions.md) 和 [批次操作](huyou/references/batches.md)。

同一运行目录提供窗口互斥与防重记录。多个任务操作同一窗口时，应共用运行目录；执行期间避免人工同时编辑页面。`verified-ui` 表示取得页面证据，`uncertain` 表示尚无法确认，应先核对而不是直接重发。

## 扩展其他平台

建议每个平台单独建立技能目录，沿用 `SKILL.md`、`scripts/`、`references/`、`examples/`、`tests/` 的结构：

1. 复用浏览器连接层，或提供兼容的浏览器适配器。
2. 实现该平台的登录状态、账号身份与页面就绪检查。
3. 优先完成内容读取与导航，再增加发布或互动操作。
4. 为写入动作定义目标定位、操作计划、执行结果和失败核对方式。
5. 提供模拟页面测试、参数示例及平台特有的使用限制。

狐友模块可作为现有实现参考；不同平台的页面结构和能力各不相同，不能仅替换网址就复用全部动作。

## 当前限制

- 狐友发布目前支持纯文本及分区选择，不支持附件；回复目标限顶层评论。
- 页面查询的完成状态只表示当前扫描范围，不保证已读取服务器全部内容。
- 页面改版、登录失效或平台限流可能使操作失败，需要重新诊断。
- 页面操作包含随机等待；它不保证平台不会限流，也不代替平台授权。

请仅操作自己或获授权管理的账号，遵守各平台规则。不要将密码、Cookie、令牌、真实账号配置或运行记录提交到公开仓库。

## 文档入口

- [比特浏览器技能](https://github.com/by10457/bitbrowser-agent-kit/blob/main/SKILL.md) · [接入说明](https://github.com/by10457/bitbrowser-agent-kit/blob/main/references/setup.md) · [窗口管理](https://github.com/by10457/bitbrowser-agent-kit/blob/main/references/management.md) · [诊断](https://github.com/by10457/bitbrowser-agent-kit/blob/main/references/diagnostics.md)
- [狐友技能](huyou/SKILL.md) · [接入说明](huyou/references/setup.md) · [查询 API](huyou/references/api.md) · [单项操作](huyou/references/actions.md) · [批次操作](huyou/references/batches.md)
- [QQ 频道技能](qq-channel/SKILL.md) · [接入说明](qq-channel/references/setup.md) · [API](qq-channel/references/api.md) · [动作与恢复](qq-channel/references/actions.md)
