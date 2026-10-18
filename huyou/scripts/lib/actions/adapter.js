/** 狐友：页面动作适配及提交证据。 */
import { pauseBeforeOperation } from "../pacing.js";
import {
  fail,
  hash,
  normalizeText,
  matchComment,
  identity,
  avatarKey,
} from "./schema.js";
import { readSnapshot, assertContext } from "../snapshot.js";
import {
  ui,
  checkAccount,
  ensureNoDraft,
  uniqueClick,
  exactTextClick,
  openDetail,
  readDetail,
  closeDetail,
  findCommentHandle,
  openPublish,
  readPublish,
  restorePage,
  postEvidence,
} from "./dom.js";
import { checkQuickLike, POST_LIKE_STICKER } from "./dom.js";
import { locatePost } from "../../posts.js";
import { editableText } from "./dom.js";
import { prepareFollowUser } from "../../actions/follow-user.js";

export class HuyouAdapter {
  constructor(
    page,
    binding,
    { verifyTimeout = 12000, draftStore, plan, targetId } = {},
  ) {
    this.page = page;
    this.binding = binding;
    this.verifyTimeout = verifyTimeout;
    this.draftStore = draftStore;
    this.plan = plan;
    this.targetId = targetId;
  }
  async prepare(task, expected) {
    const page = this.page;
    await ensureNoDraft(page);
    const account = await checkAccount(
      page,
      this.binding.expectedAccountName,
      expected?.account,
    );
    if (task.action === "publish") {
      let knownPosts = [];
      if (!(await page.$(ui.publish))) {
        const snapshot = await readSnapshot(page);
        assertContext(snapshot, this.binding);
        knownPosts = snapshot.posts;
      }
      if (
        knownPosts.some(
          (p) =>
            p.author.name === account.name &&
            normalizeText(p.text) === task.content.text,
        )
      )
        fail(
          "EXISTING_IDENTICAL_CONTENT",
          "已加载列表中已有当前账号的同文帖子，不重复发布",
        );
      await openPublish(page);
      await page.waitForFunction(
        (n) =>
          document
            .querySelector(".publish-circle-picker__button")
            ?.textContent.trim() === n,
        { timeout: 10000 },
        this.binding.expectedCircleName,
      );
      if (task.publication.board) {
        await pauseBeforeOperation();
        await exactTextClick(
          page,
          ".publish-circle-picker__board",
          task.publication.board,
        );
        await page.waitForFunction(
          (n) =>
            document
              .querySelector(".publish-circle-picker__board--active")
              ?.textContent.trim() === n,
          { timeout: 5000 },
          task.publication.board,
        );
      }
      const p = await readPublish(page);
      if (p.hasBoards && !p.board)
        fail("BOARD_REQUIRED", "请提供 publication.board，发布需要选中分区");
      if (p.circleName !== this.binding.expectedCircleName)
        fail("CIRCLE_MISMATCH", "发布表单的圈子与绑定不符，请手动选择正确圈子");
      await ensureNoDraft(page);
      return {
        account,
        publication: {
          circleName: p.circleName,
          ...(p.board ? { board: p.board } : {}),
        },
        knownPostIds: [
          ...new Set([
            ...(expected?.knownPostIds || []),
            ...knownPosts.map((p) => p.id).filter(Boolean),
          ]),
        ],
        identityStrength: "name-and-avatar-not-uid",
      };
    }
    assertContext(await readSnapshot(page), this.binding);
    if (!(await page.$(ui.detail))) {
      const found = await locatePost(page, this.binding, task.target.postId);
      if (!found.found)
        fail(
          "POST_NOT_LOADED",
          "限定加载范围内未找到目标帖子：" + found.stopReason,
        );
    }
    await openDetail(page, task.target.postId);
    const d = await readDetail(page);
    if (
      d.postId !== task.target.postId ||
      d.circleName !== this.binding.expectedCircleName
    )
      fail("POST_CONTEXT_MISMATCH", "详情帖子或圈子与任务不符");
    const evidence = {
      account,
      post: postEvidence(d),
      identityStrength: "name-and-avatar-not-uid",
    };
    if (task.action === "follow-user") {
      evidence.follow = await prepareFollowUser(
        page,
        this.binding,
        task.target,
      );
      if (
        expected?.follow &&
        hash(evidence.follow.author) !== hash(expected.follow.author)
      )
        fail("AUTHOR_CHANGED", "作者变化");
    }
    if (task.action === "like-post") {
      evidence.reaction = await checkQuickLike(page, { open: true });
      if (
        expected?.reaction &&
        hash(evidence.reaction) !== hash(expected.reaction)
      )
        fail("POST_LIKE_CHANGED", "点赞表情与计划不符");
    }
    if (["reply", "like-comment"].includes(task.action)) {
      evidence.comment = matchComment(d.comments, task.target.comment);
      if (
        expected?.comment &&
        hash(identity(evidence.comment)) !== hash(identity(expected.comment))
      )
        fail("COMMENT_CHANGED", "目标评论内容或身份已变化");
      if (
        task.action === "like-comment" &&
        evidence.comment.like.state === "unknown"
      )
        fail("LIKE_STATE_UNKNOWN", "无法确认当前评论点赞状态，不进行切换");
    }
    if (expected?.post && hash(evidence.post) !== hash(expected.post))
      fail("POST_CHANGED", "帖子内容或作者与预览计划不一致");
    return evidence;
  }
  async inspectComments(postId) {
    await ensureNoDraft(this.page);
    assertContext(await readSnapshot(this.page), this.binding);
    await openDetail(this.page, postId);
    const d = await readDetail(this.page);
    if (d.circleName !== this.binding.expectedCircleName)
      fail("CIRCLE_MISMATCH", "详情圈子不符");
    return d;
  }
  async fill(selector, text) {
    const el = await this.page.$(selector);
    if (!el) fail("EDITOR_MISSING", "编辑器不存在");
    const current = await el.evaluate((e) => ({
      text: e.value ?? e.innerText,
      max: e.maxLength,
    }));
    if (current.text.trim()) fail("EXISTING_DRAFT", "编辑器已有内容，拒绝覆盖");
    if (
      Number.isInteger(current.max) &&
      current.max >= 0 &&
      text.length > current.max
    )
      fail("TEXT_TOO_LONG", "文本超过页面实际输入限制");
    const placeholder = await el.evaluate((e) => e.getAttribute("placeholder"));
    const record = {
      status: "intent",
      planDigest: this.plan?.digest,
      binding: this.binding,
      targetId: this.targetId,
      selector,
      text,
      placeholder,
      at: new Date().toISOString(),
    };
    if (this.draftStore) await this.draftStore.save(this.plan.digest, record);
    await el.click();
    await this.page.keyboard.sendCharacter(text);
    const value = await el.evaluate(editableText);
    if (value !== text) fail("TEXT_CHANGED", "输入内容与任务不一致，不提交");
    this.ownDraft = { selector, text, placeholder };
    if (this.draftStore)
      await this.draftStore.save(this.plan.digest, {
        ...record,
        status: "owned",
      });
  }
  async clearOwnDraft() {
    if (!this.ownDraft) return;
    const { selector, text } = this.ownDraft;
    const el = await this.page.$(selector);
    if (el && (await el.evaluate(editableText)) === text) {
      if (
        (await el.evaluate((e) => e.getAttribute("placeholder"))) !==
        this.ownDraft.placeholder
      )
        fail("DRAFT_TARGET_CHANGED", "输入框目标变化，保留草稿");
      await el.click();
      await this.page.keyboard.down("Control");
      await this.page.keyboard.press("KeyA");
      await this.page.keyboard.up("Control");
      await this.page.keyboard.press("Backspace");
      if ((await el.evaluate(editableText)) !== "")
        fail("DRAFT_CLEAR_FAILED", "草稿未清空");
    } else if (el && (await el.evaluate(editableText)).trim()) {
      fail("DRAFT_CHANGED", "草稿已被修改，保留现场");
    }
    if (this.draftStore) {
      const r = await this.draftStore.get(this.plan.digest);
      if (r)
        await this.draftStore.save(this.plan.digest, {
          ...r,
          status: "released",
          releasedAt: new Date().toISOString(),
        });
    }
    this.ownDraft = null;
  }
  async stage(task, evidence) {
    const page = this.page;
    if (task.action === "follow-user") return { kind: "follow-user" };
    if (task.action === "like-post") {
      await checkQuickLike(page, { open: true });
      const detail = await readDetail(page);
      const beforeMatches = this.matches(detail, task, evidence).length;
      if (beforeMatches)
        fail(
          "EXISTING_IDENTICAL_CONTENT",
          "已加载评论中存在当前账号的点赞表情，不重复发送",
        );
      return {
        kind: "like-post",
        beforeMatches,
        sticker: POST_LIKE_STICKER,
        beforeFastComments: detail.fastComments,
      };
    }
    if (task.action === "like-comment") {
      const { comment } = await findCommentHandle(page, evidence.comment);
      return {
        kind: "like-comment",
        beforeLike: comment.like,
        target: identity(comment),
      };
    }
    if (task.action === "publish") {
      const p = await readPublish(page);
      if (p.circleName !== evidence.publication.circleName)
        fail("CIRCLE_MISMATCH", "发布圈子已变化");
      this.previousStatement = p.statement;
      await uniqueClick(page, ui.statement);
      await page.waitForSelector(ui.statementOption, {
        visible: true,
        timeout: 5000,
      });
      await exactTextClick(
        page,
        ui.statementOption,
        task.publication.statement,
      );
      await page.waitForFunction(
        (s) =>
          document
            .querySelector(".publish-statement__entry")
            ?.innerText.trim() === s,
        { timeout: 5000 },
        task.publication.statement,
      );
      await this.fill(ui.editor, task.content.text);
      return {
        kind: "publish",
        knownPostIds: evidence.knownPostIds,
        stagedAt: new Date().toISOString(),
      };
    }
    const d = await readDetail(page);
    if (this.matches(d, task, evidence).length)
      fail(
        "EXISTING_IDENTICAL_CONTENT",
        "目标位置已有该账号的相同文字，不重复提交",
      );
    if (task.action === "reply") {
      const { el, comment } = await findCommentHandle(page, evidence.comment);
      const buttons = await el.$$(".comment-item__actions button");
      const replies = [];
      for (const b of buttons)
        if (
          await b.evaluate((e) =>
            e
              .querySelector("img")
              ?.getAttribute("src")
              ?.endsWith("/ic_Icon_comment_bc2f_c@3x.png"),
          )
        )
          replies.push(b);
      if (replies.length !== 1)
        fail("REPLY_CONTROL_MISSING", "没有唯一回复按钮");
      await replies[0].click();
      await page.waitForFunction(
        (n) =>
          document.querySelector(".detail-input__textarea")?.placeholder ===
          `回复 ${n}:`,
        { timeout: 5000 },
        comment.authorName,
      );
    } else {
      // 不复用处于回复模式的编辑器。
      if (await page.$(ui.input)) await closeDetail(page);
      await openDetail(page, task.target.postId);
      await uniqueClick(page, ui.inputBox);
      await page.waitForFunction(
        (n) =>
          document.querySelector(".detail-input__textarea")?.placeholder ===
          `评论 ${n}:`,
        { timeout: 5000 },
        evidence.post.authorName,
      );
    }
    await this.fill(ui.input, task.content.text);
    return {
      kind: task.action,
      beforeMatches: this.matches(d, task, evidence).length,
    };
  }
  matches(d, task, evidence) {
    const parent =
      task.action === "reply"
        ? matchComment(d.comments, evidence.comment)
        : null;
    return d.comments.filter(
      (c) =>
        c.authorName === evidence.account.name &&
        avatarKey(c.avatar) === evidence.account.avatar &&
        (task.action === "like-post"
          ? c.stickers?.some((src) => avatarKey(src) === POST_LIKE_STICKER)
          : normalizeText(c.text) === task.content.text) &&
        (parent ? c.isReply && c.parentIndex === parent.index : !c.isReply),
    );
  }
  async assertStaged(task, evidence) {
    const page = this.page;
    await checkAccount(
      page,
      this.binding.expectedAccountName,
      evidence.account,
    );
    if (task.action === "follow-user") {
      const current = await prepareFollowUser(page, this.binding, task.target);
      if (hash(current.author) !== hash(evidence.follow.author))
        fail("AUTHOR_CHANGED", "作者变化");
      return;
    }
    if (task.action === "publish") {
      const p = await readPublish(page);
      if (
        p.circleName !== evidence.publication.circleName ||
        p.board !== (evidence.publication.board || null) ||
        normalizeText(p.editorText) !== task.content.text ||
        p.statement !== task.publication.statement ||
        p.hasMedia
      )
        fail("FORM_CHANGED", "发布表单与计划不一致");
    } else {
      const d = await readDetail(page);
      if (hash(postEvidence(d)) !== hash(evidence.post))
        fail("POST_CHANGED", "提交前帖子发生变化");
      if (
        evidence.comment &&
        hash(identity(matchComment(d.comments, evidence.comment))) !==
          hash(identity(evidence.comment))
      )
        fail("COMMENT_CHANGED", "提交前目标评论变化");
      if (task.action === "like-post") await checkQuickLike(page);
      if (!["like-comment", "like-post"].includes(task.action)) {
        const v = await page.$eval(ui.input, (e) => ({
          value: e.value,
          placeholder: e.placeholder,
        }));
        const label =
          task.action === "reply"
            ? `回复 ${evidence.comment.authorName}:`
            : `评论 ${evidence.post.authorName}:`;
        if (
          normalizeText(v.value) !== task.content.text ||
          v.placeholder !== label
        )
          fail("FORM_CHANGED", "输入内容或回复目标与计划不一致");
      }
    }
    if (!["like-comment", "like-post"].includes(task.action)) {
      const selector =
        task.action === "publish" ? ui.submitPost : ui.submitComment;
      if (
        !(await page.$(selector)) ||
        (await page.$eval(selector, (e) => e.disabled))
      )
        fail("SUBMIT_DISABLED", "发布按钮不可用，未提交");
    }
  }
  async submit(task, evidence) {
    await pauseBeforeOperation();
    await this.assertStaged(task, evidence);
    if (task.action === "follow-user") {
      const s = await prepareFollowUser(this.page, this.binding, task.target);
      if (s.followState === "followed") return { alreadyFollowed: true };
      await uniqueClick(
        this.page,
        ".feed-detail-content .feed-header__follow-btn",
      );
      return {};
    }
    // 仅在待提交记录持久化后调用。
    if (task.action === "like-post") {
      await checkQuickLike(this.page);
      this.submissionResponses = [];
      this.responseListener = (r) => {
        try {
          if (
            r.request().method() === "POST" &&
            this.submissionResponses.length < 20
          ) {
            const u = new URL(r.url());
            this.submissionResponses.push({
              origin: u.origin,
              path: u.pathname,
              status: r.status(),
            });
          }
        } catch {}
      };
      this.page.on("response", this.responseListener);
      await uniqueClick(this.page, ui.quickLike);
      return {};
    }
    if (task.action === "like-comment") {
      const { el, comment } = await findCommentHandle(
        this.page,
        evidence.comment,
      );
      if (comment.like.state === "liked") return { alreadyLiked: true };
      if (comment.like.state !== "unliked")
        fail("LIKE_STATE_UNKNOWN", "提交前点赞状态不可确认");
      const b = await el.$('button[aria-label="评论点赞"]');
      await b.click();
      return {};
    }
    await uniqueClick(
      this.page,
      task.action === "publish" ? ui.submitPost : ui.submitComment,
    );
    return {};
  }
  async verifyOnce(task, evidence, baseline) {
    await checkAccount(
      this.page,
      this.binding.expectedAccountName,
      evidence.account,
    );
    if (task.action === "publish") {
      if (await this.page.$(ui.publish)) return null;
      const s = await readSnapshot(this.page);
      if (
        s.circle.name !== evidence.publication.circleName ||
        s.circle.sidebarName !== evidence.publication.circleName
      )
        return null;
      const now = new Date();
      const localMinutes =
        Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Shanghai",
            hour: "2-digit",
            hourCycle: "h23",
          }).format(now),
        ) *
          60 +
        Number(
          new Intl.DateTimeFormat("en-GB", {
            timeZone: "Asia/Shanghai",
            minute: "2-digit",
          }).format(now),
        );
      const fresh = (label) => {
        if (label === "刚刚" || label === "1分钟前") return true;
        const m = /^今天\s+(\d{2}):(\d{2})$/.exec(label || "");
        return Boolean(
          m &&
            localMinutes - (Number(m[1]) * 60 + Number(m[2])) >= 0 &&
            localMinutes - (Number(m[1]) * 60 + Number(m[2])) <= 2,
        );
      };
      const rows = s.posts.filter(
        (p) =>
          fresh(p.publishedLabel) &&
          p.author.name === evidence.account.name &&
          avatarKey(p.author.avatar) === evidence.account.avatar &&
          !p.textTruncated &&
          normalizeText(p.text) === task.content.text &&
          p.id &&
          !baseline.knownPostIds.includes(p.id),
      );
      // 新 DOM 卡片属于页面证据，不是服务端回执；返回 ID 供核对。
      return rows.length === 1
        ? { source: "new-own-post-card", postId: rows[0].id }
        : null;
    }
    if (
      new URL(this.page.url()).searchParams.get("feedDetail") !==
      task.target.postId
    )
      return null;
    const d = await readDetail(this.page);
    if (task.action === "like-post") this.lastFastComments = d.fastComments;
    if (hash(postEvidence(d)) !== hash(evidence.post)) return null;
    if (task.action === "follow-user") {
      const s = await prepareFollowUser(this.page, this.binding, task.target);
      return s.followState === "followed" &&
        hash(s.author) === hash(evidence.follow.author)
        ? { source: "explicit-followed-state", author: s.author }
        : null;
    }
    if (task.action === "like-comment") {
      const c = matchComment(d.comments, evidence.comment);
      if (c.like.state === "liked")
        return { source: "explicit-liked-state", like: c.like };
      // 计数增长不足以确认点赞，还需图标状态变化。
      if (
        c.like.icon &&
        c.like.icon !== baseline.beforeLike.icon &&
        c.like.count >= baseline.beforeLike.count + 1
      )
        return { source: "icon-and-count-transition", like: c.like };
      return null;
    }
    const matches = this.matches(d, task, evidence);
    return matches.length > baseline.beforeMatches
      ? {
          source:
            task.action === "like-post"
              ? "new-own-thumbs-up-sticker"
              : task.action === "reply"
                ? "new-own-reply-under-target"
                : "new-own-top-level-comment",
          matchingCount: matches.length,
        }
      : null;
  }
  async verify(task, evidence, baseline) {
    const until = Date.now() + this.verifyTimeout;
    while (Date.now() < until) {
      const result = await this.verifyOnce(task, evidence, baseline);
      if (result) {
        // 短暂等待后重新读取，防止乐观更新的界面回滚。
        await new Promise((r) => setTimeout(r, 600));
        const again = await this.verifyOnce(task, evidence, baseline);
        if (again) return { status: "verified-ui", evidence: again };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      status: "uncertain",
      reason: "提交后没有取得足够的页面证据；禁止自动重发",
      ...(task.action === "like-post"
        ? {
            verification: {
              method: "own-sticker-in-loaded-comments",
              limitation: "普通评论读取不保证覆盖独立表情评论区",
              beforeFastComments: baseline.beforeFastComments,
              afterFastComments: this.lastFastComments,
              observedPostResponses: this.submissionResponses || [],
              responseMeaning:
                "仅请求元数据和计数；HTTP 成功或计数增长不证明本人操作成功",
            },
            nextAction: "reconcile-or-user-confirmation",
          }
        : {}),
    };
  }
  dispose() {
    if (this.responseListener) {
      this.page.off("response", this.responseListener);
      this.responseListener = null;
    }
  }
  async cleanup(originalURL) {
    await this.clearOwnDraft();
    if (await this.page.$(ui.quickMenu))
      await uniqueClick(this.page, ui.quickTrigger);
    if (this.previousStatement && (await this.page.$(ui.publish))) {
      const wanted =
        this.previousStatement === "添加内容类型声明"
          ? "无需声明"
          : this.previousStatement;
      await uniqueClick(this.page, ui.statement);
      await this.page.waitForSelector(ui.statementOption, {
        visible: true,
        timeout: 5000,
      });
      await exactTextClick(this.page, ui.statementOption, wanted);
    }
    await restorePage(this.page, originalURL);
  }
}
