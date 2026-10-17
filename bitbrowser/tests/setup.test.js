/** 初始化隔离测试：用临时配置根和 CLI 边界替身验证幂等、冲突及只读策略。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runSetup, parseSetupArgs, projectRoot } from '../scripts/setup-core.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex'),
    skill = path.join(root, 'skills', 'bitbrowser');
  await mkdir(home);
  const text = '# preserve comments\n[other]\nvalue = "unchanged"\n';
  await writeFile(path.join(home, 'config.toml'), text);
  let current;
  const calls = [];
  const run = (_command, args) => {
    calls.push(args);
    if (args[0] === 'ls') return { status: 0, stdout: '{}' };
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(current ? [current] : []) };
    if (args[1] === 'get') return { status: 0, stdout: JSON.stringify(current) };
    if (args[1] === 'add') {
      current = {
        name: 'bitbrowser',
        enabled: true,
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: [path.join(projectRoot, 'adapters/mcp/stdio.js')],
          env: {},
        },
      };
      for (let i = 0; i < args.length; i++)
        if (args[i] === '--env') {
          const text = args[++i],
            split = text.indexOf('=');
          current.transport.env[text.slice(0, split)] = text.slice(split + 1);
        }
      return { status: 0, stdout: '' };
    }
    throw Error('unexpected command');
  };
  return {
    home,
    skill,
    text,
    calls,
    setCurrent: (value) => (current = value),
    options: {
      codexHome: home,
      skillDir: skill,
      codexCommand: process.execPath,
      stateDir: path.join(root, 'state'),
      coordinationDir: path.join(root, 'coordination'),
    },
    deps: { run, npm: 'npm', verify: async () => ({ status: 'passed' }) },
  };
}

test('setup is repeatable, links exact source and backs up existing config', async (t) => {
  const f = await fixture(t);
  const first = await runSetup(f.options, f.deps);
  assert.equal(await realpath(f.skill), await realpath(projectRoot));
  assert.equal(await readFile(first.backup, 'utf8'), f.text);
  await runSetup(f.options, f.deps);
  assert.equal(f.calls.filter((args) => args[1] === 'add').length, 1);
  assert.equal(await readFile(path.join(f.home, 'config.toml'), 'utf8'), f.text);
});

test('setup refuses occupied skill before installing or adding a server', async (t) => {
  const f = await fixture(t);
  await mkdir(f.skill, { recursive: true });
  await writeFile(path.join(f.skill, 'user.txt'), 'keep');
  await assert.rejects(runSetup(f.options, f.deps), /同名 Skill/);
  assert.equal(f.calls.length, 1);
  assert.equal(await readFile(path.join(f.skill, 'user.txt'), 'utf8'), 'keep');
});

test('setup preserves conflicting and disabled servers and fails closed on unreadable config', async (t) => {
  const f = await fixture(t);
  f.setCurrent({ name: 'bitbrowser', transport: { type: 'http' } });
  await assert.rejects(runSetup(f.options, f.deps), /其他服务/);
  f.setCurrent({
    name: 'bitbrowser',
    enabled: false,
    transport: { type: 'stdio', args: [path.join(projectRoot, 'adapters/mcp/stdio.js')] },
  });
  await assert.rejects(runSetup(f.options, f.deps), /被禁用/);
  await assert.rejects(
    runSetup(f.options, { ...f.deps, run: () => ({ status: 1, stdout: '' }) }),
    /无法读取/,
  );
  assert(!f.calls.some((args) => args[1] === 'add'));
});

test('setup keeps registration when API verification fails; option parsing rejects mistakes', async (t) => {
  const f = await fixture(t);
  const result = await runSetup(f.options, {
    ...f.deps,
    verify: async () => ({ status: 'failed', stage: 'health' }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.verification.status, 'failed');
  assert.equal(await realpath(f.skill), await realpath(projectRoot));
  assert.throws(() => parseSetupArgs(['--force']), /未知/);
  assert.throws(() => parseSetupArgs(['--skill-dir']), /缺少值/);
});

test('setup rejects a missing explicit CLI before invoking commands or changing configuration', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runSetup({ ...f.options, codexCommand: path.join(f.home, 'missing-cli.cmd') }, f.deps),
    /命令文件不存在/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(path.join(f.home, 'config.toml'), 'utf8'), f.text);
});
