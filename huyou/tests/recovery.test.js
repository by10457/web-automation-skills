import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DraftStore, assertOwnedDraft } from "../scripts/lib/actions/drafts.js";
import { HuyouAdapter } from "../scripts/lib/actions/adapter.js";
import {
  buildActionPlan,
  reconcilePlan,
  executePlan,
} from "../scripts/lib/actions/engine.js";
import { Journal } from "../scripts/lib/actions/journal.js";
import { operationKey } from "../scripts/lib/actions/schema.js";
const binding = {
  browserId: "test",
  expectedAccountName: "me",
  expectedCircleName: "circle",
};
async function temp(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "huyou-recovery-"));
  try {
    await fn(root);
  } finally {
    if (path.dirname(root) !== os.tmpdir()) throw Error("unsafe");
    await rm(root, { recursive: true, force: true });
  }
}
test("draft ownership survives a new store; changed tab, text, binding and partial input rejected", () =>
  temp(async (root) => {
    const plan = {
      digest: "a".repeat(64),
      binding,
      task: { content: { text: "完整内容" } },
    };
    const record = {
      status: "owned",
      planDigest: plan.digest,
      binding,
      targetId: "tab",
      text: "完整内容",
    };
    await new DraftStore(root).save(plan.digest, record);
    const saved = await new DraftStore(root).get(plan.digest);
    assertOwnedDraft(saved, plan, "tab");
    for (const change of [
      { status: "intent" },
      { text: "完整内容修改" },
      { binding: { ...binding, browserId: "other" } },
    ])
      assert.throws(
        () => assertOwnedDraft({ ...saved, ...change }, plan, "tab"),
        { code: "DRAFT_NOT_OWNED" },
      );
    assert.throws(() => assertOwnedDraft(saved, plan, "other"), {
      code: "DRAFT_NOT_OWNED",
    });
  }));
test("clear refuses edited full text or changed reply target", async () => {
  let value = "正文 加了内容",
    placeholder = "评论 作者:",
    clicks = 0;
  const el = {
    evaluate: async (fn) => fn({ value, getAttribute: () => placeholder }),
    click: async () => {
      clicks++;
    },
  };
  const page = {
    $: async () => el,
    keyboard: {
      down: async () => {},
      up: async () => {},
      press: async (k) => {
        if (k === "Backspace") value = "";
      },
    },
  };
  const adapter = new HuyouAdapter(page, binding);
  adapter.ownDraft = { selector: "editor", text: "正文", placeholder };
  await assert.rejects(() => adapter.clearOwnDraft(), {
    code: "DRAFT_CHANGED",
  });
  assert.equal(clicks, 0);
  value = "正文";
  placeholder = "回复 其他人:";
  await assert.rejects(() => adapter.clearOwnDraft(), {
    code: "DRAFT_TARGET_CHANGED",
  });
  assert.equal(clicks, 0);
  placeholder = "评论 作者:";
  await adapter.clearOwnDraft();
  assert.equal(value, "");
});
test("reconciliation reads positive evidence despite draft without preparing or submitting", () =>
  temp(async (root) => {
    const evidence = { account: { name: "me" }, post: { authorName: "other" } };
    const task = {
      version: 2,
      binding,
      action: "comment",
      target: { postId: "123" },
      content: { text: "你好" },
    };
    const plan = await buildActionPlan(task, binding, {
      prepare: async () => evidence,
    });
    const journal = new Journal(root);
    await journal.begin(operationKey(plan), {
      status: "pending",
      baseline: { beforeMatches: 0 },
    });
    const adapter = {
      verifyOnce: async () => ({ source: "new-own-top-level-comment" }),
      prepare: async () => {
        throw Error("must not prepare");
      },
      submit: async () => {
        throw Error("must not submit");
      },
    };
    assert.equal(
      (await reconcilePlan(plan, adapter, journal)).status,
      "verified-ui",
    );
    assert.equal(
      (await executePlan(plan, adapter, journal)).status,
      "skipped-duplicate",
    );
  }));
test("draft-blocked reconciliation keeps pending baseline and blocks retry", () =>
  temp(async (root) => {
    const plan = await buildActionPlan(
      {
        version: 2,
        binding,
        action: "comment",
        target: { postId: "123" },
        content: { text: "你好" },
      },
      binding,
      { prepare: async () => ({ account: { name: "me" } }) },
    );
    const journal = new Journal(root),
      key = operationKey(plan);
    await journal.begin(key, {
      status: "pending",
      baseline: { beforeMatches: 0 },
    });
    const adapter = {
      verifyOnce: async () => null,
      prepare: async () => {
        throw Object.assign(Error("draft"), { code: "EXISTING_DRAFT" });
      },
    };
    const result = await reconcilePlan(plan, adapter, journal);
    assert.equal(result.nextAction, "inspect-owned-draft");
    const record = await journal.get(key);
    assert.equal(record.status, "pending");
    assert.deepEqual(record.baseline, { beforeMatches: 0 });
    assert.equal(record.lastReconciliation.error.code, "EXISTING_DRAFT");
    assert.equal(
      (await executePlan(plan, adapter, journal)).status,
      "blocked-uncertain",
    );
  }));
