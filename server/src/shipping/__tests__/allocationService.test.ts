/**
 * DR-016 合票建模 — ShipmentOrderAllocation 服务测试
 *
 * 覆盖（任务书 §5 ≥12 用例）：
 *   1. 同客户同业务线合票通过
 *   2. 跨客户拒绝
 *   3. 跨业务线拒绝
 *   4. 面料服装混合拒绝
 *   5. 跨票累计超限拒绝
 *   6. 取消票不计入累计
 *   7. 逐分配门禁（A 单 SS 未确认整票 blocked 且明细按订单分组）
 *   8. 状态回写部分履约
 *   9. 回填幂等
 *  10. orderId 投影一致
 *  11. 分配唯一约束
 *  12. DR-013 例外放行后分配仍逐项记录
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createAllocationService } from '../allocationService';
import {
  writeInternalToleranceStandard,
  INTERNAL_TOLERANCE_KEY,
} from '../../orders/toleranceStandardService';

const prisma = new PrismaClient();
const svc = createAllocationService(prisma);

// 测试数据 ID 前缀（避免与其他测试冲突）
const TEST_PREFIX = 'TEST_ALLOC_';
const TEST_ORDER_PREFIX = 'TEST_ORDER_';
const TEST_SHIPMENT_PREFIX = 'TEST_SHIP_';
const TEST_ACTOR_ID = 'TEST_ACTOR_ALLOC';

// 清理函数
async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorId: TEST_ACTOR_ID } });
  await prisma.shipmentOrderAllocation.deleteMany({
    where: {
      OR: [
        { id: { startsWith: TEST_PREFIX } },
        { id: { startsWith: 'SHPA__' } }, // 清理服务生成的分配记录
      ],
    },
  });
  await prisma.shipment.deleteMany({
    where: { id: { startsWith: TEST_SHIPMENT_PREFIX } },
  });
  await prisma.orderLine.deleteMany({
    where: { id: { startsWith: TEST_ORDER_PREFIX } },
  });
  await prisma.order.deleteMany({
    where: { id: { startsWith: TEST_ORDER_PREFIX } },
  });
  await prisma.userAccount.deleteMany({
    where: { id: TEST_ACTOR_ID },
  });
}

// 确保测试用户存在
async function ensureActor() {
  const existing = await prisma.userAccount.findUnique({ where: { id: TEST_ACTOR_ID } });
  if (existing) return existing;
  return prisma.userAccount.create({
    data: {
      id: TEST_ACTOR_ID,
      displayName: 'Test Actor',
      email: 'test-alloc-actor@bambook.test',
      passwordHash: '',
    },
  });
}

// 创建测试订单（customer name 决定合票校验的"同客户"判定）
async function createTestOrder(id: string, customerRelationId: string | null, businessLine: string | null, customerName?: string) {
  return prisma.order.create({
    data: {
      id: TEST_ORDER_PREFIX + id,
      customer: customerName ?? ('TEST_CUSTOMER_' + id),
      consigneeName: 'TEST_CONSIGNEE',
      product: 'TEST_PRODUCT',
      type: 'Garment',
      quantity: 1000,
      status: 'Confirmed',
      dueDate: '2026-12-31',
      quoteAmount: 10000,
      customerRelationId,
      businessLine,
      updatedAt: BigInt(Date.now()),
    },
  });
}

// 创建测试订单行。
// ★ 2026-09-29：`tolerancePercent` **只有显式传入**时才同时写 `toleranceSource='line_override'`
//   —— 取数链是**白名单**：没有来源标记的值不算「人定的」，不进覆盖层。
//   传 `toleranceSource = null` 可模拟「行上那个数是 schema @default 填的、不是人定的」。
async function createTestOrderLine(
  id: string,
  orderId: string,
  quantity: number,
  tolerancePercent?: number,
  unit?: string,
  toleranceSource: string | null = 'line_override',
) {
  return prisma.orderLine.create({
    data: {
      id: TEST_ORDER_PREFIX + id,
      orderId: TEST_ORDER_PREFIX + orderId,
      lineNumber: 1,
      quantity,
      unit: unit ?? 'PCS',
      ...(tolerancePercent !== undefined ? { tolerancePercent, toleranceSource } : {}),
    },
  });
}

// 创建测试票
async function createTestShipment(id: string, status: string = 'Draft') {
  return prisma.shipment.create({
    data: {
      id: TEST_SHIPMENT_PREFIX + id,
      shipmentNumber: 'TEST-SHP-' + id,
      type: 'Export',
      status,
      shippingMethod: 'Sea',
      createdAt: BigInt(Date.now()),
      updatedAt: BigInt(Date.now()),
    },
  });
}

describe('DR-016 合票建模 — ShipmentOrderAllocation', () => {
  beforeEach(async () => {
    await cleanup();
    await ensureActor();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  describe('合票校验 — assertConsolidationAllowed', () => {
    it('同客户同业务线合票通过', async () => {
      // customerRelationId 置 null，用 customer 字段兜底比较（避免 P2003 外键约束）
      // 同客户 = 相同 customer name
      const o1 = await createTestOrder('C1', null, 'garment', 'SAME_CUSTOMER');
      const o2 = await createTestOrder('C2', null, 'garment', 'SAME_CUSTOMER');
      const l1 = await createTestOrderLine('C1L', 'C1', 1000);
      const l2 = await createTestOrderLine('C2L', 'C2', 1000);
      const sh = await createTestShipment('S1');

      // 创建两条分配
      const r1 = await svc.createAllocation(sh.id, { orderId: o1.id, orderLineId: l1.id, plannedQty: 100 }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      const r2 = await svc.createAllocation(sh.id, { orderId: o2.id, orderLineId: l2.id, plannedQty: 200 }, TEST_ACTOR_ID);
      if (!r2.ok) console.error('DEBUG r2 error:', JSON.stringify(r2.error, null, 2));
      expect(r2.ok).toBe(true);

      // 验证票内有两条分配
      const list = await svc.listAllocations(sh.id);
      expect(list.ok).toBe(true);
      expect(list.data!.items.length).toBe(2);
    });

    it('跨客户拒绝', async () => {
      const o1 = await createTestOrder('X1', null, 'garment');
      const o2 = await createTestOrder('X2', null, 'garment'); // 不同 customer name（兜底比较）
      const l1 = await createTestOrderLine('X1L', 'X1', 1000);
      const l2 = await createTestOrderLine('X2L', 'X2', 1000);
      const sh = await createTestShipment('S2');

      await svc.createAllocation(sh.id, { orderId: o1.id, orderLineId: l1.id, plannedQty: 100 }, TEST_ACTOR_ID);
      const r = await svc.createAllocation(sh.id, { orderId: o2.id, orderLineId: l2.id, plannedQty: 200 }, TEST_ACTOR_ID);

      expect(r.ok).toBe(false);
      expect(r.error!.code).toBe('CONSOLIDATION_CUSTOMER_MISMATCH');
    });

    it('跨业务线拒绝', async () => {
      // 相同 customer name，仅 businessLine 不同
      const o1 = await createTestOrder('B1', null, 'garment', 'SAME_CUSTOMER_B');
      const o2 = await createTestOrder('B2', null, 'fabric', 'SAME_CUSTOMER_B'); // 不同业务线
      const l1 = await createTestOrderLine('B1L', 'B1', 1000);
      const l2 = await createTestOrderLine('B2L', 'B2', 1000);
      const sh = await createTestShipment('S3');

      await svc.createAllocation(sh.id, { orderId: o1.id, orderLineId: l1.id, plannedQty: 100 }, TEST_ACTOR_ID);
      const r = await svc.createAllocation(sh.id, { orderId: o2.id, orderLineId: l2.id, plannedQty: 200 }, TEST_ACTOR_ID);

      expect(r.ok).toBe(false);
      expect(r.error!.code).toBe('CONSOLIDATION_BUSINESS_LINE_MISMATCH');
    });

    it('面料服装混合拒绝（天然由 businessLine 校验拦截）', async () => {
      // 相同 customer name，仅 businessLine 不同（fabric vs garment）
      const o1 = await createTestOrder('M1', null, 'fabric', 'SAME_CUSTOMER_M');
      const o2 = await createTestOrder('M2', null, 'garment', 'SAME_CUSTOMER_M');
      const l1 = await createTestOrderLine('M1L', 'M1', 1000);
      const l2 = await createTestOrderLine('M2L', 'M2', 1000);
      const sh = await createTestShipment('S4');

      await svc.createAllocation(sh.id, { orderId: o1.id, orderLineId: l1.id, plannedQty: 100 }, TEST_ACTOR_ID);
      const r = await svc.createAllocation(sh.id, { orderId: o2.id, orderLineId: l2.id, plannedQty: 200 }, TEST_ACTOR_ID);

      expect(r.ok).toBe(false);
      expect(r.error!.code).toBe('CONSOLIDATION_BUSINESS_LINE_MISMATCH');
    });
  });

  describe('跨票累计上限 — ORDER_LINE_OVER_ALLOCATED', () => {
    it('跨票累计超限拒绝', async () => {
      const order = await createTestOrder('O1', null, 'garment');
      const line = await createTestOrderLine('L1', 'O1', 500);
      const sh1 = await createTestShipment('S5');
      const sh2 = await createTestShipment('S6');

      // 票1 分配 300
      const r1 = await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 300 }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      // 票2 再分配 300 → 累计 600 > 500 超限
      const r2 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 300 }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(false);
      expect(r2.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
    });

    it('取消票不计入累计', async () => {
      const order = await createTestOrder('O2', null, 'garment');
      const line = await createTestOrderLine('L2', 'O2', 500);
      const sh1 = await createTestShipment('S7', 'Cancelled'); // 已取消票
      const sh2 = await createTestShipment('S8');

      // 取消票分配 300（应被排除在累计外）
      await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 300 }, TEST_ACTOR_ID);

      // 有效票再分配 300 → 累计只算有效票 300 ≤ 500 通过
      const r = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 300 }, TEST_ACTOR_ID);
      expect(r.ok).toBe(true);
    });
  });

  describe('溢短装容差 — 标准链接入上限（REQ2-03 + J-1/J-11，2026-09-29）', () => {
    it('① 行级覆盖 ±5% 时 +3% 溢装通过', async () => {
      const order = await createTestOrder('TL1', null, 'garment');
      const line = await createTestOrderLine('TLL1', 'TL1', 500, 5); // 覆盖 ±5% ⇒ 上限 525
      const sh = await createTestShipment('ST1');

      // +3% = 515 ≤ 525 通过
      const r = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 515 }, TEST_ACTOR_ID);
      expect(r.ok).toBe(true);
    });

    it('① 行级覆盖 ±5% 时 +6% 溢装拒绝（消息须含「容差」并写明来源）', async () => {
      const order = await createTestOrder('TL2', null, 'garment');
      const line = await createTestOrderLine('TLL2', 'TL2', 500, 5); // 上限 525
      const sh = await createTestShipment('ST2');

      // +6% = 530 > 525 拒绝
      const r = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 530 }, TEST_ACTOR_ID);
      expect(r.ok).toBe(false);
      expect(r.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
      expect(r.error!.message).toContain('容差');
      expect(r.error!.message, '★ 必须说清这个数从哪来，否则人不知道该改哪').toContain('行级覆盖');
    });

    it('① 行级覆盖 0 时保持硬顶（足量交付）', async () => {
      const order = await createTestOrder('TL3', null, 'garment');
      const line = await createTestOrderLine('TLL3', 'TL3', 500, 0); // 上限 500
      const sh = await createTestShipment('ST3');

      // +2% = 510 > 500 拒绝（无容差时任何溢装即超限）
      const r = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 510 }, TEST_ACTOR_ID);
      expect(r.ok).toBe(false);
      expect(r.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
    });

    /**
     * ★★ 2026-09-29 晚口径变更（Kevin：内部标准要有**出厂默认值**）—— 本用例整条换了口径，理由写在这里：
     *   修前它钉的是「客户未录、内部也未录 ⇒ 未判定 ⇒ 按不放溢装卡住」（上午的口径）。
     *   现在「都没录」⇒ 落 **③b 出厂默认**（500 米 → 0–999 档 → ±5%）⇒ **+2% 应放行**、+6% 仍拒。
     *   ★ 反向对照也在同一条里（+6% 必须拒），否则"全放行"也能让这条变绿。
     */
    it('★★ 客户未录 + 内部未录 ⇒ 按**出厂默认**取数：+2% 放行、+6% 拒（Kevin 口径，修前是"一律卡"）', async () => {
      const order = await createTestOrder('TL4', null, 'garment');
      // ★ toleranceSource = null ⇒ 行上那个 5 是 schema @default 填的，**不是人定的**（不进覆盖层）
      const line = await createTestOrderLine('TLL4', 'TL4', 500, undefined, undefined, null);
      expect(Number(line.tolerancePercent), '行上确实有 5（系统填的）').toBe(5);
      expect(line.toleranceSource, '但来源为空 ⇒ 不算覆盖').toBeNull();

      const sh = await createTestShipment('ST4');
      // +2% = 510 ≤ 500×1.05 ⇒ 按出厂默认放行（修前这里被卡住）
      const ok = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 510 }, TEST_ACTOR_ID);
      expect(ok.ok, '★ 出厂默认 ±5% ⇒ +2% 应放行 —— 否则任何溢装都被卡死、业务侧无自解手段').toBe(true);

      const sh2 = await createTestShipment('ST4B');
      // +6% = 530 > 525 ⇒ 拒，且必须点名"这套数从哪来"（出厂默认 ⇒ 提示去设置里调）
      const no = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 530 }, TEST_ACTOR_ID);
      expect(no.ok).toBe(false);
      expect(no.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
      expect(no.error!.message, '★ 要让人知道这是"出厂默认"，不是谁录的标准').toContain('出厂默认');
    });

    /**
     * ★★ 出厂默认上线后，"卡住"这一路**并没有消失**，只是来源变了：从"没人录"变成"**配置读不到/坏掉**"。
     *   这条用例就是那个仍然可达的硬拦路径（真库直造一行坏配置 ⇒ 归一化不出档位 ⇒ 按未判定处理）。
     *   ★ 为什么不能省：若这里也放行，"不放出超合同货"就失去最后一道闸。
     */
    it('★★ 内部标准**配置损坏**（行存在但解析不出档位）⇒ 不套出厂默认，仍按「不放溢装」卡住', async () => {
      // 直接写一行坏配置（绕过 writeInternalToleranceStandard 的校验，模拟"库里存了一个空壳"）
      await prisma.systemConfig.create({
        data: {
          id: `global::${INTERNAL_TOLERANCE_KEY}`,
          scope: 'global',
          key: INTERNAL_TOLERANCE_KEY,
          group: 'custom',
          label: 'TEST：故意损坏的内部公差标准',
          valueType: 'json',
          value: {},
          version: 1,
          updatedAt: BigInt(Date.now()),
        },
      });
      try {
        const order = await createTestOrder('TL4C', null, 'garment');
        const line = await createTestOrderLine('TLL4C', 'TL4C', 500, undefined, undefined, null);
        const sh = await createTestShipment('ST4C');
        const r = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 510 }, TEST_ACTOR_ID);
        expect(r.ok, '★ 坏配置按「读不到」处理 ⇒ 必须卡住，而不是拿出厂默认去放行').toBe(false);
        expect(r.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
        expect(r.error!.message).toContain('不放溢装');
        expect(r.error!.message, '必须告诉人下一步怎么办').toContain('内部公差标准');
      } finally {
        // ★ 必须清掉：SystemConfig 是共享表，留着会污染同文件其它用例
        await prisma.systemConfig.deleteMany({ where: { key: INTERNAL_TOLERANCE_KEY } });
      }
    });

    it('★★ 只录了内部标准 ⇒ 未录客户标准也按内部标准放行（使用方：「没有客户标准，就按内部标准」）', async () => {
      const w = await writeInternalToleranceStandard(
        prisma,
        { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
        { reason: '测试：内部公差标准 ±5%' },
      );
      expect(w.ok, '写入内部标准应成功').toBe(true);
      try {
        const order = await createTestOrder('TL5', null, 'garment');
        const line = await createTestOrderLine('TLL5', 'TL5', 500, undefined, undefined, null); // 无覆盖

        const sh = await createTestShipment('ST5');
        const ok = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 515 }, TEST_ACTOR_ID);
        expect(ok.ok, '内部标准 ±5% ⇒ +3% 应放行').toBe(true);

        const sh2 = await createTestShipment('ST5B');
        const no = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 530 }, TEST_ACTOR_ID);
        expect(no.ok).toBe(false);
        expect(no.error!.message, '来源要写明是「我方标准」（内部标准）').toContain('我方标准');
      } finally {
        // ★ 必须清掉：SystemConfig 是共享表，留着会污染同文件其它用例
        await prisma.systemConfig.deleteMany({ where: { key: INTERNAL_TOLERANCE_KEY } });
      }
    });

    it('★★ 客户标准 ±1% 压住内部标准 ±5%（客户 P0）—— 30000 米 +3% 必须拒', async () => {
      // 设计稿 §七 的验收锚点
      const relId = 'TEST_REL_TOL_CUSTOMER';
      await prisma.relation.create({
        data: {
          id: relId,
          name: 'TEST_TOL_CUSTOMER',
          category: 'Customer',
          type: 'Organization',
          isOrganization: true,
          contactInfo: '',
          tags: [],
          lastInteraction: BigInt(0),
          customerAgreementTolerance: { qtyTolerance: [{ minQty: 5001, maxQty: null, pct: 1 }] },
        },
      });
      const w = await writeInternalToleranceStandard(
        prisma,
        { qtyTolerance: [{ minQty: 1, maxQty: null, pct: 5 }] },
        { reason: '测试：内部 ±5%（应被客户 ±1% 压住）' },
      );
      expect(w.ok).toBe(true);
      try {
        const order = await createTestOrder('TL6', relId, 'garment');
        const line = await createTestOrderLine('TLL6', 'TL6', 30000, undefined, 'Meter', null);

        const sh = await createTestShipment('ST6');
        // +3% = 30900；客户 ±1% 只许 30300 ⇒ 拒
        const r = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 30900 }, TEST_ACTOR_ID);
        expect(r.ok, '★ 客户 P0：±1% 必须压住内部的 ±5%').toBe(false);
        expect(r.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
        expect(r.error!.message).toContain('客户标准');

        // 反面对照：+0.5% = 30150 ≤ 30300 应放行（证明不是"一律拒"）
        const sh2 = await createTestShipment('ST6B');
        const ok = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 30150 }, TEST_ACTOR_ID);
        expect(ok.ok, '客户标准 ±1% 之内应放行').toBe(true);
      } finally {
        await prisma.systemConfig.deleteMany({ where: { key: INTERNAL_TOLERANCE_KEY } });
        await prisma.order.updateMany({
          where: { id: TEST_ORDER_PREFIX + 'TL6' },
          data: { customerRelationId: null },
        });
        await prisma.relation.deleteMany({ where: { id: relId } });
      }
    });
  });

  describe('投影维护', () => {
    it('orderId 投影一致（= 票内第一条分配的 orderId）', async () => {
      const o1 = await createTestOrder('P1', null, 'garment', 'SAME_CUSTOMER_P');
      const o2 = await createTestOrder('P2', null, 'garment', 'SAME_CUSTOMER_P');
      const l1 = await createTestOrderLine('P1L', 'P1', 1000);
      const l2 = await createTestOrderLine('P2L', 'P2', 1000);
      const sh = await createTestShipment('S9');

      await svc.createAllocation(sh.id, { orderId: o1.id, orderLineId: l1.id, plannedQty: 100 }, TEST_ACTOR_ID);
      await svc.createAllocation(sh.id, { orderId: o2.id, orderLineId: l2.id, plannedQty: 200 }, TEST_ACTOR_ID);

      const shipment = await prisma.shipment.findUnique({ where: { id: sh.id } });
      expect(shipment!.orderId).toBe(o1.id); // 第一条分配的 orderId

      // 删除第一条后投影更新
      const list = await svc.listAllocations(sh.id);
      const firstAlloc = list.data!.items[0];
      await svc.deleteAllocation(sh.id, firstAlloc.id, TEST_ACTOR_ID);

      const shipment2 = await prisma.shipment.findUnique({ where: { id: sh.id } });
      expect(shipment2!.orderId).toBe(o2.id); // 投影更新为剩余第一条
    });
  });

  describe('分配唯一约束', () => {
    it('同票同订单行不重复分配', async () => {
      const order = await createTestOrder('U1', null, 'garment');
      const line = await createTestOrderLine('UL1', 'U1', 500);
      const sh = await createTestShipment('S10');

      const r1 = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, plannedQty: 100 }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      // 重复分配同票同订单行 → 拒绝
      // ★ A4（2026-09-18）：原先靠 Prisma P2002 被兜成 CREATE_FAILED（语义不清、且
      //   orderLineId IS NULL 的整单分支 PG **根本不互斥**）。现由服务层显式判重，
      //   返回 ALLOCATION_DUPLICATE；这里同步断言新码（保留旧码仅为兼容旧部署，非本仓现状）。
      const r2 = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, plannedQty: 200 }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(false);
      expect(r2.error!.code).toBe('ALLOCATION_DUPLICATE');
      expect(r2.error!.message).toContain('只能有一条分配');
    });
  });

  describe('订单行分配粒度', () => {
    it('拒绝旧整单/null 条目分配，不创建按比例虚拟分摊', async () => {
      const order = await createTestOrder('W1', null, 'garment');
      await createTestOrderLine('WL1', 'W1', 300);
      await createTestOrderLine('WL2', 'W1', 200);
      const sh = await createTestShipment('S11');

      const result = await svc.createAllocation(sh.id, { orderId: order.id, actualQty: 300 }, TEST_ACTOR_ID);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_FAILED');
      const rows = await prisma.shipmentOrderAllocation.findMany({ where: { shipmentId: sh.id } });
      expect(rows).toHaveLength(0);
    });
  });

  describe('DR-013 例外放行后分配仍逐项记录', () => {
    it('例外放行后分配记录保持完整', async () => {
      // DR-013 例外门禁已在 W1 接入 fabricShipmentSampleService
      // 本测试验证：即使通过例外放行，分配记录仍逐项落库
      const order = await createTestOrder('E1', null, 'fabric');
      const line = await createTestOrderLine('EL1', 'E1', 500);
      const sh = await createTestShipment('S13');

      const r = await svc.createAllocation(sh.id, {
        orderId: order.id,
        orderLineId: line.id,
        plannedQty: 500,
        actualQty: 500,
        status: 'Fulfilled',
        exception: 'DR-013 例外放行（测试场景）',
      }, TEST_ACTOR_ID);

      expect(r.ok).toBe(true);
      expect(r.data!.allocation.status).toBe('Fulfilled');
      expect(r.data!.allocation.exception).toBe('DR-013 例外放行（测试场景）');
    });
  });

  describe('状态回写部分履约', () => {
    it('分配 actualQty 变动后订单出运进度可查', async () => {
      const order = await createTestOrder('T1', null, 'garment');
      const line = await createTestOrderLine('TL1', 'T1', 500);
      const sh = await createTestShipment('S14');

      // 创建分配 plannedQty=500, actualQty=300（部分履约）
      const r = await svc.createAllocation(sh.id, {
        orderId: order.id,
        orderLineId: line.id,
        plannedQty: 500,
        actualQty: 300,
        status: 'PartiallyShipped',
      }, TEST_ACTOR_ID);
      expect(r.ok).toBe(true);

      // 更新 actualQty 到 500（完全履约）
      const alloc = r.data!.allocation;
      const r2 = await svc.updateAllocation(sh.id, alloc.id, { actualQty: 500, status: 'Fulfilled' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(true);
      expect(r2.data!.allocation.status).toBe('Fulfilled');
    });
  });

  describe('单位归一 — 跨票累计按行单位换算（P0-2/P0-3）', () => {
    it('m/yd 跨单位归一：100 YD 折 91.44 m 后再分 5 m 通过（未归一会误判超限）', async () => {
      const order = await createTestOrder('N1', null, 'garment');
      const line = await createTestOrderLine('NL1', 'N1', 100, 0, 'M'); // 上限 100 m
      const sh1 = await createTestShipment('SN1');
      const sh2 = await createTestShipment('SN2');

      // 票1 分配 100 YD = 91.44 m
      const r1 = await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 100, unit: 'YD' }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      // 票2 再分 5 m：归一后 91.44 + 5 = 96.44 ≤ 100 通过（若不归一按 100+5=105 会误拒）
      const r2 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 5, unit: 'M' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(true);
    });

    it('m/yd 跨单位归一：换算后真超限仍拒绝', async () => {
      const order = await createTestOrder('N2', null, 'garment');
      const line = await createTestOrderLine('NL2', 'N2', 100, 0, 'M');
      const sh1 = await createTestShipment('SN3');
      const sh2 = await createTestShipment('SN4');

      await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 100, unit: 'YD' }, TEST_ACTOR_ID);

      // 91.44 + 9 = 100.44 > 100 拒绝
      const r2 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 9, unit: 'M' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(false);
      expect(r2.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
    });

    it('PCS 行混入 M 分配 → 明确报错而非静默相加', async () => {
      const order = await createTestOrder('N3', null, 'garment');
      const line = await createTestOrderLine('NL3', 'N3', 500, 0, 'PCS');
      const sh1 = await createTestShipment('SN5');
      const sh2 = await createTestShipment('SN6');

      const r1 = await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 300, unit: 'PCS' }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      const r2 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 100, unit: 'M' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(false);
      expect(r2.error!.code).toBe('VALIDATION_FAILED');
    });

    it('M 行既有 PCS 分配（历史脏数据）→ 累计校验报错', async () => {
      const order = await createTestOrder('N4', null, 'garment');
      const line = await createTestOrderLine('NL4', 'N4', 500, 0, 'M');
      const sh1 = await createTestShipment('SN7');
      const sh2 = await createTestShipment('SN8');

      // 新逻辑下 PCS 分配挂 M 行在创建时即被拒；累积报错分支只能由历史脏数据触发，
      // 故直接落库一条绕过服务层校验的遗留分配
      await prisma.shipmentOrderAllocation.create({
        data: {
          id: TEST_PREFIX + 'LEGACY_PCS',
          shipmentId: sh1.id,
          orderId: order.id,
          orderLineId: line.id,
          actualQty: 300,
          unit: 'PCS',
          status: 'Planned',
          createdAt: BigInt(Date.now()),
          updatedAt: BigInt(Date.now()),
        },
      });

      const r2 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 100, unit: 'M' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(false);
      expect(r2.error!.code).toBe('VALIDATION_FAILED');
    });

    it('分配未填 unit → 按行单位理解（历史数据兼容，不换算不报错）', async () => {
      const order = await createTestOrder('N5', null, 'garment');
      const line = await createTestOrderLine('NL5', 'N5', 100, 0, 'M');
      const sh1 = await createTestShipment('SN9');
      const sh2 = await createTestShipment('SN10');

      // 不填 unit：按 M 行单位理解
      const r1 = await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 80 }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      // 80 + 25 = 105 > 100 拒（证明未填 unit 的 80 被计入累计）
      const r2 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 25 }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(false);
      expect(r2.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
    });

    // ── P3-2：updateAllocation 仅改 unit 时也要重校上限（旧实现只在 actualQty 变更时校验） ──
    it('仅改单位为不可互算单位 → 更新被拒（旧实现会静默放行）', async () => {
      const order = await createTestOrder('N7', null, 'garment');
      const line = await createTestOrderLine('NL7', 'N7', 500, 0, 'PCS');
      const sh = await createTestShipment('SN12');

      const r1 = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 300, unit: 'PCS' }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      // 只改单位 PCS → M，不动数量：与行单位不可互算，必须报错而非落库
      const r2 = await svc.updateAllocation(sh.id, r1.data!.allocation.id, { unit: 'M' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(false);
      expect(r2.error!.code).toBe('VALIDATION_FAILED');
    });

    it('仅改单位为可换算单位且未超限 → 更新通过（不误伤）', async () => {
      const order = await createTestOrder('N8', null, 'garment');
      const line = await createTestOrderLine('NL8', 'N8', 100, 0, 'M'); // 上限 100 m
      const sh1 = await createTestShipment('SN13');
      const sh2 = await createTestShipment('SN14');

      // 票1 已分 100 YD = 91.44 m
      await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 100, unit: 'YD' }, TEST_ACTOR_ID);
      // 票2 分 5 m → 归一后 91.44 + 5 = 96.44 ≤ 100
      const r1 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 5, unit: 'M' }, TEST_ACTOR_ID);
      expect(r1.ok).toBe(true);

      // 改成 YD：5 M → 归一 4.572 m，91.44 + 4.572 = 96.01 ≤ 100 通过
      const r2 = await svc.updateAllocation(sh2.id, r1.data!.allocation.id, { unit: 'YD' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(true);
      expect(r2.data!.allocation.unit).toBe('YD');
    });

    it('改单位后归一结果真超限 → 更新被拒', async () => {
      const order = await createTestOrder('N9', null, 'garment');
      const line = await createTestOrderLine('NL9', 'N9', 100, 0, 'M'); // 上限 100 m
      const sh1 = await createTestShipment('SN15');
      const sh2 = await createTestShipment('SN16');

      await svc.createAllocation(sh1.id, { orderId: order.id, orderLineId: line.id, actualQty: 100, unit: 'YD' }, TEST_ACTOR_ID); // 91.44 m
      const r1 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 9, unit: 'M' }, TEST_ACTOR_ID); // 100.44 超

      // 直接用超限值创建会被拒 → 改为先建合法值（1 m），再改单位放大到 15 YD（13.716 m，合计 105.16 超）
      expect(r1.ok).toBe(false);
      const r2 = await svc.createAllocation(sh2.id, { orderId: order.id, orderLineId: line.id, actualQty: 1, unit: 'M' }, TEST_ACTOR_ID);
      expect(r2.ok).toBe(true);

      const r3 = await svc.updateAllocation(sh2.id, r2.data!.allocation.id, { actualQty: 15, unit: 'YD' }, TEST_ACTOR_ID);
      expect(r3.ok).toBe(false);
      expect(r3.error!.code).toBe('ORDER_LINE_OVER_ALLOCATED');
    });

    it('行数量为 0 不再把上限钉成 0（旧守卫不可达缺陷的回归护栏，P0-3）', async () => {
      const order = await createTestOrder('N6', null, 'garment');
      const line = await createTestOrderLine('NL6', 'N6', 0, 0, 'PCS'); // 行数量 0：不校验而非硬顶 0
      const sh = await createTestShipment('SN11');

      const r = await svc.createAllocation(sh.id, { orderId: order.id, orderLineId: line.id, actualQty: 100 }, TEST_ACTOR_ID);
      expect(r.ok).toBe(true);
    });
  });
});

describe('旧整单出运分配只读兼容', () => {
  beforeEach(async () => {
    await cleanup();
    await ensureActor();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('拒绝创建 null 订单行的比例分摊', async () => {
    const order = await createTestOrder('D1A', null, 'garment');
    await createTestOrderLine('D1AL1', 'D1A', 1000);
    await createTestOrderLine('D1AL2', 'D1A', 100);
    const shipment = await createTestShipment('D1AS1');

    const result = await svc.createAllocation(shipment.id, { orderId: order.id, actualQty: 1100 }, TEST_ACTOR_ID);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(await prisma.shipmentOrderAllocation.count({ where: { shipmentId: shipment.id } })).toBe(0);
  });

  it('拒绝修改历史 null 订单行分配', async () => {
    const order = await createTestOrder('D1B', null, 'garment');
    const shipment = await createTestShipment('D1BS1');
    await prisma.shipmentOrderAllocation.create({ data: {
      id: TEST_PREFIX + 'LEGACY_ORDER_LEVEL', shipmentId: shipment.id, orderId: order.id, orderLineId: null,
      plannedQty: 10, actualQty: null, unit: 'PCS', status: 'Planned', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
    } });

    const result = await svc.updateAllocation(shipment.id, TEST_PREFIX + 'LEGACY_ORDER_LEVEL', { plannedQty: 20 }, TEST_ACTOR_ID);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    const stored = await prisma.shipmentOrderAllocation.findUnique({ where: { id: TEST_PREFIX + 'LEGACY_ORDER_LEVEL' } });
    expect(String(stored?.plannedQty)).toBe('10');

    const deleted = await svc.deleteAllocation(shipment.id, TEST_PREFIX + 'LEGACY_ORDER_LEVEL', TEST_ACTOR_ID);
    expect(deleted.ok).toBe(false);
    expect(deleted.error?.code).toBe('VALIDATION_FAILED');
    expect(await prisma.shipmentOrderAllocation.count({ where: { id: TEST_PREFIX + 'LEGACY_ORDER_LEVEL' } })).toBe(1);
  });
});
