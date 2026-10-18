import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makePlan, validateTask } from "../scripts/lib/planner.js";
import { withLock } from "../scripts/lib/runner.js";

const binding = {
  expectedAccountName: "operator",
  expectedCircleName: "circle",
};
const task = {
  version: 1,
  binding: "one",
  action: "inspect-posts",
  selection: { order: "newest", distinctBy: "authorName", limit: 2 },
  execution: { mode: "preview" },
};
const post = (id, name, recommended = false) => ({
  id,
  snapshotKey: id,
  author: { id: null, name },
  publishedLabel: "今天 01:00",
  recommended,
});
const snap = () => ({
  account: { state: "logged-in", displayName: "operator" },
  circle: { name: "circle", sidebarName: "circle" },
  feed: { tab: "圈子", sort: "新发" },
  posts: [post("1", "A"), post("2", "B", true), post("3", "A"), post("4", "C")],
});
test("skip inserted hot posts and duplicate names; preview never executable", () => {
  const p = makePlan(snap(), binding, task);
  assert.deepEqual(
    p.selected.map((p) => p.id),
    ["1", "4"],
  );
  assert.equal(p.executable, false);
  assert.deepEqual(
    p.skipped.map((p) => p.reason),
    ["inserted-hot-post", "duplicate-author"],
  );
});
test("nickname check must not accept a different operator", () => {
  const s = snap();
  s.account.displayName = "other";
  assert.throws(() => makePlan(s, binding, task), { code: "ACCOUNT_MISMATCH" });
});
test("logged out and mismatched circle stop before planning", () => {
  const s = snap();
  s.account.state = "logged-out";
  assert.throws(() => makePlan(s, binding, task), { code: "LOGIN_REQUIRED" });
  const c = snap();
  c.circle.sidebarName = "other";
  assert.throws(() => makePlan(c, binding, task), { code: "CIRCLE_MISMATCH" });
});
test("latest requires observed sort, strict author requires UID", () => {
  const s = snap();
  s.feed.sort = "热门";
  assert.throws(() => makePlan(s, binding, task), {
    code: "ORDER_NOT_VERIFIED",
  });
  assert.throws(
    () =>
      makePlan(snap(), binding, {
        ...task,
        selection: { ...task.selection, distinctBy: "author" },
      }),
    { code: "AUTHOR_ID_UNAVAILABLE" },
  );
});
test("insufficient loaded records explicitly partial", () => {
  const s = snap();
  s.posts = [post("1477214881781591936", "A")];
  const p = makePlan(s, binding, task);
  assert.equal(p.completeness, "partial-loaded-list");
  assert.equal(p.selectedCount, 1);
  assert.equal(p.selected[0].id, "1477214881781591936");
});
test("unknown or write mode tasks cannot run", () => {
  assert.throws(() => validateTask({ ...task, action: "like" }), {
    code: "READ_ONLY_PHASE",
  });
  assert.throws(
    () => validateTask({ ...task, execution: { mode: "execute" } }),
    { code: "READ_ONLY_PHASE" },
  );
  assert.throws(
    () =>
      validateTask({ ...task, selection: { ...task.selection, limit: 1.5 } }),
    { code: "INVALID_SELECTION" },
  );
});
test("window lock prevents overlap and releases on error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-skill-lock-test-"));
  try {
    await assert.rejects(
      withLock(dir, "abc", async () => {
        await assert.rejects(
          withLock(dir, "abc", () => {}),
          { code: "WINDOW_BUSY" },
        );
        throw new Error("test-failure");
      }),
      /test-failure/,
    );
    assert.deepEqual(await readdir(path.join(dir, "locks")), []);
  } finally {
    // 仅操作本次明确创建的临时测试目录。
    await rm(dir, { recursive: true, force: true });
  }
});
