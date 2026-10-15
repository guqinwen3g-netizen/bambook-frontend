/**
 * 工作助手委托令牌（决策总账第二十三节 · 工作助手方案第 7 节）。
 * - 由用户本人会话签发，短期（2 小时，可由本人会话续签），只给本机工作助手用；
 * - 权限上限 = 账号现有权限 ∩ 工作助手上限（首批只含读取类权限）；服务端 hasScope 已遵守 permissionCeiling；
 * - 签名密钥与登录会话分开派生，委托令牌不能当作登录会话使用，也不能再签发新的委托令牌；
 * - 委托身份只能调用工作助手读取接口（见 AGENT_ALLOWED_ROUTES），其余接口一律拒绝。
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TokenPayload } from '../auth/service';
import { MIST_READ_SECTIONS } from './access';
import { MistApiError } from './errors';

export const AGENT_DELEGATION_HEADER = 'x-bambook-delegation';
export const AGENT_DELEGATION_TTL_MS = 2 * 60 * 60 * 1000;
const PURPOSE = 'bambook-mist-agent-delegation/v1';
const MAX_TOKEN = 4096;

/** 工作助手上限（首批）：Mist 读投影所用的读取类权限；不含任何写权限，也不含助手草稿。 */
export const WORK_ASSISTANT_CEILING: readonly string[] = Object.freeze([...new Set(MIST_READ_SECTIONS.flatMap(s => s.permissions).filter(p => p.endsWith(':read')))].sort());

export type AgentActor = TokenPayload & { actorKind: 'agent'; agentSessionId: string };
export type AgentDelegationPayload = { v: 1; kind: 'mist-agent'; sub: string; sid: string; ceil: string[]; iat: number; exp: number };
export type AgentDelegationIssue = { token: string; sessionId: string; expiresAt: string; ceiling: string[] };

export function isAgentActor(actor: unknown): actor is AgentActor {
  return !!actor && typeof actor === 'object' && (actor as { actorKind?: unknown }).actorKind === 'agent';
}

function deny(message: string, status = 401, code = 'AGENT_DELEGATION_INVALID'): never { throw new MistApiError(code, message, status); }

/** 委托身份可调用的接口：只读，且只限工作区列表与工作助手读取接口。 */
const AGENT_ALLOWED_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/workspaces\/?$/],
  ['GET', /^\/workspaces\/[^/]+\/agent\/(query|objects\/[^/]+\/[^/]+(\/related)?)\/?$/],
];
export function agentRouteAllowed(method: string, path: string) {
  return AGENT_ALLOWED_ROUTES.some(([m, pattern]) => m === method.toUpperCase() && pattern.test(path));
}

export type AgentDelegationOptions = {
  /** 派生签名密钥的根密钥（服务端为 JWT 密钥；本地模式为本地会话密钥）。 */
  rootSecret: () => string | Buffer;
  /** 用签名里的账号 ID 还原执行者（之后仓储仍会在事务里重新加载真实账号与授权）。 */
  resolve: (userId: string) => Promise<TokenPayload> | TokenPayload;
  now?: () => number;
  ttlMs?: number;
};

export function createAgentDelegation(options: AgentDelegationOptions) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? AGENT_DELEGATION_TTL_MS;
  const key = () => createHmac('sha256', options.rootSecret()).update(PURPOSE).digest();
  const signature = (data: string) => createHmac('sha256', key()).update(data).digest('base64url');

  /** 签发：只接受本人会话（非委托身份）；上限再与会话自身的上限取交集。 */
  function issue(actor: TokenPayload): AgentDelegationIssue {
    if (!actor?.userId) deny('请先登录');
    if (isAgentActor(actor)) deny('工作助手不能自行续签委托，请在页面上由本人续签', 403, 'FORBIDDEN');
    const prior = actor.permissionCeiling;
    const ceil = WORK_ASSISTANT_CEILING.filter(scope => prior === undefined || prior.includes('*') || prior.includes(scope));
    const iat = now();
    const payload: AgentDelegationPayload = { v: 1, kind: 'mist-agent', sub: actor.userId, sid: randomUUID(), ceil, iat, exp: iat + ttl };
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${data}.${signature(data)}`, sessionId: payload.sid, expiresAt: new Date(payload.exp).toISOString(), ceiling: [...ceil] };
  }

  function verify(token: unknown): AgentDelegationPayload {
    if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) deny('工作助手委托无效，请在页面上重新连接');
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) deny('工作助手委托签名无效');
    const expected = signature(parts[0]);
    if (parts[1].length !== expected.length || !timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) deny('工作助手委托签名无效');
    let payload: AgentDelegationPayload;
    try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { deny('工作助手委托格式无效'); }
    if (!payload! || typeof payload! !== 'object' || Array.isArray(payload!) || payload!.v !== 1 || payload!.kind !== 'mist-agent'
      || typeof payload!.sub !== 'string' || !payload!.sub || payload!.sub.length > 300 || typeof payload!.sid !== 'string' || !payload!.sid
      || !Array.isArray(payload!.ceil) || payload!.ceil.some(scope => typeof scope !== 'string' || !WORK_ASSISTANT_CEILING.includes(scope))
      || !Number.isSafeInteger(payload!.exp) || !Number.isSafeInteger(payload!.iat) || payload!.exp <= payload!.iat
      || payload!.iat > now() + 30_000 || payload!.exp - payload!.iat > ttl) deny('工作助手委托格式无效');
    if (payload!.exp <= now()) deny('工作助手委托已过期，请在页面上续签', 401, 'AGENT_DELEGATION_EXPIRED');
    return payload!;
  }

  /** 还原委托身份：permissionCeiling 只来自签名内容，且不含 '*'。 */
  async function authenticate(token: unknown): Promise<AgentActor> {
    const payload = verify(token);
    const base = await options.resolve(payload.sub);
    if (!base?.userId || base.userId !== payload.sub) deny('工作助手委托对应的账号无效');
    return { ...base, permissionCeiling: [...payload.ceil], actorKind: 'agent', agentSessionId: payload.sid };
  }

  return { issue, verify, authenticate };
}
export type AgentDelegation = ReturnType<typeof createAgentDelegation>;
