/** 工作流离线验收：所有页面动作均使用注入的模拟函数。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPostWorkflow } from "../scripts/workflow.js";
import { sealPlan } from "../scripts/lib/actions/schema.js";

const binding = {
  browserId: "window-A",
  expectedAccountName: "account-A",
  expectedCircleName: "circle-A",
};
const queryResult = {
  complete: true,
  stopReason: "requested-count",
  query: { limit: 3 },
  warnings: [],
  posts: [1, 2, 3].map((id) => ({
    id: String(id),
    text: "post " + id,
    author: { name: "author", avatar: "https://example.com/a.png" },
  })),
};
async function fixture(options = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "huyou-workflow-"));
  const calls = [];
  const action = async ({ command, task, plan }) => {
    calls.push(command);
    if (command === "prepare")
      return sealPlan({
        version: 2,
        kind: "huyou-action-plan",
        status: "ready",
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        task,
        binding,
        evidence: { account: { name: "account-A" } },
      });
    return {
      status:
        command === "rehearse"
          ? "rehearsed"
          : options.uncertain && plan.task.action === "comment"
            ? "uncertain"
            : "verified-ui",
    };
  };
  const workflow = createPostWorkflow({
    workspace,
    action,
    collect: async () => ({
      binding,
      targetId: "tab-A",
      url: "https://hy.sns.sohu.com/",
      result: structuredClone(queryResult),
    }),
    ...options,
  });
  return { workflow, workspace, calls };
}

test("snapshot selection and frozen comments run through the existing batch engine and export exact rows", async () => {
  const { workflow: w, calls } = await fixture();
  const s = await w.query({ binding, query: { limit: 3 } });
  const sample = await w.sample({
    snapshotId: s.snapshotId,
    count: 2,
    seed: "repeatable",
  });
  assert.equal(new Set(sample.items.map((p) => p.postId)).size, 2);
  const again = await w.sample({
    snapshotId: s.snapshotId,
    count: 2,
    seed: "repeatable",
  });
  assert.equal(sample.sampleId, again.sampleId);
  const comments = sample.items.map((p) => ({
    itemRef: p.itemRef,
    text: "fixed " + p.postId,
  }));
  const frozen = await w.freeze({ sampleId: sample.sampleId, comments });
  assert.deepEqual(
    await w.freeze({ sampleId: sample.sampleId, comments }),
    frozen,
  );
  const prepared = await w.prepare(frozen.prepareArguments);
  await w.prepare(frozen.prepareArguments);
  assert.equal(calls.filter((c) => c === "prepare").length, 4);
  const result = await w.run({ ...prepared.runArguments, mode: "execute" });
  assert.equal(result.status, "completed");
  await w.run({ ...prepared.runArguments, mode: "execute" });
  assert.equal(calls.filter((c) => c === "execute").length, 4);
  const report = await w.handoff({ ...prepared.runArguments, mode: "execute" });
  const json = JSON.parse(await readFile(report.jsonPath, "utf8"));
  assert.equal(json.rows.length, 4);
  assert(
    json.rows.every(
      (r) =>
        r.windowId === "window-A" &&
        r.targetId === "tab-A" &&
        r.url === "https://hy.sns.sohu.com/" &&
        r.urlKind === "observed-page",
    ),
  );
  assert.deepEqual(
    json.rows.filter((r) => r.action === "comment").map((r) => r.commentText),
    comments.map((c) => c.text),
  );
  assert(report.finalResponse.includes(report.jsonPath));
});

test("rejects wrong references, partial coverage, insufficient candidates and duplicate/missing comments", async () => {
  const { workflow: w } = await fixture();
  const s = await w.query({ binding });
  await assert.rejects(w.sample({ snapshotId: "../outside", count: 1 }), {
    code: "INVALID_REFERENCE",
  });
  await assert.rejects(w.sample({ snapshotId: s.snapshotId, count: 4 }), {
    code: "INSUFFICIENT_CANDIDATES",
  });
  const a = await w.sample({ snapshotId: s.snapshotId, count: 2, seed: "s" });
  await assert.rejects(
    w.freeze({
      sampleId: a.sampleId,
      comments: [{ itemRef: "wrong", text: "x" }],
    }),
    { code: "INVALID_COMMENTS" },
  );
  await assert.rejects(
    w.freeze({
      sampleId: a.sampleId,
      comments: a.items.map(() => ({ itemRef: a.items[0].itemRef, text: "x" })),
    }),
    { code: "INVALID_COMMENTS" },
  );
  const { workflow: p } = await fixture({
    collect: async () => ({
      binding,
      targetId: "tab-A",
      url: "https://hy.sns.sohu.com/",
      result: { ...queryResult, complete: false },
    }),
  });
  const partial = await p.query({ binding });
  await assert.rejects(p.sample({ snapshotId: partial.snapshotId, count: 1 }), {
    code: "INCOMPLETE_QUERY",
  });
  assert.equal(
    (
      await p.sample({
        snapshotId: partial.snapshotId,
        count: 1,
        allowPartial: true,
      })
    ).items.length,
    1,
  );
});

test("stale or edited snapshots cannot prepare actions", async () => {
  let now = Date.now();
  const { workflow: w } = await fixture({ now: () => now });
  const s = await w.query({ binding });
  now += 31 * 60000;
  await assert.rejects(w.sample({ snapshotId: s.snapshotId, count: 1 }), {
    code: "SNAPSHOT_EXPIRED",
  });
  now -= 31 * 60000;
  const data = JSON.parse(await readFile(s.jsonPath, "utf8"));
  data.binding.browserId = "other";
  await writeFile(s.jsonPath, JSON.stringify(data));
  await assert.rejects(w.sample({ snapshotId: s.snapshotId, count: 1 }), {
    code: "ARTIFACT_CHANGED",
  });
});

test("uncertain comment blocks remaining work and handoff preserves per-action evidence", async () => {
  const { workflow: w, calls } = await fixture({ uncertain: true });
  const s = await w.query({ binding });
  const a = await w.sample({ snapshotId: s.snapshotId, count: 2 });
  const f = await w.freeze({
    sampleId: a.sampleId,
    comments: a.items.map((p) => ({ itemRef: p.itemRef, text: "text" })),
  });
  const p = await w.prepare(f.prepareArguments);
  const result = await w.run({ ...p.runArguments, mode: "execute" });
  assert.deepEqual(result.counts, {
    "verified-ui": 1,
    uncertain: 1,
    queued: 2,
  });
  await w.run({ ...p.runArguments, mode: "execute" });
  assert.equal(calls.filter((x) => x === "execute").length, 2);
  const report = JSON.parse(
    await readFile(
      (await w.handoff({ ...p.runArguments, mode: "execute" })).jsonPath,
      "utf8",
    ),
  );
  assert.deepEqual(
    report.rows.map((r) => r.status),
    ["verified-ui", "uncertain", "queued", "queued"],
  );
});

test("frozen text cannot change and existing batch targets are excluded from later samples", async () => {
  const { workflow: w } = await fixture();
  const s = await w.query({ binding });
  const a = await w.sample({ snapshotId: s.snapshotId, count: 2 });
  const comments = a.items.map((p) => ({ itemRef: p.itemRef, text: "fixed" }));
  const f = await w.freeze({ sampleId: a.sampleId, comments });
  await assert.rejects(
    w.freeze({
      sampleId: a.sampleId,
      comments: comments.map((c) => ({ ...c, text: "changed" })),
    }),
    { code: "FROZEN_LIST_CHANGED" },
  );
  await w.prepare(f.prepareArguments);
  await assert.rejects(w.sample({ snapshotId: s.snapshotId, count: 2 }), {
    code: "INSUFFICIENT_CANDIDATES",
  });
  const remaining = await w.sample({ snapshotId: s.snapshotId, count: 1 });
  assert(!a.items.some((p) => p.postId === remaining.items[0].postId));
});

test("mismatched context and conflicting duplicate post IDs fail before actions", async () => {
  const { workflow: w, calls } = await fixture({
    collect: async () => ({
      binding: { ...binding, browserId: "wrong" },
      targetId: "tab-A",
      url: "https://hy.sns.sohu.com/",
      result: queryResult,
    }),
  });
  await assert.rejects(w.query({ binding }), { code: "CONTEXT_CHANGED" });
  assert.equal(calls.length, 0);
  const { workflow: other } = await fixture({
    collect: async () => ({
      binding,
      targetId: "tab-A",
      url: "https://hy.sns.sohu.com/",
      result: {
        ...queryResult,
        posts: [
          queryResult.posts[0],
          { ...queryResult.posts[0], text: "different" },
        ],
      },
    }),
  });
  await assert.rejects(other.query({ binding }), { code: "AMBIGUOUS_POST" });
});

test("rehearsal is separate from execution and reports its real mode", async () => {
  const { workflow: w, calls } = await fixture();
  const s = await w.query({ binding });
  const a = await w.sample({ snapshotId: s.snapshotId, count: 1 });
  const f = await w.freeze({
    sampleId: a.sampleId,
    comments: [{ itemRef: a.items[0].itemRef, text: "hi" }],
  });
  const p = await w.prepare(f.prepareArguments);
  await w.run({ ...p.runArguments, mode: "rehearse" });
  assert.equal(calls.filter((c) => c === "execute").length, 0);
  const report = JSON.parse(
    await readFile(
      (await w.handoff({ ...p.runArguments, mode: "rehearse" })).jsonPath,
      "utf8",
    ),
  );
  assert.equal(report.mode, "rehearse");
  assert(report.rows.every((r) => r.status === "rehearsed"));
  await w.run({ ...p.runArguments, mode: "execute" });
  assert.equal(calls.filter((c) => c === "execute").length, 2);
});

test("CLI samples saved snapshots offline and rejects runtime dependency injection", async () => {
  const { workflow: w, workspace } = await fixture();
  const s = await w.query({ binding });
  const input = path.join(workspace, "cli-request.json");
  await writeFile(
    input,
    JSON.stringify({
      workspace,
      snapshotId: s.snapshotId,
      count: 1,
      seed: "cli",
    }),
  );
  const cli = fileURLToPath(
    new URL("../scripts/workflow-cli.js", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [cli, "sample", "--input", input],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.items.length, 1);
  await writeFile(
    input,
    JSON.stringify({ workspace, binding, collect: "not-allowed" }),
  );
  const rejected = spawnSync(
    process.execPath,
    [cli, "query", "--input", input],
    { encoding: "utf8" },
  );
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, "INVALID_ARGUMENTS");
});

test("truncated posts are excluded and preparation failure stays blocked on repeat", async () => {
  const { workflow: w, calls } = await fixture({
    collect: async () => ({
      binding,
      targetId: "tab-A",
      url: "https://hy.sns.sohu.com/",
      result: {
        ...queryResult,
        posts: queryResult.posts.map((p) => ({ ...p, textTruncated: true })),
      },
    }),
  });
  const s = await w.query({ binding });
  await assert.rejects(w.sample({ snapshotId: s.snapshotId, count: 1 }), {
    code: "INSUFFICIENT_CANDIDATES",
  });
  assert.equal(calls.length, 0);
  const { workflow: failed } = await fixture({
    action: async () => {
      throw new Error("offline preparation failure");
    },
  });
  const snapshot = await failed.query({ binding });
  const sample = await failed.sample({
    snapshotId: snapshot.snapshotId,
    count: 1,
  });
  const list = await failed.freeze({
    sampleId: sample.sampleId,
    comments: [{ itemRef: sample.items[0].itemRef, text: "fixed" }],
  });
  const prepared = await failed.prepare(list.prepareArguments);
  assert.equal(prepared.status, "blocked");
  assert.equal(prepared.errors.length, 2);
  assert.deepEqual(await failed.prepare(list.prepareArguments), prepared);
  await assert.rejects(
    failed.run({ ...prepared.runArguments, mode: "execute" }),
    { code: "BATCH_NOT_READY" },
  );
});

test("reconciliation updates uncertain work without replaying success", async () => {
  const { workflow: w, workspace, calls } = await fixture({ uncertain: true });
  const s = await w.query({ binding });
  const a = await w.sample({ snapshotId: s.snapshotId, count: 1 });
  const f = await w.freeze({
    sampleId: a.sampleId,
    comments: [{ itemRef: a.items[0].itemRef, text: "fixed" }],
  });
  const p = await w.prepare(f.prepareArguments);
  await w.run({ ...p.runArguments, mode: "execute" });
  const resumed = createPostWorkflow({
    workspace,
    action: async ({ command, plan }) => {
      assert.equal(command, "reconcile");
      assert.equal(plan.task.action, "comment");
      return { status: "verified-ui" };
    },
  });
  assert.equal(
    (await resumed.run({ ...p.runArguments, mode: "reconcile" })).status,
    "completed",
  );
  await w.run({ ...p.runArguments, mode: "execute" });
  assert.equal(calls.filter((c) => c === "execute").length, 2);
});
