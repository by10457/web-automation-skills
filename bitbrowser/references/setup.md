# 安装与接入

整个 bitbrowser 目录为一个独立 npm 包。需要 Node.js 22.12 或更高版本；使用普通 JavaScript ESM，不需要编译或压缩。

## 安装

### 新电脑一次初始化

准备 Node.js >=22.12（含 npm）和 Codex CLI，确保 node、npm、codex 可执行。在完整项目根目录运行 `node setup.js`，或 `npm run setup`。只安装 Codex 桌面端不保证 CLI 在 PATH；可用 `--codex-command` 指定已有 CLI。脚本不会安装系统 Node、全局 CLI 或比特客户端。

脚本先检查 npm 运行依赖，缺失或版本不满足时执行 npm ci；通过官方 `codex mcp add` 注册服务，建立用户 Skill 联接（Windows junction，其他系统目录符号链接）。项目入口取自脚本位置，Node 取当前进程绝对路径，用户 Skill 默认 `~/.agents/skills/bitbrowser`，配置使用 CODEX_HOME 或 `~/.codex`。依据见 [官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 和 [官方 Skills 文档](https://learn.chatgpt.com/docs/build-skills)。

完成返回 JSON，ok:true 表示接入步骤完成，还需检查 verification.status。默认以注册参数启动独立 SDK 会话，发现工具并只调用 health、list_windows，不连接或修改窗口。退出码 0 为成功或显式跳过验证，1 为初始化失败，2 为已接入但只读验证失败。API 离线不会撤销接入，也不会自动启动客户端或窗口。

| 参数 | 用途 |
| --- | --- |
| --codex-home DIR | 指定 Codex 配置目录；不自动改变 Skill 目录 |
| --skill-dir DIR | Skill 目标目录，含 bitbrowser 目录名；通常保持默认发现位置 |
| --state-dir DIR | 持久化计划、快照、交接文件目录 |
| --coordination-dir DIR | 同一服务所有 Agent 共用的协调目录 |
| --api-url URL | 本机 HTTP API，默认 http://127.0.0.1:54345 |
| --codex-command FILE | Codex CLI 绝对路径 |
| --skip-install | 已自行安装依赖时跳过 npm 检查 |
| --skip-verify | 仅接入，不能据此宣称服务可用 |

默认状态目录为 Windows LOCALAPPDATA/bitbrowser，其他系统 ~/.local/state/bitbrowser；协调目录同级并加 -coordination 后缀。不假设存在 D 盘；用户要求其他存储盘时使用参数。已有注册的目录保留，不迁移历史计划或锁。

重复运行不重写已指向本项目、使用当前 Node 的配置，保留权限、超时、环境变量和其他 MCP；同名 Skill/MCP 指向其他内容、服务被禁用、显式参数与既有值冲突或 TOML 无法解析时停止说明。不会强制覆盖或自动启用。

首次注册前在同目录备份 config.toml 为 config.toml.bitbrowser-时间戳.bak。官方 CLI 保留其他配置值，但可能规范化排版或移除注释，原始文本留在备份。自身并发安装通过 .bitbrowser-setup.lock 拦截；异常退出遗留锁需人工核对进程，不自动删除未知锁。部分步骤失败时保留已完成项，修复后可重复运行；不自动回滚其他进程改动。

完成后在新 Codex 会话使用 `$bitbrowser` 查询在线和窗口列表；未发现工具时新开会话或重载应用。独立 SDK 检查不证明当前宿主会话热加载成功。AGENTS.md 为首次进入项目的 Agent 指明入口，但不会让任意目录中的仓库自动变成全局 Skill。

### 手动依赖安装

在 bitbrowser 目录执行：

```powershell
npm ci
node scripts/cli.js help
node scripts/cli.js doctor
```

依赖安装在本包的 node_modules，由 package-lock.json 固定版本。查询 API 不需要启动 Puppeteer，但 npm ci 会安装声明的运行依赖；puppeteer-core 不下载浏览器。开发验证使用 `npm test` 和 `npm run check`。

完整分发需包含 src、adapters、scripts、references、agents、AGENTS.md、SKILL.md、setup.js、package.json 和 package-lock.json；开发源码还包含 tests、examples。不要分发账号配置、运行记录或 node_modules。

## MCP

在支持 stdio MCP 的宿主中合并以下配置；配置格式以具体宿主为准：

```json
{
  "mcpServers": {
    "bitbrowser": {
      "command": "node",
      "args": ["/absolute/path/to/bitbrowser/adapters/mcp/stdio.js"],
      "env": {
        "BITBROWSER_API_URL": "http://127.0.0.1:54345",
        "BITBROWSER_STATE_DIR": "/absolute/path/to/state",
        "BITBROWSER_COORDINATION_DIR": "/absolute/path/to/shared-coordination"
      }
    }
  }
}
```

宿主启动 MCP 进程；手动启动时等待 stdin 输入是正常现象。stdout 只用于 JSON-RPC，诊断写 stderr。不同 Agent 应共享协调目录与同一服务地址，才能互斥操作同一窗口。Node 不在宿主 PATH 时，将 command 改为 node.exe 的绝对路径。

通用 MCP 配置示例在 examples/mcp-config.json。Codex 使用 TOML，见 [Codex 配置示例](../examples/codex-config.toml)，不要把通用 JSON 直接粘贴到 config.toml。

## 共享 JS 与兼容性

`src/index.js` 是主入口，`scripts/index.js` 是稳定转发入口。两者共用业务实现，外部项目无需复制控制代码。

保留 `SKILL_PROJECT_ROOT` 作为显式 Puppeteer 依赖覆盖目录；正常独立安装无需设置。CLI 文件计划仍要求传入 workspace；MCP 自动使用配置的状态目录保存计划和操作记录。不同状态目录不会共享操作去重记录，因此重试必须回到原状态目录和原 planId；窗口互斥则始终由独立的共享协调目录负责。

未配置时 Windows 默认状态和协调目录在 LOCALAPPDATA 下，其他平台在 ~/.local/state 下；均可通过上述环境变量覆盖。不要清理仍在使用的锁或操作记录。

## 真实客户端验证

默认 `npm test` 不操作真实浏览器。只读实测可运行 `health` 和 `windows`。新客户端需支持官方 `/browser/add`；不支持时报告错误，不自动回退旧写接口。实际创建、关闭、删除和清理数据应使用专门测试窗口，记录客户端版本及前后状态。
