/** Shared result envelopes, with conservative retry guidance and no raw stack traces. */
import { SkillError } from '../client/bitbrowser-api.js';

/** Convert a verified result to JSON data; retain uncertain operation details for inspection. */
export function successResult(data) {
  if (
    data?.status &&
    ['partial', 'needs-attention', 'running'].includes(data.status) &&
    data.planId
  ) {
    return {
      ok: false,
      data,
      error: {
        code: 'OPERATION_UNCERTAIN',
        message: '操作未完整验证，请核对原操作；不要新建计划重复执行',
        retryable: false,
      },
    };
  }
  return { ok: true, data };
}

/** Only known domain errors may expose messages; unexpected dependencies can contain secrets. */
export function errorResult(error) {
  const known = error instanceof SkillError;
  const code = known ? error.code : 'UNEXPECTED_ERROR';
  return {
    ok: false,
    error: {
      code,
      message: known ? error.message : '执行失败，请检查依赖、配置和操作记录',
      retryable: ['WINDOW_BUSY', 'COORDINATION_BUSY'].includes(code),
    },
  };
}
