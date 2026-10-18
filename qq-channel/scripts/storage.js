/** QQ 频道：运行文件的存储与读取。 */
import path from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
const platform = "qq-channel";
export function storage(workspace, category, ...parts) {
  let config;
  try {
    config = JSON.parse(
      readFileSync(
        path.join(workspace, "config", "storage.json"),
        "utf8",
      ).replace(/^\uFEFF/, ""),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const relative = config?.platforms?.[platform];
  if (
    config &&
    (config.version !== 1 ||
      typeof relative !== "string" ||
      !relative ||
      path.isAbsolute(relative))
  )
    throw Error("Invalid platform storage configuration");
  if (relative) {
    const root = path.resolve(workspace),
      base = path.resolve(root, relative);
    if (!base.startsWith(root + path.sep))
      throw Error("Platform storage must be inside workspace");
    const old = path.join(root, "operations", platform);
    if (
      existsSync(old) &&
      readdirSync(old).some((n) => /^[a-f0-9]{64}\.json$/.test(n))
    )
      throw Object.assign(
        Error("Migrate existing platform journal before changing storage root"),
        { code: "STORAGE_MIGRATION_REQUIRED" },
      );
    return path.join(base, category, ...parts);
  }
  return category === "config"
    ? path.join(workspace, category, ...parts)
    : path.join(workspace, category, platform, ...parts);
}
