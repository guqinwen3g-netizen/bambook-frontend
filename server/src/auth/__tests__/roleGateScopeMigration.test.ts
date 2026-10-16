/**
 * requireRole → requirePermission 迁移（自定义角色前置第一步）
 *
 * 原 requireRole(owner/admin/manager) / (owner/admin) / (owner) 端点改按权限点放行。
 * 钉住两件事：
 *   1. 等价：新权限点在矩阵与数据迁移里恰好授予原角色组（owner=super-admin、admin=admin、
 *      manager=sales-manager），既有账号的可用范围不变；
 *   2. 解耦：放行只看当前授权里的权限点，不看内置角色名——自定义角色持码即可，
 *      仅有旧角色名而无权限点的当前授权会被拒。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { SYSTEM_ROLE_IDS, getDatabaseSeedScopeListForRole, type SystemRoleId } from '../../_shared/rolePermissionMatrix';
import { requirePermission } from '../permissionGuard';

const SRC = path.resolve(__dirname, '../..');
const holders = (scope: string) => (Object.values(SYSTEM_ROLE_IDS) as SystemRoleId[])
  .filter(roleId => getDatabaseSeedScopeListForRole(roleId).includes(scope)).sort();
const LEADERS = [SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.SALES_MANAGER, SYSTEM_ROLE_IDS.SUPER_ADMIN].sort();
const OWNER_ADMIN = [SYSTEM_ROLE_IDS.ADMIN, SYSTEM_ROLE_IDS.SUPER_ADMIN].sort();

describe('权限点授予与原角色组等价', () => {
  it.each(['business:delete', 'emails:maintenance:write', 'agent:approvals:approve'])('%s = owner/admin/manager', scope => {
    expect(holders(scope)).toEqual(LEADERS);
  });
  it.each(['users:admin', 'dictionary:write', 'settings:system:read'])('%s = owner/admin', scope => {
    expect(holders(scope)).toEqual(OWNER_ADMIN);
  });
  it('emails:admin = owner', () => {
    expect(holders('emails:admin')).toEqual([SYSTEM_ROLE_IDS.SUPER_ADMIN]);
  });
  it('数据迁移给既有库补同样的三码与三角色', () => {
    const dir = path.resolve(SRC, '../prisma/migrations/20261016090000_role_gate_permission_scopes');
    const sql = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
    for (const scope of ['business:delete', 'emails:maintenance:write', 'agent:approvals:approve']) expect(sql).toContain(`'${scope}'`);
    expect(sql).toContain("r.\"id\" IN ('role-super-admin', 'role-admin', 'role-sales-manager')");
  });
});

describe('路由不再按内置角色名放行', () => {
  const files = ['shipping/route.ts', 'orders/route.ts', 'relations/route.ts', 'email/route.ts', 'agent/route.ts',
    'admin/route.ts', 'config/systemConfigRoute.ts', 'market/marketQuoteRoute.ts'];
  it.each(files)('%s 无 requireRole( 调用', file => {
    expect(fs.readFileSync(path.join(SRC, file), 'utf8')).not.toMatch(/requireRole\(/);
  });
});

describe('requirePermission 只认当前授权里的权限点', () => {
  const app = (actor: any) => {
    const a = express();
    a.use((req: any, _res, next) => { req.actor = actor; req.authSource = 'user-session'; next(); });
    a.delete('/x', requirePermission('business:delete'), (_req, res) => { res.json({ ok: true }); });
    return a;
  };
  it('自定义角色持码 → 放行', async () => {
    const res = await request(app({ userId: 'u-custom', roles: [], permissions: ['business:delete'], authorizationLoaded: true })).delete('/x');
    expect(res.status).toBe(200);
  });
  it('仅有旧 manager 角色名、当前授权无此码 → 403', async () => {
    const res = await request(app({ userId: 'u-mgr', roles: ['manager'], permissions: ['orders:write'], authorizationLoaded: true })).delete('/x');
    expect(res.status).toBe(403);
  });
  it('API-Key 通道不足以通过删除类权限点 → 401', async () => {
    const a = express();
    a.use((req: any, _res, next) => { req.actor = { userId: 'k', roles: [], permissions: ['business:delete'], authorizationLoaded: true }; req.authSource = 'api-key'; next(); });
    a.delete('/x', requirePermission('business:delete'), (_req, res) => { res.json({ ok: true }); });
    expect((await request(a).delete('/x')).status).toBe(401);
  });
});
