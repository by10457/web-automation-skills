/** QQ 频道：帖子查询、筛选与目标定位。 */
import { pace, fail, route, unique, text } from "./lib/core.js";
import {
  ready,
  readSnapshot,
  assertContext,
  assertNoDraft,
} from "./lib/dom.js";
import { backToTop, loadMore } from "./navigation.js";

export function parsePostTime(label, now = Date.now()) {
  let m;
  const d = new Date(now + 8 * 3600000),
    year = d.getUTCFullYear();
  if (label === "刚刚") return { start: now - 60000, end: now + 1 };
  if ((m = /^(\d+)(分钟|小时|天)前$/.exec(label || ""))) {
    const unit = { 分钟: 60000, 小时: 3600000, 天: 86400000 }[m[2]];
    return { start: now - (+m[1] + 1) * unit, end: now - +m[1] * unit + 1 };
  }
  if (
    (m = /^(?:(\d{4})-)?(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(
      label || "",
    ))
  ) {
    let y = +(m[1] || year),
      start =
        Date.UTC(y, +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - 8 * 3600000;
    if (!m[1] && start > now + 86400000) {
      y--;
      start =
        Date.UTC(y, +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - 8 * 3600000;
    }
    const check = new Date(start + 8 * 3600000);
    if (
      check.getUTCMonth() !== +m[2] - 1 ||
      check.getUTCDate() !== +m[3] ||
      +(m[4] || 0) > 23 ||
      +(m[5] || 0) > 59
    )
      return null;
    return { start, end: start + (m[4] ? 60000 : 86400000) };
  }
  return null;
}
export function normalizeQuery(input = {}) {
  const allowed = [
    "limit",
    "maxLoads",
    "timeoutMs",
    "since",
    "until",
    "date",
    "authorName",
    "textIncludes",
    "textEquals",
  ];
  if (!input || Object.keys(input).some((k) => !allowed.includes(k)))
    fail("INVALID_QUERY", "查询含未知字段");
  const q = { limit: 10, maxLoads: 20, timeoutMs: 120000, ...input };
  if (
    !Number.isInteger(q.limit) ||
    q.limit < 1 ||
    q.limit > 1000 ||
    !Number.isInteger(q.maxLoads) ||
    q.maxLoads < 0 ||
    q.maxLoads > 100 ||
    !Number.isInteger(q.timeoutMs) ||
    q.timeoutMs < 1000 ||
    q.timeoutMs > 300000
  )
    fail("INVALID_QUERY", "数量、加载次数或超时无效");
  if (q.date) {
    if (q.since || q.until || !/^\d{4}-\d{2}-\d{2}$/.test(q.date))
      fail("INVALID_QUERY", "date 为 YYYY-MM-DD，不能与 since/until 并用");
    const t = parsePostTime(q.date);
    if (!t) fail("INVALID_QUERY", "无效日期");
    q.since = new Date(t.start).toISOString();
    q.until = new Date(t.end).toISOString();
  }
  for (const k of ["since", "until"])
    if (
      q[k] &&
      (!/(Z|[+-]\d{2}:\d{2})$/.test(q[k]) || !Number.isFinite(Date.parse(q[k])))
    )
      fail("INVALID_QUERY", "时间必须带时区");
  if (q.since && q.until && Date.parse(q.since) >= Date.parse(q.until))
    fail("INVALID_QUERY", "since 必须早于 until");
  for (const k of ["authorName", "textIncludes", "textEquals"])
    if (q[k] !== undefined && (typeof q[k] !== "string" || !q[k].trim()))
      fail("INVALID_QUERY", "文本条件必须非空字符串");
  return q;
}
export function filterPosts(posts, q, now = Date.now()) {
  const warnings = new Set(),
    result = [];
  for (const p of posts) {
    if (!p.id) {
      warnings.add("missing-post-id");
      continue;
    }
    const time = parsePostTime(p.publishedLabel, now);
    if (q.since || q.until) {
      if (!time) {
        warnings.add("unknown-post-time");
        continue;
      }
      const a = q.since ? Date.parse(q.since) : -Infinity,
        b = q.until ? Date.parse(q.until) : Infinity;
      if (time.end <= a || time.start >= b) continue;
      if (time.start < a || time.end > b) {
        warnings.add("ambiguous-time-boundary");
        continue;
      }
    }
    if (q.authorName && p.author.name !== q.authorName) continue;
    if (
      q.textEquals &&
      (p.textTruncated || text(p.text) !== text(q.textEquals))
    ) {
      if (p.textTruncated) warnings.add("truncated-content");
      continue;
    }
    if (q.textIncludes && !p.text.includes(q.textIncludes)) {
      if (p.textTruncated) warnings.add("truncated-content");
      continue;
    }
    result.push({ ...p, publishedTime: time });
  }
  return { posts: result.slice(0, q.limit), warnings: [...warnings] };
}
export async function queryPosts(page, binding, query = {}, deps = {}) {
  await pace();
  const q = normalizeQuery(query),
    read = deps.read || readSnapshot,
    load = deps.load || loadMore,
    now = Date.now();
  if (!deps.read) await backToTop(page, binding);
  const seen = new Map();
  let loads = 0,
    stopReason = "load-limit",
    initialView,
    filtered;
  while (true) {
    const s = await read(page);
    assertContext(s, binding);
    if (s.pageType !== "feed") fail("FEED_REQUIRED", "需要论坛列表");
    const selected = s.views.find((v) => v.selected)?.name;
    if (!selected) fail("VIEW_UNKNOWN", "无法确认选中视图");
    initialView ??= selected;
    if (initialView !== selected) fail("VIEW_CHANGED", "扫描期间视图变化");
    for (const p of s.posts) if (p.id) seen.set(p.id, p);
    filtered = filterPosts([...seen.values()], q, now);
    if (filtered.posts.length >= q.limit) {
      stopReason = q.since || q.until ? "record-limit" : "requested-count";
      break;
    }
    if (loads >= q.maxLoads) break;
    if (Date.now() - now >= q.timeoutMs) {
      stopReason = "time-limit";
      break;
    }
    const progress = await load(page, binding, {
      timeoutMs: Math.max(
        100,
        Math.min(8000, q.timeoutMs - (Date.now() - now)),
      ),
    });
    loads++;
    if (!progress.progress) {
      stopReason = progress.stopReason;
      break;
    }
  }
  return {
    ...filtered,
    complete: stopReason === "requested-count" && !filtered.warnings.length,
    stopReason,
    loads,
    scanned: seen.size,
    view: initialView,
    scope: "bounded-visible-feed",
    ordering:
      initialView === "热门" ? "ranked-not-chronological" : "not-guaranteed",
    freshness: "not-refreshed",
  };
}
export function resolvePost(posts, target) {
  if (!target?.id && !target?.textEquals)
    fail("INVALID_TARGET", "需要帖子 ID 或完整正文");
  return unique(
    posts,
    (p) =>
      (!target.id || p.id === target.id) &&
      (!target.textEquals ||
        (!p.textTruncated && text(p.text) === text(target.textEquals))) &&
      (!target.authorName || p.author.name === target.authorName),
    "帖子",
  );
}
export async function openPost(page, binding, url) {
  await pace();
  const s = await ready(page);
  assertContext(s, binding);
  assertNoDraft(s);
  const r = route(url);
  if (!r.postId || r.channelId !== binding.channelId)
    fail("INVALID_TARGET", "详情网址须属于绑定频道");
  if (page.url() !== r.url)
    await page.goto(r.url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(
    ".game-guild-detail-poster-userInfo .user-info__name-text",
    { timeout: 15000 },
  );
  const after = await ready(page);
  assertContext(after, binding);
  if (after.detail?.id !== r.postId) fail("POST_CHANGED", "详情目标不符");
  return after.detail;
}
export async function getPost(page, binding, url) {
  return openPost(page, binding, url);
}
