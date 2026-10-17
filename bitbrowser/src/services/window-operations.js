/** Official display, fingerprint and layout helpers; no OS automation or third-party APIs. */
import { createHash } from 'node:crypto';
import { BitAPI, SkillError } from '../client/bitbrowser-api.js';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => {
  throw new SkillError(code, message);
};

/** Validate a documented display rectangle without assuming the primary monitor starts at zero. */
function rectangle(value) {
  if (
    !object(value) ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key])) ||
    value.width <= 0 ||
    value.height <= 0
  )
    fail('API_SCHEMA_CHANGED', '显示器尺寸结构无效');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, value[key]]));
}

/** Read official monitor IDs and useful geometry; discard unrelated server fields. */
export async function listDisplays({ api = new BitAPI() } = {}) {
  const data = await api.post('/alldisplays', {});
  if (!Array.isArray(data)) fail('API_SCHEMA_CHANGED', '显示器列表结构无效');
  const seen = new Set();
  return data.map((entry) => {
    if (
      !object(entry) ||
      !Number.isSafeInteger(entry.id) ||
      seen.has(entry.id) ||
      (entry.label !== undefined && typeof entry.label !== 'string')
    ) {
      fail('API_SCHEMA_CHANGED', '显示器 ID 或名称无效');
    }
    seen.add(entry.id);
    return {
      id: entry.id,
      label: entry.label ?? '',
      bounds: rectangle(entry.bounds),
      workArea: rectangle(entry.workArea),
    };
  });
}

/** Canonical JSON prevents object key order from masquerading as a configuration change. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

// Metadata is not fingerprint configuration. Never copy the returned object into a write request.
const metadata = new Set([
  'id',
  'seq',
  'browserId',
  'createTime',
  'updateTime',
  'createdTime',
  'updatedTime',
  'isDelete',
  // 7.1.5 returns UI helper/default data here: random has a version map/null accuracy,
  // while detail has null/10. Neither is a documented fingerprint setting.
  // Exclude only these observed helpers; real fingerprint differences still fail verification.
  'firefoxVersionMap',
  'defaultAccuracy',
]);
const knownFingerprintKeys = [
  'userAgent',
  'os',
  'ostype',
  'coreVersion',
  'canvas',
  'canvasValue',
  'webGL',
  'webGLValue',
  'audioContext',
  'audioContextValue',
  'computerName',
  'macAddr',
];

/** Reject window wrappers/empty payloads; retain configuration internally only for verification. */
export function fingerprintConfiguration(value) {
  if (!object(value) || !knownFingerprintKeys.some((key) => Object.hasOwn(value, key))) {
    fail('API_SCHEMA_CHANGED', '接口未返回可识别的指纹对象');
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !metadata.has(key)));
}

/** Read fingerprint configuration without exposing account or proxy fields from window detail. */
export async function readFingerprint(api, id) {
  const detail = await api.post('/browser/detail', { id });
  if (!object(detail) || detail.id !== id) fail('DETAIL_CHANGED', '指纹详情窗口 ID 不匹配');
  return fingerprintConfiguration(detail.browserFingerPrint);
}

/** Store only field names and a digest; comparison includes every field returned by random API. */
export function fingerprintProof(value, keys = Object.keys(value).sort()) {
  // Presence is separate from the value: no valid JSON value may impersonate a missing field.
  const selected = keys.map((key) => [
    key,
    Object.hasOwn(value, key),
    Object.hasOwn(value, key) ? value[key] : null,
  ]);
  return {
    keys,
    digest: createHash('sha256')
      .update(JSON.stringify(canonical(selected)))
      .digest('hex'),
  };
}

/** Validate prerequisites; flexible layout resolves explicit IDs into unambiguous official seqs. */
export async function checkLayout(request, windows, pids, api) {
  if (request.ids.some((id) => !windows.some((w) => w.id === id)))
    fail('WINDOW_NOT_FOUND', '排列目标窗口不存在');
  if (request.ids.some((id) => !(Number(pids[id]) > 0)))
    fail('WINDOW_NOT_RUNNING', '排列要求所有目标窗口已运行；不会自动启动');
  if (request.action === 'arrange-flexible') {
    const seqlist = request.ids.map((id) => windows.find((w) => w.id === id).seq);
    if (
      seqlist.some(
        (seq) =>
          !Number.isSafeInteger(seq) ||
          seq < 1 ||
          windows.filter((w) => w.seq === seq).length !== 1,
      )
    ) {
      fail('INVALID_SEQUENCE', '自适应排列需要可唯一映射的正整数窗口序号');
    }
    return { seqlist };
  }
  if (
    request.layout.screenId !== undefined &&
    !(await listDisplays({ api })).some((d) => d.id === request.layout.screenId)
  ) {
    fail('DISPLAY_NOT_FOUND', '指定显示器不存在，请重新查询显示器列表');
  }
  return { ...request.layout, ids: [...request.ids] };
}
