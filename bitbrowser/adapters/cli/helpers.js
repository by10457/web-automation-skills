/**
 * 比特浏览器模块：adapters/cli/helpers.js。普通 JavaScript ESM，无构建或压缩步骤。
 */
import { SkillError } from '../../src/client/bitbrowser-api.js';
import { successResult, errorResult } from '../../src/contracts/results.js';
/** 解析严格的 CLI 参数，拒绝未知字段和重复参数。 */
export function parseArgs(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !key.startsWith('--') ||
      !allowed.includes(key.slice(2)) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      key.slice(2) in options
    ) {
      throw new SkillError('INVALID_ARGUMENT', `参数无效：${key}`);
    }
    options[key.slice(2)] = args[i + 1];
  }
  return options;
}
/** CLI 统一 JSON 输出和退出码；此函数不用于 MCP stdout。 */
export async function main(fn) {
  try {
    const result = successResult(await fn());
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } catch (e) {
    console.error(JSON.stringify(errorResult(e), null, 2));
    process.exitCode = 1;
  }
}
