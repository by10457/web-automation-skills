/** Error contracts must not turn uncertain writes into successful or retryable actions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { successResult, errorResult } from '../src/contracts/results.js';
import { SkillError } from '../src/client/bitbrowser-api.js';

test('uncertain operations retain evidence while reporting failure without retry permission', () => {
  const data = { planId: 'one', status: 'partial', items: [{ status: 'uncertain' }] };
  const result = successResult(data);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'OPERATION_UNCERTAIN');
  assert.equal(result.error.retryable, false);
  assert.equal(result.data, data);
});

test('unknown dependency errors do not leak messages or arbitrary error codes', () => {
  const error = Object.assign(Error('ws://secret-endpoint password=secret'), { code: 'INTERNAL' });
  const result = errorResult(error);
  assert.equal(result.error.code, 'UNEXPECTED_ERROR');
  assert(!JSON.stringify(result).includes('secret'));
  assert.equal(errorResult(new SkillError('WINDOW_BUSY', 'busy')).error.retryable, true);
});
