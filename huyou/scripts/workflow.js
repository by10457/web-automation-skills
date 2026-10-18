/**
 * 查询 → 抽样 → 固定清单 → 复用批次引擎 → 文件交接。
 * 只有显式 run({mode:'execute'}) 才能提交互动。
 * 依赖注入仅用于进程内离线测试，不接受命令行输入。
 */
import path from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { WorkflowStore } from "./workflow-store.js";
import { workspacePath } from "./config.js";
import { withHuyou } from "./session.js";
import { queryPosts } from "./posts.js";
import { prepareBatch, runBatch, validateBatch } from "./lib/batch.js";
import { bindingFor, withLock } from "./lib/runner.js";
import { hash, fail } from "./lib/actions/schema.js";

const ageLimit = 30 * 60000;
const nonempty = (value) =>
  typeof value === "string" && value.trim().length > 0;
function fields(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    fail("INVALID_ARGUMENTS", "参数包含未知字段");
}

/** 按种子执行 Fisher-Yates 洗牌；拒绝采样避免取模偏差，保存种子用于复现。 */
export function shuffled(items, seed) {
  let counter = 0;
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const range = i + 1,
      ceiling = Math.floor(0x100000000 / range) * range;
    let value;
    do {
      value = createHash("sha256")
        .update(JSON.stringify([seed, counter++]))
        .digest()
        .readUInt32BE();
    } while (value >= ceiling);
    const j = value % range;
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 实机采集复用会话的账号、圈子校验和实际选中的标签。 */
async function collectLive({ workspace, binding, targetId, query }) {
  return withHuyou({ workspace, binding, targetId }, async (context) => ({
    binding: context.binding,
    targetId: context.targetId,
    result: await queryPosts(context.page, context.binding, query),
    url: context.page.url(),
  }));
}

export function createPostWorkflow({
  workspace,
  collect = collectLive,
  action,
  now = Date.now,
} = {}) {
  workspace = workspacePath(workspace);
  const store = new WorkflowStore(workspace);
  /** 保守排除已记录批次中的目标，包括结果不确定的任务。 */
  async function reservedPosts(binding) {
    const blocked = new Set();
    let dirs;
    try {
      dirs = await readdir(path.join(workspace, "batches"));
    } catch (e) {
      if (e.code === "ENOENT") return blocked;
      throw e;
    }
    for (const id of dirs.filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
      let request;
      try {
        request = validateBatch(
          JSON.parse(
            await readFile(
              path.join(workspace, "batches", id, "request.json"),
              "utf8",
            ),
          ),
        );
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      for (const item of request.items) {
        const b = await bindingFor(workspace, item.task.binding);
        if (
          b.browserId === binding.browserId &&
          b.expectedAccountName === binding.expectedAccountName &&
          b.expectedCircleName === binding.expectedCircleName &&
          ["like-post", "comment"].includes(item.task.action)
        )
          blocked.add(item.task.target.postId);
      }
    }
    return blocked;
  }
  const fresh = (snapshot) => {
    const age = now() - Date.parse(snapshot.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > ageLimit)
      fail("SNAPSHOT_EXPIRED", "快照过期；重新查询，不自动改写已有清单");
  };
  const loadChain = async (listId, checkAge = true) => {
    const list = await store.load(listId, "comments");
    const sample = await store.load(list.sampleId, "sample");
    const snapshot = await store.load(sample.snapshotId, "snapshot");
    if (checkAge) fresh(snapshot);
    return { list, sample, snapshot };
  };

  /** 查询会读取或导航页面，并非只检查浏览器状态。 */
  async function query(input) {
    fields(input, ["binding", "targetId", "query"]);
    const expected = await bindingFor(workspace, input.binding);
    const data = await collect({ workspace, ...input, binding: expected });
    if (
      hash(data.binding) !== hash(expected) ||
      !nonempty(data.targetId) ||
      (input.targetId && input.targetId !== data.targetId)
    )
      fail("CONTEXT_CHANGED", "查询账号或标签与请求不符");
    if (new URL(data.url).origin !== "https://hy.sns.sohu.com")
      fail("CONTEXT_CHANGED", "非狐友页面");
    const result = data.result;
    if (!Array.isArray(result?.posts) || typeof result.complete !== "boolean")
      fail("INVALID_QUERY_RESULT", "需要现有查询返回对象");
    const seen = new Map();
    for (const post of result.posts) {
      if (typeof post.id !== "string" || !/^\d+$/.test(post.id))
        fail("INVALID_POST", "帖子 ID 必须是数字字符串");
      if (seen.has(post.id) && hash(seen.get(post.id)) !== hash(post))
        fail("AMBIGUOUS_POST", "同一帖子包含冲突数据");
      seen.set(post.id, post);
    }
    const posts = [...seen.values()].map((post) => ({
      ...post,
      itemRef: hash([expected, data.targetId, post.id]),
      postId: post.id,
    }));
    const saved = await store.save("snapshot", {
      platform: "huyou",
      binding: expected,
      windowId: expected.browserId,
      targetId: data.targetId,
      url: data.url,
      observedAt: new Date(now()).toISOString(),
      timezone: "Asia/Shanghai",
      result: { ...result, posts },
    });
    return {
      snapshotId: saved.id,
      jsonPath: saved.file,
      complete: result.complete,
      stopReason: result.stopReason,
      count: posts.length,
      sampleArguments: { snapshotId: saved.id },
    };
  }

  /** 抽样不导航或提交动作；候选范围不代表全站数据。 */
  async function sample(input) {
    fields(input, ["snapshotId", "count", "seed", "allowPartial"]);
    const {
      snapshotId,
      count,
      seed = randomUUID(),
      allowPartial = false,
    } = input;
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 50 ||
      !nonempty(seed) ||
      seed.length > 200 ||
      typeof allowPartial !== "boolean"
    )
      fail("INVALID_ARGUMENTS", "count 为 1–50，seed 为非空字符串");
    const snapshot = await store.load(snapshotId, "snapshot");
    fresh(snapshot);
    if (!snapshot.result.complete && !allowPartial)
      fail("INCOMPLETE_QUERY", "查询不完整，需显式接受当前候选范围");
    // 截断正文不足以生成评论，不隐式追加采集。
    const blocked = await reservedPosts(snapshot.binding);
    const candidates = snapshot.result.posts.filter(
      (p) => !p.textTruncated && nonempty(p.text) && !blocked.has(p.postId),
    );
    if (candidates.length < count)
      fail("INSUFFICIENT_CANDIDATES", "完整正文候选不足，不自动扩大查询范围");
    const selected = shuffled(candidates, seed).slice(0, count);
    const saved = await store.save("sample", {
      snapshotId,
      seed,
      count,
      allowPartial,
      excludedPostIds: [...blocked].sort(),
      candidateCount: candidates.length,
      candidateDigest: hash(candidates),
      items: selected,
    });
    return {
      sampleId: saved.id,
      jsonPath: saved.file,
      seed,
      candidateCount: candidates.length,
      items: selected,
      freezeArguments: { sampleId: saved.id },
    };
  }

  /** 每个目标固定一条评论，不接受替换 ID 或账号绑定。 */
  async function freeze(input) {
    fields(input, ["sampleId", "comments"]);
    const { sampleId, comments } = input;
    const selected = await store.load(sampleId, "sample");
    fresh(await store.load(selected.snapshotId, "snapshot"));
    if (!Array.isArray(comments) || comments.length !== selected.items.length)
      fail("INVALID_COMMENTS", "需要逐条完整评论映射");
    const map = new Map();
    for (const entry of comments) {
      if (
        !entry ||
        Object.keys(entry).some((k) => !["itemRef", "text"].includes(k)) ||
        !selected.items.some((p) => p.itemRef === entry.itemRef) ||
        map.has(entry.itemRef) ||
        !nonempty(entry.text) ||
        entry.text.trim().length > 5000
      )
        fail("INVALID_COMMENTS", "评论缺失、重复、目标不符或正文无效");
      map.set(entry.itemRef, entry.text.replace(/\r\n/g, "\n").trim());
    }
    const data = {
      sampleId,
      comments: selected.items.map((p) => ({
        itemRef: p.itemRef,
        text: map.get(p.itemRef),
      })),
    };
    return withLock(workspace, "freeze-" + sampleId, async () => {
      const saved = await store.save("comments", data);
      const pointer = path.join(store.root, sampleId + ".frozen");
      try {
        await writeFile(pointer, saved.id, { flag: "wx" });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if ((await readFile(pointer, "utf8")) !== saved.id)
          fail("FROZEN_LIST_CHANGED", "该抽样的正文已固定，不自动替换");
      }
      return {
        listId: saved.id,
        jsonPath: saved.file,
        prepareArguments: { listId: saved.id },
      };
    });
  }

  /** 重启后仍复用该清单的原始批次计划。 */
  async function prepare(input) {
    fields(input, ["listId"]);
    const { listId } = input;
    const chain = await loadChain(listId, false);
    if (
      (await readFile(
        path.join(store.root, chain.list.sampleId + ".frozen"),
        "utf8",
      )) !== listId
    )
      fail("FROZEN_LIST_CHANGED", "只能准备已固定的清单");
    // 按真实窗口串行准备工作流；现有引擎
    // 继续管理浏览器锁，避免嵌套锁引发死锁。
    return withLock(
      workspace,
      "workflow-window-" + hash(chain.snapshot.windowId),
      () =>
        withLock(workspace, "workflow-" + listId, async () => {
          const receiptFile = path.join(store.root, listId + ".prepared.json");
          try {
            const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
            const prior = await store.load(receipt.preparedId, "prepared");
            if (
              prior.listId !== listId ||
              receipt.runArguments?.preparedId !== receipt.preparedId ||
              prior.manifest.id !== receipt.batchId
            )
              fail("ARTIFACT_CHANGED", "准备引用与清单不一致");
            return receipt;
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          const { list, sample: selected, snapshot } = await loadChain(listId);
          const blocked = await reservedPosts(snapshot.binding);
          if (selected.items.some((p) => blocked.has(p.postId)))
            fail(
              "TARGET_RESERVED",
              "候选已存在于批次中，核对原批次，不重复准备",
            );
          const task = validateBatch({
            version: 3,
            concurrency: 1,
            items: selected.items.flatMap((post, index) =>
              ["like-post", "comment"].map((kind) => ({
                id: "item-" + index + "-" + kind,
                targetId: snapshot.targetId,
                task: {
                  version: 2,
                  binding: snapshot.binding,
                  action: kind,
                  target: { postId: post.postId },
                  ...(kind === "comment"
                    ? { content: { text: list.comments[index].text } }
                    : {}),
                },
              })),
            ),
          });
          // 显式保留准备中断状态，不自动创建另一份计划。
          try {
            await writeFile(path.join(store.root, listId + ".preparing"), "", {
              flag: "wx",
            });
          } catch (e) {
            if (e.code === "EEXIST")
              fail(
                "PREPARATION_INTERRUPTED",
                "存在未完成准备记录，需核对原批次",
              );
            throw e;
          }
          const prepared = await prepareBatch({
            workspace,
            task,
            ...(action ? { action } : {}),
          });
          const manifest = JSON.parse(
            await readFile(prepared.planFile, "utf8"),
          );
          if (
            manifest.status === "ready" &&
            manifest.items.some(
              (item, i) =>
                hash(item.plan.task) !== hash(task.items[i].task) ||
                hash(item.plan.binding) !== hash(snapshot.binding) ||
                item.targetId !== snapshot.targetId,
            )
          )
            fail("CONTEXT_CHANGED", "准备结果与固定清单不一致");
          const saved = await store.save("prepared", { listId, manifest });
          const receipt = {
            preparedId: saved.id,
            status: prepared.status,
            batchId: prepared.batchId,
            errors: prepared.errors,
            runArguments: { preparedId: saved.id },
          };
          await writeFile(receiptFile, JSON.stringify(receipt), { flag: "wx" });
          return receipt;
        }),
    );
  }

  /** 显式模式复用 runBatch 的锁、日志、过期和重试语义。 */
  async function run(input) {
    fields(input, ["preparedId", "mode"]);
    const { preparedId, mode } = input;
    const prepared = await store.load(preparedId, "prepared");
    await loadChain(prepared.listId, mode !== "reconcile");
    return runBatch({
      workspace,
      manifest: prepared.manifest,
      mode,
      ...(action ? { action } : {}),
    });
  }

  /** 只读已有检查点，不额外核对页面、导航或隐式执行。 */
  async function handoff(input) {
    fields(input, ["preparedId", "mode"]);
    const { preparedId, mode } = input;
    if (!["execute", "rehearse"].includes(mode))
      fail("INVALID_ARGUMENTS", "交接模式为 execute 或 rehearse");
    const prepared = await store.load(preparedId, "prepared");
    const { snapshot } = await loadChain(prepared.listId, false);
    const file = path.join(
      workspace,
      "batches",
      prepared.manifest.id,
      mode === "rehearse" ? "rehearsal.json" : "execution.json",
    );
    const state = JSON.parse(await readFile(file, "utf8"));
    if (
      state.planDigest !== prepared.manifest.digest ||
      state.items.length !== prepared.manifest.items.length ||
      state.items.some((r, i) => r.id !== prepared.manifest.items[i].id)
    )
      fail("BATCH_STATE_CHANGED", "交接状态与计划不一致");
    const rows = prepared.manifest.items.map((item, i) => {
      const task = item.plan.task,
        post = snapshot.result.posts.find(
          (p) => p.postId === task.target.postId,
        );
      return {
        windowId: snapshot.windowId,
        targetId: snapshot.targetId,
        account: snapshot.binding.expectedAccountName,
        accountStatus: "expected-binding-checked-at-prepare",
        circle: snapshot.binding.expectedCircleName,
        postId: task.target.postId,
        url: post.url || snapshot.url,
        urlKind: post.url ? "post" : "observed-page",
        action: task.action,
        commentText: task.content?.text ?? null,
        status:
          state.items[i].status === "running"
            ? "uncertain"
            : state.items[i].status,
        evidence: state.items[i].result ?? null,
        errorCode: state.items[i].code ?? null,
        observedAt: snapshot.observedAt,
      };
    });
    const saved = await store.save("handoff", {
      preparedId,
      mode,
      status: state.status || "needs-attention",
      stateUpdatedAt: state.updatedAt ?? null,
      historical: true,
      rows,
    });
    const markdownPath = saved.file.replace(/\.json$/, ".md");
    // 把数据编码为代码文本，避免内容被解释为 Markdown 链接或标题。
    const markdown =
      "# 狐友工作流交接\n\n历史记录，以 JSON 为完整依据；不代表当前账号或页面状态。\n\n" +
      rows.map((r) => "    " + JSON.stringify(r)).join("\n\n") +
      "\n";
    try {
      await writeFile(markdownPath, markdown, { flag: "wx" });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // 不跟随已有符号链接，也不覆盖旧报告。
      const { lstat } = await import("node:fs/promises");
      if (
        (await lstat(markdownPath)).isSymbolicLink() ||
        (await readFile(markdownPath, "utf8")) !== markdown
      )
        fail("ARTIFACT_CHANGED", "已有交接文件内容不符");
    }
    return {
      jsonPath: saved.file,
      markdownPath,
      rowCount: rows.length,
      finalResponse: `[交接报告](<${markdownPath}>)\n\n[完整 JSON](<${saved.file}>)`,
    };
  }
  return { query, sample, freeze, prepare, run, handoff };
}
