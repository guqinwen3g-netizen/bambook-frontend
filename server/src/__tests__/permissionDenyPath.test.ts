/**
 * permissionDenyPath.test.ts — W-C 批三-C 交付物 2：路由层「低权限角色必须 403」反向断言
 *
 * 背景：既有测试 helper（authTestHelper）默认 owner 身份，只覆盖放行路径。
 * 本套件补齐反向断言：7 系统角色经 ROLE_ID_TO_LEGACY_AGENT_ROLE 映射 legacy +
 * getDefaultScopeListForRole 计算默认 scope 集，按生产登录链路同款结构签 JWT
 * （roles[]=legacy codes，permissions[]=默认 scopes），打真实 router + mock prisma：
 *   - legacy requireRole 门（finance v1 / orders v1 的 HIGH_RISK_ROLES）
 *   - scope requirePermission 门（pricing / audit / finance v2 系）
 *
 * 断言保持「正确期望」：失败 = 走查发现的真实门禁缺口（红清单见运行输出），
 * 不为了让测试绿而改期望；修复被测实现不在本文件租约内。
 *
 * 模式参考 authGuardSecurity.test.ts（mountRouter/makeValidToken/mock prisma）。
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { expectStatus } from '../shared/__tests__/utils/httpEvidence';
import jwt from 'jsonwebtoken';
import { createFinanceRouter } from '../finance/route';
import { createOrdersRouter } from '../orders/route';
import { createPricingRouter } from '../pricing/pricingRoute';
import { createAuditRouter } from '../audit/route';
import { ROLE_ID_TO_LEGACY_AGENT_ROLE } from '../auth/permissionService';
import {
  SYSTEM_ROLE_IDS,
  getDefaultScopeListForRole,
  type SystemRoleId,
} from '../_shared/rolePermissionMatrix';

// 与 middleware.ts 模块级单例 createAuthService() 一致的默认 secret
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
const apiKeys = new Set(['test-api-key-deny-path']);

/**
 * 按生产登录链路同款结构签 JWT：
 * roles[] = legacy AgentRole（requireRole 兼容层消费），
 * permissions[] = 该角色默认 scope 全集（requirePermission 第一优先消费）。
 */
function tokenForSystemRole(roleId: SystemRoleId): string {
  const legacy = ROLE_ID_TO_LEGACY_AGENT_ROLE[roleId];
  return jwt.sign(
    {
      userId: `u_${roleId}`,
      displayName: `DenyPath ${roleId}`,
      roles: [legacy],
      permissions: getDefaultScopeListForRole(roleId),
      departmentIds: ['company'],
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function auth(roleId: SystemRoleId): Record<string, string> {
  return { Authorization: `Bearer ${tokenForSystemRole(roleId)}` };
}

function makeMockPrisma(): any {
  const mock: any = {
    paymentVoucher: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: 'pv1' })),
      update: vi.fn(async () => ({ id: 'pv1' })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    invoiceAllocation: {
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
    },
    // Profit list's actual read access now loads the active persisted subject.
    // Keep the same seven canonical-role scopes as the original deny matrix.
    userAccount: { findFirst: vi.fn(async ({ where }: any) => {
      const roleId = Object.values(SYSTEM_ROLE_IDS).find(id => where.id === `u_${id}`);
      return roleId ? { id: where.id, status: 'active', deletedAt: null, primaryDeptId: 'company',
        roles: [{ roleId, departmentId: 'company', role: { id: roleId, permissions: getDefaultScopeListForRole(roleId)
          .map(scope => ({ permission: { scope } })) } }] } : null;
    }) },
    userPermissionOverrides: { findMany: vi.fn(async () => []) },
    orderProfitSheet: {
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: 'alog1' })),
      findMany: vi.fn(async () => []),
    },
    order: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({ id: 'o1' })),
      update: vi.fn(async () => ({ id: 'o1' })),
    },
    paymentRequest: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  mock.userAccount.findUnique = mock.userAccount.findFirst;
  mock.department = { findMany: vi.fn(async () => []) };
  // An empty company has no followed or team-shared customers; these are
  // current L2 dependencies, not fabricated permission grants.
  mock.relation = { findMany: vi.fn(async () => []) };
  mock.teamMember = { findMany: vi.fn(async () => []) };
  mock.teamDataGrant = { findMany: vi.fn(async () => []) };
  mock.$transaction = vi.fn(async (fn: any) => (typeof fn === 'function' ? fn(mock) : Promise.all(fn)));
  return mock;
}

function mount(path: string, router: express.Router): express.Express {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

const prisma = makeMockPrisma();
const financeApp = () => mount('/api/v1/finance', createFinanceRouter({ prisma, requireAuth: true, apiKeys }) as express.Router);
const ordersApp = () => mount('/api/v1/orders', createOrdersRouter({ prisma, requireAuth: true, apiKeys }) as express.Router);
const pricingApp = () => mount('/api/v1/pricing', createPricingRouter({ prisma, requireAuth: true, apiKeys }) as express.Router);
const auditApp = () => mount('/api/v1/audit', createAuditRouter({ prisma, requireAuth: true, apiKeys }) as express.Router);

// ★ v3.04：本地 expectStatus 收成共用一份（同一句消息 + 多带一条 B15 应答指纹）

function expectPassGate(res: request.Response, label: string) {
  expect(
    [401, 403].includes(res.status),
    `${label} → 应通过门禁（非 401/403），got ${res.status}; body=${JSON.stringify(res.body)}`,
  ).toBe(false);
}

// ══════════════════════════════════════════════════════════════
// 反向断言：legacy requireRole 门（HIGH_RISK_ROLES 不含 sales/viewer/logistics）
// ══════════════════════════════════════════════════════════════
describe('Deny · 财务凭证写（POST /api/v1/finance/vouchers，HIGH_RISK=owner/admin/manager/finance）', () => {
  it('sales（role-sales）POST → 403', async () => {
    const res = await request(financeApp()).post('/api/v1/finance/vouchers').set(auth(SYSTEM_ROLE_IDS.SALES)).send({});
    expectStatus(res, 403, 'sales POST /finance/vouchers');
  });

  it('qc（role-qc→viewer）POST → 403', async () => {
    const res = await request(financeApp()).post('/api/v1/finance/vouchers').set(auth(SYSTEM_ROLE_IDS.QC)).send({});
    expectStatus(res, 403, 'qc POST /finance/vouchers');
  });

  it('logistics（role-logistics）POST → 403', async () => {
    const res = await request(financeApp()).post('/api/v1/finance/vouchers').set(auth(SYSTEM_ROLE_IDS.LOGISTICS)).send({});
    expectStatus(res, 403, 'logistics POST /finance/vouchers');
  });

  it('sales DELETE /api/v1/finance/vouchers/:id（高危删除）→ 403', async () => {
    const res = await request(financeApp()).delete('/api/v1/finance/vouchers/pv_x').set(auth(SYSTEM_ROLE_IDS.SALES));
    expectStatus(res, 403, 'sales DELETE /finance/vouchers/:id');
  });

  it('qc DELETE /api/v1/finance/vouchers/:id（高危删除）→ 403', async () => {
    const res = await request(financeApp()).delete('/api/v1/finance/vouchers/pv_x').set(auth(SYSTEM_ROLE_IDS.QC));
    expectStatus(res, 403, 'qc DELETE /finance/vouchers/:id');
  });
});

describe('Deny · 订单写（POST/DELETE /api/v1/orders，HIGH_RISK=owner/admin/manager）', () => {
  it('qc（role-qc→viewer）POST → 403', async () => {
    const res = await request(ordersApp()).post('/api/v1/orders').set(auth(SYSTEM_ROLE_IDS.QC)).send({});
    expectStatus(res, 403, 'qc POST /orders');
  });

  it('logistics（role-logistics）POST → 403', async () => {
    const res = await request(ordersApp()).post('/api/v1/orders').set(auth(SYSTEM_ROLE_IDS.LOGISTICS)).send({});
    expectStatus(res, 403, 'logistics POST /orders');
  });

  it('finance（role-finance，业务域只读）POST → 403', async () => {
    const res = await request(ordersApp()).post('/api/v1/orders').set(auth(SYSTEM_ROLE_IDS.FINANCE)).send({});
    expectStatus(res, 403, 'finance POST /orders');
  });

  it('sales DELETE /api/v1/orders/:id（orders:delete 未授予业务员）→ 403', async () => {
    const res = await request(ordersApp()).delete('/api/v1/orders/o_x').set(auth(SYSTEM_ROLE_IDS.SALES));
    expectStatus(res, 403, 'sales DELETE /orders/:id');
  });
});

// ══════════════════════════════════════════════════════════════
// 反向断言：scope requirePermission 门（pricing:read）+ 实体审计角色映射门
// ══════════════════════════════════════════════════════════════
describe('Deny · 利润表读（GET /api/v1/pricing/profit-sheets，requirePermission pricing:read）', () => {
  it('qc（持 finance:read 但无 pricing:read）→ 403（scope 精度：finance:read 不能顶替 pricing:read）', async () => {
    const res = await request(pricingApp()).get('/api/v1/pricing/profit-sheets').set(auth(SYSTEM_ROLE_IDS.QC));
    expectStatus(res, 403, 'qc GET /pricing/profit-sheets');
  });

  it('logistics（finance:read/invoices:read/vouchers:read 但无 pricing:read）→ 403', async () => {
    const res = await request(pricingApp()).get('/api/v1/pricing/profit-sheets').set(auth(SYSTEM_ROLE_IDS.LOGISTICS));
    expectStatus(res, 403, 'logistics GET /pricing/profit-sheets');
  });
});

// 实体审计读（GET /api/v1/audit/entity）：2026-09-06 起按 canReadEntityAudit 角色映射门禁，
// 不再叠加 audit:read scope 门（sales 属 ORDERS_READ → 已放行，正向用例见 audit/entityRoute.test.ts）。
// 以下为仍被角色映射层拒绝的角色：
describe('Deny · 实体审计读（角色映射层：无 orders 模块读）', () => {
  it('qc（不在 ORDERS_READ）→ 403', async () => {
    const res = await request(auditApp())
      .get('/api/v1/audit/entity?targetType=Order&targetId=ORD_1')
      .set(auth(SYSTEM_ROLE_IDS.QC));
    expectStatus(res, 403, 'qc GET /audit/entity');
  });

  it('logistics（不在 ORDERS_READ）→ 403', async () => {
    const res = await request(auditApp())
      .get('/api/v1/audit/entity?targetType=Order&targetId=ORD_1')
      .set(auth(SYSTEM_ROLE_IDS.LOGISTICS));
    expectStatus(res, 403, 'logistics GET /audit/entity');
  });
});

// ══════════════════════════════════════════════════════════════
// 放行对照：合规角色必须能通过门禁（防守卫误伤，400/404/500 均可，非 401/403）
// ══════════════════════════════════════════════════════════════
describe('Allow · 放行对照（合规角色通过门禁）', () => {
  it('finance（role-finance）POST /api/v1/finance/vouchers → 非 401/403', async () => {
    const res = await request(financeApp()).post('/api/v1/finance/vouchers').set(auth(SYSTEM_ROLE_IDS.FINANCE)).send({});
    expectPassGate(res, 'finance POST /finance/vouchers');
  });

  it('sales-manager（role-sales-manager→manager）POST /api/v1/orders → 非 401/403', async () => {
    const res = await request(ordersApp()).post('/api/v1/orders').set(auth(SYSTEM_ROLE_IDS.SALES_MANAGER)).send({});
    expectPassGate(res, 'sales-manager POST /orders');
  });

  it('admin（role-admin）DELETE /api/v1/finance/vouchers/:id → 403（S3 ε 车道：vouchers:write 仅 FINANCE 持有，§6.6 业务只读预期收紧）', async () => {
    const res = await request(financeApp()).delete('/api/v1/finance/vouchers/pv_x').set(auth(SYSTEM_ROLE_IDS.ADMIN));
    expectStatus(res, 403, 'admin DELETE /finance/vouchers/:id（写族收编 scope 门后 admin 不再放行）');
  });

  it('admin（role-admin）DELETE /api/v1/orders/:id（高危端点放行）→ 非 401/403', async () => {
    const res = await request(ordersApp()).delete('/api/v1/orders/o_x').set(auth(SYSTEM_ROLE_IDS.ADMIN));
    expectPassGate(res, 'admin DELETE /orders/:id');
  });

  it('super-admin（role-super-admin→owner）POST /api/v1/finance/vouchers → 非 401/403', async () => {
    const res = await request(financeApp()).post('/api/v1/finance/vouchers').set(auth(SYSTEM_ROLE_IDS.SUPER_ADMIN)).send({});
    expectPassGate(res, 'super-admin POST /finance/vouchers');
  });

  it('sales（持 pricing:read）GET /api/v1/pricing/profit-sheets → 200', async () => {
    const res = await request(pricingApp()).get('/api/v1/pricing/profit-sheets').set(auth(SYSTEM_ROLE_IDS.SALES));
    expectStatus(res, 200, 'sales GET /pricing/profit-sheets');
  });

  it('finance（持 audit:read + 实体映射含 finance）GET /api/v1/audit/entity → 200', async () => {
    const res = await request(auditApp())
      .get('/api/v1/audit/entity?targetType=Order&targetId=ORD_1')
      .set(auth(SYSTEM_ROLE_IDS.FINANCE));
    expectStatus(res, 200, 'finance GET /audit/entity');
  });
});

// ══════════════════════════════════════════════════════════════
// 缺口固化区：以下断言为「正确期望」，当前实现若未挂门禁则红——
// 红 = 走查发现的真实门禁缺口，报告列出，不修实现、不改期望。
// ══════════════════════════════════════════════════════════════
describe('GAP · 财务 v1 读端点 scope 门缺失（GET /api/v1/finance/vouchers 未挂 requirePermission）', () => {
  it('qc（无 vouchers:read，仅有 finance:read）GET /api/v1/finance/vouchers → 期望 403（凭证列表应按 vouchers:read 收口）', async () => {
    const res = await request(financeApp()).get('/api/v1/finance/vouchers').set(auth(SYSTEM_ROLE_IDS.QC));
    expectStatus(res, 403, 'qc GET /finance/vouchers（v1 读端点未挂 scope 门 = 缺口）');
  });

  it('sales（持 vouchers:read）GET /api/v1/finance/vouchers → 200（对照：合规角色不受影响）', async () => {
    const res = await request(financeApp()).get('/api/v1/finance/vouchers').set(auth(SYSTEM_ROLE_IDS.SALES));
    expectStatus(res, 200, 'sales GET /finance/vouchers');
  });
});
