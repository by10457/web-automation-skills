/** 狐友：命令行参数与公开操作分发。 */
import { SkillError } from "./browser.js";
export function parseArgs(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (
      !key.startsWith("--") ||
      !allowed.includes(key.slice(2)) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      key.slice(2) in options
    ) {
      throw new SkillError("INVALID_ARGUMENT", `参数无效：${key}`);
    }
    options[key.slice(2)] = args[i + 1];
  }
  return options;
}
export async function main(fn) {
  try {
    console.log(JSON.stringify({ ok: true, data: await fn() }, null, 2));
  } catch (e) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: e.code || "UNEXPECTED_ERROR",
            message: e.code
              ? e.message
              : "执行失败，请检查依赖、配置和页面结构",
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
