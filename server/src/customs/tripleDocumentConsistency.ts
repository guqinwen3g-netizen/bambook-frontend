/**
 * tripleDocumentConsistency.ts — T7-② 三单一致核对（箱单 / 商业发票 / 报关单）
 *
 * 设计真源：docs/design/T7-2-三单一致-设计-2026-09-16.md
 * 现状核准：docs/T7-2-三单一致-现状核准-2026-09-16.md（三单字段能力不对等 + 真库证据）
 *
 * 行业语义（外贸审单实务）：
 *   - 装箱单**不含金额**（真库 48 张 PackingList 的 totalAmount 全为空 = 正确业务状态）。
 *   - 商业发票**有数量列**（QTY / UNIT PRICE / AMOUNT），本系统 InvoiceLine 未建 quantity。
 *   - 报关单是**对外申报**数据，箱单/发票是**对内业务**数据 → 三单一致的价值在于
 *     核对外报数据与内部发货事实是否相符（报关行照单录入，填错是常态）。
 *
 * 数据源映射（业务方描述的实际流程：后勤拿「码单」→ 填箱单/发票）：
 *   箱单/发票的数量·品名 = **运单侧发货事实**（Shipment + ShipmentLine，与码单同源）
 *   发票的金额            = 财务 Invoice.amount（唯一真源，经 TradeDocument.sourceInvoiceId 回链）
 *   报关单                = 自己的行明细（对外申报，可能与实际不符——正是要核对的点）
 *
 * 口径（2026-09-16 业务方拍板 + 授权按行业专业判断）：
 *   - 比金额 + 数量 + 件数 + 毛净重 + 品名；**不一致只预警，绝不阻断**（severity 恒 'warning'）。
 *   - 金额项**仅在币种一致时比对**（与 T7-① 同口径：跨币种相减没有意义）。
 *
 * 纯只读：不写库、不触发状态重算；Decimal 累加避免 IEEE 754 漂移。
 */
import { Prisma, PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { readAuthorizedCiDocument } from './ciInvoiceSource';
import { isBusinessError } from '../shared/errorCodes';

export type TripleDocDiscrepancyType =
  | 'missing_document'          // 三单缺哪一张（组 A）
  | 'quantity_mismatch'         // 数量合计：Σ装运行 vs Σ报关行
  | 'packages_mismatch'         // 件数
  | 'gross_weight_mismatch'     // 毛重
  | 'net_weight_mismatch'       // 净重
  | 'amount_mismatch'           // 金额：发票 vs 报关申报总额
  | 'currency_mismatch'         // 币种：发票 vs 报关
  | 'product_name_mismatch';    // 品名：装运行 vs 报关行

export interface TripleDocDiscrepancy {
  type: TripleDocDiscrepancyType;
  field: string;
  /** 内部发货事实（期望） */
  expected: string;
  /** 单据上的值（实际） */
  actual: string;
  /** 口径 C：**恒为 warning**——三单不一致常有正当原因（赠品/样品不计价），不阻断交单 */
  severity: 'warning';
  message: string;
}

export interface TripleConsistencyDocuments {
  packingList: { id: string; documentNumber: string; status: string } | null;
  commercialInvoice: { id: string; documentNumber: string; status: string; invoiceId: string | null; invoiceNumber: string | null } | null;
  customsDeclaration: { id: string; declarationNumber: string; status: string } | null;
}

export interface TripleConsistencyResult {
  shipmentId: string;
  shipmentNumber: string | null;
  documents: TripleConsistencyDocuments;
  /** 内部发货事实（便于前端对照展示） */
  internal: {
    quantityTotal: number;
    totalPackages: number | null;
    grossWeight: number | null;
    netWeight: number | null;
    invoiceAmount: number | null;
    invoiceCurrency: string | null;
    lineCount: number;
  };
  /** 报关侧申报值 */
  declared: {
    quantityTotal: number;
    totalPackages: number | null;
    grossWeight: number | null;
    netWeight: number | null;
    totalValue: number | null;
    currency: string | null;
    lineCount: number;
  };
  discrepancies: TripleDocDiscrepancy[];
}

const EPS = new Prisma.Decimal('0.0001');

function dec(v: unknown): Prisma.Decimal {
  if (v === null || v === undefined) return new Prisma.Decimal(0);
  try { return new Prisma.Decimal(v as any); } catch { return new Prisma.Decimal(0); }
}

function d2n(d: Prisma.Decimal): number {
  return Number(d.toFixed(4));
}

/** 品名归一化：去首尾空白、折叠内部空白、统一大小写（中英混排只做空白与大小写，不做同义词映射） */
function normalizeName(v: unknown): string {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 三单一致核对。运单不存在/已软删 → null（由路由层转 404）。
 */
export async function checkTripleConsistency(
  prisma: PrismaClient,
  shipmentId: string,
  options: { trustedActor?: TokenPayload | null } = {},
): Promise<TripleConsistencyResult | null> {
  const db = prisma as any;

  const shipment = await db.shipment.findFirst({
    where: { id: shipmentId, deletedAt: null },
    select: {
      id: true, shipmentNumber: true, orderId: true,
      totalPackages: true, grossWeight: true, netWeight: true,
    },
  });
  if (!shipment) return null;

  // ── 三单 ────────────────────────────────────────────────────────────────
  const [packingList, commercialInvoiceDoc, declaration] = await Promise.all([
    db.tradeDocument.findFirst({
      where: { shipmentId, type: 'PackingList', deletedAt: null },
      select: { id: true, documentNumber: true, status: true },
    }),
    db.tradeDocument.findFirst({
      where: { shipmentId, type: 'CommercialInvoice', deletedAt: null },
      select: { id: true, documentNumber: true, status: true, sourceInvoiceId: true, totalAmount: true, currency: true },
    }),
    db.customsDeclaration.findFirst({
      where: { shipmentId, deletedAt: null },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    }),
  ]);

  // Only an actual, currently authorized original Invoice supplies CI money.
  // An unlinked historical copy remains a missing-source warning, never a
  // fallback financial fact. Auth/dependency failure is never swallowed.
  let invoiceRow: any = null, invoiceSourceMissing = false;
  if (commercialInvoiceDoc?.sourceInvoiceId) {
    try { invoiceRow = (await readAuthorizedCiDocument(prisma, commercialInvoiceDoc.id,
      { trustedActor: options.trustedActor ?? null, mode: 'preview' })).source.invoice; }
    catch (error) {
      if (!isBusinessError(error) || !['NOT_FOUND', 'CONFLICT'].includes(error.code)) throw error;
      invoiceSourceMissing = true;
    }
  } else if (commercialInvoiceDoc) invoiceSourceMissing = true;
  const invoiceAmount = invoiceRow?.amount != null ? dec(invoiceRow.amount) : null;
  const invoiceCurrency: string | null = invoiceRow?.currency ?? null;

  // ── 内部发货事实（箱单/发票的数量·品名同源）────────────────────────────
  const shipmentLines: any[] = await db.shipmentLine.findMany({
    where: { shipmentId },
    orderBy: { lineNumber: 'asc' },
  });
  let internalQty = new Prisma.Decimal(0);
  for (const l of shipmentLines) internalQty = internalQty.plus(dec(l.quantity));

  // ── 报关侧申报值 ────────────────────────────────────────────────────────
  const cdLines: any[] = declaration?.lines ?? [];
  let declaredQty = new Prisma.Decimal(0);
  for (const l of cdLines) declaredQty = declaredQty.plus(dec(l.quantity));

  const discrepancies: TripleDocDiscrepancy[] = [];
  const push = (
    type: TripleDocDiscrepancyType, field: string,
    expected: string, actual: string, message: string,
  ) => discrepancies.push({ type, field, expected, actual, severity: 'warning', message });

  // ── 组 A · 单据完整性 ───────────────────────────────────────────────────
  if (invoiceSourceMissing) push('missing_document', 'commercialInvoice.sourceInvoiceId', '可核验原财务发票', '原来源缺失或不合格', '历史商业发票副本不能替代原财务金额；请核对原发票来源');
  if (!packingList) push('missing_document', 'packingList', '应存在装箱单', '未生成', '本票未生成装箱单（PackingList），无法与报关单核对件数/毛净重');
  if (!commercialInvoiceDoc) push('missing_document', 'commercialInvoice', '应存在商业发票', '未生成', '本票未生成商业发票（CommercialInvoice），无法与报关单核对金额');
  if (!declaration) push('missing_document', 'customsDeclaration', '应存在报关单', '未生成', '本票未生成报关单，三单一致无从核对');

  // 报关单缺失时，组 B 全部无法比对（避免刷一屏无意义的"0 vs X"）
  if (declaration) {
    // ── 组 B · 对外一致性（报关单 ↔ 内部发货事实）──────────────────────
    if (declaredQty.minus(internalQty).abs().gt(EPS)) {
      push('quantity_mismatch', 'quantityTotal',
        d2n(internalQty).toString(), d2n(declaredQty).toString(),
        `数量不一致：装运行合计 ${d2n(internalQty)}，报关申报合计 ${d2n(declaredQty)}（差 ${d2n(declaredQty.minus(internalQty))}）`);
    }

    const cmpInt = (field: string, internalVal: unknown, declaredVal: unknown, label: string, type: TripleDocDiscrepancyType) => {
      if (internalVal == null && declaredVal == null) return;
      const a = internalVal == null ? null : dec(internalVal);
      const b = declaredVal == null ? null : dec(declaredVal);
      // 一方缺值：报"无法核对"而不是差异（数据不全 ≠ 数据不一致）
      if (a == null || b == null) {
        push(type, field, a == null ? '(装运侧未填)' : d2n(a).toString(), b == null ? '(报关侧未填)' : d2n(b).toString(),
          `${label}一方未填，无法核对（装运侧 ${a == null ? '空' : d2n(a)} / 报关侧 ${b == null ? '空' : d2n(b)}）`);
        return;
      }
      if (a.minus(b).abs().gt(EPS)) {
        push(type, field, d2n(a).toString(), d2n(b).toString(), `${label}不一致：装运侧 ${d2n(a)}，报关侧 ${d2n(b)}`);
      }
    };

    cmpInt('totalPackages', shipment.totalPackages, declaration.totalPackages, '件数', 'packages_mismatch');
    cmpInt('grossWeight', shipment.grossWeight, declaration.grossWeight, '毛重', 'gross_weight_mismatch');
    cmpInt('netWeight', shipment.netWeight, declaration.netWeight, '净重', 'net_weight_mismatch');

    // 金额：**仅同币种比对**（跨币种相减无意义 —— 与 T7-① 同口径）
    const cdCurrency: string | null = declaration.currency ?? null;
    if (invoiceCurrency && cdCurrency && invoiceCurrency !== cdCurrency) {
      push('currency_mismatch', 'currency', invoiceCurrency, cdCurrency,
        `币种不一致：发票 ${invoiceCurrency}，报关 ${cdCurrency}——金额不做跨币种比对（请按币种分别核对）`);
    } else if (invoiceAmount != null && declaration.totalValue != null) {
      if (invoiceAmount.minus(dec(declaration.totalValue)).abs().gt(EPS)) {
        push('amount_mismatch', 'totalValue',
          d2n(invoiceAmount).toString(), d2n(dec(declaration.totalValue)).toString(),
          `金额不一致：发票 ${d2n(invoiceAmount)}${invoiceCurrency ? ` ${invoiceCurrency}` : ''}，报关申报 ${d2n(dec(declaration.totalValue))}${cdCurrency ? ` ${cdCurrency}` : ''}`);
      }
    } else if (invoiceAmount == null || declaration.totalValue == null) {
      push('amount_mismatch', 'totalValue',
        invoiceAmount == null ? '(发票金额未取到)' : d2n(invoiceAmount).toString(),
        declaration.totalValue == null ? '(报关总额未填)' : d2n(dec(declaration.totalValue)).toString(),
        '金额一方缺失，无法核对（发票侧或报关侧未填）');
    }

    // 品名：按 productCode 匹配（无 code 回退行序），比较归一化后的品名
    const declaredByCode = new Map<string, any>();
    const declaredNoCode: any[] = [];
    for (const l of cdLines) {
      const code = String(l.productCode ?? '').trim();
      if (code) declaredByCode.set(code, l); else declaredNoCode.push(l);
    }
    let noCodeCursor = 0;
    for (const sl of shipmentLines) {
      const code = String(sl.productCode ?? '').trim();
      const match = code ? declaredByCode.get(code) : declaredNoCode[noCodeCursor++];
      if (!match) {
        push('product_name_mismatch', `line.${sl.lineNumber}`,
          String(sl.productName ?? ''), '(报关侧无对应行)',
          `装运行 ${sl.lineNumber}（${sl.productName ?? '未填品名'}）在报关单里找不到对应行`);
        continue;
      }
      const a = normalizeName(sl.productName);
      const b = normalizeName(match.productName);
      if (a && b && a !== b) {
        // 真库实测：报关品名常比装运行多出颜色/规格后缀（如「空气层面料 Air Layer」vs
        // 「空气层面料 Air Layer（Terracotta）」）。前缀关系点明出来，让人一眼分辨
        // 「只是更详细」还是「根本是不同的货」——两者都值得看一眼，故 severity 一视同仁。
        const hint = b.startsWith(a) ? '（报关侧 = 装运侧 + 后缀，通常是颜色/规格）'
          : a.startsWith(b) ? '（装运侧更详细）'
          : '';
        push('product_name_mismatch', `line.${sl.lineNumber}`,
          String(sl.productName ?? ''), String(match.productName ?? ''),
          `品名不一致（装运行 ${sl.lineNumber} vs 报关行 ${match.lineNumber}）：${sl.productName ?? '空'} / ${match.productName ?? '空'}${hint}`);
      }
    }
    if (shipmentLines.length !== cdLines.length) {
      push('product_name_mismatch', 'lineCount',
        String(shipmentLines.length), String(cdLines.length),
        `行数不一致：装运行 ${shipmentLines.length} 行，报关 ${cdLines.length} 行`);
    }
  }

  return {
    shipmentId: shipment.id,
    shipmentNumber: shipment.shipmentNumber ?? null,
    documents: {
      packingList: packingList ? { id: packingList.id, documentNumber: packingList.documentNumber, status: packingList.status } : null,
      commercialInvoice: commercialInvoiceDoc
        ? {
            id: commercialInvoiceDoc.id,
            documentNumber: commercialInvoiceDoc.documentNumber,
            status: commercialInvoiceDoc.status,
            invoiceId: invoiceRow?.id ?? null,
            invoiceNumber: invoiceRow?.invoiceNumber ?? null,
          }
        : null,
      customsDeclaration: declaration
        ? { id: declaration.id, declarationNumber: declaration.declarationNumber, status: declaration.status }
        : null,
    },
    internal: {
      quantityTotal: d2n(internalQty),
      totalPackages: shipment.totalPackages ?? null,
      grossWeight: shipment.grossWeight != null ? Number(dec(shipment.grossWeight)) : null,
      netWeight: shipment.netWeight != null ? Number(dec(shipment.netWeight)) : null,
      invoiceAmount: invoiceAmount != null ? d2n(invoiceAmount) : null,
      invoiceCurrency,
      lineCount: shipmentLines.length,
    },
    declared: {
      quantityTotal: d2n(declaredQty),
      totalPackages: declaration?.totalPackages ?? null,
      grossWeight: declaration?.grossWeight != null ? Number(dec(declaration.grossWeight)) : null,
      netWeight: declaration?.netWeight != null ? Number(dec(declaration.netWeight)) : null,
      totalValue: declaration?.totalValue != null ? d2n(dec(declaration.totalValue)) : null,
      currency: declaration?.currency ?? null,
      lineCount: cdLines.length,
    },
    discrepancies,
  };
}
