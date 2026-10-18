/** 狐友：工作区配置与路径解析。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
export function workspacePath(value) {
  const root = value || process.env.HUYOU_WORKSPACE;
  if (!root)
    throw Object.assign(
      new Error("请显式传入 workspace 或设置 HUYOU_WORKSPACE"),
      { code: "WORKSPACE_REQUIRED" },
    );
  return path.resolve(root);
}
