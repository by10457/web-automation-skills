/** 按内容寻址的不可变工作流文件；摘要检测修改，不代表授权。 */
import path from "node:path";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { hash, fail } from "./lib/actions/schema.js";

export class WorkflowStore {
  constructor(workspace) {
    this.workspace = workspace;
    this.root = path.join(workspace, "workflows", "huyou");
  }

  /** 引用仅限单层目录，拒绝符号链接越界。 */
  async file(id) {
    if (!/^[a-f0-9]{64}$/.test(id))
      fail("INVALID_REFERENCE", "需要工具返回的完整引用");
    await mkdir(this.root, { recursive: true });
    if (
      !(await realpath(this.root)).startsWith(
        (await realpath(this.workspace)) + path.sep,
      )
    )
      fail("INVALID_REFERENCE", "工作流目录不能指向工作区外");
    const file = path.join(this.root, id + ".json");
    try {
      if (path.dirname(await realpath(file)) !== (await realpath(this.root)))
        fail("INVALID_REFERENCE", "引用越出工作流目录");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return file;
  }

  async save(kind, data) {
    const value = { ...data, kind, version: 1 };
    const id = hash(value),
      file = await this.file(id);
    try {
      await writeFile(file, JSON.stringify(value, null, 2) + "\n", {
        flag: "wx",
      });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      await this.load(id, kind);
    }
    return { id, file, value };
  }

  async load(id, kind) {
    const value = JSON.parse(await readFile(await this.file(id), "utf8"));
    if (hash(value) !== id || value.kind !== kind || value.version !== 1)
      fail("ARTIFACT_CHANGED", "引用类型不符或文件被修改");
    return value;
  }
}
