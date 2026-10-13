/**
 * sampleShipmentHistoryService.ts — ★ C5 寄样历史只读查询（2026-09-18）
 *
 * 三个寄样入口的历史**各自存在自己的 Json 字段**里（本仓既有模式：attachments 追加数组）：
 *   · `fabric`  → `FabricShipmentSample.attachments.shipments[]`（C5 新增）
 *   · `garment` → `SampleBatch(garment-round).attachments.shipmentHistory[]`（C5 新增）
 *   · `early`   → `EarlyProductionSample.attachments.rounds[]`（**本来就有**，形状略有不同）
 * 本服务把三者收敛成**同一读取口径**（同一返回形状），避免前端各写一套解析。
 *
 * ⓘ 为什么不合并成一张表：见 `sampleShipmentHistory.ts` 头注释（零 migration + 复用既有模式）。
 */
import type { PrismaClient } from '@prisma/client';
import { latestShipmentOf, totalShippingFeeOf, type SampleShipmentEntry } from './sampleShipmentHistory';

export type SampleShipmentSubject = 'fabric' | 'garment' | 'early';

export interface SampleShipmentHistoryView {
  subject: SampleShipmentSubject;
  subjectId: string;
  /** 寄样记录（最旧在前） */
  history: SampleShipmentEntry[];
  /** 寄了几次 */
  count: number;
  /** 是否分批寄样（≥2 次） */
  isMulti: boolean;
  /** 最后一次（展示"最新一次"用；空历史为 null） */
  latest: SampleShipmentEntry | null;
  /** 寄样费用合计（非数值不计入） */
  totalShippingFee: number;
}

const EMPTY = (subject: SampleShipmentSubject, subjectId: string): SampleShipmentHistoryView => ({
  subject, subjectId, history: [], count: 0, isMulti: false, latest: null, totalShippingFee: 0,
});

/** 早产样的 `rounds[]` 形状与通用寄样记录略有差异（有 round 序号）→ 归一到同一形状 */
const normalizeEarlyRounds = (rounds: unknown): SampleShipmentEntry[] => {
  if (!Array.isArray(rounds)) return [];
  return rounds.map((r: any) => ({
    sentDate: String(r?.sentDate ?? ''),
    courier: r?.courier ?? null,
    trackingNumber: r?.trackingNumber ?? null,
    recipientName: r?.recipientName ?? null,
    recipientContact: r?.recipientContact ?? null,
    shippingFee: null, // 早产样的 rounds 里没有邮寄费字段（形状差异，如实留空）
    documents: Array.isArray(r?.documents) ? r.documents : [],
    note: r?.round != null ? `第 ${r.round} 次寄样` : null,
    shippedBy: r?.shippedBy ?? null,
    shippedAt: r?.shippedAt ?? null,
  }));
};

const wrap = (subject: SampleShipmentSubject, subjectId: string, history: SampleShipmentEntry[]): SampleShipmentHistoryView => ({
  subject,
  subjectId,
  history,
  count: history.length,
  isMulti: history.length >= 2,
  latest: latestShipmentOf(history),
  totalShippingFee: totalShippingFeeOf(history),
});

/**
 * 查某主体的寄样历史。主体不存在 → 返回空历史（**不抛错**：调用方多为详情页的附加区块，
 * 主体刚删/刚建时不该整页失败；但 `count=0` 与"从未寄样"在界面上是同一呈现，故不区分）。
 */
export async function getSampleShipmentHistory(
  prisma: PrismaClient,
  subject: SampleShipmentSubject,
  subjectId: string,
): Promise<SampleShipmentHistoryView> {
  const db: any = prisma as any;
  if (!subjectId) return EMPTY(subject, subjectId);

  if (subject === 'fabric') {
    const row = await db.fabricShipmentSample.findFirst({
      where: { id: subjectId, deletedAt: null },
      select: { attachments: true },
    }).catch(() => null);
    const history = Array.isArray(row?.attachments?.shipments) ? row.attachments.shipments : [];
    return wrap(subject, subjectId, history as SampleShipmentEntry[]);
  }

  if (subject === 'garment') {
    const row = await db.sampleBatch.findFirst({
      where: { id: subjectId, deletedAt: null },
      select: { attachments: true },
    }).catch(() => null);
    const history = Array.isArray(row?.attachments?.shipmentHistory) ? row.attachments.shipmentHistory : [];
    return wrap(subject, subjectId, history as SampleShipmentEntry[]);
  }

  // early
  const row = await db.earlyProductionSample.findFirst({
    where: { id: subjectId, deletedAt: null },
    select: { attachments: true },
  }).catch(() => null);
  return wrap(subject, subjectId, normalizeEarlyRounds(row?.attachments?.rounds));
}
