import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateBatch, prepareBatch, runBatch } from "../scripts/lib/batch.js";
import { sealPlan } from "../scripts/lib/actions/schema.js";
async function temp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-skill-batch-"));
  try {
    await fn(dir);
  } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()))
      throw Error("Unsafe cleanup");
    await rm(dir, { recursive: true, force: true });
  }
}
const task = (binding, postId) => ({
  version: 2,
  binding,
  action: "like-post",
  target: { postId },
});
const input = {
  version: 3,
  concurrency: 2,
  intervalMs: 0,
  items: [
    { id: "a", task: task("one", "1") },
    { id: "b", task: task("alias", "2") },
    { id: "c", task: task("two", "3") },
  ],
};
const binding = (name) => ({
  browserId: name === "two" ? "two" : "one",
  expectedAccountName: name,
  expectedCircleName: "circle",
});
async function prepared(workspace, extra = {}) {
  const r = await prepareBatch({
    workspace,
    task: input,
    resolveBinding: async (w, n) => binding(n),
    action: async ({ task }) =>
      sealPlan({
        version: 2,
        kind: "huyou-action-plan",
        status: "ready",
        expiresAt: new Date(Date.now() + 900000).toISOString(),
        task,
        binding: binding(task.binding),
        evidence: { account: { name: task.binding } },
      }),
    ...extra,
  });
  return JSON.parse(await readFile(r.planFile, "utf8"));
}
test("batch rejects unknown fields, excessive concurrency and duplicate IDs", () => {
  assert.throws(() => validateBatch({ ...input, autoRetry: true }), {
    code: "INVALID_BATCH",
  });
  assert.throws(() => validateBatch({ ...input, concurrency: 5 }), {
    code: "INVALID_BATCH",
  });
  assert.throws(
    () => validateBatch({ ...input, items: [input.items[0], input.items[0]] }),
    { code: "INVALID_BATCH_ITEM" },
  );
});
test("physical windows serialize aliases while different windows overlap", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace),
      active = new Set();
    let peak = 0;
    const order = [];
    const r = await runBatch({
      workspace,
      manifest,
      mode: "rehearse",
      action: async ({ plan }) => {
        const id = plan.binding.browserId;
        assert(!active.has(id));
        active.add(id);
        peak = Math.max(peak, active.size);
        order.push(plan.task.target.postId);
        await new Promise((r) => setTimeout(r, 20));
        active.delete(id);
        return { status: "rehearsed" };
      },
    });
    assert.equal(r.status, "completed");
    assert.equal(peak, 2);
    assert(order.indexOf("1") < order.indexOf("2"));
  }));
test("uncertainty stops that window, other window completes, resume does not resend", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace);
    let calls = 0;
    const action = async ({ plan }) => {
      calls++;
      return {
        status: plan.task.target.postId === "1" ? "uncertain" : "verified-ui",
      };
    };
    let r = await runBatch({ workspace, manifest, mode: "execute", action });
    assert.deepEqual(r.counts, { uncertain: 1, queued: 1, "verified-ui": 1 });
    r = await runBatch({ workspace, manifest, mode: "execute", action });
    assert.equal(calls, 2);
    await runBatch({
      workspace,
      manifest,
      mode: "reconcile",
      action: async ({ command }) => {
        assert.equal(command, "reconcile");
        return { status: "verified-ui" };
      },
    });
    r = await runBatch({ workspace, manifest, mode: "execute", action });
    assert.equal(r.status, "completed");
    assert.equal(calls, 3);
  }));
test("STOP leaves queued items and resumes only after removal", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace),
      stop = path.join(workspace, "batches", manifest.id, "STOP");
    await writeFile(stop, "stop");
    let calls = 0;
    const action = async () => {
      calls++;
      return { status: "rehearsed" };
    };
    assert.equal(
      (await runBatch({ workspace, manifest, mode: "rehearse", action })).counts
        .queued,
      3,
    );
    assert.equal(calls, 0);
    await rm(stop);
    assert.equal(
      (await runBatch({ workspace, manifest, mode: "rehearse", action }))
        .status,
      "completed",
    );
    assert.equal(calls, 3);
  }));
test("crashed running checkpoint is not dispatched again", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace);
    const file = path.join(workspace, "batches", manifest.id, "execution.json");
    await writeFile(
      file,
      JSON.stringify({
        planDigest: manifest.digest,
        items: [
          { id: "a", status: "running" },
          { id: "b", status: "queued" },
          { id: "c", status: "verified-ui" },
        ],
      }),
    );
    const r = await runBatch({
      workspace,
      manifest,
      mode: "execute",
      action: async () => {
        throw Error("must not dispatch");
      },
    });
    assert.equal(r.items[0].code, "INTERRUPTED_IN_FLIGHT");
    assert.equal(r.counts.queued, 1);
  }));
test("rehearsal checkpoints do not suppress an authorized execution", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace);
    await runBatch({
      workspace,
      manifest,
      mode: "rehearse",
      action: async () => ({ status: "rehearsed" }),
    });
    let calls = 0;
    const r = await runBatch({
      workspace,
      manifest,
      mode: "execute",
      action: async () => {
        calls++;
        return { status: "verified-ui" };
      },
    });
    assert.equal(r.status, "completed");
    assert.equal(calls, 3);
  }));
test("failed preparation cannot become an executable manifest", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace, {
      action: async () => {
        throw Error("offline");
      },
    });
    assert.equal(manifest.status, "blocked");
    await assert.rejects(runBatch({ workspace, manifest, mode: "execute" }), {
      code: "BATCH_NOT_READY",
    });
  }));
test("cleanup warnings keep remaining window items blocked across resume", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace);
    let calls = 0;
    const action = async () => {
      calls++;
      return { status: "verified-ui", cleanupWarning: "CHECK_PAGE" };
    };
    await runBatch({ workspace, manifest, mode: "execute", action });
    const r = await runBatch({ workspace, manifest, mode: "execute", action });
    assert.equal(calls, 2);
    assert.equal(r.counts.queued, 1);
  }));
test("expired child plan stops before dispatch and edited manifest is rejected", () =>
  temp(async (workspace) => {
    let manifest = await prepared(workspace);
    manifest.items[0].plan = sealPlan({
      ...manifest.items[0].plan,
      expiresAt: "2000-01-01T00:00:00Z",
    });
    // 从正文重新计算密封摘要，不包含旧摘要。
    const { digest: childDigest, ...child } = manifest.items[0].plan;
    manifest.items[0].plan = sealPlan(child);
    const { digest, ...body } = manifest;
    manifest = sealPlan(body);
    let calls = 0;
    const r = await runBatch({
      workspace,
      manifest,
      mode: "execute",
      action: async () => {
        calls++;
        return { status: "verified-ui" };
      },
    });
    assert.equal(r.items[0].status, "failed");
    assert.equal(r.items[0].code, "PLAN_EXPIRED");
    assert.equal(calls, 1);
    manifest.concurrency = 4;
    await assert.rejects(runBatch({ workspace, manifest, mode: "execute" }), {
      code: "BATCH_CHANGED",
    });
  }));
test("same batch cannot run in two processes concurrently", () =>
  temp(async (workspace) => {
    const manifest = await prepared(workspace);
    let release, started;
    const ready = new Promise((r) => (started = r)),
      gate = new Promise((r) => (release = r));
    const first = runBatch({
      workspace,
      manifest,
      mode: "rehearse",
      action: async () => {
        started();
        await gate;
        return { status: "rehearsed" };
      },
    });
    await ready;
    await assert.rejects(runBatch({ workspace, manifest, mode: "execute" }), {
      code: "WINDOW_BUSY",
    });
    release();
    await first;
  }));
