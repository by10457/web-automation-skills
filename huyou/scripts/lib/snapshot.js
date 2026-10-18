/** 狐友：页面快照与证据提取。 */
import { createHash } from "node:crypto";
import { SkillError } from "./browser.js";
import { selectors } from "./selectors.js";

export async function readSnapshot(page) {
  if (new URL(page.url()).origin !== "https://hy.sns.sohu.com")
    throw new SkillError("WRONG_SITE", "目标标签页不是狐友");
  try {
    await page.waitForSelector(selectors.header, { timeout: 10000 });
  } catch {
    throw new SkillError("PAGE_NOT_READY", "狐友页面未就绪或结构已经变化");
  }
  const snapshot = await page.evaluate((s) => {
    const text = (root, css) =>
      root.querySelector(css)?.innerText?.trim() || null;
    const visible = (el) => Boolean(el?.getClientRects().length);
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
    const header = document.querySelector(s.header);
    const avatar = header?.querySelector(s.avatar);
    const login = [...(header?.querySelectorAll("button") || [])].some(
      (el) => visible(el) && el.innerText.trim() === "登录",
    );
    const activeCircle = text(document, s.activeCircle);
    const sidebarCircle = text(document, s.circleName);
    const cards = [...document.querySelectorAll(s.cards)].filter(visible);
    return {
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      account: {
        state: login
          ? "logged-out"
          : visible(avatar) && avatar.alt
            ? "logged-in"
            : "unknown",
        displayName: visible(avatar) ? avatar.alt : null,
        id: null,
        evidence: "header-avatar-alt",
        identityStrength: "display-name-only",
      },
      circle: {
        name: activeCircle,
        sidebarName: sidebarCircle,
        id: null,
        availableNames: [...document.querySelectorAll(s.circles)].map((el) =>
          el.innerText.trim(),
        ),
        evidence: "active-circle-button",
      },
      feed: {
        tab: text(document, s.activeTab),
        sort: text(document, s.sort),
        category: text(document, s.category),
        pinnedBannerCount: document.querySelectorAll(s.pinned).length,
        scope: "currently-loaded-dom",
        scrollPerformed: false,
      },
      posts: cards.map((card, index) => {
        const meta = text(card, s.meta);
        const body = card.querySelector(s.body);
        return {
          index,
          id: card.parentElement.getAttribute("data-feed-id") || null,
          url: null,
          author: {
            id: null,
            name: text(card, s.author),
            avatar:
              card.querySelector(s.authorAvatar)?.getAttribute("src") || null,
          },
          publishedLabel: meta?.split("·")[0].trim() || null,
          meta,
          text: rich(body),
          textTruncated:
            Boolean(card.querySelector(s.more)) ||
            Boolean(body && body.scrollHeight > body.clientHeight + 1),
          mediaCount: card.querySelectorAll(s.images).length,
          recommended: Boolean(meta?.includes("你可能错过的圈内热门")),
          // 快捷评论在帖子卡片上没有可靠的切换状态。
          likeState: "unknown",
          controls: [...card.querySelectorAll(s.actions)].map((el) => ({
            label:
              el.getAttribute("aria-label") ||
              el.querySelector("img")?.alt ||
              el.innerText.trim(),
            countText: el.innerText.trim(),
          })),
        };
      }),
    };
  }, selectors);
  if (new URL(snapshot.url).origin !== "https://hy.sns.sohu.com")
    throw new SkillError("PAGE_CHANGED", "读取期间页面发生变化");
  snapshot.posts = snapshot.posts.map((post) => ({
    ...post,
    snapshotKey: createHash("sha256")
      .update(
        JSON.stringify([
          post.author.name,
          post.author.avatar,
          post.publishedLabel,
          post.text,
        ]),
      )
      .digest("hex")
      .slice(0, 20),
  }));
  return snapshot;
}

export function assertContext(snapshot, binding) {
  if (snapshot.account.state !== "logged-in")
    throw new SkillError(
      "LOGIN_REQUIRED",
      "未确认狐友登录状态，请手动登录后重试",
    );
  if (!binding.expectedAccountName || !binding.expectedCircleName)
    throw new SkillError(
      "BINDING_INCOMPLETE",
      "预览任务必须配置预期账号昵称和圈子名称",
    );
  if (snapshot.account.displayName !== binding.expectedAccountName)
    throw new SkillError(
      "ACCOUNT_MISMATCH",
      "当前账号与绑定不一致，未生成目标计划",
    );
  if (
    snapshot.feed.tab !== "圈子" ||
    snapshot.circle.name !== binding.expectedCircleName ||
    snapshot.circle.sidebarName !== binding.expectedCircleName
  )
    throw new SkillError(
      "CIRCLE_MISMATCH",
      "当前圈子与绑定不一致，或当前页面不是受支持的圈子列表",
    );
}
