/**
 * P1-3 四入口接线契约测试（"漏一个即规则失效"防护锁）
 *
 *   ① OrderLine 创建/更新（orders/orderLineMutationService，route + Agent flow 双通道）
 *   ② QuotationLine 创建/重建（quotations/quotationService，route + Agent flow 双通道）
 *   ③ FabricShipmentSample 登记（samples/fabricShipmentSampleService，S/S + RC）
 *   ④ ShipmentLine 装箱（shipping/shipmentPackingService.replaceShipmentLinesTx 三收敛口）
 *
 * 另含：订单行入口集成测试（客户 B 引用专属面料 → 409；属主客户 A → 放行）
 * 与 products 路由保存/预检契约（isExclusive 落库 + 属主锚校验 + check 端点）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createOrderLine } from '../../orders/orderLineMutationService';
import type { TokenPayload } from '../../auth/service';
import { httpStatusOfCode } from '../../shared/errorCodes';

const orderLineActor: TokenPayload = { userId: 'user-1', roles: ['admin'], permissions: ['orders:write'], departmentIds: [], authorizationLoaded: true };

const orderLineSource = readFileSync(new URL('../../orders/orderLineMutationService.ts', import.meta.url), 'utf8');
const quotationSource = readFileSync(new URL('../../quotations/quotationService.ts', import.meta.url), 'utf8');
const sampleSource = readFileSync(new URL('../../samples/fabricShipmentSampleService.ts', import.meta.url), 'utf8');
const packingSource = readFileSync(new URL('../../shipping/shipmentPackingService.ts', import.meta.url), 'utf8');
const productsRouteSource = readFileSync(new URL('../../products/route.ts', import.meta.url), 'utf8');
const quotationRouteSource = readFileSync(new URL('../../quotations/quotationRoute.ts', import.meta.url), 'utf8');
const shippingRouteSource = readFileSync(new URL('../../shipping/route.ts', import.meta.url), 'utf8');

describe('P1-3 四入口源码契约锁（校验单一真源 assertFabricAllowed）', () => {
  it('① OrderLine 创建/更新均接线（route + Agent flow 共用 service 层）', () => {
    expect(orderLineSource).toContain("import { assertFabricAllowed } from '../products/fabricExclusivityService'");
    expect(orderLineSource).toContain("context: 'order-line:create'");
    expect(orderLineSource).toContain("context: 'order-line:update'");
    expect(orderLineSource).toContain("if ('materialCode' in patch || 'millQuality' in patch)");
  });

  it('② QuotationLine 创建/重建均接线（fabricCode 多键解析，无全局客供品号兜底）', () => {
    expect(quotationSource).toContain("import { assertFabricAllowed } from '../products/fabricExclusivityService'");
    expect(quotationSource).toContain("context: 'quotation:create'");
    expect(quotationSource).toContain("context: 'quotation:update'");
    expect(quotationSource).toContain('clientCodeGlobalFallback: false');
  });

  it('③ FabricShipmentSample S/S + RC 均接线（fabricProfileId 直锚）', () => {
    expect(sampleSource).toContain("import { assertFabricAllowed, productAssetIdOfFabricProfile } from '../products/fabricExclusivityService'");
    expect(sampleSource).toContain("context: 'fabric-shipment-sample:register-ss'");
    expect(sampleSource).toContain("context: 'fabric-shipment-sample:enable-rc'");
  });

  it('④ ShipmentLine 装箱接线（orderLineId/productCode 锚；三收敛口共用 replaceShipmentLinesTx）', () => {
    expect(packingSource).toContain("import { assertFabricAllowed } from '../products/fabricExclusivityService'");
    expect(packingSource).toContain("context: 'shipment-lines:replace'");
    expect(packingSource).toContain('EXCLUSIVE_FABRIC_BLOCKED');
  });

  it('路由层：409 透传（quotation statusCode / shipping statusCodeMap）', () => {
    expect(quotationRouteSource).toContain('e?.statusCode ?? 500');
    expect(shippingRouteSource).toContain('EXCLUSIVE_FABRIC_BLOCKED: 409');
  });

  it('products 路由：isExclusive 落库 + 属主锚校验 + 预检端点', () => {
    expect(productsRouteSource).toContain('validateExclusiveCodes');
    expect(productsRouteSource).toContain('isExclusive: c.isExclusive === true');
    expect(productsRouteSource).toContain("'/fabric-exclusivity/check'");
    expect(productsRouteSource).toContain('EXCLUSIVE_OWNER_REQUIRED');
  });
});

describe('P1-3 订单行入口集成（客户专属面料 fail-closed）', () => {
  const ASSET_X = { id: 'PA__X', sku: 'FAB-X', name: '独家开发面料 X', deletedAt: null };
  const EXCLUSIVE_A = { id: 'FCC-1', productAssetId: 'PA__X', clientCode: 'A-100', customerOrganizationId: 'REL-A', customerNameSnapshot: '客户A', isExclusive: true, deletedAt: null };

  function makePrisma(order: any, relationRows?: any[]) {
    const auditLogs: any[] = [];
    const relations = relationRows ?? [
      { id: 'REL-A', category: 'Customer', isOrganization: true, deletedAt: null },
      { id: 'REL-B', category: 'customer', isOrganization: true, deletedAt: null },
    ];
    const currentUser = {
      id: 'user-1', status: 'active', deletedAt: null, primaryDeptId: 'dept-test',
      roles: [{ roleId: 'role-admin', departmentId: null, role: { id: 'role-admin', permissions: [{ permission: { scope: 'orders:write' } }] } }],
    };
    const matchCode = (c: any, where: any = {}): boolean => {
      if (where?.clientCode !== undefined && where.clientCode !== c.clientCode) return false;
      if (where?.productAssetId?.in && !where.productAssetId.in.includes(c.productAssetId)) return false;
      if (where?.isExclusive !== undefined && where.isExclusive !== c.isExclusive) return false;
      if (where?.deletedAt !== undefined && where.deletedAt !== c.deletedAt) return false;
      if (Array.isArray(where?.OR)) {
        const orOk = (where.OR as any[]).some((sub: any) =>
          sub.customerOrganizationId === null ? c.customerOrganizationId == null : sub.customerOrganizationId === c.customerOrganizationId);
        if (!orOk) return false;
      }
      return true;
    };
    const tx = {
      userAccount: {
        findFirst: vi.fn(async ({ where }: any = {}) => where?.id === currentUser.id && where?.deletedAt === null ? currentUser : null),
        findUnique: vi.fn(async ({ where }: any = {}) => where?.id === currentUser.id && where?.deletedAt === null ? currentUser : null),
        findMany: vi.fn(async () => []),
      },
      userPermissionOverrides: { findMany: vi.fn(async () => []) },
      department: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => [{ id: order.id }]),
      order: {
        findUnique: vi.fn(async () => order),
        findUniqueOrThrow: vi.fn(async () => order),
        findFirst: vi.fn(async ({ where }: any) => order.id === where.id && order.deletedAt == null ? order : null),
        update: vi.fn(async ({ data }: any) => Object.assign(order, data)),
      },
      orderLine: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: any) => ({ ...data, order })),
        update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      },
      auditLog: { create: vi.fn(async ({ data }: any) => { auditLogs.push(data); return data; }) },
      entityReference: { upsert: vi.fn(async () => ({})) },
      entityLink: { upsert: vi.fn(async () => ({})) },
      productAsset: { findMany: vi.fn(async ({ where }: any = {}) => [ASSET_X].filter(a => where?.id?.in?.includes(a.id) ?? false)) },
      fabricProfile: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      fabricCustomerCode: { findMany: vi.fn(async ({ where }: any = {}) => [EXCLUSIVE_A].filter(c => matchCode(c, where))) },
      relation: { findMany: vi.fn(async ({ where }: any = {}) => relations.filter(r => where?.id?.in?.includes(r.id))) },
    };
    const prisma: any = {
      // The refused attempt uses the actual outer client; successful mutation
      // audit stays on tx. This fixture alone is not durable PG evidence.
      auditLog: { create: vi.fn(async ({ data }: any) => { auditLogs.push(data); return data; }) },
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      orderLine: { findMany: vi.fn(async () => []) },
    };
    return { prisma, tx, auditLogs };
  }

  const ORDER_B = { id: 'ORD__B', poNumber: 'PO-B', customer: '客户B', customerRelationId: 'REL-B', type: 'Fabric', deletedAt: null };
  const ORDER_A = { id: 'ORD__A', poNumber: 'PO-A', customer: '客户A', customerRelationId: 'REL-A', type: 'Fabric', deletedAt: null };

  beforeEach(() => { vi.clearAllMocks(); });

  it('客户 B 订单行引用专属面料（客供品号 A-100）→ 409 EXCLUSIVE_FABRIC_BLOCKED + 违规审计', async () => {
    const { prisma, tx, auditLogs } = makePrisma(ORDER_B);
    const r = await createOrderLine({ prisma, orderId: 'ORD__B', materialCode: 'A-100', quantity: 100, actorId: 'user-1', trustedActor: orderLineActor });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('EXCLUSIVE_FABRIC_BLOCKED');
    expect(httpStatusOfCode((r as any).error.code)).toBe(409);
    expect((r as any).error.message).toContain('客户A');
    expect(tx.orderLine.create).not.toHaveBeenCalled();
    expect(auditLogs[0].detail.after.violations[0]).toMatchObject({ identityStatus: 'different_customer', identityGap: null });
    // 违规尝试已留痕（targetType=ProductAsset）
    expect(auditLogs.length).toBe(1);
    expect(auditLogs[0].action).toBe('exclusive_fabric_violation_attempt');
    expect(auditLogs[0].targetType).toBe('ProductAsset');
  });

  it('订单入口：同名但客户 Relation ID 不同仍返回专属面料 409', async () => {
    const sameNameOtherCustomer = { ...ORDER_B, customer: '客户A' };
    const { prisma, tx, auditLogs } = makePrisma(sameNameOtherCustomer);
    const r = await createOrderLine({ prisma, orderId: 'ORD__B', materialCode: 'A-100', quantity: 100, actorId: 'user-1', trustedActor: orderLineActor });
    expect(r).toMatchObject({ ok: false, error: { code: 'EXCLUSIVE_FABRIC_BLOCKED' } });
    expect(httpStatusOfCode((r as any).error.code)).toBe(409);
    expect((r as any).error.message).toContain('为客户「客户A」专属，当前客户「客户A」未获授权');
    expect(tx.orderLine.create).not.toHaveBeenCalled();
    expect(auditLogs[0].detail.after.violations[0]).toMatchObject({ identityStatus: 'different_customer', identityGap: null });
  });

  it('订单入口：无效客户 Relation 身份待核对并返回 409，零业务写入', async () => {
    const { prisma, tx, auditLogs } = makePrisma(ORDER_B, [
      { id: 'REL-A', category: 'Customer', isOrganization: true, deletedAt: null },
      { id: 'REL-B', category: 'Supplier', isOrganization: true, deletedAt: null },
    ]);
    const r = await createOrderLine({ prisma, orderId: 'ORD__B', materialCode: 'A-100', quantity: 100, actorId: 'user-1', trustedActor: orderLineActor });
    expect(r).toMatchObject({ ok: false, error: { code: 'EXCLUSIVE_FABRIC_BLOCKED' } });
    expect(httpStatusOfCode((r as any).error.code)).toBe(409);
    expect((r as any).error.message).toContain('当前客户「客户B」档案待核对');
    expect((r as any).error.message).not.toContain('REL-B');
    expect(tx.orderLine.create).not.toHaveBeenCalled();
    expect(auditLogs[0].detail.after.violations[0]).toMatchObject({
      identityStatus: 'identity_pending', identityGap: 'customer_relation_invalid',
      identityIssues: [{ side: 'customer', relationId: 'REL-B', reason: 'not_customer' }],
    });
  });

  it('属主客户 A 订单行同一面料 → 放行创建', async () => {
    const { prisma, tx } = makePrisma(ORDER_A);
    const r = await createOrderLine({ prisma, orderId: 'ORD__A', materialCode: 'A-100', quantity: 100, actorId: 'user-1', trustedActor: orderLineActor });
    expect(r.ok).toBe(true);
    expect(tx.orderLine.create).toHaveBeenCalledTimes(1);
    expect((r as any).data.line.materialCode).toBe('A-100');
  });

  it('未命中任何产品锚的客供品号 → 放行（不能因未登记编码卡业务）', async () => {
    const { prisma } = makePrisma(ORDER_B);
    // fabricCustomerCode.findMany 只按 clientCode 精确匹配；传未登记码 → 无命中
    const r = await createOrderLine({ prisma, orderId: 'ORD__B', materialCode: 'UNKNOWN-CODE', quantity: 100, actorId: 'user-1', trustedActor: orderLineActor });
    expect(r.ok).toBe(true);
  });
});
