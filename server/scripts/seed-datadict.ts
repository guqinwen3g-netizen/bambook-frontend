/**
 * seed-datadict.ts — Phase 0-07 初始化 21 类系统字典（幂等重跑）
 *
 * 运行：
 *   cd server && npx ts-node scripts/seed-datadict.ts
 */
import { PrismaClient } from '@prisma/client';
import type { DictCategory } from '../src/dictionaries/dataDictionaryService';
import type { DictEntry } from '../src/dictionaries/dataDictionaryService';

const prisma = new PrismaClient();

interface DictSeed {
  code: string;
  name: string;
  category: DictCategory;
  entries: Omit<DictEntry, 'order'> & { order?: number }[] extends never ? never : Array<Partial<DictEntry> & { key: string; label: string }>;
  description?: string;
}

const SEEDS: DictSeed[] = [
  // ————————— BOM & 成本（3类）—————————
  {
    code: 'bom_material_type',
    name: 'BOM 物料类型',
    category: 'bom',
    description: '与 bomService MaterialType 类型对齐；系统内置（禁止删除 key）',
    entries: [
      { key: 'Main',         label: '主布 / Main Fabric',        order: 0, color: '#2563eb', tags: ['fabric'] },
      { key: 'Contrast',     label: '配色布 / Contrast Fabric',   order: 1, color: '#7c3aed', tags: ['fabric'] },
      { key: 'Lining',       label: '里布 / Lining',              order: 2, color: '#059669', tags: ['fabric'] },
      { key: 'Pocketing',    label: '袋布 / Pocketing',           order: 3, color: '#0891b2', tags: ['fabric'] },
      { key: 'Trimmings',    label: '辅料 / Trimmings & Accessories', order: 4, color: '#ea580c', tags: ['accessory'] },
      { key: 'Thread',       label: '缝纫线 / Thread',            order: 5, color: '#db2777', tags: ['consumable'] },
      { key: 'Packaging',    label: '包装 / Packaging',           order: 6, color: '#64748b', tags: ['packaging'] },
      { key: 'Other',        label: '其他 / Other',               order: 99 },
    ],
  },
  {
    code: 'bom_cost_type',
    name: '成本分类',
    category: 'bom',
    description: '与 bomService CostType 对齐；Material/Labor/Overhead/Other',
    entries: [
      { key: 'Material', label: '物料成本 Material', order: 0, color: '#2563eb' },
      { key: 'Labor',    label: '人工成本 Labor',    order: 1, color: '#16a34a' },
      { key: 'Overhead', label: '制造费用 Overhead', order: 2, color: '#ea580c' },
      { key: 'Other',    label: '其他费用 Other',    order: 3, color: '#64748b' },
    ],
  },
  {
    code: 'bom_status',
    name: 'BOM 状态',
    category: 'bom',
    entries: [
      { key: 'Draft',     label: '草稿',  order: 0, color: '#94a3b8' },
      { key: 'Confirmed', label: '已确认', order: 1, color: '#2563eb' },
      { key: 'Archived',  label: '已归档', order: 9, color: '#64748b', disabled: false },
    ],
  },

  // ————————— 订单/履约（2类）—————————
  {
    code: 'order_status',
    name: '订单状态',
    category: 'order',
    entries: [
      { key: 'Draft',        label: '草稿',        order: 0, color: '#94a3b8' },
      { key: 'Confirmed',    label: '已确认',      order: 1, color: '#2563eb' },
      { key: 'InProduction', label: '生产中',      order: 2, color: '#7c3aed' },
      { key: 'Shipped',      label: '已出货',      order: 3, color: '#0ea5e9' },
      { key: 'Invoiced',     label: '已开票',      order: 4, color: '#f59e0b' },
      { key: 'Paid',         label: '已收款',      order: 5, color: '#16a34a' },
      { key: 'Completed',    label: '已完成',      order: 6, color: '#059669' },
      { key: 'Cancelled',    label: '已取消',      order: 9, color: '#ef4444' },
    ],
  },
  {
    code: 'order_type',
    name: '订单类型',
    category: 'order',
    entries: [
      { key: 'Fabric',   label: '面料订单',   order: 0, color: '#0891b2' },
      { key: 'Apparel',  label: '成衣订单',   order: 1, color: '#7c3aed' },
      { key: 'HomeText', label: '家纺订单',   order: 2, color: '#db2777' },
      { key: 'Accessory',label: '辅料订单',   order: 3, color: '#ea580c' },
      { key: 'Other',    label: '其他订单',   order: 99 },
    ],
  },
  {
    code: 'shipment_status',
    name: '发货状态',
    category: 'logistics',
    entries: [
      { key: 'Draft',         label: '草稿',          order: 0, color: '#94a3b8' },
      { key: 'Packing',       label: '装箱中',        order: 1, color: '#2563eb' },
      { key: 'Ready',         label: '待发货',        order: 2, color: '#f59e0b' },
      { key: 'Dispatched',    label: '已发货',        order: 3, color: '#7c3aed' },
      { key: 'InTransit',     label: '运输途中',      order: 4, color: '#0ea5e9' },
      { key: 'Delivered',     label: '客户签收',      order: 5, color: '#16a34a' },
      { key: 'Cancelled',     label: '取消/退回',     order: 9, color: '#ef4444' },
    ],
  },

  // ————————— 财务（4类）—————————
  {
    code: 'payment_terms',
    name: '付款条款',
    category: 'finance',
    entries: [
      { key: 'TT_30_PRE',   label: 'T/T 30% 预付 + 70% 见提单', order: 0 },
      { key: 'TT_100_AT_SIGHT', label: 'T/T 100% 即期',    order: 1 },
      { key: 'LC_SIGHT',    label: 'L/C 即期信用证',          order: 2 },
      { key: 'LC_30',       label: 'L/C 提单后 30 天',        order: 3 },
      { key: 'OA_30',       label: 'O/A 月结 30 天',           order: 4 },
      { key: 'OA_60',       label: 'O/A 月结 60 天',           order: 5 },
      { key: 'DP_SIGHT',    label: 'D/P 即期（付款交单）',     order: 6 },
      { key: 'DA_30',       label: 'D/A 30 天（承兑交单）',    order: 7 },
      { key: 'CASH',        label: '现金/人民币转账',           order: 99 },
    ],
  },
  {
    code: 'incoterms',
    name: '贸易术语 Incoterms 2020',
    category: 'finance',
    entries: [
      { key: 'EXW', label: 'EXW 工厂交货',       order: 0 },
      { key: 'FCA', label: 'FCA 货交承运人',     order: 1 },
      { key: 'FAS', label: 'FAS 船边交货',       order: 2 },
      { key: 'FOB', label: 'FOB 船上交货（离岸价）', order: 3, color: '#2563eb' },
      { key: 'CFR', label: 'CFR 成本加运费',     order: 4 },
      { key: 'CIF', label: 'CIF 成本保险加运费', order: 5, color: '#7c3aed' },
      { key: 'CPT', label: 'CPT 运费付至',       order: 6 },
      { key: 'CIP', label: 'CIP 运费保险付至',   order: 7 },
      { key: 'DAP', label: 'DAP 目的地交货',     order: 8 },
      { key: 'DPU', label: 'DPU 卸货后交货',     order: 9 },
      { key: 'DDP', label: 'DDP 完税后交货',     order: 10, color: '#ea580c' },
    ],
  },
  {
    code: 'currency',
    name: '币种',
    category: 'finance',
    entries: [
      { key: 'CNY', label: '人民币 ¥',   order: 0, color: '#dc2626', value: 1, tags: ['default', 'local'] },
      { key: 'USD', label: '美元 US$',   order: 1, color: '#16a34a', value: 2, tags: ['main-trade'] },
      { key: 'EUR', label: '欧元 €',     order: 2, color: '#2563eb', value: 3 },
      { key: 'HKD', label: '港币 HK$',   order: 3, color: '#7c3aed', value: 4 },
      { key: 'JPY', label: '日元 ¥',     order: 4, color: '#ea580c', value: 5 },
      { key: 'GBP', label: '英镑 £',     order: 5, color: '#0891b2', value: 6 },
      { key: 'AUD', label: '澳元 A$',    order: 6, value: 7 },
      { key: 'CAD', label: '加元 C$',    order: 7, value: 8 },
      { key: 'SGD', label: '新加坡元 S$', order: 8, value: 9 },
      { key: 'KRW', label: '韩元 ₩',     order: 9, value: 10 },
    ],
  },
  {
    code: 'tax_code',
    name: '税码（增值税）',
    category: 'finance',
    entries: [
      { key: 'VAT_13', label: 'VAT 13%（一般商品）',       order: 0, color: '#dc2626', value: 0.13, tags: ['standard'] },
      { key: 'VAT_9',  label: 'VAT 9%（交通/运输/农产品）', order: 1, color: '#ea580c', value: 0.09 },
      { key: 'VAT_6',  label: 'VAT 6%（现代服务/货代）',    order: 2, color: '#f59e0b', value: 0.06 },
      { key: 'VAT_3',  label: 'VAT 3%（小规模简易）',       order: 3, color: '#7c3aed', value: 0.03 },
      { key: 'VAT_0',  label: 'VAT 0%（出口退税类）',       order: 4, color: '#16a34a', value: 0, tags: ['export'] },
      { key: 'TAX_FREE', label: '免税（Tax Free）',          order: 5, color: '#0891b2', value: 0, tags: ['special'] },
    ],
  },
  {
    code: 'invoice_status',
    name: '发票状态',
    category: 'finance',
    entries: [
      { key: 'Draft',     label: '草稿',        order: 0, color: '#94a3b8' },
      { key: 'Issued',    label: '已开具',      order: 1, color: '#2563eb' },
      { key: 'Received',  label: '已收到',      order: 2, color: '#16a34a' },
      { key: 'Posted',    label: '已入账',      order: 3, color: '#059669' },
      { key: 'RedWritten',label: '已红冲',      order: 4, color: '#dc2626' },
      { key: 'Void',      label: '已作废',      order: 9, color: '#64748b' },
    ],
  },
  {
    code: 'vat_invoice_type',
    name: '增值税发票类型',
    category: 'finance',
    entries: [
      { key: 'SPECIAL_PAPER', label: '纸质增值税专用发票',        order: 0, color: '#dc2626', tags: ['deductible'] },
      { key: 'SPECIAL_E',     label: '全电增值税专用发票',        order: 1, color: '#7c3aed', tags: ['deductible'] },
      { key: 'NORMAL_PAPER',  label: '纸质增值税普通发票',        order: 2, color: '#0891b2' },
      { key: 'NORMAL_E',      label: '全电增值税普通发票',        order: 3, color: '#0ea5e9' },
      { key: 'EXPORT_INV',    label: '出口商业发票（Commercial）', order: 4, color: '#16a34a', tags: ['export'] },
    ],
  },
  {
    code: 'approval_status',
    name: '审批状态',
    category: 'system',
    entries: [
      { key: 'Draft',     label: '草稿',   order: 0, color: '#94a3b8' },
      { key: 'Pending',   label: '审批中', order: 1, color: '#f59e0b' },
      { key: 'Approved',  label: '已通过', order: 2, color: '#16a34a' },
      { key: 'Rejected',  label: '已驳回', order: 3, color: '#dc2626' },
      { key: 'Withdrawn', label: '已撤回', order: 9, color: '#64748b' },
    ],
  },

  // ————————— CRM / Relation（3类）—————————
  {
    code: 'relation_type',
    name: '实体类型',
    category: 'crm',
    entries: [
      { key: 'Customer',  label: '客户 Customer',     order: 0, color: '#2563eb', tags: ['buy-side'] },
      { key: 'Supplier',  label: '供应商 Supplier',   order: 1, color: '#16a34a', tags: ['sell-side'] },
      { key: 'Factory',   label: '工厂 Factory',      order: 2, color: '#ea580c', tags: ['sell-side'] },
      { key: 'Agent',     label: '代理商 Agent',      order: 3, color: '#7c3aed', tags: ['mid'] },
      { key: 'Logistics', label: '物流服务商 Forwarder', order: 4, color: '#0891b2', tags: ['service'] },
      { key: 'Bank',      label: '银行 Bank',         order: 5, color: '#059669', tags: ['finance'] },
      { key: 'Other',     label: '其他 Other',        order: 99 },
    ],
  },
  {
    code: 'relation_stage',
    name: '客户阶段',
    category: 'crm',
    entries: [
      { key: 'Lead',          label: '线索 Lead',          order: 0, color: '#94a3b8' },
      { key: 'Opportunity',   label: '商机 Opportunity',    order: 1, color: '#f59e0b' },
      { key: 'Quotation',     label: '报价中',              order: 2, color: '#7c3aed' },
      { key: 'TrialOrder',    label: '打样/试单',           order: 3, color: '#2563eb' },
      { key: 'Customer',      label: '正式客户',            order: 4, color: '#16a34a' },
      { key: 'Key',           label: '战略/大客户',         order: 5, color: '#dc2626', tags: ['vip'] },
      { key: 'Churned',       label: '流失客户',            order: 9, color: '#64748b' },
    ],
  },
  {
    code: 'relation_tier',
    name: '客户等级',
    category: 'crm',
    entries: [
      { key: 'S',   label: 'S 级 — 战略级', order: 0, color: '#dc2626', tags: ['top'] },
      { key: 'A',   label: 'A 级 — 核心',   order: 1, color: '#ea580c' },
      { key: 'B',   label: 'B 级 — 重要',   order: 2, color: '#f59e0b' },
      { key: 'C',   label: 'C 级 — 普通',   order: 3, color: '#0ea5e9' },
      { key: 'D',   label: 'D 级 — 待培育', order: 4, color: '#94a3b8' },
      { key: 'Z',   label: 'Z 级 — 暂停合作', order: 9, color: '#64748b' },
    ],
  },

  // ————————— 产品 / 生产（1类）—————————
  {
    code: 'product_category',
    name: '产品大类',
    category: 'product',
    entries: [
      { key: 'Fabric',   label: '面料 / Fabric',    order: 0, color: '#0891b2' },
      { key: 'Apparel',  label: '服装 / Apparel',   order: 1, color: '#7c3aed' },
      { key: 'HomeText', label: '家纺 / Home Textile', order: 2, color: '#db2777' },
      { key: 'Accessory',label: '辅料 / Trimmings & Accessories', order: 3, color: '#ea580c' },
      { key: 'Package',  label: '包装 / Packaging', order: 4, color: '#64748b' },
      { key: 'Other',    label: '其他 / Other',     order: 99 },
    ],
  },

  // ————————— 报关 / 海关（1类）—————————
  {
    code: 'customs_decl_status',
    name: '报关状态',
    category: 'customs',
    entries: [
      { key: 'Draft',      label: '草稿',          order: 0, color: '#94a3b8' },
      { key: 'Prepared',   label: '单证制作完成',   order: 1, color: '#2563eb' },
      { key: 'Submitted',  label: '已申报',        order: 2, color: '#7c3aed' },
      { key: 'Inspection', label: '查验中',        order: 3, color: '#f59e0b' },
      { key: 'Released',   label: '通关放行',      order: 4, color: '#16a34a' },
      { key: 'Cleared',    label: '结关（关单回传）', order: 5, color: '#059669' },
      { key: 'Rejected',   label: '退单 / 未通过',  order: 9, color: '#dc2626' },
    ],
  },

  // ————————— HR（2类）—————————
  {
    code: 'department_category',
    name: '部门类别',
    category: 'hr',
    entries: [
      { key: 'Sales',      label: '销售/业务部',   order: 0, color: '#2563eb' },
      { key: 'Merchandiser', label: '跟单/技术部', order: 1, color: '#7c3aed' },
      { key: 'Production', label: '生产/工厂部',   order: 2, color: '#ea580c' },
      { key: 'Finance',    label: '财务/成本部',   order: 3, color: '#dc2626' },
      { key: 'Logistics',  label: '物流/储运部',   order: 4, color: '#0891b2' },
      { key: 'HR_Admin',   label: '人事/行政/总办', order: 5, color: '#64748b' },
      { key: 'Product',    label: '产品/开发部',   order: 6, color: '#0ea5e9' },
      { key: 'QC',         label: '品质管理部',    order: 7, color: '#16a34a' },
      { key: 'Management', label: '管理层',        order: 99, color: '#f59e0b', tags: ['exec'] },
    ],
  },
  {
    code: 'employee_level',
    name: '职级',
    category: 'hr',
    entries: [
      { key: 'Owner',  label: 'Owner 老板 / 总裁', order: 0, color: '#dc2626', tags: ['exec'] },
      { key: 'M5',     label: 'M5 总经理 / Partner', order: 1, color: '#ea580c', tags: ['exec'] },
      { key: 'M4',     label: 'M4 副总 / 总监',    order: 2, color: '#f59e0b', tags: ['exec'] },
      { key: 'M3',     label: 'M3 高级经理',       order: 3, color: '#7c3aed', tags: ['manager'] },
      { key: 'M2',     label: 'M2 经理',           order: 4, color: '#2563eb', tags: ['manager'] },
      { key: 'M1',     label: 'M1 主管',           order: 5, color: '#0891b2', tags: ['manager'] },
      { key: 'P8',     label: 'P8 专家级',         order: 6, color: '#0ea5e9', tags: ['pro'] },
      { key: 'P7',     label: 'P7 高级',           order: 7, color: '#059669' },
      { key: 'P6',     label: 'P6 资深',           order: 8, color: '#16a34a' },
      { key: 'P5',     label: 'P5 中级',           order: 9 },
      { key: 'P4',     label: 'P4 初级',           order: 10 },
      { key: 'P3',     label: 'P3 助理',           order: 11 },
      { key: 'P2',     label: 'P2 实习生',         order: 12 },
      { key: 'P1',     label: 'P1 见习',           order: 13, disabled: true },
    ],
  },
  {
    code: 'leave_type',
    name: '请假类型',
    category: 'hr',
    entries: [
      { key: 'Annual',    label: '年假',       order: 0, color: '#16a34a', tags: ['paid'] },
      { key: 'Personal',  label: '事假',       order: 1, color: '#ea580c' },
      { key: 'Sick',      label: '病假',       order: 2, color: '#dc2626' },
      { key: 'Compensatory', label: '调休（加班抵）', order: 3, color: '#0891b2', tags: ['paid'] },
      { key: 'Marriage',  label: '婚假',       order: 4, color: '#db2777', tags: ['paid'] },
      { key: 'Maternity', label: '产假',       order: 5, color: '#7c3aed', tags: ['paid'] },
      { key: 'Paternity', label: '陪产假',     order: 6, color: '#2563eb', tags: ['paid'] },
      { key: 'Bereavement', label: '丧假',     order: 7, color: '#64748b', tags: ['paid'] },
      { key: 'WorkInjury', label: '工伤假',     order: 8, color: '#f59e0b' },
      { key: 'Public',    label: '公休假',     order: 9, color: '#059669', tags: ['national'] },
      { key: 'Unpaid',    label: '无薪休假',   order: 99, color: '#94a3b8' },
    ],
  },
];

async function seedOne(seed: DictSeed): Promise<{ code: string; entriesN: number; created: boolean }> {
  const id = `DICT_global_${seed.code}`;
  const existing = await prisma.dataDictionary.findUnique({ where: { id }, select: { id: true } });
  // 注意：upsert 不直接调用 dataDictionaryService（避免循环依赖），这里简单直接 upsert；version 采用 1；以后若有变更服务端会自增
  await prisma.dataDictionary.upsert({
    where: { id },
    create: {
      id,
      code: seed.code,
      name: seed.name,
      category: seed.category,
      scope: 'global',
      isSystem: true,
      version: 1,
      entries: seed.entries
        .map((e, i) => ({ order: i, ...e }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) as any,
      description: seed.description ?? null,
      updatedAt: BigInt(Date.now()),
    },
    update: {
      // 只在 description 为空且 seed.description 有值时补写 description，不覆盖 entries（避免管理员自定义被覆盖）
      description: seed.description ?? undefined,
      updatedAt: BigInt(Date.now()),
    },
  });
  return { code: seed.code, entriesN: seed.entries.length, created: !existing };
}

async function main() {
  console.log(`[seed-datadict] Start. 字典种类=${SEEDS.length}`);
  let created = 0;
  let skipped = 0;
  for (const s of SEEDS) {
    const r = await seedOne(s);
    if (r.created) {
      console.log(`  + create ${r.code.padEnd(22)} [${s.category}] (${r.entriesN} entries) -> ${s.name}`);
      created++;
    } else {
      console.log(`  · skip   ${r.code.padEnd(22)} [${s.category}] (${r.entriesN} entries) — 已存在（保留管理员自定义）`);
      skipped++;
    }
  }
  console.log(`[seed-datadict] Done. created=${created}, skipped=${skipped}.`);
  console.log('[seed-datadict] 所有 21 类系统字典基线已完成。后续请通过 dataDictionaryService.upsert 修改（自动 version+1 + 写 History）');
}

main()
  .catch((err) => {
    console.error('[seed-datadict] FAILED:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
