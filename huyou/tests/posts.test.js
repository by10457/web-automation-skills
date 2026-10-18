import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePostTime,
  normalizeQuery,
  filterPosts,
  queryPosts,
  resolvePost,
} from "../scripts/posts.js";
import * as api from "../scripts/index.js";
const now = Date.parse("2026-09-20T02:00:00+08:00");
const post = (id, time = "昨天 12:00", extra = {}) => ({
  id,
  publishedLabel: time,
  author: { name: "a" },
  text: "hello",
  ...extra,
});
test("calendar date ranges use Shanghai and reject invalid dates", () => {
  const q = normalizeQuery({ date: "yesterday" }, now);
  assert.equal(q.since, "2026-09-18T16:00:00.000Z");
  assert.equal(q.until, "2026-09-19T16:00:00.000Z");
  assert.throws(() => normalizeQuery({ date: "2026-02-30" }, now), {
    code: "INVALID_QUERY",
  });
  assert.throws(() => normalizeQuery({ since: "2026-09-19" }, now), {
    code: "INVALID_QUERY",
  });
  assert.equal(
    new Date(
      parsePostTime(
        "12-31 23:30",
        Date.parse("2026-01-01T01:00:00+08:00"),
      ).start,
    ).toISOString(),
    "2025-12-31T15:30:00.000Z",
  );
});
test("date filters flag unknown labels, exclude hot posts, and preserve string IDs", () => {
  const r = filterPosts(
    [
      post("123"),
      post("456", "今天 00:00"),
      post("789", "bad"),
      post("999", "昨天 12:00", { recommended: true }),
    ],
    normalizeQuery({ date: "yesterday" }, now),
  );
  assert.deepEqual(
    r.posts.map((p) => p.id),
    ["123"],
  );
  assert(r.warnings.includes("unknown-post-time"));
});
test("full text matching rejects truncated and ambiguous results", () => {
  assert.throws(
    () => resolvePost([post("1"), post("2")], { textEquals: "hello" }),
    { code: "AMBIGUOUS_POST" },
  );
  assert.throws(
    () =>
      resolvePost([post("1", "昨天 12:00", { textTruncated: true })], {
        textEquals: "hello",
      }),
    { code: "POST_NOT_FOUND" },
  );
  assert.equal(resolvePost([post("1")], { id: "1" }).id, "1");
});
const expected = { expectedAccountName: "me", expectedCircleName: "circle" };
const snapshot = (posts) => ({
  account: { state: "logged-in", displayName: "me" },
  circle: { name: "circle", sidebarName: "circle" },
  feed: { tab: "圈子", sort: "新发" },
  posts,
});
test("热门副本先出现时不占用普通帖子在时间序列中的位置", async () => {
  let loaded = false;
  const result = await queryPosts(null, expected, {limit:3}, {
    read: async () => snapshot(loaded
      ? [post('1','今天 06:00'),post('3','今天 04:00',{recommended:true}),post('2','今天 05:00'),post('3','今天 04:00')]
      : [post('1','今天 06:00'),post('3','今天 04:00',{recommended:true})]),
    load: async () => { loaded=true;return {progress:true}; }
  });
  assert.deepEqual(result.posts.map(p=>p.id),['1','2','3']);
  assert.equal(result.complete,true);
  assert.deepEqual(result.warnings,[]);
});
test("query loads and deduplicates IDs until requested count", async () => {
  let n = 0;
  const r = await queryPosts(
    null,
    expected,
    { limit: 3 },
    {
      read: async () =>
        snapshot(n ? [post("1"), post("2"), post("3")] : [post("1")]),
      load: async () => {
        n++;
        return { progress: true };
      },
    },
  );
  assert.equal(r.posts.length, 3);
  assert.equal(r.loads, 1);
  assert.equal(r.complete, true);
});
test("no loading progress is explicitly incomplete", async () => {
  const r = await queryPosts(
    null,
    expected,
    { limit: 10 },
    {
      read: async () => snapshot([post("1")]),
      load: async () => ({ progress: false, stopReason: "no-progress" }),
    },
  );
  assert.equal(r.complete, false);
  assert.equal(r.stopReason, "no-progress");
});
test("date boundary can finish but out-of-order data cannot claim complete", async () => {
  const q = { date: "2026-09-19", limit: 100, maxLoads: 0 };
  const a = await queryPosts(null, expected, q, {
    read: async () =>
      snapshot([post("1", "2026-09-19 10:00"), post("2", "2026-09-18 10:00")]),
  });
  assert.equal(a.stopReason, "time-boundary");
  assert.equal(a.complete, true);
  const b = await queryPosts(null, expected, q, {
    read: async () =>
      snapshot([post("2", "2026-09-18 10:00"), post("1", "2026-09-19 10:00")]),
  });
  assert.equal(b.complete, false);
});
test("query rejects an unexpected account before loading", async () => {
  await assert.rejects(
    queryPosts(
      null,
      expected,
      {},
      {
        read: async () => ({
          ...snapshot([]),
          account: { state: "logged-in", displayName: "other" },
        }),
      },
    ),
    { code: "ACCOUNT_MISMATCH" },
  );
});
test("public exports provide query, navigation, actions, and batch functions", () => {
  for (const name of [
    "withHuyou",
    "queryPosts",
    "getPost",
    "resolvePost",
    "loadMore",
    "backToTop",
    "refreshFeed",
    "prepareLikePost",
    "likePost",
    "comment",
    "reply",
    "publish",
    "prepareBatch",
  ])
    assert.equal(typeof api[name], "function");
});
