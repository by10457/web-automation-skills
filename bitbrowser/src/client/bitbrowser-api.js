/**
 * 比特本地 HTTP API 客户端：地址约束、跨进程限频、响应契约和可预测的错误。
 * 此层不依赖 Puppeteer 或 MCP，所有写请求均只发送一次。
 */
import { requestSlot } from '../runtime/coordination.js';
/** 可对外展示的领域错误；message 不应包含原始服务响应或凭据。 */
export class SkillError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 校验仅允许本机端点，拒绝远程地址、凭据和不支持的协议。 */
export function localURL(value, protocols = ['http:']) {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new SkillError('NON_LOCAL_ENDPOINT', '仅允许本机浏览器服务地址');
  }
  return url;
}

/** 官方本地 API 读取与连接客户端，可注入 fetch 实现用于契约测试。 */
export class BitAPI {
  /** @param {string} base 本机 HTTP origin；默认使用 BITBROWSER_API_URL。 */
  constructor(
    base = process.env.BITBROWSER_API_URL || 'http://127.0.0.1:54345',
    fetcher = fetch,
    { coordinate = true } = {},
  ) {
    const endpoint = localURL(base);
    if (endpoint.hostname === 'localhost') endpoint.hostname = '127.0.0.1';
    this.base = endpoint.origin;
    this.fetcher = fetcher;
    this.coordinate = coordinate;
  }
  /**
   * 发送 JSON POST，并检查 HTTP 与业务两层结果。
   * @param {string} path 白名单中的 API 路径。
   * @param {object} body 官方参数对象。
   * @param {number} attempt 内部限频重试计数；调用方不应手动设置。
   * @returns {Promise<unknown>} success 响应的 data；health 可没有 data。
   */
  async post(path, body = {}, attempt = 0) {
    if (
      !(
        this.paths || [
          '/health',
          '/browser/list',
          '/browser/pids/all',
          '/browser/open',
          '/alldisplays',
        ]
      ).includes(path)
    ) {
      throw new SkillError('UNSUPPORTED_API', '未提供该接口');
    }
    const delay = Math.max(0, (this.nextRequestAt || 0) - Date.now());
    this.nextRequestAt = Date.now() + delay + 250;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.coordinate) await requestSlot(this.base);
    let response;
    try {
      response = await this.fetcher(this.base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new SkillError(
        'API_UNAVAILABLE',
        '比特本地服务不可用或请求超时，请检查软件和本地服务设置',
      );
    }
    if (response.status === 429) return this.rateLimited(path, body, attempt);
    if (!response.ok)
      throw new SkillError('API_HTTP_ERROR', `本地接口返回 HTTP ${response.status}`);
    let result;
    try {
      result = await response.json();
    } catch {
      throw new SkillError('API_SCHEMA_CHANGED', '本地接口未返回有效 JSON');
    }
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      typeof result.success !== 'boolean'
    ) {
      throw new SkillError('API_SCHEMA_CHANGED', '本地接口响应缺少 success 布尔字段');
    }
    if (result.success !== true) {
      const message = String(result.msg || result.message || '');
      if (/请求频繁|too many requests|rate.?limit/i.test(message)) {
        return this.rateLimited(path, body, attempt);
      }
      // Client 7.1.5 refuses launches above its memory threshold. This is not account quota.
      if (/内存.*(?:超出|不足|过高)|out of memory|insufficient memory/i.test(message)) {
        throw new SkillError(
          'RESOURCE_EXHAUSTED',
          '比特因系统内存不足或使用率过高拒绝请求；释放内存后重新核对状态，不自动重试',
        );
      }
      const code = /权限|permission|forbidden/i.test(message)
        ? 'PERMISSION_DENIED'
        : /额度|上限|套餐|数量不足|quota|limit/i.test(message)
          ? 'QUOTA_EXCEEDED'
          : 'API_REJECTED';
      throw new SkillError(code, `比特接口拒绝请求：${path}；请检查客户端权限、额度和参数`);
    }
    return result.data;
  }
  /** Retry only explicitly read-only operations; a failed write may already have happened. */
  async rateLimited(path, body, attempt) {
    if (
      ['/health', '/browser/list', '/browser/pids/all', '/browser/detail', '/alldisplays'].includes(
        path,
      ) &&
      attempt < 3
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      return this.post(path, body, attempt + 1);
    }
    throw new SkillError(
      'RATE_LIMITED',
      '本地接口请求过于频繁，请降低调用频率；写入操作不会自动重试',
    );
  }
  /** Paginate inventory, rejecting missing/duplicate identities before exposing results. */
  async list() {
    const output = [];
    const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const data = await this.post('/browser/list', { page, pageSize: 100 });
      if (!Array.isArray(data?.list))
        throw new SkillError('API_SCHEMA_CHANGED', '窗口列表结构发生变化');
      for (const item of data.list) {
        if (
          !item ||
          typeof item.id !== 'string' ||
          !item.id ||
          seen.has(item.id) ||
          (item.name !== undefined && typeof item.name !== 'string')
        ) {
          throw new SkillError('API_SCHEMA_CHANGED', '窗口列表缺少有效 ID 或包含重复 ID');
        }
        seen.add(item.id);
      }
      output.push(...data.list.map(({ id, name, seq }) => ({ id, name, seq })));
      if (data.list.length < 100) return output;
    }
    throw new SkillError('LIST_LIMIT', '窗口列表超出本工具的分页上限');
  }
  /** 获取仍存活窗口的 ID → 正整数 PID 映射；缺项表示未运行。 */
  async running() {
    const data = await this.post('/browser/pids/all');
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new SkillError('API_SCHEMA_CHANGED', '运行窗口结构发生变化');
    if (Object.values(data).some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
      throw new SkillError('API_SCHEMA_CHANGED', '运行窗口 PID 必须为正整数');
    }
    return data;
  }
}

/** 按唯一 ID 或名称解析窗口；歧义时停止，不猜测账号。 */
export function resolveWindow(windows, { id, name } = {}) {
  if (Boolean(id) === Boolean(name))
    throw new SkillError('INVALID_WINDOW_SELECTOR', '请提供唯一的 --id 或 --name');
  const matches = windows.filter((w) => (id ? w.id === id : w.name === name));
  if (matches.length !== 1)
    throw new SkillError(
      matches.length ? 'AMBIGUOUS_WINDOW' : 'WINDOW_NOT_FOUND',
      '窗口不存在或名称不唯一，请使用真实窗口 ID',
    );
  return matches[0];
}
