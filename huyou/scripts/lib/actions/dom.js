/** 狐友：页面元素读取与恢复。 */
import {
  fail,
  avatarKey,
  normalizeText,
  matchComment,
  identity,
  hash,
} from "./schema.js";
export const ui = {
  quickTrigger: ".feed-detail .detail-input__fast-comment-trigger",
  quickMenu: ".feed-detail .detail-input__fast-comment-popover",
  quickLike:
    '.feed-detail .detail-input__fast-comment-popover button[aria-label="点赞"]',
  dialog: '.modal-root[role="dialog"]',
  close: ".modal-outer__close",
  detail: ".feed-detail",
  comment: ".comment-item",
  input: ".detail-input__textarea",
  inputBox: ".detail-input__box",
  submitComment: ".detail-input__submit",
  publish: ".publish-composer",
  editor: '.publish-editor__content[contenteditable="true"]',
  publishCircle: ".publish-circle-picker__button",
  submitPost: ".publish-submit-bar__button",
  statement: ".publish-statement__entry",
  statementOption: ".statement-dropdown__item",
};
export async function accountOnPage(page) {
  return page.evaluate(() => {
    const el = document.querySelector(
      ".app-header__actions .app-header__avatar",
    );
    return { name: el?.alt || null, avatar: el?.getAttribute("src") || null };
  });
}
export async function checkAccount(page, expectedName, expectedAccount) {
  if (new URL(page.url()).origin !== "https://hy.sns.sohu.com")
    fail("WRONG_SITE", "当前页面不是狐友");
  const a = await accountOnPage(page);
  if (!a.name || a.name !== expectedName || !a.avatar)
    fail("ACCOUNT_MISMATCH", "账号未登录或昵称不匹配");
  const actual = { name: a.name, avatar: avatarKey(a.avatar) };
  if (expectedAccount && hash(actual) !== hash(expectedAccount))
    fail("ACCOUNT_CHANGED", "账号昵称或头像与计划不一致");
  return actual;
}
export async function ensureNoDraft(page) {
  const dirty = await page.evaluate(
    () =>
      [
        ...document.querySelectorAll(
          ".detail-input__textarea,.publish-editor__content",
        ),
      ].some((e) => (e.value ?? e.innerText)?.trim()) ||
      [...document.querySelectorAll("input[type=file]")].some(
        (e) => e.files?.length,
      ),
  );
  if (dirty)
    fail("EXISTING_DRAFT", "存在未提交草稿或附件，请先自行处理，工具不会覆盖");
}
export async function uniqueClick(page, selector) {
  const all = await page.$$(selector);
  if (all.length !== 1)
    fail("CONTROL_NOT_UNIQUE", `控件缺失或不唯一：${selector}`);
  if (!(await all[0].isVisible())) fail("CONTROL_HIDDEN", "目标控件不可见");
  await all[0].click();
}
export async function exactTextClick(page, selector, text) {
  const elements = await page.$$(selector);
  const matches = [];
  for (const e of elements)
    if ((await e.evaluate((el) => el.innerText.trim())) === text)
      matches.push(e);
  if (matches.length !== 1)
    fail("CONTROL_NOT_UNIQUE", `未找到唯一选项：${text}`);
  await matches[0].click();
}
export async function openDetail(page, postId) {
  if (await page.$(ui.detail)) {
    if (new URL(page.url()).searchParams.get("feedDetail") !== postId)
      fail("OTHER_DETAIL_OPEN", "已打开其他帖子，请先关闭后重试");
    return;
  }
  const card = `.feed-list > [data-feed-id="${postId}"] > .feed-card`;
  const buttons = await page.$$(`${card} .feed-footer__actions button`);
  const match = [];
  for (const b of buttons)
    if (await b.evaluate((e) => e.querySelector("img")?.alt === "评论"))
      match.push(b);
  if (match.length !== 1)
    fail(
      "POST_NOT_LOADED",
      "指定帖子未在当前列表唯一出现，请先打开相应圈子或加载该帖子",
    );
  await match[0].click();
  await page.waitForSelector(".feed-detail-content__body", {
    visible: true,
    timeout: 10000,
  });
  await page.waitForFunction(
    (id) => new URL(location.href).searchParams.get("feedDetail") === id,
    { timeout: 10000 },
    postId,
  );
}
export async function readDetail(page) {
  await page.waitForFunction(
    () => {
      const e = document.querySelector(".feed-detail-comments");
      return e && !e.innerText.includes("加载中...");
    },
    { timeout: 10000 },
  );
  return page.evaluate(() => {
    const root = document.querySelector(".feed-detail");
    const rich = (el) => {
      if (!el) return "";
      const walk = (n) =>
        n.nodeType === Node.TEXT_NODE
          ? n.textContent
          : n.nodeType === Node.ELEMENT_NODE &&
              n.matches(".feed-rich-text__emoticon")
            ? n.getAttribute("title") || ""
            : n.nodeType === Node.ELEMENT_NODE && n.tagName === "BR"
              ? "\n"
              : [...n.childNodes].map(walk).join("");
      return walk(el).trim();
    };
    const comments = [...root.querySelectorAll(".comment-item")].map(
      (el, index) => {
        const like = el.querySelector(
          '.comment-item__actions button[aria-label="评论点赞"], .comment-item__actions button[aria-label="取消评论点赞"]',
        );
        const src = like?.querySelector("img")?.getAttribute("src") || null;
        const pressed = like?.getAttribute("aria-pressed");
        const replies = el.closest(".comment-replies");
        const parent = replies?.previousElementSibling;
        return {
          index,
          id: null,
          authorName:
            el.querySelector(".comment-item__name")?.innerText.trim() || "",
          avatar:
            el.querySelector(".comment-item__avatar")?.getAttribute("src") ||
            null,
          text: rich(
            el.querySelector(".comment-item__content-text .feed-rich-text"),
          ),
          stickers: [...el.querySelectorAll(".comment-item__content img")]
            .map((e) => e.getAttribute("src"))
            .filter(Boolean),
          time: el.querySelector(".comment-item__time")?.innerText.trim() || "",
          isReply: Boolean(replies),
          parentIndex: parent
            ? [...root.querySelectorAll(".comment-item")].indexOf(parent)
            : null,
          like: {
            state:
              pressed === "true" ||
              like?.getAttribute("aria-label") === "取消评论点赞"
                ? "liked"
                : pressed === "false" || src?.endsWith("/ic_Icon_like_c@3x.png")
                  ? "unliked"
                  : "unknown",
            icon: src,
            count: Number(like?.innerText.trim() || 0),
          },
        };
      },
    );
    const fastLabel =
      root
        .querySelector(".feed-detail-comments__fast-count")
        ?.textContent.trim() || null;
    const fastMatch = /^(\d+)条表情评论\s*$/.exec(fastLabel || "");
    return {
      postId: new URL(location.href).searchParams.get("feedDetail"),
      authorName: root
        .querySelector(".feed-detail-content .feed-header__name")
        ?.innerText.trim(),
      text: rich(
        root.querySelector(".feed-detail-content__body .feed-rich-text"),
      ),
      circleName: root
        .querySelector(".feed-circle-tag__name")
        ?.innerText.trim(),
      comments,
      fastComments: {
        count: fastMatch ? Number(fastMatch[1]) : null,
        label: fastLabel,
        identityAvailable: false,
      },
    };
  });
}
export async function closeDetail(page) {
  await ensureNoDraft(page);
  if (await page.$(ui.detail)) {
    await uniqueClick(page, ui.close);
    await page.waitForSelector(ui.detail, { hidden: true, timeout: 5000 });
  }
}
export async function findCommentHandle(page, target) {
  const d = await readDetail(page);
  const c = matchComment(d.comments, target);
  const elements = await page.$$(".feed-detail .comment-item");
  const el = elements[c.index];
  if (!el) fail("COMMENT_CHANGED", "评论列表发生变化");
  return { el, comment: c, detail: d };
}
export function editableText(el) {
  if ("value" in el) return el.value;
  const blocks = [...el.children];
  if (blocks.length && blocks.every((e) => e.tagName === "P"))
    return blocks.map((e) => e.innerText.replace(/\n$/, "")).join("\n");
  return el.innerText;
}
export async function readPublish(page) {
  const result = await page.evaluate(() => ({
    circleName: document
      .querySelector(".publish-circle-picker__button")
      ?.innerText.trim(),
    board:
      document
        .querySelector(".publish-circle-picker__board--active")
        ?.textContent.trim() || null,
    hasBoards: Boolean(document.querySelector(".publish-circle-picker__board")),
    editorText:
      document.querySelector(".publish-editor__content")?.innerText.trim() ||
      "",
    statement: document
      .querySelector(".publish-statement__entry")
      ?.innerText.trim(),
    disabled: document.querySelector(".publish-submit-bar__button")?.disabled,
    hasMedia: [...document.querySelectorAll("input[type=file]")].some(
      (e) => e.files?.length,
    ),
  }));
  const editor = await page.$(ui.editor);
  if (editor) result.editorText = (await editor.evaluate(editableText)).trim();
  return result;
}
export async function openPublish(page) {
  if (!(await page.$(ui.publish))) {
    await closeDetail(page);
    await uniqueClick(page, 'a.nav-item[href="/publish"]');
    try {
      await page.waitForSelector(ui.editor, { visible: true, timeout: 5000 });
    } catch {
      // 发布路由未渲染表单时尝试一次恢复。
      // 只有不存在表单或草稿时才允许这次导航恢复。
      await ensureNoDraft(page);
      if (
        new URL(page.url()).pathname !== "/publish" ||
        (await page.$(ui.publish))
      )
        fail("PUBLISH_NOT_READY", "发布页面未就绪，未重新加载已有编辑器");
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 });
      try {
        await page.waitForSelector(ui.editor, {
          visible: true,
          timeout: 10000,
        });
      } catch {
        fail("PUBLISH_NOT_READY", "发布页面仍未就绪，请手动检查");
      }
    }
  }
}
export async function restorePage(page, originalURL) {
  await ensureNoDraft(page);
  if (originalURL === page.url()) return;
  if (
    new URL(originalURL).pathname === "/" &&
    new URL(page.url()).pathname === "/publish"
  ) {
    await uniqueClick(page, 'a.nav-item[href="/"]');
    await page.waitForSelector(".feed-list", { timeout: 10000 });
  } else if (!new URL(originalURL).searchParams.has("feedDetail"))
    await closeDetail(page);
}
export const postEvidence = (d) => ({
  postId: d.postId,
  authorName: d.authorName,
  text: d.text,
  circleName: d.circleName,
});

export const POST_LIKE_STICKER = "924708741062862848.gif";
export async function checkQuickLike(page, { open = false } = {}) {
  if (!(await page.$(ui.quickMenu)) && open)
    await uniqueClick(page, ui.quickTrigger);
  await page.waitForSelector(ui.quickMenu, { visible: true, timeout: 5000 });
  const buttons = await page.$$(ui.quickLike);
  if (buttons.length !== 1)
    fail("POST_LIKE_MISSING", "快捷评论菜单没有唯一的点赞选项");
  const info = await buttons[0].evaluate((e) => ({
    label: e.getAttribute("aria-label"),
    alt: e.querySelector("img")?.alt,
    src: e.querySelector("img")?.getAttribute("src"),
    disabled: e.disabled,
  }));
  if (
    info.disabled ||
    info.alt !== "点赞" ||
    avatarKey(info.src) !== POST_LIKE_STICKER
  )
    fail("POST_LIKE_CHANGED", "点赞表情与已确认标识不符，未提交");
  return {
    label: "点赞",
    sticker: POST_LIKE_STICKER,
    mechanism: "quick-comment-sticker",
  };
}
