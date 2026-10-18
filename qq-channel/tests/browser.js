// 使用隔离上下文并拦截全部网络请求，不操作已登录的标签页。
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { withBrowser } from "../scripts/lib/browser.js";
import { readSnapshot, ready } from "../scripts/lib/dom.js";
import { ActionAdapter } from "../scripts/lib/action-adapter.js";
import { sealPlan } from "../scripts/lib/plans.js";
import { executePlan } from "../scripts/lib/engine.js";
import { Journal } from "../scripts/lib/journal.js";
import { describeImages } from "../scripts/lib/files.js";
import { queryPosts } from "../scripts/posts.js";
import { queryComments } from "../scripts/comments.js";
import { selectPostView, selectChannel } from "../scripts/channels.js";
import { backToTop, refreshFeed } from "../scripts/navigation.js";
const id = process.argv[2];
if (!id) throw Error("Provide a running BitBrowser window ID");
const html = await readFile(
  new URL("./fixtures/site.html", import.meta.url),
  "utf8",
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
  "base64",
);
const root = await mkdtemp(path.join(os.tmpdir(), "qq-browser-"));
let passed = 0;
try {
  await withBrowser({ id }, async (browser) => {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (r.isNavigationRequest() && u.origin === "https://pd.qq.com")
          void r.respond({ status: 200, contentType: "text/html", body: html });
        else if (u.origin === "https://fixture.test")
          void r.respond({ status: 200, contentType: "image/png", body: png });
        else void r.abort();
      });
      const binding = {
        browserId: id,
        expectedAccountName: "global",
        expectedChannelAccountName: "alias",
        expectedChannelName: "channel",
        channelId: "abc",
      };
      await page.goto("https://pd.qq.com/g/abc");
      const s = await readSnapshot(page);
      assert.equal(s.draft, false);
      assert.equal(s.posts[0].id, "B_target");
      passed++;
      await page.evaluate(() => {
        const name = document.querySelector(".app-login .name"),
          img = document.querySelector(".app-login img"),
          src = img.getAttribute("src");
        name.textContent = "";
        img.removeAttribute("src");
        setTimeout(() => {
          name.textContent = "global";
          img.setAttribute("src", src);
        }, 600);
      });
      assert.equal((await ready(page)).account.name, "global");
      passed++;
      await page.$eval(
        ".game-guild-main__short-content__media-detail",
        (e) => (e.className = "game-guild-main__short-content__detail"),
      );
      assert.equal((await readSnapshot(page)).posts[0].text, "hello campus");
      passed++;
      const q = await queryPosts(page, binding, { limit: 1, maxLoads: 0 });
      assert.equal(q.complete, true);
      assert.equal(q.posts[0].text, "hello campus");
      passed++;
      await selectPostView(page, binding, "热门");
      assert.equal(
        (await readSnapshot(page)).views.find((v) => v.selected).name,
        "热门",
      );
      passed++;
      page.reload = () => {
        throw Error("Whole-page refresh is forbidden");
      };
      await page.evaluate(() => {
        globalThis.viewClicks = [];
        for (const e of document.querySelectorAll(".tab-bar__item"))
          e.addEventListener("click", () =>
            globalThis.viewClicks.push(e.textContent.trim()),
          );
      });
      const refreshed = await refreshFeed(page, binding);
      assert.equal(refreshed.selectedView, "热门");
      assert.deepEqual(await page.evaluate(() => globalThis.viewClicks), [
        "全部",
        "热门",
      ]);
      passed++;
      await selectPostView(page, binding, "全部");
      await page.evaluate(() => (globalThis.viewClicks = []));
      await refreshFeed(page, binding);
      assert.deepEqual(await page.evaluate(() => globalThis.viewClicks), [
        "热门",
        "全部",
      ]);
      passed++;
      await page.$eval(".game-guild-main__waterfalls", (e) => {
        const spacer = document.createElement("div");
        spacer.style.height = "2000px";
        e.append(spacer);
        e.scrollTop = 600;
      });
      const top = await backToTop(page, binding);
      assert.ok(top.from > 0);
      assert.equal(top.to, 0);
      passed++;
      await page.$eval(
        "[contenteditable]",
        (e) => (e.textContent = "existing draft"),
      );
      await assert.rejects(
        refreshFeed(page, binding),
        (e) => e.code === "EXISTING_DRAFT",
      );
      passed++;
      await page.$eval("[contenteditable]", (e) => (e.textContent = ""));
      await page.evaluate(() => {
        for (const e of [...document.querySelectorAll(".tab-bar__item")].slice(
          1,
        ))
          e.remove();
      });
      await assert.rejects(
        refreshFeed(page, binding),
        (e) => e.code === "NO_ALTERNATE_VIEW",
      );
      passed++;
      await page.goto("https://pd.qq.com/g/abc");
      await page.$eval(".choice", (e) => e.classList.add("disabled"));
      const disabledAdapter = new ActionAdapter(page, binding, {
        workspace: root,
        runDir: path.join(root, "disabled"),
      });
      await assert.rejects(
        disabledAdapter.prepare({
          action: "publish",
          board: "说说",
          content: { text: "must not publish" },
        }),
        (e) => e.code === "BOARD_DISABLED",
      );
      passed++;
      const channel = await selectChannel(page, binding);
      assert.equal(channel.initialization.via, "热门");
      assert.equal(channel.initialization.selectedView, "全部");
      passed++;
      await page.goto("https://pd.qq.com/g/abc/post/B_target");
      await page.evaluate(() => {
        document.querySelector(".comment-bar__comment-count").remove();
        document.querySelector(".comment-list").remove();
        document.querySelector(".has-no-more-comment").className =
          "has-no-comment";
      });
      const empty = await queryComments(page, binding, { maxLoads: 0 });
      assert.equal(empty.complete, true);
      assert.equal(empty.comments.length, 0);
      passed++;
      await page.$eval(".like-container", (e) => {
        e.removeAttribute("aria-pressed");
        e.innerHTML =
          '<svg><use href="/symbol/common.svg#like-active"></use></svg><div class="like-text">1</div>';
      });
      assert.equal((await readSnapshot(page)).detail.like.state, "liked");
      passed++;
      for (const action of ["comment", "reply", "like-post", "publish"]) {
        await page.goto("https://pd.qq.com/g/abc");
        const runDir = path.join(root, action);
        const task = {
          action,
          ...(action === "publish"
            ? { board: "说说" }
            : {
                target: {
                  url: "https://pd.qq.com/g/abc/post/B_target?subc=12",
                  ...(action === "reply"
                    ? { comment: { id: "c_original" } }
                    : {}),
                },
              }),
          ...(action === "like-post"
            ? {}
            : { content: { text: "hello from skill" } }),
        };
        let images = [];
        if (action === "publish") {
          const file = path.join(root, "image.png"),
            second = path.join(root, "second.png");
          await writeFile(file, png);
          await writeFile(second, png);
          task.content.images = [file, second];
          images = await describeImages(task.content.images);
        }
        const a = new ActionAdapter(page, binding, {
          workspace: root,
          runDir,
          verifyTimeoutMs: 1500,
        });
        const evidence = await a.prepare(task);
        if (action === "reply") {
          const comments = await queryComments(page, binding, { maxLoads: 0 });
          assert.equal(comments.comments[1].parentId, "c_original");
          assert.equal(comments.complete, true);
        }
        const plan = sealPlan({
          kind: "qq-channel-action-plan",
          version: 1,
          task,
          binding,
          images,
          evidence,
          expiresAt: new Date(Date.now() + 900000).toISOString(),
        });
        const result = await executePlan(plan, a, new Journal(root));
        if (result.status !== "verified-ui")
          console.log(
            JSON.stringify(
              { action, evidence, snapshot: await readSnapshot(page) },
              null,
              2,
            ),
          );
        assert.equal(
          result.status,
          "verified-ui",
          JSON.stringify({ action, result }),
        );
        assert.equal(
          (await executePlan(plan, a, new Journal(root))).status,
          "skipped-duplicate",
        );
        passed++;
        console.log("PASS " + action);
      }
      console.log(
        JSON.stringify({
          passed,
          network: "all requests intercepted",
          liveCommunityWrites: 0,
        }),
      );
    } finally {
      await context.close();
    }
  });
} finally {
  if (path.dirname(root) !== os.tmpdir()) throw Error("unsafe cleanup");
  await rm(root, { recursive: true, force: true });
}
