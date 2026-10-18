import test from "node:test";
import assert from "node:assert/strict";
import { finishPublishedPost } from "../scripts/lib/completion.js";
import { ActionAdapter } from "../scripts/lib/action-adapter.js";
test("confirmed publish returns to channel; failed return retains success", async () => {
  const plan = { task: { action: "publish" } },
    result = { status: "verified-ui", evidence: { postId: "post" } };
  const ok = await finishPublishedPost(plan, result, async () => ({
    initialization: { selectedView: "全部" },
  }));
  assert.equal(ok.returnToChannel.status, "returned");
  const failed = await finishPublishedPost(plan, result, async () => {
    throw Error("navigation failed");
  });
  assert.equal(failed.status, "verified-ui");
  assert.equal(failed.returnToChannel.status, "failed");
  assert.deepEqual(failed.evidence, result.evidence);
});
test("uncertain writes and other actions preserve scene", async () => {
  const navigate = () => {
    throw Error("must not navigate");
  };
  for (const status of ["uncertain", "blocked-uncertain", "skipped-duplicate"])
    assert.deepEqual(
      await finishPublishedPost(
        { task: { action: "publish" } },
        { status },
        navigate,
      ),
      { status },
    );
  assert.deepEqual(
    await finishPublishedPost(
      { task: { action: "reply" } },
      { status: "verified-ui" },
      navigate,
    ),
    { status: "verified-ui" },
  );
});
test("publish redirected to a new matching detail is verified; existing post is not", async () => {
  const adapter = new ActionAdapter(null, {}),
    author = { name: "author", avatar: "https://example.com/a" };
  adapter.snapshot = async () => ({
    account: { avatar: author.avatar },
    posts: [],
    detail: {
      id: "new",
      url: "https://pd.qq.com/g/a/post/new",
      textComplete: true,
      author,
      text: "hello",
      images: [],
    },
  });
  const plan = {
    task: { action: "publish", content: { text: "hello" } },
    images: [],
    evidence: {
      account: {
        avatar: author.avatar,
        channelName: author.name,
        channelAvatar: author.avatar,
      },
    },
  };
  assert.equal(
    (await adapter.verifyOnce(plan, { postIds: [] })).source,
    "new-own-post-detail",
  );
  assert.equal(await adapter.verifyOnce(plan, { postIds: ["new"] }), null);
});
