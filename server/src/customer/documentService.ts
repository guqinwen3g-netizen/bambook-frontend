/**
 * documentService.ts — 客户门户「单据下载」（§10.3-8 下半截）
 *
 * 业务口径（2026-09-12 业务方定案）：客户可下载 **PI（形式发票）/ CI（商业发票）/
 * 装箱单 / 发票**；报关单、验货报告、成衣工艺单等内部/官方单据不提供。
 *
 * 设计要点：
 *  1. **不新造渲染链**：全部复用服务端既有单据渲染（财务发票真源模板 FIN_CI、
 *     出运单据集 CI/PL），客户侧只负责「鉴权 + 归属过滤 + 状态门禁」。
 *  2. **归属过滤在查询层**（`customerRelationId`），并且**只放行已签发的单据**——
 *     草稿（Draft）绝不下发，避免把未定稿的价格/数量发给客户。
 *  3. **失败一律 404**：不区分「不存在」与「不属于你」，避免探测他人单据是否存在。
 *  4. 出运单据（CI/PL）归属判定与既有客户接口同口径：直接 `Shipment.customerRelationId`
 *     命中，或经分配表的来源订单属于该客户（多单拼柜）。
 */

import type { PrismaClient } from '@prisma/client';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { assembleDocumentSetData } from '../shipping/documentSetService';
import { renderHtmlToPdf } from '../templates/pdf';
import { logger } from '../lib/logger';

/**
 * 客户可下载的单据种类。
 *
 * H16（2026-09-16）新增 `bl`（提单）：提单是**给买方的物权凭证**（买方凭以提货），
 * 不是内部单据——与报关单/验货报告等「不提供」的类别性质不同。归属校验沿用
 * `shipmentBelongsToCustomer`（直接归属 ∪ 分配表来源订单归属），草稿运单不下发。
 */
export const CUSTOMER_DOCUMENT_KINDS = ['pi', 'invoice', 'ci', 'pl', 'bl', 'awb'] as const;
export type CustomerDocumentKind = (typeof CUSTOMER_DOCUMENT_KINDS)[number];

export function isCustomerDocumentKind(value: string): value is CustomerDocumentKind {
  return (CUSTOMER_DOCUMENT_KINDS as readonly string[]).includes(value);
}

export type CustomerDocumentErrorCode =
  | 'NOT_FOUND'          // 不存在 / 不属于该客户 / 非本类单据 / 未签发 —— 对外统一 404
  | 'RENDER_FAILED';     // 渲染链故障（对外 500）

export interface CustomerDocumentResult {
  ok: boolean;
  pdf?: Buffer;
  filename?: string;
  error?: { code: CustomerDocumentErrorCode; message: string };
}

const FILENAME_PREFIX: Record<CustomerDocumentKind, string> = {
  pi: 'Proforma-Invoice',
  invoice: 'Commercial-Invoice',
  ci: 'Commercial-Invoice',
  pl: 'Packing-List',
  bl: 'Bill-of-Lading',
  awb: 'Air-Waybill',
};

/** 单据号里可能有空格/斜杠，落到 Content-Disposition 前做最小净化 */
function safeFilename(prefix: string, docNo: string): string {
  const cleaned = String(docNo || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}${cleaned ? `-${cleaned}` : ''}.pdf`;
}

/** 该运单是否属于此客户：直接归属 ∪ 分配表的来源订单归属 */
async function shipmentBelongsToCustomer(
  prisma: PrismaClient,
  relationId: string,
  shipment: any,
): Promise<boolean> {
  if (shipment.customerRelationId === relationId) return true;
  const db = prisma as any;
  const allocs = await db.shipmentOrderAllocation
    .findMany({ where: { shipmentId: shipment.id }, select: { orderId: true } })
    .catch(() => []);
  const orderIds = Array.from(new Set((allocs ?? []).map((a: any) => a.orderId).filter(Boolean)));
  if (!orderIds.length) return false;
  const owned = await db.order
    .findFirst({ where: { id: { in: orderIds }, customerRelationId: relationId, deletedAt: null }, select: { id: true } })
    .catch(() => null);
  return Boolean(owned);
}

/**
 * 生成客户可下载单据的 HTML（未转 PDF）。返回 null 语义 = 「按 404 处理」。
 */
async function buildDocumentHtml(
  prisma: PrismaClient,
  relationId: string,
  kind: CustomerDocumentKind,
  id: string,
): Promise<{ html: string; filenamePrefix: string; docNo: string } | null> {
  const db = prisma as any;

  // ── 发票 / PI：同一条渲染链，靠 Invoice.type 区分（Proforma / Receivable）──
  if (kind === 'invoice' || kind === 'pi') {
    const expectedType = kind === 'invoice' ? 'Receivable' : 'Proforma';
    const invoice = await db.invoice
      .findFirst({
        where: { id, customerRelationId: relationId, type: expectedType, deletedAt: null },
        select: { id: true, invoiceNumber: true, status: true },
      })
      .catch(() => null);
    if (!invoice) return null;
    // 草稿绝不下发（未定稿的价格/数量不能给客户）
    if (invoice.status === 'Draft' || invoice.status === 'Cancelled') return null;

    const html = await renderServerDocument(
      prisma,
      'FIN_CI',
      null,
      { screen: false },
      { id: invoice.id, type: kind === 'pi' ? 'ProformaInvoice' : 'CommercialInvoice', sourceRef: invoice.id },
    );
    if (!html) return null;
    return { html, filenamePrefix: FILENAME_PREFIX[kind], docNo: invoice.invoiceNumber ?? '' };
  }

  // ── CI / PL / BL / AWB：出运单据集（运单维度）──
  const shipment = await db.shipment
    .findFirst({ where: { id, deletedAt: null } })
    .catch(() => null);
  if (!shipment) return null;
  if (!(await shipmentBelongsToCustomer(prisma, relationId, shipment))) return null;
  // 草稿运单不下发（内容还没定）
  if (shipment.status === 'Draft' || shipment.status === 'Cancelled') return null;

  const assembled = await assembleDocumentSetData(prisma, shipment.id);
  if (!assembled.ok) return null;

  // CI / PL / BL / AWB 同源（都走 assembleDocumentSetData 的出运单据集快照）
  const registryKind = kind === 'ci' ? 'CI' : kind === 'pl' ? 'PL' : kind === 'bl' ? 'BL' : 'AWB';
  const html = await renderServerDocument(prisma, registryKind, (assembled as any).data, { screen: false });
  if (!html) return null;
  return { html, filenamePrefix: FILENAME_PREFIX[kind], docNo: shipment.shipmentNumber ?? '' };
}

/**
 * 客户单据下载主入口：鉴权与归属由调用方保证（已校验客户 token），
 * 本函数负责「按客户归属取数 → 状态门禁 → 复用渲染链 → 转 PDF」。
 */
export async function renderCustomerDocumentPdf(
  prisma: PrismaClient,
  relationId: string,
  kind: CustomerDocumentKind,
  id: string,
): Promise<CustomerDocumentResult> {
  let built: Awaited<ReturnType<typeof buildDocumentHtml>> = null;
  try {
    built = await buildDocumentHtml(prisma, relationId, kind, id);
  } catch (e: any) {
    logger.error('[customer/document] 取数/渲染失败', { kind, error: e?.message || String(e) });
    return { ok: false, error: { code: 'RENDER_FAILED', message: 'Document rendering failed.' } };
  }
  if (!built) return { ok: false, error: { code: 'NOT_FOUND', message: 'Document not found.' } };

  try {
    const { pdf } = await renderHtmlToPdf(built.html, { format: 'A4' });
    return { ok: true, pdf: Buffer.from(pdf), filename: safeFilename(built.filenamePrefix, built.docNo) };
  } catch (e: any) {
    logger.error('[customer/document] HTML→PDF 失败', { kind, error: e?.message || String(e) });
    return { ok: false, error: { code: 'RENDER_FAILED', message: 'Document rendering failed.' } };
  }
}
