/** QQ 频道：操作账本持久化。 */
import { storage } from "../storage.js";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { readJSON, saveJSON, fail } from "./core.js";
export class Journal {
  constructor(workspace) {
    const legacy = path.join(workspace, "qq-channel", "operations");
    if (
      existsSync(legacy) &&
      readdirSync(legacy).some((n) => /^[a-f0-9]{64}\.json$/.test(n))
    )
      fail(
        "STORAGE_MIGRATION_REQUIRED",
        "请先迁移旧操作账本到 operations/qq-channel，禁止忽略历史记录继续提交",
      );
    this.dir = storage(workspace, "operations");
  }
  file(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) fail("INVALID_KEY", "操作标识无效");
    return path.join(this.dir, key + ".json");
  }
  async get(key) {
    try {
      return await readJSON(this.file(key));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      fail("JOURNAL_UNREADABLE", "操作记录不可读，停止以免重复提交");
    }
  }
  async begin(key, value) {
    return saveJSON(this.file(key), value, { exclusive: true });
  }
  async finish(key, value) {
    return saveJSON(this.file(key), value);
  }
}
