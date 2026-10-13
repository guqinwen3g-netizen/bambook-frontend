import { PricingDomainError, pricingInputError, pricingNotFoundError } from './pricingError';
/**
 * 阶段 P1 — 订单级利润表服务（PRD 6.2 P1 / 8.3 订单利润分析）
 *
 * 职责：
 *   generateOrderProfitSheet(orderId)：聚合订单全链路资金口径，归一化至 CNY：
 *     销售收入 = Σ 应收发票（type=Receivable，非 Cancelled）amount × 汇率
 *     采购承诺 = Σ 已确认采购单 totalAmount × 汇率（不是实际耗用）
 *     运费     = Σ 运单（非 Cancelled）freight+insurance+customs+otherCharges
 *     付款本金仅作资金展示；手续费单列。实际耗用证据不足时对外不提供利润。
 *   汇率口径：Invoice/PurchaseOrder/PaymentVoucher 自带 exchangeRate 快照优先；
 *     快照缺失且币种非本位币时回退 ExchangeRate 最新记录（details 行标记 rateSource）；
 *     无任何可用汇率的外币行不计入合计，列入 details.unconverted 透明披露。
 *
 * 幂等：orderId @unique 为真源，重生成=覆盖更新（version+1），不产生重复行。
 */

import { Prisma, PrismaClient, OrderProfitSheet } from '@prisma/client';
import { logger } from '../lib/logger';
import { isInternalTransferEffective } from '../internalTrade/internalTransferService';
import crypto from 'crypto';
import { CostEvidence, maskProfitSheet } from './costEvidence';
import { assertOrderCostPeerVisibility, readCurrentOrderCostReview, type OrderCostReviewFiles } from './orderCostReviewService';
import { loadOrderCostSources, reviewHash, reviewReject } from './orderCostReviewSource';
import { createPermissionService } from '../auth/permissionService';
import type { TokenPayload } from '../auth/service';

// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface ProfitLineItem {
  id: string;
  label: string; // 发票号 / 采购单号 / 运单号 / 凭证号
  amount: number; // 原币金额
  currency: string;
  rate: number; // 实际采用汇率
  rateSource: 'snapshot' | 'base' | 'latest-rate';
  cnyAmount: number; // 折算后金额
  /** DR-005：true = 内部交易行（内部面料采购/销售），合并报表须抵销，不计对外营收 */
  internal?: boolean;
}

export interface UnconvertedLine {
  id: string;
  label: string;
  kind: 'sales' | 'purchase' | 'freight' | 'misc' | 'bankFee' | 'allowance';
  amount: number;
  currency: string;
  reason: string;
}

/** DR-005 内部面料交易利润口径摘要（仅内部交易相关订单附加；schema 冻结期载体为 details JSON） */
export interface InternalTradeSummary {
  /** order.isInternalFabricTrade：内部面料订单独立归集，不进对外营收 */
  isInternalTrade: boolean;
  /** 服装部口径：内部面料采购成本（Σ 生效 incoming transferAmount，CNY） */
  internalPurchaseAmount: number;
  /** 面料部口径：内部面料销售收入（Σ 生效 outgoing transferAmount，CNY） */
  internalSalesAmount: number;
  /** 公司合并视图抵销额 = internalPurchaseAmount（内部采购价 = 内部销售收入） */
  consolidatedAdjustment: number;
  /** 部门利润 = grossProfit（部门视角，不含抵销；合并抵销仅在 reportService 公司视图执行） */
  departmentProfit: number | null;
}

export interface ProfitSheetDetails {
  costEvidence?: CostEvidence;
  sales: ProfitLineItem[];
  purchases: ProfitLineItem[];
  freight: ProfitLineItem[];
  misc: ProfitLineItem[];
  /** ★ M1·D7：银行手续费**单列**为一类成本（收款侧 + 付款侧本金之外的部分） */
  bankFees: ProfitLineItem[];
  /** 本位币合计，冗余存在 details 里便于前端直接取（真值仍是 bankFees 各行之和） */
  bankFeeCost: number;
  /** ★ M1·D7：索赔/折让（贷项票已抵扣额）**单列**为成本项，**不改销售收入口径** */
  allowances: ProfitLineItem[];
  allowanceCost: number;
  unconverted: UnconvertedLine[];
  internalTrade?: InternalTradeSummary;
  /** ★ D2-Q4：归一后的贸易术语（FOB/CIF/CFR/OTHER）——判据源 `Order.deliveryTerms` */
  incoterm?: 'FOB' | 'CIF' | 'CFR' | 'OTHER';
  /** ★ D2-Q4：CIF/CFR 下垫付运费**改开运费应收**，故不计入成本 */
  freightRebillable?: boolean;
  /** 该笔应改开应收的运费金额（CNY）；非 CIF/CFR 时为 0 */
  freightRebillableAmount?: number;
}

/**
 * ★ D2-Q4 判据纯函数：把自由文本的 `deliveryTerms` 归一成四档。
 * 只认 FOB / CIF / CFR（CFR 随 CIF，矩阵 :394）；其余（含空/无法归一）一律 OTHER
 * ⇒ 调用方对 OTHER 保持既有行为（运费计入成本），**绝不自造阈值**。
 * 归一：大小写不敏感 + 去空白 + 取首个字母串（"FOB Shanghai" → FOB、"CIF Montreal" → CIF）。
 */
export function normalizeIncoterm(raw: string | null | undefined): 'FOB' | 'CIF' | 'CFR' | 'OTHER' {
  const s = String(raw ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s) return 'OTHER';
  const head = s.split(' ')[0] ?? '';
  if (head === 'FOB') return 'FOB';
  if (head === 'CIF') return 'CIF';
  if (head === 'CFR' || head === 'CNF' || head === 'C&F') return 'CFR';
  return 'OTHER';
}

function generateId(prefix: string): string {
  return `${prefix}__${crypto.randomBytes(6).toString('base64url').toUpperCase()}`;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

export function createProfitSheetService(prisma: PrismaClient, options: { reviewEvidenceFiles?: OrderCostReviewFiles } = {}) {
  const db = prisma as any;
  const now = () => Date.now();

  /** 最新汇率表（currency → rate），每次生成加载一次 */
  async function loadLatestRateMap(): Promise<Map<string, number>> {
    const rows = await db.exchangeRate.findMany({
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
    const map = new Map<string, number>();
    for (const r of rows) {
      if (!map.has(r.currency)) map.set(r.currency, Number(r.rate));
    }
    return map;
  }

  /**
   * 单行归一化：返回 ProfitLineItem；无法折算返回 UnconvertedLine 语义对象（cnyAmount 无效）。
   * snapshotRate：单据自带汇率快照（currency → CNY）。
   */
  function normalizeLine(
    kind: UnconvertedLine['kind'],
    id: string,
    label: string,
    amount: number,
    currency: string,
    snapshotRate: number | null,
    latestRates: Map<string, number>,
  ): { line?: ProfitLineItem; unconverted?: UnconvertedLine } {
    if (currency === 'CNY') {
      return { line: { id, label, amount, currency, rate: 1, rateSource: 'base', cnyAmount: round4(amount) } };
    }
    if (snapshotRate !== null && Number.isFinite(snapshotRate) && snapshotRate > 0) {
      return { line: { id, label, amount, currency, rate: snapshotRate, rateSource: 'snapshot', cnyAmount: round4(amount * snapshotRate) } };
    }
    const latest = latestRates.get(currency);
    if (latest !== undefined && latest > 0) {
      return { line: { id, label, amount, currency, rate: latest, rateSource: 'latest-rate', cnyAmount: round4(amount * latest) } };
    }
    return { unconverted: { id, label, kind, amount, currency, reason: '无汇率快照且无最新汇率记录' } };
  }

  /**
   * 加载订单承担运费的运单及分摊比例（合票运费归集真源）。
   *
   * Shipment.orderId 只是首单投影（allocationService.syncShipmentOrderIdProjection），
   * 合票（一票多单）时不能按它全额归集运费——否则首单运费虚高、其余订单恒为 0。
   * 真源 = ShipmentOrderAllocation：
   *   - 有分配记录的票：运费按 actualQty（缺省回退 plannedQty）比例分摊到订单，
   *     票内各订单 share 之和 = 1；数量全缺省时按票内订单数均摊。
   *   - 无任何分配记录的存量票（分配机制上线前旧数据）：回退 Shipment.orderId
   *     直归（share=1）——仅当票内确无任何分配记录，防合票投影错挂。
   *   - 订单在票内的全部分配已取消：不承担运费（share=0，剔除）。
   */
  async function loadOrderFreightShipments(
    orderId: string,
  ): Promise<Array<{ shipment: any; share: number; mixedUnits: boolean }>> {
    const hasAllocTable = !!db.shipmentOrderAllocation;
    const myAllocs: any[] = hasAllocTable
      ? await db.shipmentOrderAllocation.findMany({
          where: { orderId, status: { not: 'Cancelled' } },
          select: { shipmentId: true, plannedQty: true, actualQty: true, unit: true },
        })
      : [];
    const allocShipmentIds = [...new Set(myAllocs.map((a: any) => a.shipmentId))];

    // 候选票：本订单有分配的票 ∪ orderId 直挂的票（存量兼容），两查合并去重
    const [allocShipments, directShipments] = await Promise.all([
      allocShipmentIds.length > 0
        ? db.shipment.findMany({
            where: { id: { in: allocShipmentIds }, status: { not: 'Cancelled' }, deletedAt: null },
          })
        : [],
      db.shipment.findMany({
        where: { orderId, status: { not: 'Cancelled' }, deletedAt: null },
      }),
    ]);
    const byId = new Map<string, any>();
    for (const sh of [...(allocShipments as any[]), ...(directShipments as any[])]) byId.set(sh.id, sh);

    // 票内全量分配（分摊比例分母）
    const allAllocsByShipment = new Map<string, any[]>();
    if (hasAllocTable && allocShipmentIds.length > 0) {
      const all = await db.shipmentOrderAllocation.findMany({
        where: { shipmentId: { in: allocShipmentIds }, status: { not: 'Cancelled' } },
        select: { shipmentId: true, orderId: true, plannedQty: true, actualQty: true, unit: true },
      });
      for (const a of all as any[]) {
        const list = allAllocsByShipment.get(a.shipmentId) ?? [];
        list.push(a);
        allAllocsByShipment.set(a.shipmentId, list);
      }
    }

    const qtyOf = (a: any) => Number(a.actualQty ?? a.plannedQty ?? 0) || 0;
    const unitOf = (a: any) => (a.unit == null ? '' : String(a.unit).trim().toLowerCase());
    const result: Array<{ shipment: any; share: number; mixedUnits: boolean }> = [];
    for (const sh of byId.values()) {
      if (allocShipmentIds.includes(sh.id)) {
        const all = allAllocsByShipment.get(sh.id) ?? [];
        const myQty = myAllocs
          .filter((a: any) => a.shipmentId === sh.id)
          .reduce((s, a) => s + qtyOf(a), 0);
        const totalQty = all.reduce((s, a) => s + qtyOf(a), 0);
        // ★ 2026-09-19（上线验收修）：**单位不可互算时不得按数量分摊**。
        //   原先只看数量 ⇒ 一票里既有「米」又有「公斤」（面料合票常见）时，
        //   `Σ数量` 是没有意义的分母，比例全错、运费归集到错的订单 ⇒ 订单利润错（且不报错）。
        //   与 `shared/orderLineShippedQty` 的既有口径一致：单位不同 → 不按数量算。
        //   缺省 unit 不视为「不同」（无法证伪），以保持既有行为不变。
        const units = new Set(all.map(unitOf).filter((u: string) => u.length > 0));
        const mixedUnits = units.size > 1;
        let share: number;
        if (totalQty > 0 && !mixedUnits) {
          share = myQty / totalQty;
        } else {
          // 数量全缺省 或 单位不可互算：按票内订单数均摊，保证 share 之和 = 1
          const distinctOrders = new Set(all.map((a: any) => a.orderId));
          share = distinctOrders.size > 0 ? 1 / distinctOrders.size : 1;
        }
        if (share > 0) result.push({ shipment: sh, share, mixedUnits });
      } else {
        // orderId 直挂票：仅当票内无任何分配记录（真存量旧数据）才全额直归
        const anyAlloc = hasAllocTable
          ? await db.shipmentOrderAllocation.findMany({
              where: { shipmentId: sh.id },
              select: { id: true },
              take: 1,
            })
          : [];
        if ((anyAlloc as any[]).length === 0) result.push({ shipment: sh, share: 1, mixedUnits: false });
      }
    }
    return result;
  }

  /**
   * 聚合订单利润口径（DR-054-①：生成与运费重估同一真源）。
   *
   * freightMultiplier 仅作用于计算层——运单四类费用金额 × multiplier 后再折 CNY
   * （模拟"如果运费涨 N 倍"），不改任何运单数据；生成落库传 1（真实口径）。
   */
  async function buildProfitOverview(orderId: string, freightMultiplier = 1, trustedActor?: TokenPayload) {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt !== null) throw pricingNotFoundError('订单不存在');

    const latestRates = await loadLatestRateMap();
    const details: ProfitSheetDetails = { sales: [], purchases: [], freight: [], misc: [], bankFees: [], bankFeeCost: 0, allowances: [], allowanceCost: 0, unconverted: [] };

    // ─── 销售收入：应收发票 ───
    // ★ 2026-09-30 真跑修复（口径级，不报错但算错）：
    //   真源 = InvoiceOrderAllocation。建票走 `orderAllocations` 分摊路径时 **Invoice.orderId 为空**
    //   （只写分配表）⇒ 原先只按 `Invoice.orderId` 查，这批票的收入**恒为 0**，利润表凭空少收入。
    //   与运费段同一范式：有分配记录 ⇒ 按 allocatedAmount 计入各单（一张票分摊多单时各单只计自己那份）；
    //   无任何分配记录的存量票 ⇒ 回退 Invoice.orderId 直挂（全额），保证旧数据行为不变。
    const salesAllocs: any[] = db.invoiceOrderAllocation
      ? await db.invoiceOrderAllocation.findMany({
          where: { orderId, deletedAt: null },
          select: { invoiceId: true, allocatedAmount: true },
        })
      : [];
    const salesAllocMap = new Map<string, number>();
    for (const a of salesAllocs) {
      salesAllocMap.set(a.invoiceId, Number(a.allocatedAmount ?? 0));
    }
    const salesDirect = await db.invoice.findMany({
      where: { orderId, type: 'Receivable', status: { not: 'Cancelled' }, deletedAt: null },
    });
    const salesByAlloc = salesAllocMap.size > 0
      ? await db.invoice.findMany({
          where: { id: { in: [...salesAllocMap.keys()] }, type: 'Receivable', status: { not: 'Cancelled' }, deletedAt: null },
        })
      : [];
    const salesSeen = new Set<string>();
    const salesInputs: Array<{ inv: any; amount: number }> = [];
    for (const inv of [...(salesByAlloc as any[]), ...(salesDirect as any[])]) {
      if (salesSeen.has(inv.id)) continue; // 两路命中同一张票 ⇒ 只算一次（分配优先）
      salesSeen.add(inv.id);
      salesInputs.push({ inv, amount: salesAllocMap.has(inv.id) ? (salesAllocMap.get(inv.id) as number) : Number(inv.amount) });
    }
    for (const { inv, amount } of salesInputs) {
      const r = normalizeLine('sales', inv.id, inv.invoiceNumber, amount, inv.currency,
        inv.exchangeRate === null ? null : Number(inv.exchangeRate), latestRates);
      if (r.line) details.sales.push(r.line);
      if (r.unconverted) details.unconverted.push(r.unconverted);
    }

    // ─── 采购成本：采购单 ───
    const purchaseOrders = await db.purchaseOrder.findMany({
      where: { orderId, status: { in: ['Confirmed','PartiallyReceived','Received','Closed'] }, deletedAt: null },
      include: { lines: true, receipts: true },
    });
    for (const po of purchaseOrders) {
      const r = normalizeLine('purchase', po.id, po.poNumber, Number(po.totalAmount), po.currency,
        po.exchangeRate === null ? null : Number(po.exchangeRate), latestRates);
      if (r.line) details.purchases.push(r.line);
      if (r.unconverted) details.unconverted.push(r.unconverted);
    }

    // ─── 运费：按 ShipmentOrderAllocation 分摊到订单（合票一票多单时各单
    //     按 actualQty 比例承担，不再按 Shipment.orderId 首单投影全额直归；
    //     运单无汇率快照字段，外币一律按最新汇率折算；
    //     REQ2-14 重估：金额 × freightMultiplier 模拟海运费变动，DR-054-①） ───
    const freightShipments = await loadOrderFreightShipments(orderId);
    for (const { shipment: sh, share, mixedUnits } of freightShipments) {
      const charges: Array<[number | null, string | null, string]> = [
        [sh.freightAmount === null ? null : Number(sh.freightAmount), sh.freightCurrency, '运费'],
        [sh.insuranceAmount === null ? null : Number(sh.insuranceAmount), sh.insuranceCurrency, '保险费'],
        [sh.customsAmount === null ? null : Number(sh.customsAmount), sh.customsCurrency, '报关费'],
        [sh.otherCharges === null ? null : Number(sh.otherCharges), sh.otherChargesCurrency, '其他费用'],
      ];
      for (const [rawAmount, currency, label] of charges) {
        if (rawAmount === null || rawAmount === 0) continue;
        const amount = rawAmount * freightMultiplier * share;
        const cur = currency ?? 'CNY';
        const shareNote = share < 1
          ? (mixedUnits
              // 单位不可互算 ⇒ 明说是均摊，别让用户以为这是按量算出来的比例
              ? `（合票分摊 ${(share * 100).toFixed(1)}% · 计量单位不一，按票内订单均摊）`
              : `（合票分摊 ${(share * 100).toFixed(1)}%）`)
          : '';
        const r = normalizeLine('freight', sh.id, `${sh.shipmentNumber} ${label}${shareNote}`, amount, cur, null, latestRates);
        if (r.line) details.freight.push(r.line);
        if (r.unconverted) details.unconverted.push(r.unconverted);
      }
    }

    // 付款本金只作支付阶段展示，不成为成本；手续费独立保留。
    let paidPrincipalCny: number | null = 0;
    const payments = await db.paymentVoucher.findMany({where:{orderId,type:'Disbursement',deletedAt:null}});
    for (const pv of payments) {
      const r = normalizeLine('misc',pv.id,pv.voucherNumber,Number(pv.amount),pv.currency,pv.exchangeRate == null ? null : Number(pv.exchangeRate),latestRates);
      if (!r.line) paidPrincipalCny=null;
      else if (paidPrincipalCny !== null) paidPrincipalCny += r.line.cnyAmount;
    }

    // ─── ★ M1·D7 银行手续费（单列成本项）：收款侧 + 付款侧 ───
    //  为什么原来收款侧是**隐形**的：本服务过去只读 `type:'Disbursement'` 的付款凭证，
    //  `Receipt`（收款水单）从未被利润表读过 ⇒ 收款被银行扣的手续费既不在收入里、也不在任何成本里。
    //  口径（§12 D7）：**销售收入不动**（仍按应收发票），手续费单独成一条成本项。
    //  归属判据：`orderId` 冗余命中 **或** 该凭证核销的发票属于本订单（orderId 没填时不能漏），
    //  两条同时命中只算一次（按 id 去重）⇒ profitSheet.test.ts 有重复计账守卫。
    //  付款手续费覆盖全部付款凭证，不因后来挂票而消失；本金始终不进成本。
    // ★ 与收入段同源：用「分配表 ∪ 直挂」去重后的票集合，而不是原来只按 orderId 查到的那一批
    const orderInvoiceIds: string[] = [...salesSeen];
    // 两次精确查询而不是 `OR`：① 真库走索引；② 测试替身对 `OR` 是**静默忽略**的
    //   （`matchWhere` 只认 `not`/`in`），写成 OR 会让 mock 返回全部收款凭证 ⇒ 假绿。
    const receiptByOrder: any[] = await db.paymentVoucher.findMany({
      where: { orderId, type: 'Receipt', deletedAt: null },
    });
    const receiptByInvoice: any[] = orderInvoiceIds.length === 0 ? [] : await db.paymentVoucher.findMany({
      where: { invoiceId: { in: orderInvoiceIds }, type: 'Receipt', deletedAt: null },
    });
    const seenFeeIds = new Set<string>();
    for (const pv of [...payments, ...receiptByOrder, ...receiptByInvoice]) {
      if (seenFeeIds.has(pv.id)) continue;   // 两条归属判据同时命中也只算一次
      seenFeeIds.add(pv.id);
      const fee = Number(pv.bankFee ?? 0);
      if (fee === 0) continue; // 没扣手续费 ⇒ 不造噪音行
      const r = normalizeLine('bankFee', pv.id,
        `${pv.voucherNumber}（${pv.type === 'Receipt' ? '收款' : '付款'}手续费）`,
        fee, pv.currency, pv.exchangeRate === null ? null : Number(pv.exchangeRate), latestRates);
      if (r.line) details.bankFees.push(r.line);
      // 外币无汇率 ⇒ 落 unconverted 披露，**不得静默按 0 计入**（G3「算不出来不给数」）
      if (r.unconverted) details.unconverted.push(r.unconverted);
    }

    // ─── ★ M1·D7 折让（贷项票已抵扣额）单列成本项 ───
    //  改前的不正确：销售收入按**票面额**全额计，贷项票只体现在"发票已核销额"里，
    //  利润表**一个字都没读它** ⇒ 客户拿走的每一块折让仍全额留在我们的毛利里 ⇒ **毛利被系统性高估**。
    //  口径（§12 D7）：收入口径**不动**，折让作为一条单独成本项入账。
    //  计哪些：① 抵扣到「本订单的应收发票」上的 `CreditNoteAllocation.appliedAmount`
    //          （走核销明细这张真源，与「发票已核销总额 = Σ收款 + Σ折让」同一口径）；
    //        ② 票面 1000 只抵了 800 ⇒ 只计 800（未核销余额挂账，不算已发生的成本）；
    //        ③ `Cancelled` 的贷项票一律不计 —— 与「Cancelled 发票不计收入」同一 fail-closed 取向。
    const orderInvoiceIdSet = new Set(orderInvoiceIds);
    const cnAllocs: any[] = orderInvoiceIds.length === 0 || !db.creditNoteAllocation
      ? []
      : await db.creditNoteAllocation.findMany({ where: { invoiceId: { in: orderInvoiceIds } } });
    const cnIds = [...new Set(cnAllocs.map((a: any) => a.creditNoteId))];
    const cnById = new Map<string, any>();
    if (cnIds.length > 0 && db.creditNote) {
      for (const c of await db.creditNote.findMany({ where: { id: { in: cnIds } } })) cnById.set(c.id, c);
    }
    for (const a of cnAllocs) {
      const cn = cnById.get(a.creditNoteId);
      if (!cn) continue;                                   // 明细在、票不在 ⇒ 不猜（G3）
      if (cn.deletedAt) continue;
      if (cn.status === 'Cancelled') continue;             // 作废单据不得成为成本
      if (!orderInvoiceIdSet.has(a.invoiceId)) continue;    // 双保险：只算本订单发票
      const applied = Number(a.appliedAmount);
      if (!Number.isFinite(applied) || applied === 0) continue;
      const r = normalizeLine('allowance', cn.id,
        `${cn.creditNoteNumber}（折让${cn.reason ? `：${cn.reason}` : ''}）`,
        applied, cn.currency, null, latestRates);
      if (r.line) details.allowances.push(r.line);
      if (r.unconverted) details.unconverted.push(r.unconverted);
    }

    // ─── DR-005 内部面料交易：部门利润口径（订单利润表生成.md §2.3.4） ───
    //   服装部（服装订单侧 incoming）：purchases 维度含内部面料采购价（生效内部供料单 transferAmount）
    //   面料部（内部面料订单侧 outgoing）：sales 维度含内部面料销售收入
    //   仅生效状态（Effective/Delivering/Closed，或历史已认账记录）计入核算；
    //   Draft/PendingConfirm/Cancelled 不计（未批准结算价不得生效，fail-closed）。
    //   兼容说明：mock/旧库无 orderInternalTransfer 表时按无内部交易处理（不影响既有四维聚合）。
    const transferRows: any[] = db.orderInternalTransfer
      ? await db.orderInternalTransfer.findMany({ where: { orderId, deletedAt: null } })
      : [];
    const effectiveTransfers = transferRows.filter((t) => isInternalTransferEffective(t));
    let internalPurchaseCny = 0;
    let internalSalesCny = 0;
    for (const t of effectiveTransfers) {
      const amount = Number(t.transferAmount);
      if (!Number.isFinite(amount) || amount === 0) continue;
      if (t.transferDirection === 'incoming') {
        const r = normalizeLine('purchase', t.id, `内部面料采购（内部供料单 ${t.id}）`, amount, t.transferCurrency ?? 'CNY', null, latestRates);
        if (r.line) { details.purchases.push({ ...r.line, internal: true }); internalPurchaseCny = round4(internalPurchaseCny + r.line.cnyAmount); }
        if (r.unconverted) details.unconverted.push(r.unconverted);
      } else if (t.transferDirection === 'outgoing') {
        const r = normalizeLine('sales', t.id, `内部面料销售（内部供料单 ${t.id}）`, amount, t.transferCurrency ?? 'CNY', null, latestRates);
        if (r.line) { details.sales.push({ ...r.line, internal: true }); internalSalesCny = round4(internalSalesCny + r.line.cnyAmount); }
        if (r.unconverted) details.unconverted.push(r.unconverted);
      }
    }

    const sum = (rows: ProfitLineItem[]) => round4(rows.reduce((acc, r) => acc + r.cnyAmount, 0));
    const salesRevenue = sum(details.sales);
    const purchaseCost = sum(details.purchases);
    const freightCost = sum(details.freight);
    const miscCost = sum(details.misc);
    const bankFeeCost = sum(details.bankFees);
    details.bankFeeCost = bankFeeCost;
    const allowanceCost = sum(details.allowances);
    details.allowanceCost = allowanceCost;
    // ── D2-Q4（2026-09-30 补齐，矩阵 :394 拍板）：CIF/CFR 下垫付运费·保险**不计成本**，改开运费应收 ──
    //   拍板原文：「CIF 下垫付运费/保险费不计成本，改开运费应收 → profitSheetService 必须按 Incoterms 分支」。
    //   为什么：CIF 的运费已经含在报给客户的价里 ⇒ 若再计一次成本，等于**同一笔钱扣两遍**，毛利被系统性低估。
    //   判据源 = `Order.deliveryTerms`（自由文本，如 "FOB Shanghai" / "CIF Montreal"）⇒ 归一后分支。
    //   ★ 只认 FOB / CIF / CFR 三档（CFR 随 CIF，矩阵口径）；其余（含空）按既有行为 = 运费计入成本，
    //     绝不自造阈值 ⇒ 现状 69 单全是 FOB Shanghai，**存量毛利零变化**。
    const incoterm = normalizeIncoterm(order?.deliveryTerms);
    const freightRebillable = incoterm === 'CIF' || incoterm === 'CFR';
    const freightInCost = freightRebillable ? 0 : freightCost;
    details.freightRebillable = freightRebillable;
    details.freightRebillableAmount = freightRebillable ? freightCost : 0;
    details.incoterm = incoterm;
    const grossProfit = round4(salesRevenue - purchaseCost - freightInCost - miscCost - bankFeeCost - allowanceCost);
    const grossMargin = salesRevenue > 0 ? round4((grossProfit / salesRevenue) * 100) : null;
    let acceptedAmountCny: number | null = 0;
    for (const po of purchaseOrders) {
      if (!Array.isArray(po.receipts) || !Array.isArray(po.lines)) { acceptedAmountCny=null; break; }
      for (const receipt of po.receipts.filter((r:any)=>!r.deletedAt)) {
        const audit = db.auditLog ? await db.auditLog.findFirst({where:{action:'create_material_receipt',targetType:'PurchaseOrder',targetId:po.id,detail:{path:['after','receiptId'],equals:receipt.id}},orderBy:{createdAt:'desc'}}) : null;
        const rows = audit?.detail?.after?.lineReceipts;
        if (!Array.isArray(rows)) { acceptedAmountCny=null; break; }
        const seen=new Set<string>(); let total=0; let amount=0; let valid=true;
        for (const row of rows) {
          const line=po.lines.find((l:any)=>l.id===row.lineId);
          const qty=Number(row.accepted);
          if (!line || seen.has(row.lineId) || row.materialCode!==line.materialCode || row.unit!==line.unit || !Number.isFinite(qty) || qty<0 || !Number.isFinite(Number(line.unitPrice))) {valid=false;break;}
          seen.add(row.lineId);total+=qty;amount+=qty*Number(line.unitPrice);
        }
        if (!valid || !Number.isFinite(Number(receipt.totalAccepted)) || Math.abs(total-Number(receipt.totalAccepted))>0.00001) {acceptedAmountCny=null;break;}
        const converted=normalizeLine('purchase',receipt.id,receipt.receiptNumber,amount,po.currency,po.exchangeRate==null?null:Number(po.exchangeRate),latestRates);
        if (!converted.line) {acceptedAmountCny=null;break;}
        if (acceptedAmountCny!==null) acceptedAmountCny+=converted.line.cnyAmount;
      }
      if (acceptedAmountCny===null) break;
    }
    const review = await readCurrentOrderCostReview(db, orderId, options.reviewEvidenceFiles, trustedActor);
    const pendingReasons = [...review.pendingReasons];
    const reviewComplete = review.status === 'complete';
    const sameRevenueRange = reviewComplete
      && reviewHash(review.scopeSnapshot.revenueInvoiceIds) === reviewHash(details.sales.filter(row => !row.internal).map(row => row.id))
      && reviewHash(review.scopeSnapshot.internalRevenueTransferIds ?? []) === reviewHash(details.sales.filter(row => row.internal).map(row => row.id))
      && new Prisma.Decimal(review.actualRevenueCny).eq(salesRevenue);
    if (reviewComplete && !sameRevenueRange) pendingReasons.push('ACTUAL_REVENUE_SCOPE_CHANGED');
    const actualComplete = reviewComplete && sameRevenueRange && pendingReasons.length === 0;
    details.costEvidence={version:2,calculatedAt:new Date().toISOString(),status:actualComplete?'complete':'pending',
      committedAmountCny:details.unconverted.some(r=>r.kind==='purchase')?null:purchaseCost,
      acceptedAmountCny:acceptedAmountCny===null?null:round4(acceptedAmountCny),
      paidPrincipalCny:paidPrincipalCny===null?null:round4(paidPrincipalCny),actualCostCny:actualComplete?review.actualCostCny:null,
      actualProfitCny:actualComplete?Number(new Prisma.Decimal(review.actualRevenueCny!).sub(review.actualCostCny!).toDecimalPlaces(4)):null,pendingReasons,
      ...('reviewId' in review ? { reviewId:review.reviewId,reviewRevision:review.reviewRevision,sourceFingerprint:review.sourceFingerprint,actualRevenueCny:null,actualBreakdown:null } : {}),
      ...(reviewComplete?{sourceFingerprint:review.sourceFingerprint,actualRevenueCny:actualComplete?review.actualRevenueCny:null,actualBreakdown:actualComplete?review.actualBreakdown:null}:{} )};


    // DR-005 摘要：仅内部交易相关订单附加（departmentProfit = 部门视角 grossProfit；
    // consolidatedAdjustment 供公司合并报表抵销使用，此处不做抵销扣减）
    if (order.isInternalFabricTrade === true || effectiveTransfers.length > 0) {
      details.internalTrade = {
        isInternalTrade: order.isInternalFabricTrade === true,
        internalPurchaseAmount: internalPurchaseCny,
        internalSalesAmount: internalSalesCny,
        consolidatedAdjustment: internalPurchaseCny,
        departmentProfit: null,
      };
    }

    return {
      order: { id: order.id, poNumber: order.poNumber, customer: order.customer, status: order.status },
      // ★ 2026-09-25 修：M1·D7 把"银行手续费 / 索赔折让"单列为成本项之后，这两个顶层字段
      //   一直没接上 ⇒ 落库是默认值 0，而 grossProfit 已经扣掉了它们 ⇒ 同一张表"分项之和 ≠ 毛利"。
      salesRevenue, purchaseCost, freightCost, miscCost, bankFeeCost, allowanceCost, grossProfit, grossMargin, details,
    };
  }

  /**
   * 生成/重生成订单利润表（幂等：orderId 唯一，覆盖更新 version+1）。
   */
  async function generateOrderProfitSheet(orderId: string, actorId: string, trustedActor?: TokenPayload) {
    if (!orderId?.trim()) throw pricingInputError('orderId 必填');
    // A shared internal price cannot be written into another team's sheet before
    // checking both current order scopes. Legacy external aggregation is unchanged.
    let currentActor = trustedActor;
    const internalRows = db.orderInternalTransfer ? await db.orderInternalTransfer.findMany({ where: { orderId, deletedAt: null } }) : [];
    if (internalRows.length) {
      if (trustedActor && trustedActor.userId !== actorId) reviewReject('FORBIDDEN', '利润表操作者与真实凭证不一致');
      const context = await createPermissionService({ prisma: db }).getUserPermissionContext(actorId);
      if (!context) reviewReject('FORBIDDEN', '当前账号权限不可核对');
      currentActor = { userId: actorId, roles: context.legacyRoleCodes, roleIds: context.roleIds, permissions: context.scopes, departmentIds: context.departmentIds, authorizationLoaded: true, ...(trustedActor?.permissionCeiling !== undefined ? { permissionCeiling: [...trustedActor.permissionCeiling] } : {}) };
      await assertOrderCostPeerVisibility(db, currentActor, await loadOrderCostSources(db, orderId));
    }
    const overview = await buildProfitOverview(orderId, 1, currentActor);
    const { salesRevenue, purchaseCost, freightCost, miscCost, bankFeeCost, allowanceCost, grossProfit, grossMargin, details } = overview;

    // ★ M1·D7-1c（收口）：OrderProfitSheet.bankFeeCost / allowanceCost 两列是 NOT NULL DEFAULT 0。
    //   此前**没有任何写入方** ⇒ 每次生成利润表后两列恒为 0，而真值只躺在 details JSON 里。
    //   「0」会被下游读成「已计算且手续费为 0」，属 Kevin 明令禁止的「0 ≠ 没取到」静默伪装。
    //   ⇒ 与 details 同源同值落库（同一函数内取，无漂移可能），使列成为可用的 SQL 聚合维度。
    //   真源仍是 details.bankFees / details.allowances 各行之和；这里只是它的持久化镜像。
    //   ★ 合并 s0 时口径统一：bankFeeCost / allowanceCost 由上面第 429 行的解构取得
    //     （buildProfitOverview 在 396-399 行把 sum(bankFees) 同时写进顶层与 details ⇒ 二者同源同值），
    //     故此处**不再重复声明**（否则 TS2451 同作用域重复声明）。

    const ts = now();
    const existing = await db.orderProfitSheet.findUnique({ where: { orderId } });
    let sheet: OrderProfitSheet;
    if (existing) {
      sheet = await db.orderProfitSheet.update({
        where: { orderId },
        data: {
          salesRevenue, purchaseCost, freightCost, miscCost, bankFeeCost, allowanceCost, grossProfit, grossMargin,
          details, version: existing.version + 1, generatedAt: BigInt(ts), updatedAt: BigInt(ts),
        },
      });
    } else {
      sheet = await db.orderProfitSheet.create({
        data: {
          id: generateId('OPS'), orderId,
          salesRevenue, purchaseCost, freightCost, miscCost, bankFeeCost, allowanceCost, grossProfit, grossMargin,
          details, version: 1, generatedAt: BigInt(ts), createdAt: BigInt(ts), updatedAt: BigInt(ts),
        },
      });
    }
    logger.info('[ProfitSheetService] sheet generated', {
      orderId, sheetId: sheet.id, version: sheet.version, grossProfit, actorId,
    });
    return maskProfitSheet(sheet);
  }

  async function getProfitSheetByOrder(orderId: string) {
    const row = await db.orderProfitSheet.findUnique({ where: { orderId } });
    return row ? { ...maskProfitSheet(row), orderId: row.orderId as string } : null;
  }

  async function listProfitSheets(query: { limit?: number; offset?: number; orderScope?: Record<string, unknown> }) {
    const take = Math.min(query.limit || 50, 200);
    const skip = query.offset || 0;
    // OrderProfitSheet stores a snapshot orderId, not a Prisma relation.
    // Resolve real visible Order rows first; never invent a relation filter.
    const where = query.orderScope === undefined ? {} : { orderId: { in:
      (await db.order.findMany({ where: { AND: [{ deletedAt: null }, query.orderScope] }, select: { id: true } }))
        .map((order: { id: string }) => order.id),
    } };
    const [items, total] = await Promise.all([
      db.orderProfitSheet.findMany({ where, orderBy: { generatedAt: 'desc' }, take, skip }),
      db.orderProfitSheet.count({ where }),
    ]);
    return { items: items.map((row: any) => ({ ...maskProfitSheet(row), orderId: row.orderId as string })), total };
  }

  async function deleteProfitSheet(orderId: string, actorId: string): Promise<void> {
    const existing = await db.orderProfitSheet.findUnique({ where: { orderId } });
    if (!existing) throw pricingNotFoundError('利润表不存在');
    // 硬删除：利润表是聚合投影，重生成即可恢复，无历史留痕义务
    await db.orderProfitSheet.delete({ where: { orderId } });
    logger.info('[ProfitSheetService] sheet deleted', { orderId, actorId });
  }

  /**
   * REQ2-14 海运费变动批量重估（DR-054-②：只读预览不落库；X-04 一屏可见锚点）。
   *
   * 受影响 = 非终态订单且存在活跃运单运费类费用（有运费基数才谈重估）；
   * baseline 优先取已落库利润表（用户认过的口径），无则现场 ×1 计算——同真源。
   */
  async function reestimateFreightImpact(params: { multiplier?: unknown; orderId?: unknown }) {
    const multiplier = Number(params.multiplier ?? 1);
    if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) {
      throw new PricingDomainError('INVALID_MULTIPLIER', 'multiplier 必须为 (0, 100] 区间数值（如 3 = 运费涨 3 倍）');
    }

    // 受影响订单：非终态 + 有活跃运单运费类费用
    const TERMINAL_ORDER_STATUS = ['Cancelled', 'Delivered', 'Completed'];
    const where: any = { deletedAt: null, status: { notIn: TERMINAL_ORDER_STATUS } };
    if (params.orderId != null && String(params.orderId).trim() !== '') where.id = String(params.orderId).trim();
    const orders = await db.order.findMany({
      where,
      select: { id: true, poNumber: true, customer: true, status: true },
    });

    const items: any[] = [];
    for (const order of orders) {
      // 运费基数：订单承担的活跃运单四类费用（>0 计数；合票票经分配分摊口径，
      // 次单不再因 Shipment.orderId 投影指向首单而被漏筛）
      const freightShipments = await loadOrderFreightShipments(order.id);
      const hasFreightBase = freightShipments.some(({ shipment: sh }) =>
        [sh.freightAmount, sh.insuranceAmount, sh.customsAmount, sh.otherCharges]
          .some(v => v != null && Number(v) > 0));
      if (!hasFreightBase) continue;

      // 两侧均按当前证据计算；旧持久化暂估数字不得成为实际利润基线。
      const baseline = await buildProfitOverview(order.id, 1);
      const reestimated = { freightCost: round4(baseline.freightCost * multiplier) };
      const base = { grossProfit:null, grossMargin:null, freightCost:baseline.freightCost, source:'computed' as const };
      const deltaProfit = null;
      const deltaMargin = null;
      const advice = 'pending' as const;

      items.push({
        orderId: order.id, poNumber: order.poNumber, customer: order.customer, status: order.status,
        baseline: { ...base },
        reestimated: {
          grossProfit: null, grossMargin: null,
          freightCost: reestimated.freightCost,
        },
        deltaProfit, deltaMargin, advice,
      });
    }

    // 转负优先，利润变化幅度降序
    const adviceRank: Record<string, number> = { renegotiate: 0, warn: 1, ok: 2, pending:3 };
    items.sort((a, b) => (adviceRank[a.advice] - adviceRank[b.advice]) || (a.deltaProfit - b.deltaProfit));

    const summary = {
      multiplier,
      affectedOrders: items.length,
      baselineProfitTotal: null,
      reestimatedProfitTotal: null,
      deltaProfitTotal: null,
      pendingOrders:items.length,
      negativeProfitOrders: null,
      renegotiateOrders: items.filter(x => x.advice === 'renegotiate').length,
      warnOrders: items.filter(x => x.advice === 'warn').length,
    };
    return { items, summary };
  }

  return {
    generateOrderProfitSheet,
    getProfitSheetByOrder,
    listProfitSheets,
    deleteProfitSheet,
    reestimateFreightImpact,
  };
}

export type ProfitSheetService = ReturnType<typeof createProfitSheetService>;
