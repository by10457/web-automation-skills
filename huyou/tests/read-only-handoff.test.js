/** 离线检验交接字段、引用防串窗和正文依据；不连接浏览器。 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  selectIndependentPosts,
  createCommentBrief,
  exportReadOnlyHandoff,
} from "../scripts/index.js";
function window(id) {
  const selection = selectIndependentPosts({
    snapshot: {
      binding: {
        browserId: id,
        expectedAccountName: "测试账号",
        expectedCircleName: "测试圈子",
      },
      targetId: "tab-" + id,
      url: "https://hy.sns.sohu.com/",
      result: {
        complete: true,
        posts: [{ id: "123", text: "找英语学习搭子" }],
      },
    },
    likeCount: 1,
    commentCount: 1,
    seed: "test",
  });
  const brief = createCommentBrief({ selection });
  return {
    selection,
    comments: [
      {
        itemRef: brief.items[0].itemRef,
        text: "想练口语还是备考呀？",
        evidenceQuote: "英语学习搭子",
      },
    ],
    accountEvidence: { state: "logged-in", displayName: "测试账号" },
    timing: {
      startedAt: "2026-10-18T00:00:00Z",
      endedAt: "2026-10-18T00:00:02Z",
    },
  };
}
test("完整交接保留窗口上下文并验证跨窗引用、原文依据和抽样修改", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "huyou-handoff-"));
  try {
    const a = window("a"),
      b = window("b");
    const result = await exportReadOnlyHandoff({
      outputDir: dir,
      windows: [a, b],
    });
    const document = JSON.parse(await readFile(result.jsonPath, "utf8"));
    assert.equal(document.overlapMs, 2000);
    assert.equal(document.submittedActions, 0);
    for (const name of ["comments.json", "likes.json"]) {
      const rows = JSON.parse(
        await readFile(path.join(path.dirname(result.jsonPath), name), "utf8"),
      );
      assert.equal(rows.length, 2);
      assert(
        rows.every(
          (r) =>
            r.url &&
            r.targetId &&
            r.windowId &&
            r.accountStatus === "logged-in" &&
            r.circle,
        ),
      );
    }
    b.comments = a.comments;
    await assert.rejects(
      exportReadOnlyHandoff({ outputDir: dir, windows: [b] }),
      { code: "INVALID_COMMENTS" },
    );
    a.comments[0].evidenceQuote = "不存在的活动";
    await assert.rejects(
      exportReadOnlyHandoff({ outputDir: dir, windows: [a] }),
      { code: "UNSUPPORTED_COMMENT" },
    );
    a.selection.likes[0] = "456";
    assert.throws(() => createCommentBrief({ selection: a.selection }), {
      code: "SELECTION_CHANGED",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
