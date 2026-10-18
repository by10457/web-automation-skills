/** QQ 频道：动作与页面行为适配。 */
import { pace, fail, hash, avatarIdentity, saveJSON, route } from "./core.js";
import {
  selectors,
  readSnapshot,
  ready,
  assertContext,
  assertNoDraft,
  clickUnique,
  clickText,
} from "./dom.js";
import { openPost } from "../posts.js";
import { selectChannel } from "../channels.js";
import { backToTop } from "../navigation.js";
import { resolveComment } from "../comments.js";
import { verifyImages } from "./files.js";
import path from "node:path";

export const postIdentity = (p) => ({
  id: p.id,
  channelId: p.channelId,
  author: { name: p.author.name, avatar: avatarIdentity(p.author.avatar) },
  text: p.text,
});
export const commentIdentity = (c) => ({
  id: c.id,
  author: { name: c.author.name, avatar: avatarIdentity(c.author.avatar) },
  text: c.text,
  isReply: c.isReply,
  parentId: c.parentId,
});
export function commentActor(plan) {
  const name =
    plan.binding.expectedCommentAuthorName ||
    plan.binding.expectedChannelAccountName ||
    plan.evidence.account.channelName;
  const avatar =
    plan.binding.expectedCommentAuthorAvatar ||
    (name === plan.evidence.account.channelName
      ? plan.evidence.account.channelAvatar
      : null);
  return { name, avatar: avatar ? avatarIdentity(avatar) : null };
}
const matchesActor = (author, actor) =>
  author.name === actor.name &&
  (!actor.avatar || avatarIdentity(author.avatar) === actor.avatar);
export function confirmPreviews(previews, expectedCount) {
  if (
    previews.length !== expectedCount ||
    previews.some((p) => !p.ready || !/^https:\/\//.test(p.src || ""))
  )
    fail(
      "UPLOAD_UNVERIFIED",
      "图片预览数量、远程地址或加载状态未确认；保留草稿",
    );
  return previews.map((p) => p.src);
}
export class ActionAdapter {
  constructor(
    page,
    binding,
    { workspace, runDir, verifyTimeoutMs = 12000 } = {},
  ) {
    Object.assign(this, { page, binding, workspace, runDir, verifyTimeoutMs });
  }
  async snapshot() {
    const s = await readSnapshot(this.page);
    assertContext(s, this.binding);
    return s;
  }
  async openComposer(action) {
    const s = await ready(this.page);
    assertContext(s, this.binding);
    assertNoDraft(s);
    if (s.pageType !== "feed") await selectChannel(this.page, this.binding);
    // 长列表扫描后虚拟化可能隐藏编辑器，读取频道身份前先回到顶部。
    await backToTop(this.page, this.binding);
    if (
      !(await this.page.$(selectors.editor)) ||
      !(await readSnapshot(this.page)).account.channelName
    )
      await clickUnique(this.page, ".editor-header");
    await this.page.waitForSelector(selectors.editor, {
      visible: true,
      timeout: 10000,
    });
    const expected = ["comment", "like-post"].includes(action)
      ? this.binding.expectedInteractionAccountName ||
        this.binding.expectedChannelAccountName
      : this.binding.expectedChannelAccountName;
    if (!expected)
      fail("CHANNEL_ACCOUNT_REQUIRED", "发送动作需要配置频道内昵称");
    const after = await this.snapshot();
    assertNoDraft(after);
    if (after.account.channelName !== expected)
      fail(
        "CHANNEL_ACCOUNT_MISMATCH",
        `当前互动身份为「${after.account.channelName || "未知"}」，预期「${expected}」`,
      );
    return after;
  }
  async prepare(task) {
    await pace();
    const direct =
      this.binding.directPostPreparation &&
      ["comment", "like-post"].includes(task.action);
    let own, account;
    if (direct) {
      own = await ready(this.page);
      assertContext(own, this.binding);
      assertNoDraft(own);
      if (
        !this.binding.expectedInteractionAccountName ||
        !this.binding.expectedInteractionAccountAvatar ||
        !this.binding.expectedCommentAuthorName ||
        !this.binding.expectedCommentAuthorAvatar
      )
        fail(
          "DIRECT_IDENTITY_REQUIRED",
          "直接进入帖子需要预先核验互动身份及评论署名、头像",
        );
      account = {
        name: own.account.name,
        avatar: avatarIdentity(own.account.avatar),
        channelName: this.binding.expectedInteractionAccountName,
        channelAvatar: avatarIdentity(
          this.binding.expectedInteractionAccountAvatar,
        ),
      };
    } else {
      own = await this.openComposer(task.action);
      account = {
        name: own.account.name,
        avatar: avatarIdentity(own.account.avatar),
        channelName: own.account.channelName,
        channelAvatar: avatarIdentity(own.account.channelAvatar),
      };
    }
    if (!account.channelAvatar) fail("ACCOUNT_UNKNOWN", "无法读取频道身份头像");
    if (task.action === "publish") {
      if (
        !own.composer.textLimit ||
        task.content.text.length > own.composer.textLimit
      )
        fail("TEXT_LIMIT", "未读到发布上限或正文超限");
      const visibleChoices = await this.page.$$(selectors.boardChoice);
      let pickerOpen = false;
      for (const e of visibleChoices)
        if (await e.isVisible()) pickerOpen = true;
      if (!pickerOpen) await clickUnique(this.page, selectors.board);
      await this.page.waitForSelector(selectors.boardChoice, {
        visible: true,
        timeout: 5000,
      });
      const boards = await this.page.$$eval(selectors.boardChoice, (es) =>
        es.map((e) => ({
          name: e.textContent.trim(),
          disabled:
            e.classList.contains("disabled") ||
            e.getAttribute("aria-disabled") === "true",
        })),
      );
      const matched = boards.filter((b) => b.name === task.board);
      if (matched.length !== 1) fail("INVALID_BOARD", "发布版块缺失或重名");
      if (matched[0].disabled)
        fail("BOARD_DISABLED", "该版块不可发布，请选择有权限的版块");
      await clickText(this.page, selectors.boardChoice, task.board);
      await this.page.waitForFunction(
        ({ css, name }) =>
          document.querySelector(css)?.textContent.trim() === name,
        { timeout: 5000 },
        { css: selectors.board, name: task.board },
      );
      const after = await this.snapshot();
      if (after.composer.board !== task.board)
        fail("BOARD_CHANGED", "发布版块未选中");
      return {
        account,
        board: task.board,
        textLimit: own.composer.textLimit,
        knownPostIds: own.posts.map((p) => p.id),
      };
    }
    await openPost(this.page, this.binding, task.target.url);
    await this.page.waitForSelector(
      ".comment-bar__comment-count,.has-no-comment",
      { timeout: 15000 },
    );
    const detail = (await this.snapshot()).detail;
    if (!detail.textComplete)
      fail("UNSUPPORTED_POST_LAYOUT", "未确认详情完整正文布局，停止互动");
    const evidence = { account, post: postIdentity(detail) };
    if (task.action === "reply")
      evidence.comment = commentIdentity(
        resolveComment(detail.comments, task.target.comment),
      );
    if (task.action === "like-post" && detail.like.state === "unknown")
      fail("LIKE_STATE_UNKNOWN", "未确认点赞状态，禁止切换");
    return evidence;
  }
  async preflight(plan) {
    await verifyImages(plan.images);
    if (plan.task.action !== "publish") {
      await openPost(this.page, this.binding, plan.task.target.url);
      await this.page.waitForSelector(
        ".comment-bar__comment-count,.has-no-comment",
        { timeout: 15000 },
      );
      const s = await this.snapshot();
      assertNoDraft(s);
      if (
        s.account.name !== plan.evidence.account.name ||
        avatarIdentity(s.account.avatar) !== plan.evidence.account.avatar
      )
        fail("ACCOUNT_CHANGED", "操作账号证据变化");
      if (hash(postIdentity(s.detail)) !== hash(plan.evidence.post))
        fail("POST_CHANGED", "帖子内容或作者变化");
      if (
        plan.evidence.comment &&
        hash(
          commentIdentity(
            resolveComment(s.detail.comments, plan.task.target.comment),
          ),
        ) !== hash(plan.evidence.comment)
      )
        fail("COMMENT_CHANGED", "目标评论变化");
      return;
    }
    const current = await this.prepare(plan.task);
    if (hash(current.account) !== hash(plan.evidence.account))
      fail("ACCOUNT_CHANGED", "操作账号证据变化");
    if (plan.evidence.post && hash(current.post) !== hash(plan.evidence.post))
      fail("POST_CHANGED", "帖子内容或作者变化");
    if (
      plan.evidence.comment &&
      hash(current.comment) !== hash(plan.evidence.comment)
    )
      fail("COMMENT_CHANGED", "目标评论变化");
  }
  async alreadySatisfied(plan) {
    return (
      plan.task.action === "like-post" &&
      (await this.snapshot()).detail.like.state === "liked"
    );
  }
  async stage(plan) {
    const { task } = plan,
      s = await this.snapshot();
    assertNoDraft(s);
    const baseline = {
      postIds: s.posts.map((p) => p.id),
      commentIds: s.detail?.comments.map((c) => c.id) || [],
      like: s.detail?.like || null,
      stagedAt: new Date().toISOString(),
    };
    if (task.action === "like-post") return baseline;
    const own = plan.evidence.account,
      actor = commentActor(plan);
    if (
      task.action === "publish" &&
      s.posts.some(
        (p) =>
          p.author.name === own.channelName &&
          avatarIdentity(p.author.avatar) === own.channelAvatar &&
          !p.textTruncated &&
          p.text === task.content.text &&
          p.images.length === plan.images.length,
      )
    )
      fail(
        "EXISTING_IDENTICAL_CONTENT",
        "已加载列表有同文同数量附件帖子，先核对",
      );
    if (
      task.action !== "publish" &&
      s.detail.comments.some(
        (c) =>
          matchesActor(c.author, actor) &&
          c.text === task.content.text &&
          (task.action === "reply"
            ? c.parentId === plan.evidence.comment.id
            : !c.isReply),
      )
    )
      fail("EXISTING_IDENTICAL_CONTENT", "目标位置已有本人同文评论，先核对");
    if (task.action === "reply") {
      const c = resolveComment(s.detail.comments, task.target.comment),
        handles = await this.page.$$(selectors.comment),
        matches = [];
      for (const e of handles)
        if (await e.evaluate((n, id) => n.id === id, c.id)) matches.push(e);
      if (matches.length !== 1) fail("AMBIGUOUS_COMMENT", "无法唯一定位评论");
      const control = await matches[0].$(selectors.reply);
      if (!control) fail("REPLY_MISSING", "回复入口不存在");
      await control.click();
    } else if (task.action === "comment") {
      if (s.composer.replyLabel?.startsWith("回复"))
        fail(
          "REPLY_MODE",
          "当前处于回复模式，请先在页面退出回复模式后再评论；不会整页刷新",
        );
      await clickUnique(this.page, selectors.input);
    }
    await this.page.waitForSelector(selectors.editor, {
      visible: true,
      timeout: 10000,
    });
    await this.checkTarget(plan);
    const editor = await this.page.$(selectors.editor);
    await saveJSON(path.join(this.runDir, "draft.json"), {
      status: "input-intent",
      planDigest: plan.digest,
      text: task.content.text,
      images: plan.images.map((f) => f.sha256),
    });
    await editor.click();
    await this.page.keyboard.sendCharacter(task.content.text);
    const after = await this.snapshot();
    if (
      after.composer.editors.length !== 1 ||
      after.composer.editors[0].text !== task.content.text
    )
      fail("TEXT_CHANGED", "实际输入与计划不符；保留草稿");
    await saveJSON(path.join(this.runDir, "draft.json"), {
      status: "owned",
      planDigest: plan.digest,
      text: task.content.text,
      images: plan.images.map((f) => f.sha256),
    });
    this.previewSources = [];
    for (let i = 0; i < plan.images.length; i++) {
      await pace();
      await this.checkTarget(plan);
      await verifyImages(plan.images);
      const file = await this.page.$(selectors.file);
      if (!file) fail("UPLOAD_MISSING", "上传入口不存在");
      await file.uploadFile(plan.images[i].path);
      const until = Date.now() + 45000;
      let previews;
      while (Date.now() < until) {
        const p = (await this.snapshot()).composer;
        if (/失败|超出|过大|不支持/.test(p.uploadText))
          fail("UPLOAD_FAILED", "上传被页面拒绝，保留草稿");
        try {
          previews = confirmPreviews(p.previews, i + 1);
          if (/上传中|处理中|加载中/.test(p.uploadText)) previews = null;
        } catch (e) {
          if (e.code !== "UPLOAD_UNVERIFIED") throw e;
        }
        if (previews) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!previews) fail("UPLOAD_UNVERIFIED", "未确认远程图片预览，保留草稿");
      if (this.previewSources.some((src, j) => src !== previews[j]))
        fail("IMAGE_ORDER_CHANGED", "上传后已有图片顺序或地址变化");
      this.previewSources = previews;
    }
    baseline.previewSources = this.previewSources;
    return baseline;
  }
  async checkTarget(plan) {
    const s = await this.snapshot(),
      { task, evidence } = plan;
    if (avatarIdentity(s.account.avatar) !== evidence.account.avatar)
      fail("ACCOUNT_CHANGED", "全局头像证据变化");
    if (task.action === "publish") {
      if (
        s.pageType !== "feed" ||
        s.composer.board !== task.board ||
        s.account.channelName !== evidence.account.channelName ||
        avatarIdentity(s.account.channelAvatar) !==
          evidence.account.channelAvatar
      )
        fail("PUBLISH_CONTEXT_CHANGED", "发布身份或版块变化");
      if (
        !s.composer.textLimit ||
        task.content.text.length > s.composer.textLimit
      )
        fail("TEXT_LIMIT", "发布正文超限");
    } else {
      if (!s.detail || hash(postIdentity(s.detail)) !== hash(evidence.post))
        fail("POST_CHANGED", "目标帖子变化");
      if (task.action === "reply") {
        const c = resolveComment(s.detail.comments, task.target.comment);
        if (
          hash(commentIdentity(c)) !== hash(evidence.comment) ||
          !c.replying ||
          s.composer.replyLabel !== `回复${c.author.name}：${c.text}`
        )
          fail("REPLY_TARGET_CHANGED", "回复目标提示与计划不符");
      } else if (
        task.action === "comment" &&
        s.composer.replyLabel?.startsWith("回复")
      )
        fail("REPLY_MODE", "当前处于回复模式");
    }
    return s;
  }
  async assertStaged(plan) {
    const s = await this.checkTarget(plan);
    if (plan.task.action === "like-post") {
      if (s.detail.like.state !== "unliked")
        fail("LIKE_STATE_CHANGED", "点赞状态发生变化，停止");
      return;
    }
    if (
      s.composer.editors.length !== 1 ||
      s.composer.editors[0].text !== plan.task.content.text
    )
      fail("TEXT_CHANGED", "正文变化");
    const src = confirmPreviews(s.composer.previews, plan.images.length);
    if (hash(src) !== hash(this.previewSources || []))
      fail("IMAGE_CHANGED", "图片预览变化");
    if (
      s.composer.buttonDisabled ||
      s.composer.buttonText !==
        (plan.task.action === "publish" ? "发表" : "发送")
    )
      fail("SUBMIT_DISABLED", "提交按钮不可用");
  }
  async submit(plan) {
    await pace();
    await this.assertStaged(plan);
    await clickUnique(
      this.page,
      plan.task.action === "like-post" ? selectors.like : selectors.publish,
    );
  }
  async verifyOnce(plan, baseline) {
    const s = await this.snapshot(),
      { task, evidence } = plan;
    if (avatarIdentity(s.account.avatar) !== evidence.account.avatar)
      fail("ACCOUNT_CHANGED", "账号变化");
    if (task.action === "publish") {
      const p = s.detail;
      if (
        p &&
        !baseline.postIds.includes(p.id) &&
        p.textComplete &&
        p.author.name === evidence.account.channelName &&
        avatarIdentity(p.author.avatar) === evidence.account.channelAvatar &&
        p.text === task.content.text &&
        p.images.length === plan.images.length
      )
        return { source: "new-own-post-detail", postId: p.id, url: p.url };
      const found = s.posts.filter(
        (p) =>
          !baseline.postIds.includes(p.id) &&
          p.author.name === evidence.account.channelName &&
          avatarIdentity(p.author.avatar) === evidence.account.channelAvatar &&
          !p.textTruncated &&
          p.text === task.content.text &&
          p.images.length === plan.images.length,
      );
      return found.length === 1
        ? {
            source: "new-own-post-card",
            postId: found[0].id,
            url: found[0].url,
          }
        : null;
    }
    if (!s.detail || hash(postIdentity(s.detail)) !== hash(evidence.post))
      return null;
    if (task.action === "like-post")
      return s.detail.like.state === "liked"
        ? { source: "explicit-liked-state" }
        : null;
    const actor = commentActor(plan);
    const found = s.detail.comments.filter(
      (c) =>
        !baseline.commentIds.includes(c.id) &&
        c.id &&
        matchesActor(c.author, actor) &&
        c.text === task.content.text &&
        (task.action === "reply"
          ? c.isReply && c.parentId === evidence.comment.id
          : !c.isReply),
    );
    return found.length === 1
      ? {
          source: "new-own-comment",
          commentId: found[0].id,
          parentId: found[0].parentId,
        }
      : null;
  }
  async verify(plan, baseline) {
    const until = Date.now() + this.verifyTimeoutMs;
    while (Date.now() < until) {
      const a = await this.verifyOnce(plan, baseline);
      if (a) {
        await new Promise((r) => setTimeout(r, 700));
        const b = await this.verifyOnce(plan, baseline);
        if (b && hash(a) === hash(b))
          return { status: "verified-ui", evidence: b };
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return { status: "uncertain", reason: "未取得足够页面证据，禁止自动重发" };
  }
  async reconcile(plan, record) {
    if (!record.baseline) return null;
    const current = await this.verifyOnce(plan, record.baseline);
    if (current) return current;
    const s = await this.snapshot();
    assertNoDraft(s);
    if (plan.task.action !== "publish") {
      await openPost(this.page, this.binding, plan.task.target.url);
      await this.page.waitForSelector(
        ".comment-bar__comment-count,.has-no-comment",
        { timeout: 15000 },
      );
    }
    const until = Date.now() + 6000;
    do {
      const evidence = await this.verifyOnce(plan, record.baseline);
      if (evidence) return evidence;
      await new Promise((r) => setTimeout(r, 400));
    } while (Date.now() < until);
    return null;
  }
}
