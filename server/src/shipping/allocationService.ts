/**
 * DR-016 合票建模 — ShipmentOrderAllocation 分配记录服务
 *
 * 职责：
 *   1. 分配记录 CRUD（POST/DELETE/PATCH）
 *   2. 合票校验：同客户同业务线（assertConsolidationAllowed）
 *   3. 跨票累计上限：ORDER_LINE_OVER_ALLOCATED
 *   4. Shipment.orderId 投影维护（首条分配 orderId）
 *
 * 设计原则：
 *   - 服务工厂模式 createAllocationService(prisma)
 *   - 事务内操作，审计失败即回滚（fail-closed）
 *   - 无软删：随 Shipment 软删过滤
 */

import { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { lockLegacyShipmentAllocationWrite } from './shipmentPhysicalAllocationService';
import { isBusinessError } from '../shared/errorCodes';
import { writeRouteAuditLog } from '../audit/routeAudit';
import { round4 } from '../lib/unitConversion';
import { normalizeQtyToBase } from '../shared/qtyUnit';
import { lineShares, syncOrderLineShipmentQuantity } from '../shared/orderLineShippedQty';
import { SHIPPED_SHIPMENT_STATUSES } from '../shared/shippingLock';
import {
  loadToleranceStandards,
  resolveLineTolerance,
  gateToleranceOf,
  TOLERANCE_SOURCE_LABELS,
  type GateTolerance,
  type LoadedToleranceStandards,
} from '../orders/toleranceStandardService';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export type AllocationErrorCode =
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'ACCOUNT_DISABLED'
  | 'FORBIDDEN'
  | 'AUTHORIZATION_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'SHIPMENT_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  | 'ALLOCATION_NOT_FOUND'
  | 'CONSOLIDATION_CUSTOMER_MISMATCH'
  | 'CONSOLIDATION_BUSINESS_LINE_MISMATCH'
  | 'ORDER_LINE_OVER_ALLOCATED'
  | 'ALLOCATION_DUPLICATE' // ★ 同票同订单（行）重复分配（A4，2026-09-18）
  | 'SHIPMENT_ALREADY_SHIPPED' // ★ 已发运后禁改/禁删实际出运量（A1 + A1-b，2026-09-18）
  | 'VALIDATION_FAILED'
  | 'CREATE_FAILED'
  | 'UPDATE_FAILED'
  | 'DELETE_FAILED';

export interface AllocationResult<T = any> {
  ok: boolean;
  data?: T;
  error?: { code: AllocationErrorCode; message: string; status?: number };
}

export interface AllocationInput {
  orderId: string;
  orderLineId?: string | null;
  plannedQty?: number | string | null;
  actualQty?: number | string | null;
  unit?: string | null;
  status?: string;
  batchOrCartonNote?: string | null;
  exception?: string | null;
}

export interface AllocationPatch {
  plannedQty?: number | string | null;
  actualQty?: number | string | null;
  unit?: string | null;
  status?: string;
  batchOrCartonNote?: string | null;
  exception?: string | null;
}

const ALLOCATION_STATUSES = new Set(['Planned', 'PartiallyShipped', 'Fulfilled', 'ShortShipped', 'Cancelled']);

/**
 * ★★ 已发运锁定态：这些状态下的运单**禁止再改实际出运量**（2026-09-18 · A1）
 *
 * 为什么必须锁：改 `actualQty` 会同时影响① 库存扣减 ② 开票金额 ③ 批次结算，
 * 但原实现**只校跨票累计上限**，既不回冲库存、也不联动已开票额
 * ⇒ **货发走之后改一个数字，账就静默地变了**（不报错，最高危）。
 *
 * ★ 出口确认（加锁前必做，否则制造死锁）：本仓运单有 `Cancelled` 出口且
 *   **取消会反向入库**（`shipmentMutationService` 取消路径）⇒
 *   「数量填错了」的正确路径是 **取消运单 → 重新建票**，不是原地改数。
 *   出口存在 ⇒ 可以硬挡。
 */
// ★ 已发运判据收口到 shared/shippingLock（本仓曾有 3 处各写一份，改一处忘一处 = 收口点错位）
const SHIPPED_LOCKED_STATUSES = new Set<string>(SHIPPED_SHIPMENT_STATUSES);

function fail<T>(code: AllocationErrorCode, message: string): AllocationResult<T> {
  return { ok: false, error: { code, message } };
}

function newId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function toDecimal(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 数量单位归一已收口到 shared/qtyUnit（C3：订单行「已出运量」也要按同一口径折算，
// 各写一份会出现「上限校验说超了、容差面板说没超」的同数不同判）

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createAllocationService(prisma: PrismaClient) {
  const db = prisma as any;
  const now = () => Date.now();

  /**
   * 加载票并验证未软删
   */
  async function loadShipment(t: any, shipmentId: string) {
    const sh = await t.shipment.findUnique({
      where: { id: shipmentId },
      // ★ status 是「是否已发运」判据所需（A1 静默改账守卫，2026-09-18）
      select: { id: true, deletedAt: true, orderId: true, status: true },
    });
    if (!sh || sh.deletedAt) {
      throw Object.assign(new Error(`运单 ${shipmentId} 不存在或已删除`), { code: 'SHIPMENT_NOT_FOUND' });
    }
    return sh;
  }

  /**
   * 加载订单并验证未软删
   */
  async function loadOrder(t: any, orderId: string) {
    const order = await t.order.findUnique({
      where: { id: orderId },
      select: { id: true, deletedAt: true, customerRelationId: true, businessLine: true, customer: true },
    });
    if (!order || order.deletedAt) {
      throw Object.assign(new Error(`订单 ${orderId} 不存在或已删除`), { code: 'ORDER_NOT_FOUND' });
    }
    return order;
  }

  /**
   * 合票校验：来源订单必须同客户、同收货方、同业务板块
   * 任一不符抛 CONSOLIDATION_CUSTOMER_MISMATCH / CONSOLIDATION_BUSINESS_LINE_MISMATCH
   */
  async function assertConsolidationAllowed(t: any, shipmentId: string): Promise<void> {
    const allocations = await t.shipmentOrderAllocation.findMany({
      where: { shipmentId },
      select: { orderId: true },
    });
    if (allocations.length <= 1) return; // 单票或空票无需校验

    const orderIds = [...new Set(allocations.map((a: any) => a.orderId))];
    const orders = await t.order.findMany({
      where: { id: { in: orderIds }, deletedAt: null },
      select: { id: true, customerRelationId: true, businessLine: true, customer: true,
        consigneeRelationId: true, consigneeName: true, shipToName: true },
    });

    if (orders.length !== orderIds.length) {
      const found = new Set(orders.map((o: any) => o.id));
      const missing = orderIds.filter(id => !found.has(id));
      throw Object.assign(
        new Error(`合票校验失败：订单 ${missing.join(', ')} 不存在或已删除`),
        { code: 'ORDER_NOT_FOUND' },
      );
    }

    const first = orders[0];
    const identity = (relationId: unknown, label: unknown) => {
      if (typeof relationId === 'string' && relationId.trim()) return `id:${relationId.trim()}`;
      return typeof label === 'string' && label.trim() ? `name:${label.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}` : null;
    };
    const firstConsignee = identity(first.consigneeRelationId, first.consigneeName ?? first.shipToName);
    if (!firstConsignee) throw Object.assign(new Error('合票来源订单缺少明确收货方'), { code: 'CONSOLIDATION_CONSIGNEE_MISMATCH' });
    for (let i = 1; i < orders.length; i++) {
      const o = orders[i];
      // customerRelationId 为 null 时用 customer name 兜底比较（兼容旧数据）
      const firstCustomer = identity(first.customerRelationId, first.customer);
      const currCustomer = identity(o.customerRelationId, o.customer);
      if (firstCustomer !== currCustomer) {
        throw Object.assign(
          new Error(`合票校验失败：订单 ${o.id} 签约客户与首单不一致（仅同客户允许合票）`),
          { code: 'CONSOLIDATION_CUSTOMER_MISMATCH' },
        );
      }
      if (identity(o.consigneeRelationId, o.consigneeName ?? o.shipToName) !== firstConsignee) {
        throw Object.assign(new Error(`合票校验失败：订单 ${o.id} 收货方与首单不一致（仅同收货方允许合票）`),
          { code: 'CONSOLIDATION_CONSIGNEE_MISMATCH' });
      }
      const firstLine = first.businessLine ?? 'other';
      const currLine = o.businessLine ?? 'other';
      if (firstLine !== currLine) {
        throw Object.assign(
          new Error(`合票校验失败：订单 ${o.id} 业务线（${currLine}）与首单（${firstLine}）不一致，禁止合票`),
          { code: 'CONSOLIDATION_BUSINESS_LINE_MISMATCH' },
        );
      }
    }
  }

  /**
   * ★★ 口径 D1（2026-09-17 业务方拍板）：整单分配按**行数量比例**分摊的**唯一实现**。
   *
   * 两个分支（整单分配校验 / 行级分支计入整单分配）**必须共用本函数** ——
   * 各写一份必然漂移（本仓已多次踩过「收口点错位」）。
   *
   * ── 修前的「按行数均分」为什么错（两个方向相反）──────
   * `perLineQty = 本次量 / lines.length`：
   *   · 行数量**低于均值**的行 → 均分**高估**其份额 ⇒ **误拒**
   *     （例：订单 1000+100 两行，整单分配 1100 → 均分 550 > 100 ⇒ 拒，但它其实合法）
   *   · 行数量**高于均值**的行 → 均分**低估** ⇒ **校验形同虚设**
   *
   * ── 兜底 ─────────────────────────────────────────────
   * 所有行数量都缺失/非法（`total <= 0`）时**退回均分** —— 与修前行为一致，
   * 避免除零，也避免"数据缺失时全拒"。
   */
  // lineShares 已收口到 shared/orderLineShippedQty（C3：订单行已出运量快照要用同一分摊口径，
  // 各写一份会让「上限校验」与「容差面板」对同一批货给出不同结论）

  /**
   * 跨票累计上限校验：该 orderLine 全部分配（排除已取消票）actualQty 按 OrderLine.unit 归一后累计 + 本次 ≤ OrderLine.quantity × (1 + tolerancePercent/100)
   * 溢短装条款（REQ2-03，OrderLine.tolerancePercent 默认 ±5%）纳入上限：客户合同 +5% 溢装时 +3% 出运合法；
   * null/undefined 容差按 0 处理（足量交付）。整单分配（orderLineId=null）按订单行汇总同规则。
   * 单位口径：m/yd 跨单位用 lib/unitConversion 换算；PCS/KG 等与长度不可互算 → VALIDATION_FAILED 报错（报错优于算错）。
   */
  /**
   * ★★ A4（2026-09-18）：同票同订单（行）**不得重复分配**
   *
   * 为什么必须在服务层挡（DB 挡不住）：
   *   schema 唯一键 `[shipmentId, orderId, orderLineId]` 含**可空** `orderLineId`，
   *   而 **PostgreSQL 的唯一约束把 NULL 视为互不相同** ⇒ 整单分配（orderLineId IS NULL）
   *   **可以无限插**。同一票同一订单插 N 条整单分配 ⇒ 出运量/开票量/批次结算被**重复计 N 次**，
   *   且全程不报错（静默错账，A 类里最脏的一种）。
   *
   * 两种重复都挡：
   *   ① 完全同键（含 NULL 分支）→ 直接拒
   *   ② 粒度混用：已存在「整单分配」又插「行级分配」（或反过来）→ 同一批货被计两次，同样拒
   *
   * ★ 出口确认（加护栏前必做，否则制造死锁）：
   *   要改量 = PATCH 那条；要拆到行 = 先 DELETE 整单那条再建。DELETE 无 shipped 外的门槛 ⇒
   *   出口存在，可以硬挡。
   *
   * ⓘ 已知残留（诚实声明）：并发双写仍有极小窗口（检查与插入之间，READ COMMITTED）。
   *   根治要加 partial unique index（`WHERE orderLineId IS NULL`），但生产库存在历史重复行时
   *   建索引会**直接让迁移失败、打断部署** ⇒ 本轮不迁，留给运维在清完重复行之后再加。
   */
  async function assertNoDuplicateAllocation(
    t: any,
    shipmentId: string,
    orderId: string,
    orderLineId: string | null,
  ): Promise<void> {
    const existing: Array<{ id: string; orderLineId: string | null }> =
      await t.shipmentOrderAllocation.findMany({
        where: { shipmentId, orderId },
        select: { id: true, orderLineId: true },
      });
    if (existing.length === 0) return;

    const exact = existing.find(a => (a.orderLineId ?? null) === orderLineId);
    if (exact) {
      const scope = orderLineId ? `订单行 ${orderLineId}` : '整单';
      throw Object.assign(
        new Error(`该票已有此订单的${scope}分配（${exact.id}）：同一票同一订单（行）只能有一条分配。要改量请直接改那条，要拆到行请先删除整单分配再建`),
        { code: 'ALLOCATION_DUPLICATE' },
      );
    }

    const hasOrderLevel = existing.some(a => a.orderLineId == null);
    const hasLineLevel = existing.some(a => a.orderLineId != null);
    // ② 粒度混用：本次插入必然是「另一粒度」（完全同键已在上面拒掉）
    if ((orderLineId == null && hasLineLevel) || (orderLineId != null && hasOrderLevel)) {
      throw Object.assign(
        new Error('同一票同一订单不得同时存在「整单分配」与「行级分配」（同一批货会被计两次）。请先删除其中一种，再按统一粒度重建'),
        { code: 'ALLOCATION_DUPLICATE' },
      );
    }
  }

  /**
   * ★ 2026-09-29：取该订单的公差标准上下文（**客户标准 P0 + 内部标准辅助**）。
   *   · 一次调用只查一次 —— 避免逐行 N+1。
   *   · 用**事务客户端 `t`** 读，保证与本次分配同一快照。
   */
  async function loadToleranceContext(t: any, orderId: string): Promise<LoadedToleranceStandards> {
    const order = await t.order.findUnique({
      where: { id: orderId },
      select: { customerRelationId: true },
    });
    return loadToleranceStandards(t, { customerRelationId: order?.customerRelationId ?? null });
  }

  /**
   * ★★ 2026-09-29：出运上限用的公差口径 —— **唯一入口**。
   *
   * 修前：`line.tolerancePercent == null ? 0 : Number(...)` —— 直接拿行上那个数，
   *   而那个数（5）是 `@default` 填的、**不是合同约定** ⇒ 5001m 的单按 5% 放行（合同只许 ±1%）。
   * 修后：走「**客户标准(P0) → 内部标准(辅助) → 未判定 ⇒ 按 0 不放溢装**」的取数链。
   * ★ 与订单视图（`toleranceService`）共用同一个解析器 ⇒ **不再各写各的回退值**。
   */
  function gateForLine(
    ctx: LoadedToleranceStandards,
    line: { tolerancePercent: unknown; toleranceSource?: string | null },
    lineQty: number,
  ): GateTolerance {
    return gateToleranceOf(resolveLineTolerance(line, ctx, { measure: lineQty }));
  }

  /** 错误消息里的容差说明 —— ★ 未判定时**不许**写「+0%」（那是误导） */
  function tolerancePhrase(gate: GateTolerance, allowedMax: number): string {
    if (gate.unresolvedReason) {
      // ★ 2026-09-29 晚：出厂默认上线后，「未判定」已**不再是"没人录"** ——
      //   它现在只来自 ① 客户标准读不到 ② 内部标准配置损坏 ③ 数量落在档位空档外。
      //   所以话术必须指向"去核对"，而不是让人以为"去录一下就好了"。
      return `★ 本行**没有可用的溢短装容差标准**（客户标准读不到 / 内部标准配置损坏 / 数量落在标准表档位空档外）⇒ 按「不放溢装」处理，上限 ${allowedMax}；请核对「设置 → 平台规则 → 内部公差标准」与该客户档案中的客户标准`;
    }
    return `溢短装容差 +${gate.pct}%（来源：${TOLERANCE_SOURCE_LABELS[gate.source]}），上限 ${allowedMax}`;
  }

  async function assertOrderLineNotOverAllocated(
    t: any,
    shipmentId: string,
    orderId: string,
    orderLineId: string | null,
    newActualQty: number | null,
    newUnit: string | null | undefined,
  ): Promise<void> {
    if (newActualQty === null || newActualQty === undefined) return; // 无实际数量不校验

    if (orderLineId) {
      // 行级分配：校验该行跨票累计
      const line = await t.orderLine.findUnique({ where: { id: orderLineId }, select: { orderId: true, quantity: true, tolerancePercent: true, toleranceSource: true, unit: true } });
      if (!line) {
        throw Object.assign(new Error(`订单行 ${orderLineId} 不存在`), { code: 'VALIDATION_FAILED' });
      }
      // 行数量缺失/非法 → 不校验（保留「未设置不校验」原意；注意 Number(null)=0、Number(undefined)=NaN，
      // 旧写法 `lineQty === null` 永不可达，会让 allowedMax=0 拒掉一切正数分配）
      const lineQty = Number(line.quantity);
      if (!Number.isFinite(lineQty) || lineQty <= 0) return;
      // ★ 2026-09-29：容差口径改走标准链（客户标准 P0 → 内部标准辅助 → 未判定按 0 不放溢装）
      const tolCtx = await loadToleranceContext(t, line.orderId);
      const gate = gateForLine(tolCtx, line, lineQty);
      const allowedMax = round4(lineQty * (1 + gate.pct / 100));

      // 排除已取消票（Cancelled 状态的 Shipment 不计入累计）
      const allocations = await t.shipmentOrderAllocation.findMany({
        where: {
          orderLineId,
          shipmentId: { not: shipmentId }, // 排除本票
        },
        select: { actualQty: true, unit: true, shipmentId: true },
      });
      const shipmentIds = [...new Set(allocations.map((a: any) => a.shipmentId))];
      const shipments = await t.shipment.findMany({
        where: { id: { in: shipmentIds }, deletedAt: null },
        select: { id: true, status: true },
      });
      const activeShipmentIds = new Set(
        shipments.filter((s: any) => s.status !== 'Cancelled').map((s: any) => s.id),
      );

      // 累计必须按行单位归一后相加（m/yd 换算；PCS/KG 等与长度不可互算 → 报错而非静默相加）
      const baseActualQty = normalizeQtyToBase(newActualQty, newUnit, line.unit);
      if (baseActualQty === null) {
        throw Object.assign(
          new Error(`分配单位「${newUnit}」与订单行单位「${line.unit ?? '未设置'}」不可互算，禁止混用单位分配`),
          { code: 'VALIDATION_FAILED' },
        );
      }
      let cumulative = 0;
      for (const a of allocations) {
        if (!activeShipmentIds.has(a.shipmentId)) continue;
        const qty = Number(a.actualQty) || 0;
        if (qty === 0) continue;
        const normalized = normalizeQtyToBase(qty, a.unit, line.unit);
        if (normalized === null) {
          throw Object.assign(
            new Error(`跨票累计校验失败：订单行 ${orderLineId} 既有分配（票 ${a.shipmentId}）单位「${a.unit ?? '未设置'}」与行单位「${line.unit ?? '未设置'}」不可互算，禁止混用单位分配`),
            { code: 'VALIDATION_FAILED' },
          );
        }
        cumulative += normalized;
      }

      // ★★ 口径 D1（2026-09-17 业务方拍板）：**行级分支必须把「整单分配」按行数量比例计入累计**。
      //
      // 缺口（修前）：上面的 `allocations` 查询只按 `orderLineId` 过滤，而**整单分配**
      //   （`orderLineId = null`）看不见 ⇒ 「先整单分配满额、再逐行分配」可**双重分配**
      //   （两套账各算各的，谁都不超限，合计却超了）。
      // 修法：把该订单的整单分配按**行数量比例**归到本行 —— 份额口径与整单分支**同一份**
      //   （`lineShares`），不另写一套。
      // ⚠️ 本修会让校验**变严**（原来能过的"整单满额 + 行级再分"会被拒）——
      //   这是口径明示的意图；已按口径要求做**真库只读核对**（见提交说明）。
      if (line.orderId) {
        const siblingLines = await t.orderLine.findMany({
          where: { orderId: line.orderId },
          select: { id: true, quantity: true },
        });
        const wholeOrderAllocations = await t.shipmentOrderAllocation.findMany({
          where: { orderId: line.orderId, orderLineId: null, shipmentId: { not: shipmentId } },
          select: { actualQty: true, unit: true, shipmentId: true },
        });
        const wholeShipmentIds = [...new Set(wholeOrderAllocations.map((a: any) => a.shipmentId))];
        const wholeShipments = await t.shipment.findMany({
          where: { id: { in: wholeShipmentIds }, deletedAt: null },
          select: { id: true, status: true },
        });
        const activeWholeIds = new Set(
          wholeShipments.filter((s: any) => s.status !== 'Cancelled').map((s: any) => s.id),
        );
        let totalWhole = 0;
        for (const a of wholeOrderAllocations) {
          if (!activeWholeIds.has(a.shipmentId)) continue;
          const qty = Number(a.actualQty) || 0;
          if (qty === 0) continue;
          const normalized = normalizeQtyToBase(qty, a.unit, line.unit);
          if (normalized === null) {
            throw Object.assign(
              new Error(`跨票累计校验失败：订单 ${line.orderId} 整单分配（票 ${a.shipmentId}）单位「${a.unit ?? '未设置'}」与行单位「${line.unit ?? '未设置'}」不可互算，禁止混用单位分配`),
              { code: 'VALIDATION_FAILED' },
            );
          }
          totalWhole += normalized;
        }
        cumulative += totalWhole * (lineShares(siblingLines).get(orderLineId) ?? 0);
      }

      if (cumulative + baseActualQty > allowedMax) {
        throw Object.assign(
          new Error(
            `跨票累计超限：订单行 ${orderLineId} 可出运量 ${lineQty}${line.unit ? ` ${line.unit}` : ''}（${tolerancePhrase(gate, allowedMax)}），已分配 ${round4(cumulative)}，本次 ${round4(baseActualQty)} 超出`,
          ),
          { code: 'ORDER_LINE_OVER_ALLOCATED' },
        );
      }
    } else {
      // 整单分配：按订单所有行汇总校验
      // 查询条件：该订单的所有分配（包括行级分配和整单分配），排除已取消票
      const lines = await t.orderLine.findMany({
        where: { orderId },
        select: { id: true, quantity: true, tolerancePercent: true, toleranceSource: true, unit: true },
      });
      if (lines.length === 0) return; // 无行不校验
      // ★ 2026-09-29：公差标准上下文**只查一次**（整单分支逐行复用，避免 N+1）
      const tolCtx = await loadToleranceContext(t, orderId);

      // 查询该订单的所有分配（行级 + 整单级），排除本票
      const allAllocations = await t.shipmentOrderAllocation.findMany({
        where: {
          orderId,
          shipmentId: { not: shipmentId },
        },
        select: { actualQty: true, unit: true, shipmentId: true, orderLineId: true },
      });
      const shipmentIds = [...new Set(allAllocations.map((a: any) => a.shipmentId))];
      const shipments = await t.shipment.findMany({
        where: { id: { in: shipmentIds }, deletedAt: null },
        select: { id: true, status: true },
      });
      const activeShipmentIds = new Set(
        shipments.filter((s: any) => s.status !== 'Cancelled').map((s: any) => s.id),
      );
      const activeAllocations = allAllocations.filter((a: any) => activeShipmentIds.has(a.shipmentId));

      // 单位归一：统一到本次分配的单位空间再比较（m/yd 换算；混用不可互算单位 → 报错而非静默相加）
      let totalAllocated = 0;
      for (const a of activeAllocations) {
        const qty = Number(a.actualQty) || 0;
        if (qty === 0) continue;
        const normalized = normalizeQtyToBase(qty, a.unit, newUnit);
        if (normalized === null) {
          throw Object.assign(
            new Error(`跨票累计校验失败：订单 ${orderId} 既有分配（票 ${a.shipmentId}）单位「${a.unit ?? '未设置'}」与本次分配单位「${newUnit ?? '未设置'}」不可互算，禁止混用单位分配`),
            { code: 'VALIDATION_FAILED' },
          );
        }
        totalAllocated += normalized;
      }
      // ★ 口径 D1：按**行数量比例**分摊（取代原「按行数均分」—— 均分会误拒低量行、且对高量行形同虚设）
      const shares = lineShares(lines);

      for (const line of lines) {
        // 行数量缺失/非法 → 跳过该行（保留「未设置不校验」原意；旧守卫 Number(null)=0 永不可达）
        const lineQty = Number(line.quantity);
        if (!Number.isFinite(lineQty) || lineQty <= 0) continue;
        // ★ 2026-09-29：容差口径改走标准链（客户标准 P0 → 内部标准辅助 → 未判定按 0）
        const gate = gateForLine(tolCtx, line, lineQty);
        // 行上限换算到本次分配的单位空间；不可互算（如行 PCS vs 分配 M）→ 报错优于算错
        const baseLineQty = normalizeQtyToBase(lineQty, line.unit, newUnit);
        if (baseLineQty === null) {
          throw Object.assign(
            new Error(`跨票累计校验失败：订单 ${orderId} 行 ${line.id} 单位「${line.unit ?? '未设置'}」与本次分配单位「${newUnit ?? '未设置'}」不可互算，禁止混用单位分配`),
            { code: 'VALIDATION_FAILED' },
          );
        }
        const allowedMax = round4(baseLineQty * (1 + gate.pct / 100));

        // ★ 本行的份额（按行数量比例）
        const share = shares.get(line.id) ?? 0;
        const perLineAllocated = totalAllocated * share;
        const perLineQty = newActualQty * share;

        if (perLineAllocated + perLineQty > allowedMax) {
          throw Object.assign(
            new Error(
              `跨票累计超限：订单 ${orderId} 行 ${line.id} 可出运量 ${lineQty}${line.unit ? ` ${line.unit}` : ''}（${tolerancePhrase(gate, allowedMax)}），已按行量比例分摊 ${perLineAllocated.toFixed(4)}，本次分摊 ${perLineQty.toFixed(4)} 超出`,
            ),
            { code: 'ORDER_LINE_OVER_ALLOCATED' },
          );
        }
      }
    }
  }

  /**
   * 维护 Shipment.orderId 投影（= 票内第一条分配的 orderId）
   */
  async function syncShipmentOrderIdProjection(t: any, shipmentId: string): Promise<void> {
    const first = await t.shipmentOrderAllocation.findFirst({
      where: { shipmentId },
      orderBy: { createdAt: 'asc' },
      select: { orderId: true },
    });
    // D8-Q3 品类下沉：businessLine 随主订单投影派生回填（合票边界已校验同业务线，取首单一致）
    let businessLine: string | null = null;
    if (first?.orderId) {
      const order = await t.order.findUnique({ where: { id: first.orderId }, select: { businessLine: true } });
      businessLine = order?.businessLine ?? null;
    }
    await t.shipment.update({
      where: { id: shipmentId },
      data: { orderId: first?.orderId ?? null, businessLine },
    });
  }

  /**
   * 新增分配记录
   */
  async function createAllocation(
    shipmentId: string,
    input: AllocationInput,
    actorId: string,
    ip?: string | null,
    options?: { actor?: TokenPayload | null },
  ): Promise<AllocationResult<{ allocation: any }>> {
    // Order fulfilment is line-granular. Legacy order-level allocations remain
    // readable for history, but must not be newly created and proportionally
    // distributed across lines by the old projection logic.
    if (typeof input.orderLineId !== 'string' || !input.orderLineId.trim()) {
      return fail('VALIDATION_FAILED', '出运分配必须明确绑定准确订单行；整单比例分摊已停用。');
    }
    try {
      const result = await db.$transaction(async (t: any) => {
        await lockLegacyShipmentAllocationWrite(t, { shipmentId, orderId: input.orderId, ...(options?.actor === undefined ? {} : { actor: options.actor }) });
        await loadShipment(t, shipmentId);
        await loadOrder(t, input.orderId);

        if (input.status && !ALLOCATION_STATUSES.has(input.status)) {
          throw Object.assign(new Error(`非法分配状态：${input.status}`), { code: 'VALIDATION_FAILED' });
        }

        const plannedQty = toDecimal(input.plannedQty);
        const actualQty = toDecimal(input.actualQty);

        // ★ A4：同票同订单（行）去重（必须在建行之前；PG 对 NULL 唯一键不互斥，DB 挡不住）
        await assertNoDuplicateAllocation(t, shipmentId, input.orderId, input.orderLineId ?? null);

        // 跨票累计上限校验
        await assertOrderLineNotOverAllocated(t, shipmentId, input.orderId, input.orderLineId ?? null, actualQty, input.unit ?? null);

        // 合票校验（新增前校验现有分配，新增后校验全量）
        await assertConsolidationAllowed(t, shipmentId);

        const id = newId('SHPA');
        const allocation = await t.shipmentOrderAllocation.create({
          data: {
            id,
            shipmentId,
            orderId: input.orderId,
            orderLineId: input.orderLineId ?? null,
            plannedQty,
            actualQty,
            unit: input.unit ?? null,
            status: input.status ?? 'Planned',
            batchOrCartonNote: input.batchOrCartonNote ?? null,
            exception: input.exception ?? null,
            createdAt: BigInt(now()),
            updatedAt: BigInt(now()),
          },
        });

        // 合票校验（含新增后的全量）
        await assertConsolidationAllowed(t, shipmentId);

        // 维护投影
        await syncShipmentOrderIdProjection(t, shipmentId);
        // ★ C3：出运事实 → 订单行已出运量快照（溢短装条款面板的数据源，此前从不被出运写入）
        await syncOrderLineShipmentQuantity(t, input.orderId);

        // 审计
        await writeRouteAuditLog({
          prisma: t,
          actorId,
          source: 'shipping-allocation',
          operation: 'ALLOCATION_CREATE',
          targetType: 'ShipmentOrderAllocation',
          targetId: id,
          after: allocation,
          ip,
        });

        return allocation;
      });
      return { ok: true, data: { allocation: result } };
    } catch (e: any) {
      if (isBusinessError(e)) return { ok: false, error: { code: e.code as AllocationErrorCode, message: String(e.message ?? e.code), status: e.statusCode } };
      return fail(e.code ?? 'CREATE_FAILED', e.message);
    }
  }

  /**
   * 更新分配记录
   */
  async function updateAllocation(
    shipmentId: string,
    allocationId: string,
    patch: AllocationPatch,
    actorId: string,
    ip?: string | null,
    options?: { actor?: TokenPayload | null },
  ): Promise<AllocationResult<{ allocation: any }>> {
    try {
      const result = await db.$transaction(async (t: any) => {
        await lockLegacyShipmentAllocationWrite(t, { shipmentId, allocationId, ...(options?.actor === undefined ? {} : { actor: options.actor }) });
        const shipment = await loadShipment(t, shipmentId);

        const existing = await t.shipmentOrderAllocation.findUnique({
          where: { id: allocationId },
        });
        if (!existing || existing.shipmentId !== shipmentId) {
          throw Object.assign(new Error(`分配记录 ${allocationId} 不存在或不属于票 ${shipmentId}`), {
            code: 'ALLOCATION_NOT_FOUND',
          });
        }

        // Preserve legacy order-level allocations as read-only history. Editing
        // one would continue the virtual proportional allocation semantics.
        if (existing.orderLineId == null) {
          throw Object.assign(new Error('历史整单分配只能查看；请按准确订单行新建分配。'), { code: 'VALIDATION_FAILED' });
        }

        // ★★ A1（2026-09-18）：已发运后**禁止改实际出运量**（含单位 —— 单位变了数量语义就变）。
        //    旧实现只校跨票累计上限，既不回冲库存、也不联动已开票额
        //    ⇒ 货发走之后改一个数字，库存/开票/结算三处**静默不同步**。
        //    数量真填错了的出口 = 取消运单（反向入库）→ 重新建票（已在 §常量注释确认出口存在）。
        if (SHIPPED_LOCKED_STATUSES.has(shipment.status)
          && (patch.actualQty !== undefined || patch.unit !== undefined)) {
          throw Object.assign(
            new Error(`运单已 ${shipment.status}（实际出运量锁定）：不得再改实际数量或单位。数量有误请「取消运单」（库存反向回冲）后重新建票`),
            { code: 'SHIPMENT_ALREADY_SHIPPED' },
          );
        }

        if (patch.status && !ALLOCATION_STATUSES.has(patch.status)) {
          throw Object.assign(new Error(`非法分配状态：${patch.status}`), { code: 'VALIDATION_FAILED' });
        }

        const plannedQty = patch.plannedQty !== undefined ? toDecimal(patch.plannedQty) : existing.plannedQty;
        const actualQty = patch.actualQty !== undefined ? toDecimal(patch.actualQty) : existing.actualQty;

        // 跨票累计上限校验（actualQty 或 unit 任一变更时）
        // 只改单位也须重校：整单分配分支以「本次分配单位」为比较空间，若放任把 M 改成 PCS 而不重算，
        // 后续跨票累计会拿新单位与既有 M 侧数量比较 → 归一函数返回 null 报错（下游 fail-closed），
        // 但本票内已按错单位落库。与其留到下游炸，不如改单位当场校验（报错优于算错，同 P0-2 取向）。
        if (patch.actualQty !== undefined || patch.unit !== undefined) {
          const effectiveUnit = patch.unit !== undefined ? (patch.unit ?? null) : existing.unit;
          await assertOrderLineNotOverAllocated(t, shipmentId, existing.orderId, existing.orderLineId, actualQty, effectiveUnit);
        }

        const before = { ...existing };
        const allocation = await t.shipmentOrderAllocation.update({
          where: { id: allocationId },
          data: {
            plannedQty,
            actualQty,
            unit: patch.unit !== undefined ? (patch.unit ?? null) : existing.unit,
            status: patch.status ?? existing.status,
            batchOrCartonNote: patch.batchOrCartonNote !== undefined ? (patch.batchOrCartonNote ?? null) : existing.batchOrCartonNote,
            exception: patch.exception !== undefined ? (patch.exception ?? null) : existing.exception,
            updatedAt: BigInt(now()),
          },
        });

        // ★ C3：改数量/单位同样要刷订单行已出运量快照（orderId 不变 ⇒ 票投影无需维护）
        await syncOrderLineShipmentQuantity(t, existing.orderId);

        // 审计
        await writeRouteAuditLog({
          prisma: t,
          actorId,
          source: 'shipping-allocation',
          operation: 'ALLOCATION_UPDATE',
          targetType: 'ShipmentOrderAllocation',
          targetId: allocationId,
          before,
          after: allocation,
          ip,
        });

        return allocation;
      });
      return { ok: true, data: { allocation: result } };
    } catch (e: any) {
      if (isBusinessError(e)) return { ok: false, error: { code: e.code as AllocationErrorCode, message: String(e.message ?? e.code), status: e.statusCode } };
      return fail(e.code ?? 'UPDATE_FAILED', e.message);
    }
  }

  /**
   * 删除分配记录
   */
  async function deleteAllocation(
    shipmentId: string,
    allocationId: string,
    actorId: string,
    ip?: string | null,
    options?: { actor?: TokenPayload | null },
  ): Promise<AllocationResult<{ allocation: any }>> {
    try {
      const result = await db.$transaction(async (t: any) => {
        await lockLegacyShipmentAllocationWrite(t, { shipmentId, allocationId, ...(options?.actor === undefined ? {} : { actor: options.actor }) });
        const shipment = await loadShipment(t, shipmentId);

        const existing = await t.shipmentOrderAllocation.findUnique({
          where: { id: allocationId },
        });
        if (!existing || existing.shipmentId !== shipmentId) {
          throw Object.assign(new Error(`分配记录 ${allocationId} 不存在或不属于票 ${shipmentId}`), {
            code: 'ALLOCATION_NOT_FOUND',
          });
        }

        if (existing.orderLineId == null) {
          throw Object.assign(new Error('历史整单分配只能查看；不能删除或改写。'), { code: 'VALIDATION_FAILED' });
        }

        // ★★ A1-b（2026-09-18）：**删**分配与**改**分配是同一个业务动作的两个入口，
        //    A1 只收口了 PATCH ⇒ 已发运后删掉一条带实际数量的分配，出运量凭空少一块，
        //    而库存已扣、发票已开、批次已结算 —— 与 A1 完全同型的静默错账。
        //    收口到同一常量（SHIPPED_LOCKED_STATUSES），不另立一套判据。
        //    ⓘ 只挡「有实际出运量」的行：planned 行删掉不影响任何已发运事实，放开以免制造死锁。
        if (SHIPPED_LOCKED_STATUSES.has(shipment.status) && Number(existing.actualQty ?? 0) > 0) {
          throw Object.assign(
            new Error(`运单已 ${shipment.status}（实际出运量锁定）：不得删除带实际出运量的分配。数量有误请「取消运单」（库存反向回冲）后重新建票`),
            { code: 'SHIPMENT_ALREADY_SHIPPED' },
          );
        }

        await t.shipmentOrderAllocation.delete({ where: { id: allocationId } });

        // 维护投影
        await syncShipmentOrderIdProjection(t, shipmentId);
        // ★ C3：删分配 → 已出运量下降，快照必须跟上
        await syncOrderLineShipmentQuantity(t, existing.orderId);

        // 审计
        await writeRouteAuditLog({
          prisma: t,
          actorId,
          source: 'shipping-allocation',
          operation: 'ALLOCATION_DELETE',
          targetType: 'ShipmentOrderAllocation',
          targetId: allocationId,
          before: existing,
          ip,
        });

        return existing;
      });
      return { ok: true, data: { allocation: result } };
    } catch (e: any) {
      if (isBusinessError(e)) return { ok: false, error: { code: e.code as AllocationErrorCode, message: String(e.message ?? e.code), status: e.statusCode } };
      return fail(e.code ?? 'DELETE_FAILED', e.message);
    }
  }

  /**
   * 列出票内分配记录
   */
  async function listAllocations(shipmentId: string): Promise<AllocationResult<{ items: any[] }>> {
    try {
      const items = await db.shipmentOrderAllocation.findMany({
        where: { shipmentId },
        orderBy: { createdAt: 'asc' },
      });
      return { ok: true, data: { items } };
    } catch (e: any) {
      return fail('NOT_FOUND', e.message);
    }
  }

  /**
   * 按订单查询分配记录（跨票）
   */
  async function listAllocationsByOrder(orderId: string): Promise<AllocationResult<{ items: any[] }>> {
    try {
      const items = await db.shipmentOrderAllocation.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      });
      // 补充票状态（用于前端过滤已取消票）
      const shipmentIds = [...new Set(items.map((a: any) => a.shipmentId))];
      const shipments = await db.shipment.findMany({
        where: { id: { in: shipmentIds }, deletedAt: null },
        select: { id: true, status: true, shipmentNumber: true },
      });
      const shipMap = new Map(shipments.map((s: any) => [s.id, s]));
      const enriched = items.map((a: any) => ({
        ...a,
        shipmentStatus: (shipMap.get(a.shipmentId) as any)?.status ?? null,
        shipmentNumber: (shipMap.get(a.shipmentId) as any)?.shipmentNumber ?? null,
      }));
      return { ok: true, data: { items: enriched } };
    } catch (e: any) {
      return fail('NOT_FOUND', e.message);
    }
  }

  return {
    createAllocation,
    updateAllocation,
    deleteAllocation,
    listAllocations,
    listAllocationsByOrder,
    assertConsolidationAllowed, // 暴露供外部（如 QC 门禁）调用
  };
}
