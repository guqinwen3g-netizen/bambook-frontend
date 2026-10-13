/**
 * 资料完备度规则引擎 v1 — 规则注册表（rules.ts）
 *
 * 定位：系统主动识别资料缺口。七条规则全部为纯实时只读查询（不落表、不写库），
 * 新增规则只需在 COMPLETENESS_RULES 数组追加条目，summary 聚合自动收编。
 *
 * 口径说明：
 *   - 「客户」识别走系统约定 category='Customer'（Relation.type 在库内为
 *     'Organization'/'Contact' 轨道，见 relations/relationServiceV2.ts 的分类约定）
 *   - 「未命中 ProductAsset」= materialCode 不在未删 ProductAsset.sku 集合中
 *   - 「已出运」= 离港后状态（Shipped/Arrived/Cleared/Delivered），Delivered 为其真子集
 *   - 采购行引用统一以「未删 PurchaseOrder 下的 PurchaseLine.materialCode」为准
 */
import { PrismaClient } from '@prisma/client';

export type CompletenessSeverity = 'P0' | 'P1' | 'P2';

/** 共享索引：规则间复用的全量小表查询，一次加载供全部规则消费（数据量小，纯内存 Set/Map） */
export interface CompletenessSharedIndex {
  /** 未删产品档案 sku 集合（订单行/采购行「未建档」判定的反面集合） */
  productSkus: Set<string>;
  /** 产品档案 id → sku（辅料引用判定用） */
  skuByAssetId: Map<string, string>;
  /** 未删采购行的 materialCode 集合（辅料「无采购引用」判定的正面集合） */
  purchaseMaterialCodes: Set<string>;
  /** 有 CreditLimit 行（未删）的 relationId 集合 */
  creditLimitRelationIds: Set<string>;
  /** 有关联 TradeDocument（未删）的 shipmentId 集合 */
  shipmentIdsWithTradeDoc: Set<string>;
}

export async function loadCompletenessSharedIndex(prisma: PrismaClient): Promise<CompletenessSharedIndex> {
  const [assets, purchaseLines, creditLimits, tradeDocs] = await Promise.all([
    prisma.productAsset.findMany({ where: { deletedAt: null }, select: { id: true, sku: true } }),
    prisma.purchaseLine.findMany({
      where: { purchaseOrder: { deletedAt: null } },
      select: { materialCode: true },
    }),
    prisma.creditLimit.findMany({ where: { deletedAt: null }, select: { relationId: true } }),
    prisma.tradeDocument.findMany({
      where: { deletedAt: null, shipmentId: { not: null } },
      select: { shipmentId: true },
    }),
  ]);
  return {
    productSkus: new Set(assets.map(a => a.sku)),
    skuByAssetId: new Map(assets.map(a => [a.id, a.sku])),
    purchaseMaterialCodes: new Set(purchaseLines.map(l => l.materialCode).filter(Boolean) as string[]),
    creditLimitRelationIds: new Set(creditLimits.map(c => c.relationId)),
    shipmentIdsWithTradeDoc: new Set(tradeDocs.map(t => t.shipmentId as string)),
  };
}

/** 已实际出运（离港后）的运单状态集合 */
export const SHIPPED_STATUSES = ['Shipped', 'Arrived', 'Cleared', 'Delivered'];

export interface CompletenessRule {
  ruleId: string;
  label: string;
  severity: CompletenessSeverity;
  /** 缺口归属的实体类型（summary group 展示用） */
  entityType: string;
  /**
   * 返回命中缺口的主键 id 列表：count = 列表长度，summary sampleIds 取前 5。
   * 行级规则（订单行）返回行 id；单据级规则（PO 计数）返回去重后的单据 id。
   */
  collect(prisma: PrismaClient, index: CompletenessSharedIndex): Promise<string[]>;
}

export const COMPLETENESS_RULES: CompletenessRule[] = [
  {
    ruleId: 'order_line_material_unlinked',
    label: '订单行面料未建档',
    severity: 'P0',
    entityType: 'order',
    async collect(prisma, index) {
      const lines = await prisma.orderLine.findMany({
        where: { order: { deletedAt: null } },
        select: { id: true, materialCode: true },
      });
      return lines
        .filter(l => l.materialCode && !index.productSkus.has(l.materialCode))
        .map(l => l.id);
    },
  },
  {
    ruleId: 'dev_case_unlinked_product',
    label: '开发案未关联产品档案',
    severity: 'P0',
    entityType: 'development-case',
    async collect(prisma) {
      const cases = await prisma.developmentCase.findMany({
        where: { deletedAt: null },
        select: { id: true, productAssetId: true },
      });
      return cases.filter(c => !c.productAssetId).map(c => c.id);
    },
  },
  {
    ruleId: 'order_no_customer_relation',
    label: '订单未关联客户',
    severity: 'P1',
    entityType: 'order',
    async collect(prisma) {
      const orders = await prisma.order.findMany({
        where: { deletedAt: null },
        select: { id: true, customerRelationId: true },
      });
      return orders.filter(o => !o.customerRelationId).map(o => o.id);
    },
  },
  {
    ruleId: 'customer_no_credit_limit',
    label: '客户未设信用额度',
    severity: 'P1',
    entityType: 'relation',
    async collect(prisma, index) {
      const relations = await prisma.relation.findMany({
        where: { deletedAt: null, category: 'Customer' },
        select: { id: true },
      });
      return relations.filter(r => !index.creditLimitRelationIds.has(r.id)).map(r => r.id);
    },
  },
  {
    ruleId: 'po_material_unlinked',
    label: '采购行物料未建档',
    severity: 'P1',
    // 汇总归 PO 计数：一个 PO 只要存在任一未建档物料行即命中一次
    entityType: 'purchase-order',
    async collect(prisma, index) {
      const lines = await prisma.purchaseLine.findMany({
        where: { purchaseOrder: { deletedAt: null } },
        select: { id: true, materialCode: true, purchaseOrderId: true },
      });
      const poIds = new Set(
        lines
          .filter(l => l.materialCode && !index.productSkus.has(l.materialCode))
          .map(l => l.purchaseOrderId),
      );
      return Array.from(poIds);
    },
  },
  {
    ruleId: 'shipped_no_tradedoc',
    label: '已出运无报关单据',
    severity: 'P2',
    entityType: 'shipment',
    async collect(prisma, index) {
      const shipments = await prisma.shipment.findMany({
        where: { deletedAt: null, status: { in: SHIPPED_STATUSES } },
        select: { id: true },
      });
      return shipments.filter(s => !index.shipmentIdsWithTradeDoc.has(s.id)).map(s => s.id);
    },
  },
  {
    ruleId: 'trim_no_reference',
    label: '辅料档案无采购引用',
    severity: 'P2',
    entityType: 'product',
    async collect(prisma, index) {
      const trims = await prisma.trimmingProfile.findMany({
        where: { deletedAt: null },
        select: { id: true, productAssetId: true },
      });
      return trims
        .filter(t => {
          const sku = index.skuByAssetId.get(t.productAssetId);
          return sku ? !index.purchaseMaterialCodes.has(sku) : false;
        })
        .map(t => t.productAssetId);
    },
  },
];
