/**
 * agentPrincipal.ts — Agent 服务主体（API Key → 员工账号）
 *
 * §10.4.1 业务方定案（2026-09-12）：**把 AI 当员工看**——员工通过前端 UI 操作系统，
 * AI 通过 MCP/API 操作系统，二者只是入口不同；权限差异取决于该 AI 自己的账号与身份。
 *
 * 由此推导出的三条实现口径：
 *  1. API Key 不是「万能钥匙」，它只是某个**主体账号**的登录凭据；
 *  2. 权限来自当前 DB 的角色与有效个人 grant；当前加载后的空集是明确无授权，
 *     不从环境变量写死一串 scope；
 *  3. 一个 Key 对应一个账号，多个 AI = 多个账号（在用户管理里可见、可调角色），
 *     与真员工共用同一套 RBAC 与数据范围。
 *
 * 配置（可选，缺省 = 不启用 Agent 主体，API-Key 请求 403 AGENT_PRINCIPAL_REQUIRED）：
 *  - BAMBOOK_AGENT_API_KEY_MAP  多主体：`key1=userId1,key2=userId2`
 *  - BAMBOOK_AGENT_API_KEY_ACTOR_ID  单主体（所有 SDK key 共用该账号）
 */

import type { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { legacyAgentRoleForId, loadEffectivePermissionScopes } from './permissionService';
import { partitionApiKeys, redactKey } from './apiKeySafety';

export interface AgentPrincipalActor {
  userId: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  /** Current role and personal-grant queries completed successfully. */
  authorizationLoaded?: true;
  roleIds?: string[];
  departmentIds: string[];
}

function splitList(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 解析 key → 账号 的映射。优先多主体配置，回退单主体配置。
 * 返回空数组表示未配置（fail-closed）。
 */
export function parseAgentPrincipalBindings(): Array<{ apiKey: string; userId: string }> {
  const bindings: Array<{ apiKey: string; userId: string }> = [];
  for (const entry of splitList(process.env.BAMBOOK_AGENT_API_KEY_MAP)) {
    const idx = entry.indexOf('=');
    if (idx <= 0) {
      logger.warn('[agentPrincipal] BAMBOOK_AGENT_API_KEY_MAP 条目格式应为 key=userId，已忽略', { entry });
      continue;
    }
    bindings.push({ apiKey: entry.slice(0, idx).trim(), userId: entry.slice(idx + 1).trim() });
  }
  if (bindings.length > 0) return bindings;

  const single = String(process.env.BAMBOOK_AGENT_API_KEY_ACTOR_ID || '').trim();
  if (single) {
    // 注意：这里**不能**再把 VITE_BAMBOOK_API_KEY 当凭证来源。
    // VITE_ 前缀变量会被 Vite 内联进前端产物（详见 apiKeySafety.ts），
    // 把它绑成 Agent 主体 = 任何人下载 JS 就能拿到某个员工账号的身份。
    // 同时做一次交叉自检，挡住「BAMBOOK_API_KEY 与某个 VITE_* 同值」的装配置。
    const { accepted, rejected } = partitionApiKeys([
      process.env.BAMBOOK_SDK_KEY,
      process.env.BAMBOOK_API_KEY,
    ]);
    if (rejected.length > 0) {
      logger.error(
        '[agentPrincipal] 以下 API Key 同时出现在 VITE_* 变量中（会被内联进前端产物），'
        + `已拒绝绑定为 Agent 主体：${rejected.map(redactKey).join('、')}`,
      );
    }
    for (const key of accepted) {
      bindings.push({ apiKey: key, userId: single });
    }
  }
  return bindings;
}

/**
 * 从 DB 加载账号主体：角色 → legacy 角色码 + scope 列表 + 部门。
 * 账号不存在 / 非 active / 已软删除 → 拒绝（返回 null），绝不降级为匿名高权限。
 */
async function loadPrincipal(prisma: PrismaClient, userId: string): Promise<AgentPrincipalActor | null> {
  const account = await prisma.userAccount
    .findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        displayName: true,
        status: true,
        primaryDeptId: true,
        roles: { select: { roleId: true, departmentId: true } },
      },
    })
    .catch(() => null);
  if (!account) {
    logger.warn('[agentPrincipal] 主体账号不存在或已删除', { userId });
    return null;
  }
  if (account.status !== 'active') {
    logger.warn('[agentPrincipal] 主体账号非 active，拒绝绑定', { userId, status: account.status });
    return null;
  }

  const roleIds = (account.roles ?? []).map((r) => r.roleId);
  if (roleIds.length === 0) {
    logger.warn('[agentPrincipal] 主体账号无任何角色，拒绝绑定（最小权限）', { userId });
    return null;
  }

  let permissions: string[];
  try {
    const explicit = await prisma.rolePermission.findMany({
      where: { roleId: { in: roleIds } },
      select: { permission: { select: { scope: true } } },
    });
    permissions = await loadEffectivePermissionScopes(prisma, account.id,
      explicit.map(row => row.permission.scope));
  } catch (error) {
    // Failed DB loading must not synthesize default-role authority, especially
    // for API-key principals whose key would otherwise retain broad access.
    logger.warn('[agentPrincipal] current authorization load failed, binding refused', {
      userId, error: (error as Error).message,
    });
    return null;
  }

  const roles = Array.from(
    new Set(
      roleIds.flatMap((rid) => {
        const legacy = legacyAgentRoleForId(rid);
        return [rid, ...(legacy ? [legacy] : [])];
      }),
    ),
  );

  const departmentIds = Array.from(
    new Set(
      [
        account.primaryDeptId,
        ...(account.roles ?? []).map((r) => r.departmentId),
      ].filter(Boolean) as string[],
    ),
  );

  return {
    userId: account.id,
    displayName: account.displayName,
    roles,
    roleIds,
    permissions,
    authorizationLoaded: true,
    departmentIds: departmentIds.length ? departmentIds : ['company'],
  };
}

/**
 * 进程级默认主体映射（由 index.ts 启动装载后注入）。
 *
 * 为什么需要全局默认：25+ 个模块路由各自 `createModuleAuthGuard({ requireAuth, apiKeys })`，
 * 没有 apiKeyActors 入参通道，逐个改签名既大又易漏。凭证→主体的映射本质是**进程级配置**
 * （同 SDK_CONFIG 性质），因此下沉为模块级默认：未显式传 opts.apiKeyActors 的路由
 * 自动使用这份映射；未装载（size=0）时保持旧语义（放行但无主体）。
 */
let defaultApiKeyActors: Map<string, AgentPrincipalActor> = new Map();

export function setDefaultAgentApiKeyActors(map: Map<string, AgentPrincipalActor>): void {
  defaultApiKeyActors = map;
}

export function getDefaultAgentApiKeyActors(): ReadonlyMap<string, AgentPrincipalActor> {
  return defaultApiKeyActors;
}

/**
 * 构建/刷新 API Key → 主体 的映射。调用方持有同一个 Map 引用即可热更新
 * （守卫在请求时才查表），无需重启。
 */
export async function loadAgentApiKeyActors(
  prisma: PrismaClient,
  apiKeys: ReadonlySet<string>,
): Promise<Map<string, AgentPrincipalActor>> {
  const map = new Map<string, AgentPrincipalActor>();
  const bindings = parseAgentPrincipalBindings();
  if (bindings.length === 0) return map;

  const cache = new Map<string, AgentPrincipalActor | null>();
  for (const { apiKey, userId } of bindings) {
    if (!apiKeys.has(apiKey)) {
      logger.warn('[agentPrincipal] 映射中的 API Key 不在 SDK 白名单，已忽略', { userId });
      continue;
    }
    if (!cache.has(userId)) cache.set(userId, await loadPrincipal(prisma, userId));
    const actor = cache.get(userId) ?? null;
    if (actor) map.set(apiKey, actor);
  }
  return map;
}
