/** QQ 频道：共享校验与任务契约。 */
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function fail(code, message) {
  throw new SkillError(code, message);
}
export const canonical = (x) =>
  Array.isArray(x)
    ? x.map(canonical)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, canonical(x[k])]),
        )
      : x;
export const hash = (x) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(x)))
    .digest("hex");
export const text = (x) =>
  String(x ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
export async function pace() {
  await new Promise((r) => setTimeout(r, randomInt(1000, 5001)));
}
export function workspacePath(value = process.env.QQ_CHANNEL_WORKSPACE) {
  if (typeof value !== "string" || !value.trim())
    fail("WORKSPACE_REQUIRED", "指定 workspace 或 QQ_CHANNEL_WORKSPACE");
  return path.resolve(value);
}
export async function readJSON(file) {
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}
export async function saveJSON(file, data, { exclusive = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = exclusive ? file : file + "." + randomUUID() + ".tmp";
  let h;
  try {
    h = await open(tmp, "wx");
  } catch (e) {
    if (e.code === "EEXIST")
      fail("RECORD_EXISTS", "已有记录，禁止覆盖或重复提交");
    throw e;
  }
  try {
    await h.writeFile(JSON.stringify(data, null, 2) + "\n");
    await h.sync();
  } finally {
    await h.close();
  }
  if (!exclusive) await rename(tmp, file);
}
export async function withWindowLock(root, id, fn) {
  if (!/^[a-zA-Z0-9-]+$/.test(id || ""))
    fail("INVALID_BROWSER_ID", "需要真实浏览器窗口 ID");
  const file = path.join(root, "locks", id + ".lock");
  await mkdir(path.dirname(file), { recursive: true });
  let h;
  try {
    h = await open(file, "wx");
  } catch (e) {
    if (e.code === "EEXIST")
      fail("WINDOW_BUSY", "窗口已有任务或遗留锁，请核对原任务");
    throw e;
  }
  try {
    await h.writeFile(
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        skill: "qq-channel",
      }),
    );
    return await fn();
  } finally {
    await h.close();
    await unlink(file);
  }
}
export function route(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("INVALID_URL", "需要完整 QQ 频道网址");
  }
  if (u.origin !== "https://pd.qq.com")
    fail("WRONG_SITE", "目标必须为 https://pd.qq.com");
  const m = /^\/g\/([a-zA-Z0-9_-]+)(?:\/post\/([a-zA-Z0-9_-]+))?\/?$/.exec(
    u.pathname,
  );
  if (!m) fail("UNSUPPORTED_PAGE", "仅支持频道论坛列表和帖子详情");
  return {
    channelId: m[1],
    postId: m[2] || null,
    viewId: u.searchParams.get("subc"),
    url: u.href,
  };
}
export function unique(items, predicate, label = "目标") {
  const found = items.filter(predicate);
  if (found.length !== 1)
    fail(
      found.length ? "AMBIGUOUS_TARGET" : "TARGET_NOT_FOUND",
      label + "不存在或匹配不唯一",
    );
  return found[0];
}
export function avatarIdentity(src) {
  try {
    const u = new URL(src);
    return (
      u.origin +
      u.pathname +
      (u.searchParams.has("k") ? "?k=" + u.searchParams.get("k") : "")
    );
  } catch {
    return src || null;
  }
}
