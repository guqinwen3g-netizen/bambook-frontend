/**
 * company-sim/master-data.ts — 主数据：客户 / 供应商 / 货代 / 产品档案
 */

import { Prisma } from '@prisma/client';
import { at, createManyLogged, USERS, round2 } from './common';

export interface RelationRow {
  id: string;
  name: string;
  category: 'Customer' | 'Supplier' | 'Forwarder';
  country: string;
  ownerId?: string;
  currency: string;
}

export const CUSTOMERS: RelationRow[] = [
  { id: 'SIM-CUS-01', name: 'Maple & Thread Co.', category: 'Customer', country: 'US', ownerId: USERS.salesManager, currency: 'USD' },
  { id: 'SIM-CUS-02', name: 'Nordic Apparel GmbH', category: 'Customer', country: 'DE', ownerId: USERS.salesA, currency: 'EUR' },
  { id: 'SIM-CUS-03', name: 'Sakura Brands K.K.', category: 'Customer', country: 'JP', ownerId: USERS.salesB, currency: 'USD' },
  { id: 'SIM-CUS-04', name: 'Southern Cross Fashion Pty Ltd', category: 'Customer', country: 'AU', ownerId: USERS.salesA, currency: 'USD' },
  { id: 'SIM-CUS-05', name: 'Bleu Marlin SAS', category: 'Customer', country: 'FR', ownerId: USERS.salesB, currency: 'EUR' },
  { id: 'SIM-CUS-06', name: 'Cascadia Outfitters Inc.', category: 'Customer', country: 'US', ownerId: USERS.salesManager, currency: 'USD' },
  { id: 'SIM-CUS-07', name: 'Willow & Wren Ltd.', category: 'Customer', country: 'GB', ownerId: USERS.salesA, currency: 'USD' },
  { id: 'SIM-CUS-08', name: 'Aurora Milano S.r.l.', category: 'Customer', country: 'IT', ownerId: USERS.salesB, currency: 'EUR' },
];

export const SUPPLIERS: RelationRow[] = [
  { id: 'SIM-SUP-01', name: '吴江恒溢织造有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-02', name: '绍兴瑞丰针织有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-03', name: '常州华瑞印染有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-04', name: '江苏鹿港高科技针织有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-05', name: '上海永信拉链有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-06', name: '宁波华孚纽扣有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-07', name: '苏州锦绣织标有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-08', name: '杭州锦盛服饰有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-09', name: '无锡雅妮时装有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
  { id: 'SIM-SUP-10', name: '南通蓝羽服装有限公司', category: 'Supplier', country: 'CN', currency: 'CNY' },
];

export const FORWARDERS: RelationRow[] = [
  { id: 'SIM-FWD-01', name: '上海锦昀国际货运代理有限公司', category: 'Forwarder', country: 'CN', currency: 'CNY' },
  { id: 'SIM-FWD-02', name: '深圳迅航国际物流有限公司', category: 'Forwarder', country: 'CN', currency: 'CNY' },
];

const SUB_CATEGORIES = [
  { id: 'SIM-SUB-FABRIC', mainCategory: 'Fabric', name: '面料', description: '梭织/针织面料' },
  { id: 'SIM-SUB-FAB-WOVEN', mainCategory: 'Fabric', name: '梭织面料', description: 'Woven fabrics' },
  { id: 'SIM-SUB-FAB-KNIT', mainCategory: 'Fabric', name: '针织面料', description: 'Knitted fabrics' },
  { id: 'SIM-SUB-GARMENT', mainCategory: 'Garment', name: '成衣', description: 'Finished garments' },
  { id: 'SIM-SUB-GAR-DRESS', mainCategory: 'Garment', name: '连衣裙', description: 'Dresses' },
  { id: 'SIM-SUB-GAR-BLOUSE', mainCategory: 'Garment', name: '衬衫', description: 'Blouses & shirts' },
  { id: 'SIM-SUB-GAR-KNIT-TOP', mainCategory: 'Garment', name: '针织上衣', description: 'Knit tops' },
  { id: 'SIM-SUB-TRIM', mainCategory: 'Trimmings', name: '辅料', description: 'Trimmings / accessories' },
  { id: 'SIM-SUB-TRIM-ZIPPER', mainCategory: 'Trimmings', name: '拉链', description: 'Zippers' },
  { id: 'SIM-SUB-TRIM-BUTTON', mainCategory: 'Trimmings', name: '纽扣', description: 'Buttons' },
  { id: 'SIM-SUB-TRIM-LABEL', mainCategory: 'Trimmings', name: '标签织带', description: 'Labels & webbing' },
];

const COMPOSITION_TERMS = [
  { id: 'SIM-TERM-COT', abbreviation: 'C', chineseName: '棉', englishName: 'Cotton' },
  { id: 'SIM-TERM-PES', abbreviation: 'T', chineseName: '涤纶', englishName: 'Polyester' },
  { id: 'SIM-TERM-VIS', abbreviation: 'R', chineseName: '粘胶', englishName: 'Viscose' },
  { id: 'SIM-TERM-NY', abbreviation: 'N', chineseName: '锦纶', englishName: 'Nylon' },
  { id: 'SIM-TERM-SP', abbreviation: 'SP', chineseName: '氨纶', englishName: 'Spandex' },
  { id: 'SIM-TERM-LIN', abbreviation: 'L', chineseName: '亚麻', englishName: 'Linen' },
  { id: 'SIM-TERM-MD', abbreviation: 'MD', chineseName: '莫代尔', englishName: 'Modal' },
  { id: 'SIM-TERM-LYC', abbreviation: 'LYO', chineseName: '莱赛尔', englishName: 'Lyocell' },
  { id: 'SIM-TERM-WO', abbreviation: 'W', chineseName: '羊毛', englishName: 'Wool' },
];

const COUNTRY_ADDR: Record<string, { city: string; addr: string; contact: string; email: string }> = {
  US: { city: 'New York, NY', addr: '350 5th Ave, Suite 4200, New York, NY 10118', contact: 'Emily Carter', email: 'emily.carter@maplethread.example.com' },
  DE: { city: 'Hamburg', addr: 'Speicherstadt 14, 20457 Hamburg', contact: 'Jonas Weber', email: 'j.weber@nordicapparel.example.de' },
  JP: { city: 'Tokyo', addr: '2-11-3 Meguro, Meguro-ku, Tokyo 153-0063', contact: 'Yuki Tanaka', email: 'y.tanaka@sakurabrands.example.jp' },
  AU: { city: 'Melbourne', addr: '120 Collins St, Melbourne VIC 3000', contact: 'Olivia Bennett', email: 'olivia.b@scrossfashion.example.au' },
  FR: { city: 'Paris', addr: '18 Rue de Rivoli, 75004 Paris', contact: 'Camille Dubois', email: 'c.dubois@bleumarlin.example.fr' },
  GB: { city: 'London', addr: '45 Marylebone High St, London W1U 4QB', contact: 'Harry Whitmore', email: 'harry.w@willowwren.example.co.uk' },
  IT: { city: 'Milano', addr: 'Via Montenapoleone 8, 20121 Milano', contact: 'Sofia Ricci', email: 's.ricci@auroramilano.example.it' },
  CN: { city: '中国', addr: '中国', contact: '负责人', email: 'contact@example.cn' },
};

/**
 * 供应商工厂地址（2026-09-02 修复全景看板地图卡米兰：订单此前不写 millAddress/
 * consigneeAddress，customerAddress 只是「Overseas (客户名)」占位——8 客户中唯一
 * 含城市名的是 Aurora Milano → 'Milano'.includes('Milan') 子串命中 → 9 单全解析
 * 到米兰，地图中心=米兰均值。真实地址让 Dashboard 地球恢复「长三角工厂集群」
 * 航线图设计（城市名与前端 CityCoordinates 键对齐，millAddress 优先解析）。
 */
export const SUPPLIER_ADDR: Record<string, string> = {
  'SIM-SUP-01': 'No. 88 Hengyi Rd, Wujiang, Suzhou, Jiangsu 215200',
  'SIM-SUP-02': 'No. 16 Ruifeng Rd, Shaoxing, Zhejiang 312000',
  'SIM-SUP-03': 'No. 52 Huarui Rd, Changzhou, Jiangsu 213000',
  'SIM-SUP-04': 'No. 1 Lugang Ave, Zhangjiagang, Jiangsu 215600',
  'SIM-SUP-05': 'No. 300 Yongxin Rd, Shanghai 201100',
  'SIM-SUP-06': 'No. 9 Huafu Rd, Ningbo, Zhejiang 315000',
  'SIM-SUP-07': 'No. 66 Jinxiu Rd, Suzhou, Jiangsu 215128',
  'SIM-SUP-08': 'No. 18 Jinsheng Rd, Hangzhou, Zhejiang 310000',
  'SIM-SUP-09': 'No. 27 Yani Rd, Wuxi, Jiangsu 214000',
  'SIM-SUP-10': 'No. 3 Lanyu Rd, Nantong, Jiangsu 226000',
};

/** 客户 id → 海外真实地址（COUNTRY_ADDR 便捷封装，与 SUPPLIER_ADDR 对偶） */
export function customerAddrById(customerId: string): string | undefined {
  const c = CUSTOMERS.find((x) => x.id === customerId);
  return c ? COUNTRY_ADDR[c.country]?.addr : undefined;
}

export interface MasterDataCtx {
  customerIds: string[];
  supplierIds: string[];
  garmentAssets: { id: string; sku: string; name: string; styleNo: string; customerRelId: string; factoryRelId: string; subCategoryId: string }[];
  fabricAssets: { id: string; sku: string; name: string; millRelId: string }[];
}

/** 建主数据：子类 / 成分词条 / Relation / 联系人 / 产品档案（面料 24 + 成衣 12 + 辅料 6） */
export async function seedMasterData(prisma: PrismaClient): Promise<MasterDataCtx> {
  console.log('── 主数据：Relation（客户 8 / 供应商 10 / 货代 2） ──');
  const nowMs = at(1, 1, 9);

  // 1. 子类 + 成分词条
  await createManyLogged(prisma, 'productSubCategory', 'ProductSubCategory', SUB_CATEGORIES.map((s) => ({
    id: s.id, mainCategory: s.mainCategory, name: s.name, description: s.description,
    updatedAt: nowMs, deletedAt: null,
  })));
  await createManyLogged(prisma, 'materialCompositionTerm', 'MaterialCompositionTerm', COMPOSITION_TERMS.map((t) => ({
    id: t.id, abbreviation: t.abbreviation, chineseName: t.chineseName, englishName: t.englishName,
    updatedAt: nowMs, deletedAt: null,
  })));

  // 2. Relation：8 客户 + 10 供应商 + 2 货代
  const relationRows: Prisma.RelationUncheckedCreateInput[] = [];
  for (const c of CUSTOMERS) {
    const a = COUNTRY_ADDR[c.country];
    relationRows.push({
      id: c.id, code: `${c.id}-CODE`, name: c.name, category: 'Customer', type: 'Organization',
      isOrganization: true, stage: 'Customer', tier: 'A',
      contactInfo: `${a.contact} / ${a.email}`, lastInteraction: nowMs,
      englishName: c.name, primaryContactName: a.contact, primaryContactEmail: a.email,
      website: `https://www.${c.name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`,
      currency: c.currency, paymentTerms: 'T/T 30% deposit, 70% against B/L copy',
      paymentPreference: 'T/T', officialAddress: a.addr, shippingAddress: a.addr,
      coordinatesLat: 0, coordinatesLng: 0,
      ownerId: c.ownerId ?? USERS.salesManager, salesRepIds: [c.ownerId ?? USERS.salesManager],
      sensitivity: 'normal', deletedAt: null,
    });
  }
  for (const s of SUPPLIERS) {
    const a = COUNTRY_ADDR.CN;
    relationRows.push({
      id: s.id, code: `${s.id}-CODE`, name: s.name, category: 'Supplier', type: 'Organization',
      isOrganization: true, contactInfo: '业务部 / sales@example.cn', lastInteraction: nowMs,
      chineseName: s.name, currency: 'CNY', paymentTerms: '月结 30 天',
      officialAddress: '浙江省 / 江苏省', ownerId: USERS.gm, deletedAt: null,
    });
  }
  for (const f of FORWARDERS) {
    relationRows.push({
      id: f.id, code: `${f.id}-CODE`, name: f.name, category: 'Forwarder', type: 'Organization',
      isOrganization: true, contactInfo: '操作部 / ops@example.cn', lastInteraction: nowMs,
      chineseName: f.name, currency: 'CNY', ownerId: USERS.logistics, deletedAt: null,
    });
  }
  await createManyLogged(prisma, 'relation', 'Relation', relationRows);

  // 3. 联系人（Contact，每客户 2 人）
  const contactRows: Prisma.ContactUncheckedCreateInput[] = [];
  CUSTOMERS.forEach((c, ci) => {
    const a = COUNTRY_ADDR[c.country];
    contactRows.push({
      id: `SIM-CTC-${String(ci + 1).padStart(2, '0')}A`, relationId: c.id,
      name: a.contact, title: ci % 2 === 0 ? 'Purchasing Manager' : 'Head of Sourcing',
      email: a.email, phone: `+1-2${ci}-555-0${100 + ci}`, isPrimary: true, isDecisionMaker: ci < 4,
      tags: ['buyer'], status: 'Active', createdAt: nowMs, updatedAt: nowMs, deletedAt: null,
    });
    contactRows.push({
      id: `SIM-CTC-${String(ci + 1).padStart(2, '0')}B`, relationId: c.id,
      name: ci % 2 === 0 ? 'Michael Ross' : 'Anna Lindberg', title: 'Merchandiser',
      email: `merch${ci + 1}@${c.name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`,
      isPrimary: false, isDecisionMaker: false, tags: ['merchandiser'],
      status: 'Active', createdAt: nowMs, updatedAt: nowMs, deletedAt: null,
    });
  });
  // 供应商/货代联系人（真实公司必有对接人：业务+品质/操作）
  const SUPPLIER_CONTACT_POOL = [
    ['王建军', '销售经理', 'sales'], ['李慧敏', '外贸业务员', 'sales'],
    ['张伟国', '品控主管', 'qc'], ['陈丽娟', '单证专员', 'docs'],
    ['刘志强', '业务经理', 'sales'], ['赵雅萍', '跟单员', 'merchandiser'],
  ];
  SUPPLIERS.forEach((s, si) => {
    const [n1, t1] = SUPPLIER_CONTACT_POOL[si % SUPPLIER_CONTACT_POOL.length];
    const [n2, t2] = SUPPLIER_CONTACT_POOL[(si + 2) % SUPPLIER_CONTACT_POOL.length];
    const idx = String(si + 9).padStart(2, '0');
    contactRows.push({
      id: `SIM-CTC-${idx}A`, relationId: s.id, name: n1, title: t1,
      email: `sales${si + 1}@${s.id.toLowerCase()}.example.cn`, mobile: `138-${String(1000 + si * 7).padStart(4, '0')}-${String(2000 + si * 13).padStart(4, '0')}`,
      wechat: `wx_${s.id.toLowerCase()}_${si + 1}`, isPrimary: true, isDecisionMaker: si < 5,
      tags: ['supplier-sales'], status: 'Active', createdAt: nowMs, updatedAt: nowMs, deletedAt: null,
    });
    contactRows.push({
      id: `SIM-CTC-${idx}B`, relationId: s.id, name: n2, title: t2,
      email: `qc${si + 1}@${s.id.toLowerCase()}.example.cn`, mobile: `139-${String(3000 + si * 11).padStart(4, '0')}-${String(4000 + si * 3).padStart(4, '0')}`,
      isPrimary: false, isDecisionMaker: false, tags: [t2 === 'qc' ? 'supplier-qc' : 'supplier-merch'],
      status: 'Active', createdAt: nowMs, updatedAt: nowMs, deletedAt: null,
    });
  });
  FORWARDERS.forEach((f, fi) => {
    const idx = String(fi + 21).padStart(2, '0');
    contactRows.push({
      id: `SIM-CTC-${idx}A`, relationId: f.id, name: fi === 0 ? '孙海燕' : '周凯文', title: '船务操作',
      email: `ops@${f.id.toLowerCase()}.example.cn`, mobile: `137-${String(5000 + fi * 17).padStart(4, '0')}-${String(6000 + fi * 9).padStart(4, '0')}`,
      isPrimary: true, isDecisionMaker: false, tags: ['forwarder-ops'], status: 'Active', createdAt: nowMs, updatedAt: nowMs, deletedAt: null,
    });
  });
  await createManyLogged(prisma, 'contact', 'Contact', contactRows);

  // 4. 产品档案：24 面料 + 12 成衣 + 6 辅料
  console.log('── 主数据：产品档案（面料 24 / 成衣 12 / 辅料 6） ──');
  const fabricNames = [
    ['天丝棉平纹', 'Tencel Cotton Poplin', 'SIM-SUB-FAB-WOVEN'], ['莫代尔弹力斜纹', 'Modal Stretch Twill', 'SIM-SUB-FAB-WOVEN'],
    ['人棉印花布', 'Rayon Print', 'SIM-SUB-FAB-WOVEN'], ['亚麻混纺平纹', 'Linen Blend Plain', 'SIM-SUB-FAB-WOVEN'],
    ['全棉府绸', 'Cotton Poplin', 'SIM-SUB-FAB-WOVEN'], ['涤粘西装呢', 'Poly-viscose Suiting', 'SIM-SUB-FAB-WOVEN'],
    ['天丝斜纹', 'Tencel Twill', 'SIM-SUB-FAB-WOVEN'], ['棉锦弹力面料', 'Cotton Nylon Stretch', 'SIM-SUB-FAB-WOVEN'],
    ['雪纺', 'Chiffon', 'SIM-SUB-FAB-WOVEN'], ['色丁布', 'Satin', 'SIM-SUB-FAB-WOVEN'],
    ['全棉双绉', 'Cotton Crepe', 'SIM-SUB-FAB-WOVEN'], ['针织罗纹', 'Rib Knit', 'SIM-SUB-FAB-KNIT'],
    ['棉氨汗布', 'Cotton Spandex Jersey', 'SIM-SUB-FAB-KNIT'], ['莫代尔针织布', 'Modal Jersey', 'SIM-SUB-FAB-KNIT'],
    ['涤氨网眼布', 'Poly Spandex Mesh', 'SIM-SUB-FAB-KNIT'], ['罗纹袖口布', 'Cuff Rib', 'SIM-SUB-FAB-KNIT'],
    ['空气层面料', 'Air Layer', 'SIM-SUB-FAB-KNIT'], ['珠地网眼', 'Pique', 'SIM-SUB-FAB-KNIT'],
    ['摇粒绒', 'Polar Fleece', 'SIM-SUB-FAB-KNIT'], ['天丝麻针织', 'Tencel Linen Knit', 'SIM-SUB-FAB-KNIT'],
    ['蕾丝面料', 'Lace Fabric', 'SIM-SUB-FAB-KNIT'], ['牛仔布', 'Denim', 'SIM-SUB-FAB-WOVEN'],
    ['灯芯绒', 'Corduroy', 'SIM-SUB-FAB-WOVEN'], ['仿麻雪纺', 'Linen-look Chiffon', 'SIM-SUB-FAB-WOVEN'],
  ];
  const compPresets = [
    [['SIM-TERM-LYC', 55], ['SIM-TERM-COT', 45]], [['SIM-TERM-MD', 60], ['SIM-TERM-COT', 35], ['SIM-TERM-SP', 5]],
    [['SIM-TERM-VIS', 100]], [['SIM-TERM-LIN', 55], ['SIM-TERM-COT', 45]], [['SIM-TERM-COT', 97], ['SIM-TERM-SP', 3]],
    [['SIM-TERM-PES', 65], ['SIM-TERM-VIS', 35]], [['SIM-TERM-LYC', 100]], [['SIM-TERM-COT', 80], ['SIM-TERM-NY', 17], ['SIM-TERM-SP', 3]],
    [['SIM-TERM-PES', 100]], [['SIM-TERM-PES', 95], ['SIM-TERM-SP', 5]], [['SIM-TERM-COT', 100]], [['SIM-TERM-COT', 95], ['SIM-TERM-SP', 5]],
    [['SIM-TERM-COT', 95], ['SIM-TERM-SP', 5]], [['SIM-TERM-MD', 92], ['SIM-TERM-SP', 8]], [['SIM-TERM-PES', 90], ['SIM-TERM-SP', 10]],
    [['SIM-TERM-COT', 98], ['SIM-TERM-SP', 2]], [['SIM-TERM-PES', 60], ['SIM-TERM-COT', 40]], [['SIM-TERM-COT', 100]],
    [['SIM-TERM-PES', 100]], [['SIM-TERM-LYC', 50], ['SIM-TERM-LIN', 45], ['SIM-TERM-VIS', 5]], [['SIM-TERM-NY', 60], ['SIM-TERM-VIS', 40]],
    [['SIM-TERM-COT', 98], ['SIM-TERM-SP', 2]], [['SIM-TERM-COT', 100]], [['SIM-TERM-PES', 55], ['SIM-TERM-VIS', 45]],
  ];
  const fabricAssets: MasterDataCtx['fabricAssets'] = [];
  const fabricAssetRows: Prisma.ProductAssetUncheckedCreateInput[] = [];
  const fabricProfileRows: Prisma.FabricProfileUncheckedCreateInput[] = [];
  const compLineRows: Prisma.FabricCompositionLineUncheckedCreateInput[] = [];
  const priceRows: Prisma.FabricPriceHistoryUncheckedCreateInput[] = [];
  const certRows: Prisma.FabricCertificationUncheckedCreateInput[] = [];
  fabricNames.forEach(([cn, en, sub], i) => {
    const id = `SIM-FAB-${String(i + 1).padStart(3, '0')}`;
    const sku = `SIM-FABSKU-${String(i + 1).padStart(3, '0')}`;
    const mill = SUPPLIERS[i % 4]; // 前 4 家面料厂轮转
    const moq = 800 + (i % 5) * 200;
    const cost = round2(8.5 + (i % 8) * 2.3);
    fabricAssetRows.push({
      id, sku, name: `${cn} ${en}`, mainCategory: 'Fabric', subCategoryId: sub as string,
      season: i % 2 === 0 ? 'SS26' : 'AW26', cost, status: 'Active', updatedAt: nowMs, deletedAt: null,
    });
    fabricProfileRows.push({
      id: `${id}-PF`, productAssetId: id, articleNo: `F26-${1000 + i}`,
      millOrganizationId: mill.id, millName: mill.name, millQuality: `MQ-${String(i + 1).padStart(2, '0')}`,
      construction: i < 12 ? 'Woven' : 'Knit', yarnCount: `40S×40S/${i + 60}`,
      weightValue: 120 + (i % 9) * 20, weightUnit: 'gsm', weightValueGsm: 120 + (i % 9) * 20, widthValue: 150, widthUnit: 'cm',
      productionLeadDays: 25 + (i % 4) * 5, moqValue: moq, factoryMoqValue: moq, sampleMoqValue: 30,
      stockStatus: i % 3 === 0 ? 'InStock' : 'MadeToOrder', updatedAt: nowMs, deletedAt: null,
    });
    compPresets[i].forEach(([termId, pct], li) => {
      compLineRows.push({
        id: `${id}-CMP-${li}`, productAssetId: id, termId: termId as string,
        percentage: new Prisma.Decimal(pct), sortOrder: li, updatedAt: nowMs, deletedAt: null,
      });
    });
    // 2026-09-02 修复价格词汇断层：priceType 词汇统一为消费方口径
    // （ProductsManager 价格面板 / priceDeviationRuleService 目录价真源）——
    // factory=工厂采购价（出厂含税价）、customer=客户销售价（对外报价基准），
    // 原先的 purchase/sale 写入后全 UI 消费点读不到（0 命中）。
    priceRows.push({
      id: `${id}-PRICE-1`, productAssetId: id, priceType: 'factory', amount: new Prisma.Decimal(cost),
      currency: 'CNY', unit: 'M', customerOrganizationId: null, sourceType: 'manual',
      effectiveDate: '2026-05-20', note: '出厂含税价', updatedAt: nowMs, deletedAt: null,
    });
    priceRows.push({
      id: `${id}-PRICE-2`, productAssetId: id, priceType: 'customer', amount: new Prisma.Decimal(round2(cost * 1.9)),
      currency: 'USD', unit: 'M', customerOrganizationId: null, sourceType: 'manual',
      effectiveDate: '2026-05-25', note: '对外报价基准（FOB Shanghai）', updatedAt: nowMs, deletedAt: null,
    });
    if (i % 3 === 0) {
      certRows.push({
        id: `${id}-CERT-1`, productAssetId: id, certification: 'OEKO-TEX Standard 100',
        certificateNo: `OT-${2026}-${String(100 + i)}`, validUntil: '2027-05-31',
        note: 'Class I 婴幼儿级别部分', updatedAt: nowMs, deletedAt: null,
      });
    }
    fabricAssets.push({ id, sku, name: `${cn} ${en}`, millRelId: mill.id });
  });

  const garmentDefs = [
    ['法式碎花连衣裙', 'Floral Wrap Dress', 'Dress', 'SIM-SUB-GAR-DRESS'],
    ['吊带雪纺连衣裙', 'Chiffon Slip Dress', 'Dress', 'SIM-SUB-GAR-DRESS'],
    ['收腰针织连衣裙', 'Knitted Waist Dress', 'Dress', 'SIM-SUB-GAR-DRESS'],
    ['衬衫式连衣裙', 'Shirt Dress', 'Dress', 'SIM-SUB-GAR-DRESS'],
    ['V领雪纺衬衫', 'V-neck Chiffon Blouse', 'Blouse', 'SIM-SUB-GAR-BLOUSE'],
    ['泡泡袖衬衫', 'Puff Sleeve Blouse', 'Blouse', 'SIM-SUB-GAR-BLOUSE'],
    ['亚麻混纺衬衫', 'Linen Blend Shirt', 'Blouse', 'SIM-SUB-GAR-BLOUSE'],
    ['荷叶边衬衫', 'Ruffle Trim Blouse', 'Blouse', 'SIM-SUB-GAR-BLOUSE'],
    ['圆领针织上衣', 'Crew Neck Knit Top', 'Knit Top', 'SIM-SUB-GAR-KNIT-TOP'],
    ['坑条针织背心', 'Ribbed Knit Vest', 'Knit Top', 'SIM-SUB-GAR-KNIT-TOP'],
    ['喇叭袖针织衫', 'Bell Sleeve Knit Top', 'Knit Top', 'SIM-SUB-GAR-KNIT-TOP'],
    ['两件套针织上衣', 'Knit Twinset Top', 'Knit Top', 'SIM-SUB-GAR-KNIT-TOP'],
  ];
  const garmentAssets: MasterDataCtx['garmentAssets'] = [];
  const garmentAssetRows: Prisma.ProductAssetUncheckedCreateInput[] = [];
  const garmentProfileRows: Prisma.GarmentProfileUncheckedCreateInput[] = [];
  garmentDefs.forEach(([cn, en, cat, sub], i) => {
    const id = `SIM-GAR-${String(i + 1).padStart(3, '0')}`;
    const sku = `SIM-GARSKU-${String(i + 1).padStart(3, '0')}`;
    const styleNo = `GST-26${String(101 + i)}`;
    const cust = CUSTOMERS[i % 8];
    const factory = SUPPLIERS[7 + (i % 3)];
    const mainFab = fabricAssets[i % 24];
    garmentAssetRows.push({
      id, sku, name: `${cn} ${en}`, mainCategory: 'Garment', subCategoryId: sub as string,
      season: 'SS26', cost: round2(18 + i * 2.4), status: 'Active', updatedAt: nowMs, deletedAt: null,
    });
    garmentProfileRows.push({
      id: `${id}-GP`, productAssetId: id, styleNo, productName: `${cn} ${en}`, garmentCategory: cat,
      collection: 'SS26 Womenswear', customer: cust.name, customerRelationId: cust.id,
      factoryRelationId: factory.id, factory: factory.name, brand: cust.name.split(' ')[0],
      gender: 'Women', ageGroup: 'Adult', silhouette: cat === 'Dress' ? 'A-line' : 'Regular',
      moqValue: 500 + (i % 4) * 100, moqUnit: 'PCS',
      mainFabric: mainFab.name, liningFabric: i % 3 === 0 ? 'Poly Taffeta' : null,
      zipper: i % 2 === 0 ? 'YKK 5# Nylon' : null, button: 'Polyester 18L',
      sizeRange: 'XS-XXL', baseSize: 'M', countryOfOrigin: 'China',
      fobPrice: String(round2(6.8 + i * 1.1)),
      inspectionStandard: 'AQL 2.5/4.0 Level II', packingMethod: 'Solid color solid size, 1pc/polybag',
      cartonSpec: '60×40×40cm, ≤22kg', careLabel: 'Machine wash cold, tumble dry low',
      updatedAt: nowMs, deletedAt: null,
    } as Prisma.GarmentProfileUncheckedCreateInput);
    garmentAssets.push({ id, sku, name: `${cn} ${en}`, styleNo, customerRelId: cust.id, factoryRelId: factory.id, subCategoryId: sub as string });
  });

  const trimDefs = [
    ['尼龙隐形拉链 5#', 'Invisible Zipper 5#', 'SIM-SUB-TRIM-ZIPPER', 4],
    ['金属拉链 8#', 'Metal Zipper 8#', 'SIM-SUB-TRIM-ZIPPER', 4],
    ['树脂衬衣纽扣 18L', 'Resin Shirt Button 18L', 'SIM-SUB-TRIM-BUTTON', 5],
    ['贝壳纽扣 20L', 'Shell Button 20L', 'SIM-SUB-TRIM-BUTTON', 5],
    ['织标主唛', 'Woven Main Label', 'SIM-SUB-TRIM-LABEL', 6],
    ['洗水唛', 'Care Label', 'SIM-SUB-TRIM-LABEL', 6],
  ];
  const trimRows: Prisma.ProductAssetUncheckedCreateInput[] = [];
  const trimProfileRows: Prisma.TrimmingProfileUncheckedCreateInput[] = [];
  trimDefs.forEach(([cn, en, sub, supIdx], i) => {
    const id = `SIM-TRIM-${String(i + 1).padStart(3, '0')}`;
    const sup = SUPPLIERS[supIdx as number];
    trimRows.push({
      id, sku: `SIM-TRMSKU-${String(i + 1).padStart(3, '0')}`, name: `${cn} ${en}`,
      mainCategory: 'Trimmings', subCategoryId: sub as string, season: 'SS26',
      cost: round2(0.15 + i * 0.2), status: 'Active', updatedAt: nowMs, deletedAt: null,
    });
    trimProfileRows.push({
      id: `${id}-TP`, productAssetId: id, trimmingCode: `TRM-${200 + i}`, trimmingName: `${cn} ${en}`,
      trimmingCategory: (sub as string).endsWith('ZIPPER') ? 'Zipper' : (sub as string).endsWith('BUTTON') ? 'Button' : 'Label',
      material: i < 2 ? 'Nylon/Metal' : i < 4 ? 'Resin/Shell' : 'Polyester',
      supplier: sup.name, supplierRelationId: sup.id, unit: i < 4 ? 'PC' : 'PCS',
      moq: i < 4 ? '1000 PCS' : '3000 PCS', leadTime: '10-15 days', currency: 'CNY',
      price: String(round2(0.15 + i * 0.2)), updatedAt: nowMs, deletedAt: null,
    });
  });

  await createManyLogged(prisma, 'productAsset', 'ProductAsset（面料/成衣/辅料）', [...fabricAssetRows, ...garmentAssetRows, ...trimRows]);
  await createManyLogged(prisma, 'fabricProfile', 'FabricProfile', fabricProfileRows);
  await createManyLogged(prisma, 'garmentProfile', 'GarmentProfile', garmentProfileRows);
  await createManyLogged(prisma, 'trimmingProfile', 'TrimmingProfile', trimProfileRows);
  await createManyLogged(prisma, 'fabricCompositionLine', 'FabricCompositionLine', compLineRows);
  await createManyLogged(prisma, 'fabricPriceHistory', 'FabricPriceHistory', priceRows);
  await createManyLogged(prisma, 'fabricCertification', 'FabricCertification', certRows);

  // 5. FabricCustomerCode：客户品号映射（2026-09-02 补数——此前 0 行，
  //    ProductsManager 客户分类视图/搜索/客供品号解析全空转）。
  //    8 客户 × 主要面料共 15 条，其中 2 条 isExclusive=true（P1-3 客户专属
  //    面料规则演示：属主客户必须可锚定，customerOrganizationId 强制非空）。
  const CLIENT_CODE_SPECS: Array<{ cus: number; fab: number; code: string; exclusive?: boolean; note: string }> = [
    { cus: 0, fab: 0, code: 'AT-2601', note: 'Maple & Thread 品号：Tencel Cotton Poplin' },
    { cus: 0, fab: 4, code: 'AT-2605', exclusive: true, note: 'Maple & Thread 出资开发的独家属主面料（SS26 胶囊系列）' },
    { cus: 1, fab: 3, code: 'NA-2610', note: 'Nordic Apparel 品号：Linen Blend Plain（AW26 补单主面料）' },
    { cus: 1, fab: 6, code: 'NA-2612', note: 'Nordic Apparel 品号：Tencel Twill' },
    { cus: 2, fab: 11, code: 'SB-2620', note: 'Sakura Brands 品号：Rib Knit（罗纹袖口配套）' },
    { cus: 2, fab: 12, code: 'SB-2621', note: 'Sakura Brands 品号：Cotton Spandex Jersey' },
    { cus: 3, fab: 9, code: 'SC-2630', note: 'Southern Cross 品号：Satin' },
    { cus: 3, fab: 18, code: 'SC-2631', note: 'Southern Cross 品号：Polar Fleece' },
    { cus: 4, fab: 1, code: 'BM-2640', note: 'Bleu Marlin 品号：Modal Stretch Twill' },
    { cus: 4, fab: 10, code: 'BM-2641', note: 'Bleu Marlin 品号：Cotton Crepe' },
    { cus: 5, fab: 2, code: 'CO-2650', note: 'Cascadia 品号：Rayon Print' },
    { cus: 5, fab: 20, code: 'CO-2651', note: 'Cascadia 品号：Lace Fabric' },
    { cus: 6, fab: 8, code: 'WW-2660', note: 'Willow & Wren 品号：Chiffon' },
    { cus: 6, fab: 17, code: 'WW-2661', exclusive: true, note: 'Willow & Wren 独家开发提花雪纺（买断供料）' },
    { cus: 7, fab: 5, code: 'AM-2670', note: 'Aurora Milano 品号：Poly-viscose Suiting' },
  ];
  const clientCodeRows: Prisma.FabricCustomerCodeUncheckedCreateInput[] = CLIENT_CODE_SPECS.map((s, i) => ({
    id: `SIM-FCC-${String(i + 1).padStart(3, '0')}`,
    productAssetId: `SIM-FAB-${String(s.fab + 1).padStart(3, '0')}`,
    customerOrganizationId: CUSTOMERS[s.cus].id,
    customerNameSnapshot: CUSTOMERS[s.cus].name,
    clientCode: s.code,
    isExclusive: !!s.exclusive,
    note: s.note,
    updatedAt: nowMs, deletedAt: null,
  }));
  await createManyLogged(prisma, 'fabricCustomerCode', 'FabricCustomerCode（客户品号映射）', clientCodeRows);

  return { customerIds: CUSTOMERS.map((c) => c.id), supplierIds: SUPPLIERS.map((s) => s.id), garmentAssets, fabricAssets };
}
