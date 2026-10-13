import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  loadAgentApiKeyActors,
  parseAgentPrincipalBindings,
} from '../agentPrincipal';
import { getDefaultScopeListForRole, SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';

/**
 * §10.4.1 定案：AI = 员工。API Key 只是某个主体账号的凭据，权限一律来自该账号的角色，
 * 不从环境变量写死 scope。账号不可用（不存在/非 active/无角色）时必须拒绝绑定，
 * 绝不降级为匿名高权限。
 */

const ENV_KEYS = [
  'BAMBOOK_AGENT_API_KEY_MAP',
  'BAMBOOK_AGENT_API_KEY_ACTOR_ID',
  'BAMBOOK_SDK_KEY',
  'BAMBOOK_API_KEY',
  'VITE_BAMBOOK_API_KEY',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('parseAgentPrincipalBindings', () => {
  it('未配置 → 空（fail-closed，不启用 Agent 主体）', () => {
    expect(parseAgentPrincipalBindings()).toEqual([]);
  });

  it('MAP 多主体：key=userId 逐对解析（多个 AI 各自身份）', () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_agent_1,key-b=usr_agent_2';
    expect(parseAgentPrincipalBindings()).toEqual([
      { apiKey: 'key-a', userId: 'usr_agent_1' },
      { apiKey: 'key-b', userId: 'usr_agent_2' },
    ]);
  });

  it('单主体回退：ACTOR_ID 应用到全部 SDK key', () => {
    process.env.BAMBOOK_AGENT_API_KEY_ACTOR_ID = 'usr_agent_1';
    process.env.BAMBOOK_SDK_KEY = 'sdk-1';
    process.env.BAMBOOK_API_KEY = 'sdk-2';
    // 注意：此处刻意不再把 VITE_BAMBOOK_API_KEY 设为 'sdk-2'。
    // 旧断言正是这么写的（期望同值仍被接受）——那编码的是漏洞本身，已随修复一并纠正。
    expect(parseAgentPrincipalBindings()).toEqual([
      { apiKey: 'sdk-1', userId: 'usr_agent_1' },
      { apiKey: 'sdk-2', userId: 'usr_agent_1' },
    ]);
  });

  it('VITE_ 变量不再作为凭证来源（会被 Vite 内联进前端产物）', () => {
    // 只配 VITE_BAMBOOK_API_KEY：它按定义是公开值，绝不能绑定成某个员工账号的身份
    process.env.BAMBOOK_AGENT_API_KEY_ACTOR_ID = 'usr_agent_1';
    process.env.VITE_BAMBOOK_API_KEY = 'public-key';
    expect(parseAgentPrincipalBindings()).toEqual([]);
  });

  it('BAMBOOK_API_KEY 与 VITE_* 同值 → 该 key 被拒绝绑定（fail-closed）', () => {
    process.env.BAMBOOK_AGENT_API_KEY_ACTOR_ID = 'usr_agent_1';
    process.env.BAMBOOK_API_KEY = 'same-value';
    process.env.VITE_BAMBOOK_API_KEY = 'same-value';
    expect(parseAgentPrincipalBindings()).toEqual([]);
  });

  it('MAP 里的畸形条目被忽略而非整体失败', () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'bad-entry,key-a=usr_agent_1';
    expect(parseAgentPrincipalBindings()).toEqual([{ apiKey: 'key-a', userId: 'usr_agent_1' }]);
  });
});

function makePrisma(account: any, rolePermissions: Array<{ permission: { scope: string } }> = []) {
  return {
    userAccount: { findFirst: vi.fn().mockResolvedValue(account) },
    rolePermission: { findMany: vi.fn().mockResolvedValue(rolePermissions) },
    userPermissionOverrides: { findMany: vi.fn().mockResolvedValue([]) },
  } as any;
}

describe('loadAgentApiKeyActors', () => {
  const apiKeys = new Set(['key-a']);

  it('账号不存在 → 不绑定（不降级为匿名）', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_ghost';
    const map = await loadAgentApiKeyActors(makePrisma(null), apiKeys);
    expect(map.size).toBe(0);
  });

  it('账号非 active → 不绑定', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_x';
    const map = await loadAgentApiKeyActors(
      makePrisma({ id: 'usr_x', displayName: 'X', status: 'disabled', primaryDeptId: null, roles: [{ roleId: 'role-sales', departmentId: null }] }),
      apiKeys,
    );
    expect(map.size).toBe(0);
  });

  it('账号无角色 → 不绑定（最小权限）', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_x';
    const map = await loadAgentApiKeyActors(
      makePrisma({ id: 'usr_x', displayName: 'X', status: 'active', primaryDeptId: null, roles: [] }),
      apiKeys,
    );
    expect(map.size).toBe(0);
  });

  it('已配置权限正常主体：角色 → legacy 角色码 + 当前 DB 明示权限 + 部门', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_sales_bot';
    const prisma = makePrisma({
      id: 'usr_sales_bot',
      displayName: 'AI 跟单助手',
      status: 'active',
      primaryDeptId: 'dept-sales',
      roles: [{ roleId: SYSTEM_ROLE_IDS.SALES, departmentId: null }],
    }, [{ permission: { scope: 'orders:read' } }]);
    const map = await loadAgentApiKeyActors(prisma, apiKeys);
    const actor = map.get('key-a');
    expect(actor).toBeDefined();
    expect(actor!.userId).toBe('usr_sales_bot');
    expect(actor!.displayName).toBe('AI 跟单助手');
    expect(actor!.roles).toContain('role-sales');
    expect(actor!.roles).toContain('sales'); // legacy 码，供 hasScope fallback
    expect(actor!.permissions).toContain('orders:read'); // §10.7 O-2：Agent 也得有读权限才不被挡
    expect(actor!.departmentIds).toContain('dept-sales');
    expect(actor!.authorizationLoaded).toBe(true);
  });

  it('DB 明示授权优先于默认矩阵', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_bot';
    const prisma = makePrisma(
      { id: 'usr_bot', displayName: 'bot', status: 'active', primaryDeptId: null, roles: [{ roleId: SYSTEM_ROLE_IDS.QC, departmentId: null }] },
      [{ permission: { scope: 'qc:write' } }],
    );
    const map = await loadAgentApiKeyActors(prisma, apiKeys);
    expect(map.get('key-a')!.permissions).toEqual(['qc:write']);
    expect(getDefaultScopeListForRole(SYSTEM_ROLE_IDS.QC)).not.toEqual(['qc:write']);
  });

  it('当前 DB 加载的空权限保持空集，不回退角色默认矩阵', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_empty';
    const prisma = makePrisma({ id: 'usr_empty', displayName: 'empty', status: 'active',
      primaryDeptId: null, roles: [{ roleId: SYSTEM_ROLE_IDS.SALES, departmentId: null }] });
    const map = await loadAgentApiKeyActors(prisma, apiKeys);
    expect(map.get('key-a')).toMatchObject({ permissions: [], authorizationLoaded: true });
    expect(map.get('key-a')!.permissions).not.toContain('orders:read');
  });

  it('个人有效 grant 与自定义角色明示权限共用当前 DB 聚合', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_custom';
    const prisma = makePrisma({ id: 'usr_custom', displayName: 'custom', status: 'active',
      primaryDeptId: null, roles: [{ roleId: 'role-custom-acceptance', departmentId: null }] },
    [{ permission: { scope: 'orders:read' } }]);
    prisma.userPermissionOverrides.findMany.mockResolvedValue([{ scope: 'sensitive:salary' }, { scope: 'hr:salary:read' }]);
    const map = await loadAgentApiKeyActors(prisma, apiKeys);
    expect(map.get('key-a')).toMatchObject({ roleIds: ['role-custom-acceptance'],
      permissions: ['hr:salary:read', 'orders:read', 'sensitive:salary'], authorizationLoaded: true });
    expect(prisma.userPermissionOverrides.findMany).toHaveBeenCalledWith({ where: {
      userId: 'usr_custom', isActive: true, deletedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    }, select: { scope: true } });
  });

  it.each(['role', 'personal-grant'] as const)('%s 权限查询失败时不绑定 API Key，也不回退默认矩阵', async phase => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'key-a=usr_fault';
    const prisma = makePrisma({ id: 'usr_fault', displayName: 'fault', status: 'active',
      primaryDeptId: null, roles: [{ roleId: SYSTEM_ROLE_IDS.SALES, departmentId: null }] },
    [{ permission: { scope: 'orders:read' } }]);
    if (phase === 'role') prisma.rolePermission.findMany.mockRejectedValue(new Error('synthetic role-read failure'));
    else prisma.userPermissionOverrides.findMany.mockRejectedValue(new Error('synthetic grant-read failure'));
    const map = await loadAgentApiKeyActors(prisma, apiKeys);
    expect(map.size).toBe(0);
  });

  it('Key 不在 SDK 白名单 → 忽略（防止凭空造主体）', async () => {
    process.env.BAMBOOK_AGENT_API_KEY_MAP = 'rogue-key=usr_bot';
    const prisma = makePrisma({
      id: 'usr_bot',
      displayName: 'bot',
      status: 'active',
      primaryDeptId: null,
      roles: [{ roleId: SYSTEM_ROLE_IDS.SALES, departmentId: null }],
    });
    const map = await loadAgentApiKeyActors(prisma, apiKeys);
    expect(map.size).toBe(0);
    expect(prisma.userAccount.findFirst).not.toHaveBeenCalled();
  });
});
