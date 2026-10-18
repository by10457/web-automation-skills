import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { route, withWindowLock, hash } from "../scripts/lib/core.js";
import { validateTask, sealPlan, operationKey } from "../scripts/lib/plans.js";
import { describeImages, verifyImages } from "../scripts/lib/files.js";
import { Journal } from "../scripts/lib/journal.js";
import { executePlan } from "../scripts/lib/engine.js";
import { assertContext, assertNoDraft } from "../scripts/lib/dom.js";
import { resolveComment } from "../scripts/comments.js";
import {
  filterPosts,
  normalizeQuery,
  parsePostTime,
  resolvePost,
  queryPosts,
} from "../scripts/posts.js";
import { validateBinding } from "../scripts/session.js";
import {
  ActionAdapter,
  commentActor,
  confirmPreviews,
  postIdentity,
} from "../scripts/lib/action-adapter.js";
const binding = {
  browserId: "test",
  expectedAccountName: "global",
  expectedChannelName: "channel",
  channelId: "abc",
  expectedChannelAccountName: "alias",
};
const target = { url: "https://pd.qq.com/g/abc/post/B_testX60?subc=12" };
function plan(action = "comment") {
  const task = validateTask(
    {
      action,
      target,
      ...(action === "like-post" ? {} : { content: { text: "hello" } }),
    },
    binding,
  );
  return sealPlan({
    version: 1,
    kind: "qq-channel-action-plan",
    binding,
    task,
    images: [],
    evidence: {
      account: { name: "global", channelName: "alias" },
      post: { id: "B_testX60" },
    },
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  });
}
async function tmp(fn) {
  const p = await mkdtemp(path.join(os.tmpdir(), "qq-skill-"));
  try {
    await fn(p);
  } finally {
    if (path.dirname(p) !== os.tmpdir()) throw Error("unsafe cleanup");
    await rm(p, { recursive: true, force: true });
  }
}
test("route accepts opaque post IDs and rejects external sites and chat", () => {
  assert.equal(route(target.url).postId, "B_testX60");
  assert.throws(() => route("https://pd.qq.com/g/abc/text/1"), {
    code: "UNSUPPORTED_PAGE",
  });
  assert.throws(() => route("https://evil.example/g/abc"), {
    code: "WRONG_SITE",
  });
});
test("binding checks distinguish global nickname from channel alias and wrong channel", () => {
  const s = {
    url: target.url,
    account: { name: "global", avatar: "https://a/avatar" },
    channel: { id: "abc", name: "channel" },
    notices: [],
  };
  assertContext(s, binding);
  assert.throws(
    () =>
      assertContext(
        { ...s, account: { ...s.account, name: "alias" } },
        binding,
      ),
    { code: "ACCOUNT_MISMATCH" },
  );
  assert.throws(
    () =>
      assertContext(
        { ...s, channel: { id: "wrong", name: "channel" } },
        binding,
      ),
    { code: "CHANNEL_MISMATCH" },
  );
  assert.throws(() => assertNoDraft({ draft: true }), {
    code: "EXISTING_DRAFT",
  });
});
test("task rejects popular publish view, foreign post, images on comment and unknown action", () => {
  assert.throws(
    () =>
      validateTask(
        { action: "publish", board: "热门", content: { text: "hi" } },
        binding,
      ),
    { code: "INVALID_BOARD" },
  );
  assert.throws(
    () =>
      validateTask(
        {
          action: "comment",
          target: { url: "https://pd.qq.com/g/other/post/B_x" },
          content: { text: "hi" },
        },
        binding,
      ),
    { code: "INVALID_TARGET" },
  );
  assert.throws(
    () =>
      validateTask(
        { action: "comment", target, content: { text: "hi", images: ["x"] } },
        binding,
      ),
    { code: "UNSUPPORTED_CONTENT" },
  );
  assert.throws(() => validateTask({ action: "delete", target }, binding), {
    code: "INVALID_ACTION",
  });
});
test("comment resolution rejects duplicate identities and nested replies", () => {
  const c = { id: "c_a", author: { name: "a" }, text: "same", isReply: false };
  assert.equal(resolveComment([c], { id: "c_a" }), c);
  assert.throws(
    () =>
      resolveComment([c, { ...c, id: "c_b" }], {
        authorName: "a",
        text: "same",
      }),
    { code: "AMBIGUOUS_TARGET" },
  );
  assert.throws(
    () => resolveComment([{ ...c, isReply: true }], { id: "c_a" }),
    { code: "NESTED_REPLY_UNSUPPORTED" },
  );
});
test("comment verification uses published channel identity, not feed composer identity", async () => {
  const post = {
    id: "B_testX60",
    channelId: "abc",
    author: { name: "student", avatar: "https://a/student" },
    text: "hello",
  };
  const actor = { name: "alias", avatar: "https://a/alias" };
  const prepared = {
    binding: {
      ...binding,
      expectedInteractionAccountName: "global",
      expectedCommentAuthorName: actor.name,
      expectedCommentAuthorAvatar: actor.avatar,
    },
    task: { action: "comment", content: { text: "reply" } },
    evidence: {
      account: {
        channelName: "global",
        channelAvatar: "https://a/global",
        avatar: "https://a/global",
      },
      post: postIdentity(post),
    },
  };
  assert.deepEqual(commentActor(prepared), actor);
  const a = new ActionAdapter({}, prepared.binding);
  a.snapshot = async () => ({
    account: { avatar: "https://a/global" },
    detail: {
      ...post,
      comments: [{ id: "c_new", author: actor, text: "reply", isReply: false }],
    },
  });
  assert.deepEqual(await a.verifyOnce(prepared, { commentIds: [] }), {
    source: "new-own-comment",
    commentId: "c_new",
    parentId: undefined,
  });
});
test("query date range and truncated text never imply complete results", () => {
  assert.equal(
    parsePostTime("2026-09-21").start,
    Date.parse("2026-09-21T00:00:00+08:00"),
  );
  assert.equal(parsePostTime("2026-02-30"), null);
  assert.throws(() => normalizeQuery({ since: "2026-09-21" }), {
    code: "INVALID_QUERY",
  });
  const p = {
    id: "B_a",
    author: { name: "x" },
    text: "hello",
    textTruncated: true,
    publishedLabel: "unknown",
  };
  assert.deepEqual(
    filterPosts([p], normalizeQuery({ textEquals: "hello" })).warnings,
    ["truncated-content"],
  );
  assert.equal(
    filterPosts([p], normalizeQuery({ date: "2026-09-21" })).posts.length,
    0,
  );
  assert.throws(() => resolvePost([p, p], { id: "B_a" }), {
    code: "AMBIGUOUS_TARGET",
  });
});
test("image signature and hash detect replacement before any upload", () =>
  tmp(async (dir) => {
    const f = path.join(dir, "a.png");
    await writeFile(f, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    const images = await describeImages([f]);
    await verifyImages(images);
    await writeFile(f, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
    await assert.rejects(() => verifyImages(images), { code: "IMAGE_CHANGED" });
    await writeFile(f, "not an image");
    await assert.rejects(() => describeImages([f]), {
      code: "UNSUPPORTED_IMAGE",
    });
  }));
test("preview verification rejects incomplete, local-only or missing images", () => {
  assert.deepEqual(
    confirmPreviews([{ src: "https://a/p.png", ready: true }], 1),
    ["https://a/p.png"],
  );
  for (const previews of [
    [],
    [{ src: "blob:test", ready: true }],
    [{ src: "https://a/p.png", ready: false }],
  ])
    assert.throws(() => confirmPreviews(previews, 1), {
      code: "UPLOAD_UNVERIFIED",
    });
});
function adapter(overrides = {}) {
  return {
    preflight: async () => {},
    alreadySatisfied: async () => false,
    stage: async () => ({ commentIds: [] }),
    assertStaged: async () => {},
    submit: async () => {},
    verify: async () => ({ status: "verified-ui" }),
    ...overrides,
  };
}
test("submission timeout persists uncertainty; a new journal cannot resubmit", () =>
  tmp(async (dir) => {
    let count = 0;
    const p = plan(),
      a = adapter({
        submit: async () => {
          count++;
          throw Error("timeout");
        },
      });
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "uncertain",
    );
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "blocked-uncertain",
    );
    assert.equal(count, 1);
  }));
test("pending record exists before submit and success deduplicates", () =>
  tmp(async (dir) => {
    const p = plan(),
      j = new Journal(dir);
    let count = 0;
    const a = adapter({
      submit: async () => {
        assert.equal((await j.get(operationKey(p))).status, "pending");
        count++;
      },
    });
    assert.equal((await executePlan(p, a, j)).status, "verified-ui");
    assert.equal((await executePlan(p, a, j)).status, "skipped-duplicate");
    assert.equal(count, 1);
  }));
test("upload failure or journal failure cannot reach submit", () =>
  tmp(async (dir) => {
    let count = 0;
    const submit = async () => {
      count++;
    };
    await assert.rejects(() =>
      executePlan(
        plan(),
        adapter({
          stage: async () => {
            throw Error("upload");
          },
          submit,
        }),
        new Journal(dir),
      ),
    );
    await assert.rejects(() =>
      executePlan(plan(), adapter({ submit }), {
        get: async () => null,
        begin: async () => {
          throw Error("disk full");
        },
      }),
    );
    assert.equal(count, 0);
  }));
test("already liked skips without toggle; modified or expired plans stop", () =>
  tmp(async (dir) => {
    const p = plan("like-post"),
      a = adapter({
        alreadySatisfied: async () => true,
        submit: async () => {
          throw Error("must not click");
        },
      });
    assert.equal(
      (await executePlan(p, a, new Journal(dir))).status,
      "skipped-already-liked",
    );
    await assert.rejects(
      () =>
        executePlan(
          { ...p, task: { ...p.task, action: "comment" } },
          a,
          new Journal(dir),
        ),
      { code: "PLAN_CHANGED" },
    );
    const { digest, ...body } = plan();
    const expired = sealPlan({ ...body, expiresAt: "2000-01-01T00:00:00Z" });
    await assert.rejects(() => executePlan(expired, a, new Journal(dir)), {
      code: "PLAN_EXPIRED",
    });
  }));
test("reconcile never submits, keeps failed evidence uncertain, accepts independent positive evidence", () =>
  tmp(async (dir) => {
    const p = plan(),
      j = new Journal(dir);
    await j.begin(operationKey(p), { status: "pending", baseline: {} });
    const a = adapter({
      submit: async () => {
        throw Error("must not submit");
      },
      reconcile: async () => null,
    });
    assert.equal(
      (await executePlan(p, a, j, { mode: "reconcile" })).status,
      "uncertain",
    );
    a.reconcile = async () => ({ commentId: "c_new" });
    assert.equal(
      (await executePlan(p, a, j, { mode: "reconcile" })).status,
      "verified-ui",
    );
  }));
test("shared window lock prevents parallel skill work", () =>
  tmp(async (dir) => {
    await withWindowLock(dir, "test", async () =>
      assert.rejects(() => withWindowLock(dir, "test", async () => {}), {
        code: "WINDOW_BUSY",
      }),
    );
    await withWindowLock(dir, "test", async () => {});
  }));
test("discovery accepts account-only binding; actions require target channel", () => {
  assert.equal(
    validateBinding({ expectedAccountName: "me" }, { requireChannel: false })
      .expectedAccountName,
    "me",
  );
  assert.throws(() => validateBinding({ expectedAccountName: "me" }), {
    code: "INVALID_BINDING",
  });
});
test("virtual feed accumulates recycled IDs but date scans never claim total coverage", async () => {
  let tick = 0;
  const base = {
    url: "https://pd.qq.com/g/abc",
    pageType: "feed",
    account: { name: "global", avatar: "https://a/a" },
    channel: { id: "abc", name: "channel" },
    notices: [],
    views: [{ name: "热门", selected: true }],
  };
  const p = (id) => ({
    id,
    author: { name: "a" },
    text: "x",
    publishedLabel: "2026-09-21",
    textTruncated: false,
  });
  const deps = {
    read: async () => ({
      ...base,
      posts: tick ? [p("B_2"), p("B_3")] : [p("B_1"), p("B_2")],
    }),
    load: async () => {
      tick++;
      return { progress: true };
    },
  };
  const r = await queryPosts({}, binding, { limit: 3, maxLoads: 1 }, deps);
  assert.deepEqual(
    r.posts.map((p) => p.id),
    ["B_1", "B_2", "B_3"],
  );
  assert.equal(r.ordering, "ranked-not-chronological");
  const dates = await queryPosts(
    {},
    binding,
    { limit: 1, maxLoads: 0, date: "2026-09-21" },
    deps,
  );
  assert.equal(dates.complete, false);
  assert.equal(dates.stopReason, "record-limit");
});
