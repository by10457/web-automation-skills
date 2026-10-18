/** 狐友：帖子查询、筛选与目标定位。 */
import { pauseBeforeOperation } from "./lib/pacing.js";
import { readSnapshot, assertContext } from "./lib/snapshot.js";
import { fail, normalizeText } from "./lib/actions/schema.js";
import { assertFeed, backToTop, loadMore } from "./navigation.js";
import {
  openDetail,
  readDetail,
  restorePage,
  ensureNoDraft,
} from "./lib/actions/dom.js";
const day = 86400000,
  offset = 8 * 3600000;
function midnight(now) {
  const d = new Date(now + offset);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - offset;
}
function calendar(y, m, d, h = 0, min = 0) {
  const n = Date.UTC(y, m - 1, d, h, min);
  const a = new Date(n);
  return a.getUTCFullYear() === y &&
    a.getUTCMonth() === m - 1 &&
    a.getUTCDate() === d &&
    h >= 0 &&
    h < 24 &&
    min >= 0 &&
    min < 60
    ? n - offset
    : null;
}
/** 将页面时间文本解析为时间戳，无法可靠识别时返回空结果。 */
export function parsePostTime(label, now = Date.now()) {
  let m, start;
  if (label === "刚刚")
    return { start: now - 60000, end: now + 1, precision: "relative" };
  if ((m = /^(\d+)(分钟|小时)前$/.exec(label || ""))) {
    const unit = m[2] === "分钟" ? 60000 : 3600000;
    return {
      start: now - (Number(m[1]) + 1) * unit,
      end: now - Number(m[1]) * unit + 1,
      precision: "relative",
    };
  }
  if ((m = /^(今天|昨天)\s+(\d{2}):(\d{2})$/.exec(label || ""))) {
    if (+m[2] > 23 || +m[3] > 59) return null;
    start =
      midnight(now) -
      (m[1] === "昨天" ? day : 0) +
      Number(m[2]) * 3600000 +
      Number(m[3]) * 60000;
  } else if (
    (m = /^(?:(\d{4})-)?(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/.exec(label || ""))
  ) {
    const year = Number(m[1] || new Date(now + offset).getUTCFullYear());
    start = calendar(year, +m[2], +m[3], +m[4], +m[5]);
    if (!m[1] && start !== null && start > now + 60000)
      start = calendar(year - 1, +m[2], +m[3], +m[4], +m[5]);
  } else return null;
  return start === null
    ? null
    : { start, end: start + 60000, precision: "minute" };
}
export function normalizeQuery(q = {}, now = Date.now()) {
  const keys = [
    "limit",
    "date",
    "since",
    "until",
    "authorName",
    "textIncludes",
    "textEquals",
    "excludeHot",
    "maxLoads",
    "timeoutMs",
    "mode",
  ];
  if (
    !q ||
    typeof q !== "object" ||
    Array.isArray(q) ||
    Object.keys(q).some((k) => !keys.includes(k))
  )
    fail("INVALID_QUERY", "查询含未知字段");
  q = {
    limit: q.mode === "range" ? 1000 : 10,
    maxLoads: 10,
    timeoutMs: 30000,
    excludeHot: true,
    mode: "count",
    ...q,
  };
  if (
    !["count", "range"].includes(q.mode) ||
    (q.mode === "range" && !q.date && !q.since)
  )
    fail("INVALID_QUERY", "range 模式需要日期或 since");
  if (
    !Number.isInteger(q.limit) ||
    q.limit < 1 ||
    q.limit > 1000 ||
    !Number.isInteger(q.maxLoads) ||
    q.maxLoads < 0 ||
    q.maxLoads > 100 ||
    !Number.isInteger(q.timeoutMs) ||
    q.timeoutMs < 1000 ||
    q.timeoutMs > 300000 ||
    typeof q.excludeHot !== "boolean"
  )
    fail("INVALID_QUERY", "查询数量、加载次数或超时无效");
  for (const k of ["authorName", "textIncludes", "textEquals"])
    if (q[k] !== undefined && (typeof q[k] !== "string" || !q[k].trim()))
      fail("INVALID_QUERY", "文本筛选需非空字符串");
  if (q.date !== undefined) {
    if (q.since !== undefined || q.until !== undefined)
      fail("INVALID_QUERY", "date 与 since/until 不能并用");
    let start;
    if (q.date === "yesterday") start = midnight(now) - day;
    else {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.date);
      if (m) start = calendar(+m[1], +m[2], +m[3]);
    }
    if (!Number.isFinite(start))
      fail("INVALID_QUERY", "date 使用 yesterday 或 YYYY-MM-DD");
    q.since = new Date(start).toISOString();
    q.until = new Date(start + day).toISOString();
  }
  for (const k of ["since", "until"])
    if (
      q[k] !== undefined &&
      (typeof q[k] !== "string" ||
        !/(Z|[+-]\d{2}:\d{2})$/.test(q[k]) ||
        !Number.isFinite(Date.parse(q[k])))
    )
      fail("INVALID_QUERY", "时间范围需带时区的 ISO 时间");
  if (q.since && q.until && Date.parse(q.since) >= Date.parse(q.until))
    fail("INVALID_QUERY", "since 必须早于 until");
  return {
    ...q,
    timeZone: "Asia/Shanghai",
    referenceTime: new Date(now).toISOString(),
  };
}
export function filterPosts(posts, q) {
  const result = [],
    warnings = [];
  const start = q.since ? Date.parse(q.since) : -Infinity,
    end = q.until ? Date.parse(q.until) : Infinity;
  for (const p of posts) {
    if (q.excludeHot && p.recommended) continue;
    if (!p.id) {
      warnings.push("missing-post-id");
      continue;
    }
    const time = parsePostTime(p.publishedLabel, Date.parse(q.referenceTime));
    if (q.since || q.until) {
      if (!time) {
        warnings.push("unknown-post-time");
        continue;
      }
      if (time.end <= start || time.start >= end) continue;
      if (time.start < start || time.end > end) {
        warnings.push("ambiguous-time-boundary");
        continue;
      }
    }
    if (q.authorName && p.author.name !== q.authorName) continue;
    if (q.textIncludes && !p.text.includes(q.textIncludes)) {
      if (p.textTruncated) warnings.push("truncated-content");
      continue;
    }
    if (
      q.textEquals &&
      (p.textTruncated || normalizeText(p.text) !== normalizeText(q.textEquals))
    ) {
      if (p.textTruncated) warnings.push("truncated-content");
      continue;
    }
    result.push({
      ...p,
      publishedTime: time
        ? {
            from: new Date(time.start).toISOString(),
            until: new Date(time.end).toISOString(),
            precision: time.precision,
          }
        : null,
    });
  }
  return { posts: result.slice(0, q.limit), warnings: [...new Set(warnings)] };
}
/** 按绑定账号与圈子查询帖子，返回扫描完整性及停止原因；调用前应选择新发排序。 */
export async function queryPosts(page, binding, query = {}, deps = {}) {
  await pauseBeforeOperation();
  const now = Date.now(),
    q = normalizeQuery(query, now),
    read = deps.read || readSnapshot,
    load = deps.load || loadMore;
  if (!deps.read) {
    await assertFeed(page);
    await backToTop(page);
  }
  const collected = new Map();
  let loads = 0,
    stopReason = "load-limit",
    filtered,
    sortReliable = true;
  let unknown = false;
  while (true) {
    const s = await read(page);
    assertContext(s, binding);
    if (s.feed.sort !== "新发")
      fail("ORDER_NOT_VERIFIED", "请先将圈子排序切换为新发");
    // 热门副本不能抢占同 ID 普通帖的插入位置，否则后续覆盖会破坏时间顺序。
    for (const p of s.posts.filter((p) => !q.excludeHot || !p.recommended))
      if (p.id) collected.set(p.id, p);
      else unknown = true;
    const posts = [...collected.values()];
    filtered = filterPosts(posts, q);
    const relevant = posts.filter((p) => !p.recommended),
      times = relevant.map((p) => parsePostTime(p.publishedLabel, now));
    if (times.some((t) => !t)) unknown = true;
    for (let i = 1; i < times.length; i++)
      if (times[i] && times[i - 1] && times[i].start > times[i - 1].end)
        sortReliable = false;
    if (filtered.posts.length >= q.limit) {
      stopReason = "limit-reached";
      break;
    }
    if (
      q.since &&
      sortReliable &&
      !unknown &&
      times.length &&
      times.at(-1).end <= Date.parse(q.since)
    ) {
      stopReason = "time-boundary";
      break;
    }
    if (loads >= q.maxLoads) break;
    if (Date.now() - now >= q.timeoutMs) {
      stopReason = "time-limit";
      break;
    }
    const remaining = q.timeoutMs - (Date.now() - now);
    if (remaining < 100) {
      stopReason = "time-limit";
      break;
    }
    const progress = await load(page, { timeoutMs: Math.min(5000, remaining) });
    loads++;
    if (!progress.progress) {
      stopReason = progress.stopReason;
      break;
    }
  }
  const warnings = [
    ...filtered.warnings,
    ...(!sortReliable ? ["non-monotonic-feed"] : []),
    ...(unknown ? ["missing-id-or-time"] : []),
  ];
  return {
    ...filtered,
    query: q,
    complete:
      (q.mode === "range"
        ? stopReason === "time-boundary"
        : ["limit-reached", "time-boundary"].includes(stopReason)) &&
      warnings.length === 0,
    stopReason:
      q.mode === "range" && stopReason === "limit-reached"
        ? "record-limit"
        : stopReason,
    loads,
    scanned: collected.size,
    warnings: [...new Set(warnings)],
    scope: "current-feed-with-bounded-loading",
    freshness: "not-refreshed",
    coverage:
      stopReason === "limit-reached" ? "requested-count" : "scanned-range",
  };
}
/** 在已读取帖子中唯一匹配目标；歧义或缺失时停止，不按位置猜选。 */
export function resolvePost(posts, { id, textEquals, authorName } = {}) {
  if (!id && !textEquals) fail("INVALID_TARGET", "需要帖子 ID 或完整正文");
  const matches = posts.filter(
    (p) =>
      (!id || p.id === id) &&
      (!textEquals ||
        (!p.textTruncated &&
          normalizeText(p.text) === normalizeText(textEquals))) &&
      (!authorName || p.author.name === authorName),
  );
  if (matches.length !== 1)
    fail(
      matches.length ? "AMBIGUOUS_POST" : "POST_NOT_FOUND",
      "没有唯一匹配帖子，请补充 ID 或作者",
    );
  return matches[0];
}
/** 读取指定帖子详情，供业务层生成内容或核对目标。 */
export async function getPost(page, postId) {
  await pauseBeforeOperation();
  if (typeof postId !== "string" || !/^\d+$/.test(postId))
    fail("INVALID_TARGET", "帖子 ID 需为数字字符串");
  await ensureNoDraft(page);
  const original = page.url();
  try {
    await openDetail(page, postId);
    return await readDetail(page);
  } finally {
    await restorePage(page, original);
  }
}
export async function locatePost(
  page,
  binding,
  postId,
  { maxLoads = 10, timeoutMs = 30000 } = {},
) {
  await pauseBeforeOperation();
  if (
    typeof postId !== "string" ||
    !/^\d+$/.test(postId) ||
    !Number.isInteger(maxLoads) ||
    maxLoads < 0 ||
    maxLoads > 100 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 300000
  )
    fail("INVALID_TARGET", "需要帖子 ID 和有效加载范围");
  await assertFeed(page);
  const start = Date.now();
  let loads = 0;
  while (true) {
    const s = await readSnapshot(page);
    assertContext(s, binding);
    const matches = s.posts.filter((p) => p.id === postId);
    if (matches.length > 1) fail("AMBIGUOUS_POST", "列表出现重复帖子 ID");
    if (matches.length === 1) return { found: true, post: matches[0], loads };
    if (loads >= maxLoads)
      return { found: false, loads, stopReason: "load-limit" };
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining < 100)
      return { found: false, loads, stopReason: "time-limit" };
    const r = await loadMore(page, { timeoutMs: Math.min(5000, remaining) });
    loads++;
    if (!r.progress) return { found: false, loads, stopReason: r.stopReason };
  }
}
export async function openPost(page, binding, postId, options) {
  await pauseBeforeOperation();
  const found = await locatePost(page, binding, postId, options);
  if (!found.found) return found;
  await openDetail(page, postId);
  return { ...found, detail: await readDetail(page) };
}
