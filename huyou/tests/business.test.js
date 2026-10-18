/** 独立抽样和固定评论批次的离线契约测试，不连接浏览器。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  selectIndependentPosts,
  buildIndependentBatch,
} from "../scripts/business.js";
const snapshot = {
  binding: {
    browserId: "test-window",
    expectedAccountName: "测试账号",
    expectedCircleName: "测试圈",
  },
  targetId: "test-tab",
  result: {
    complete: true,
    posts: Array.from({ length: 50 }, (_, i) => ({
      id: String(i + 1),
      text: `测试帖子 ${i}`,
    })),
  },
};
test("两组独立抽样可复现且组内不重复", () => {
  const a = selectIndependentPosts({ snapshot, seed: "repeatable" });
  assert.deepEqual(a, selectIndependentPosts({ snapshot, seed: "repeatable" }));
  assert.equal(new Set(a.likes).size, 10);
  assert.equal(new Set(a.comments).size, 10);
  assert.notDeepEqual(a.likes, a.comments);
  assert.equal(snapshot.result.posts[0].id, "1");
});
test("固定正文生成二十项原生批次并保留窗口和标签", () => {
  const selection = selectIndependentPosts({ snapshot, seed: "fixed" });
  const comments = selection.comments.map((postId) => ({
    postId,
    text: `针对 ${postId} 的评论`,
  }));
  const task = buildIndependentBatch({ selection, comments });
  assert.equal(task.items.length, 20);
  assert.equal(
    task.items.filter((i) => i.task.action === "like-post").length,
    10,
  );
  assert.deepEqual(
    task.items
      .filter((i) => i.task.action === "comment")
      .map((i) => i.task.content.text),
    comments.map((c) => c.text),
  );
  assert.ok(
    task.items.every(
      (i) =>
        i.targetId === "test-tab" && i.task.binding.browserId === "test-window",
    ),
  );
  assert.throws(() =>
    buildIndependentBatch({ selection, comments: comments.slice(1) }),
  );
  assert.throws(() =>
    buildIndependentBatch({ selection, comments: [...comments, comments[0]] }),
  );
  selection.likes[0] = "999";
  assert.throws(() => buildIndependentBatch({ selection, comments }));
});
test("拒绝不完整查询、重复 ID、数量不足；截断正文不用于评论", () => {
  const copy = structuredClone(snapshot);
  copy.result.complete = false;
  assert.throws(() => selectIndependentPosts({ snapshot: copy }));
  copy.result.complete = true;
  copy.result.posts[0].id = "2";
  assert.throws(() => selectIndependentPosts({ snapshot: copy }));
  assert.throws(() => selectIndependentPosts({ snapshot, likeCount: 51 }));
  const truncated = structuredClone(snapshot);
  truncated.result.posts.forEach((p) => (p.textTruncated = true));
  assert.throws(() => selectIndependentPosts({ snapshot: truncated }));
  assert.equal(
    selectIndependentPosts({ snapshot: truncated, commentCount: 0 }).comments
      .length,
    0,
  );
});
