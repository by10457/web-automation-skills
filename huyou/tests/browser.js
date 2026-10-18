// 显式运行：node web-automation-skills/huyou/tests/browser.js --id <运行中的比特浏览器 ID>
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withBrowser } from "../scripts/lib/browser.js";
import { HuyouAdapter } from "../scripts/lib/actions/adapter.js";
import { buildActionPlan, executePlan } from "../scripts/lib/actions/engine.js";
import { Journal } from "../scripts/lib/actions/journal.js";
import { queryPosts, locatePost } from "../scripts/posts.js";
import { loadMore, backToTop, refreshFeed } from "../scripts/navigation.js";
import { queryComments } from "../scripts/comments.js";
import {
  diagnoseHuyou,
  listCircles,
  setFeedSort,
  selectCircle,
} from "../scripts/context.js";
import { openUserProfile, closeUserProfile } from "../scripts/profiles.js";
import {
  prepareFollowUser,
  followUser,
} from "../scripts/actions/follow-user.js";
import { createRequire } from "node:module";
import { recoverInteractionPage } from "../scripts/operations.js";
const id = process.argv[3];
if (!["--id", "--executable"].includes(process.argv[2]) || !id)
  throw Error("Provide --id or --executable");
const runBrowser =
  process.argv[2] === "--id"
    ? withBrowser
    : async (_, fn) => {
        const p = createRequire(path.join(process.cwd(), "package.json"))(
          "puppeteer-core",
        );
        const b = await p.launch({ executablePath: id, headless: true });
        try {
          return await fn(b);
        } finally {
          await b.close();
        }
      };
const html = await readFile(
  new URL("./fixtures/site.html", import.meta.url),
  "utf8",
);
const binding = {
  browserId: id,
  expectedAccountName: "operator",
  expectedCircleName: "circle",
};
const dir = await mkdtemp(
  path.join(os.tmpdir(), "browser-skill-browser-tests-"),
);
let passed = 0,
  intercepted = 0;
try {
  await runBrowser({ id }, async (browser) => {
    const context = await browser.createBrowserContext();
    try {
      async function test(name, task, check) {
        if (
          process.env.HUYOU_TEST_FILTER &&
          !name.includes(process.env.HUYOU_TEST_FILTER)
        )
          return;
        const page = await context.newPage();
        await page.setRequestInterception(true);
        page.on("request", (r) => {
          intercepted++;
          if (r.isNavigationRequest())
            void r.respond({
              status: 200,
              contentType: "text/html",
              body: html,
            });
          else void r.abort();
        });
        try {
          await page.goto("https://hy.sns.sohu.com/", {
            waitUntil: "domcontentloaded",
          });
          const adapter = new HuyouAdapter(page, binding, {
            verifyTimeout: 1000,
          });
          await check({ page, adapter, task });
          passed++;
          console.log("PASS " + name);
        } finally {
          await page.close();
        }
      }
      await test(
        "read interfaces and bounded comment loading",
        {},
        async ({ page }) => {
          assert.equal((await diagnoseHuyou(page, binding)).status, "ready");
          assert.equal((await listCircles(page)).selected, "circle");
          assert.equal((await locatePost(page, binding, "123")).found, true);
          assert.equal(
            (await locatePost(page, binding, "999", { maxLoads: 0 })).found,
            false,
          );
          const r = await queryComments(page, binding, "123", { maxLoads: 0 });
          assert.equal(r.comments.length, 1);
          assert.equal(r.complete, false);
          assert.equal(page.url(), "https://hy.sns.sohu.com/");
          assert.equal(await page.evaluate(() => fixture.submits), 0);
        },
      );
      await test(
        "sort selection verifies the resulting label",
        {},
        async ({ page }) => {
          await page.evaluate(() => {
            const b = document.querySelector(".circle-tab__sort");
            b.onclick = () => {
              const p = document.createElement("div");
              p.className = "circle-tab__sort-menu";
              for (const label of ["新发", "热门"]) {
                const e = document.createElement("button");
                e.className = "circle-tab__sort-option";
                e.textContent = label;
                e.onclick = () => {
                  b.textContent = label;
                  p.remove();
                };
                p.append(e);
              }
              document.body.append(p);
            };
          });
          await setFeedSort(page, "热门");
          assert.equal(
            await page.$eval(".circle-tab__sort", (e) => e.textContent),
            "热门",
          );
          await setFeedSort(page, "新发");
        },
      );
      await test(
        "circle selection checks header and sidebar",
        {},
        async ({ page }) => {
          await page.evaluate(() => {
            const b = document.createElement("button");
            b.className = "main-header__circle";
            b.innerHTML =
              '<div class="main-header__circle-info"><span class="main-header__circle-name">other</span></div>';
            b.onclick = () => {
              document
                .querySelector(".main-header__circle--active")
                .classList.remove("main-header__circle--active");
              b.classList.add("main-header__circle--active");
              document.querySelector(".circle-info-card__name").textContent =
                "other";
            };
            document.querySelector("main").prepend(b);
          });
          await selectCircle(page, "other", {
            expectedAccountName: "operator",
          });
          assert.equal((await listCircles(page)).selected, "other");
        },
      );
      await test(
        "comments load through the observed sentinel without submitting",
        {},
        async ({ page }) => {
          await page.evaluate(() => {
            const original = detail;
            detail = (id) => {
              original(id);
              const e = document.createElement("div");
              e.className = "comment-list__sentinel";
              e.style.marginTop = "2000px";
              document.querySelector(".comment-list").append(e);
              new IntersectionObserver((entries) => {
                if (
                  entries.some((x) => x.isIntersecting) &&
                  !e.dataset.loaded
                ) {
                  e.dataset.loaded = "yes";
                  state.comments.push({
                    name: "second",
                    avatar: "second.png",
                    text: "next",
                    liked: false,
                    count: 0,
                    replies: [],
                  });
                  original(id);
                }
              }).observe(e);
            };
          });
          const r = await queryComments(page, binding, "123", { limit: 2 });
          assert.equal(r.comments.length, 2);
          assert.equal(r.complete, true);
          assert.equal(r.loads, 1);
          assert.equal(await page.evaluate(() => fixture.submits), 0);
        },
      );
      const base = {
        version: 2,
        binding: "fixture",
        target: { postId: "123" },
      };
      await test(
        "unified follow and explicit page recovery",
        base,
        async ({ page, adapter }) => {
          await page.evaluate(() => {
            const original = detail;
            detail = (id) => {
              original(id);
              const img = document.createElement("img");
              img.className = "feed-header__avatar";
              img.src = "author.png";
              const b = document.createElement("button");
              b.className = "feed-header__follow-btn";
              b.textContent = "关注";
              b.setAttribute("aria-pressed", "false");
              b.onclick = () => {
                fixture.submits++;
                b.textContent = "已关注";
                b.setAttribute("aria-pressed", "true");
              };
              document.querySelector(".feed-detail-content").append(img, b);
            };
          });
          const plan = await buildActionPlan(
            { ...base, action: "follow-user" },
            binding,
            adapter,
          );
          assert.equal(
            (
              await executePlan(
                plan,
                adapter,
                new Journal(path.join(dir, "unified-follow")),
              )
            ).status,
            "verified-ui",
          );
          const recovered = await recoverInteractionPage({
            page,
            binding,
            workspace: dir,
          });
          assert.equal(recovered.closedDetail, true);
          assert.equal(await page.$(".feed-detail"), null);
          assert.equal(await page.evaluate(() => fixture.submits), 1);
        },
      );
      await test(
        "follow author submits once without opening a profile",
        base,
        async ({ page }) => {
          await page.evaluate(() => {
            const original = detail;
            detail = (id) => {
              original(id);
              const b = document.createElement("button");
              b.className = "feed-header__follow-btn";
              const avatar = document.createElement("img");
              avatar.className = "feed-header__avatar";
              avatar.src = "author.png";
              document.querySelector(".feed-detail-content").append(avatar);
              b.textContent = "关注";
              b.setAttribute("aria-pressed", "false");
              b.onclick = () => {
                fixture.submits++;
                b.textContent = "已关注";
                b.setAttribute("aria-pressed", "true");
              };
              document.querySelector(".feed-detail-content").append(b);
            };
          });
          const count = (await context.pages()).length;
          const plan = await prepareFollowUser(page, binding, {
            postId: "123",
          });
          assert.equal(await page.evaluate(() => fixture.submits), 0);
          assert.equal(
            (
              await followUser(page, binding, plan, {
                workspace: path.join(dir, "follow"),
              })
            ).status,
            "verified-ui",
          );
          assert.equal(
            (
              await followUser(page, binding, plan, {
                workspace: path.join(dir, "follow"),
              })
            ).status,
            "skipped-already-followed",
          );
          assert.equal(await page.evaluate(() => fixture.submits), 1);
          assert.equal((await context.pages()).length, count);
        },
      );
      await test(
        "follow author unknown state blocks submission",
        base,
        async ({ page }) => {
          await page.evaluate(() => {
            const original = detail;
            detail = (id) => {
              original(id);
              const b = document.createElement("button");
              b.className = "feed-header__follow-btn";
              const avatar = document.createElement("img");
              avatar.className = "feed-header__avatar";
              avatar.src = "author.png";
              document.querySelector(".feed-detail-content").append(avatar);
              b.textContent = "加载中";
              document.querySelector(".feed-detail-content").append(b);
            };
          });
          await assert.rejects(
            prepareFollowUser(page, binding, { postId: "123" }),
            { code: "FOLLOW_STATE_UNKNOWN" },
          );
          assert.equal(await page.evaluate(() => fixture.submits), 0);
          await assert.rejects(closeUserProfile({ page }), {
            code: "UNOWNED_PROFILE",
          });
          assert.equal(page.isClosed(), false);
        },
      );
      await test(
        "follow author uncertain submission cannot repeat",
        base,
        async ({ page }) => {
          await page.evaluate(() => {
            const original = detail;
            detail = (id) => {
              original(id);
              const img = document.createElement("img");
              img.className = "feed-header__avatar";
              img.src = "author.png";
              const b = document.createElement("button");
              b.className = "feed-header__follow-btn";
              b.textContent = "关注";
              b.setAttribute("aria-pressed", "false");
              b.onclick = () => fixture.submits++;
              document.querySelector(".feed-detail-content").append(img, b);
            };
          });
          const plan = await prepareFollowUser(page, binding, {
            postId: "123",
          });
          const options = { workspace: path.join(dir, "follow-uncertain") };
          assert.equal(
            (await followUser(page, binding, plan, options)).status,
            "uncertain",
          );
          assert.equal(
            (await followUser(page, binding, plan, options)).status,
            "blocked-previous-operation",
          );
          assert.equal(await page.evaluate(() => fixture.submits), 1);
        },
      );
      await test(
        "publish board selection and submit guard",
        {
          version: 2,
          binding: "fixture",
          action: "publish",
          content: { text: "分区测试" },
          publication: { statement: "无需声明" },
        },
        async ({ page, adapter, task }) => {
          await page.click('a[href="/publish"]');
          await page.evaluate(() => {
            const b = document.createElement("button");
            b.className = "publish-circle-picker__board";
            b.textContent = "交流";
            b.onclick = () =>
              b.classList.add("publish-circle-picker__board--active");
            document.body.append(b);
          });
          await assert.rejects(adapter.prepare(task), {
            code: "BOARD_REQUIRED",
          });
          task.publication.board = "交流";
          const evidence = await adapter.prepare(task);
          assert.equal(evidence.publication.board, "交流");
          await adapter.stage(task, evidence);
          await adapter.assertStaged(task, evidence);
          await page.$eval(".publish-circle-picker__board", (e) =>
            e.classList.remove("publish-circle-picker__board--active"),
          );
          await assert.rejects(adapter.assertStaged(task, evidence));
          assert.equal(await page.evaluate(() => fixture.submits), 0);
        },
      );
      await test(
        "query triggers loading and deduplicates the feed",
        base,
        async ({ page }) => {
          await page.evaluate(() => {
            const sentinel = document.createElement("div");
            sentinel.className = "feed-list__sentinel";
            sentinel.style.marginTop = "2000px";
            document.querySelector(".feed-list").append(sentinel);
            const observer = new IntersectionObserver((entries) => {
              if (entries.some((e) => e.isIntersecting)) {
                fixture.posts.push({
                  id: "124",
                  name: "other",
                  avatar: "other.png",
                  text: "next post",
                });
                home();
                observer.disconnect();
              }
            });
            observer.observe(sentinel);
          });
          const r = await queryPosts(page, binding, { limit: 2, maxLoads: 2 });
          assert.equal(r.posts.length, 2);
          assert.equal(r.complete, true);
          assert.equal(r.loads, 1);
          await backToTop(page);
          assert.equal(await page.evaluate(() => scrollY), 0);
        },
      );
      await test(
        "silent loading does not claim end of feed",
        base,
        async ({ page }) => {
          await page.evaluate(() => {
            const e = document.createElement("div");
            e.className = "feed-list__sentinel";
            document.querySelector(".feed-list").append(e);
          });
          assert.deepEqual(await loadMore(page, { timeoutMs: 200 }), {
            progress: false,
            stopReason: "no-progress",
          });
          await refreshFeed(page);
          assert.equal(await page.$(".feed-list__sentinel"), null);
        },
      );
      await test(
        "prepare has zero submissions",
        { ...base, action: "comment", content: { text: "评论测试" } },
        async ({ page, adapter, task }) => {
          await buildActionPlan(task, binding, adapter);
          assert.equal(await page.evaluate(() => fixture.submits), 0);
          await adapter.cleanup("https://hy.sns.sohu.com/");
          assert.equal(page.url(), "https://hy.sns.sohu.com/");
        },
      );
      for (const action of [
        "comment",
        "reply",
        "like-comment",
        "like-post",
        "publish",
      ]) {
        const task =
          action === "publish"
            ? {
                version: 2,
                binding: "fixture",
                action,
                content: { text: "纯文本发布测试" },
                publication: { statement: "内容由AI生成" },
              }
            : {
                ...base,
                action,
                ...(action.startsWith("like-")
                  ? {}
                  : { content: { text: `${action} 测试` } }),
                target: {
                  postId: "123",
                  ...(["reply", "like-comment"].includes(action)
                    ? {
                        comment: { authorName: "reader", text: "测试目标评论" },
                      }
                    : {}),
                },
              };
        await test(
          action + " submits once and verifies",
          task,
          async ({ page, adapter, task }) => {
            const plan = await buildActionPlan(task, binding, adapter);
            await adapter.cleanup("https://hy.sns.sohu.com/");
            const j = new Journal(path.join(dir, action));
            const result = await executePlan(plan, adapter, j);
            assert.equal(result.status, "verified-ui", JSON.stringify(result));
            assert.equal(await page.evaluate(() => fixture.submits), 1);
            assert.equal(
              (await executePlan(plan, adapter, j)).status,
              "skipped-duplicate",
            );
            assert.equal(await page.evaluate(() => fixture.submits), 1);
            if (action === "like-post")
              assert.equal(
                await page.evaluate(() => fixture.lastReaction),
                "点赞",
              );
          },
        );
      }
      await test(
        "rehearsal clears own draft without submitting",
        { ...base, action: "comment", content: { text: "不提交的演练" } },
        async ({ page, adapter, task }) => {
          const e = await adapter.prepare(task);
          await adapter.stage(task, e);
          await adapter.assertStaged(task, e);
          await adapter.cleanup("https://hy.sns.sohu.com/");
          assert.equal(await page.evaluate(() => fixture.submits), 0);
          assert.equal(page.url(), "https://hy.sns.sohu.com/");
        },
      );
      await test(
        "timeout becomes uncertain and cannot repeat",
        { ...base, action: "comment", content: { text: "超时测试" } },
        async ({ page, adapter, task }) => {
          const p = await buildActionPlan(task, binding, adapter);
          await page.evaluate(() => (fixture.mode = "timeout"));
          const j = new Journal(path.join(dir, "timeout"));
          assert.equal((await executePlan(p, adapter, j)).status, "uncertain");
          assert.equal(
            (await executePlan(p, adapter, j)).status,
            "blocked-uncertain",
          );
          assert.equal(await page.evaluate(() => fixture.submits), 1);
        },
      );
      await test(
        "existing user draft is preserved",
        { ...base, action: "comment", content: { text: "不能覆盖" } },
        async ({ page, adapter, task }) => {
          await page.click('a[href="/publish"]');
          await page.click("[contenteditable]");
          await page.keyboard.sendCharacter("用户自己的草稿");
          await assert.rejects(adapter.prepare(task), {
            code: "EXISTING_DRAFT",
          });
          assert.equal(
            await page.$eval("[contenteditable]", (e) => e.innerText),
            "用户自己的草稿",
          );
        },
      );
      await test(
        "post-like rehearsal opens menu without submitting",
        { ...base, action: "like-post" },
        async ({ page, adapter, task }) => {
          const e = await adapter.prepare(task);
          await adapter.stage(task, e);
          await adapter.assertStaged(task, e);
          await adapter.cleanup("https://hy.sns.sohu.com/");
          assert.equal(await page.evaluate(() => fixture.submits), 0);
          assert.equal(
            await page.$(".detail-input__fast-comment-popover"),
            null,
          );
        },
      );
      await test(
        "changed reaction icon prevents submission",
        { ...base, action: "like-post" },
        async ({ page, adapter, task }) => {
          const e = await adapter.prepare(task);
          await page.$eval(
            '[aria-label="点赞"] img',
            (e) => (e.src = "https://fixture.invalid/other.gif"),
          );
          await assert.rejects(adapter.stage(task, e), {
            code: "POST_LIKE_CHANGED",
          });
          assert.equal(await page.evaluate(() => fixture.submits), 0);
        },
      );
      await test(
        "existing own reaction prevents another send",
        { ...base, action: "like-post" },
        async ({ page, adapter, task }) => {
          await page.evaluate(() =>
            fixture.comments.unshift({
              name: "operator",
              avatar: "me.png",
              text: "",
              sticker: "924708741062862848.gif",
              replies: [],
            }),
          );
          const e = await adapter.prepare(task);
          await assert.rejects(adapter.stage(task, e), {
            code: "EXISTING_IDENTICAL_CONTENT",
          });
          assert.equal(await page.evaluate(() => fixture.submits), 0);
        },
      );
      await test(
        "post-like timeout prevents retry",
        { ...base, action: "like-post" },
        async ({ page, adapter, task }) => {
          const p = await buildActionPlan(task, binding, adapter);
          await page.evaluate(() => (fixture.mode = "timeout"));
          const j = new Journal(path.join(dir, "post-like-timeout"));
          assert.equal((await executePlan(p, adapter, j)).status, "uncertain");
          assert.equal(
            (await executePlan(p, adapter, j)).status,
            "blocked-uncertain",
          );
          assert.equal(await page.evaluate(() => fixture.submits), 1);
        },
      );
    } finally {
      await context.close();
    }
  });
} finally {
  if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()))
    throw Error("Unsafe cleanup");
  await rm(dir, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    passed,
    intercepted,
    realWebsiteRequests: 0,
    isolatedContextClosed: true,
  }),
);
