/**
 * B129 收口（v3.12）· 订单确认书「提交签署」这一站的**活路径档位证据**
 *
 * 为什么要单独一份：`components/ocSigningContract.test.ts` 那站契约测试原先钉的是**实现字面**
 * （`msg.includes('NO_REVIEWER_RESOLVED') ? 409`）⇒ 它只证明"那行字还在"，不证明"用户拿到 409"。
 * 本批改掉的正是那行字，于是它红了 —— 红得对（判据钉错了对象），但**修法不是把它换个字面接着钉**，
 * 而是补上真正缺的那一层：向路由发请求，读响应码。
 *
 * ★ 三条纪律（都是前几批复核教出来的，不是我自己发明的）：
 *   ① 不 mock 审批模块：409 必须来自 `approvalRoutingService` 真抛出 + `shared/errorCodes` 真登记
 *      + `statusFromError` 真查表（mock 掉任何一环，这条绿就与产品行为无关了）；
 *   ② 每条断言只认**一个**值（不许 `[409,500]` 那种"哪种实现都过"的软档）；
 *   ③ 配**反面对照**：把 code 拿掉、同样的文案交给真尺，必须答不出 409 ——
 *      否则"409 来自登记"这句话只是我说的，不是量出来的。
 *
 * ⚠️ 本文件**不声称** B131 已修完：③ 只钉住"我们自己的崩溃不再被答成 400"这一条（2c 那一档），
 *    默认兜底档仍是 400，那笔账在 §9 B131 里还开着。
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { statusFromError } from '../../shared/bizStatus';
import { lookupErrorCode } from '../../shared/errorCodes';
import { NO_REVIEWER_RESOLVED, createApprovalRoutingService } from '../../approvals/approvalRoutingService';
import { getDatabaseSeedScopeListForRole, SYSTEM_ROLE_IDS } from '../../_shared/rolePermissionMatrix';
import { createOrdersV2Router } from '../routeV2';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production-at-least-32-chars';
/** JWT 只标识用户；真正 scope 由下方当前数据库角色树加载。 */
const OWNER_ID = 'u-sign-owner';
const ownerToken = jwt.sign({ userId: OWNER_ID, roles: ['manager'] }, SECRET);
const URL_SIGN = '/api/v2/orders/ORD__1/request-sign';

const ORDER = {
  id: 'ORD__1', code: 'SO-202608-001', poNumber: 'PO-1', customer: 'Peerless', ownerId: OWNER_ID,
  customerRelationId: null, deletedAt: null, status: 'confirmed', currency: 'USD', createdAt: 1780000000000,
  lines: [],
};

/** 任意模型任意方法都返回 null ⇒ "记录查不到"。必须两层（`prisma.order` 得是对象，否则抛的是 TypeError） */
const prismaNull: any = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => null }) });
const ROLE_NAME: Record<string, string> = {
  [SYSTEM_ROLE_IDS.SALES_MANAGER]: '销售主管',
  [SYSTEM_ROLE_IDS.QC]: '质检专员',
};
function currentPrisma(options: { roleId?: string; order?: any | null; orderReadError?: Error; permissionReadError?: Error } = {}): any {
  const roleId = options.roleId ?? SYSTEM_ROLE_IDS.SALES_MANAGER;
  const userId = roleId === SYSTEM_ROLE_IDS.QC ? 'u-sign-qc' : OWNER_ID;
  const role = {
    id: roleId,
    name: ROLE_NAME[roleId] ?? roleId,
    permissions: getDatabaseSeedScopeListForRole(roleId as any).map(scope => ({ permission: { scope } })),
  };
  const user = {
    id: userId, displayName: '签署申请人', status: 'active', deletedAt: null, primaryDeptId: null,
    roles: [{ roleId, departmentId: null, role }],
  };
  const orderDelegate = {
    findFirst: async () => {
      if (options.orderReadError) throw options.orderReadError;
      return options.order ?? null;
    },
    findUnique: async () => options.order ?? null,
  };
  return {
    userAccount: { findFirst: async () => user, findUnique: async () => user },
    userPermissionOverrides: { findMany: async () => {
      if (options.permissionReadError) throw options.permissionReadError;
      return [];
    } },
    userRole: { findMany: async () => [] },
    department: { findUnique: async () => null, findMany: async () => [] },
    teamMember: { findMany: async () => [] },
    teamDataGrant: { findMany: async () => [] },
    relation: { findMany: async () => [], findUnique: async () => null },
    order: orderDelegate,
    orderLine: { findMany: async () => [], findFirst: async () => null, findUnique: async () => null },
    shipment: { findMany: async () => [] },
    systemConfig: { findUnique: async () => null },
  };
}
const prismaCurrentOrder = currentPrisma({ order: ORDER });
const prismaMissingOrder = currentPrisma();
const prismaNoAdmin = currentPrisma({ order: ORDER });
const prismaPermissionUnavailable = currentPrisma({ permissionReadError: new Error('grant store unavailable') });
/** 当前身份、权限均真实装载后，业务源读取才触发预期的内部崩溃。 */
const prismaCrash = currentPrisma({ orderReadError: new TypeError("Cannot read properties of undefined (reading 'x')") });
const deniedToken = jwt.sign({ userId: 'u-sign-qc', roles: ['viewer'] }, SECRET);

function appWith(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/orders', createOrdersV2Router({ prisma, requireAuth: true, apiKeys: new Set(['k']) } as any));
  return app;
}
const post = (app: express.Express, token = ownerToken) => request(app).post(URL_SIGN).set('Authorization', `Bearer ${token}`);

describe('B129 · 签署请求真实路由档位：读取授权、DR-007、当前身份与业务故障', () => {
  it('① 订单来源不存在或当前用户不可读 ⇒ 403（先做来源读取授权，不泄漏记录是否存在）', async () => {
    const res = await post(appWith(prismaMissingOrder));
    expect(res.status, `body=${JSON.stringify(res.body)}`).toBe(403);
    expect(res.body.error).toBe('SIGN_REQUEST_FAILED');
    expect(res.body.message).toBe('原业务不存在或当前用户无读取权限');
  });

  it('② 无可解析的领导 ⇒ 409（当前有效申请人进入真实 DR-007 ADMIN 兜底，仍无候选）', async () => {
    const res = await post(appWith(prismaNoAdmin));
    expect(res.status, `body=${JSON.stringify(res.body)}`).toBe(409);
    expect(res.body.error).toBe('SIGN_REQUEST_FAILED');
    expect(String(res.body.message)).toContain(NO_REVIEWER_RESOLVED);
  });

  it('③ 无登录身份 ⇒ 401；有效身份但当前权限加载失败 ⇒ 503', async () => {
    const anonymous = await request(appWith(prismaCurrentOrder)).post(URL_SIGN).send({});
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe('UNAUTHORIZED');

    const unavailable = await post(appWith(prismaPermissionUnavailable));
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe('AUTHORIZATION_UNAVAILABLE');
  });

  it('④ 当前数据库角色缺少 orders:write ⇒ 403，即使 JWT 带有 viewer 兼容码', async () => {
    const res = await post(appWith(currentPrisma({ roleId: SYSTEM_ROLE_IDS.QC, order: ORDER })), deniedToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('⑤ ★ 当前身份/权限已装载后业务源读取崩溃 ⇒ 500（B131·2c 活路径）', async () => {
    const res = await post(appWith(prismaCrash));
    expect(res.status, `body=${JSON.stringify(res.body)}`).toBe(500);
  });

  it('⑥ 出处对账：409 是注册表给的，不是文案给的（把 code 拿掉就答不出 409）', async () => {
    expect(lookupErrorCode(NO_REVIEWER_RESOLVED)?.status, '码没登记 ⇒ 本批的收口不成立').toBe(409);
    // 错误取**产品自己抛的那一枚**（不是我手写的字符串），否则"带码→409"可以靠自造文案蒙绿
    const real: any = await createApprovalRoutingService({ prisma: prismaCurrentOrder } as any)
      .resolveReviewerByDepartment(OWNER_ID).catch((x: any) => x);
    expect(real?.code, '抛方没带 code ⇒ 认档只能靠文案，B68 的病灶就还在').toBe(NO_REVIEWER_RESOLVED);
    expect(statusFromError(real), '带码走注册表').toBe(409);
    const codeless = new Error(String(real.message));
    expect(statusFromError(codeless), '同一句文案、没有码 ⇒ 真尺答不出 409（说明档位来自登记这一步）').not.toBe(409);
    // ★ 实测值打印出来（不写进断言当"预期的 400"）：本批量到的是 **404** —— 真文案含"申请人不存在或已停用"，
    //   撞在第 4 档关键词上，而不是落到默认兜底档。这与 B68 在报关那一站量到的完全一致（同一枚错误、同一把尺）。
    console.log(`[B129 实测] 无码同文案 → ${statusFromError(codeless)}（撞关键词，非默认兜底档；默认档仍是 400，见 §9 B131）`);
  });
});
