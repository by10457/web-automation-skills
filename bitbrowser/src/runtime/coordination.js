/**
 * 比特浏览器模块：src/runtime/coordination.js。普通 JavaScript ESM，无构建或压缩步骤。
 */
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { coordinationDirectory } from './paths.js';
import { serviceIdentity } from './service-identity.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SkillError } from '../client/bitbrowser-api.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A host-local gate coordinates all skill copies using the same service.
/** 跨进程分配同一服务的请求时隙；未知占用不自动删除。 */
export async function requestSlot(
  service,
  { directory = coordinationDirectory(), interval = 300, timeout = 30000 } = {},
) {
  await mkdir(directory, { recursive: true });
  const key = createHash('sha256').update(serviceIdentity(service)).digest('hex');
  const file = path.join(directory, key + '.lock'),
    stamp = path.join(directory, key + '.time');
  const deadline = Date.now() + timeout;
  let h;
  while (!h) {
    try {
      h = await open(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline)
        throw new SkillError(
          'COORDINATION_BUSY',
          '请求协调锁被占用；确认相关进程已结束后检查协调目录',
        );
      await sleep(50);
    }
  }
  try {
    await h.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    let previous = 0;
    try {
      previous = Number(await readFile(stamp, 'utf8'));
      if (!Number.isFinite(previous)) throw Error('Invalid timestamp');
    } catch (e) {
      if (e.code !== 'ENOENT') throw new SkillError('COORDINATION_INVALID', '请求协调时间记录损坏');
    }
    const wait = Math.max(0, previous + interval - Date.now());
    if (wait > timeout) throw new SkillError('COORDINATION_INVALID', '请求协调时间超出等待范围');
    if (wait) await sleep(wait);
    await writeFile(stamp, String(Date.now()));
  } finally {
    await h.close();
    await unlink(file);
  }
}

/** 在有限时间内轮询实际状态，不重试产生副作用的动作。 */
export async function waitForState(check, { timeoutMs = 15000, pollIntervalMs = 300 } = {}) {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > timeoutMs
  )
    throw new SkillError('INVALID_WAIT', '等待时间需为 1–120000 ms，轮询间隔需不大于等待时间');
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollIntervalMs, deadline - Date.now()));
  } while (true);
}
