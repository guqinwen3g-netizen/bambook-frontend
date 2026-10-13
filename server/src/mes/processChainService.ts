/**
 * processChainService.ts — REQ2-05 面料工序级委外链（订单工序链：计划+成本核算层）
 *
 * 设计真源：docs/design/04-模块设计/03-订单与生产/ProductionBoard-生产看板/面料工序级委外链.md
 *
 * DR-047 三决策：
 *   ① 工序链 = 计划与成本核算层；OutsourcingOrder = 执行单据层（可选关联不耦合）
 *   ② 加工费为成本口径（BOM/利润表消费），不生成应付——应付走既有采购域
 *   ③ 按产出量计费（染厂出缸量惯例）：完工 amount = outputQty × unitPrice；
 *      未完工按投入量预估（estimate 口径）
 *
 * 核心闭环：
 *   创建节点（seq/工序/工厂/投入量/单价）→（可选 in_progress）→ 完工登记产出量
 *   → 自动损耗率 + 金额重算 → 订单级聚合（累计损耗/加工费合计/进度）
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';

// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

/** 面料工序类型枚举 */
export const PROCESS_TYPES = ['gray_fabric', 'dyeing', 'finishing', 'coating', 'other'] as const;
export const PROCESS_TYPE_LABELS: Record<string, string> = {
  gray_fabric: '坯布织造',
  dyeing: '染整',
  finishing: '后整理',
  coating: '涂层',
  other: '其他',
};

export const PROCESS_UNITS = ['M', 'YD', 'KG'] as const;
export const PROCESS_STATUSES = ['planned', 'in_progress', 'done'] as const;

/** 判别联合（testRequestService 范式） */
export type ProcessChainResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): ProcessChainResult<never> =>
  ({ ok: false, error: { code, message, status } });

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function toQty(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error(`${field} 必须为正数`), { code: 'INVALID_QTY' });
  }
  return n;
}

function toPrice(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw Object.assign(new Error(`${field} 必须为非负数`), { code: 'INVALID_PRICE' });
  }
  return n;
}

function sanitizeType(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!(PROCESS_TYPES as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`processType 须为 ${PROCESS_TYPES.join(' | ')}`), { code: 'INVALID_PROCESS_TYPE' });
  }
  return s;
}

function sanitizeUnit(value: unknown): string {
  const s = String(value ?? 'M').trim().toUpperCase();
  if (!(PROCESS_UNITS as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`unit 须为 ${PROCESS_UNITS.join(' | ')}`), { code: 'INVALID_UNIT' });
  }
  return s;
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createProcessChainService(prisma: PrismaClient) {
  const db = prisma as any;

  // ── 创建工序节点 ──
  async function createNode(input: {
    orderId: string;
    seq: unknown;
    processType: unknown;
    supplierId?: unknown;
    inputQty: unknown;
    unit?: unknown;
    unitPrice: unknown;
    notes?: unknown;
    outsourcingOrderId?: unknown;
  }): Promise<ProcessChainResult<{ node: any }>> {
    try {
      const orderId = String(input.orderId ?? '').trim();
      if (!orderId) return fail('ORDER_REQUIRED', 'orderId 必填');
      const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
      if (!order) return fail('ORDER_NOT_FOUND', `订单 ${orderId} 不存在`, 404);

      const seq = Number(input.seq);
      if (!Number.isInteger(seq) || seq < 1) {
        return fail('INVALID_SEQ', 'seq 必须为正整数（工序序号）');
      }
      const dup = await db.orderProcessNode.findFirst({ where: { orderId, seq, deletedAt: null } });
      if (dup) return fail('SEQ_DUP', `工序序号 ${seq} 已存在（同订单唯一）`, 409);

      const processType = sanitizeType(input.processType);
      const inputQty = toQty(input.inputQty, 'inputQty');
      const unit = sanitizeUnit(input.unit);
      const unitPrice = toPrice(input.unitPrice, 'unitPrice');

      // 承接工厂快照（fail-closed：传入即校验）
      let supplierId: string | null = null;
      let supplierName: string | null = null;
      if (input.supplierId != null && String(input.supplierId).trim() !== '') {
        const rel = await db.relation.findFirst({ where: { id: String(input.supplierId), deletedAt: null } });
        if (!rel) return fail('SUPPLIER_NOT_FOUND', `供应商 ${input.supplierId} 不存在`);
        supplierId = rel.id;
        supplierName = rel.name;
      }

      // 可选关联外协单（DR-047-①：执行载体，不耦合状态机）
      let outsourcingOrderId: string | null = null;
      if (input.outsourcingOrderId != null && String(input.outsourcingOrderId).trim() !== '') {
        const oso = await db.outsourcingOrder.findFirst({
          where: { id: String(input.outsourcingOrderId), deletedAt: null },
        });
        if (!oso) return fail('OSO_NOT_FOUND', `外协单 ${input.outsourcingOrderId} 不存在`);
        outsourcingOrderId = oso.id;
      }

      const ts = Date.now();
      const node = await db.orderProcessNode.create({
        data: {
          id: `OPN__${ts.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          orderId,
          seq,
          processType,
          supplierId,
          supplierName,
          inputQty,
          outputQty: null,
          unit,
          unitPrice,
          currency: 'CNY',
          amount: round4(inputQty * unitPrice), // 未完工预估口径（DR-047-③）
          status: 'planned',
          notes: input.notes != null ? String(input.notes).trim() || null : null,
          outsourcingOrderId,
          createdAt: BigInt(ts),
          updatedAt: BigInt(ts),
        },
      });
      logger.info('[ProcessChain] node created', { id: node.id, orderId, seq, processType });
      return { ok: true, data: { node } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message, e.code === 'ORDER_NOT_FOUND' ? 404 : 400);
      logger.error('[ProcessChain] create failed', { error: e?.message });
      return fail('CREATE_FAILED', e?.message || '创建失败');
    }
  }

  // ── 订单工序链全景（验收锚点：完整链路进度 + 累计损耗 + 加工费合计） ──
  async function listChain(orderId: string): Promise<ProcessChainResult<{ nodes: any[]; summary: any }>> {
    const oid = String(orderId ?? '').trim();
    if (!oid) return fail('ORDER_REQUIRED', 'orderId 必填');
    const nodes = await db.orderProcessNode.findMany({
      where: { orderId: oid, deletedAt: null },
      orderBy: { seq: 'asc' },
    });

    // 累计损耗：首道投入 → 末道产出（跨工序链净损耗）
    const input0 = nodes.length > 0 ? Number(nodes[0].inputQty) : 0;
    const lastDone = [...nodes].reverse().find((n: any) => n.status === 'done' && n.outputQty != null);
    const lastOutput = lastDone != null ? Number(lastDone.outputQty) : null;
    const cumulativeLossPct = input0 > 0 && lastOutput != null
      ? round4(((input0 - lastOutput) / input0) * 100)
      : null;

    const totalAmount = nodes.reduce((s: number, n: any) => s + Number(n.amount), 0);
    const summary = {
      total: nodes.length,
      done: nodes.filter((n: any) => n.status === 'done').length,
      inProgress: nodes.filter((n: any) => n.status === 'in_progress').length,
      planned: nodes.filter((n: any) => n.status === 'planned').length,
      firstInputQty: input0,
      lastOutputQty: lastOutput,
      cumulativeLossPct,
      totalAmount: round4(totalAmount),
      // 分工序加工费明细（BOM/利润表消费口径）
      byType: PROCESS_TYPES.map(t => ({
        type: t,
        amount: round4(nodes.filter((n: any) => n.processType === t).reduce((s: number, n: any) => s + Number(n.amount), 0)),
      })).filter(x => x.amount > 0),
    };
    return { ok: true, data: { nodes, summary } };
  }

  // ── 修正计划字段（planned/in_progress 限定） ──
  async function updateNode(id: string, patch: Record<string, unknown>): Promise<ProcessChainResult<{ node: any }>> {
    try {
      const existing = await db.orderProcessNode.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return fail('NOT_FOUND', `工序节点 ${id} 不存在`, 404);
      if (existing.status === 'done') {
        const onlyNotes = Object.keys(patch).every(k => k === 'notes');
        if (!onlyNotes) return fail('NODE_DONE', '已完工节点仅可修改备注', 409);
      }

      const data: any = { updatedAt: BigInt(Date.now()) };
      if (patch.supplierId !== undefined) {
        if (patch.supplierId == null || String(patch.supplierId).trim() === '') {
          data.supplierId = null; data.supplierName = null;
        } else {
          const rel = await db.relation.findFirst({ where: { id: String(patch.supplierId), deletedAt: null } });
          if (!rel) return fail('SUPPLIER_NOT_FOUND', `供应商 ${patch.supplierId} 不存在`);
          data.supplierId = rel.id;
          data.supplierName = rel.name;
        }
      }
      let needRecalc = false;
      if (patch.inputQty !== undefined) { data.inputQty = toQty(patch.inputQty, 'inputQty'); needRecalc = true; }
      if (patch.unitPrice !== undefined) { data.unitPrice = toPrice(patch.unitPrice, 'unitPrice'); needRecalc = true; }
      if (patch.unit !== undefined) data.unit = sanitizeUnit(patch.unit);
      if (patch.notes !== undefined) data.notes = String(patch.notes ?? '').trim() || null;
      if (patch.outsourcingOrderId !== undefined) {
        if (patch.outsourcingOrderId == null || String(patch.outsourcingOrderId).trim() === '') {
          data.outsourcingOrderId = null;
        } else {
          const oso = await db.outsourcingOrder.findFirst({ where: { id: String(patch.outsourcingOrderId), deletedAt: null } });
          if (!oso) return fail('OSO_NOT_FOUND', `外协单 ${patch.outsourcingOrderId} 不存在`);
          data.outsourcingOrderId = oso.id;
        }
      }
      // 未完工改量/价 → 预估口径重算（完工节点禁止改量价，走到这里必是未完工）
      if (needRecalc && existing.outputQty == null) {
        data.amount = round4(Number(data.inputQty ?? existing.inputQty) * Number(data.unitPrice ?? existing.unitPrice));
      }

      const node = await db.orderProcessNode.update({ where: { id }, data });
      return { ok: true, data: { node } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message, e.code === 'NOT_FOUND' ? 404 : 400);
      logger.error('[ProcessChain] update failed', { error: e?.message });
      return fail('UPDATE_FAILED', e?.message || '更新失败');
    }
  }

  // ── planned → in_progress ──
  async function startNode(id: string): Promise<ProcessChainResult<{ node: any }>> {
    const existing = await db.orderProcessNode.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return fail('NOT_FOUND', `工序节点 ${id} 不存在`, 404);
    if (existing.status !== 'planned') return fail('INVALID_TRANSITION', `仅 planned 可开工（当前 ${existing.status}）`, 409);
    const node = await db.orderProcessNode.update({
      where: { id },
      data: { status: 'in_progress', updatedAt: BigInt(Date.now()) },
    });
    return { ok: true, data: { node } };
  }

  // ── 完工登记（验收锚点：产出量 → 损耗率 + 金额重算） ──
  async function completeNode(id: string, input: {
    outputQty: unknown;
    actualUnitPrice?: unknown;
  }): Promise<ProcessChainResult<{ node: any; lossPct: number | null }>> {
    try {
      const existing = await db.orderProcessNode.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return fail('NOT_FOUND', `工序节点 ${id} 不存在`, 404);
      if (existing.status === 'done') return fail('NODE_DONE', '该工序已完工', 409);

      const outputQty = toQty(input.outputQty, 'outputQty');
      const inQty = Number(existing.inputQty);
      if (outputQty > inQty) {
        return fail('OUTPUT_EXCEEDS_INPUT', `产出量 ${outputQty} 超过投入量 ${inQty}（溢装请修正投入量）`);
      }
      const unitPrice = input.actualUnitPrice !== undefined && input.actualUnitPrice !== null && input.actualUnitPrice !== ''
        ? toPrice(input.actualUnitPrice, 'actualUnitPrice')
        : Number(existing.unitPrice);

      const ts = Date.now();
      const lossPct = round4(((inQty - outputQty) / inQty) * 100);
      const node = await db.orderProcessNode.update({
        where: { id },
        data: {
          outputQty,
          unitPrice,
          amount: round4(outputQty * unitPrice), // DR-047-③：按产出计费
          status: 'done',
          completedAt: BigInt(ts),
          updatedAt: BigInt(ts),
        },
      });
      logger.info('[ProcessChain] node completed', { id, outputQty, lossPct, amount: node.amount });
      return { ok: true, data: { node, lossPct } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message, e.code === 'NOT_FOUND' ? 404 : 400);
      logger.error('[ProcessChain] complete failed', { error: e?.message });
      return fail('COMPLETE_FAILED', e?.message || '完工登记失败');
    }
  }

  // ── 软删（仅 planned） ──
  async function deleteNode(id: string): Promise<ProcessChainResult<{ id: string }>> {
    const existing = await db.orderProcessNode.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return fail('NOT_FOUND', `工序节点 ${id} 不存在`, 404);
    if (existing.status !== 'planned') {
      return fail('NOT_PLANNED', '已开工/完工节点不可删除（核算留痕）', 409);
    }
    await db.orderProcessNode.update({ where: { id }, data: { deletedAt: BigInt(Date.now()) } });
    return { ok: true, data: { id } };
  }

  return { createNode, listChain, updateNode, startNode, completeNode, deleteNode };
}
