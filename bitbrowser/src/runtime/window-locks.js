/** Host-wide window locks, shared by management operations and browser callbacks. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SkillError } from '../client/bitbrowser-api.js';
import { coordinationDirectory } from './paths.js';
import { serviceIdentity } from './service-identity.js';

const context = new AsyncLocalStorage();

/**
 * Lock windows in a deterministic order across processes and workspaces.
 * A nested withBrowser call inside a management action reuses its enclosing lock.
 * Injected APIs without a service identity do not participate in host coordination.
 * @param {string|null} service Canonical service origin from BitAPI.base.
 * @param {string[]} ids Real window IDs, or the internal creation lock key.
 * @param {Function} action Operation to execute while holding the locks.
 */
export async function withWindowLocks(service, ids, action) {
  if (!service) return action();
  // Copy ancestor ownership: a child's newly acquired locks must not reach siblings.
  // Shared lease objects also invalidate ownership inherited by detached async work.
  const scope = new Map(context.getStore() || []);
  const directory = path.join(coordinationDirectory(), 'windows');
  await mkdir(directory, { recursive: true });
  const keys = [...new Set(ids)].sort().map((id) =>
    createHash('sha256')
      .update(JSON.stringify([serviceIdentity(service), id]))
      .digest('hex'),
  );

  async function acquire(index) {
    if (index === keys.length) return action();
    const key = keys[index];
    if (scope.get(key)?.active) return acquire(index + 1);
    const file = path.join(directory, key + '.lock');
    let handle;
    try {
      handle = await open(file, 'wx');
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new SkillError('WINDOW_BUSY', '目标窗口正在被其他操作占用；请先等待或核对原操作');
      throw error;
    }
    const lease = { active: true };
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      scope.set(key, lease);
      return await acquire(index + 1);
    } finally {
      lease.active = false;
      scope.delete(key);
      await handle.close();
      await unlink(file);
    }
  }
  return context.run(scope, () => acquire(0));
}
