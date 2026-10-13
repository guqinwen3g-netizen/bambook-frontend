
/**
 * tcCertificateService.ts — REQ2-06 GRS TC 交易证书链（三段链：原料→工厂→我方）
 *
 * 设计真源：docs/design/04-模块设计/06-资源与支撑/Suppliers-供应商/GRS-TC交易证书链.md
 *
 * DR-048 三决策：
 *   ① TC 与资质认证分轨（FactoryCertification 是年度资质；TC 是每票交易证书）
 *   ② 三段链 stage 枚举 + 段位聚合勾稽（Σ 原料 ≥ Σ 工厂 ≥ Σ 我方），
 *      不做逐张 parent 拓扑（parentTcId 预留）
 *   ③ 一键校验四检查项（只读无副作用，出货门禁消费方调用）：
 *      链完整性 / 段间吨位 / TC vs 订单用量（KG 行）/ 有效期
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../lib/logger';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────────
// 常量与校验
// ────────────────────────────────────────────────────────────────────

export const TC_STAGES = ['material_input', 'factory_output', 'our_sale'] as const;
export const TC_STAGE_LABELS: Record<string, string> = {
  material_input: '原料 TC',
  factory_output: '工厂 TC',
  our_sale: '我方 TC',
};

export type TcResult<T = any> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status: number } };

const fail = (code: string, message: string, status = 400): TcResult<never> =>
  ({ ok: false, error: { code, message, status } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertYmd(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!DATE_RE.test(s)) throw Object.assign(new Error(`${field} 须为 YYYY-MM-DD`), { code: 'INVALID_DATE' });
  return s;
}

function toQuantityKg(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error('quantityKg 必须为正数（吨位，公斤）'), { code: 'INVALID_QTY' });
  }
  return Math.round(n * 1000) / 1000;
}

function sanitizeStage(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!(TC_STAGES as readonly string[]).includes(s)) {
    throw Object.assign(new Error(`stage 须为 ${TC_STAGES.join(' | ')}`), { code: 'INVALID_STAGE' });
  }
  return s;
}

// ────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────

export function createTcCertificateService(prisma: PrismaClient) {
  const db = prisma as any;

  // ── 登记 TC ──
  async function createTc(input: {
    orderId: string;
    stage: unknown;
    tcNo: unknown;
    quantityKg: unknown;
    relationId?: unknown;
    issuedAt?: unknown;
    validUntil?: unknown;
    notes?: unknown;
    parentTcId?: unknown;
  }): Promise<TcResult<{ tc: any }>> {
    try {
      const orderId = String(input.orderId ?? '').trim();
      if (!orderId) return fail('ORDER_REQUIRED', 'orderId 必填');
      const order = await db.order.findFirst({ where: { id: orderId, deletedAt: null } });
      if (!order) return fail('ORDER_NOT_FOUND', `订单 ${orderId} 不存在`, 404);

      const tcNo = String(input.tcNo ?? '').trim();
      if (!tcNo) return fail('TC_NO_REQUIRED', '证书编号 tcNo 必填');
      const dup = await db.tcCertificate.findFirst({ where: { tcNo, deletedAt: null } });
      if (dup) return fail('TC_NO_DUP', `证书编号 ${tcNo} 已存在`, 409);

      const stage = sanitizeStage(input.stage);
      const quantityKg = toQuantityKg(input.quantityKg);

      // 交易对手快照（fail-closed）
      let relationId: string | null = null;
      let relationName: string | null = null;
      if (input.relationId != null && String(input.relationId).trim() !== '') {
        const rel = await db.relation.findFirst({ where: { id: String(input.relationId), deletedAt: null } });
        if (!rel) return fail('RELATION_NOT_FOUND', `交易对手 ${input.relationId} 不存在`);
        relationId = rel.id;
        relationName = rel.name;
      }

      // 可选链上游：同订单内存在性校验
      let parentTcId: string | null = null;
      if (input.parentTcId != null && String(input.parentTcId).trim() !== '') {
        const parent = await db.tcCertificate.findFirst({
          where: { id: String(input.parentTcId), orderId, deletedAt: null },
        });
        if (!parent) return fail('PARENT_NOT_FOUND', '链上游 TC 不存在或不属于本订单');
        parentTcId = parent.id;
      }

      const ts = Date.now();
      const tc = await db.tcCertificate.create({
        data: {
          id: `TCC__${ts.toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          tcNo,
          orderId,
          relationId,
          relationName,
          stage,
          quantityKg,
          issuedAt: assertYmd(input.issuedAt, 'issuedAt'),
          validUntil: assertYmd(input.validUntil, 'validUntil'),
          notes: input.notes != null ? String(input.notes).trim() || null : null,
          parentTcId,
          createdAt: BigInt(ts),
          updatedAt: BigInt(ts),
        },
      });
      logger.info('[TcCertificate] created', { id: tc.id, tcNo, stage, quantityKg, orderId });
      return { ok: true, data: { tc } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message, e.code === 'ORDER_NOT_FOUND' ? 404 : 400);
      logger.error('[TcCertificate] create failed', { error: e?.message });
      return fail('CREATE_FAILED', e?.message || '登记失败');
    }
  }

  // ── 链视图（订单 or 供应商维度；按 stage 分组 + 段位吨位聚合） ──
  async function listTc(params: { orderId?: string; relationId?: string }): Promise<TcResult<{ items: any[]; byStage: any }>> {
    const orderId = params.orderId?.trim();
    const relationId = params.relationId?.trim();
    if (!orderId && !relationId) return fail('SCOPE_REQUIRED', 'orderId 与 relationId 必传其一');
    const where: any = { deletedAt: null };
    if (orderId) where.orderId = orderId;
    if (relationId) where.relationId = relationId;

    const items = await db.tcCertificate.findMany({ where, orderBy: { createdAt: 'desc' } });
    const byStage = TC_STAGES.map(stage => {
      const stageItems = items.filter((t: any) => t.stage === stage);
      return {
        stage,
        label: TC_STAGE_LABELS[stage],
        count: stageItems.length,
        totalKg: Math.round(stageItems.reduce((s: number, t: any) => s + Number(t.quantityKg), 0) * 1000) / 1000,
      };
    });
    return { ok: true, data: { items, byStage } };
  }

  // ── 一键校验（DR-048-③ 四检查项，只读无副作用——出货门禁消费方调用） ──
  async function verifyChain(orderId: string): Promise<TcResult<any>> {
    const oid = String(orderId ?? '').trim();
    if (!oid) return fail('ORDER_REQUIRED', 'orderId 必填');
    const order = await db.order.findFirst({
      where: { id: oid, deletedAt: null },
      include: { lines: true },
    });
    if (!order) return fail('ORDER_NOT_FOUND', `订单 ${oid} 不存在`, 404);

    const tcs = await db.tcCertificate.findMany({
      where: { orderId: oid, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const today = todayLocalKey();

    // ① 链完整性：三段各 ≥1
    const missingStages = TC_STAGES.filter(
      stage => !tcs.some((t: any) => t.stage === stage));

    // ② 段间吨位：Σ 原料 ≥ Σ 工厂 ≥ Σ 我方（上游 < 下游即预警——含损耗合理性）
    const sumBy = (stage: string) =>
      Math.round(tcs.filter((t: any) => t.stage === stage)
        .reduce((s: number, t: any) => s + Number(t.quantityKg), 0) * 1000) / 1000;
    const materialKg = sumBy('material_input');
    const factoryKg = sumBy('factory_output');
    const ourKg = sumBy('our_sale');
    const tonnageWarnings: string[] = [];
    if (materialKg < factoryKg) {
      tonnageWarnings.push(`原料 TC 吨位 ${materialKg}kg < 工厂 TC 吨位 ${factoryKg}kg（原料须覆盖产出）`);
    }
    if (factoryKg < ourKg) {
      tonnageWarnings.push(`工厂 TC 吨位 ${factoryKg}kg < 我方 TC 吨位 ${ourKg}kg（产出须覆盖销售）`);
    }

    // ③ 订单用量勾稽：Σ 我方 TC vs 订单 unit=KG 行 Σ quantity（TC < 用量 → 预警）
    const kgLines = (order.lines || []).filter((l: any) => String(l.unit ?? '').toUpperCase() === 'KG');
    const orderUsageKg = kgLines.reduce((s: number, l: any) => s + Number(l.quantity || 0), 0);
    const usageWarning = kgLines.length > 0 && ourKg < orderUsageKg
      ? `我方 TC 吨位 ${ourKg}kg < 订单用量 ${orderUsageKg}kg（TC 覆盖不足）`
      : null;

    // ④ 有效期：validUntil < 今天
    const expiredTc = tcs
      .filter((t: any) => t.validUntil != null && String(t.validUntil) < today)
      .map((t: any) => ({ id: t.id, tcNo: t.tcNo, validUntil: t.validUntil }));

    const verdict = missingStages.length === 0 && tonnageWarnings.length === 0 && !usageWarning && expiredTc.length === 0
      ? 'complete'
      : 'warning';

    return {
      ok: true,
      data: {
        orderId: oid,
        poNumber: order.poNumber ?? null,
        verdict,
        tcCount: tcs.length,
        byStage: { materialKg, factoryKg, ourKg },
        missingStages: missingStages.map(s => ({ stage: s, label: TC_STAGE_LABELS[s] })),
        tonnageWarnings,
        orderUsage: {
          checked: kgLines.length > 0,
          orderUsageKg: kgLines.length > 0 ? orderUsageKg : null,
          ourSaleKg: ourKg,
          warning: usageWarning,
        },
        expiredTc,
      },
    };
  }

  // ── 修正（白名单：吨位/效期/备注；tcNo/stage/orderId 不可改） ──
  async function updateTc(id: string, patch: Record<string, unknown>): Promise<TcResult<{ tc: any }>> {
    try {
      const existing = await db.tcCertificate.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return fail('NOT_FOUND', `TC 证书 ${id} 不存在`, 404);
      const data: any = { updatedAt: BigInt(Date.now()) };
      if (patch.quantityKg !== undefined) data.quantityKg = toQuantityKg(patch.quantityKg);
      if (patch.issuedAt !== undefined) data.issuedAt = assertYmd(patch.issuedAt, 'issuedAt');
      if (patch.validUntil !== undefined) data.validUntil = assertYmd(patch.validUntil, 'validUntil');
      if (patch.notes !== undefined) data.notes = String(patch.notes ?? '').trim() || null;
      const tc = await db.tcCertificate.update({ where: { id }, data });
      return { ok: true, data: { tc } };
    } catch (e: any) {
      if (e?.code) return fail(e.code, e.message, e.code === 'NOT_FOUND' ? 404 : 400);
      logger.error('[TcCertificate] update failed', { error: e?.message });
      return fail('UPDATE_FAILED', e?.message || '更新失败');
    }
  }

  // ── 软删 ──
  async function deleteTc(id: string): Promise<TcResult<{ id: string }>> {
    const existing = await db.tcCertificate.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return fail('NOT_FOUND', `TC 证书 ${id} 不存在`, 404);
    await db.tcCertificate.update({ where: { id }, data: { deletedAt: BigInt(Date.now()) } });
    logger.info('[TcCertificate] soft-deleted', { id });
    return { ok: true, data: { id } };
  }

  return { createTc, listTc, verifyChain, updateTc, deleteTc };
}
