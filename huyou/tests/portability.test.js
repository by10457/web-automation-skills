import test from "node:test";
import assert from "node:assert/strict";
import { workspacePath } from "../scripts/config.js";
import { bindingFor } from "../scripts/lib/runner.js";
import { withHuyou } from "../scripts/session.js";
import { resolveComment } from "../scripts/comments.js";
import { normalizeQuery, queryPosts } from "../scripts/posts.js";
test("explicit binding objects need no local config file", async () => {
  const b = {
    browserId: "id",
    expectedAccountName: "me",
    expectedCircleName: "circle",
  };
  assert.deepEqual(await bindingFor("/missing", b), b);
  await assert.rejects(bindingFor("/missing", { browserId: "id" }), {
    code: "BINDING_INCOMPLETE",
  });
});
test("external page session does not acquire a browser or local config", async () => {
  const page = {};
  const b = { expectedAccountName: "me", expectedCircleName: "circle" };
  assert.equal(
    await withHuyou({ page, binding: b, requireContext: false }, (s) => s.page),
    page,
  );
});
test("comment resolution refuses ambiguous identities and supports explicit reply filtering", () => {
  const c = { authorName: "x", text: "same", isReply: false };
  assert.throws(() => resolveComment([c, c], c), { code: "AMBIGUOUS_COMMENT" });
  assert.equal(
    resolveComment([c, { ...c, isReply: true }], { ...c, isReply: true })
      .isReply,
    true,
  );
});
test("range queries cannot report date completion at a record cap", async () => {
  const b = { expectedAccountName: "me", expectedCircleName: "circle" };
  const s = {
    account: { state: "logged-in", displayName: "me" },
    circle: { name: "circle", sidebarName: "circle" },
    feed: { tab: "圈子", sort: "新发" },
    posts: [
      {
        id: "1",
        publishedLabel: "昨天 12:00",
        author: { name: "x" },
        text: "x",
      },
    ],
  };
  const r = await queryPosts(
    null,
    b,
    { mode: "range", date: "yesterday", limit: 1 },
    { read: async () => s },
  );
  assert.equal(r.complete, false);
  assert.equal(r.stopReason, "record-limit");
  assert.throws(() => normalizeQuery({ mode: "range" }), {
    code: "INVALID_QUERY",
  });
});
