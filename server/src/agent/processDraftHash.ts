import type { ProcessDraft } from './toolRegistry';

/** 稳定 JSON 序列化：递归排序 object keys，保证内容相同输出相同 */
function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, (key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (value as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return value;
  });
}

/**
 * 计算 ProcessDraft 的 canonical hash（idempotencyKey）。
 * 保证"审批什么就提交什么"——hash 覆盖全部六字段内容，任何字段变化都会产生不同 key。
 * 用稳定 JSON 序列化（key 排序）+ djb2 hash，避免 crypto 依赖。
 */
export function computeProcessDraftHash(draft: Omit<ProcessDraft, 'idempotencyKey'>): string {
  // 稳定序列化：深层 key 排序，保证内容相同则 hash 相同
  const canonical = stableStringify({
    subOperations: draft.subOperations,
    beforeAfterDiff: draft.beforeAfterDiff,
    impactScope: draft.impactScope,
    irreversible: draft.irreversible,
    postCommitHooks: draft.postCommitHooks,
  });
  // djb2 hash
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash) + canonical.charCodeAt(i);
    hash = hash & 0xffffffff;
  }
  return `pd:${(hash >>> 0).toString(16)}`;
}

