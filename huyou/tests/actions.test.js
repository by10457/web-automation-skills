import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateActionTask,
  matchComment,
  sealPlan,
  verifyPlan,
  operationKey,
} from "../scripts/lib/actions/schema.js";
import {
  buildActionPlan,
  executePlan,
  reconcilePlan,
} from "../scripts/lib/actions/engine.js";
import { Journal } from "../scripts/lib/actions/journal.js";
const binding = {
  browserId: "one",
  expectedAccountName: "operator",
  expectedCircleName: "circle",
};
const task = {
  version: 2,
  binding: "one",
  action: "comment",
  target: { postId: "1000000000000000001" },
  content: { text: "具体回复" },
};
function mock() {
  let submits = 0;
  return {
    prepare: async () => ({
      account: { name: "operator", avatar: "me.png" },
      post: {
        postId: task.target.postId,
        text: "问题",
        authorName: "author",
        circleName: "circle",
      },
    }),
    stage: async () => ({ beforeMatches: 0 }),
    assertStaged: async () => {},
    submit: async () => {
      submits++;
      return {};
    },
    verify: async () => ({
      status: "verified-ui",
      evidence: { source: "test" },
    }),
    verifyOnce: async () => ({ source: "test" }),
    get submits() {
      return submits;
    },
  };
}
async function temp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-skill-actions-"));
  try {
    return await fn(dir);
  } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()))
      throw Error("Unsafe test cleanup");
    await rm(dir, { recursive: true, force: true });
  }
}
test("tasks reject unsupported media, ambiguous action fields, non-string IDs", () => {
  assert.throws(
    () => validateActionTask({ ...task, target: { postId: 123 } }),
    { code: "INVALID_TARGET" },
  );
  assert.throws(
    () =>
      validateActionTask({ ...task, content: { text: "x", images: ["a"] } }),
    { code: "INVALID_CONTENT" },
  );
  assert.throws(
    () => validateActionTask({ ...task, execution: { mode: "execute" } }),
    { code: "INVALID_TASK" },
  );
});
test("plans detect modified text and expired previews", async () => {
  const p = await buildActionPlan(task, binding, mock(), { now: 1000 });
  assert.throws(() => verifyPlan(p, 1000 + 16 * 60000), {
    code: "PLAN_EXPIRED",
  });
  const changed = structuredClone(p);
  changed.task.content.text = "different";
  assert.throws(() => verifyPlan(changed, 1001), { code: "PLAN_CHANGED" });
});
test("same-name same-content comments fail closed, nested target unsupported", () => {
  const c = { authorName: "a", text: "same", avatar: "a.png", isReply: false };
  assert.throws(() => matchComment([c, c], c), { code: "AMBIGUOUS_COMMENT" });
  assert.throws(() => matchComment([{ ...c, isReply: true }], c), {
    code: "NESTED_REPLY_UNSUPPORTED",
  });
});
test("durable duplicate protection survives a new journal instance", async () =>
  temp(async (dir) => {
    const a = mock(),
      p = await buildActionPlan(task, binding, a);
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "verified-ui",
    );
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "skipped-duplicate",
    );
    assert.equal(a.submits, 1);
  }));
test("timeout after click is uncertain and cannot resubmit", async () =>
  temp(async (dir) => {
    const a = mock(),
      p = await buildActionPlan(task, binding, a);
    a.verify = async () => {
      throw Error("timeout");
    };
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "uncertain",
    );
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "blocked-uncertain",
    );
    assert.equal(a.submits, 1);
  }));
test("pending crash record blocks writes even when no success response exists", async () =>
  temp(async (dir) => {
    const a = mock(),
      p = await buildActionPlan(task, binding, a),
      j = new Journal(dir);
    await j.begin(operationKey(p), {
      status: "pending",
      baseline: { beforeMatches: 0 },
    });
    assert.equal((await executePlan(p, a, j)).status, "blocked-uncertain");
    assert.equal(a.submits, 0);
    assert.equal((await reconcilePlan(p, a, j)).status, "verified-ui");
    assert.equal(a.submits, 0);
  }));
test("preflight failure creates no submitted journal record", async () =>
  temp(async (dir) => {
    const a = mock(),
      p = await buildActionPlan(task, binding, a),
      j = new Journal(dir);
    a.assertStaged = async () => {
      throw Error("changed");
    };
    await assert.rejects(executePlan(p, a, j), /changed/);
    assert.equal(await j.get(operationKey(p)), null);
    assert.equal(a.submits, 0);
  }));
test("journal failure prevents click", async () => {
  const a = mock(),
    p = await buildActionPlan(task, binding, a);
  await assert.rejects(
    executePlan(p, a, {
      get: async () => null,
      begin: async () => {
        throw Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(a.submits, 0);
});
test("journal finalization failure remains uncertain instead of permitting retry", async () => {
  const a = mock(),
    p = await buildActionPlan(task, binding, a);
  const result = await executePlan(p, a, {
    get: async () => null,
    begin: async () => {},
    finish: async () => {
      throw Error("disk full");
    },
  });
  assert.equal(result.status, "uncertain");
  assert.equal(result.code, "JOURNAL_UPDATE_FAILED");
  assert.equal(a.submits, 1);
});
test("already-liked comment is skipped without toggling", async () =>
  temp(async (dir) => {
    const a = mock();
    a.prepare = async () => ({
      account: { name: "operator", avatar: "me.png" },
      comment: {
        authorName: "a",
        text: "yes",
        isReply: false,
        like: { state: "liked" },
      },
    });
    const p = await buildActionPlan(
      {
        version: 2,
        binding: "one",
        action: "like-comment",
        target: { postId: "123", comment: { authorName: "a", text: "yes" } },
      },
      binding,
      a,
    );
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "skipped-already-liked",
    );
    assert.equal(a.submits, 0);
  }));
