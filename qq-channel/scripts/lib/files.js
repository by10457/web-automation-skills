/** QQ 频道：文件读写工具。 */
import { readFile, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fail, hash } from "./core.js";
export function imageType(b) {
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString()))
    return "image/gif";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}
export async function describeImages(files = []) {
  if (
    !Array.isArray(files) ||
    files.some((f) => typeof f !== "string" || !path.isAbsolute(f))
  )
    fail("INVALID_IMAGES", "images 使用本地绝对路径数组");
  const result = [];
  for (const file of files) {
    const resolved = await realpath(file),
      info = await stat(resolved);
    if (!info.isFile()) fail("INVALID_IMAGE", "图片必须为文件");
    const bytes = await readFile(resolved),
      type = imageType(bytes);
    if (!type)
      fail("UNSUPPORTED_IMAGE", "支持 PNG、JPEG、WebP、GIF；按文件签名检查");
    result.push({
      path: resolved,
      name: path.basename(resolved),
      bytes: bytes.length,
      type,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return result;
}
export async function verifyImages(expected) {
  const actual = await describeImages(expected.map((f) => f.path));
  if (hash(actual) !== hash(expected))
    fail("IMAGE_CHANGED", "图片内容或文件信息变化，请重新 prepare");
  return actual;
}
