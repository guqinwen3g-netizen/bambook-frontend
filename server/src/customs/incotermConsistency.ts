/**
 * incotermConsistency.ts — D2 报关成交方式 ↔ 订单 Incoterms 一致性核对
 *
 * 现状核准（docs/D2-报关成交方式与Incoterms校验-现状核准-2026-09-16.md）：
 *   两侧字段名都不同（订单 `Order.deliveryTerms` / 报关单 `CustomsDeclaration.tradeTerms`），
 *   全仓零比较，且**两处静默取其一**：
 *     - shipping/documentSetService.ts:361（还用它驱动「卖方是否投保」→ 会产出错误的保险单要求）
 *     - templates/docTemplates/customsDocs.ts:104
 *   ⇒ 订单 CIF / 报关 FOB 时，系统静默用 CIF 出全套单据，而报关单印着 FOB，两套单据互相矛盾。
 *
 * 口径（业务方 2026-09-16 授权按行业专业判断，详见 §判断）：
 *   1. **订单条款为准**：订单/合同的 Incoterms 是与客户谈定的**商业合同依据**；报关单的成交方式是
 *      **向海关申报**的数据，申报必须与合同一致 —— 不一致说明**报关申报有问题，该纠正的是报关单**
 *      （申报不实有法律风险），而不是反过来改商业单据。
 *   2. **逐字归一化比对**（`CFR` ≠ `CIF`，二者保险责任确实不同），但按矩阵 D2 拍板
 *      「只升 FOB + CIF 为枚举、CFR 随 CIF」给出**分组**，用于区分差异严重程度：
 *      跨组不一致 > 同组细分差异。
 *   3. **只预警不阻断**（沿用 T7 系列统一口径；分批报关时成交方式可能合理不同，阻断会卡死业务）。
 *
 * 纯只读：不写库、不触发重算。
 */
import { PrismaClient } from '@prisma/client';
import { extractIncotermCode, normIncoterm as normTerms } from '../_shared/incoterm';

export type IncotermGroup = 'FOB' | 'CIF' | 'OTHER';

export interface IncotermDiscrepancy {
  type: 'incoterm_mismatch' | 'incoterm_missing';
  field: string;
  /** 期望：订单条款（商业合同依据） */
  expected: string;
  /** 实际：报关成交方式（申报数据） */
  actual: string;
  /** 只预警不阻断 */
  severity: 'warning';
  message: string;
}

export interface IncotermConsistencyResult {
  declarationId: string;
  declarationNumber: string;
  orderId: string | null;
  orderCode: string | null;
  /** 订单条款（商业合同依据，出单据的真源） */
  orderTerms: string | null;
  orderGroup: IncotermGroup | null;
  /** 报关成交方式（申报数据） */
  declarationTerms: string | null;
  declarationGroup: IncotermGroup | null;
  /** 归一化后逐字相等 */
  consistent: boolean;
  /** 同组但不同字（如 CFR vs CIF）—— 差异较轻，提示确认 */
  sameGroup: boolean;
  discrepancies: IncotermDiscrepancy[];
}

/**
 * 按矩阵 D2 拍板分组：「只升 FOB + CIF 为枚举（CFR 随 CIF）」。
 * - FOB 组：FOB / FCA / EXW —— 买方负责主运费（离岸/出厂）
 * - CIF 组：CIF / CIP / CFR / CPT —— 卖方负责主运费（CFR 随 CIF）
 * - OTHER：D 组（DDP/DAP/DPU）等
 */
const FOB_GROUP = new Set(['FOB', 'FCA', 'EXW']);
const CIF_GROUP = new Set(['CIF', 'CIP', 'CFR', 'CPT']);

export function incotermGroup(terms: string | null | undefined): IncotermGroup | null {
  const t = extractIncotermCode(terms);
  if (!t) return null;
  if (FOB_GROUP.has(t)) return 'FOB';
  if (CIF_GROUP.has(t)) return 'CIF';
  return 'OTHER';
}

/**
 * 核对某报关单的成交方式与订单条款是否一致。报关单不存在/已软删 → null（路由层转 404）。
 */
export async function checkIncotermConsistency(
  prisma: PrismaClient,
  declarationId: string,
): Promise<IncotermConsistencyResult | null> {
  const db = prisma as any;

  const decl = await db.customsDeclaration.findFirst({
    where: { id: declarationId, deletedAt: null },
    select: { id: true, declarationNumber: true, orderId: true, shipmentId: true, tradeTerms: true },
  });
  if (!decl) return null;

  // 订单锚：优先报关单直挂 orderId；否则经运单回退（报关单可能只挂 shipmentId）
  let orderId: string | null = decl.orderId ?? null;
  if (!orderId && decl.shipmentId) {
    const ship = await db.shipment.findUnique({ where: { id: decl.shipmentId }, select: { orderId: true } });
    orderId = ship?.orderId ?? null;
  }
  const order = orderId
    ? await db.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true, code: true, deliveryTerms: true } })
    : null;

  const orderTermsRaw = order?.deliveryTerms ?? null;
  const declarationTermsRaw = decl.tradeTerms ?? null;
  // 比对用**成交方式代码**（去掉港口/地点）；raw 仅用于提示文案（让人看到原始写法）
  const nOrder = extractIncotermCode(orderTermsRaw);
  const nDecl = extractIncotermCode(declarationTermsRaw);
  const orderGroup = incotermGroup(orderTermsRaw);
  const declGroup = incotermGroup(declarationTermsRaw);
  const rawNote = (raw: string | null, code: string) => {
    const r = normTerms(raw);
    return r && r !== code ? `（订单原文「${r}」，已按成交方式代码 ${code} 比对）` : '';
  };

  const discrepancies: IncotermDiscrepancy[] = [];
  const consistent = !!nOrder && !!nDecl && nOrder === nDecl;
  const sameGroup = !consistent && !!orderGroup && orderGroup === declGroup;

  if (!nOrder && nDecl) {
    discrepancies.push({
      type: 'incoterm_missing', field: 'orderTerms',
      expected: '(订单未登记交货条款)', actual: nDecl, severity: 'warning',
      message: `订单未登记交货条款（Order.deliveryTerms 为空），无法与报关成交方式 ${nDecl} 核对`,
    });
  } else if (nOrder && !nDecl) {
    discrepancies.push({
      type: 'incoterm_missing', field: 'declarationTerms',
      expected: nOrder, actual: '(报关未填成交方式)', severity: 'warning',
      message: `报关单未填成交方式，无法与订单条款 ${nOrder} 核对`,
    });
  } else if (nOrder && nDecl && !consistent) {
    // 跨组 vs 同组细分：严重程度不同，提示语分开（口径 2）
    const crossGroup = orderGroup !== declGroup;
    const hint = crossGroup
      ? `（**跨组**差异：${orderGroup ?? '?'} 组 vs ${declGroup ?? '?'} 组，运费/保险责任划分完全不同，请优先核实）`
      : `（同组细分差异：${orderGroup} 组内部，如 CFR 与 CIF 的差别在**是否含保险**，请确认保险是否已覆盖）`;
    discrepancies.push({
      type: 'incoterm_mismatch', field: 'tradeTerms',
      expected: nOrder, actual: nDecl, severity: 'warning',
      message: `订单条款 ${nOrder} 与报关成交方式 ${nDecl} 不一致${hint}${rawNote(orderTermsRaw, nOrder)}。`
        + `**以订单条款为准出商业单据**；报关成交方式应向海关更正（申报须与合同一致）`,
    });
  }

  return {
    declarationId: decl.id,
    declarationNumber: decl.declarationNumber,
    orderId: order?.id ?? null,
    orderCode: order?.code ?? null,
    orderTerms: nOrder || null,
    orderGroup,
    declarationTerms: nDecl || null,
    declarationGroup: declGroup,
    consistent,
    sameGroup,
    discrepancies,
  };
}
