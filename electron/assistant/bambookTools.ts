/**
 * 工作助手 P1 业务读工具。只向主进程绑定的同源 Mist API 发送短期委托头；
 * 不接受模型给出的 URL / 工作区 / 令牌，不使用本人 Cookie，不跟随重定向。
 */
import { AssistantError, type FetchLike } from './types';
import type { ToolDefinition } from './tools';

export type BambookDelegation = { token: string; expiresAt: string; workspaceId: string; apiBase: string };
export type DelegationReason = 'missing' | 'expired' | 'rejected';

export const BAMBOOK_OBJECT_TYPES = [
  'customer', 'contact', 'order', 'order_line', 'development', 'dev_version', 'product', 'sample',
  'quotation', 'supplier', 'purchase', 'production', 'shipment', 'invoice', 'risk', 'claim',
] as const;

const typeSchema = { type: 'string', enum: [...BAMBOOK_OBJECT_TYPES], description: '业务对象类型；以服务端实际允许的可读类型为准。' };
const idSchema = { type: 'string', minLength: 1, maxLength: 200, description: '查询结果返回的对象 id，也可用准确编号。' };
const invalid = (message: string): never => { throw new AssistantError('INVALID_ARGUMENTS', message); };
function objectType(value: unknown): string {
  if (typeof value !== 'string' || !BAMBOOK_OBJECT_TYPES.includes(value as any)) invalid('不支持的业务对象类型，请用 bambook_query 查询可读类型');
  return value as string;
}
function objectId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid('对象 id 须为 1–200 字符的准确编号');
  return value as string;
}

/** 主进程固定 apiBase 后，host 再校验一遍形状；委托只保存在 Account 内存，不落盘。 */
export function normalizeDelegation(input: any, now: Date): BambookDelegation {
  if (!input || typeof input.token !== 'string' || !input.token || input.token.length > 4096 || /\s/.test(input.token)
    || typeof input.workspaceId !== 'string' || !input.workspaceId.trim() || input.workspaceId.length > 200
    || typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new AssistantError('DELEGATION_INVALID', '工作助手业务授权无效，请重新连接');
  }
  if (Date.parse(input.expiresAt) <= now.getTime()) throw new AssistantError('DELEGATION_EXPIRED', '工作助手业务授权已过期，请重新连接');
  let base: URL;
  try { base = new URL(input.apiBase); } catch { throw new AssistantError('DELEGATION_ORIGIN_INVALID', '业务授权来源无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new AssistantError('DELEGATION_ORIGIN_INVALID', '业务授权只接受当前应用的 HTTP(S) 来源');
  }
  return { token: input.token, workspaceId: input.workspaceId, expiresAt: new Date(input.expiresAt).toISOString(), apiBase: base.origin };
}

export function bambookTools(options: {
  fetch: FetchLike;
  delegation: () => BambookDelegation | null;
  needed: (reason: DelegationReason) => void;
}): ToolDefinition[] {
  const request = async (tail: string, signal: AbortSignal, now: Date) => {
    const d = options.delegation();
    if (!d || Date.parse(d.expiresAt) <= now.getTime()) {
      const reason = d ? 'expired' : 'missing';
      options.needed(reason);
      throw new AssistantError('DELEGATION_NEEDED', '工作助手业务授权缺失或已过期，已通知页面重新连接；请等页面连接完成后重试，不要改用本人会话。');
    }
    const response = await options.fetch(`${d.apiBase}/api/mist/workspaces/${encodeURIComponent(d.workspaceId)}/agent/${tail}`, {
      method: 'GET', headers: { 'x-bambook-delegation': d.token, Accept: 'application/json' },
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
    });
    if (response.status === 401) {
      options.needed('rejected');
      throw new AssistantError('DELEGATION_NEEDED', '工作助手业务授权已失效，已通知页面重新连接；请等连接完成后重试。');
    }
    // 不将原始错误正文（可能是代理页面）回填给模型，也不在事件里泄露委托令牌。
    if (!response.ok) {
      if (response.status === 403) throw new AssistantError('FORBIDDEN', '当前账号无权读取此类业务数据；不要换类型或接口绕过。');
      if (response.status === 404) throw new AssistantError('NOT_FOUND', '业务对象或工作区不存在，或当前账号不可见。');
      throw new AssistantError('BAMBOOK_READ_FAILED', `业务读取未完成（HTTP ${response.status}），请稍后重试。`);
    }
    const text = await response.text();
    if (text.length > 100_000) throw new AssistantError('BAMBOOK_RESULT_TOO_LARGE', '业务结果过大，请缩小查询范围。');
    let body: any;
    try { body = JSON.parse(text); } catch { throw new AssistantError('BAMBOOK_RESULT_INVALID', '业务接口没有返回可核对的结果。'); }
    if (!body || body.workspace?.id !== d.workspaceId || !Number.isSafeInteger(body.workspace?.revision)
      || (!Array.isArray(body.results) && (!body.object || typeof body.object !== 'object'))) {
      throw new AssistantError('BAMBOOK_RESULT_INVALID', '业务结果的工作区或格式不符，请重新连接后重试。');
    }
    return body;
  };
  const common = { risk: 'read' as const, confirm: 'never' as const, timeoutMs: 20_000 };
  const details = { type: 'object', properties: { type: typeSchema, id: idSchema }, required: ['type', 'id'], additionalProperties: false };
  return [
    {
      ...common, name: 'bambook_query',
      description: '在当前工作区按本人权限查询业务对象。可用 type 限定类型，q 按编号/名称/摘要搜索，limit 默认 10、最多 20。省略 type 可查询当前全部可读类型；无权限会明确拒绝。返回 id、摘要、原样引用的 link、工作区版本，结果截短时请缩小范围。',
      parameters: { type: 'object', properties: { type: typeSchema, q: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false },
      run: async (args, ctx) => {
        const query = new URLSearchParams();
        if (args.type !== undefined) query.set('type', objectType(args.type));
        if (args.q !== undefined) {
          if (typeof args.q !== 'string' || args.q.length > 200) invalid('q 须为不超过 200 字的查询文字');
          query.set('q', args.q as string);
        }
        if (args.limit !== undefined) {
          if (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 20) invalid('limit 须为 1–20 的整数');
          query.set('limit', String(args.limit));
        }
        return request(`query?${query}`, ctx.signal, ctx.now());
      },
    },
    {
      ...common, name: 'bambook_get',
      description: '按 type 和准确 id/编号读取单个业务对象的详情。先 query 获取 id；大字段截短、图片和附件内容不返回。引用时原样使用返回的 link。',
      parameters: details,
      run: async (args, ctx) => request(`objects/${objectType(args.type)}/${encodeURIComponent(objectId(args.id))}`, ctx.signal, ctx.now()),
    },
    {
      ...common, name: 'bambook_expand',
      description: '展开对象的直接关联（它引用的对象 / 引用了它的对象），只返回当前账号可读且可见的对象，最多 30 项；需要详情再用 bambook_get。',
      parameters: details,
      run: async (args, ctx) => request(`objects/${objectType(args.type)}/${encodeURIComponent(objectId(args.id))}/related`, ctx.signal, ctx.now()),
    },
  ];
}