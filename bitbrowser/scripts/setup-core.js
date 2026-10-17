/** 可重复的 Codex 初始化；不覆盖同名配置，不执行任何浏览器写操作。 */
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, lstat, realpath, symlink, open, unlink, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** 严格参数解析：未知参数或重复值不静默忽略。 */
export function parseSetupArgs(args) {
  const result = {};
  const names = {
    '--codex-home': 'codexHome',
    '--skill-dir': 'skillDir',
    '--state-dir': 'stateDir',
    '--coordination-dir': 'coordinationDir',
    '--api-url': 'apiUrl',
    '--codex-command': 'codexCommand',
  };
  const flags = {
    '--help': 'help',
    '--skip-install': 'skipInstall',
    '--skip-verify': 'skipVerify',
  };
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]] || flags[args[i]];
    if (!key || key in result) throw new Error('未知或重复的初始化参数：' + args[i]);
    if (flags[args[i]]) result[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数缺少值：' + args[i]);
      result[key] = args[++i];
    }
  }
  return result;
}

/** 查找 CLI；Windows 的 npm 包装器用 PowerShell 字面量执行，不拼接未转义命令。 */
export function findCommand(name, env = process.env) {
  if (path.isAbsolute(name)) {
    if (existsSync(name)) return name;
    throw new Error('命令文件不存在：' + name);
  }
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.ps1', ''] : [''];
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, name + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    `找不到 ${name}；请安装 Node/npm 和 Codex CLI，并加入 PATH；Codex 可用 --codex-command 指定。`,
  );
}

/** 原始输出只在内存解析；不将 Codex 配置或环境中的秘密打印到日志。 */
export function runCommand(command, args, { env, cwd }) {
  let executable = command,
    argv = args;
  if (process.platform === 'win32' && /\.(cmd|ps1)$/i.test(command)) {
    const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
    const code = '& ' + [command, ...args].map(literal).join(' ') + '; exit $LASTEXITCODE';
    executable = 'powershell.exe';
    argv = [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(code, 'utf16le').toString('base64'),
    ];
  }
  const result = spawnSync(executable, argv, {
    env,
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout || '' };
}

/** 判断真实目标相同；路径大小写差异、Windows 联接均由 realpath 处理。 */
async function samePath(left, right) {
  try {
    const a = await realpath(left),
      b = await realpath(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

/** 用实际注册参数启动独立 SDK 会话，只允许 health/list_windows；不宣称宿主已热加载。 */
export async function verifyReadOnly(config) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: config.transport.command,
    args: config.transport.args,
    cwd: config.transport.cwd || projectRoot,
    env: { ...process.env, ...config.transport.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bitbrowser-setup-check', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 20000 });
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ['bitbrowser_health', 'bitbrowser_list_windows']) {
      if (!tools.includes(name)) throw new Error('缺少只读工具');
    }
    const health = await client.callTool({ name: 'bitbrowser_health', arguments: {} });
    if (!health.structuredContent?.ok)
      return {
        status: 'failed',
        stage: 'health',
        code: health.structuredContent?.error?.code || 'API_UNAVAILABLE',
        toolCount: tools.length,
      };
    const windows = await client.callTool({ name: 'bitbrowser_list_windows', arguments: {} });
    if (!windows.structuredContent?.ok)
      return {
        status: 'failed',
        stage: 'list_windows',
        code: windows.structuredContent?.error?.code || 'QUERY_FAILED',
      };
    return {
      status: 'passed',
      transport: 'independent-sdk',
      toolCount: tools.length,
      windowCount: windows.structuredContent.data.length,
    };
  } catch {
    return { status: 'failed', stage: 'mcp', code: 'MCP_CHECK_FAILED' };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * 安装只处理缺失项；同名冲突须由用户决定，不能借安装重置既有授权或服务配置。
 * deps 仅用于隔离测试；正常入口使用真实 CLI 和 SDK。
 */
export async function runSetup(options = {}, deps = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('需要 Node.js >= 22.12');
  const root = deps.root || projectRoot;
  const home = path.resolve(
    options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  );
  const skill = path.resolve(
    options.skillDir || path.join(os.homedir(), '.agents', 'skills', 'bitbrowser'),
  );
  const entry = path.join(root, 'adapters', 'mcp', 'stdio.js');
  const env = { ...process.env, CODEX_HOME: home };
  const run = deps.run || runCommand;
  // 显式覆盖也必须验证：不存在的 Windows 包装器曾产生空输出，误报 JSON 解析失败。
  const codex = findCommand(options.codexCommand || 'codex', env);
  const invoke = (args) => run(codex, args, { env, cwd: home });
  await mkdir(home, { recursive: true });
  const lockPath = path.join(home, '.bitbrowser-setup.lock');
  // 排他锁只防本脚本重复运行；锁存在时不擅自删除，异常退出可人工核对后移除。
  const lock = await open(lockPath, 'wx').catch(() => {
    throw new Error('初始化锁已存在或目录不可写，请核对其他安装进程：' + lockPath);
  });
  try {
    const listed = invoke(['mcp', 'list', '--json']);
    if (listed.status !== 0)
      throw new Error('Codex 无法读取 MCP 配置，未修改配置；请检查 CLI 和 TOML 语法');
    const inventory = JSON.parse(listed.stdout);
    if (!Array.isArray(inventory)) throw new Error('Codex MCP 列表格式不兼容，未修改配置');
    let current = inventory.find((item) => item.name === 'bitbrowser');
    if (current) {
      const read = invoke(['mcp', 'get', 'bitbrowser', '--json']);
      if (read.status !== 0) throw new Error('无法读取已有 bitbrowser 配置');
      current = JSON.parse(read.stdout);
      const transport = current.transport;
      if (
        transport?.type !== 'stdio' ||
        transport.args?.length !== 1 ||
        !(await samePath(path.resolve(transport.cwd || home, transport.args[0]), entry))
      )
        throw new Error('同名 bitbrowser MCP 指向其他服务，已保留；请先明确迁移目标');
      if (!current.enabled)
        throw new Error('已有 bitbrowser MCP 被禁用，已保留原策略；请显式启用后重试');
      if (!(await samePath(findCommand(transport.command, env), process.execPath)))
        throw new Error('已有 MCP 使用其他 Node/包装命令，已保留；请核对运行时后再初始化');
      for (const [option, key] of [
        ['stateDir', 'BITBROWSER_STATE_DIR'],
        ['coordinationDir', 'BITBROWSER_COORDINATION_DIR'],
        ['apiUrl', 'BITBROWSER_API_URL'],
      ]) {
        if (options[option] && options[option] !== transport.env?.[key])
          throw new Error('显式参数与已有 MCP 环境配置冲突，未覆盖：' + key);
      }
    }
    let skillExists = false;
    try {
      await lstat(skill);
      skillExists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (skillExists && !(await samePath(skill, root)))
      throw new Error('同名 Skill 已存在且指向其他内容，已保留：' + skill);
    // 安装前检查所有冲突，避免先改变配置再发现 Skill 不兼容。
    if (!options.skipInstall) {
      const npm = deps.npm || findCommand('npm', env);
      const checked = run(npm, ['ls', '--omit=dev', '--depth=0', '--json'], { env, cwd: root });
      if (checked.status !== 0) {
        const installed = run(npm, ['ci', '--no-audit', '--no-fund'], { env, cwd: root });
        if (installed.status !== 0)
          throw new Error('npm ci 失败，尚未注册 Skill/MCP；请检查网络和 package-lock.json');
      }
    }
    let backup;
    if (!current) {
      const stateBase =
        process.platform === 'win32'
          ? path.join(
              process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
              'bitbrowser',
            )
          : path.join(os.homedir(), '.local', 'state', 'bitbrowser');
      const apiUrl = options.apiUrl || 'http://127.0.0.1:54345';
      const parsed = new URL(apiUrl);
      if (
        parsed.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        parsed.username ||
        parsed.password
      )
        throw new Error('API 地址必须是无凭据的本机 HTTP 地址');
      const settings = {
        BITBROWSER_API_URL: apiUrl,
        BITBROWSER_STATE_DIR: path.resolve(options.stateDir || stateBase),
        BITBROWSER_COORDINATION_DIR: path.resolve(
          options.coordinationDir || stateBase + '-coordination',
        ),
      };
      const config = path.join(home, 'config.toml');
      if (existsSync(config)) {
        backup = config + '.bitbrowser-' + Date.now() + '.bak';
        await copyFile(config, backup, 1);
      }
      const added = invoke([
        'mcp',
        'add',
        'bitbrowser',
        ...Object.entries(settings).flatMap(([key, value]) => ['--env', key + '=' + value]),
        '--',
        process.execPath,
        entry,
      ]);
      if (added.status !== 0)
        throw new Error('Codex 注册失败；如有配置备份请核对，不自动回滚其他进程改动');
      const read = invoke(['mcp', 'get', 'bitbrowser', '--json']);
      if (read.status !== 0) throw new Error('注册后无法回读，请检查 Codex 配置');
      current = JSON.parse(read.stdout);
    }
    if (!skillExists) {
      await mkdir(path.dirname(skill), { recursive: true });
      await symlink(root, skill, process.platform === 'win32' ? 'junction' : 'dir');
    }
    const permitted = ['bitbrowser_health', 'bitbrowser_list_windows'].every(
      (name) =>
        (!current.enabled_tools || current.enabled_tools.includes(name)) &&
        !current.disabled_tools?.includes(name),
    );
    const verification = options.skipVerify
      ? { status: 'skipped' }
      : !permitted
        ? { status: 'failed', stage: 'policy', code: 'READ_TOOLS_DISABLED' }
        : await (deps.verify || verifyReadOnly)(current);
    return {
      ok: true,
      projectRoot: root,
      codexHome: home,
      skillPath: skill,
      configuration: 'registered-or-preserved',
      backup,
      verification,
      nextStep:
        '在 Codex 新会话使用 $bitbrowser。工具尚未出现时重新加载 Codex；独立 SDK 验证不证明当前会话已热加载。API 离线时检查比特客户端与本地 API 开关，不启动或修改窗口。',
    };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
