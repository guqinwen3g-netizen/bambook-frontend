/**
 * A5 报表引擎 — 数据集注册表（服务端白名单）
 *
 * 设计决策：
 *   - 报表定义（ReportDefinition）只存 datasetKey + 字段名，执行时由引擎
 *     在本注册表上校验（fail closed）——客户端无法注入任意 Prisma 查询。
 *   - 每个数据集声明：prismaModel（delegate 名）、dimensions（可分组字段）、
 *     metrics（可聚合数值字段）、filterFields（可过滤字段，含操作符白名单）。
 *   - 日期字段为 String YYYY-MM-DD（业务日历日），gte/lte 按字典序比较即正确。
 *   - 软删过滤 deletedAt: null 由引擎统一注入，不在各数据集重复声明。
 *
 * 新增数据集 = 在本文件追加一个 entry，无需改引擎。
 */

export type ReportFieldType = 'string' | 'number' | 'date' | 'enum';

export interface ReportFieldSpec {
  key: string;
  label: string;
  type: ReportFieldType;
  /** enum 类型的可选值（用于 UI 下拉 + contains 禁用） */
  enumValues?: readonly string[];
}

export interface DatasetSpec {
  key: string;
  label: string;
  /** Prisma delegate 名（prisma.<model>），如 'invoice' */
  prismaModel: string;
  description?: string;
  dimensions: readonly ReportFieldSpec[];
  metrics: readonly ReportFieldSpec[];
  filterFields: readonly ReportFieldSpec[];
  /**
   * A5d 下钻契约：
   *   - entityType：EntityLink 图谱类型码（与 entities/sync.ts 的 ownerType/fromType 一致），
   *     前端据此渲染关联图谱并导航到所属模块。
   *   - idField：实体主键字段（默认 'id'），drill 查询 select/orderBy 使用。
   *   - detailFields：下钻明细行展示的字段（须为模型上真实存在的标量字段）。
   */
  entityType: string;
  idField: string;
  detailFields: readonly ReportFieldSpec[];
}

// ────────────────────────────────────────────────────────────────
// 字段简写构造器
// ────────────────────────────────────────────────────────────────
const s = (key: string, label: string): ReportFieldSpec => ({ key, label, type: 'string' });
const n = (key: string, label: string): ReportFieldSpec => ({ key, label, type: 'number' });
const d = (key: string, label: string): ReportFieldSpec => ({ key, label, type: 'date' });
const e = (key: string, label: string, enumValues: readonly string[]): ReportFieldSpec => ({
  key,
  label,
  type: 'enum',
  enumValues,
});

// ────────────────────────────────────────────────────────────────
// 注册表
// ────────────────────────────────────────────────────────────────
export const REPORT_DATASETS: readonly DatasetSpec[] = [
  {
    key: 'orders',
    label: '订单',
    prismaModel: 'order',
    description: '生产订单（面料/成衣）',
    entityType: 'order',
    idField: 'id',
    detailFields: [
      s('poNumber', 'PO 号'),
      s('customer', '客户'),
      e('type', '订单类型', ['Fabric', 'Garment'] as const),
      s('status', '状态'),
      s('season', '季节'),
      n('quantity', '数量'),
      d('dueDate', '交期'),
    ],
    dimensions: [
      e('type', '订单类型', ['Fabric', 'Garment'] as const),
      s('status', '状态'),
      s('customer', '客户'),
      s('season', '季节'),
      s('currency', '币种'),
      s('salesPerson', '业务员'),
    ],
    metrics: [
      n('quantity', '数量'),
      n('quoteAmount', '报价金额'),
      n('totalNet', '净额合计'),
      n('totalActual', '实际合计'),
    ],
    filterFields: [
      e('type', '订单类型', ['Fabric', 'Garment'] as const),
      s('status', '状态'),
      s('customer', '客户'),
      s('season', '季节'),
      s('currency', '币种'),
      s('salesPerson', '业务员'),
      d('dueDate', '交期'),
      d('poDate', 'PO 日期'),
    ],
  },
  {
    key: 'invoices',
    label: '发票',
    prismaModel: 'invoice',
    description: '应收/应付业务发票',
    entityType: 'invoice',
    idField: 'id',
    detailFields: [
      s('invoiceNumber', '发票号'),
      e('type', '发票类型', ['Receivable', 'Payable'] as const),
      e('status', '状态', ['Draft', 'Issued', 'PartiallyPaid', 'Paid', 'Cancelled'] as const),
      s('customerName', '结算对象'),
      n('amount', '发票金额'),
      s('currency', '币种'),
      d('issueDate', '开票日期'),
      d('dueDate', '到期日'),
    ],
    dimensions: [
      e('type', '发票类型', ['Receivable', 'Payable'] as const),
      e('status', '状态', ['Draft', 'Issued', 'PartiallyPaid', 'Paid', 'Cancelled'] as const),
      s('currency', '币种'),
      s('customerName', '结算对象'),
    ],
    metrics: [n('amount', '发票金额')],
    filterFields: [
      e('type', '发票类型', ['Receivable', 'Payable'] as const),
      e('status', '状态', ['Draft', 'Issued', 'PartiallyPaid', 'Paid', 'Cancelled'] as const),
      s('currency', '币种'),
      s('customerName', '结算对象'),
      d('issueDate', '开票日期'),
      d('dueDate', '到期日'),
      d('settlementDate', '结算日期'),
    ],
  },
  {
    key: 'paymentVouchers',
    label: '收付凭证',
    prismaModel: 'paymentVoucher',
    description: '收款/付款水单',
    entityType: 'paymentVoucher',
    idField: 'id',
    detailFields: [
      s('voucherNumber', '凭证号'),
      e('type', '凭证类型', ['Receipt', 'Disbursement'] as const),
      e('status', '核销状态', ['unreconciled', 'partially_reconciled', 'reconciled'] as const),
      s('customerName', '交易对象'),
      n('amount', '凭证金额'),
      s('currency', '币种'),
      d('paymentDate', '收付日期'),
    ],
    dimensions: [
      e('type', '凭证类型', ['Receipt', 'Disbursement'] as const),
      e('status', '核销状态', ['unreconciled', 'partially_reconciled', 'reconciled'] as const),
      s('currency', '币种'),
      s('paymentMethod', '收付方式'),
      s('customerName', '交易对象'),
    ],
    metrics: [
      n('amount', '凭证金额'),
      n('bankFee', '银行手续费'),
      n('appliedAmount', '已核销金额'),
    ],
    filterFields: [
      e('type', '凭证类型', ['Receipt', 'Disbursement'] as const),
      e('status', '核销状态', ['unreconciled', 'partially_reconciled', 'reconciled'] as const),
      s('currency', '币种'),
      s('paymentMethod', '收付方式'),
      s('customerName', '交易对象'),
      d('paymentDate', '收付日期'),
    ],
  },
  {
    key: 'shipments',
    label: '运单',
    prismaModel: 'shipment',
    description: '出口/进口/内贸运单',
    entityType: 'shipment',
    idField: 'id',
    detailFields: [
      s('shipmentNumber', '运单号'),
      e('type', '运单类型', ['Export', 'Import', 'Domestic'] as const),
      s('status', '状态'),
      e('shippingMethod', '运输方式', ['Sea', 'Air', 'Land', 'Rail', 'Courier'] as const),
      s('customerName', '客户'),
      d('etd', '预计离港'),
      s('portOfLoading', '装货港'),
      s('portOfDischarge', '卸货港'),
    ],
    dimensions: [
      e('type', '运单类型', ['Export', 'Import', 'Domestic'] as const),
      s('status', '状态'),
      e('shippingMethod', '运输方式', ['Sea', 'Air', 'Land', 'Rail', 'Courier'] as const),
      s('portOfLoading', '装货港'),
      s('portOfDischarge', '卸货港'),
      s('customerName', '客户'),
      s('carrierName', '承运方'),
    ],
    metrics: [
      n('totalPackages', '总件数'),
      n('grossWeight', '毛重(kg)'),
      n('volume', '体积(CBM)'),
      n('freightAmount', '运费'),
      n('insuranceAmount', '保险费'),
    ],
    filterFields: [
      e('type', '运单类型', ['Export', 'Import', 'Domestic'] as const),
      s('status', '状态'),
      e('shippingMethod', '运输方式', ['Sea', 'Air', 'Land', 'Rail', 'Courier'] as const),
      s('customerName', '客户'),
      s('carrierName', '承运方'),
      d('etd', '预计离港'),
      d('atd', '实际离港'),
      d('eta', '预计到港'),
      d('ata', '实际到港'),
    ],
  },
  {
    key: 'vatInvoices',
    label: '增值税发票',
    prismaModel: 'vatInvoice',
    description: '进项/销项 VAT 发票',
    entityType: 'vatInvoice',
    idField: 'id',
    detailFields: [
      s('vatNumber', '发票号码'),
      e('direction', '方向', ['Input', 'Output'] as const),
      e('invoiceType', '票种', ['Special', 'Normal'] as const),
      e('status', '状态', ['Received', 'Verified', 'Declared', 'RedFlushed', 'Cancelled'] as const),
      s('sellerName', '销售方'),
      s('buyerName', '购买方'),
      n('totalAmount', '价税合计'),
      d('issueDate', '开票日期'),
    ],
    dimensions: [
      e('direction', '方向', ['Input', 'Output'] as const),
      e('invoiceType', '票种', ['Special', 'Normal'] as const),
      e('status', '状态', ['Received', 'Verified', 'Declared', 'RedFlushed', 'Cancelled'] as const),
      s('sellerName', '销售方'),
      s('buyerName', '购买方'),
      s('deductionPeriod', '勾选所属期'),
    ],
    metrics: [
      n('netAmount', '不含税金额'),
      n('taxAmount', '税额'),
      n('totalAmount', '价税合计'),
    ],
    filterFields: [
      e('direction', '方向', ['Input', 'Output'] as const),
      e('invoiceType', '票种', ['Special', 'Normal'] as const),
      e('status', '状态', ['Received', 'Verified', 'Declared', 'RedFlushed', 'Cancelled'] as const),
      s('sellerName', '销售方'),
      s('buyerName', '购买方'),
      s('deductionPeriod', '勾选所属期'),
      d('issueDate', '开票日期'),
      d('verifiedDate', '认证日期'),
    ],
  },
  {
    key: 'outwardRemittances',
    label: '付汇水单',
    prismaModel: 'outwardRemittance',
    description: '购付汇水单（付款侧外汇闭环）',
    entityType: 'outwardRemittance',
    idField: 'id',
    detailFields: [
      s('remittanceNumber', '水单号'),
      s('currency', '币种'),
      n('foreignAmount', '外币金额'),
      n('cnyAmount', '折人民币'),
      s('payeeName', '收款人'),
      s('bank', '付汇银行'),
      e('purpose', '付汇用途', ['GoodsPayment', 'Freight', 'Insurance', 'Commission', 'Other'] as const),
      d('remitDate', '付汇日期'),
    ],
    dimensions: [
      s('currency', '币种'),
      s('bank', '付汇银行'),
      e('purpose', '付汇用途', ['GoodsPayment', 'Freight', 'Insurance', 'Commission', 'Other'] as const),
      s('payeeName', '收款人'),
    ],
    metrics: [
      n('foreignAmount', '外币金额'),
      n('cnyAmount', '折人民币'),
    ],
    filterFields: [
      s('currency', '币种'),
      s('bank', '付汇银行'),
      e('purpose', '付汇用途', ['GoodsPayment', 'Freight', 'Insurance', 'Commission', 'Other'] as const),
      s('payeeName', '收款人'),
      d('remitDate', '付汇日期'),
    ],
  },
  {
    key: 'taxRefunds',
    label: '退税申报',
    prismaModel: 'taxRefund',
    description: '出口退税申报单',
    entityType: 'taxRefund',
    idField: 'id',
    detailFields: [
      s('refundNumber', '申报编号'),
      e('status', '状态', ['Draft', 'Submitted', 'Reviewing', 'Approved', 'Rejected', 'Refunded', 'Cancelled'] as const),
      n('exportAmountFob', '出口FOB金额'),
      s('exportAmountFobCurrency', '出口币种'),
      n('refundAmount', '实际退税额'),
      d('exportDate', '出口日期'),
      d('refundDate', '退税到账日期'),
    ],
    dimensions: [
      e('status', '状态', ['Draft', 'Submitted', 'Reviewing', 'Approved', 'Rejected', 'Refunded', 'Cancelled'] as const),
      s('exportAmountFobCurrency', '出口币种'),
    ],
    metrics: [
      n('exportAmountFob', '出口FOB金额'),
      n('exportAmountCny', '折人民币'),
      n('refundableVat', '可退增值税'),
      n('refundAmount', '实际退税额'),
    ],
    filterFields: [
      e('status', '状态', ['Draft', 'Submitted', 'Reviewing', 'Approved', 'Rejected', 'Refunded', 'Cancelled'] as const),
      d('exportDate', '出口日期'),
      d('declarationDate', '申报日期'),
      d('refundDate', '退税到账日期'),
    ],
  },
  {
    key: 'inventoryItems',
    label: '库存项',
    prismaModel: 'inventoryItem',
    description:
      '库存项（按货权/仓库/单位/品类汇总）。三条口径务必遵守：'
      + '① **数量跨单位不可相加**（YD/M/KG/PC/SET）—— 请把「单位」放进维度；'
      + '② **存货按货权（ownership）而非物理位置**：Transferred（货权已转移）不得计入我方存货；'
      + '③ **单位成本是金额**，跨币种不可相加 —— 请把「币种」放进维度。'
      + '仓库维度给出的是 Warehouse.id（如 SIM-WH-MAIN），仓库名见库存模块。',
    entityType: 'inventoryItem',
    idField: 'id',
    detailFields: [
      s('materialCode', '物料编码'),
      s('description', '品名'),
      e('category', '品类', ['Fabric', 'Trimmings', 'Accessories', 'Garment', 'Other'] as const),
      e('ownership', '货权', ['Owned', 'Transferred'] as const),
      n('quantity', '库存数量'),
      s('unit', '单位'),
      s('warehouseId', '仓库'),
      s('locationCode', '库位'),
      d('lastInDate', '最后入库日'),
    ],
    dimensions: [
      e('ownership', '货权', ['Owned', 'Transferred'] as const),
      s('unit', '单位'),
      e('category', '品类', ['Fabric', 'Trimmings', 'Accessories', 'Garment', 'Other'] as const),
      s('warehouseId', '仓库'),
      s('materialCode', '物料编码'),
      s('batchNumber', '批次号'),
      s('currency', '币种'),
    ],
    metrics: [
      n('quantity', '库存数量'),
      n('lockedQuantity', '锁定数量'),
      n('unitCost', '单位成本'),
      n('minStock', '最低库存线'),
    ],
    filterFields: [
      e('ownership', '货权', ['Owned', 'Transferred'] as const),
      s('unit', '单位'),
      e('category', '品类', ['Fabric', 'Trimmings', 'Accessories', 'Garment', 'Other'] as const),
      s('warehouseId', '仓库'),
      s('materialCode', '物料编码'),
      s('batchNumber', '批次号'),
      s('locationCode', '库位'),
      s('currency', '币种'),
      d('lastInDate', '最后入库日'),
      d('lastOutDate', '最后出库日'),
    ],
  },
];

const datasetIndex = new Map(REPORT_DATASETS.map(ds => [ds.key, ds]));

export function getDataset(key: string): DatasetSpec | undefined {
  return datasetIndex.get(key);
}

export function listDatasets(): DatasetSpec[] {
  return [...REPORT_DATASETS];
}
