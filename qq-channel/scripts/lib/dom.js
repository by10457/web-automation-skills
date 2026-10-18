/** QQ 频道：页面元素读取与恢复。 */
import { fail, route, avatarIdentity } from "./core.js";
export const selectors = {
  account: ".app-login .name",
  accountAvatar: ".app-login img",
  channel: ".my-guild-item",
  view: ".tab-bar__item",
  card: 'a.game-guild-main__short-content[href*="/post/"]',
  feedScroll: ".game-guild-main__waterfalls",
  detailScroll: ".feed-content",
  editor: '.editor-area [data-exeditor-root][contenteditable="true"]',
  composer: ".editor-area",
  publish: ".editor-area .publish-button button",
  board: ".chose-channel-btn",
  boardChoice: ".plate .choice",
  comment: ".comment-list-item",
  reply: ".comment-list-item__rely",
  input: ".bottom-input",
  like: ".bottom-right .like-container",
  file: ".editor-area input[type=file]",
  preview: ".editor-area .preview-list",
};
// 纯 DOM 读取器，也用于脱敏测试夹具；不读取应用内部状态或私有接口。
export function snapshotDOM(s) {
  const q = (root, css) => root?.querySelector(css),
    all = (root, css) => [...(root?.querySelectorAll(css) || [])];
  const t = (root, css) => q(root, css)?.textContent.trim() || null;
  const visible = (e) =>
    !!e &&
    getComputedStyle(e).display !== "none" &&
    getComputedStyle(e).visibility !== "hidden";
  function rich(el) {
    if (!el) return "";
    const walk = (n) =>
      n.nodeType === 3
        ? n.textContent
        : n.nodeType !== 1
          ? ""
          : n.matches(
                ".exeditor-placeholder-container,.ProseMirror-separator,.ProseMirror-trailingBreak",
              )
            ? ""
            : n.tagName === "BR"
              ? "\n"
              : n.tagName === "IMG"
                ? n.getAttribute("alt") || ""
                : [...n.childNodes].map(walk).join("");
    if (el.matches("[contenteditable=true]"))
      return [...el.childNodes].map(walk).join("\n");
    return walk(el).trim();
  }
  const u = new URL(location.href),
    m = /^\/g\/([^/]+)(?:\/post\/([^/]+))?\/?$/.exec(u.pathname);
  const views = all(document, s.view).map((e) => ({
    name: e.textContent.trim(),
    kind: ["全部", "热门"].includes(e.textContent.trim())
      ? "aggregate"
      : "board",
    selected: e.classList.contains("is-active"),
  }));
  const channels = all(document, s.channel).map((e) => ({
    name: e.getAttribute("title") || t(e, ".item-name"),
    avatar: q(e, "img")?.getAttribute("src") || null,
    selected: e.classList.contains("router-link-active"),
    url: e.getAttribute("href") || null,
  }));
  const editors = all(document, s.editor).map((e) => ({
    text: rich(e),
    visible: visible(e),
  }));
  const previews = all(document, s.preview).flatMap((el) =>
    all(el, "img").map((e) => ({
      src: e.getAttribute("src"),
      ready: e.complete && e.naturalWidth > 0,
    })),
  );
  const files = all(document, "input[type=file]").reduce(
    (n, e) => n + (e.files?.length || 0),
    0,
  );
  const count = t(document, ".editor-area .word-count");
  const posts = all(document, s.card).map((e) => {
    const a = new URL(e.href),
      id = /\/post\/([^/]+)/.exec(a.pathname)?.[1];
    const body = q(
      e,
      ".game-guild-main__short-content__media-detail,.game-guild-main__short-content__detail",
    );
    return {
      id,
      url: a.href,
      channelId: /\/g\/([^/]+)/.exec(a.pathname)?.[1],
      boardId: a.searchParams.get("subc"),
      author: {
        name: t(e, ".nick"),
        avatar: q(e, ".user-info img")?.getAttribute("src") || null,
      },
      publishedLabel: t(e, ".edit-time"),
      text: rich(body),
      textTruncated:
        !body ||
        all(e, "span,div").some(
          (n) => n.children.length === 0 && n.textContent.trim() === "全文",
        ),
      images: all(e, ".short-feed-image img").map(
        (i) => i.getAttribute("src") || i.getAttribute("data-src"),
      ),
    };
  });
  const comments = all(document, s.comment).map((e) => {
    const root = e.closest(".comment-list"),
      parent = all(root, s.comment).find((n) => n.id.startsWith("c_"));
    return {
      id: e.id || null,
      author: {
        name: t(e, ".comment-list-item__info__title-name"),
        avatar:
          q(e, ".comment-list-item__info__title img")?.getAttribute("src") ||
          null,
      },
      text: rich(q(e, ".comment-richcontent")),
      publishedLabel: t(e, ".comment-list-item__info__title-time"),
      isReply: e.id.startsWith("r_"),
      parentId: e.id.startsWith("r_") ? parent?.id || null : null,
      replying: t(e, ".comment-list-item__rely-count") === "回复中",
    };
  });
  const like = q(document, s.like),
    icon =
      q(like, "use")?.getAttribute("xlink:href") ||
      q(like, "use")?.getAttribute("href"),
    pressed = like?.getAttribute("aria-pressed");
  const likeLabel = t(like, ".like-text");
  // 使用明确的已赞界面状态，仅凭计数不能识别操作账号。
  const likeState =
    pressed === "true" ||
    likeLabel === "已点赞" ||
    icon?.endsWith("#like-active")
      ? "liked"
      : pressed === "false" || icon?.endsWith("#like")
        ? "unliked"
        : "unknown";
  const detailText = q(
    document,
    ".short-textcontent-container-full,.short-textcontent-container-right,.feed-content > .long-textcontent-container",
  );
  const detail = m?.[2]
    ? {
        id: m[2],
        url: u.href,
        channelId: m[1],
        boardId: u.searchParams.get("subc"),
        boardName: t(document, ".feed-info__detail__from-name"),
        author: {
          name: t(
            document,
            ".game-guild-detail-poster-userInfo .user-info__name-text",
          ),
          avatar:
            q(document, ".game-guild-detail-poster-userInfo img")?.getAttribute(
              "src",
            ) || null,
        },
        text: rich(detailText),
        publishedLabel: t(document, ".feed-info__detail__time"),
        images: all(
          document,
          ".feed-content > .short-textcontent-container-full img",
        )
          .filter((i) => i.alt !== "emoji")
          .map((i) => i.getAttribute("src")),
        like: { state: likeState, icon: icon || null, label: likeLabel },
        comments,
        commentsReady: !!q(
          document,
          ".comment-bar__comment-count,.has-no-comment",
        ),
        commentsEnd: !!q(document, ".has-no-more-comment,.has-no-comment"),
      }
    : null;
  if (detail) {
    detail.textComplete = !!detailText;
    detail.warnings = detail.textComplete
      ? []
      : ["unsupported-detail-text-layout"];
  }
  const notices = all(
    document,
    "[role=alert],.g-message,.g-toast,.g-dialog,.g-modal",
  )
    .filter(visible)
    .map((e) => e.textContent.trim());
  return {
    url: u.href,
    pageType: m ? (m[2] ? "post" : "feed") : "unsupported",
    channel: {
      id: m?.[1] || null,
      name: t(document, ".guild-name") || t(document, "h1"),
    },
    account: {
      name: t(document, s.account),
      avatar: q(document, s.accountAvatar)?.getAttribute("src") || null,
      channelName:
        editors.length &&
        t(document, ".editor-header .user-name") !== "期待你的分享..."
          ? t(document, ".editor-header .user-name")
          : null,
      channelAvatar:
        q(document, ".editor-header .user-info img")?.getAttribute("src") ||
        null,
    },
    channels,
    views,
    posts,
    detail,
    composer: {
      editors,
      files,
      previews,
      board: t(document, s.board),
      textLimit:
        count && /\/\s*(\d+)/.exec(count)
          ? Number(/\/\s*(\d+)/.exec(count)[1])
          : null,
      replyLabel: t(document, ".editor-header .placeholder-text"),
      buttonText: t(document, s.publish),
      buttonDisabled: q(document, s.publish)?.disabled ?? true,
      uploadText: all(document, s.preview)
        .map((e) => e.innerText || e.textContent)
        .join("\n"),
    },
    draft:
      editors.some((e) => e.text.trim()) || previews.length > 0 || files > 0,
    notices,
  };
}
export async function readSnapshot(page) {
  route(page.url());
  const value = await page.evaluate(snapshotDOM, selectors);
  route(value.url);
  return value;
}
export function assertContext(s, b, { channel = true } = {}) {
  route(s.url);
  if (!s.account.name || !s.account.avatar)
    fail("LOGIN_REQUIRED", "未确认登录账号");
  if (s.account.name !== b.expectedAccountName)
    fail("ACCOUNT_MISMATCH", "全局账号与绑定不符");
  if (
    b.expectedAccountAvatar &&
    avatarIdentity(s.account.avatar) !== avatarIdentity(b.expectedAccountAvatar)
  )
    fail("ACCOUNT_MISMATCH", "账号头像证据不符");
  if (
    channel &&
    (s.channel.id !== b.channelId || s.channel.name !== b.expectedChannelName)
  )
    fail("CHANNEL_MISMATCH", "实际频道与目标绑定不符");
  if (
    s.notices.some((t) =>
      /操作频繁|频繁操作|安全验证|验证码|访问受限|账号异常|禁止发言/.test(t),
    )
  )
    fail("PLATFORM_BLOCKED", "页面提示限制或验证，请人工处理");
}
export function assertNoDraft(s) {
  if (s.draft) fail("EXISTING_DRAFT", "存在草稿或附件，保留现场");
}
export async function ready(page) {
  await page.waitForSelector(".app-login .name", { timeout: 15000 });
  try {
    await page.waitForFunction(
      () =>
        !!document.querySelector(".app-login .name")?.textContent.trim() &&
        !!document.querySelector(".app-login img")?.getAttribute("src"),
      { timeout: 15000 },
    );
  } catch (e) {
    if (e.name !== "TimeoutError") throw e;
    fail("LOGIN_REQUIRED", "等待账号信息加载超时，请核对登录状态");
  }
  return readSnapshot(page);
}
export async function clickUnique(page, selector) {
  const all = await page.$$(selector);
  if (all.length !== 1)
    fail("CONTROL_NOT_UNIQUE", "控件缺失或不唯一：" + selector);
  if (!(await all[0].isVisible()))
    fail("CONTROL_HIDDEN", "控件不可见：" + selector);
  await all[0].click();
}
export async function clickText(page, selector, value) {
  const items = await page.$$(selector),
    found = [];
  for (const e of items)
    if (await e.evaluate((n, v) => n.textContent.trim() === v, value))
      found.push(e);
  if (found.length !== 1)
    fail("AMBIGUOUS_CONTROL", "控件名称不存在或不唯一：" + value);
  await found[0].click();
}
