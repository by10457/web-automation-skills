/** Local plan persistence. Callers use opaque UUIDs, never paths or arbitrary plan bodies. */
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SkillError } from '../client/bitbrowser-api.js';

/** Store plans beneath a configured state root. This is integrity storage, not authorization. */
export class PlanStore {
  constructor(directory) {
    this.directory = path.resolve(directory, 'plans');
  }

  /** Resolve a validated opaque ID; prevent path traversal at the storage boundary. */
  file(id) {
    if (
      typeof id !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    ) {
      throw new SkillError('INVALID_PLAN', '需要有效的计划 ID');
    }
    return path.join(this.directory, id + '.json');
  }

  /** Exclusive creation prevents overwriting an existing plan; flush before returning its ID. */
  async save(plan) {
    const file = this.file(plan.id);
    await mkdir(this.directory, { recursive: true });
    const handle = await open(file, 'wx');
    try {
      await handle.writeFile(JSON.stringify(plan, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Read the original plan. Shared execution still verifies digest, service and expiry. */
  async load(id) {
    const file = this.file(id);
    try {
      const plan = JSON.parse(await readFile(file, 'utf8'));
      if (plan?.id !== id) throw new SkillError('INVALID_PLAN', '计划 ID 与记录不一致');
      return plan;
    } catch (error) {
      if (error instanceof SkillError) throw error;
      throw new SkillError(
        error.code === 'ENOENT' ? 'PLAN_NOT_FOUND' : 'RECORD_UNREADABLE',
        '无法读取原计划，请核对 planId 与状态目录',
      );
    }
  }
}
