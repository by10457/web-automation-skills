#!/usr/bin/env node
/** 首次接入入口：仅依赖 Node 内置模块启动，具体实现可单独测试。 */
import { runSetup, parseSetupArgs } from './scripts/setup-core.js';

try {
  const options = parseSetupArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'node setup.js [--codex-home DIR] [--skill-dir DIR] [--state-dir DIR] [--coordination-dir DIR] [--api-url URL] [--codex-command FILE] [--skip-install] [--skip-verify]',
    );
  } else {
    const result = await runSetup(options);
    console.log(JSON.stringify(result, null, 2));
    if (result.verification.status === 'failed') process.exitCode = 2;
  }
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, code: error.code || 'SETUP_FAILED', message: error.message }),
  );
  process.exitCode = 1;
}
