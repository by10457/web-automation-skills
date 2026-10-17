# 命令与模块接口

从 skill 目录执行：

```powershell
node scripts/cli.js health
node scripts/cli.js windows
node scripts/cli.js displays
node scripts/cli.js state --id WINDOW_ID
node scripts/cli.js tabs --name WINDOW_NAME
node scripts/cli.js tabs --id WINDOW_ID
```

stdout 成功返回 `{ok:true,data:...}`；失败 stderr 返回 `{ok:false,error:{code,message}}` 并退出 1。窗口列表仅保留 id/name/seq/running。标签页 ID 是本次运行 targetId，不是持久配置 ID。调试连接地址不持久化。

调用方通过实际文件路径导入比特技能，依赖在 bitbrowser 目录使用 npm ci 安装：

```js
import { withBrowser, listTabs, selectTab } from './skills/bitbrowser/scripts/index.js';
await withBrowser({ id: browserId }, async (browser, window) => {
  const tab = selectTab(await listTabs(browser), { origin: 'https://example.com' });
  return { window, title: await tab.page.title() };
});
```

常见错误：API_UNAVAILABLE（检查本地服务）、WINDOW_NOT_RUNNING（按用户授权启动）、AMBIGUOUS_WINDOW（使用 ID）、AMBIGUOUS_TAB（指定 targetId）、CONNECT_FAILED（窗口不可连接）、WINDOW_RESTARTED（重新检查）。连接命令不自动重试 open、不关闭或删除窗口。管理命令及确认流程见 [management.md](management.md)。
