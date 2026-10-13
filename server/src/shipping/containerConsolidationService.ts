/**
 * containerConsolidationService.ts — ★ C1 拼柜（一柜多票）聚合与核对（2026-09-18）
 *
 * ── 为什么需要它（零基础障碍清单 C1，实测订正了清单描述）──
 * 清单原文是「`CustomsDeclaration` 无柜号字段」。**实测：柜号字段本来就有** ——
 *   `Shipment.containerNumber` / `sealNumber`（`schema.prisma:3028-3029`），
 *   已用于装箱单/报关单据模板、客户门户与货运管理页；`CustomsDeclaration.shipmentId` 也能关联。
 * 真缺口是**没有「按柜号聚合」的能力** ⇒ 拼柜（一柜装多票）时：
 *   · 一柜到底装了几票、几个客户、多少件/多少吨 —— 只能人工翻运单
 *   · 报关单与退税按票分散，**按柜核对**（一个柜对应几张报关单、退了多少税）只能手工
 *   · ★ 最要命的：拼柜**必须同船、同航次、同目的港、同时离港**，
 *     而系统对「同柜但 ETD/目的港/船名不一致」**完全没有任何提示** ——
 *     填错了要等到报关或客户查货才发现（一次改单的代价远大于一条提示）
 *
 * ── 本服务做三件事（只读，零写入）──
 *   ① 按 `containerNumber` 聚合（trim 归一；**空柜号的票单独归入 unassigned**，不硬塞进某个柜）
 *   ② 每柜并排给出：票/客户/件重体 + 关联报关单 + 关联退税
 *   ③ ★ **柜内矛盾检测**（纯函数 `detectConsolidationConflicts`，可单测）：
 *      ETD / 目的港 / 船名 / 航次 在同一柜内出现多个不同非空值 → 逐条告警
 *
 * ── 刻意不做的两件事（写下来防后人踩）──
 *   · **不做柜内「封条号重复」检测**：同一柜多票共用同一个封条号是**正常**的（一个柜一个封条）。
 *     真正异常的是「同一封条号出现在不同柜」——那是跨柜判据，需要业务口径，本轮不做。
 *   · **不做自动纠正**：只报不写。拼柜信息改哪个字段、改成谁的值，是业务判断。
 */
import type { PrismaClient } from '@prisma/client';

// ────────────────────────────────────────────────────────────────
// 纯函数：柜内矛盾检测
// ────────────────────────────────────────────────────────────────

/** 参与柜内一致性判定的运单最小形态 */
export interface ContainerShipmentRef {
  id: string;
  shipmentNumber: string;
  etd?: string | null;
  portOfDischarge?: string | null;
  vesselOrFlight?: string | null;
  voyageNumber?: string | null;
}

export type ContainerConflictCode =
  | 'ETD_MISMATCH'
  | 'DISCHARGE_PORT_MISMATCH'
  | 'VESSEL_MISMATCH'
  | 'VOYAGE_MISMATCH';

export interface ContainerConflict {
  code: ContainerConflictCode;
  /** 面向人的一句话（含冲突值 + 涉及票号） */
  message: string;
  /** 出现过的不同取值（已归一、去重、排序） */
  values: string[];
  /** 涉及到的票号 */
  shipmentNumbers: string[];
}

const norm = (v?: string | null): string => (v ?? '').trim();

/** 通用：某字段在柜内是否出现多个不同非空值 */
function collectConflict(
  shipments: ContainerShipmentRef[],
  pick: (s: ContainerShipmentRef) => string,
  code: ContainerConflictCode,
  label: string,
): ContainerConflict | null {
  const byValue = new Map<string, string[]>();
  for (const s of shipments) {
    const v = pick(s);
    if (!v) continue; // 空值不参与（未填 ≠ 不一致 —— 宁可漏报，不可误报）
    const arr = byValue.get(v) ?? [];
    arr.push(s.shipmentNumber);
    byValue.set(v, arr);
  }
  if (byValue.size <= 1) return null;
  const values = [...byValue.keys()].sort();
  const shipmentNumbers = [...byValue.values()].flat().sort();
  return {
    code,
    values,
    shipmentNumbers,
    message: `同柜各票的${label}不一致：${values.join(' / ')}（涉及 ${shipmentNumbers.join('、')}）。拼柜必须同${label}，请核对后再报关`,
  };
}

/**
 * 柜内矛盾检测（**纯函数**）。
 *
 * 判据（拼柜的四条硬一致）：ETD / 目的港 / 船名 / 航次。
 * 单票柜返回空数组（没有「一致性」可言）。
 * 空值一律不参与 —— 未填 ≠ 不一致（宁可漏报，不可误报）。
 */
export function detectConsolidationConflicts(shipments: ContainerShipmentRef[]): ContainerConflict[] {
  if (!shipments || shipments.length < 2) return [];
  const out: ContainerConflict[] = [];
  const push = (c: ContainerConflict | null) => { if (c) out.push(c); };
  push(collectConflict(shipments, s => norm(s.etd), 'ETD_MISMATCH', '离港日(ETD)'));
  push(collectConflict(shipments, s => norm(s.portOfDischarge), 'DISCHARGE_PORT_MISMATCH', '卸货港'));
  push(collectConflict(shipments, s => norm(s.vesselOrFlight), 'VESSEL_MISMATCH', '船名/航班'));
  push(collectConflict(shipments, s => norm(s.voyageNumber), 'VOYAGE_MISMATCH', '航次'));
  return out;
}

// ────────────────────────────────────────────────────────────────
// 聚合查询（只读）
// ────────────────────────────────────────────────────────────────

export interface ContainerShipmentRow {
  id: string;
  shipmentNumber: string;
  status: string;
  customerName: string | null;
  businessLine: string | null;
  orderId: string | null;
  etd: string | null;
  eta: string | null;
  atd: string | null;
  ata: string | null;
  portOfLoading: string | null;
  portOfDischarge: string | null;
  vesselOrFlight: string | null;
  voyageNumber: string | null;
  sealNumber: string | null;
  totalPackages: number | null;
  grossWeight: number | null;
  volume: number | null;
}

export interface ContainerCustomsRow {
  id: string;
  declarationNumber: string;
  shipmentId: string | null;
  status: string;
  totalValue: number | null;
  currency: string | null;
  declarationDate: string | null;
}

export interface ContainerTaxRefundRow {
  id: string;
  declarationId: string | null;
  status: string;
  refundAmount: number | null;
  exportAmountFob: number | null;
  currency: string | null;
}

export interface ContainerGroup {
  containerNumber: string;
  shipmentCount: number;
  customerCount: number;
  shipments: ContainerShipmentRow[];
  customsDeclarations: ContainerCustomsRow[];
  taxRefunds: ContainerTaxRefundRow[];
  totals: { totalPackages: number; grossWeight: number; volume: number };
  /** ★ 柜内矛盾（拼柜必须同船同港同时离港） */
  conflicts: ContainerConflict[];
}

export interface ContainerConsolidationResult {
  from: string | null;
  to: string | null;
  /** 已填柜号的柜（按票数降序，票数相同按柜号字典序） */
  containers: ContainerGroup[];
  /** 未填柜号的票（不硬塞进某个柜） */
  unassigned: { shipmentCount: number; shipments: ContainerShipmentRow[] };
  summary: {
    containerCount: number;
    /** 装了 ≥2 票的柜数 = 真正意义上的「拼柜」 */
    consolidatedCount: number;
    ticketCount: number;
    unassignedCount: number;
    conflictCount: number;
  };
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 按柜号聚合（只读）。区间过滤走 `etd`（与准交率/运输方式统计同口径：无 etd 的票在带区间时排除）。
 */
export async function getContainerConsolidation(
  prisma: PrismaClient,
  params: { from?: string; to?: string } = {},
): Promise<ContainerConsolidationResult> {
  const { from, to } = params;

  const shipments = await (prisma as any).shipment.findMany({
    where: { deletedAt: null },
    select: {
      id: true, shipmentNumber: true, status: true, customerName: true, businessLine: true,
      orderId: true, etd: true, eta: true, atd: true, ata: true,
      portOfLoading: true, portOfDischarge: true, vesselOrFlight: true, voyageNumber: true,
      sealNumber: true, containerNumber: true, totalPackages: true, grossWeight: true, volume: true,
    },
  });

  const filtered = (shipments as any[]).filter(s => {
    if (!from && !to) return true;
    const d = s.etd ?? s.ata;
    if (!d) return false;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  });

  const shipmentIds = filtered.map(s => s.id);

  // 报关单（按 shipmentId 关联）+ 退税（按 declarationId 关联）
  const declarations: any[] = shipmentIds.length
    ? await (prisma as any).customsDeclaration
      .findMany({
        where: { shipmentId: { in: shipmentIds }, deletedAt: null },
        select: {
          id: true, declarationNumber: true, shipmentId: true, status: true,
          totalValue: true, currency: true, declarationDate: true,
        },
      })
      .catch(() => [] as any[])
    : [];
  const declarationIds = declarations.map(d => d.id);
  const refunds: any[] = declarationIds.length
    ? await (prisma as any).taxRefund
      .findMany({
        where: { declarationId: { in: declarationIds }, deletedAt: null },
        select: { id: true, declarationId: true, status: true, refundAmount: true, exportAmountFob: true, exportAmountFobCurrency: true },
      })
      .catch(() => [] as any[])
    : [];

  const toRow = (s: any): ContainerShipmentRow => ({
    id: s.id, shipmentNumber: s.shipmentNumber, status: s.status,
    customerName: s.customerName ?? null, businessLine: s.businessLine ?? null, orderId: s.orderId ?? null,
    etd: s.etd ?? null, eta: s.eta ?? null, atd: s.atd ?? null, ata: s.ata ?? null,
    portOfLoading: s.portOfLoading ?? null, portOfDischarge: s.portOfDischarge ?? null,
    vesselOrFlight: s.vesselOrFlight ?? null, voyageNumber: s.voyageNumber ?? null,
    sealNumber: s.sealNumber ?? null,
    totalPackages: num(s.totalPackages), grossWeight: num(s.grossWeight), volume: num(s.volume),
  });

  const byContainer = new Map<string, ContainerShipmentRow[]>();
  const unassignedRows: ContainerShipmentRow[] = [];
  for (const s of filtered) {
    const c = norm(s.containerNumber);
    if (!c) { unassignedRows.push(toRow(s)); continue; }
    const arr = byContainer.get(c) ?? [];
    arr.push(toRow(s));
    byContainer.set(c, arr);
  }

  const containers: ContainerGroup[] = [...byContainer.entries()].map(([containerNumber, rows]) => {
    const ids = new Set(rows.map(r => r.id));
    const myDeclarations: ContainerCustomsRow[] = declarations
      .filter(d => d.shipmentId && ids.has(d.shipmentId))
      .map(d => ({
        id: d.id, declarationNumber: d.declarationNumber, shipmentId: d.shipmentId ?? null,
        status: d.status, totalValue: num(d.totalValue), currency: d.currency ?? null,
        declarationDate: d.declarationDate ?? null,
      }));
    const declIds = new Set(myDeclarations.map(d => d.id));
    const myRefunds: ContainerTaxRefundRow[] = refunds
      .filter(r => r.declarationId && declIds.has(r.declarationId))
      .map(r => ({
        id: r.id, declarationId: r.declarationId ?? null, status: r.status,
        refundAmount: num(r.refundAmount), exportAmountFob: num(r.exportAmountFob),
        currency: r.exportAmountFobCurrency ?? null,
      }));

    const customers = new Set(rows.map(r => (r.customerName ?? '').trim()).filter(Boolean));
    return {
      containerNumber,
      shipmentCount: rows.length,
      customerCount: customers.size,
      shipments: [...rows].sort((a, b) => a.shipmentNumber.localeCompare(b.shipmentNumber)),
      customsDeclarations: myDeclarations,
      taxRefunds: myRefunds,
      totals: {
        totalPackages: rows.reduce((s, r) => s + (r.totalPackages ?? 0), 0),
        grossWeight: round4(rows.reduce((s, r) => s + (r.grossWeight ?? 0), 0)),
        volume: round4(rows.reduce((s, r) => s + (r.volume ?? 0), 0)),
      },
      conflicts: detectConsolidationConflicts(rows),
    };
  });

  containers.sort((a, b) => b.shipmentCount - a.shipmentCount || a.containerNumber.localeCompare(b.containerNumber));

  return {
    from: from ?? null,
    to: to ?? null,
    containers,
    unassigned: { shipmentCount: unassignedRows.length, shipments: unassignedRows.sort((a, b) => a.shipmentNumber.localeCompare(b.shipmentNumber)) },
    summary: {
      containerCount: containers.length,
      consolidatedCount: containers.filter(c => c.shipmentCount > 1).length,
      ticketCount: filtered.length,
      unassignedCount: unassignedRows.length,
      conflictCount: containers.reduce((s, c) => s + c.conflicts.length, 0),
    },
  };
}
