# BitBrowser：共享核心、MCP 与 Skill

基于比特浏览器官方 API 的本地自动化封装。共享 JavaScript 核心供 MCP、CLI 和网站业务脚本调用，轻量 Skill 负责需求识别、操作编排和结果交接。普通 JS ESM，无编译或压缩步骤。

## 快速接入

准备 Node.js >=22.12（含 npm）、Codex CLI 和已启用本地 API 的比特浏览器，在本目录执行：

```powershell
node setup.js
```

初始化安装依赖、注册用户 Skill/MCP，并调用在线状态和窗口列表做只读验证。可重复运行，保留已有配置；冲突时停止而不覆盖。参数、隔离安装和故障处理见 [安装与接入](references/setup.md)。首次进入项目的 Agent 从 [AGENTS.md](AGENTS.md) 开始。

完成后在新 Codex 会话请求：“使用 $bitbrowser 检查在线状态并列出窗口，只读查询。”独立 SDK 验证成功不代表当前宿主已经热加载 MCP。

## 能力与边界

- 查询在线状态、窗口详情及运行状态、标签页和显示器。
- 创建、启动、关闭、删除窗口，修改名称备注，访问 URL 和操作标签。
- 随机指纹，宫格、对角线及自适应排列，清理 Cookie/HTTP 缓存。
- 管理写操作采用 prepare → execute → inspect；结果不确定时核对原计划，不自动重放写请求。
- 从标签快照生成包含窗口 ID、targetId、URL 和账号证据的交接文件，直接复用工具返回的计划参数和文件链接。

操作限定用户授权目标。新窗口隔离会话不等于已登录；账号状态需要网站业务证据。排列仅返回 API 确认，指纹不承诺全局唯一。官方 API 未提供的安装检测和桌面客户端启动不在封装范围内。

## 使用说明

- [轻量 Skill](SKILL.md)：Agent 使用入口。
- [任务编排与交接](references/workflows.md)：多窗口、独立登录及结果交付。
- [MCP 契约](references/mcp.md)、[JS API](references/api.md)、[CLI](references/commands.md)。
- [管理操作](references/management.md)、[连接生命周期](references/connection.md)、[诊断](references/diagnostics.md)。
- [通用 MCP 配置](examples/mcp-config.json)、[Codex 配置](examples/codex-config.toml)。

## 项目结构与开发

| 目录 | 职责 |
| --- | --- |
| src/client、src/contracts | 官方 API、参数及结果契约 |
| src/services、src/runtime | 业务服务、连接、锁、限频与持久化 |
| adapters | CLI 与 MCP 适配 |
| scripts | 稳定 JS 导入入口和开发检查 |
| references、examples、agents | 使用说明、请求示例与 Skill 元数据 |
| tests | 自动化回归与协议集成测试 |

```powershell
npm ci
npm test
npm run check
```

测试默认不操作真实浏览器，临时产物使用系统临时目录，可通过 BITBROWSER_TEST_ROOT 指定其他位置。运行状态独立于源码保存，位置及覆盖方式见接入说明。分发保留回归测试，排除依赖、运行数据和本地开发档案。
