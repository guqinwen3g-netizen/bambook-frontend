/**
 * 出运制单数据装配服务 Document Set Assembly Service
 *
 * 职责：
 *   以 Shipment 为主轴，聚合 Order / OrderLine / CustomsDeclaration / Relation
 *   多源数据，解析出制单（CI/PL/CO/BL）所需的标准化字段。
 *
 * 设计原则：
 *   - 单一回退链真源：所有 "shipment → order → customs → relation" 的字段
 *     回退逻辑只在此服务内实现一次，前端模板只消费不决策。
 *   - 只读：不做任何写入，不产生副作用。
 *   - 宽容缺失：订单/报关单未关联时仍返回可用骨架（对应字段为 null），
 *     由前端 UI 提示数据完整度，而非阻断制单。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { extractIncotermCode, sameIncoterm } from '../_shared/incoterm';
// ★ S4 任务3：制单金额回退链末端的 `num(order?.totalNet) ?? num(order?.quoteAmount)` 收敛到真源
import { orderAmountOf } from '../shared/orderAmount';
import { shipmentDocumentSourceInTx, documentDecimal, type ShipmentDocumentSourceOptions } from './shipmentDocumentSource';

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface DocumentSetLine {
  lineNumber: number;
  description: string;
  productCode: string | null;
  hsCode: string | null;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  amount: number | null;
  cartons: number | null;
  grossWeight: number | null;
  netWeight: number | null;
  volume: number | null;
  originCountry: string | null;
}

export interface DocumentSetParty {
  name: string;
  address: string | null;
  contact: string | null;
}

export interface DocumentSetData {
  shipment: {
    id: string;
    shipmentNumber: string;
    status: string;
    type: string;
    shippingMethod: string | null;
    vesselOrFlight: string | null;
    voyageNumber: string | null;
    portOfLoading: string | null;
    portOfDischarge: string | null;
    containerNumber: string | null;
    sealNumber: string | null;
    bookingDate: string | null;
    etd: string | null;
    atd: string | null;
    eta: string | null;
    totalPackages: number | null;
    grossWeight: number | null;
    netWeight: number | null;
    volume: number | null;
    hsCode: string | null;
    customsDeclarationNumber: string | null;
    notes: string | null;
  };
  order: {
    id: string;
    poNumber: string | null;
    customer: string;
    currency: string | null;
    deliveryTerms: string | null;
    paymentTerms: string | null;
    salesContractNumber: string | null;
    finalContractNumber: string | null;
    invoiceNumber: string | null;
    invoiceDate: string | null;
  } | null;
  customs: {
    declarationNumber: string;
    declarationDate: string | null;
    declarationPort: string | null;
    tradeTerms: string | null;
    totalValue: number | null;
    currency: string | null;
    originCountry: string | null;
    destinationCountry: string | null;
    consignee: string | null;
    consignor: string | null;
  } | null;
  parties: {
    /** 客户 / 收货人（CI 的 Buyer、PL 抬头） */
    customer: DocumentSetParty | null;
    /** 收货方（BL Consignee / CO Consignee） */
    consignee: DocumentSetParty | null;
    /** 货代/船公司 */
    carrier: { name: string } | null;
  };
  lines: DocumentSetLine[];
  totals: {
    quantity: number | null;
    amount: number | null;
    cartons: number | null;
    grossWeight: number | null;
    netWeight: number | null;
    volume: number | null;
    currency: string | null;
  };
  /** 数据完整度提示（供 UI 展示，不阻断） */
  missing: string[];
  /** 阶段 D / D4：Form A / 保险单 / 受益人证明扩展装配 */
  extras: {
    /** Form A 第 8 栏原产地标准（默认 'P' = 完全原产，纺织品出口惯例） */
    originCriterion: string;
    insurance: {
      /** 投保金额：CIF/CIP 条款按货值 ×110% 惯例推断；否则 null */
      insuredAmount: number | null;
      currency: string | null;
      /** 险别（默认 CIC 一切险+战争险） */
      coverage: string;
      /** 保费（shipment.insuranceAmount，成本字段，非保额） */
      premium: number | null;
      premiumCurrency: string | null;
      /** 保险人（schema 无字段，预留 null → 模板显示 —） */
      insurer: string | null;
    };
    /** 关联信用证摘要（经 orderId 解析，受益人证明/保险单引用） */
    letterOfCredit: {
      lcNumber: string;
      issueBank: string | null;
      issueDate: string | null;
      applicant: string | null;
    } | null;
  };
}

export type DocumentSetErrorCode = 'SHIPMENT_NOT_FOUND' | 'ASSEMBLE_FAILED';

/**
 * ★ 域内码 → **对外 HTTP 错误码**的唯一一份映射（v2.47 复核 I-1）。
 *   背景：`shipping/route.ts` 与 `customs/compositeDocumentService.ts` 曾各写一遍
 *   「`SHIPMENT_NOT_FOUND` 才算 404、其余算 500」⇒ 同一句判断两处并行，而且其中一处是"码→码"，
 *   B32 那把只认 `code === 'X' ? <数字>` 的棘轮**结构上看不见它**（复核抓出来的，不是我自己发现的）。
 *   用 `Record<union, …>` 而不是三元 ⇒ union 加第三枚码会**编译期报错**，不会静默进 500 那一档。
 *   ⚠️ 只管"是哪枚对外码"，**档位数值仍只在 `shared/errorCodes` 那份注册表里**。
 *   ★ 为什么不放注册表侧（试过，被守卫否决）：`routeErrorSourceGuard` 要求 **`errorCodes.ts` 零 import**
 *     （它必须能被任何层引用 ⇒ 不能有依赖）；放本文件既合这条硬约束，也让 union 与它的映射同源。
 *     代价是 `compositeDocument.test.ts` 原来用 `vi.mock(整模块)` 会吞掉本函数 ⇒ 该桩已改为
 *     `{ ...actual, assembleDocumentSetData }`（台账 B64 那一族的正解：桩只吞要换的那一个导出）。
 */
const DOC_SET_HTTP_CODE: Record<DocumentSetErrorCode, 'NOT_FOUND' | 'ASSEMBLE_FAILED'> = {
  SHIPMENT_NOT_FOUND: 'NOT_FOUND',
  ASSEMBLE_FAILED: 'ASSEMBLE_FAILED',
};
export function documentSetHttpErrorCode(code: DocumentSetErrorCode): 'NOT_FOUND' | 'ASSEMBLE_FAILED' {
  return DOC_SET_HTTP_CODE[code];
}

export interface DocumentSetResult {
  ok: boolean;
  data?: DocumentSetData;
  error?: { code: DocumentSetErrorCode; message: string };
}

/** Canonical DTO from the authorized actual-source entry. All decimal fields
 * are strings/null; counts remain integers. This is deliberately distinct from
 * the unchanged numeric legacy/internal DTO above. */
type ExactFields<T, K extends keyof T> = Omit<T, K> & { [P in K]: string | null };
export type SourceDocumentSetLine = ExactFields<DocumentSetLine, 'quantity' | 'unitPrice' | 'amount' | 'grossWeight' | 'netWeight' | 'volume'> & {
  shipmentLineId: string; orderId: string | null; orderLineId: string | null; productionBatchIds: string[]; cartonItems: any[];
};
export type SourceDocumentSetData = Omit<DocumentSetData, 'shipment' | 'lines' | 'totals' | 'customs' | 'extras'> & {
  shipment: ExactFields<DocumentSetData['shipment'], 'grossWeight' | 'netWeight' | 'volume'>;
  lines: SourceDocumentSetLine[];
  totals: ExactFields<DocumentSetData['totals'], 'quantity' | 'amount' | 'grossWeight' | 'netWeight' | 'volume'>;
  customs: ExactFields<NonNullable<DocumentSetData['customs']>, 'totalValue'> | null;
  extras: Omit<DocumentSetData['extras'], 'insurance'> & { insurance: ExactFields<DocumentSetData['extras']['insurance'], 'insuredAmount' | 'premium'> };
  orders: Array<{ id: string; orderNumber: string | null; poNumber: string | null; currency: string | null; deliveryTerms: string | null; paymentTerms: string | null }>;
  cartons: any[];
  source: { schemaVersion: 1; fingerprint: string; orderIds: string[]; kind: 'legacy' | 'physical' | 'claim'; cartonCoverageComplete: boolean };
};
export interface SourceDocumentSetResult { ok: true; data: SourceDocumentSetData; error?: undefined; }

// ────────────────────────────────────────────────────────────────
// 辅助
// ────────────────────────────────────────────────────────────────

function num(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: any): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

/** 第一个非空值（null/undefined/'' 视为空） */
function first<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) {
    if (v !== null && v !== undefined && (v as any) !== '') return v;
  }
  return null;
}

/**
 * 行级字段求和。partial = 部分行有值、部分行缺值：
 * 此时合计是"看似权威的少算值"（报关/箱单差错风险），调用方必须回退运单/报关级数据并提示，不得直接采用。
 * 全部行有值 → total；全部缺值 → { null, false }（走调用方既有回退链）。
 */
function sumField(lines: DocumentSetLine[], key: keyof DocumentSetLine): { total: number | null; partial: boolean } {
  let has = false;
  let incomplete = false;
  let sum = 0;
  for (const l of lines) {
    const v = l[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      has = true;
    } else {
      incomplete = true;
    }
  }
  if (!has) return { total: null, partial: false };
  return { total: Math.round(sum * 10000) / 10000, partial: incomplete };
}

function relationToParty(rel: any, nameFallback?: string | null, addressFallback?: string | null, contactFallback?: string | null): DocumentSetParty | null {
  if (!rel && !nameFallback) return null;
  const name = str(rel?.englishName) ?? str(rel?.chineseName) ?? str(rel?.name) ?? str(nameFallback);
  if (!name) return null;
  return {
    name,
    address: str(rel?.officialAddress) ?? str(rel?.shippingAddress) ?? str(rel?.billingAddress) ?? str(addressFallback),
    contact: str(rel?.primaryContactName) ?? str(rel?.contact) ?? str(contactFallback),
  };
}

// ────────────────────────────────────────────────────────────────
// 主装配
// ────────────────────────────────────────────────────────────────

export function assembleDocumentSetData(prisma: PrismaClient, shipmentId: string): Promise<DocumentSetResult>;
export function assembleDocumentSetData(prisma: PrismaClient, shipmentId: string, options: ShipmentDocumentSourceOptions): Promise<SourceDocumentSetResult>;
export function assembleDocumentSetData(prisma: PrismaClient, shipmentId: string, options: ShipmentDocumentSourceOptions | undefined): Promise<DocumentSetResult | SourceDocumentSetResult>;
export async function assembleDocumentSetData(
  prisma: PrismaClient,
  shipmentId: string,
  options?: ShipmentDocumentSourceOptions,
): Promise<DocumentSetResult | SourceDocumentSetResult> {
  if (options) return assembleExactDocumentSetData(prisma, shipmentId, options);
  try {
    const db = prisma as any;

    // 1) 运单（必须存在）
    const shipment = await db.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment || shipment.deletedAt) {
      return { ok: false, error: { code: 'SHIPMENT_NOT_FOUND', message: `运单 ${shipmentId} 不存在` } };
    }

    // 2) 并行拉取关联数据
    const [shipmentLines, order, customsDecl, customerRel, carrierRel] = await Promise.all([
      db.shipmentLine.findMany({ where: { shipmentId }, orderBy: { lineNumber: 'asc' } }),
      shipment.orderId
        ? db.order.findUnique({ where: { id: shipment.orderId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } })
        : Promise.resolve(null),
      db.customsDeclaration.findFirst({
        where: { shipmentId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      }),
      shipment.customerRelationId
        ? db.relation.findUnique({ where: { id: shipment.customerRelationId } })
        : Promise.resolve(null),
      shipment.carrierRelationId
        ? db.relation.findUnique({ where: { id: shipment.carrierRelationId } })
        : Promise.resolve(null),
    ]);

    const orderLines: any[] = order?.lines ?? [];
    const customsLines: any[] = customsDecl?.lines ?? [];

    // 3) 收货方 Relation（BL/CO 用）：优先 order.consigneeRelationId
    let consigneeRel: any = null;
    if (order?.consigneeRelationId) {
      consigneeRel = await db.relation.findUnique({ where: { id: order.consigneeRelationId } });
    }

    // 3b) 阶段 D / D4：关联信用证（受益人证明/保险单引用）——经 orderId 取最近一张
    const lcRow = order
      ? await db.letterOfCredit.findFirst({
          where: { orderId: order.id, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        })
      : null;

    // 4) 行装配：以 shipmentLines 为主轴；无行时回退 orderLines
    const lines: DocumentSetLine[] = [];
    if (shipmentLines.length > 0) {
      for (const sl of shipmentLines) {
        const ol = sl.orderLineId ? orderLines.find((l) => l.id === sl.orderLineId) : orderLines[sl.lineNumber - 1];
        const cl = customsLines[sl.lineNumber - 1];
        const quantity = num(sl.quantity) ?? num(ol?.quantity) ?? num(cl?.quantity);
        const unitPrice = num(ol?.unitPrice) ?? num(cl?.unitPrice);
        const amount = num(ol?.netValue) ?? num(cl?.totalAmount)
          ?? (quantity !== null && unitPrice !== null ? Math.round(quantity * unitPrice * 10000) / 10000 : null);
        lines.push({
          lineNumber: sl.lineNumber,
          description: first(str(sl.productName), str(ol?.description), str(cl?.productName)) ?? `Line ${sl.lineNumber}`,
          productCode: first(str(sl.productCode), str(ol?.itemNo), str(cl?.productCode)),
          hsCode: first(str(sl.hsCode), str(cl?.hsCode), str(shipment.hsCode)),
          quantity,
          unit: first(str(sl.unit), str(ol?.unit), str(cl?.unit)),
          unitPrice,
          amount,
          cartons: num(sl.cartons),
          grossWeight: num(sl.grossWeight) ?? num(cl?.grossWeight),
          netWeight: num(sl.netWeight) ?? num(cl?.netWeight),
          volume: num(sl.volume),
          originCountry: first(str(sl.countryOfOrigin), str(cl?.originCountry), str(customsDecl?.originCountry)),
        });
      }
    } else {
      // 无装运行 → 从订单行构造骨架（箱规/重量留空）
      for (const ol of orderLines) {
        const cl = customsLines[ol.lineNumber - 1];
        const quantity = num(ol.quantity) ?? num(cl?.quantity);
        const unitPrice = num(ol.unitPrice) ?? num(cl?.unitPrice);
        const amount = num(ol.netValue) ?? num(cl?.totalAmount)
          ?? (quantity !== null && unitPrice !== null ? Math.round(quantity * unitPrice * 10000) / 10000 : null);
        lines.push({
          lineNumber: ol.lineNumber,
          description: first(str(ol.description), str(cl?.productName)) ?? `Line ${ol.lineNumber}`,
          productCode: first(str(ol.itemNo), str(cl?.productCode)),
          hsCode: first(str(cl?.hsCode), str(shipment.hsCode)),
          quantity,
          unit: first(str(ol.unit), str(cl?.unit)),
          unitPrice,
          amount,
          cartons: null,
          grossWeight: num(cl?.grossWeight),
          netWeight: num(cl?.netWeight),
          volume: null,
          originCountry: first(str(cl?.originCountry), str(customsDecl?.originCountry)),
        });
      }
    }

    // 5) 合计：行合计优先，运单级兜底；行级部分和（部分行缺值）不可作合计 → 回退并告警
    const lineSums = {
      quantity: sumField(lines, 'quantity'),
      amount: sumField(lines, 'amount'),
      cartons: sumField(lines, 'cartons'),
      grossWeight: sumField(lines, 'grossWeight'),
      netWeight: sumField(lines, 'netWeight'),
      volume: sumField(lines, 'volume'),
    };
    const totals = {
      quantity: lineSums.quantity.partial ? null : lineSums.quantity.total,
      // ★ S4 任务3：末端回退链（原 `num(order?.totalNet) ?? num(order?.quoteAmount)`）收敛到真源。
      //   ★ 只传 totalNet/quoteAmount，**不传整个 order** —— 本行上方已有 `lineSums.amount.partial`
      //     守卫（部分行缺值 ⇒ 行合计不可用，必须回退主档）；若传整个 order，真源① Σ明细行会被激活，
      //     等于把刚被 partial 拒掉的**部分和**从后门放回来。
      amount: (lineSums.amount.partial ? null : lineSums.amount.total) ?? num(customsDecl?.totalValue) ?? (orderAmountOf({ totalNet: order?.totalNet, quoteAmount: order?.quoteAmount }) || null),
      cartons: (lineSums.cartons.partial ? null : lineSums.cartons.total) ?? (num(shipment.totalPackages) ?? num(customsDecl?.totalPackages)),
      grossWeight: (lineSums.grossWeight.partial ? null : lineSums.grossWeight.total) ?? num(shipment.grossWeight) ?? num(customsDecl?.grossWeight),
      netWeight: (lineSums.netWeight.partial ? null : lineSums.netWeight.total) ?? num(shipment.netWeight) ?? num(customsDecl?.netWeight),
      volume: (lineSums.volume.partial ? null : lineSums.volume.total) ?? num(shipment.volume),
      currency: first(str(customsDecl?.currency), str(order?.currency), str(order?.salesCurrency)),
    };

    // 6) 当事方
    const customer = relationToParty(
      customerRel,
      first(str(shipment.customerName), str(order?.billToName), str(order?.customer)),
      first(str(order?.billToAddress), str(order?.customerAddress)),
      str(order?.billToContact),
    );
    const consignee = relationToParty(
      consigneeRel,
      first(str(order?.consigneeName), str(customsDecl?.consignee)),
      str(order?.consigneeAddress),
      str(order?.consigneeContact),
    ) ?? customer; // 无独立收货方时回退客户（常见：直客订单）
    const carrier = (() => {
      const name = str(carrierRel?.englishName) ?? str(carrierRel?.chineseName) ?? str(carrierRel?.name) ?? str(shipment.carrierName);
      return name ? { name } : null;
    })();

    // 7) 完整度提示
    const missing: string[] = [];
    if (!order) missing.push('未关联订单（缺少价格/条款来源）');
    if (!customsDecl) missing.push('未关联报关单（缺少申报要素）');
    if (lines.length === 0) missing.push('无行明细（装运行与订单行均为空）');
    if (lineSums.quantity.partial) missing.push('部分行缺少数量（合计不可信，已留空，请补齐行数据）');
    if (lineSums.amount.partial) missing.push('部分行缺少金额（合计已回退运单/报关级数据）');
    if (lineSums.cartons.partial) missing.push('部分行缺少箱数（合计已回退运单级数据）');
    if (lineSums.grossWeight.partial) missing.push('部分行缺少毛重（合计已回退运单级数据）');
    if (lineSums.netWeight.partial) missing.push('部分行缺少净重（合计已回退运单级数据）');
    if (lineSums.volume.partial) missing.push('部分行缺少体积（合计已回退运单级数据）');
    if (totals.amount === null) missing.push('缺少金额（订单行无单价/净值）');
    if (totals.grossWeight === null) missing.push('缺少毛重');
    if (!customer) missing.push('缺少客户信息');

    // 8) 阶段 D / D4：Form A / 保险单 / 受益人证明扩展装配
    // D2：成交方式双源（订单 `Order.deliveryTerms` / 报关 `CustomsDeclaration.tradeTerms`）
    // 不一致时**不静默取其一**（对齐对账域原则 reconciliationService.ts:8-10）。
    // 仍以**订单条款**出单据（订单/合同是与客户谈定的商业合同依据；报关单是申报数据，
    // 申报须与合同一致 → 不一致该纠正的是报关单，不是反过来改商业单据）。
    // 注意下面 incoTerms 还驱动「卖方是否投保」→ 不一致会产出错误的保险单要求，故必须报出来。
    // 用共享的成交方式解析（`FOB SHANGHAI` 与 `FOB` 是**同一成交方式**——订单写法带港口、
    // 报关成交方式栏只填代码，直接逐字比会大面积误报）。
    const orderTermsRaw = str(order?.deliveryTerms);
    const declTermsRaw = str(customsDecl?.tradeTerms);
    const orderTermsNorm = extractIncotermCode(orderTermsRaw);
    const declTermsNorm = extractIncotermCode(declTermsRaw);
    if (orderTermsNorm && declTermsNorm && !sameIncoterm(orderTermsRaw, declTermsRaw)) {
      missing.push(
        `订单条款 ${orderTermsNorm} 与报关成交方式 ${declTermsNorm} 不一致`
        + `（已按订单条款出单据；报关成交方式应向海关更正——申报须与合同一致）`,
      );
    }
    const incoTerms = (first(str(order?.deliveryTerms), str(customsDecl?.tradeTerms)) ?? '').toUpperCase();
    const sellerPaysInsurance = /CIF|CIP/.test(incoTerms);
    const insuredAmount = sellerPaysInsurance && totals.amount !== null
      ? Math.round(totals.amount * 1.1 * 100) / 100
      : null;
    if (sellerPaysInsurance && insuredAmount === null) {
      missing.push('CIF/CIP 条款下缺少货值（无法推断投保金额）');
    }
    const extras: DocumentSetData['extras'] = {
      originCriterion: 'P',
      insurance: {
        insuredAmount,
        currency: insuredAmount !== null ? totals.currency : null,
        coverage: 'COVERING ALL RISKS AND WAR RISKS AS PER C.I.C. (1/1/1981)',
        premium: num(shipment.insuranceAmount),
        premiumCurrency: str(shipment.insuranceCurrency),
        insurer: null,
      },
      letterOfCredit: lcRow
        ? {
            lcNumber: lcRow.lcNumber,
            issueBank: str(lcRow.issueBank),
            issueDate: str(lcRow.issueDate),
            applicant: str(lcRow.applicant),
          }
        : null,
    };

    return {
      ok: true,
      data: {
        shipment: {
          id: shipment.id,
          shipmentNumber: shipment.shipmentNumber,
          status: shipment.status,
          type: shipment.type,
          shippingMethod: str(shipment.shippingMethod),
          vesselOrFlight: str(shipment.vesselOrFlight),
          voyageNumber: str(shipment.voyageNumber),
          portOfLoading: str(shipment.portOfLoading),
          portOfDischarge: str(shipment.portOfDischarge),
          containerNumber: str(shipment.containerNumber),
          sealNumber: str(shipment.sealNumber),
          bookingDate: str(shipment.bookingDate),
          etd: str(shipment.etd),
          atd: str(shipment.atd),
          eta: str(shipment.eta),
          totalPackages: num(shipment.totalPackages),
          grossWeight: num(shipment.grossWeight),
          netWeight: num(shipment.netWeight),
          volume: num(shipment.volume),
          hsCode: str(shipment.hsCode),
          customsDeclarationNumber: first(str(shipment.customsDeclarationNumber), str(customsDecl?.declarationNumber)),
          notes: str(shipment.notes),
        },
        order: order
          ? {
              id: order.id,
              poNumber: str(order.poNumber),
              customer: order.customer,
              currency: first(str(order.currency), str(order.salesCurrency)),
              deliveryTerms: first(str(order.deliveryTerms), str(customsDecl?.tradeTerms)),
              paymentTerms: str(order.paymentTerms),
              salesContractNumber: str(order.salesContractNumber),
              finalContractNumber: str(order.finalContractNumber),
              invoiceNumber: str(order.invoiceNumber),
              invoiceDate: str(order.invoiceDate),
            }
          : null,
        customs: customsDecl
          ? {
              declarationNumber: customsDecl.declarationNumber,
              declarationDate: str(customsDecl.declarationDate),
              declarationPort: str(customsDecl.declarationPort),
              tradeTerms: str(customsDecl.tradeTerms),
              totalValue: num(customsDecl.totalValue),
              currency: str(customsDecl.currency),
              originCountry: str(customsDecl.originCountry),
              destinationCountry: str(customsDecl.destinationCountry),
              consignee: str(customsDecl.consignee),
              consignor: str(customsDecl.consignor),
            }
          : null,
        parties: { customer, consignee, carrier },
        lines,
        totals,
        missing,
        extras,
      },
    };
  } catch (e: any) {
    return { ok: false, error: { code: 'ASSEMBLE_FAILED', message: String(e?.message ?? e) } };
  }
}

/** Authorized entry used by the official object-bound routes. Original legacy
 * internal assembly remains unchanged above; no positional/whole-order goods
 * fallback is permitted in this source-bound result. Decimal facts travel as
 * strings. The old numeric interface describes only that legacy seam. */
async function assembleExactDocumentSetData(prisma: PrismaClient, shipmentId: string, options: ShipmentDocumentSourceOptions): Promise<SourceDocumentSetResult> {
  return prisma.$transaction(async tx => {
    const source = await shipmentDocumentSourceInTx(tx, shipmentId, options), shipment = source.shipment;
    const same = (key: string) => { const values = [...new Set(source.orders.map(order => str(order[key])))]; return values.length === 1 ? values[0] : null; };
    const customerId = same('customerRelationId') ?? str(shipment.customerRelationId);
    const consigneeId = same('consigneeRelationId');
    const [customerRel, carrierRel, declaration, consigneeRel, lcRows] = await Promise.all([
      customerId ? tx.relation.findUnique({ where: { id: customerId } }) : null,
      shipment.carrierRelationId ? tx.relation.findUnique({ where: { id: shipment.carrierRelationId } }) : null,
      tx.customsDeclaration.findFirst({ where: { shipmentId, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
      consigneeId ? tx.relation.findUnique({ where: { id: consigneeId } }) : null,
      source.orderIds.length ? tx.letterOfCredit.findMany({ where: { orderId: { in: source.orderIds }, deletedAt: null }, orderBy: { createdAt: 'desc' } }) : [],
    ]);
    const missing: string[] = [];
    if (!source.lines.length) missing.push('本票尚无实际装运行（不回退整单数量）');
    if (source.orders.length > 1) missing.push('合票包含多个原订单；单据引用全部原订单，不猜测主订单');
    if (!source.cartonCoverageComplete) missing.push('箱内实际分配尚未完整覆盖本票装运行');
    const lines = source.lines.map(line => {
      const original = line.originalOrderLine;
      return { lineNumber: line.lineNumber, shipmentLineId: line.id, orderLineId: line.orderLineId ?? null, orderId: line.orderId,
        productionBatchIds: line.productionBatchIds, description: str(line.productName) ?? str(original?.description) ?? '',
        productCode: str(line.productCode) ?? str(original?.itemNo), hsCode: str(line.hsCode), quantity: line.quantity,
        unit: line.unit, unitPrice: line.unitPrice, amount: line.amount, cartons: line.cartons ?? null,
        grossWeight: documentDecimal(line.grossWeight), netWeight: documentDecimal(line.netWeight), volume: documentDecimal(line.volume),
        originCountry: str(line.countryOfOrigin), cartonItems: source.cartons.flatMap(carton => carton.items
          .filter((item: any) => item.shipmentLineId === line.id).map((item: any) => ({ ...item, cartonNo: carton.cartonNo }))) };
    });
    const sum = (rows: any[], field: string): string | null => !rows.length || rows.some(row => row[field] == null) ? null
      : rows.reduce((total, row) => total.plus(documentDecimal(row[field])!), new Prisma.Decimal(0)).toString();
    const currencies = [...new Set(source.orders.map(order => str(order.currency) ?? str(order.salesCurrency)))];
    const currency = currencies.length === 1 ? currencies[0] : null;
    const units = [...new Set(lines.map(line => line.unit))];
    if (units.length !== 1 || units[0] == null) missing.push('实际装运行单位不同或缺失，数量不做跨单位合计');
    const amount = currency ? sum(lines, 'amount') : null;
    if (!currency) missing.push('原订单币种不同或缺失，金额不做跨币种合计');
    const totals = { quantity: units.length === 1 && units[0] != null ? sum(lines, 'quantity') : null, amount,
      cartons: source.cartons.length ? source.cartons.length : lines.length && lines.every(line => line.cartons != null) ? lines.reduce((sum, line) => sum + line.cartons, 0) : null,
      grossWeight: source.cartons.length ? sum(source.cartons, 'grossWeight') : sum(lines, 'grossWeight'),
      netWeight: source.cartons.length ? sum(source.cartons, 'netWeight') : sum(lines, 'netWeight'),
      volume: source.cartons.length ? sum(source.cartons, 'volume') : sum(lines, 'volume'), currency };
    const terms = same('deliveryTerms');
    if (source.orders.length && !terms) missing.push('合票原订单贸易条款不同或缺失，不取第一单条款');
    const primary = source.orders.length === 1 ? source.orders[0] : null;
    const customer = relationToParty(customerRel, same('customer') ?? str(shipment.customerName), same('billToAddress'), same('billToContact'));
    const consignee = relationToParty(consigneeRel, same('consigneeName'), same('consigneeAddress'), same('consigneeContact')) ?? customer;
    const lcRow = lcRows.length === 1 ? lcRows[0] : null;
    if (lcRows.length > 1) missing.push('存在多个原信用证，不猜测适用本票的信用证');
    const data = {
      shipment: { ...shipment, totalPackages: source.cartons.length ? source.cartons.length : shipment.totalPackages ?? null,
        grossWeight: totals.grossWeight, netWeight: totals.netWeight, volume: totals.volume },
      order: primary ? { id: primary.id, poNumber: str(primary.poNumber), customer: primary.customer,
        currency, deliveryTerms: terms, paymentTerms: same('paymentTerms'), salesContractNumber: str(primary.salesContractNumber),
        finalContractNumber: str(primary.finalContractNumber), invoiceNumber: null, invoiceDate: null } : null,
      orders: source.orders.map(order => ({ id: order.id, orderNumber: str(order.orderNumber), poNumber: str(order.poNumber),
        currency: str(order.currency) ?? str(order.salesCurrency), deliveryTerms: str(order.deliveryTerms), paymentTerms: str(order.paymentTerms) })),
      customs: declaration ? { declarationNumber: declaration.declarationNumber, declarationDate: declaration.declarationDate,
        declarationPort: declaration.declarationPort, tradeTerms: declaration.tradeTerms, totalValue: documentDecimal(declaration.totalValue),
        currency: declaration.currency, originCountry: declaration.originCountry, destinationCountry: declaration.destinationCountry,
        consignee: declaration.consignee, consignor: declaration.consignor } : null,
      parties: { customer, consignee, carrier: relationToParty(carrierRel, str(shipment.carrierName)) }, lines, cartons: source.cartons, totals, missing,
      source: { schemaVersion: 1, fingerprint: source.fingerprint, orderIds: source.orderIds, kind: source.kind, cartonCoverageComplete: source.cartonCoverageComplete },
      extras: { originCriterion: 'P', insurance: { insuredAmount: terms && /CIF|CIP/.test(terms.toUpperCase()) && amount !== null
        ? new Prisma.Decimal(amount).mul('1.1').toDecimalPlaces(2).toString() : null, currency,
        coverage: 'COVERING ALL RISKS AND WAR RISKS AS PER C.I.C. (1/1/1981)', premium: documentDecimal(shipment.insuranceAmount),
        premiumCurrency: str(shipment.insuranceCurrency), insurer: null }, letterOfCredit: lcRow ? { lcNumber: lcRow.lcNumber, issueBank: str(lcRow.issueBank), issueDate: str(lcRow.issueDate), applicant: str(lcRow.applicant) } : null },
    };
    // Recheck current account/action ceiling and every actual L2 after all reads.
    await shipmentDocumentSourceInTx(tx, shipmentId, { ...options, expectedSourceFingerprint: source.fingerprint });
    return { ok: true, data: data as SourceDocumentSetData };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
