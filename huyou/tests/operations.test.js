import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  recordOperationEvidence,
  listOperations,
  classifyInteractionResult,
} from "../scripts/operations.js";
import { interactionBatchFromPosts } from "../scripts/batch-targets.js";
import { buildActionPlan, executePlan } from "../scripts/lib/actions/engine.js";
import { Journal } from "../scripts/lib/actions/journal.js";
const binding = {
  browserId: "test",
  expectedAccountName: "me",
  expectedCircleName: "circle",
};
const task = {
  version: 2,
  binding,
  action: "follow-user",
  target: { postId: "123" },
};
const evidence = {
  account: { name: "me", avatar: "me.png" },
  follow: {
    author: { name: "other", avatar: "other.png" },
    followState: "not-followed",
  },
};
async function temporary(fn) {
  const p = await mkdtemp(path.join(os.tmpdir(), "huyou-ops-"));
  try {
    await fn(p);
  } finally {
    if (path.dirname(p) !== os.tmpdir()) throw Error("unsafe");
    await rm(p, { recursive: true, force: true });
  }
}
test("external clicks block retry; human confirmation preserves provenance", () =>
  temporary(async (workspace) => {
    let submits = 0;
    const adapter = {
      prepare: async () => evidence,
      stage: async () => ({}),
      assertStaged: async () => {},
      submit: async () => {
        submits++;
        return {};
      },
      verify: async () => ({ status: "verified-ui" }),
    };
    const plan = await buildActionPlan(task, binding, adapter);
    await recordOperationEvidence({
      workspace,
      plan,
      source: "external-execution",
      note: "clicked by another caller",
    });
    assert.equal(
      (await executePlan(plan, adapter, new Journal(workspace))).status,
      "blocked-uncertain",
    );
    await recordOperationEvidence({
      workspace,
      plan,
      source: "user-confirmation",
      note: "user checked profile",
      confirmed: true,
    });
    assert.equal(
      (await executePlan(plan, adapter, new Journal(workspace))).status,
      "skipped-duplicate",
    );
    const r = await listOperations({ workspace });
    assert.equal(r.operations[0].evidenceHistory.length, 2);
    assert.equal(submits, 0);
  }));
test("unified follow executes once and shares author key across posts", () =>
  temporary(async (workspace) => {
    let submits = 0;
    const adapter = {
      prepare: async () => evidence,
      stage: async () => ({}),
      assertStaged: async () => {},
      submit: async () => {
        submits++;
        return {};
      },
      verify: async () => ({ status: "verified-ui" }),
    };
    const p = await buildActionPlan(task, binding, adapter),
      q = await buildActionPlan(
        { ...task, target: { postId: "456" } },
        binding,
        adapter,
      );
    assert.equal(
      (await executePlan(p, adapter, new Journal(workspace))).status,
      "verified-ui",
    );
    assert.equal(
      (await executePlan(q, adapter, new Journal(workspace))).status,
      "skipped-duplicate",
    );
    assert.equal(submits, 1);
  }));
test("follow skip and incomplete batch boundaries", () =>
  temporary(async (workspace) => {
    const adapter = {
      prepare: async () => ({
        ...evidence,
        follow: { ...evidence.follow, followState: "followed" },
      }),
    };
    const p = await buildActionPlan(task, binding, adapter);
    assert.equal(
      (await executePlan(p, adapter, new Journal(workspace))).status,
      "skipped-already-followed",
    );
    const posts = [
      { id: "1", author: { name: "me", avatar: "me.png" } },
      { id: "2", author: { name: "a", avatar: "https://x/a.png" } },
      { id: "3", author: { name: "a", avatar: "https://y/a.png" } },
    ];
    const options = {
      posts,
      binding,
      action: "follow-user",
      excludeSelfName: "me",
    };
    assert.equal(interactionBatchFromPosts(options).items.length, 1);
    assert.throws(
      () => interactionBatchFromPosts({ ...options, complete: false }),
      { code: "INCOMPLETE_QUERY" },
    );
    assert.equal(
      classifyInteractionResult({ status: "uncertain" }).decision,
      "reconcile",
    );
    assert.equal(
      classifyInteractionResult({ code: "ACCOUNT_MISMATCH" }).decision,
      "stop",
    );
  }));
