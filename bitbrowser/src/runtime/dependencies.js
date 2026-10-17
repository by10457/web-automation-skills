/**
 * 比特浏览器模块：src/runtime/dependencies.js。普通 JavaScript ESM，无构建或压缩步骤。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { SkillError } from '../client/bitbrowser-api.js';
/** 从当前包或显式宿主目录加载 Puppeteer，不启动新的浏览器实例。 */
export function loadPuppeteer() {
  const roots = process.env.SKILL_PROJECT_ROOT
    ? [createRequire(path.join(path.resolve(process.env.SKILL_PROJECT_ROOT), 'package.json'))]
    : [createRequire(import.meta.url), createRequire(path.join(process.cwd(), 'package.json'))];
  for (const require of roots) {
    try {
      return require('puppeteer-core');
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
  }
  throw new SkillError(
    'DEPENDENCY_MISSING',
    '请在 bitbrowser 目录运行 npm ci；若显式设置 SKILL_PROJECT_ROOT，请检查该目录是否提供 Puppeteer',
  );
}
