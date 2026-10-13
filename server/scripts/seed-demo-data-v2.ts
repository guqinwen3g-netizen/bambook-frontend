/**
 * Enhanced DEMO data seed for Bambook — v2.
 *
 * Changes from v1:
 *   - Peerless (actual business customer) as 3rd customer
 *   - Agent + Freight Forwarder organizations
 *   - 3-4 contacts per customer, 2-3 per supplier
 *   - Garment + Trimming product assets (not just Fabric)
 *   - ProductSubCategory + ProductClassification seed data
 *   - EntityLinks connecting orders↔products↔relations
 *   - More orders with diverse statuses and scenarios
 *   - EntityReference entries for cross-entity resolution
 *
 * New in v2 (2026-06-15):
 *   - DevelopmentCase: 5 demo development cases (fabric/garment/pp stages)
 *   - Invoice: 6 demo invoices (Receivable + Payable, various statuses)
 *   - PaymentVoucher: 4 demo payment vouchers (Receipt + Disbursement)
 *   - Shipment + ShipmentLine: 4 shipments with 5 lines
 *   - Insight: 15 demo insight records
 *   - Rollback excludes PDML-* records (庞大面料 data preserved)
 *
 * Run from apps/Bambook/server:
 *   npx tsx scripts/seed-demo-data-v2.ts --dry-run
 *   npx tsx scripts/seed-demo-data-v2.ts --apply
 *   npx tsx scripts/seed-demo-data-v2.ts --rollback
 */

import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';

const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const apply = args.has('--apply');
const rollback = args.has('--rollback');

if (![dryRun, apply, rollback].filter(Boolean).length) {
  console.error('Usage: npx tsx scripts/seed-demo-data-v2.ts --dry-run | --apply | --rollback');
  process.exit(1);
}

const DEMO_TAG = 'DEMO';
const DEMO_SOURCE = 'demo';
const now = 1767225600000; // 2026-01-01T00:00:00.000Z

// ─── Type aliases ───────────────────────────────────────────────
type RelationSeed = Prisma.RelationUncheckedCreateInput;
type FabricProductSeed = {
  asset: Prisma.ProductAssetUncheckedCreateInput;
  fabricProfile: Prisma.FabricProfileUncheckedCreateInput;
  composition: Array<{ id: string; termId: string; abbreviation: string; chineseName: string; englishName: string; percentage: number }>;
  customerCodes: Prisma.FabricCustomerCodeUncheckedCreateInput[];
  prices: Prisma.FabricPriceHistoryUncheckedCreateInput[];
  certifications: Prisma.FabricCertificationUncheckedCreateInput[];
};
type GarmentProductSeed = {
  asset: Prisma.ProductAssetUncheckedCreateInput;
  garmentProfile: Prisma.GarmentProfileUncheckedCreateInput;
  customerCodes: Prisma.FabricCustomerCodeUncheckedCreateInput[];
  prices: Prisma.FabricPriceHistoryUncheckedCreateInput[];
};
type TrimmingProductSeed = {
  asset: Prisma.ProductAssetUncheckedCreateInput;
  trimmingProfile: Prisma.TrimmingProfileUncheckedCreateInput;
  prices: Prisma.FabricPriceHistoryUncheckedCreateInput[];
};
type OrderSeed = {
  order: Prisma.OrderUncheckedCreateInput;
  lines: Prisma.OrderLineUncheckedCreateInput[];
};
type DevelopmentCaseSeed = Prisma.DevelopmentCaseUncheckedCreateInput;
type InvoiceSeed = Prisma.InvoiceUncheckedCreateInput;
type PaymentVoucherSeed = Prisma.PaymentVoucherUncheckedCreateInput;
type InvoiceAllocationSeed = Prisma.InvoiceAllocationUncheckedCreateInput;
type FactoryProfileSeed = Prisma.FactoryProfileUncheckedCreateInput;
type SampleColorBatchSeed = Prisma.SampleColorBatchUncheckedCreateInput;
type FactoryEvaluationSeed = Prisma.FactoryEvaluationUncheckedCreateInput;
type ShipmentSeed = Prisma.ShipmentUncheckedCreateInput;
type ShipmentLineSeed = Prisma.ShipmentLineUncheckedCreateInput;
type InsightSeed = Prisma.InsightUncheckedCreateInput;
type SubCategorySeed = Prisma.ProductSubCategoryUncheckedCreateInput;
type ClassificationSeed = Prisma.ProductClassificationUncheckedCreateInput;
type EntityLinkSeed = Prisma.EntityLinkUncheckedCreateInput;
type EntityRefSeed = Prisma.EntityReferenceUncheckedCreateInput;

// ═══════════════════════════════════════════════════════════════════
// 1. PRODUCT SUB-CATEGORIES
// ═══════════════════════════════════════════════════════════════════
const subCategories: SubCategorySeed[] = [
  { id: 'DEMO-SUB-FABRIC', mainCategory: 'Fabric', name: '面料', description: '梭织/针织面料', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-WOVEN', mainCategory: 'Fabric', name: '梭织面料', description: 'Woven fabrics', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-KNIT', mainCategory: 'Fabric', name: '针织面料', description: 'Knitted fabrics', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-GARMENT', mainCategory: 'Garment', name: '成衣', description: 'Finished garments', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-GARMENT-OUTER', mainCategory: 'Garment', name: '外套', description: 'Outerwear / jackets / coats', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-GARMENT-BOTTOM', mainCategory: 'Garment', name: '下装', description: 'Trousers / shorts', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-TRIMMING', mainCategory: 'Trimmings', name: '辅料', description: 'Trimmings / accessories', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-TRIM-ZIPPER', mainCategory: 'Trimmings', name: '拉链', description: 'Zippers', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-TRIM-BUTTON', mainCategory: 'Trimmings', name: '纽扣', description: 'Buttons', updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-SUB-TRIM-LABEL', mainCategory: 'Trimmings', name: '标签织带', description: 'Labels & webbing', updatedAt: BigInt(now), deletedAt: null },
];

// ═══════════════════════════════════════════════════════════════════
// 2. PRODUCT CLASSIFICATIONS
// ═══════════════════════════════════════════════════════════════════
const classifications: ClassificationSeed[] = [
  { id: 'DEMO-CLS-FAB-COTTON', mainCategory: 'Fabric', dimension: 'fiber', name: '棉类', description: 'Cotton-based fabrics', sortOrder: 1, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-FAB-PV', mainCategory: 'Fabric', dimension: 'fiber', name: '涤粘类', description: 'Poly-viscose fabrics', sortOrder: 2, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-FAB-RPET', mainCategory: 'Fabric', dimension: 'fiber', name: '再生涤纶', description: 'Recycled polyester fabrics', sortOrder: 3, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-FAB-NYLON', mainCategory: 'Fabric', dimension: 'fiber', name: '尼龙类', description: 'Nylon-based fabrics', sortOrder: 4, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-FAB-KNIT', mainCategory: 'Fabric', dimension: 'structure', name: '针织', description: 'Knitted structure', sortOrder: 5, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-FAB-WOVEN', mainCategory: 'Fabric', dimension: 'structure', name: '梭织', description: 'Woven structure', sortOrder: 6, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-GAR-MENS', mainCategory: 'Garment', dimension: 'gender', name: '男装', description: 'Menswear', sortOrder: 1, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-GAR-UNISEX', mainCategory: 'Garment', dimension: 'gender', name: '中性', description: 'Unisex', sortOrder: 2, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-TRIM-HARD', mainCategory: 'Trimmings', dimension: 'type', name: '硬辅料', description: 'Hard trimmings (buttons, zippers)', sortOrder: 1, updatedAt: BigInt(now), deletedAt: null },
  { id: 'DEMO-CLS-TRIM-SOFT', mainCategory: 'Trimmings', dimension: 'type', name: '软辅料', description: 'Soft trimmings (labels, webbing)', sortOrder: 2, updatedAt: BigInt(now), deletedAt: null },
];

// ═══════════════════════════════════════════════════════════════════
// 3. RELATIONS (Organizations + Contacts)
// ═══════════════════════════════════════════════════════════════════

// --- Organizations ---
const organizations: RelationSeed[] = [
  // ─── Customers ───
  {
    id: 'DEMO-CUST-ATLAS',
    name: 'Atlas Outfitters Ltd.',
    category: 'Customer', type: 'Customer', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    // P1-001 归属三键：L2 业务口径（followedBy）依赖 ownerId/salesRepIds
    ownerId: 'usr_demo_sales_a', salesRepIds: ['usr_demo_sales_a'], departmentId: 'dept-sales',
    tags: [DEMO_TAG, 'customer', 'usa', 'menswear'],
    contactInfo: 'orders@atlas-outfitters.example | +1 212 555 0188',
    rating: 4.6, lastInteraction: BigInt(now), deletedAt: null,
    preferences: '偏好稳定交期和可追溯认证；常规付款 T/T 30 days。',
    chineseName: '阿特拉斯户外服饰', englishName: 'Atlas Outfitters Ltd.',
    creditLevel: 'A-', summary: '美国男装与户外休闲品牌，采购弹力棉、尼龙棉混纺和功能针织面料。',
    primaryContactName: 'Emily Carter', primaryContactEmail: 'emily.carter@atlas-outfitters.example', primaryContactPhone: '+1 212 555 0188',
    backupContacts: [
      { name: 'Mark Evans', role: 'Sourcing Manager', email: 'mark.evans@atlas-outfitters.example', phone: '+1 212 555 0191' },
      { name: 'Sarah Kim', role: 'QA Coordinator', email: 'sarah.kim@atlas-outfitters.example', phone: '+1 212 555 0195' },
    ],
    shipToAddresses: [
      { label: 'NJ Warehouse', contactName: 'Atlas Receiving', address: '1200 Meadowlands Pkwy, Secaucus, NJ 07094, USA', phone: '+1 201 555 0144' },
      { label: 'LA 3PL', contactName: 'West Coast DC', address: '6880 Alameda St, Los Angeles, CA 90001, USA', phone: '+1 323 555 0122' },
    ],
    financialNotes: 'DEMO: 信用额度 USD 250,000；逾期超过 7 天需暂停新订单。',
    website: 'https://atlas-outfitters.example',
    paymentTerms: 'T/T 30 days after shipment', paymentPreference: 'T/T', currency: 'USD',
    taxId: 'DEMO-US-ATLAS-001', creditLimit: 250000,
    officialAddress: '450 Seventh Avenue, New York, NY 10123, USA',
    factoryAddresses: [], warehouseAddress: '1200 Meadowlands Pkwy, Secaucus, NJ 07094, USA',
    billingAddress: '450 Seventh Avenue, New York, NY 10123, USA',
    shippingAddress: '1200 Meadowlands Pkwy, Secaucus, NJ 07094, USA',
    coordinatesLat: 40.757, coordinatesLng: -73.988,
    email: 'orders@atlas-outfitters.example', phone: '+1 212 555 0188',
    mobile: null, wechat: null, whatsapp: '+1 212 555 0188',
    otherContacts: [], birthday: null, language: 'English', timezone: 'America/New_York', personalNote: null,
  },
  {
    id: 'DEMO-CUST-NORDEN',
    name: 'Norden Studio AB',
    category: 'Customer', type: 'Customer', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    // P1-001 归属三键：归 sales.b（与 sales.a 隔离，可验证业务员互不可见）
    ownerId: 'usr_demo_sales_b', salesRepIds: ['usr_demo_sales_b'], departmentId: 'dept-sales',
    tags: [DEMO_TAG, 'customer', 'sweden', 'premium-casual'],
    contactInfo: 'sourcing@norden-studio.example | +46 8 555 0100',
    rating: 4.3, lastInteraction: BigInt(now - 86400000), deletedAt: null,
    preferences: '重视环保认证和批次稳定性，要求 OEKO-TEX 或 GRS 文件齐全。',
    chineseName: '诺登设计工作室', englishName: 'Norden Studio AB',
    creditLevel: 'B+', summary: '北欧高端休闲服装品牌，采购毛感针织、再生涤纶和混纺面料。',
    primaryContactName: 'Linnea Holm', primaryContactEmail: 'linnea.holm@norden-studio.example', primaryContactPhone: '+46 8 555 0100',
    backupContacts: [
      { name: 'Oskar Nilsson', role: 'Production Coordinator', email: 'oskar.nilsson@norden-studio.example', phone: '+46 8 555 0105' },
      { name: 'Erik Lund', role: 'Design Director', email: 'erik.lund@norden-studio.example', phone: '+46 8 555 0108' },
    ],
    shipToAddresses: [
      { label: 'Gothenburg DC', contactName: 'Norden DC', address: 'Industrivagen 18, 417 07 Gothenburg, Sweden', phone: '+46 31 555 0133' },
    ],
    financialNotes: 'DEMO: 新客户，首三单建议控制信用额度并跟踪回款。',
    website: 'https://norden-studio.example',
    paymentTerms: '30% deposit, 70% before shipment', paymentPreference: 'T/T', currency: 'USD',
    taxId: 'DEMO-SE-NORDEN-002', creditLimit: 120000,
    officialAddress: 'Birger Jarlsgatan 22, 114 34 Stockholm, Sweden',
    factoryAddresses: [], warehouseAddress: 'Industrivagen 18, 417 07 Gothenburg, Sweden',
    billingAddress: 'Birger Jarlsgatan 22, 114 34 Stockholm, Sweden',
    shippingAddress: 'Industrivagen 18, 417 07 Gothenburg, Sweden',
    coordinatesLat: 59.334, coordinatesLng: 18.064,
    email: 'sourcing@norden-studio.example', phone: '+46 8 555 0100',
    mobile: null, wechat: null, whatsapp: '+46 8 555 0100',
    otherContacts: [], birthday: null, language: 'English / Swedish', timezone: 'Europe/Stockholm', personalNote: null,
  },
  {
    id: 'DEMO-CUST-PEERLESS',
    name: 'Peerless Clothing International',
    category: 'Customer', type: 'Customer', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    // P1-001 归属三键：归 sales.a（剧本 C 催款主角；开屏默认选中即本人有权客户）
    ownerId: 'usr_demo_sales_a', salesRepIds: ['usr_demo_sales_a'], departmentId: 'dept-sales',
    tags: [DEMO_TAG, 'customer', 'canada', 'menswear', 'suiting'],
    contactInfo: 'purchasing@peerless-clothing.example | +1 514 555 0200',
    rating: 4.8, lastInteraction: BigInt(now - 3600000), deletedAt: null,
    preferences: '核心客户，羊毛面料为主，要求 RWS 认证、缸差控制严，付款稳定。',
    chineseName: 'Peerless 国际服饰', englishName: 'Peerless Clothing International',
    creditLevel: 'A+', summary: '加拿大最大男装制造商之一，采购精纺羊毛、弹力面料和成衣面料。',
    primaryContactName: 'Robert Chen', primaryContactEmail: 'robert.chen@peerless-clothing.example', primaryContactPhone: '+1 514 555 0200',
    backupContacts: [
      { name: 'Jennifer Wong', role: 'VP Merchandising', email: 'jennifer.wong@peerless-clothing.example', phone: '+1 514 555 0203' },
      { name: 'David Park', role: 'Quality Assurance', email: 'david.park@peerless-clothing.example', phone: '+1 514 555 0206' },
      { name: 'Lisa Tremblay', role: 'Logistics Coordinator', email: 'lisa.tremblay@peerless-clothing.example', phone: '+1 514 555 0209' },
    ],
    shipToAddresses: [
      { label: 'Montreal HQ', contactName: 'Peerless Receiving', address: '5555 Rue Saint-Patrick, Montreal, QC H4E 1A2, Canada', phone: '+1 514 555 0250' },
      { label: 'Toronto DC', contactName: 'Peerless Toronto', address: '200 Consumers Rd, North York, ON M2J 4R4, Canada', phone: '+1 416 555 0260' },
    ],
    financialNotes: 'DEMO: 核心客户，信用额度 USD 500,000；付款准时，可优先排产。',
    website: 'https://peerless-clothing.example',
    paymentTerms: 'T/T 45 days after shipment', paymentPreference: 'T/T', currency: 'USD',
    taxId: 'DEMO-CA-PEERLESS-003', creditLimit: 500000,
    officialAddress: '5555 Rue Saint-Patrick, Montreal, QC H4E 1A2, Canada',
    factoryAddresses: [], warehouseAddress: '5555 Rue Saint-Patrick, Montreal, QC H4E 1A2, Canada',
    billingAddress: '5555 Rue Saint-Patrick, Montreal, QC H4E 1A2, Canada',
    shippingAddress: '5555 Rue Saint-Patrick, Montreal, QC H4E 1A2, Canada',
    coordinatesLat: 45.475, coordinatesLng: -73.575,
    email: 'purchasing@peerless-clothing.example', phone: '+1 514 555 0200',
    mobile: null, wechat: null, whatsapp: '+1 514 555 0200',
    otherContacts: [], birthday: null, language: 'English / French', timezone: 'America/Montreal', personalNote: null,
  },

  // ─── Suppliers ───
  {
    id: 'DEMO-MILL-JINHUA',
    name: '金华常青纺织厂',
    category: 'Supplier', type: 'Fabric Mill', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'supplier', 'cotton-stretch', 'zhejiang'],
    contactInfo: 'sales@evergreen-textile.example | +86 579 5555 0101',
    rating: 4.5, lastInteraction: BigInt(now - 2 * 86400000), deletedAt: null,
    preferences: '棉弹力布稳定，染色批差风险低；常用付款月结。',
    chineseName: '金华常青纺织厂', englishName: 'Jinhua Evergreen Textile Mill',
    creditLevel: 'A', summary: '以棉弹力斜纹、府绸、帆布为主的面料供应商，适合男装休闲裤和夹克。',
    primaryContactName: '王敏', primaryContactEmail: 'wangmin@evergreen-textile.example', primaryContactPhone: '+86 579 5555 0101',
    backupContacts: [
      { name: '陈浩', role: 'Lab Dip', phone: '+86 579 5555 0102' },
      { name: '张磊', role: 'Production Manager', phone: '+86 579 5555 0103' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 月结 45 天，开票后付款。',
    website: 'https://evergreen-textile.example',
    paymentTerms: 'Monthly settlement 45 days', paymentPreference: 'Bank Transfer', currency: 'CNY',
    taxId: 'DEMO-CN-JH-003', creditLimit: 800000,
    officialAddress: '浙江省金华市婺城区演示路 88 号',
    factoryAddresses: ['浙江省金华市婺城区演示路 88 号染整园区 3 号楼'],
    warehouseAddress: '浙江省金华市婺城区演示仓库 2 号',
    billingAddress: '浙江省金华市婺城区演示路 88 号',
    shippingAddress: '浙江省金华市婺城区演示仓库 2 号',
    coordinatesLat: 29.079, coordinatesLng: 119.648,
    email: 'sales@evergreen-textile.example', phone: '+86 579 5555 0101',
    mobile: '+86 138 0000 0101', wechat: 'DEMO-JH-MIN', whatsapp: null,
    otherContacts: [], birthday: null, language: 'Chinese', timezone: 'Asia/Shanghai', personalNote: null,
  },
  {
    id: 'DEMO-MILL-SUZHOU',
    name: '苏州蓝河染织',
    category: 'Supplier', type: 'Fabric Mill', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'supplier', 'poly-viscose', 'suzhou'],
    contactInfo: 'service@blueriver-textile.example | +86 512 5555 0202',
    rating: 4.1, lastInteraction: BigInt(now - 3 * 86400000), deletedAt: null,
    preferences: '擅长涤粘混纺和毛感针织，但大货前需确认色牢度测试。',
    chineseName: '苏州蓝河染织', englishName: 'Suzhou BlueRiver Dyeing & Weaving',
    creditLevel: 'B+', summary: '涤粘混纺、毛感针织和再生涤纶面料供应商。',
    primaryContactName: '刘倩', primaryContactEmail: 'liuqian@blueriver-textile.example', primaryContactPhone: '+86 512 5555 0202',
    backupContacts: [
      { name: '赵强', role: 'Production', phone: '+86 512 5555 0203' },
      { name: '吴芳', role: 'QC Manager', phone: '+86 512 5555 0204' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 高峰期排产紧，建议保留 7 天缓冲。',
    website: 'https://blueriver-textile.example',
    paymentTerms: '30% deposit, 70% before delivery', paymentPreference: 'Bank Transfer', currency: 'CNY',
    taxId: 'DEMO-CN-SZ-004', creditLimit: 500000,
    officialAddress: '江苏省苏州市吴江区演示工业园 16 号',
    factoryAddresses: ['江苏省苏州市吴江区演示工业园 16 号'],
    warehouseAddress: '江苏省苏州市吴江区蓝河仓储中心',
    billingAddress: '江苏省苏州市吴江区演示工业园 16 号',
    shippingAddress: '江苏省苏州市吴江区蓝河仓储中心',
    coordinatesLat: 31.159, coordinatesLng: 120.639,
    email: 'service@blueriver-textile.example', phone: '+86 512 5555 0202',
    mobile: '+86 139 0000 0202', wechat: 'DEMO-SZ-BLUE', whatsapp: null,
    otherContacts: [], birthday: null, language: 'Chinese', timezone: 'Asia/Shanghai', personalNote: null,
  },
  {
    id: 'DEMO-MILL-NANTONG',
    name: '南通北星针织',
    category: 'Supplier', type: 'Fabric Mill', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'supplier', 'knit', 'nantong'],
    contactInfo: 'export@northstar-knit.example | +86 513 5555 0303',
    rating: 4.0, lastInteraction: BigInt(now - 4 * 86400000), deletedAt: null,
    preferences: '针织产能稳定，适合秋冬抓毛和罗纹类订单。',
    chineseName: '南通北星针织', englishName: 'Nantong NorthStar Knitting',
    creditLevel: 'B', summary: '针织面料供应商，主营双面布、抓毛布、罗纹和功能针织。',
    primaryContactName: '孙磊', primaryContactEmail: 'sunlei@northstar-knit.example', primaryContactPhone: '+86 513 5555 0303',
    backupContacts: [
      { name: '许芳', role: 'QC', phone: '+86 513 5555 0304' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 需提前锁定纱线，交期约 45-60 天。',
    website: 'https://northstar-knit.example',
    paymentTerms: 'T/T before shipment', paymentPreference: 'Bank Transfer', currency: 'CNY',
    taxId: 'DEMO-CN-NT-005', creditLimit: 350000,
    officialAddress: '江苏省南通市通州区演示针织路 27 号',
    factoryAddresses: ['江苏省南通市通州区演示针织路 27 号'],
    warehouseAddress: '江苏省南通市通州区北星仓库',
    billingAddress: '江苏省南通市通州区演示针织路 27 号',
    shippingAddress: '江苏省南通市通州区北星仓库',
    coordinatesLat: 32.064, coordinatesLng: 120.887,
    email: 'export@northstar-knit.example', phone: '+86 513 5555 0303',
    mobile: '+86 137 0000 0303', wechat: 'DEMO-NT-KNIT', whatsapp: null,
    otherContacts: [], birthday: null, language: 'Chinese', timezone: 'Asia/Shanghai', personalNote: null,
  },
  {
    id: 'DEMO-MILL-SHAOXING',
    name: '绍兴绿环再生纺织',
    category: 'Supplier', type: 'Fabric Mill', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'supplier', 'recycled', 'shaoxing'],
    contactInfo: 'export@greenloop-textile.example | +86 575 5555 0404',
    rating: 4.4, lastInteraction: BigInt(now - 5 * 86400000), deletedAt: null,
    preferences: '再生系列资料齐全，GRS 文件响应快。',
    chineseName: '绍兴绿环再生纺织', englishName: 'Shaoxing GreenLoop Recycled Textiles',
    creditLevel: 'A-', summary: '再生涤纶、环保混纺和功能涂层供应商。',
    primaryContactName: '周婷', primaryContactEmail: 'zhouting@greenloop-textile.example', primaryContactPhone: '+86 575 5555 0404',
    backupContacts: [
      { name: '韩宇', role: 'Certification', phone: '+86 575 5555 0405' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: GRS 文件需随批次归档。',
    website: 'https://greenloop-textile.example',
    paymentTerms: 'T/T 30 days', paymentPreference: 'Bank Transfer', currency: 'CNY',
    taxId: 'DEMO-CN-SX-006', creditLimit: 600000,
    officialAddress: '浙江省绍兴市柯桥区演示大道 56 号',
    factoryAddresses: ['浙江省绍兴市柯桥区演示大道 56 号'],
    warehouseAddress: '浙江省绍兴市柯桥区绿环仓储',
    billingAddress: '浙江省绍兴市柯桥区演示大道 56 号',
    shippingAddress: '浙江省绍兴市柯桥区绿环仓储',
    coordinatesLat: 30.079, coordinatesLng: 120.493,
    email: 'export@greenloop-textile.example', phone: '+86 575 5555 0404',
    mobile: '+86 136 0000 0404', wechat: 'DEMO-SX-GREEN', whatsapp: null,
    otherContacts: [], birthday: null, language: 'Chinese', timezone: 'Asia/Shanghai', personalNote: null,
  },
  {
    id: 'DEMO-MILL-DAESE',
    name: 'DAESE Textile Co., Ltd.',
    category: 'Supplier', type: 'Fabric Mill', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'supplier', 'wool', 'korea'],
    contactInfo: 'export@daese-textile.example | +82 2 555 0500',
    rating: 4.7, lastInteraction: BigInt(now - 86400000), deletedAt: null,
    preferences: '精纺羊毛品质极佳，RWS 认证齐全；交期稳定但价格偏高。',
    chineseName: '大世纺织', englishName: 'DAESE Textile Co., Ltd.',
    creditLevel: 'A', summary: '韩国精纺羊毛面料供应商，品质优异，RWS 认证齐全。',
    primaryContactName: 'Kim Sang-ho', primaryContactEmail: 'kim.sangho@daese-textile.example', primaryContactPhone: '+82 2 555 0500',
    backupContacts: [
      { name: 'Lee Ji-won', role: 'Export Manager', email: 'lee.jiwon@daese-textile.example', phone: '+82 2 555 0501' },
      { name: 'Park Min-su', role: 'Quality Control', email: 'park.minsu@daese-textile.example', phone: '+82 2 555 0502' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 高品质供应商，付款 L/C at sight 或 T/T 30 days。',
    website: 'https://daese-textile.example',
    paymentTerms: 'L/C at sight or T/T 30 days', paymentPreference: 'L/C', currency: 'USD',
    taxId: 'DEMO-KR-DAESE-007', creditLimit: 400000,
    officialAddress: '123 Seocho-daero, Seocho-gu, Seoul, South Korea',
    factoryAddresses: ['456 Icheon-si, Gyeonggi-do, South Korea'],
    warehouseAddress: '456 Icheon-si, Gyeonggi-do, South Korea',
    billingAddress: '123 Seocho-daero, Seocho-gu, Seoul, South Korea',
    shippingAddress: '456 Icheon-si, Gyeonggi-do, South Korea',
    coordinatesLat: 37.497, coordinatesLng: 127.027,
    email: 'export@daese-textile.example', phone: '+82 2 555 0500',
    mobile: null, wechat: null, whatsapp: '+82 2 555 0500',
    otherContacts: [], birthday: null, language: 'Korean / English', timezone: 'Asia/Seoul', personalNote: null,
  },
  {
    id: 'DEMO-TRIM-ZJG-LABEL',
    name: '张家港骏马辅料织标厂',
    category: 'Supplier', type: 'Trimming Supplier', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'supplier', 'trimming', 'label', 'zhangjiagang'],
    contactInfo: 'label@junma-trims.example | +86 512 5555 0808',
    rating: 4.5, lastInteraction: BigInt(now - 2 * 3600000), deletedAt: null,
    preferences: '主供织标、洗标、吊牌和包装辅料；小单响应快，需提前确认色卡和耐洗测试。',
    chineseName: '张家港骏马辅料织标厂', englishName: 'Zhangjiagang Junma Label & Trims Factory',
    creditLevel: 'A-', summary: '张家港辅料供应商，服务 Peerless 与 Atlas 的主唛、洗标和包装辅料项目。',
    primaryContactName: '赵颖', primaryContactEmail: 'zhaoying@junma-trims.example', primaryContactPhone: '+86 512 5555 0808',
    backupContacts: [
      { name: '陆晨', role: 'Sample Room', email: 'luchen@junma-trims.example', phone: '+86 512 5555 0809' },
      { name: '沈洁', role: 'QC', email: 'shenjie@junma-trims.example', phone: '+86 512 5555 0810' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 辅料单价低但 SKU 多，建议按月合并对账。',
    website: 'https://junma-trims.example',
    paymentTerms: 'Monthly settlement 30 days', paymentPreference: 'Bank Transfer', currency: 'CNY',
    taxId: 'DEMO-CN-ZJG-010', creditLimit: 200000,
    officialAddress: '江苏省苏州市张家港市杨舍镇演示工业路 18 号',
    factoryAddresses: ['江苏省苏州市张家港市杨舍镇演示工业路 18 号'],
    warehouseAddress: '江苏省苏州市张家港市杨舍镇骏马辅料仓库',
    billingAddress: '江苏省苏州市张家港市杨舍镇演示工业路 18 号',
    shippingAddress: '江苏省苏州市张家港市杨舍镇骏马辅料仓库',
    coordinatesLat: 31.8756, coordinatesLng: 120.5550,
    email: 'label@junma-trims.example', phone: '+86 512 5555 0808',
    mobile: '+86 138 0000 0808', wechat: 'DEMO-ZJG-JUNMA', whatsapp: null,
    otherContacts: [], birthday: null, language: 'Chinese', timezone: 'Asia/Shanghai', personalNote: null,
  },

  // ─── Agent (贸易代理) ───
  {
    id: 'DEMO-AGENT-PACIFIC',
    name: 'Pacific Trade Agency',
    category: 'Agent', type: 'Trading Agent', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'agent', 'trading', 'hongkong'],
    contactInfo: 'ops@pacific-trade-agency.example | +852 555 0600',
    rating: 4.2, lastInteraction: BigInt(now - 7 * 86400000), deletedAt: null,
    preferences: '代理 Peerless 在中国香港地区的订单协调和物流安排。',
    chineseName: '太平洋贸易代理', englishName: 'Pacific Trade Agency',
    creditLevel: 'B+', summary: '中国香港贸易代理，负责北美客户在中国区的订单协调和物流。',
    primaryContactName: 'Alex Fung', primaryContactEmail: 'alex.fung@pacific-trade-agency.example', primaryContactPhone: '+852 555 0600',
    backupContacts: [
      { name: 'Cathy Lam', role: 'Operations', email: 'cathy.lam@pacific-trade-agency.example', phone: '+852 555 0601' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 代理费 3%，按季结算。',
    website: 'https://pacific-trade-agency.example',
    paymentTerms: 'Quarterly settlement', paymentPreference: 'T/T', currency: 'USD',
    taxId: 'DEMO-HK-PACIFIC-008', creditLimit: null,
    officialAddress: '88 Des Voeux Road Central, Hong Kong, China',
    factoryAddresses: [], warehouseAddress: '88 Des Voeux Road Central, Hong Kong, China',
    billingAddress: '88 Des Voeux Road Central, Hong Kong, China',
    shippingAddress: '88 Des Voeux Road Central, Hong Kong, China',
    coordinatesLat: 22.285, coordinatesLng: 114.158,
    email: 'ops@pacific-trade-agency.example', phone: '+852 555 0600',
    mobile: null, wechat: 'DEMO-PACIFIC-AG', whatsapp: '+852 555 0600',
    otherContacts: [], birthday: null, language: 'English / Chinese', timezone: 'Asia/Hong_Kong', personalNote: null,
  },

  // ─── Freight Forwarder ───
  {
    id: 'DEMO-FWD-GLOBEX',
    name: 'Globex Logistics Co.',
    category: 'Partner', type: 'Freight Forwarder', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'partner', 'freight', 'shanghai'],
    contactInfo: 'booking@globex-logistics.example | +86 21 5555 0700',
    rating: 4.3, lastInteraction: BigInt(now - 10 * 86400000), deletedAt: null,
    preferences: '上海港整箱/拼箱，加拿大/美国/北欧航线均有合约价。',
    chineseName: '环球物流', englishName: 'Globex Logistics Co.',
    creditLevel: 'A-', summary: '上海货代，加拿大/美国/北欧航线合约价，整箱拼箱均可。',
    primaryContactName: '周明', primaryContactEmail: 'zhouming@globex-logistics.example', primaryContactPhone: '+86 21 5555 0700',
    backupContacts: [
      { name: '陈丽', role: 'Booking', email: 'chenli@globex-logistics.example', phone: '+86 21 5555 0701' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 月结 30 天，海运费波动大需按次确认。',
    website: 'https://globex-logistics.example',
    paymentTerms: 'Monthly settlement 30 days', paymentPreference: 'Bank Transfer', currency: 'USD',
    taxId: 'DEMO-CN-GLOBEX-009', creditLimit: null,
    officialAddress: '上海市浦东新区演示货运路 100 号',
    factoryAddresses: [], warehouseAddress: '上海市浦东新区演示货运路 100 号',
    billingAddress: '上海市浦东新区演示货运路 100 号',
    shippingAddress: '上海市浦东新区演示货运路 100 号',
    coordinatesLat: 31.230, coordinatesLng: 121.474,
    email: 'booking@globex-logistics.example', phone: '+86 21 5555 0700',
    mobile: '+86 150 0000 0700', wechat: 'DEMO-GLOBEX', whatsapp: null,
    otherContacts: [], birthday: null, language: 'Chinese / English', timezone: 'Asia/Shanghai', personalNote: null,
  },

  // ─── Yarn Supplier ───
  {
    id: 'DEMO-MILL-HUZHOU-YARN',
    name: '湖州百纤纱线有限公司',
    category: 'Supplier', type: 'Yarn Supplier', isOrganization: true,
    parentId: null, reportsToId: null, role: null, department: null,
    tags: [DEMO_TAG, 'supplier', 'yarn', 'zhejiang'],
    contactInfo: 'sales@baixian-yarn.example | +86 572 5555 0909',
    rating: 4.4, lastInteraction: BigInt(now - 3 * 86400000), deletedAt: null,
    preferences: '主营再生涤纶纱、棉纱和混纺纱；支持小批量定制色。',
    chineseName: '湖州百纤纱线有限公司', englishName: 'Huzhou Baixian Yarn Co., Ltd.',
    creditLevel: 'A', summary: '浙江湖州纱线供应商，提供再生涤纶、棉和混纺纱线。',
    primaryContactName: '钱伟', primaryContactEmail: 'qianwei@baixian-yarn.example', primaryContactPhone: '+86 572 5555 0909',
    backupContacts: [
      { name: '李娜', role: 'Sample Room', email: 'lina@baixian-yarn.example', phone: '+86 572 5555 0910' },
    ],
    shipToAddresses: [],
    financialNotes: 'DEMO: 纱线单价中等，按批号结算。',
    website: 'https://baixian-yarn.example',
    paymentTerms: 'T/T 30 days', paymentPreference: 'Bank Transfer', currency: 'CNY',
    taxId: 'DEMO-CN-HUZHOU-011', creditLimit: 150000,
    officialAddress: '浙江省湖州市吴兴区演示纱线路 88 号',
    factoryAddresses: ['浙江省湖州市吴兴区演示纱线路 88 号'],
    warehouseAddress: '浙江省湖州市吴兴区演示纱线路 88 号',
    billingAddress: '浙江省湖州市吴兴区演示纱线路 88 号',
    shippingAddress: '浙江省湖州市吴兴区演示纱线路 88 号',
    coordinatesLat: 30.872, coordinatesLng: 120.088,
    email: 'sales@baixian-yarn.example', phone: '+86 572 5555 0909',
    mobile: '+86 139 0000 0909', wechat: 'DEMO-BAIXIAN-YARN', whatsapp: null,
    otherContacts: [], birthday: null, language: 'Chinese', timezone: 'Asia/Shanghai', personalNote: null,
  },
];

// --- Contacts (derived from organizations) ---
const contactDefinitions: Array<[string, string, string, string, string, string, string, string?, string?]> = [
  // Atlas contacts
  ['DEMO-CONTACT-ATLAS-EMILY', 'Emily Carter', 'Customer', 'DEMO-CUST-ATLAS', 'Merchandising Director', 'emily.carter@atlas-outfitters.example', '+1 212 555 0188', 'English', 'America/New_York'],
  ['DEMO-CONTACT-ATLAS-MARK', 'Mark Evans', 'Customer', 'DEMO-CUST-ATLAS', 'Sourcing Manager', 'mark.evans@atlas-outfitters.example', '+1 212 555 0191', 'English', 'America/New_York'],
  ['DEMO-CONTACT-ATLAS-SARAH', 'Sarah Kim', 'Customer', 'DEMO-CUST-ATLAS', 'QA Coordinator', 'sarah.kim@atlas-outfitters.example', '+1 212 555 0195', 'English', 'America/New_York'],
  // Norden contacts
  ['DEMO-CONTACT-NORDEN-LINNEA', 'Linnea Holm', 'Customer', 'DEMO-CUST-NORDEN', 'Sourcing Lead', 'linnea.holm@norden-studio.example', '+46 8 555 0100', 'English', 'Europe/Stockholm'],
  ['DEMO-CONTACT-NORDEN-OSKAR', 'Oskar Nilsson', 'Customer', 'DEMO-CUST-NORDEN', 'Production Coordinator', 'oskar.nilsson@norden-studio.example', '+46 8 555 0105', 'English', 'Europe/Stockholm'],
  ['DEMO-CONTACT-NORDEN-ERIK', 'Erik Lund', 'Customer', 'DEMO-CUST-NORDEN', 'Design Director', 'erik.lund@norden-studio.example', '+46 8 555 0108', 'English', 'Europe/Stockholm'],
  // Peerless contacts
  ['DEMO-CONTACT-PEERLESS-ROBERT', 'Robert Chen', 'Customer', 'DEMO-CUST-PEERLESS', 'Purchasing Director', 'robert.chen@peerless-clothing.example', '+1 514 555 0200', 'English/French', 'America/Montreal'],
  ['DEMO-CONTACT-PEERLESS-JENNIFER', 'Jennifer Wong', 'Customer', 'DEMO-CUST-PEERLESS', 'VP Merchandising', 'jennifer.wong@peerless-clothing.example', '+1 514 555 0203', 'English', 'America/Montreal'],
  ['DEMO-CONTACT-PEERLESS-DAVID', 'David Park', 'Customer', 'DEMO-CUST-PEERLESS', 'Quality Assurance', 'david.park@peerless-clothing.example', '+1 514 555 0206', 'English', 'America/Montreal'],
  ['DEMO-CONTACT-PEERLESS-LISA', 'Lisa Tremblay', 'Customer', 'DEMO-CUST-PEERLESS', 'Logistics Coordinator', 'lisa.tremblay@peerless-clothing.example', '+1 514 555 0209', 'French/English', 'America/Montreal'],
  // Zhangjiagang trimming contacts
  ['DEMO-CONTACT-ZJG-ZHAO', '赵颖', 'Supplier', 'DEMO-TRIM-ZJG-LABEL', 'Sales Manager', 'zhaoying@junma-trims.example', '+86 512 5555 0808', 'Chinese', 'Asia/Shanghai'],
  ['DEMO-CONTACT-ZJG-LU', '陆晨', 'Supplier', 'DEMO-TRIM-ZJG-LABEL', 'Sample Room', 'luchen@junma-trims.example', '+86 512 5555 0809', 'Chinese', 'Asia/Shanghai'],
  // Jinhua contacts
  ['DEMO-CONTACT-JINHUA-WANG', '王敏', 'Supplier', 'DEMO-MILL-JINHUA', 'Sales Manager', 'wangmin@evergreen-textile.example', '+86 579 5555 0101', 'Chinese', 'Asia/Shanghai'],
  ['DEMO-CONTACT-JINHUA-CHEN', '陈浩', 'Supplier', 'DEMO-MILL-JINHUA', 'Lab Dip', 'chenhao@evergreen-textile.example', '+86 579 5555 0102', 'Chinese', 'Asia/Shanghai'],
  ['DEMO-CONTACT-JINHUA-ZHANG', '张磊', 'Supplier', 'DEMO-MILL-JINHUA', 'Production Manager', 'zhanglei@evergreen-textile.example', '+86 579 5555 0103', 'Chinese', 'Asia/Shanghai'],
  // Suzhou contacts
  ['DEMO-CONTACT-SUZHOU-LIU', '刘倩', 'Supplier', 'DEMO-MILL-SUZHOU', 'Account Manager', 'liuqian@blueriver-textile.example', '+86 512 5555 0202', 'Chinese', 'Asia/Shanghai'],
  ['DEMO-CONTACT-SUZHOU-ZHAO', '赵强', 'Supplier', 'DEMO-MILL-SUZHOU', 'Production', 'zhaoqiang@blueriver-textile.example', '+86 512 5555 0203', 'Chinese', 'Asia/Shanghai'],
  // Nantong contacts
  ['DEMO-CONTACT-NANTONG-SUN', '孙磊', 'Supplier', 'DEMO-MILL-NANTONG', 'Export Manager', 'sunlei@northstar-knit.example', '+86 513 5555 0303', 'Chinese', 'Asia/Shanghai'],
  ['DEMO-CONTACT-NANTONG-XU', '许芳', 'Supplier', 'DEMO-MILL-NANTONG', 'QC', 'xufang@northstar-knit.example', '+86 513 5555 0304', 'Chinese', 'Asia/Shanghai'],
  // Shaoxing contacts
  ['DEMO-CONTACT-SHAOXING-ZHOU', '周婷', 'Supplier', 'DEMO-MILL-SHAOXING', 'Export Manager', 'zhouting@greenloop-textile.example', '+86 575 5555 0404', 'Chinese', 'Asia/Shanghai'],
  ['DEMO-CONTACT-SHAOXING-HAN', '韩宇', 'Supplier', 'DEMO-MILL-SHAOXING', 'Certification', 'hanyu@greenloop-textile.example', '+86 575 5555 0405', 'Chinese', 'Asia/Shanghai'],
  // DAESE contacts
  ['DEMO-CONTACT-DAESE-KIM', 'Kim Sang-ho', 'Supplier', 'DEMO-MILL-DAESE', 'Sales Director', 'kim.sangho@daese-textile.example', '+82 2 555 0500', 'Korean/English', 'Asia/Seoul'],
  ['DEMO-CONTACT-DAESE-LEE', 'Lee Ji-won', 'Supplier', 'DEMO-MILL-DAESE', 'Export Manager', 'lee.jiwon@daese-textile.example', '+82 2 555 0501', 'Korean/English', 'Asia/Seoul'],
  ['DEMO-CONTACT-DAESE-PARK', 'Park Min-su', 'Supplier', 'DEMO-MILL-DAESE', 'Quality Control', 'park.minsu@daese-textile.example', '+82 2 555 0502', 'Korean/English', 'Asia/Seoul'],
  // Agent contacts
  ['DEMO-CONTACT-PACIFIC-ALEX', 'Alex Fung', 'Agent', 'DEMO-AGENT-PACIFIC', 'Director', 'alex.fung@pacific-trade-agency.example', '+852 555 0600', 'English/Chinese', 'Asia/Hong_Kong'],
  ['DEMO-CONTACT-PACIFIC-CATHY', 'Cathy Lam', 'Agent', 'DEMO-AGENT-PACIFIC', 'Operations', 'cathy.lam@pacific-trade-agency.example', '+852 555 0601', 'English/Chinese', 'Asia/Hong_Kong'],
  // Freight forwarder contacts
  ['DEMO-CONTACT-GLOBEX-ZHOU', '周明', 'Partner', 'DEMO-FWD-GLOBEX', 'Booking Manager', 'zhouming@globex-logistics.example', '+86 21 5555 0700', 'Chinese/English', 'Asia/Shanghai'],
  ['DEMO-CONTACT-GLOBEX-CHEN', '陈丽', 'Partner', 'DEMO-FWD-GLOBEX', 'Booking', 'chenli@globex-logistics.example', '+86 21 5555 0701', 'Chinese', 'Asia/Shanghai'],
  // Huzhou yarn contacts
  ['DEMO-CONTACT-HUZHOU-QIAN', '钱伟', 'Supplier', 'DEMO-MILL-HUZHOU-YARN', 'Sales Manager', 'qianwei@baixian-yarn.example', '+86 572 5555 0909', 'Chinese', 'Asia/Shanghai'],
  ['DEMO-CONTACT-HUZHOU-LI', '李娜', 'Supplier', 'DEMO-MILL-HUZHOU-YARN', 'Sample Room', 'lina@baixian-yarn.example', '+86 572 5555 0910', 'Chinese', 'Asia/Shanghai'],
];

const contactRelations: RelationSeed[] = contactDefinitions.map((c, idx) => ({
  id: c[0], name: `${c[1]}`, category: c[2], type: 'Contact', isOrganization: false,
  parentId: c[3], reportsToId: null, role: c[4], department: c[2] === 'Customer' ? 'Sourcing' : c[2] === 'Agent' ? 'Operations' : 'Sales',
  tags: [DEMO_TAG, 'contact'], contactInfo: `${c[5]} | ${c[6]}`,
  rating: 4, lastInteraction: BigInt(now - idx * 3600000), deletedAt: null,
  preferences: `DEMO contact for ${c[3]}.`,
  chineseName: c[1], englishName: c[1], creditLevel: null,
  summary: `${c[4]}，用于关系智库和订单角色验证。`,
  primaryContactName: null, primaryContactEmail: null, primaryContactPhone: null,
  backupContacts: [], shipToAddresses: [], financialNotes: null,
  website: null, paymentTerms: null, paymentPreference: null, currency: null,
  taxId: null, creditLimit: null, officialAddress: null,
  factoryAddresses: [], warehouseAddress: null, billingAddress: null, shippingAddress: null,
  coordinatesLat: null, coordinatesLng: null,
  email: c[5], phone: c[6], mobile: c[6], wechat: null, whatsapp: c[6],
  otherContacts: [], birthday: null, language: c[7] || 'English', timezone: c[8] || 'UTC',
  personalNote: 'DEMO: 可用于演示联系人归属、联系方式和业务角色。',
}));

const allRelations: RelationSeed[] = [...organizations, ...contactRelations];

// ═══════════════════════════════════════════════════════════════════
// 4. FABRIC PRODUCTS
// ═══════════════════════════════════════════════════════════════════
const fabricProducts: FabricProductSeed[] = [
  makeFabricProduct({
    id: 'DEMO-PROD-COTTON-STRETCH-TWILL',
    sku: 'DEMO-FAB-CST-240-OLIVE',
    name: 'Cotton Stretch Twill 240gsm - Olive',
    millId: 'DEMO-MILL-JINHUA', subCatId: 'DEMO-SUB-WOVEN',
    articleNo: 'DEMO-ART-CST240', millQuality: 'JH-CST-240', millColorCode: 'OLV-536',
    colorDescription: 'Olive Green', construction: '3/1 Twill', yarnCount: '32/2 x 16 + 40D',
    pattern: 'Solid', weightValue: 240, widthValue: 57, leadDays: 35,
    content: [['MCT-DEMO-COTTON', 'C', '棉', 'Cotton', 97], ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 3]],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-CST-OLV-240'], ['DEMO-CUST-PEERLESS', 'PRL-CST-OLV-240']],
    prices: [4.6, 6.2, 8.5, 9.8],
    certs: ['OEKO-TEX Standard 100', 'BCI Cotton'],
    stockStatus: 'Available', stockQuantity: 1800,
    riskNote: '稳定常规品，注意橄榄色不同批次色差需保留缸差样。',
  }),
  makeFabricProduct({
    id: 'DEMO-PROD-COTTON-POPLIN-WHITE',
    sku: 'DEMO-FAB-CPP-115-WHITE',
    name: 'Cotton Poplin 115gsm - Optical White',
    millId: 'DEMO-MILL-JINHUA', subCatId: 'DEMO-SUB-WOVEN',
    articleNo: 'DEMO-ART-CPP115', millQuality: 'JH-CPP-115', millColorCode: 'WHT-001',
    colorDescription: 'Optical White', construction: 'Plain Weave', yarnCount: '60s x 60s',
    pattern: 'Solid', weightValue: 115, widthValue: 58, leadDays: 30,
    content: [['MCT-DEMO-COTTON', 'C', '棉', 'Cotton', 100]],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-POP-WHT-115']],
    prices: [3.25, 4.55, 6.0, 7.2],
    certs: ['OEKO-TEX Standard 100'],
    stockStatus: 'Made-to-order', stockQuantity: 0,
    riskNote: '白色订单需确认白度和缩水率。',
  }),
  makeFabricProduct({
    id: 'DEMO-PROD-POLY-VISCOSE-MELANGE',
    sku: 'DEMO-FAB-PV-310-GREY',
    name: 'Poly Viscose Melange 310gsm - Grey',
    millId: 'DEMO-MILL-SUZHOU', subCatId: 'DEMO-SUB-KNIT',
    articleNo: 'DEMO-ART-PV310', millQuality: 'SZ-PV-310', millColorCode: 'GRY-812',
    colorDescription: 'Heather Grey', construction: 'Double Knit', yarnCount: '40s PV blended',
    pattern: 'Melange', weightValue: 310, widthValue: 60, leadDays: 50,
    content: [['MCT-DEMO-POLYESTER', 'PES', '涤纶', 'Polyester', 65], ['MCT-DEMO-VISCOSE', 'VI', '粘胶', 'Viscose', 32], ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 3]],
    customerCodes: [['DEMO-CUST-NORDEN', 'NRD-PV-GRY-310']],
    prices: [5.1, 7.2, 9.1, 10.8],
    certs: ['OEKO-TEX Standard 100'],
    stockStatus: 'Low Stock', stockQuantity: 420,
    riskNote: '毛感效果好，但需复测起毛起球。',
  }),
  makeFabricProduct({
    id: 'DEMO-PROD-RECYCLED-POLY-RIPSTOP',
    sku: 'DEMO-FAB-RPET-RIP-145-NAVY',
    name: 'Recycled Polyester Ripstop 145gsm - Navy',
    millId: 'DEMO-MILL-SHAOXING', subCatId: 'DEMO-SUB-WOVEN',
    articleNo: 'DEMO-ART-RIP145', millQuality: 'SX-RPET-RIP-145', millColorCode: 'NVY-209',
    colorDescription: 'Deep Navy', construction: 'Ripstop', yarnCount: '75D x 75D',
    pattern: 'Mini grid', weightValue: 145, widthValue: 59, leadDays: 42,
    content: [['MCT-DEMO-REC-POLY', 'RPET', '再生涤纶', 'Recycled Polyester', 100]],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-RIP-NVY-145'], ['DEMO-CUST-PEERLESS', 'PRL-RIP-NVY-145']],
    prices: [3.95, 5.75, 7.2, 8.1],
    certs: ['GRS', 'OEKO-TEX Standard 100'],
    stockStatus: 'Available', stockQuantity: 2600,
    riskNote: 'GRS 批次证书必须随订单归档。',
  }),
  makeFabricProduct({
    id: 'DEMO-PROD-WOOL-LIKE-KNIT',
    sku: 'DEMO-FAB-WLK-360-CAMEL',
    name: 'Wool-like Brushed Knit 360gsm - Camel',
    millId: 'DEMO-MILL-NANTONG', subCatId: 'DEMO-SUB-KNIT',
    articleNo: 'DEMO-ART-WLK360', millQuality: 'NT-WLK-360', millColorCode: 'CML-620',
    colorDescription: 'Camel', construction: 'Brushed double knit', yarnCount: '30s blended yarn',
    pattern: 'Solid brushed', weightValue: 360, widthValue: 62, leadDays: 60,
    content: [['MCT-DEMO-POLYESTER', 'PES', '涤纶', 'Polyester', 70], ['MCT-DEMO-VISCOSE', 'VI', '粘胶', 'Viscose', 20], ['MCT-DEMO-WOOL', 'W', '羊毛', 'Wool', 10]],
    customerCodes: [['DEMO-CUST-NORDEN', 'NRD-WLK-CML-360']],
    prices: [6.8, 9.6, 12.5, 14.2],
    certs: ['OEKO-TEX Standard 100'],
    stockStatus: 'Development', stockQuantity: 0,
    riskNote: '交期长，需提前锁纱；批量前需确认手感样。',
  }),
  makeFabricProduct({
    id: 'DEMO-PROD-NYLON-COTTON-STRETCH',
    sku: 'DEMO-FAB-NC-190-KHAKI',
    name: 'Nylon Cotton Stretch 190gsm - Khaki',
    millId: 'DEMO-MILL-SHAOXING', subCatId: 'DEMO-SUB-WOVEN',
    articleNo: 'DEMO-ART-NC190', millQuality: 'SX-NC-190', millColorCode: 'KHK-408',
    colorDescription: 'Khaki', construction: 'Plain weave stretch', yarnCount: '70D nylon / 40s cotton + 40D',
    pattern: 'Solid', weightValue: 190, widthValue: 57, leadDays: 45,
    content: [['MCT-DEMO-NYLON', 'N', '尼龙', 'Nylon', 52], ['MCT-DEMO-COTTON', 'C', '棉', 'Cotton', 44], ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 4]],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-NC-KHK-190']],
    prices: [5.45, 7.65, 9.4, 10.9],
    certs: ['OEKO-TEX Standard 100', 'PFC-Free Finish'],
    stockStatus: 'At Risk', stockQuantity: 180,
    riskNote: '坯布库存不足，若客户追加需重新排产。',
  }),
  makeFabricProduct({
    id: 'DEMO-PROD-WOOL-WORSTED-CHARCOAL',
    sku: 'DEMO-FAB-WW-280-CHARCOAL',
    name: 'Wool Worsted 280gsm - Charcoal',
    millId: 'DEMO-MILL-DAESE', subCatId: 'DEMO-SUB-WOVEN',
    articleNo: 'DEMO-ART-WW280', millQuality: 'DS-WW-280', millColorCode: 'CHR-710',
    colorDescription: 'Charcoal', construction: '2/2 Twill', yarnCount: '80/2 x 80/2',
    pattern: 'Solid', weightValue: 280, widthValue: 58, leadDays: 55,
    content: [['MCT-DEMO-WOOL', 'W', '羊毛', 'Wool', 97], ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 3]],
    customerCodes: [['DEMO-CUST-PEERLESS', 'PRL-WW-CHR-280']],
    prices: [12.5, 16.8, 22.0, 25.5],
    certs: ['RWS', 'OEKO-TEX Standard 100'],
    stockStatus: 'Available', stockQuantity: 3200,
    riskNote: 'RWS 认证需随批次更新；深色缸差风险中等。',
  }),
  makeFabricProduct({
    id: 'DEMO-PROD-WOOL-STRETCH-NAVY',
    sku: 'DEMO-FAB-WS-250-NAVY',
    name: 'Wool Stretch 250gsm - Navy',
    millId: 'DEMO-MILL-DAESE', subCatId: 'DEMO-SUB-WOVEN',
    articleNo: 'DEMO-ART-WS250', millQuality: 'DS-WS-250', millColorCode: 'NVY-415',
    colorDescription: 'Deep Navy', construction: 'Plain weave stretch', yarnCount: '60/2 x 60/2 + 40D',
    pattern: 'Solid', weightValue: 250, widthValue: 57, leadDays: 50,
    content: [['MCT-DEMO-WOOL', 'W', '羊毛', 'Wool', 96], ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 4]],
    customerCodes: [['DEMO-CUST-PEERLESS', 'PRL-WS-NVY-250'], ['DEMO-CUST-ATLAS', 'ATL-WS-NVY-250']],
    prices: [11.2, 15.0, 19.5, 22.8],
    certs: ['RWS', 'OEKO-TEX Standard 100'],
    stockStatus: 'Available', stockQuantity: 1500,
    riskNote: '弹力回复率需每批测试，适合西裤和休闲裤。',
  }),
];

// ═══════════════════════════════════════════════════════════════════
// 5. GARMENT PRODUCTS
// ═══════════════════════════════════════════════════════════════════
const garmentProducts: GarmentProductSeed[] = [
  {
    asset: {
      id: 'DEMO-PROD-GARMENT-BLAZER', sku: 'DEMO-GAR-BLZ-NAVY-S', name: 'Men\'s Slim Fit Blazer - Navy',
      mainCategory: 'Garment', subCategoryId: 'DEMO-SUB-GARMENT-OUTER', season: 'DEMO-AW26',
      techPackUrl: null, imageUrl: null, cost: 45.0, status: 'Active',
      updatedAt: BigInt(now), deletedAt: null,
    },
    garmentProfile: {
      id: 'DEMO-PROD-GARMENT-BLAZER-PROFILE', productAssetId: 'DEMO-PROD-GARMENT-BLAZER',
      styleNo: 'DEMO-BLZ-001', productName: 'Men Slim Fit Blazer', garmentCategory: 'Blazer',
      collection: 'AW26 Classic', customer: 'Peerless', brand: 'Peerless', project: 'AW26 Suiting',
      gender: 'Male', ageGroup: 'Adult', tags: 'suiting,formal,wool',
      silhouette: 'Slim Fit', fit: 'Regular', collarType: 'Notch Lapel', sleeveType: 'Set-in',
      closureType: '2-button', pocketDetails: 'Flap pockets x2, breast pocket x1',
      hemDetails: 'Curved', waistbandDetails: null, liningStructure: 'Full lining',
      interlining: 'Fusible', shoulderPad: 'Light', stitchDetails: 'Regular stitch',
      constructionNote: 'Fully canvassed front, fused front panel',
      mainFabric: 'Wool Worsted 280gsm Charcoal / Wool Stretch 250gsm Navy',
      contrastFabric: null, liningFabric: 'Acetate lining', ribFabric: null, pocketingFabric: 'Cotton pocketing',
      button: 'Horn button x5', zipper: null, snapsEyelets: null, thread: 'Polyester core-spun',
      labelTrims: 'Main label, care label, size label', packaging: 'Individual polybag + hanger',
      materialUsage: 'Shell 1.6m, Lining 1.4m', substituteMaterials: null,
      sizeRange: '36-48', baseSize: '42', measurementPoints: 'Chest, Shoulder, Sleeve, Length',
      sizeSpec: 'DEMO-BLZ-SPEC-V1', tolerance: '+/- 1cm', gradingRule: 'Standard 2cm increment',
      shrinkageAllowance: '1.5%', garmentWeight: '850g (size 42)',
      colorways: 'Navy, Charcoal', customerColorCodes: 'PRL-NVY, PRL-CHR',
      fabricColorCodes: 'NVY-415, CHR-710', garmentSku: 'DEMO-GAR-BLZ-NAVY-42',
      barcode: 'DEMO-001234567890', availableSizes: '36,38,40,42,44,46,48',
      colorImageNotes: 'Navy main, Charcoal optional',
      moq: '500 pcs/color', sampleVersion: 'V2 - Confirmed', patternMaker: 'Zhang Wei',
      merchandiser: 'Li Ming', owner: 'Kevin Gu', revisionHistory: 'V1: Initial → V2: Lapel adjusted',
      fittingComments: 'Good fit on shoulder, slight adjustment on sleeve length',
      customerComments: 'Approved with minor changes', confirmedDate: '2026-01-25',
      techPackVersion: 'V2.1', factory: 'DEMO-MILL-JINHUA',
      orderQuantity: '1500 pcs', deliveryDate: '2026-04-15',
      targetCost: 'USD 42.00', fobPrice: 'USD 45.00', exwPrice: 'USD 40.00', retailPrice: 'USD 199.00',
      inspectionStandard: 'AQL 2.5', commonDefects: 'Buttonhole, collar symmetry',
      washFinishing: 'Steam press only', careLabel: 'Dry clean only',
      complianceTests: 'Color fastness, dimensional stability',
      packingMethod: '1pc/polybag, 24pcs/carton', cartonSpec: '60x40x35cm',
      countryOfOrigin: 'China', qualityNote: 'DEMO: 标准西服品质要求',
      updatedAt: BigInt(now), deletedAt: null,
    },
    customerCodes: [{ id: 'DEMO-PROD-GARMENT-BLAZER-CC1', productAssetId: 'DEMO-PROD-GARMENT-BLAZER', customerOrganizationId: 'DEMO-CUST-PEERLESS', customerNameSnapshot: 'Peerless Clothing International', clientCode: 'PRL-BLZ-NAVY', note: 'DEMO: Peerless blazer code', updatedAt: BigInt(now), deletedAt: null }],
    prices: [
      { id: 'DEMO-PROD-GARMENT-BLAZER-P1', productAssetId: 'DEMO-PROD-GARMENT-BLAZER', priceType: 'fob', amount: 45.0, currency: 'USD', unit: 'piece', customerOrganizationId: 'DEMO-CUST-PEERLESS', sourceType: 'demo-seed', sourceId: 'DEMO-PROD-GARMENT-BLAZER', effectiveDate: '2026-01-01', note: 'DEMO: FOB Shanghai', updatedAt: BigInt(now), deletedAt: null },
      { id: 'DEMO-PROD-GARMENT-BLAZER-P2', productAssetId: 'DEMO-PROD-GARMENT-BLAZER', priceType: 'exw', amount: 40.0, currency: 'USD', unit: 'piece', customerOrganizationId: null, sourceType: 'demo-seed', sourceId: 'DEMO-PROD-GARMENT-BLAZER', effectiveDate: '2026-01-01', note: 'DEMO: EXW factory', updatedAt: BigInt(now), deletedAt: null },
    ],
  },
  {
    asset: {
      id: 'DEMO-PROD-GARMENT-CHINO', sku: 'DEMO-GAR-CHN-KHK-M', name: 'Men\'s Stretch Chino Trouser - Khaki',
      mainCategory: 'Garment', subCategoryId: 'DEMO-SUB-GARMENT-BOTTOM', season: 'DEMO-AW26',
      techPackUrl: null, imageUrl: null, cost: 22.0, status: 'Active',
      updatedAt: BigInt(now), deletedAt: null,
    },
    garmentProfile: {
      id: 'DEMO-PROD-GARMENT-CHINO-PROFILE', productAssetId: 'DEMO-PROD-GARMENT-CHINO',
      styleNo: 'DEMO-CHN-002', productName: 'Men Stretch Chino', garmentCategory: 'Trouser',
      collection: 'AW26 Casual', customer: 'Atlas', brand: 'Atlas', project: 'AW26 Casual Pants',
      gender: 'Male', ageGroup: 'Adult', tags: 'casual,chino,stretch',
      silhouette: 'Straight', fit: 'Regular', collarType: null, sleeveType: null,
      closureType: 'Zip fly + button', pocketDetails: 'Slant pockets x2, back welt pockets x2',
      hemDetails: 'Plain', waistbandDetails: 'Curved waistband with belt loops',
      liningStructure: 'Half lining', interlining: 'Waistband interlining', shoulderPad: null,
      stitchDetails: 'Topstitch 1/8"', constructionNote: 'Standard chino construction',
      mainFabric: 'Cotton Stretch Twill 240gsm / Nylon Cotton Stretch 190gsm',
      contrastFabric: null, liningFabric: null, ribFabric: null, pocketingFabric: 'Cotton pocketing',
      button: 'Coconut button x1', zipper: 'YKK #5 brass', snapsEyelets: null, thread: 'Poly core-spun',
      labelTrims: 'Main label, care label, size label', packaging: 'Individual polybag',
      materialUsage: 'Shell 1.3m', substituteMaterials: null,
      sizeRange: '30-40', baseSize: '33', measurementPoints: 'Waist, Hip, Inseam, Thigh',
      sizeSpec: 'DEMO-CHN-SPEC-V1', tolerance: '+/- 1cm', gradingRule: 'Standard 2cm waist increment',
      shrinkageAllowance: '2%', garmentWeight: '450g (size 33)',
      colorways: 'Khaki, Olive, Navy', customerColorCodes: 'ATL-KHK, ATL-OLV, ATL-NVY',
      fabricColorCodes: 'KHK-408, OLV-536, NVY-415', garmentSku: 'DEMO-GAR-CHN-KHK-33',
      barcode: 'DEMO-001234567891', availableSizes: '30,31,32,33,34,36,38,40',
      colorImageNotes: 'Khaki main',
      moq: '800 pcs/color', sampleVersion: 'V1 - Confirmed', patternMaker: 'Wang Jun',
      merchandiser: 'Li Ming', owner: 'Kevin Gu', revisionHistory: 'V1: Initial approved',
      fittingComments: 'Good fit, approved first sample',
      customerComments: 'Approved as is', confirmedDate: '2026-01-20',
      techPackVersion: 'V1.0', factory: 'DEMO-MILL-JINHUA',
      orderQuantity: '3000 pcs', deliveryDate: '2026-03-20',
      targetCost: 'USD 20.00', fobPrice: 'USD 22.00', exwPrice: 'USD 19.50', retailPrice: 'USD 89.00',
      inspectionStandard: 'AQL 2.5', commonDefects: 'Belt loop, fly alignment',
      washFinishing: 'Garment wash', careLabel: 'Machine wash cold',
      complianceTests: 'Color fastness, shrinkage test',
      packingMethod: '1pc/polybag, 30pcs/carton', cartonSpec: '60x40x30cm',
      countryOfOrigin: 'China', qualityNote: 'DEMO: 标准休闲裤品质',
      updatedAt: BigInt(now), deletedAt: null,
    },
    customerCodes: [{ id: 'DEMO-PROD-GARMENT-CHINO-CC1', productAssetId: 'DEMO-PROD-GARMENT-CHINO', customerOrganizationId: 'DEMO-CUST-ATLAS', customerNameSnapshot: 'Atlas Outfitters Ltd.', clientCode: 'ATL-CHN-KHK', note: 'DEMO: Atlas chino code', updatedAt: BigInt(now), deletedAt: null }],
    prices: [
      { id: 'DEMO-PROD-GARMENT-CHINO-P1', productAssetId: 'DEMO-PROD-GARMENT-CHINO', priceType: 'fob', amount: 22.0, currency: 'USD', unit: 'piece', customerOrganizationId: 'DEMO-CUST-ATLAS', sourceType: 'demo-seed', sourceId: 'DEMO-PROD-GARMENT-CHINO', effectiveDate: '2026-01-01', note: 'DEMO: FOB Shanghai', updatedAt: BigInt(now), deletedAt: null },
    ],
  },
  {
    asset: {
      id: 'DEMO-PROD-GARMENT-JACKET', sku: 'DEMO-GAR-JKT-NAVY-M', name: 'Men\'s Lightweight Bomber Jacket - Navy',
      mainCategory: 'Garment', subCategoryId: 'DEMO-SUB-GARMENT-OUTER', season: 'DEMO-AW26',
      techPackUrl: null, imageUrl: null, cost: 38.0, status: 'Development',
      updatedAt: BigInt(now), deletedAt: null,
    },
    garmentProfile: {
      id: 'DEMO-PROD-GARMENT-JACKET-PROFILE', productAssetId: 'DEMO-PROD-GARMENT-JACKET',
      styleNo: 'DEMO-JKT-003', productName: 'Men Lightweight Bomber', garmentCategory: 'Jacket',
      collection: 'AW26 Outerwear', customer: 'Norden', brand: 'Norden', project: 'AW26 Outerwear Capsule',
      gender: 'Male', ageGroup: 'Adult', tags: 'outerwear,bomber,lightweight',
      silhouette: 'Boxy', fit: 'Oversized', collarType: 'Rib stand collar', sleeveType: 'Raglan',
      closureType: 'Zip front', pocketDetails: 'Slanted welt pockets x2, interior pocket x1',
      hemDetails: 'Rib hem', waistbandDetails: 'Rib waistband',
      liningStructure: 'Full lining', interlining: null, shoulderPad: null,
      stitchDetails: 'Binding on seams', constructionNote: 'Lightweight bomber, un-padded',
      mainFabric: 'Recycled Polyester Ripstop 145gsm',
      contrastFabric: null, liningFabric: 'Mesh lining', ribFabric: 'Cotton rib', pocketingFabric: null,
      button: null, zipper: 'YKK #5 nylon 2-way', snapsEyelets: null, thread: 'Poly core-spun',
      labelTrims: 'Main label, care label, flag label', packaging: 'Individual polybag + tissue',
      materialUsage: 'Shell 1.8m, Lining 1.6m', substituteMaterials: null,
      sizeRange: 'S-XXL', baseSize: 'L', measurementPoints: 'Chest, Shoulder, Sleeve, Length',
      sizeSpec: 'DEMO-JKT-SPEC-V1', tolerance: '+/- 1.5cm', gradingRule: 'Standard increment',
      shrinkageAllowance: '1%', garmentWeight: '580g (size L)',
      colorways: 'Navy, Black', customerColorCodes: 'NRD-NVY, NRD-BLK',
      fabricColorCodes: 'NVY-209', garmentSku: 'DEMO-GAR-JKT-NAVY-L',
      barcode: 'DEMO-001234567892', availableSizes: 'S,M,L,XL,XXL',
      colorImageNotes: 'Navy main, Black optional',
      moq: '600 pcs/color', sampleVersion: 'V1 - In review', patternMaker: 'TBD',
      merchandiser: 'Li Ming', owner: 'Kevin Gu', revisionHistory: 'V1: Initial sample pending',
      fittingComments: 'Pending fitting',
      customerComments: 'Awaiting sample', confirmedDate: null,
      techPackVersion: 'V0.9', factory: null,
      orderQuantity: null, deliveryDate: '2026-05-01',
      targetCost: 'USD 35.00', fobPrice: 'USD 38.00', exwPrice: null, retailPrice: 'USD 159.00',
      inspectionStandard: 'AQL 2.5', commonDefects: 'Zipper alignment, rib attachment',
      washFinishing: 'No wash', careLabel: 'Do not wash, wipe clean',
      complianceTests: 'Color fastness, water resistance',
      packingMethod: '1pc/polybag, 20pcs/carton', cartonSpec: '65x45x40cm',
      countryOfOrigin: 'China', qualityNote: 'DEMO: 开发中',
      updatedAt: BigInt(now), deletedAt: null,
    },
    customerCodes: [{ id: 'DEMO-PROD-GARMENT-JACKET-CC1', productAssetId: 'DEMO-PROD-GARMENT-JACKET', customerOrganizationId: 'DEMO-CUST-NORDEN', customerNameSnapshot: 'Norden Studio AB', clientCode: 'NRD-JKT-NVY', note: 'DEMO: Norden jacket code', updatedAt: BigInt(now), deletedAt: null }],
    prices: [
      { id: 'DEMO-PROD-GARMENT-JACKET-P1', productAssetId: 'DEMO-PROD-GARMENT-JACKET', priceType: 'fob', amount: 38.0, currency: 'USD', unit: 'piece', customerOrganizationId: 'DEMO-CUST-NORDEN', sourceType: 'demo-seed', sourceId: 'DEMO-PROD-GARMENT-JACKET', effectiveDate: '2026-01-01', note: 'DEMO: FOB Shanghai (est.)', updatedAt: BigInt(now), deletedAt: null },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════
// 6. TRIMMING PRODUCTS
// ═══════════════════════════════════════════════════════════════════
const trimmingProducts: TrimmingProductSeed[] = [
  {
    asset: {
      id: 'DEMO-PROD-TRIM-ZIPPER-YKK5', sku: 'DEMO-TRM-ZIP-YKK5-BRASS', name: 'YKK #5 Brass Zipper',
      mainCategory: 'Trimmings', subCategoryId: 'DEMO-SUB-TRIM-ZIPPER', season: 'DEMO-AW26',
      techPackUrl: null, imageUrl: null, cost: 1.2, status: 'Active',
      updatedAt: BigInt(now), deletedAt: null,
    },
    trimmingProfile: {
      id: 'DEMO-PROD-TRIM-ZIPPER-YKK5-PROFILE', productAssetId: 'DEMO-PROD-TRIM-ZIPPER-YKK5',
      trimmingCode: 'DEMO-ZIP-YKK5', trimmingName: 'YKK #5 Brass Zipper', trimmingCategory: 'Zipper',
      material: 'Brass', specification: '#5 closed-end', size: '18cm, 20cm, 22cm',
      color: 'Brass/Gold', colorCode: 'BR-001', finish: 'Polished',
      supplier: 'YKK', factory: null, brand: 'YKK', customer: null,
      applicableProducts: 'Chino trousers, jackets', usagePosition: 'Fly, front opening',
      unit: 'piece', unitConsumption: '1 per garment', moq: '500 pcs', leadTime: '15 days',
      stockStatus: 'Available', stockQuantity: 5000, stockUnit: 'piece',
      price: '1.20', currency: 'USD', complianceTests: 'Nickel-free test',
      qualityStandard: 'YKK standard', riskNote: null,
      packaging: '100pcs/bag', careRequirement: null,
      notes: 'DEMO: Standard brass zipper for chinos and jackets.',
      updatedAt: BigInt(now), deletedAt: null,
    },
    prices: [
      { id: 'DEMO-PROD-TRIM-ZIPPER-YKK5-P1', productAssetId: 'DEMO-PROD-TRIM-ZIPPER-YKK5', priceType: 'cost', amount: 1.2, currency: 'USD', unit: 'piece', customerOrganizationId: null, sourceType: 'demo-seed', sourceId: 'DEMO-PROD-TRIM-ZIPPER-YKK5', effectiveDate: '2026-01-01', note: 'DEMO: YKK standard pricing', updatedAt: BigInt(now), deletedAt: null },
    ],
  },
  {
    asset: {
      id: 'DEMO-PROD-TRIM-BUTTON-HORN', sku: 'DEMO-TRM-BTN-HORN-22MM', name: 'Natural Horn Button 22mm',
      mainCategory: 'Trimmings', subCategoryId: 'DEMO-SUB-TRIM-BUTTON', season: 'DEMO-AW26',
      techPackUrl: null, imageUrl: null, cost: 0.35, status: 'Active',
      updatedAt: BigInt(now), deletedAt: null,
    },
    trimmingProfile: {
      id: 'DEMO-PROD-TRIM-BUTTON-HORN-PROFILE', productAssetId: 'DEMO-PROD-TRIM-BUTTON-HORN',
      trimmingCode: 'DEMO-BTN-HORN22', trimmingName: 'Natural Horn Button 22mm', trimmingCategory: 'Button',
      material: 'Natural horn', specification: '4-hole, 22mm', size: '22mm',
      color: 'Natural/Tortoise', colorCode: 'HORN-NT', finish: 'Polished',
      supplier: 'Guangzhou Button Co.', factory: null, brand: null, customer: null,
      applicableProducts: 'Blazers, suits, coats', usagePosition: 'Front closure, sleeve button',
      unit: 'piece', unitConsumption: '5 per blazer', moq: '2000 pcs', leadTime: '20 days',
      stockStatus: 'Available', stockQuantity: 8000, stockUnit: 'piece',
      price: '0.35', currency: 'USD', complianceTests: 'No restricted substances',
      qualityStandard: 'Industry standard', riskNote: 'Natural material, color variation expected',
      packaging: '1000pcs/bag', careRequirement: 'Dry clean only',
      notes: 'DEMO: Horn button for Peerless blazer program.',
      updatedAt: BigInt(now), deletedAt: null,
    },
    prices: [
      { id: 'DEMO-PROD-TRIM-BUTTON-HORN-P1', productAssetId: 'DEMO-PROD-TRIM-BUTTON-HORN', priceType: 'cost', amount: 0.35, currency: 'USD', unit: 'piece', customerOrganizationId: null, sourceType: 'demo-seed', sourceId: 'DEMO-PROD-TRIM-BUTTON-HORN', effectiveDate: '2026-01-01', note: 'DEMO: Standard pricing', updatedAt: BigInt(now), deletedAt: null },
    ],
  },
  {
    asset: {
      id: 'DEMO-PROD-TRIM-LABEL-MAIN', sku: 'DEMO-TRM-LBL-MAIN-WOVEN', name: 'Woven Main Label',
      mainCategory: 'Trimmings', subCategoryId: 'DEMO-SUB-TRIM-LABEL', season: 'DEMO-AW26',
      techPackUrl: null, imageUrl: null, cost: 0.08, status: 'Active',
      updatedAt: BigInt(now), deletedAt: null,
    },
    trimmingProfile: {
      id: 'DEMO-PROD-TRIM-LABEL-MAIN-PROFILE', productAssetId: 'DEMO-PROD-TRIM-LABEL-MAIN',
      trimmingCode: 'DEMO-LBL-MAIN', trimmingName: 'Woven Main Label', trimmingCategory: 'Label',
      material: 'Polyester woven', specification: '3x6cm, center fold', size: '3x6cm',
      color: 'Black/Gold', colorCode: 'BK-GD', finish: 'Ultrasonic cut',
      supplier: 'Zhangjiagang Label Factory', factory: null, brand: null, customer: null,
      applicableProducts: 'All garments', usagePosition: 'Back neck',
      unit: 'piece', unitConsumption: '1 per garment', moq: '5000 pcs', leadTime: '10 days',
      stockStatus: 'Available', stockQuantity: 20000, stockUnit: 'piece',
      price: '0.08', currency: 'USD', complianceTests: 'OEKO-TEX',
      qualityStandard: 'Industry standard', riskNote: null,
      packaging: '5000pcs/bag', careRequirement: null,
      notes: 'DEMO: Standard main label for all programs.',
      updatedAt: BigInt(now), deletedAt: null,
    },
    prices: [
      { id: 'DEMO-PROD-TRIM-LABEL-MAIN-P1', productAssetId: 'DEMO-PROD-TRIM-LABEL-MAIN', priceType: 'cost', amount: 0.08, currency: 'USD', unit: 'piece', customerOrganizationId: null, sourceType: 'demo-seed', sourceId: 'DEMO-PROD-TRIM-LABEL-MAIN', effectiveDate: '2026-01-01', note: 'DEMO: Label pricing', updatedAt: BigInt(now), deletedAt: null },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════
// 7. ORDERS
// ═══════════════════════════════════════════════════════════════════
const orders: OrderSeed[] = [
  makeOrder({
    id: 'DEMO-PO-2601001', customerId: 'DEMO-CUST-ATLAS', customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas', product: 'Cotton Stretch Twill seasonal program', status: 'Production',
    poDate: '2026-01-08', dueDate: '2026-03-05', millId: 'DEMO-MILL-JINHUA',
    millName: '金华常青纺织厂', consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.', amount: 38850, purchasePrice: 4.6,
    lines: [
      ['001', 'DEMO-FAB-CST-240-OLIVE', 'JH-CST-240', 'Cotton Stretch Twill Olive', '57/58"', 4200, 6.2, '2026-02-22', '2026-03-05'],
      ['002', 'DEMO-FAB-CPP-115-WHITE', 'JH-CPP-115', 'Cotton Poplin Optical White', '58"', 2800, 4.55, '2026-02-20', '2026-03-03'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601002', customerId: 'DEMO-CUST-NORDEN', customer: 'Norden Studio AB',
    customerCode: 'norden', product: 'Wool-like knit capsule collection', status: 'Pending',
    poDate: '2026-01-12', dueDate: '2026-04-10', millId: 'DEMO-MILL-NANTONG',
    millName: '南通北星针织', consignee: 'Norden Gothenburg DC',
    billTo: 'Norden Studio AB', amount: 42000, purchasePrice: 6.8,
    lines: [
      ['001', 'DEMO-FAB-WLK-360-CAMEL', 'NT-WLK-360', 'Wool-like Brushed Knit Camel', '62"', 2500, 9.6, '2026-03-28', '2026-04-10'],
      ['002', 'DEMO-FAB-PV-310-GREY', 'SZ-PV-310', 'Poly Viscose Melange Grey', '60"', 1800, 7.2, '2026-03-20', '2026-04-05'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601003', customerId: 'DEMO-CUST-ATLAS', customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas', product: 'Recycled ripstop outerwear program', status: 'Shipping',
    poDate: '2026-01-15', dueDate: '2026-03-01', millId: 'DEMO-MILL-SHAOXING',
    millName: '绍兴绿环再生纺织', consignee: 'Atlas LA 3PL',
    billTo: 'Atlas Outfitters Ltd.', amount: 29900, purchasePrice: 3.95,
    lines: [
      ['001', 'DEMO-FAB-RPET-RIP-145-NAVY', 'SX-RPET-RIP-145', 'Recycled Polyester Ripstop Navy', '59/60"', 5200, 5.75, '2026-02-18', '2026-03-01'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601004', customerId: 'DEMO-CUST-NORDEN', customer: 'Norden Studio AB',
    customerCode: 'norden', product: 'Premium melange fabric repeat', status: 'Delivered',
    poDate: '2025-12-20', dueDate: '2026-02-15', millId: 'DEMO-MILL-SUZHOU',
    millName: '苏州蓝河染织', consignee: 'Norden Gothenburg DC',
    billTo: 'Norden Studio AB', amount: 21600, purchasePrice: 5.1,
    lines: [
      ['001', 'DEMO-FAB-PV-310-GREY', 'SZ-PV-310', 'Poly Viscose Melange Grey', '60"', 3000, 7.2, '2026-02-02', '2026-02-15'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601005', customerId: 'DEMO-CUST-ATLAS', customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas', product: 'Nylon cotton stretch urgent order', status: 'Alert',
    poDate: '2026-01-18', dueDate: '2026-02-25', millId: 'DEMO-MILL-SHAOXING',
    millName: '绍兴绿环再生纺织', consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.', amount: 22950, purchasePrice: 5.45,
    lines: [
      ['001', 'DEMO-FAB-NC-190-KHAKI', 'SX-NC-190', 'Nylon Cotton Stretch Khaki', '57/58"', 3000, 7.65, '2026-02-20', '2026-02-25'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601006', customerId: 'DEMO-CUST-ATLAS', customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas', product: 'Cotton program balance shipment', status: 'Pending',
    poDate: '2026-01-22', dueDate: '2026-03-18', millId: 'DEMO-MILL-JINHUA',
    millName: '金华常青纺织厂', consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.', amount: 25575, purchasePrice: 3.25,
    lines: [
      ['001', 'DEMO-FAB-CPP-115-WHITE', 'JH-CPP-115', 'Cotton Poplin Optical White', '58"', 4500, 4.55, '2026-03-07', '2026-03-18'],
      ['002', 'DEMO-FAB-CST-240-OLIVE', 'JH-CST-240', 'Cotton Stretch Twill Olive', '57/58"', 800, 6.2, '2026-03-06', '2026-03-18'],
    ],
  }),
  // ─── Peerless orders ───
  makeOrder({
    id: 'DEMO-PO-2601007', customerId: 'DEMO-CUST-PEERLESS', customer: 'Peerless Clothing International',
    customerCode: 'peerless', product: 'Wool worsted suiting program', status: 'Production',
    poDate: '2026-01-10', dueDate: '2026-03-20', millId: 'DEMO-MILL-DAESE',
    millName: 'DAESE Textile Co., Ltd.', consignee: 'Peerless Montreal HQ',
    billTo: 'Peerless Clothing International', amount: 84000, purchasePrice: 12.5,
    lines: [
      ['001', 'DEMO-FAB-WW-280-CHARCOAL', 'DS-WW-280', 'Wool Worsted 280gsm Charcoal', '58"', 3000, 16.8, '2026-03-10', '2026-03-20'],
      ['002', 'DEMO-FAB-WS-250-NAVY', 'DS-WS-250', 'Wool Stretch 250gsm Navy', '57"', 2000, 15.0, '2026-03-08', '2026-03-18'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601008', customerId: 'DEMO-CUST-PEERLESS', customer: 'Peerless Clothing International',
    customerCode: 'peerless', product: 'Wool stretch trouser program', status: 'Pending',
    poDate: '2026-01-25', dueDate: '2026-04-15', millId: 'DEMO-MILL-DAESE',
    millName: 'DAESE Textile Co., Ltd.', consignee: 'Peerless Toronto DC',
    billTo: 'Peerless Clothing International', amount: 60000, purchasePrice: 11.2,
    lines: [
      ['001', 'DEMO-FAB-WS-250-NAVY', 'DS-WS-250', 'Wool Stretch 250gsm Navy', '57"', 4000, 15.0, '2026-04-05', '2026-04-15'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601009', customerId: 'DEMO-CUST-PEERLESS', customer: 'Peerless Clothing International',
    customerCode: 'peerless', product: 'Blazer garment order (成衣)', status: 'Pending',
    poDate: '2026-01-28', dueDate: '2026-04-20', millId: 'DEMO-MILL-JINHUA',
    millName: '金华常青纺织厂', consignee: 'Peerless Montreal HQ',
    billTo: 'Peerless Clothing International', amount: 67500, purchasePrice: 40.0,
    lines: [
      ['001', 'DEMO-GAR-BLZ-NAVY-S', 'DEMO-BLZ-001', 'Men Slim Fit Blazer Navy', 'N/A', 1500, 45.0, '2026-04-10', '2026-04-20'],
    ],
  }),
  // ─── More Atlas orders ───
  makeOrder({
    id: 'DEMO-PO-2601010', customerId: 'DEMO-CUST-ATLAS', customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas', product: 'Chino trouser garment order (成衣)', status: 'Production',
    poDate: '2026-02-01', dueDate: '2026-04-01', millId: 'DEMO-MILL-JINHUA',
    millName: '金华常青纺织厂', consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.', amount: 66000, purchasePrice: 19.5,
    lines: [
      ['001', 'DEMO-GAR-CHN-KHK-M', 'DEMO-CHN-002', 'Men Stretch Chino Khaki', 'N/A', 3000, 22.0, '2026-03-22', '2026-04-01'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601011', customerId: 'DEMO-CUST-PEERLESS', customer: 'Peerless Clothing International',
    customerCode: 'peerless', product: 'Woven main label replenishment', status: 'Production',
    poDate: '2026-02-04', dueDate: '2026-03-12', millId: 'DEMO-TRIM-ZJG-LABEL',
    millName: '张家港骏马辅料织标厂', consignee: 'Peerless Montreal HQ',
    billTo: 'Peerless Clothing International', amount: 5600, purchasePrice: 0.08,
    lines: [
      ['001', 'DEMO-TRM-LBL-MAIN', 'DEMO-LBL-MAIN', 'Peerless woven main label black/gold', '3x6cm', 70000, 0.08, '2026-03-05', '2026-03-12'],
    ],
  }),

  // ─── Other: Yarn Orders (纱线) ───
  makeOrder({
    id: 'DEMO-PO-2601012', customerId: 'DEMO-CUST-NORDEN', customer: 'Norden Studio AB',
    customerCode: 'norden', product: '再生涤纶纱补货 (纱线)', status: 'Production',
    poDate: '2026-02-10', dueDate: '2026-03-20', millId: 'DEMO-MILL-HUZHOU-YARN',
    millName: '湖州百纤纱线有限公司', consignee: 'Norden Gothenburg DC',
    billTo: 'Norden Studio AB', amount: 18400, purchasePrice: 8.5,
    lines: [
      ['001', 'DEMO-YRN-RPET-300-NVY', 'BT-RPET-300', '再生涤纶 300D Navy 纱', '300D', 2400, 7.67, '2026-03-10', '2026-03-20'],
      ['002', 'DEMO-YRN-RPET-300-KHK', 'BT-RPET-301', '再生涤纶 300D Khaki 纱', '300D', 1200, 7.80, '2026-03-10', '2026-03-20'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601013', customerId: 'DEMO-CUST-ATLAS', customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas', product: '弹力棉纱紧急订单 (纱线)', status: 'Pending',
    poDate: '2026-02-15', dueDate: '2026-03-15', millId: 'DEMO-MILL-HUZHOU-YARN',
    millName: '湖州百纤纱线有限公司', consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.', amount: 12600, purchasePrice: 9.2,
    lines: [
      ['001', 'DEMO-YRN-CTX-40S-OLV', 'BT-CTX-40S', '精梳棉 40s Olive 纱', '40s', 1400, 9.00, '2026-03-05', '2026-03-15'],
    ],
  }),

  // ─── Other: Accessories Orders (辅料) ───
  makeOrder({
    id: 'DEMO-PO-2601014', customerId: 'DEMO-CUST-PEERLESS', customer: 'Peerless Clothing International',
    customerCode: 'peerless', product: '西装纽扣批量订单 (辅料)', status: 'Production',
    poDate: '2026-02-08', dueDate: '2026-03-18', millId: 'DEMO-TRIM-ZJG-LABEL',
    millName: '张家港骏马辅料织标厂', consignee: 'Peerless Montreal HQ',
    billTo: 'Peerless Clothing International', amount: 4200, purchasePrice: 0.35,
    lines: [
      ['001', 'DEMO-OTH-BTN-NAVY-18L', 'DEMO-BTN-18L', 'Navy 18L 树脂扣 4孔', '18L', 24000, 0.18, '2026-03-10', '2026-03-18'],
      ['002', 'DEMO-OTH-BTN-GOLD-20L', 'DEMO-BTN-20L', 'Gold 20L 金属扣', '20L', 8000, 0.60, '2026-03-10', '2026-03-18'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601015', customerId: 'DEMO-CUST-NORDEN', customer: 'Norden Studio AB',
    customerCode: 'norden', product: '拉链 + 织带补货 (辅料)', status: 'Pending',
    poDate: '2026-02-12', dueDate: '2026-03-25', millId: 'DEMO-TRIM-ZJG-LABEL',
    millName: '张家港骏马辅料织标厂', consignee: 'Norden Gothenburg DC',
    billTo: 'Norden Studio AB', amount: 7800, purchasePrice: 0.42,
    lines: [
      ['001', 'DEMO-OTH-ZIP-8C-NAVY', 'DEMO-ZIP-8C', 'YKK 8号树脂拉链 Navy', '8C', 6000, 0.55, '2026-03-15', '2026-03-25'],
      ['002', 'DEMO-OTH-WEB-25MM-GREY', 'DEMO-WEB-25MM', '25mm 尼龙织带 Grey', '25mm', 3000, 0.20, '2026-03-15', '2026-03-25'],
    ],
  }),
];

// ═══════════════════════════════════════════════════════════════════
// 8. ENTITY LINKS
// ═══════════════════════════════════════════════════════════════════
const entityLinks: EntityLinkSeed[] = [
  // Orders → Customer relations
  ...orders.map((o, idx) => ({
    id: `DEMO-LINK-ORD-CUST-${idx + 1}`,
    fromType: 'order', fromId: o.order.id, fromPath: 'customer',
    toType: 'relation.organization', toId: o.order.customerRelationId!,
    linkKind: 'customer', confidence: 1.0, metadata: { source: DEMO_SOURCE },
    source: DEMO_SOURCE, status: 'active',
    createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
  })),
  // Orders → Mill relations
  ...orders.map((o, idx) => ({
    id: `DEMO-LINK-ORD-MILL-${idx + 1}`,
    fromType: 'order', fromId: o.order.id, fromPath: 'mill',
    toType: 'relation.organization', toId: o.order.millRelationId!,
    linkKind: 'supplier', confidence: 1.0, metadata: { source: DEMO_SOURCE },
    source: DEMO_SOURCE, status: 'active',
    createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
  })),
  // Order lines → Products
  ...orders.flatMap((o, oIdx) =>
    o.lines.map((line, lIdx) => ({
      id: `DEMO-LINK-ORDLN-PROD-${oIdx + 1}-${lIdx + 1}`,
      fromType: 'orderLine', fromId: line.id, fromPath: 'materialCode',
      toType: 'productAsset', toId: line.materialCode!.startsWith('DEMO-GAR-')
        ? 'DEMO-PROD-GARMENT-BLAZER'
        : line.materialCode!.startsWith('DEMO-TRM-')
          ? 'DEMO-PROD-TRIM-LABEL-MAIN'
          : line.materialCode?.replace('DEMO-FAB-', 'DEMO-PROD-').replace(/-[A-Z]+-\d+-.+$/, '') || '',
      linkKind: 'material', confidence: 0.95, metadata: { source: DEMO_SOURCE, matchedBy: 'sku' },
      source: DEMO_SOURCE, status: 'active',
      createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
    }))
  ),
  // Products → Mill (supplier)
  ...fabricProducts.map((p, idx) => ({
    id: `DEMO-LINK-PROD-MILL-${idx + 1}`,
    fromType: 'productAsset', fromId: p.asset.id, fromPath: 'fabricProfile.millOrganizationId',
    toType: 'relation.organization', toId: p.fabricProfile.millOrganizationId!,
    linkKind: 'supplier', confidence: 1.0, metadata: { source: DEMO_SOURCE },
    source: DEMO_SOURCE, status: 'active',
    createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
  })),
  // Contacts → Organizations
  ...contactRelations.map((c, idx) => ({
    id: `DEMO-LINK-CONTACT-ORG-${idx + 1}`,
    fromType: 'relation.contact', fromId: c.id, fromPath: 'parentId',
    toType: 'relation.organization', toId: c.parentId!,
    linkKind: 'belongs_to', confidence: 1.0, metadata: { source: DEMO_SOURCE },
    source: DEMO_SOURCE, status: 'active',
    createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
  })),
];

// ═══════════════════════════════════════════════════════════════════
// 9. DEVELOPMENT CASES
// ═══════════════════════════════════════════════════════════════════
const developmentCases: DevelopmentCaseSeed[] = [
  {
    id: 'DEMO-DEV-26001', code: 'DEV-2026-NRD-WLK-001',
    name: 'Norden 毛感针织开发 - Camel色',
    type: 'fabric', stage: 'feedback', priority: 'high',
    owner: 'Kevin Gu',
    customerRelationId: 'DEMO-CUST-NORDEN', customerName: 'Norden Studio AB',
    supplierRelationId: 'DEMO-MILL-NANTONG', supplierName: '南通北星针织',
    productAssetId: 'DEMO-PROD-WOOL-LIKE-KNIT', productName: 'Wool-like Brushed Knit 360gsm - Camel',
    currentRound: 1,
    nextAction: '等待 Norden 对手感样的反馈',
    targetDate: '2026-03-15',
    completedDate: null,
    sampleType: 'yardage', sampleQuantity: 50, sampleUnit: 'meter',
    sampleSentDate: '2026-02-20', sampleTrackingNumber: 'DEMO-DEV-26001-SAMPLE',
    sampleCourier: 'DHL', sampleShippingFee: 68.5,
    sampleRecipientName: 'Emma Lindqvist', sampleRecipientCompany: 'Norden Studio AB',
    sampleRecipientAddress: 'Sveavagen 44, Stockholm, Sweden', sampleRecipientPhone: '+46 70 555 0142',
    sampleFeedback: null, sampleFeedbackDate: null,
    linkedOrderId: null, linkedOrderPo: null, convertedAt: null,
    notes: 'DEMO: 北欧高端休闲品牌首次毛感针织合作，需重点关注手感样反馈。',
    tags: ['DEMO', 'fabric', 'wool-like', 'norden'],
    attachments: null,
    createdAt: BigInt(now - 20 * 86400000), updatedAt: BigInt(now - 2 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-DEV-26002', code: 'DEV-2026-ATL-JKT-001',
    name: 'Atlas 轻薄 bomber 开发 - Navy',
    type: 'garment', stage: 'revision', priority: 'normal',
    owner: 'Li Ming',
    customerRelationId: 'DEMO-CUST-ATLAS', customerName: 'Atlas Outfitters Ltd.',
    supplierRelationId: 'DEMO-MILL-SHAOXING', supplierName: '绍兴绿环再生纺织',
    productAssetId: 'DEMO-PROD-GARMENT-JACKET', productName: 'Men\'s Lightweight Bomber Jacket - Navy',
    currentRound: 2,
    nextAction: '根据 Atlas 反馈调整罗纹密度和拉链规格',
    targetDate: '2026-04-01',
    completedDate: null,
    sampleType: 'fit-sample', sampleQuantity: 2, sampleUnit: 'piece',
    sampleSentDate: '2026-02-25', sampleTrackingNumber: 'DEMO-DEV-26002-SAMPLE',
    sampleCourier: 'FedEx', sampleShippingFee: 52.0,
    sampleRecipientName: 'Sarah Chen', sampleRecipientCompany: 'Atlas Outfitters Ltd.',
    sampleRecipientAddress: '2400 NW Front Ave, Portland, OR, USA', sampleRecipientPhone: '+1 503 555 0187',
    sampleFeedback: '罗纹密度偏松，拉链颜色略浅，请调整后重新寄样。',
    sampleFeedbackDate: '2026-03-05',
    linkedOrderId: null, linkedOrderPo: null, convertedAt: null,
    notes: 'DEMO: 开发中，Round 2 修版。',
    tags: ['DEMO', 'garment', 'bomber', 'atlas'],
    attachments: null,
    createdAt: BigInt(now - 30 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-DEV-26003', code: 'DEV-2026-PRL-BLZ-001',
    name: 'Peerless 西服版开发 - PP样',
    type: 'pp', stage: 'approved', priority: 'urgent',
    owner: 'Kevin Gu',
    customerRelationId: 'DEMO-CUST-PEERLESS', customerName: 'Peerless Clothing International',
    supplierRelationId: 'DEMO-MILL-JINHUA', supplierName: '金华常青纺织厂',
    productAssetId: 'DEMO-PROD-GARMENT-BLAZER', productName: 'Men\'s Slim Fit Blazer - Navy',
    currentRound: 3,
    nextAction: 'PP 样已确认，等待客户正式下单',
    targetDate: '2026-02-28',
    completedDate: '2026-02-28',
    sampleType: 'pp-sample', sampleQuantity: 5, sampleUnit: 'piece',
    sampleSentDate: '2026-02-10', sampleTrackingNumber: 'DEMO-DEV-26003-SAMPLE',
    sampleCourier: 'UPS', sampleShippingFee: 45.8,
    sampleRecipientName: 'Michael Ross', sampleRecipientCompany: 'Peerless Clothing International',
    sampleRecipientAddress: '500 7th Ave, New York, NY, USA', sampleRecipientPhone: '+1 212 555 0119',
    sampleFeedback: '版型 approved，可进入大货。',
    sampleFeedbackDate: '2026-02-28',
    linkedOrderId: 'DEMO-PO-2601009', linkedOrderPo: 'DEMO-PO-2601009',
    convertedAt: BigInt(now - 10 * 86400000),
    notes: 'DEMO: PP 样已批准，已转为大货订单 DEMO-PO-2601009。',
    tags: ['DEMO', 'garment', 'blazer', 'pp-approved', 'peerless'],
    attachments: null,
    createdAt: BigInt(now - 60 * 86400000), updatedAt: BigInt(now - 10 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-DEV-26004', code: 'DEV-2026-NRD-PV-002',
    name: 'Norden PV 混纺复购开发 - Grey',
    type: 'fabric', stage: 'developing', priority: 'normal',
    owner: 'Kevin Gu',
    customerRelationId: 'DEMO-CUST-NORDEN', customerName: 'Norden Studio AB',
    supplierRelationId: 'DEMO-MILL-SUZHOU', supplierName: '苏州蓝河染织',
    productAssetId: 'DEMO-PROD-POLY-VISCOSE-MELANGE', productName: 'Poly Viscose Melange 310gsm - Grey',
    currentRound: 1,
    nextAction: '等待苏州蓝河实验室调色出 Lab Dip',
    targetDate: '2026-04-20',
    completedDate: null,
    sampleType: 'lab-dip', sampleQuantity: 10, sampleUnit: 'piece',
    sampleSentDate: '2026-03-10', sampleTrackingNumber: 'DEMO-DEV-26004-SAMPLE',
    sampleCourier: 'DHL', sampleShippingFee: 61.2,
    sampleRecipientName: 'Emma Lindqvist', sampleRecipientCompany: 'Norden Studio AB',
    sampleRecipientAddress: 'Sveavagen 44, Stockholm, Sweden', sampleRecipientPhone: '+46 70 555 0142',
    sampleFeedback: null, sampleFeedbackDate: null,
    linkedOrderId: null, linkedOrderPo: null, convertedAt: null,
    notes: 'DEMO: Norden 复购订单，优先锁定纱线和交期。',
    tags: ['DEMO', 'fabric', 'pv-melange', 'norden', 'repeat'],
    attachments: null,
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-DEV-26005', code: 'DEV-2026-ATL-NC-001',
    name: 'Atlas NC 弹力布风险评估',
    type: 'fabric', stage: 'shipping', priority: 'high',
    owner: 'Li Ming',
    customerRelationId: 'DEMO-CUST-ATLAS', customerName: 'Atlas Outfitters Ltd.',
    supplierRelationId: 'DEMO-MILL-SHAOXING', supplierName: '绍兴绿环再生纺织',
    productAssetId: 'DEMO-PROD-NYLON-COTTON-STRETCH', productName: 'Nylon Cotton Stretch 190gsm - Khaki',
    currentRound: 1,
    nextAction: '与绍兴确认坯布库存和补货时间',
    targetDate: '2026-03-01',
    completedDate: null,
    sampleType: 'yardage', sampleQuantity: 30, sampleUnit: 'meter',
    sampleSentDate: '2026-02-01', sampleTrackingNumber: 'DEMO-DEV-26005-SAMPLE',
    sampleCourier: 'DHL', sampleShippingFee: 73.9,
    sampleRecipientName: 'Sarah Chen', sampleRecipientCompany: 'Atlas Outfitters Ltd.',
    sampleRecipientAddress: '2400 NW Front Ave, Portland, OR, USA', sampleRecipientPhone: '+1 503 555 0187',
    sampleFeedback: '样品手感合格，大货坯布库存告急。',
    sampleFeedbackDate: '2026-02-20',
    linkedOrderId: 'DEMO-PO-2601005', linkedOrderPo: 'DEMO-PO-2601005',
    convertedAt: null,
    notes: 'DEMO: 高风险面料，坯布库存仅 180m，关联 Alert 订单 DEMO-PO-2601005。',
    tags: ['DEMO', 'fabric', 'at-risk', 'nc-stretch', 'atlas'],
    attachments: null,
    createdAt: BigInt(now - 25 * 86400000), updatedAt: BigInt(now - 3 * 86400000), deletedAt: null,
  },
];

// ═══════════════════════════════════════════════════════════════════
// 10. INVOICES
// ═══════════════════════════════════════════════════════════════════
const invoices: InvoiceSeed[] = [
  // ─── Receivable (Atlas — 已发货) ───
  {
    id: 'DEMO-INV-001', invoiceNumber: 'INV-2026-ATL-0301',
    type: 'Receivable', status: 'Paid',
    amount: 29900.0000, currency: 'USD',
    issueDate: '2026-02-28', dueDate: '2026-03-30',
    exchangeRate: 7.2500, baseCurrency: 'CNY',
    orderId: 'DEMO-PO-2601003',
    customerRelationId: 'DEMO-CUST-ATLAS',
    customerName: 'Atlas Outfitters Ltd.',
    notes: 'DEMO: Atlas 再生涤纶 RIPSTOP 出口发票，已结清。',
    attachments: null,
    createdAt: BigInt(now - 15 * 86400000), updatedAt: BigInt(now - 5 * 86400000), deletedAt: null,
  },
  // ─── Receivable (Norden — 已结清) ───
  {
    id: 'DEMO-INV-002', invoiceNumber: 'INV-2026-NRD-0215',
    type: 'Receivable', status: 'Paid',
    amount: 21600.0000, currency: 'USD',
    issueDate: '2026-02-20', dueDate: '2026-03-22',
    exchangeRate: 7.2300, baseCurrency: 'CNY',
    orderId: 'DEMO-PO-2601004',
    customerRelationId: 'DEMO-CUST-NORDEN',
    customerName: 'Norden Studio AB',
    notes: 'DEMO: Norden PV 混纺复购面料发票，已结清。',
    attachments: null,
    createdAt: BigInt(now - 30 * 86400000), updatedAt: BigInt(now - 12 * 86400000), deletedAt: null,
  },
  // ─── Receivable (Peerless — 部分销账) ───
  {
    id: 'DEMO-INV-003', invoiceNumber: 'INV-2026-PRL-0320',
    type: 'Receivable', status: 'PartiallyPaid',
    amount: 84000.0000, currency: 'USD',
    issueDate: '2026-03-15', dueDate: '2026-04-30',
    exchangeRate: 7.2500, baseCurrency: 'CNY',
    orderId: 'DEMO-PO-2601007',
    customerRelationId: 'DEMO-CUST-PEERLESS',
    customerName: 'Peerless Clothing International',
    notes: 'DEMO: Peerless 精纺羊毛西服面料大货发票，部分付款 USD 50,000，余款 34,000。',
    attachments: null,
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 2 * 86400000), deletedAt: null,
  },
  // ─── Receivable (Atlas — 开票中) ───
  {
    id: 'DEMO-INV-004', invoiceNumber: 'INV-2026-ATL-0318',
    type: 'Receivable', status: 'Issued',
    amount: 38850.0000, currency: 'USD',
    issueDate: '2026-03-10', dueDate: '2026-04-10',
    exchangeRate: 7.2500, baseCurrency: 'CNY',
    orderId: 'DEMO-PO-2601001',
    customerRelationId: 'DEMO-CUST-ATLAS',
    customerName: 'Atlas Outfitters Ltd.',
    notes: 'DEMO: Atlas 棉弹力面料生产中发票，已开票待付款。',
    attachments: null,
    createdAt: BigInt(now - 3 * 86400000), updatedAt: BigInt(now - 3 * 86400000), deletedAt: null,
  },
  // ─── Payable (金华工厂 — 羊毛面料) ───
  {
    id: 'DEMO-INV-005', invoiceNumber: 'INV-2026-JH-0310',
    type: 'Payable', status: 'Issued',
    amount: 93750.0000, currency: 'CNY',
    issueDate: '2026-03-10', dueDate: '2026-04-25',
    exchangeRate: null, baseCurrency: 'CNY',
    orderId: 'DEMO-PO-2601007',
    customerRelationId: 'DEMO-MILL-DAESE',
    customerName: 'DAESE Textile Co., Ltd.',
    notes: 'DEMO: DAESE 精纺羊毛面料应付发票，WOOL WORSTED 3000m + WOOL STRETCH 2000m。',
    attachments: null,
    createdAt: BigInt(now - 4 * 86400000), updatedAt: BigInt(now - 4 * 86400000), deletedAt: null,
  },
  // ─── Payable (苏州蓝河 — PV面料) ───
  {
    id: 'DEMO-INV-006', invoiceNumber: 'INV-2026-SZ-0215',
    type: 'Payable', status: 'Paid',
    amount: 41040.0000, currency: 'CNY',
    issueDate: '2026-02-15', dueDate: '2026-03-30',
    exchangeRate: null, baseCurrency: 'CNY',
    orderId: 'DEMO-PO-2601004',
    customerRelationId: 'DEMO-MILL-SUZHOU',
    customerName: '苏州蓝河染织',
    notes: 'DEMO: 苏州蓝河 PV 混纺面料应付发票，已结清。',
    attachments: null,
    createdAt: BigInt(now - 35 * 86400000), updatedAt: BigInt(now - 10 * 86400000), deletedAt: null,
  },
];

// ═══════════════════════════════════════════════════════════════════
// 11. PAYMENT VOUCHERS
// ═══════════════════════════════════════════════════════════════════
const paymentVouchers: PaymentVoucherSeed[] = [
  // ─── Receipt: Atlas 回款 ───
  {
    id: 'DEMO-PAY-001', voucherNumber: 'PAY-2026-ATL-0320',
    type: 'Receipt', amount: 29900.0000, currency: 'USD',
    paymentDate: '2026-03-20', paymentMethod: 'TT',
    status: 'reconciled', // DR-045：status 由 InvoiceAllocation 真源推导（全额核销 → reconciled）
    bankFee: 45.0000,
    exchangeRate: 7.2500, baseCurrency: 'CNY',
    invoiceId: 'DEMO-INV-001', appliedAmount: 29900.0000,
    orderId: 'DEMO-PO-2601003',
    customerRelationId: 'DEMO-CUST-ATLAS',
    customerName: 'Atlas Outfitters Ltd.',
    notes: 'DEMO: Atlas 货款，INV-2026-ATL-0301 全额回款，扣除手续费后净额 29855 USD。',
    attachments: null,
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 5 * 86400000), deletedAt: null,
  },
  // ─── Receipt: Norden 回款 ───
  {
    id: 'DEMO-PAY-002', voucherNumber: 'PAY-2026-NRD-0228',
    type: 'Receipt', amount: 21600.0000, currency: 'USD',
    paymentDate: '2026-02-28', paymentMethod: 'TT',
    status: 'reconciled', // DR-045：status 由 InvoiceAllocation 真源推导（全额核销 → reconciled）
    bankFee: 35.0000,
    // P1-006（DR-046 汇率快照口径）：收款日汇率低于开票日（INV-002 7.23）→
    // 汇兑损失 21600 × (7.21 − 7.23) = −432 CNY，为 C5 报表提供可演示损益记录
    exchangeRate: 7.2100, baseCurrency: 'CNY',
    invoiceId: 'DEMO-INV-002', appliedAmount: 21600.0000,
    orderId: 'DEMO-PO-2601004',
    customerRelationId: 'DEMO-CUST-NORDEN',
    customerName: 'Norden Studio AB',
    notes: 'DEMO: Norden 货款，INV-2026-NRD-0215 全额回款，净额 21565 USD。',
    attachments: null,
    createdAt: BigInt(now - 12 * 86400000), updatedAt: BigInt(now - 12 * 86400000), deletedAt: null,
  },
  // ─── Receipt: Peerless 部分回款 ───
  {
    id: 'DEMO-PAY-003', voucherNumber: 'PAY-2026-PRL-0330',
    type: 'Receipt', amount: 50000.0000, currency: 'USD',
    paymentDate: '2026-03-30', paymentMethod: 'TT',
    status: 'reconciled', // DR-045：status 由 InvoiceAllocation 真源推导（凭证全额核销给 INV-003 → reconciled）
    bankFee: 80.0000,
    exchangeRate: 7.2500, baseCurrency: 'CNY',
    invoiceId: 'DEMO-INV-003', appliedAmount: 50000.0000,
    orderId: 'DEMO-PO-2601007',
    customerRelationId: 'DEMO-CUST-PEERLESS',
    customerName: 'Peerless Clothing International',
    notes: 'DEMO: Peerless 首批付款 USD 50,000，INV-2026-PRL-0320 部分核销，余款 34,000 挂账。',
    attachments: null,
    createdAt: BigInt(now - 2 * 86400000), updatedAt: BigInt(now - 2 * 86400000), deletedAt: null,
  },
  // ─── Disbursement: 付款 DAESE ───
  {
    id: 'DEMO-PAY-004', voucherNumber: 'PAY-2026-DAESE-0405',
    type: 'Disbursement', amount: 93750.0000, currency: 'CNY',
    paymentDate: '2026-04-05', paymentMethod: 'TT',
    status: 'reconciled', // DR-045：status 由 InvoiceAllocation 真源推导（全额核销 → reconciled）
    bankFee: 200.0000,
    exchangeRate: null, baseCurrency: 'CNY',
    invoiceId: 'DEMO-INV-005', appliedAmount: 93750.0000,
    orderId: 'DEMO-PO-2601007',
    customerRelationId: 'DEMO-MILL-DAESE',
    customerName: 'DAESE Textile Co., Ltd.',
    notes: 'DEMO: DAESE 羊毛面料货款，INV-2026-JH-0310 全额支付，扣除手续费后净额 93550 CNY。',
    attachments: null,
    createdAt: BigInt(now - 1 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
];

// ═══════════════════════════════════════════════════════════════════
// 11b. INVOICE ALLOCATIONS — 核销明细（DR-045：核销唯一真源）
// ═══════════════════════════════════════════════════════════════════
// P1-004/005/006 根因修复：核销事实必须落 InvoiceAllocation 分配表，
// 发票/凭证 status 与 appliedAmount 快照均由该表派生；只写快照不写
// 明细 = 脏数据（账龄全额虚高 / 待收统计虚高 / 汇率损益报表恒空）。
// id 格式与 applyAllocation 运行时一致：ALLOC__${invoiceId}__${voucherId}
const invoiceAllocations: InvoiceAllocationSeed[] = [
  { // Atlas 全额核销 INV-001
    id: 'ALLOC__DEMO-INV-001__DEMO-PAY-001',
    invoiceId: 'DEMO-INV-001', voucherId: 'DEMO-PAY-001',
    appliedAmount: 29900.0000, appliedDate: '2026-03-20',
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 5 * 86400000),
  },
  { // Norden 全额核销 INV-002
    id: 'ALLOC__DEMO-INV-002__DEMO-PAY-002',
    invoiceId: 'DEMO-INV-002', voucherId: 'DEMO-PAY-002',
    appliedAmount: 21600.0000, appliedDate: '2026-02-28',
    createdAt: BigInt(now - 12 * 86400000), updatedAt: BigInt(now - 12 * 86400000),
  },
  { // Peerless 部分核销 INV-003（$84,000 收 $50,000，余 $34,000 挂账）
    id: 'ALLOC__DEMO-INV-003__DEMO-PAY-003',
    invoiceId: 'DEMO-INV-003', voucherId: 'DEMO-PAY-003',
    appliedAmount: 50000.0000, appliedDate: '2026-03-30',
    createdAt: BigInt(now - 2 * 86400000), updatedAt: BigInt(now - 2 * 86400000),
  },
  { // DAESE 应付全额核销 INV-005
    id: 'ALLOC__DEMO-INV-005__DEMO-PAY-004',
    invoiceId: 'DEMO-INV-005', voucherId: 'DEMO-PAY-004',
    appliedAmount: 93750.0000, appliedDate: '2026-04-05',
    createdAt: BigInt(now - 1 * 86400000), updatedAt: BigInt(now - 1 * 86400000),
  },
];

// ═══════════════════════════════════════════════════════════════════
// 11c. FACTORY PROFILES — 供应商工厂档案（P1-002 修复）
// ═══════════════════════════════════════════════════════════════════
// 根因：供应商身份真源在 Relation(category=Supplier)（schema 注释），但
// 供应商管理页 /api/v1/suppliers 查 FactoryProfile 1:1 挂接表——seed 只建
// Relation 未建档案 → 开屏恒 0 家工厂。此处为 7 家供应商组织（isOrganization）
// 补建档案；联系人个人（type=Contact，parentId 挂组织）不是工厂，不建档案。
// 评分缓存 = relation.rating（5 分制）×20 折百分制；交期分模拟略低（真实感）。
const factoryProfiles: FactoryProfileSeed[] = [
  { // 金华常青纺织厂 — 棉弹力机织
    id: 'FACP__DEMO-MILL-JINHUA', relationId: 'DEMO-MILL-JINHUA',
    monthlyCapacity: 500000.0000, capacityUnit: 'M', workerCount: 260,
    specialties: ['棉弹力斜纹', '府绸', '帆布'],
    qualityScore: 90, deliveryScore: 87, priceLevel: 'Mid',
    firstOrderAt: '2025-03-15', totalOrders: 6, totalAmount: 2380000.0000,
    bankName: '中国工商银行金华婺城支行', bankAccount: 'DEMO-CN-JH-003',
    notes: 'DEMO: 棉弹力布稳定，染色批差风险低。',
    createdAt: BigInt(now - 180 * 86400000), updatedAt: BigInt(now - 2 * 86400000), deletedAt: null,
  },
  { // 苏州蓝河染织 — 涤粘混纺/针织染整
    id: 'FACP__DEMO-MILL-SUZHOU', relationId: 'DEMO-MILL-SUZHOU',
    monthlyCapacity: 450000.0000, capacityUnit: 'M', workerCount: 190,
    specialties: ['涤粘混纺', '毛感针织', '再生涤纶'],
    qualityScore: 82, deliveryScore: 78, priceLevel: 'Mid',
    firstOrderAt: '2025-06-20', totalOrders: 4, totalAmount: 1650000.0000,
    bankName: '中国银行苏州吴江支行', bankAccount: 'DEMO-CN-SZ-004',
    notes: 'DEMO: 高峰期排产紧，建议保留 7 天缓冲。',
    createdAt: BigInt(now - 150 * 86400000), updatedAt: BigInt(now - 3 * 86400000), deletedAt: null,
  },
  { // 南通北星针织 — 针织面料
    id: 'FACP__DEMO-MILL-NANTONG', relationId: 'DEMO-MILL-NANTONG',
    monthlyCapacity: 380000.0000, capacityUnit: 'M', workerCount: 140,
    specialties: ['双面布', '抓毛布', '罗纹', '功能针织'],
    qualityScore: 80, deliveryScore: 81, priceLevel: 'Low',
    firstOrderAt: '2025-09-02', totalOrders: 3, totalAmount: 920000.0000,
    bankName: '中国建设银行南通通州支行', bankAccount: 'DEMO-CN-NT-005',
    notes: 'DEMO: 需提前锁定纱线，交期约 45-60 天。',
    createdAt: BigInt(now - 120 * 86400000), updatedAt: BigInt(now - 4 * 86400000), deletedAt: null,
  },
  { // 绍兴绿环再生纺织 — 再生环保面料（GRS）
    id: 'FACP__DEMO-MILL-SHAOXING', relationId: 'DEMO-MILL-SHAOXING',
    monthlyCapacity: 420000.0000, capacityUnit: 'M', workerCount: 210,
    specialties: ['再生涤纶', '环保混纺', '功能涂层'],
    qualityScore: 88, deliveryScore: 85, priceLevel: 'Mid',
    firstOrderAt: '2025-04-10', totalOrders: 5, totalAmount: 1870000.0000,
    bankName: '招商银行绍兴柯桥支行', bankAccount: 'DEMO-CN-SX-006',
    notes: 'DEMO: 再生系列资料齐全，GRS 文件响应快，随批次归档。',
    createdAt: BigInt(now - 160 * 86400000), updatedAt: BigInt(now - 5 * 86400000), deletedAt: null,
  },
  { // DAESE Textile — 精纺羊毛（韩国）
    id: 'FACP__DEMO-MILL-DAESE', relationId: 'DEMO-MILL-DAESE',
    monthlyCapacity: 300000.0000, capacityUnit: 'M', workerCount: 170,
    specialties: ['精纺羊毛', '羊毛混纺', '高支薄型'],
    qualityScore: 86, deliveryScore: 83, priceLevel: 'High',
    firstOrderAt: '2025-11-05', totalOrders: 2, totalAmount: 2150000.0000,
    bankName: 'KEB Hana Bank Seoul', bankAccount: 'DEMO-KR-DS-007', bankSwift: 'KOEXKRSE',
    notes: 'DEMO: 精纺羊毛面料，验厂评分高，交期稳定。',
    createdAt: BigInt(now - 100 * 86400000), updatedAt: BigInt(now - 6 * 86400000), deletedAt: null,
  },
  { // 张家港骏马辅料织标厂 — 辅料
    id: 'FACP__DEMO-TRIM-ZJG-LABEL', relationId: 'DEMO-TRIM-ZJG-LABEL',
    monthlyCapacity: 1200000.0000, capacityUnit: 'PC', workerCount: 80,
    specialties: ['织标', '印标', '吊牌'],
    qualityScore: 78, deliveryScore: 84, priceLevel: 'Low',
    firstOrderAt: '2025-08-18', totalOrders: 8, totalAmount: 360000.0000,
    bankName: '中国农业银行张家港支行', bankAccount: 'DEMO-CN-ZJG-008',
    notes: 'DEMO: 打样快，小单灵活。',
    createdAt: BigInt(now - 90 * 86400000), updatedAt: BigInt(now - 8 * 86400000), deletedAt: null,
  },
  { // 湖州百纤纱线 — 纱线供应商
    id: 'FACP__DEMO-MILL-HUZHOU-YARN', relationId: 'DEMO-MILL-HUZHOU-YARN',
    monthlyCapacity: 900000.0000, capacityUnit: null, workerCount: 110,
    specialties: ['涤纶纱', '粘胶纱', '混纺纱'],
    qualityScore: 84, deliveryScore: 82, priceLevel: 'Mid',
    firstOrderAt: '2025-07-22', totalOrders: 4, totalAmount: 1280000.0000,
    bankName: '中国工商银行湖州支行', bankAccount: 'DEMO-CN-HZ-009',
    notes: 'DEMO: 纱线按吨计价，产能单位与面料不同。',
    createdAt: BigInt(now - 110 * 86400000), updatedAt: BigInt(now - 10 * 86400000), deletedAt: null,
  },
];

// ═══════════════════════════════════════════════════════════════════
// 11d. SAMPLE COLOR BATCHES — 打色批次（REQ2-01 剧本 A 完整演示）
// ═══════════════════════════════════════════════════════════════════
// lab_dip（DEV-26004 Norden PV 混纺，developing，苏州蓝河）：3 缸——
//   1 号偏红重打 / 2 号 OK 封样基准 / 3 号偏红+色浅重打（剧本 A 原景）
// bulk（PO-2601007 Peerless 羊毛大货，DAESE）：2 缸——大货缸差取证场景
// 已判定批次同步造 FactoryEvaluation(sourceType='color_batch')，供质量分趋势演示
//（运行时真实判定走 service 事务联动；seed 直写为演示数据口径，id 对齐 ALLOC 范式幂等）
const sampleColorBatches: SampleColorBatchSeed[] = [
  { // 剧本 A · 缸 1：偏红，客户要求重打
    id: 'SCB__DEMO-26004-A101', batchCode: 'SCB-20260115-001',
    stage: 'lab_dip', developmentCaseId: 'DEMO-DEV-26004', roundNo: 2,
    dyeLotNo: '缸A-101', batchNo: 'B1', rollNos: ['R01'],
    colorRating: 3, sideDiff: 4, endDiff: 3,
    defectCauses: ['red_cast'],
    customerStatus: 'needs_recast', approvedAsSealed: false,
    customerFeedbackNote: '色光偏红，与标样差异明显，要求重打。', customerFeedbackDate: '2026-01-18',
    supplierRelationId: 'DEMO-MILL-SUZHOU', supplierName: '苏州蓝河染织',
    notes: 'DEMO: 剧本 A 缸 1——偏红重打案例。',
    createdAt: BigInt(now - 20 * 86400000), updatedAt: BigInt(now - 17 * 86400000), deletedAt: null,
  },
  { // 剧本 A · 缸 2：与标样一致，客户通过 → 封样基准
    id: 'SCB__DEMO-26004-A102', batchCode: 'SCB-20260115-002',
    stage: 'lab_dip', developmentCaseId: 'DEMO-DEV-26004', roundNo: 2,
    dyeLotNo: '缸A-102', batchNo: 'B1', rollNos: ['R02'],
    colorRating: 5, sideDiff: 5, endDiff: 5,
    defectCauses: [],
    customerStatus: 'approved', approvedAsSealed: true,
    customerFeedbackNote: '与标样一致，批准为该颜色生产基准。', customerFeedbackDate: '2026-01-18',
    supplierRelationId: 'DEMO-MILL-SUZHOU', supplierName: '苏州蓝河染织',
    notes: 'DEMO: 剧本 A 缸 2——封样基准。',
    createdAt: BigInt(now - 20 * 86400000), updatedAt: BigInt(now - 17 * 86400000), deletedAt: null,
  },
  { // 剧本 A · 缸 3：偏红+色浅，重打
    id: 'SCB__DEMO-26004-A103', batchCode: 'SCB-20260115-003',
    stage: 'lab_dip', developmentCaseId: 'DEMO-DEV-26004', roundNo: 2,
    dyeLotNo: '缸A-103', batchNo: 'B1', rollNos: ['R03'],
    colorRating: 2, sideDiff: 3, endDiff: 2,
    defectCauses: ['red_cast', 'lighter'],
    customerStatus: 'needs_recast', approvedAsSealed: false,
    customerFeedbackNote: '整体偏红且色浅一档，重打。', customerFeedbackDate: '2026-01-18',
    supplierRelationId: 'DEMO-MILL-SUZHOU', supplierName: '苏州蓝河染织',
    notes: 'DEMO: 剧本 A 缸 3——双疵点重打案例。',
    createdAt: BigInt(now - 20 * 86400000), updatedAt: BigInt(now - 17 * 86400000), deletedAt: null,
  },
  { // 大货缸差 · 缸 D-201：轻微差异待判定
    id: 'SCB__DEMO-2601007-D201', batchCode: 'SCB-20260301-001',
    stage: 'bulk', orderId: 'DEMO-PO-2601007',
    dyeLotNo: '缸D-201', batchNo: 'B1', rollNos: ['R11', 'R12', 'R13'],
    colorRating: 4, sideDiff: 4, endDiff: 4,
    defectCauses: [],
    customerStatus: 'pending', approvedAsSealed: false,
    supplierRelationId: 'DEMO-MILL-DAESE', supplierName: 'DAESE Textile Co., Ltd.',
    notes: 'DEMO: 大货首缸，轻微差异范围内。',
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 5 * 86400000), deletedAt: null,
  },
  { // 大货缸差 · 缸 D-202：偏蓝，客户要求重染
    id: 'SCB__DEMO-2601007-D202', batchCode: 'SCB-20260301-002',
    stage: 'bulk', orderId: 'DEMO-PO-2601007',
    dyeLotNo: '缸D-202', batchNo: 'B1', rollNos: ['R21', 'R22'],
    colorRating: 3, sideDiff: 4, endDiff: 3,
    defectCauses: ['blue_cast'],
    customerStatus: 'needs_recast', approvedAsSealed: false,
    customerFeedbackNote: '客户投诉缸差：D-202 偏蓝，要求重新对色。', customerFeedbackDate: '2026-03-05',
    supplierRelationId: 'DEMO-MILL-DAESE', supplierName: 'DAESE Textile Co., Ltd.',
    notes: 'DEMO: 大货缸差取证场景——一键导出证据链。',
    createdAt: BigInt(now - 4 * 86400000), updatedAt: BigInt(now - 3 * 86400000), deletedAt: null,
  },
];

// 已判定批次的供应商质量分明细（评级→分数映射同 service：3→70 / 2→50）
const colorBatchEvaluations: FactoryEvaluationSeed[] = [
  { id: 'FAEV__COLOR-DEMO-26004-A101', factoryId: 'FACP__DEMO-MILL-SUZHOU', kind: 'inspection', score: 70,
    sourceType: 'color_batch', sourceId: 'SCB__DEMO-26004-A101', evaluatedAt: '2026-01-18',
    note: '色差评级3级(明显差异) 疵点:偏红 判定:要求重打 缸号:缸A-101',
    createdAt: BigInt(now - 17 * 86400000), deletedAt: null },
  { id: 'FAEV__COLOR-DEMO-26004-A103', factoryId: 'FACP__DEMO-MILL-SUZHOU', kind: 'inspection', score: 50,
    sourceType: 'color_batch', sourceId: 'SCB__DEMO-26004-A103', evaluatedAt: '2026-01-18',
    note: '色差评级2级(严重偏离) 疵点:偏红/色浅 判定:要求重打 缸号:缸A-103',
    createdAt: BigInt(now - 17 * 86400000), deletedAt: null },
  { id: 'FAEV__COLOR-DEMO-2601007-D202', factoryId: 'FACP__DEMO-MILL-DAESE', kind: 'inspection', score: 70,
    sourceType: 'color_batch', sourceId: 'SCB__DEMO-2601007-D202', evaluatedAt: '2026-03-05',
    note: '色差评级3级(明显差异) 疵点:偏蓝 判定:要求重打 缸号:缸D-202',
    createdAt: BigInt(now - 3 * 86400000), deletedAt: null },
];

// ═══════════════════════════════════════════════════════════════════
// 12. SHIPMENTS + SHIPMENT LINES
// ═══════════════════════════════════════════════════════════════════
const shipments: ShipmentSeed[] = [
  {
    id: 'DEMO-SHP-001', shipmentNumber: 'SHP-2026-ATL-0301',
    type: 'Export', status: 'Delivered',
    shippingMethod: 'Sea',
    bookingDate: '2026-02-20',
    etd: '2026-03-01', atd: '2026-03-01',
    eta: '2026-03-25', ata: '2026-03-24',
    vesselOrFlight: 'MSC TERESA', voyageNumber: 'WE246A',
    portOfLoading: 'Shanghai, China', portOfDischarge: 'New York, USA',
    containerNumber: 'MSCU1234567', sealNumber: 'SL-20260301-001',
    totalPackages: 42, grossWeight: 3150.000, netWeight: 2880.000, volume: 48.500,
    freightAmount: 1850.0000, freightCurrency: 'USD',
    insuranceAmount: 120.0000, insuranceCurrency: 'USD',
    customsAmount: null, customsCurrency: null,
    otherCharges: 320.0000, otherChargesCurrency: 'USD',
    orderId: 'DEMO-PO-2601003',
    customerRelationId: 'DEMO-CUST-ATLAS',
    customerName: 'Atlas Outfitters Ltd.',
    carrierRelationId: 'DEMO-FWD-GLOBEX', carrierName: 'Globex Logistics Co.',
    hsCode: '5211.31', customsBroker: 'Global Customs Broker LLC',
    customsDeclarationNumber: null, customsClearanceDate: null,
    notes: 'DEMO: Atlas 再生涤纶 RIPSTOP 出口运单，已送达 NJ Warehouse。',
    attachments: null,
    createdAt: BigInt(now - 15 * 86400000), updatedAt: BigInt(now - 10 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SHP-002', shipmentNumber: 'SHP-2026-NRD-0215',
    type: 'Export', status: 'Delivered',
    shippingMethod: 'Sea',
    bookingDate: '2026-02-05',
    etd: '2026-02-15', atd: '2026-02-15',
    eta: '2026-02-28', ata: '2026-02-28',
    vesselOrFlight: 'CMA CGM MARCO', voyageNumber: 'NE246B',
    portOfLoading: 'Shanghai, China', portOfDischarge: 'Gothenburg, Sweden',
    containerNumber: 'CMAU7654321', sealNumber: 'SL-20260215-002',
    totalPackages: 28, grossWeight: 2100.000, netWeight: 1920.000, volume: 36.000,
    freightAmount: 2100.0000, freightCurrency: 'USD',
    insuranceAmount: 85.0000, insuranceCurrency: 'USD',
    customsAmount: null, customsCurrency: null,
    otherCharges: 450.0000, otherChargesCurrency: 'USD',
    orderId: 'DEMO-PO-2601004',
    customerRelationId: 'DEMO-CUST-NORDEN',
    customerName: 'Norden Studio AB',
    carrierRelationId: 'DEMO-FWD-GLOBEX', carrierName: 'Globex Logistics Co.',
    hsCode: '5515.11', customsBroker: 'Nordic Freight Solutions',
    customsDeclarationNumber: null, customsClearanceDate: null,
    notes: 'DEMO: Norden PV 混纺面料出口运单，已送达 Gothenburg DC。',
    attachments: null,
    createdAt: BigInt(now - 35 * 86400000), updatedAt: BigInt(now - 12 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SHP-003', shipmentNumber: 'SHP-2026-PRL-0325',
    type: 'Export', status: 'Shipped',
    shippingMethod: 'Sea',
    bookingDate: '2026-03-10',
    etd: '2026-03-25', atd: '2026-03-25',
    eta: '2026-04-15', ata: null,
    vesselOrFlight: 'EVER SUMMIT', voyageNumber: 'EC246C',
    portOfLoading: 'Shanghai, China', portOfDischarge: 'Montreal, Canada',
    containerNumber: 'EVNU9876543', sealNumber: 'SL-20260325-003',
    totalPackages: 65, grossWeight: 5400.000, netWeight: 4980.000, volume: 72.000,
    freightAmount: 2800.0000, freightCurrency: 'USD',
    insuranceAmount: 250.0000, insuranceCurrency: 'USD',
    customsAmount: null, customsCurrency: null,
    otherCharges: 600.0000, otherChargesCurrency: 'USD',
    orderId: 'DEMO-PO-2601007',
    customerRelationId: 'DEMO-CUST-PEERLESS',
    customerName: 'Peerless Clothing International',
    carrierRelationId: 'DEMO-FWD-GLOBEX', carrierName: 'Globex Logistics Co.',
    hsCode: '5111.11', customsBroker: 'Canada East Customs',
    customsDeclarationNumber: null, customsClearanceDate: null,
    notes: 'DEMO: Peerless 羊毛面料大货发运中，预计 4 月中到港。',
    attachments: null,
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SHP-004', shipmentNumber: 'SHP-2026-ATL-0225',
    type: 'Export', status: 'Loading',
    shippingMethod: 'Sea',
    bookingDate: '2026-02-28',
    etd: '2026-03-10', atd: null,
    eta: '2026-04-05', ata: null,
    vesselOrFlight: 'COSCO PACIFIC', voyageNumber: 'CP246D',
    portOfLoading: 'Shanghai, China', portOfDischarge: 'Los Angeles, USA',
    containerNumber: null, sealNumber: null,
    totalPackages: null, grossWeight: null, netWeight: null, volume: null,
    freightAmount: 1600.0000, freightCurrency: 'USD',
    insuranceAmount: 95.0000, insuranceCurrency: 'USD',
    customsAmount: null, customsCurrency: null,
    otherCharges: 280.0000, otherChargesCurrency: 'USD',
    orderId: 'DEMO-PO-2601005',
    customerRelationId: 'DEMO-CUST-ATLAS',
    customerName: 'Atlas Outfitters Ltd.',
    carrierRelationId: 'DEMO-FWD-GLOBEX', carrierName: 'Globex Logistics Co.',
    hsCode: '5211.41', customsBroker: 'Global Customs Broker LLC',
    customsDeclarationNumber: null, customsClearanceDate: null,
    notes: 'DEMO: Atlas NC 弹力布风险运单，坯布库存不足，装箱中。',
    attachments: null,
    createdAt: BigInt(now - 3 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
];

const shipmentLines: ShipmentLineSeed[] = [
  // SHP-001 lines (Atlas RIPSTOP)
  {
    id: 'DEMO-SHPL-001-01', shipmentId: 'DEMO-SHP-001',
    lineNumber: 1,
    orderLineId: 'DEMO-PO-2601003-L001',
    productCode: 'DEMO-FAB-RPET-RIP-145-NAVY', productName: 'Recycled Polyester Ripstop 145gsm Navy',
    colorCode: 'NVY-209', quantity: 5200, unit: 'meter',
    cartons: 42, grossWeight: 3150.000, netWeight: 2880.000, volume: 48.500,
    hsCode: '5211.31', countryOfOrigin: 'China',
    createdAt: BigInt(now - 15 * 86400000), updatedAt: BigInt(now - 15 * 86400000),
  },
  // SHP-002 lines (Norden PV)
  {
    id: 'DEMO-SHPL-002-01', shipmentId: 'DEMO-SHP-002',
    lineNumber: 1,
    orderLineId: 'DEMO-PO-2601004-L001',
    productCode: 'DEMO-FAB-PV-310-GREY', productName: 'Poly Viscose Melange 310gsm Grey',
    colorCode: 'GRY-812', quantity: 3000, unit: 'meter',
    cartons: 28, grossWeight: 2100.000, netWeight: 1920.000, volume: 36.000,
    hsCode: '5515.11', countryOfOrigin: 'China',
    createdAt: BigInt(now - 35 * 86400000), updatedAt: BigInt(now - 35 * 86400000),
  },
  // SHP-003 lines (Peerless wool)
  {
    id: 'DEMO-SHPL-003-01', shipmentId: 'DEMO-SHP-003',
    lineNumber: 1,
    orderLineId: 'DEMO-PO-2601007-L001',
    productCode: 'DEMO-FAB-WW-280-CHARCOAL', productName: 'Wool Worsted 280gsm Charcoal',
    colorCode: 'CHR-710', quantity: 3000, unit: 'meter',
    cartons: 38, grossWeight: 3000.000, netWeight: 2760.000, volume: 42.000,
    hsCode: '5111.11', countryOfOrigin: 'South Korea',
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 5 * 86400000),
  },
  {
    id: 'DEMO-SHPL-003-02', shipmentId: 'DEMO-SHP-003',
    lineNumber: 2,
    orderLineId: 'DEMO-PO-2601007-L002',
    productCode: 'DEMO-FAB-WS-250-NAVY', productName: 'Wool Stretch 250gsm Navy',
    colorCode: 'NVY-415', quantity: 2000, unit: 'meter',
    cartons: 27, grossWeight: 2400.000, netWeight: 2220.000, volume: 30.000,
    hsCode: '5111.11', countryOfOrigin: 'South Korea',
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 5 * 86400000),
  },
  // SHP-004 lines (Atlas NC — at risk)
  {
    id: 'DEMO-SHPL-004-01', shipmentId: 'DEMO-SHP-004',
    lineNumber: 1,
    orderLineId: 'DEMO-PO-2601005-L001',
    productCode: 'DEMO-FAB-NC-190-KHAKI', productName: 'Nylon Cotton Stretch 190gsm Khaki',
    colorCode: 'KHK-408', quantity: 3000, unit: 'meter',
    cartons: null, grossWeight: null, netWeight: null, volume: null,
    hsCode: '5211.41', countryOfOrigin: 'China',
    createdAt: BigInt(now - 3 * 86400000), updatedAt: BigInt(now - 3 * 86400000),
  },
];

// ═══════════════════════════════════════════════════════════════════
// 13. INSIGHTS
// ═══════════════════════════════════════════════════════════════════
const insights: InsightSeed[] = [
  {
    id: 'DEMO-INS-001', fact: 'Atlas Outfitters 是本公司第一大客户，年度订单量占比约 40%，付款记录优秀，建议重点维护。',
    importance: 'high', timestamp: BigInt(now - 1 * 86400000), isPinned: true, deletedAt: null,
  },
  {
    id: 'DEMO-INS-002', fact: 'Peerless Clothing 是核心客户，信用额度 50 万美元，羊毛面料需求稳定，RWS 认证优先。',
    importance: 'high', timestamp: BigInt(now - 2 * 86400000), isPinned: true, deletedAt: null,
  },
  {
    id: 'DEMO-INS-003', fact: 'Norden Studio AB 新客户（瑞典），首次复购完成，OEKO-TEX 认证资料齐全，可提升信用等级。',
    importance: 'medium', timestamp: BigInt(now - 5 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-004', fact: 'DAESE Textile（韩国）是本公司最高品质供应商，精纺羊毛 RWS 认证交期稳定，建议签订年度框架协议。',
    importance: 'high', timestamp: BigInt(now - 7 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-005', fact: 'DEMO-PROD-NYLON-COTTON-STRETCH（NC-190 Khaki）坯布库存仅 180m，订单 DEMO-PO-2601005 处于 Alert 状态，需尽快补货。',
    importance: 'urgent', timestamp: BigInt(now - 1 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-006', fact: '绍兴绿环（DEMO-MILL-SHAOXING）GRS 证书有效期至 2026-09-30，需提前 2 个月续期以避免断档。',
    importance: 'high', timestamp: BigInt(now - 10 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-007', fact: 'Q2 南通北星针织产能已饱和 90%，新开发案（DEV-2026-NRD-WLK-001）建议提前锁定期货。',
    importance: 'medium', timestamp: BigInt(now - 3 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-008', fact: 'Atlas 要求将付款条件从 T/T 30 天调整为 T/T 45 天，需评估资金成本后回复。',
    importance: 'high', timestamp: BigInt(now - 6 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-009', fact: 'Peerless Blazer 开发案（DEV-2026-PRL-BLZ-001）Round 3 PP 样已批准，已转大货订单 DEMO-PO-2601009（$67,500）。',
    importance: 'medium', timestamp: BigInt(now - 10 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-010', fact: 'Globex Logistics 续约谈判完成，上海-北美航线运费下调 8%，新合约有效期至 2027-06-30。',
    importance: 'medium', timestamp: BigInt(now - 8 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-011', fact: 'Atlas Bomber Jacket 开发案（DEV-2026-ATL-JKT-001）进入 Round 2 修版，拉链规格需与 YKK 确认交期。',
    importance: 'medium', timestamp: BigInt(now - 1 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-012', fact: '2026 年春夏市场趋势：再生涤纶和功能面料需求上升，GRS 认证面料溢价约 5-8%。',
    importance: 'low', timestamp: BigInt(now - 14 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-013', fact: '计划于 2026-05-01 赴韩国拜访 DAESE 工厂，审查生产线并确认 Q3 交期安排。',
    importance: 'medium', timestamp: BigInt(now - 4 * 86400000), isPinned: false, deletedAt: null,
  },
  {
    id: 'DEMO-INS-014', fact: 'Peerless 新询盘：2026-27 秋冬正装面料需求增加，含羊毛弹力系列，请尽快提交面料提案。',
    importance: 'urgent', timestamp: BigInt(now - 0.5 * 86400000), isPinned: true, deletedAt: null,
  },
  {
    id: 'DEMO-INS-015', fact: '苏州蓝河（DEMO-MILL-SUZHOU）PV 混纺产品起毛起球风险需每批复测，Lab Dip 流程建议增加到货复检环节。',
    importance: 'medium', timestamp: BigInt(now - 12 * 86400000), isPinned: false, deletedAt: null,
  },
];

// ═══════════════════════════════════════════════════════════════════
// 14. SAMPLE ROOM WAREHOUSES（样品间仓库；3 个：主仓/面料仓/成衣仓）
// ═══════════════════════════════════════════════════════════════════
const sampleRoomWarehouses = [
  {
    id: 'DEMO-WH-SAMPLE-001', code: 'SH-SAMPLE-MAIN', name: '样品间主仓',
    type: 'Main', address: '上海总部 3F-A 区样品间', manager: '陈芳', phone: '021-5555-0001',
    isActive: true, sortOrder: 1, notes: 'DEMO: 主样品间，存放色卡/工艺样/辅料样',
    createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
  },
  {
    id: 'DEMO-WH-SAMPLE-002', code: 'SH-SAMPLE-FABRIC', name: '面料档案仓',
    type: 'Auxiliary', address: '上海总部 3F-B 区面料档案室', manager: '林娜', phone: '021-5555-0002',
    isActive: true, sortOrder: 2, notes: 'DEMO: 面料实物档案，恒温恒湿',
    createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
  },
  {
    id: 'DEMO-WH-SAMPLE-003', code: 'SH-SAMPLE-GARMENT', name: '成衣样品仓',
    type: 'Auxiliary', address: '上海总部 3F-C 区成衣样品间', manager: '王强', phone: '021-5555-0003',
    isActive: true, sortOrder: 3, notes: 'DEMO: 成衣服装样品，按客户分区',
    createdAt: BigInt(now), updatedAt: BigInt(now), deletedAt: null,
  },
];

// ═══════════════════════════════════════════════════════════════════
// 15. SAMPLE CARD ITEMS（30 个样卡；覆盖 fabric/garment/colorcard/trim/other
//     + 关联 devCaseId/orderId/productAssetId/warehouseId + 库存/借出/退役多样性
//     + 部分低库存（availableQty <= minStock）+ 部分在借（borrowed）/逾期 + 部分退役）
// ═══════════════════════════════════════════════════════════════════
const sampleCardItems = [
  // ── 面料样卡 12 个 ──
  {
    id: 'DEMO-SCI-001', code: 'SC-20260101-001', name: '棉弹力斜纹布样卡', cardType: 'fabric',
    colorCardCode: null, location: 'A-01-03', status: 'in_stock', notes: 'DEMO: Atlas 主力面料，关联开发单 DEMO-DEV-26001',
    quantity: 8, availableQty: 8, minStock: 3, maxStock: 20, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: 'DEMO-DEV-26001', orderId: 'DEMO-PO-2601001', productAssetId: 'DEMO-PROD-COTTON-STRETCH-TWILL',
    createdAt: BigInt(now - 1 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-002', code: 'SC-20260101-002', name: '棉府绸白色样卡', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-01', status: 'in_stock', notes: 'DEMO: Norden 衬衫面料，关联开发单 DEMO-DEV-26004',
    quantity: 5, availableQty: 5, minStock: 2, maxStock: 15, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: 'DEMO-DEV-26004', orderId: 'DEMO-PO-2601002', productAssetId: 'DEMO-PROD-COTTON-POPLIN-WHITE',
    createdAt: BigInt(now - 2 * 86400000), updatedAt: BigInt(now - 2 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-003', code: 'SC-20260101-003', name: 'PV 混纺马来丝样卡', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-02', status: 'in_stock', notes: 'DEMO: PV 混纺，关联开发单 DEMO-DEV-26004',
    quantity: 6, availableQty: 6, minStock: 2, maxStock: 15, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: 'DEMO-DEV-26004', orderId: null, productAssetId: 'DEMO-PROD-POLY-VISCOSE-MELANGE',
    createdAt: BigInt(now - 3 * 86400000), updatedAt: BigInt(now - 3 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-004', code: 'SC-20260101-004', name: '再生涤纶 ripstop 样卡', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-03', status: 'in_stock', notes: 'DEMO: GRS 认证再生面料',
    quantity: 4, availableQty: 4, minStock: 2, maxStock: 10, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: null, orderId: 'DEMO-PO-2601003', productAssetId: 'DEMO-PROD-RECYCLED-POLY-RIPSTOP',
    createdAt: BigInt(now - 4 * 86400000), updatedAt: BigInt(now - 4 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-005', code: 'SC-20260101-005', name: '仿羊毛针织样卡', cardType: 'fabric',
    colorCardCode: null, location: 'A-01-05', status: 'in_stock', notes: 'DEMO: 仿羊毛针织，关联开发单 DEMO-DEV-26001',
    quantity: 5, availableQty: 5, minStock: 2, maxStock: 12, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: 'DEMO-DEV-26001', orderId: null, productAssetId: 'DEMO-PROD-WOOL-LIKE-KNIT',
    createdAt: BigInt(now - 5 * 86400000), updatedAt: BigInt(now - 5 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-006', code: 'SC-20260101-006', name: 'NC 弹力卡其样卡', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-06', status: 'in_stock', notes: 'DEMO: NC 卡其，低库存预警，关联开发单 DEMO-DEV-26005',
    quantity: 4, availableQty: 1, minStock: 3, maxStock: 10, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: 'DEMO-DEV-26005', orderId: 'DEMO-PO-2601005', productAssetId: 'DEMO-PROD-NYLON-COTTON-STRETCH',
    createdAt: BigInt(now - 6 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-007', code: 'SC-20260101-007', name: '精纺羊毛炭灰样卡', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-07', status: 'borrowed', notes: 'DEMO: Peerless 西装面料，在借中',
    quantity: 3, availableQty: 0, minStock: 2, maxStock: 8, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-WOOL-WORSTED-CHARCOAL',
    createdAt: BigInt(now - 7 * 86400000), updatedAt: BigInt(now - 2 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-008', code: 'SC-20260101-008', name: '羊毛弹力藏青样卡', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-08', status: 'borrowed', notes: 'DEMO: 逾期未还（dueAt 已过），关联开发单 DEMO-DEV-26001',
    quantity: 4, availableQty: 0, minStock: 2, maxStock: 10, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: 'DEMO-DEV-26001', orderId: null, productAssetId: 'DEMO-PROD-WOOL-STRETCH-NAVY',
    createdAt: BigInt(now - 8 * 86400000), updatedAt: BigInt(now - 3 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-009', code: 'SC-20260101-009', name: '棉弹力斜纹布样卡-副本 A', cardType: 'fabric',
    colorCardCode: null, location: 'A-01-09', status: 'in_stock', notes: 'DEMO: 同款面料备份样卡',
    quantity: 6, availableQty: 6, minStock: 3, maxStock: 15, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-COTTON-STRETCH-TWILL',
    createdAt: BigInt(now - 9 * 86400000), updatedAt: BigInt(now - 9 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-010', code: 'SC-20260101-010', name: '精纺羊毛炭灰样卡-褪色退役', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-10', status: 'retired', notes: 'DEMO: 长期光照褪色，已退役存档',
    quantity: 2, availableQty: 2, minStock: null, maxStock: null, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-WOOL-WORSTED-CHARCOAL',
    createdAt: BigInt(now - 30 * 86400000), updatedAt: BigInt(now - 10 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-011', code: 'SC-20260101-011', name: 'PV 混纺马来丝样卡-副本', cardType: 'fabric',
    colorCardCode: null, location: 'B-02-11', status: 'in_stock', notes: 'DEMO: 低库存临界，紧急补库',
    quantity: 3, availableQty: 0, minStock: 3, maxStock: 8, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-002', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-POLY-VISCOSE-MELANGE',
    createdAt: BigInt(now - 11 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-012', code: 'SC-20260101-012', name: '棉府绸白色样卡-副本', cardType: 'fabric',
    colorCardCode: null, location: 'A-01-12', status: 'in_stock', notes: 'DEMO: 备份样卡',
    quantity: 5, availableQty: 5, minStock: 2, maxStock: 12, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-COTTON-POPLIN-WHITE',
    createdAt: BigInt(now - 12 * 86400000), updatedAt: BigInt(now - 12 * 86400000), deletedAt: null,
  },
  // ── 成衣样卡 5 个 ──
  {
    id: 'DEMO-SCI-013', code: 'SC-20260101-013', name: 'Peerless 男士修身西装样衣', cardType: 'garment',
    colorCardCode: null, location: 'C-03-01', status: 'in_stock', notes: 'DEMO: PP 样已批准，关联开发单 DEMO-DEV-26003，已转大货订单 DEMO-PO-2601009',
    quantity: 2, availableQty: 2, minStock: 1, maxStock: 5, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-003', devCaseId: 'DEMO-DEV-26003', orderId: 'DEMO-PO-2601009', productAssetId: 'DEMO-PROD-GARMENT-BLAZER',
    createdAt: BigInt(now - 13 * 86400000), updatedAt: BigInt(now - 13 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-014', code: 'SC-20260101-014', name: 'Atlas 男士斜纹棉长裤样衣', cardType: 'garment',
    colorCardCode: null, location: 'C-03-02', status: 'in_stock', notes: 'DEMO: Atlas Chino 样衣',
    quantity: 3, availableQty: 3, minStock: 2, maxStock: 8, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-003', devCaseId: null, orderId: 'DEMO-PO-2601002', productAssetId: 'DEMO-PROD-GARMENT-CHINO',
    createdAt: BigInt(now - 14 * 86400000), updatedAt: BigInt(now - 14 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-015', code: 'SC-20260101-015', name: 'Norden 轻量飞行夹克样衣', cardType: 'garment',
    colorCardCode: null, location: 'C-03-03', status: 'borrowed', notes: 'DEMO: 在借中（销售部出差借用），关联开发单 DEMO-DEV-26002',
    quantity: 2, availableQty: 0, minStock: 1, maxStock: 4, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-003', devCaseId: 'DEMO-DEV-26002', orderId: null, productAssetId: 'DEMO-PROD-GARMENT-JACKET',
    createdAt: BigInt(now - 15 * 86400000), updatedAt: BigInt(now - 5 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-016', code: 'SC-20260101-016', name: 'Peerless 西装 M 码样衣', cardType: 'garment',
    colorCardCode: null, location: 'C-03-04', status: 'in_stock', notes: 'DEMO: 低库存预警，关联开发单 DEMO-DEV-26003',
    quantity: 1, availableQty: 1, minStock: 2, maxStock: 4, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-003', devCaseId: 'DEMO-DEV-26003', orderId: null, productAssetId: 'DEMO-PROD-GARMENT-BLAZER',
    createdAt: BigInt(now - 16 * 86400000), updatedAt: BigInt(now - 16 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-017', code: 'SC-20260101-017', name: 'Atlas 长裤样衣-退役', cardType: 'garment',
    colorCardCode: null, location: 'C-03-05', status: 'retired', notes: 'DEMO: 试穿磨损，已退役',
    quantity: 1, availableQty: 1, minStock: null, maxStock: null, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-003', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-GARMENT-CHINO',
    createdAt: BigInt(now - 40 * 86400000), updatedAt: BigInt(now - 20 * 86400000), deletedAt: null,
  },
  // ── 色卡 6 个 ──
  {
    id: 'DEMO-SCI-018', code: 'SC-20260101-018', name: 'Classic Blue 色卡', cardType: 'colorcard',
    colorCardCode: '19-4052 TCX', location: 'A-02-01', status: 'in_stock', notes: 'DEMO: Pantone 19-4052 TCX 经典蓝',
    quantity: 10, availableQty: 10, minStock: 3, maxStock: 20, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 18 * 86400000), updatedAt: BigInt(now - 18 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-019', code: 'SC-20260101-019', name: 'Sunset Orange 色卡', cardType: 'colorcard',
    colorCardCode: '18-1664 TCX', location: 'A-02-02', status: 'in_stock', notes: 'DEMO: Pantone 18-1664 TCX，低库存',
    quantity: 2, availableQty: 2, minStock: 3, maxStock: 8, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 19 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-020', code: 'SC-20260101-020', name: 'Pastel Pink 色卡', cardType: 'colorcard',
    colorCardCode: '16-1546 TCX', location: 'A-02-03', status: 'in_stock', notes: 'DEMO: Pantone 16-1546 TCX',
    quantity: 8, availableQty: 8, minStock: 3, maxStock: 15, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 20 * 86400000), updatedAt: BigInt(now - 20 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-021', code: 'SC-20260101-021', name: 'Lemon Yellow 色卡', cardType: 'colorcard',
    colorCardCode: '14-0740 TCX', location: 'A-02-04', status: 'borrowed', notes: 'DEMO: 客户看样借用',
    quantity: 4, availableQty: 0, minStock: 2, maxStock: 8, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 21 * 86400000), updatedAt: BigInt(now - 4 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-022', code: 'SC-20260101-022', name: 'Scuba Blue 色卡', cardType: 'colorcard',
    colorCardCode: '17-2624 TCX', location: 'A-02-05', status: 'in_stock', notes: 'DEMO: Pantone 17-2624 TCX',
    quantity: 6, availableQty: 6, minStock: 2, maxStock: 12, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 22 * 86400000), updatedAt: BigInt(now - 22 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-023', code: 'SC-20260101-023', name: 'Royal Purple 色卡-退役', cardType: 'colorcard',
    colorCardCode: '18-3838 TCX', location: 'A-02-06', status: 'retired', notes: 'DEMO: 已退役归档',
    quantity: 2, availableQty: 2, minStock: null, maxStock: null, unit: '张',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 50 * 86400000), updatedAt: BigInt(now - 25 * 86400000), deletedAt: null,
  },
  // ── 辅料样卡 5 个 ──
  {
    id: 'DEMO-SCI-024', code: 'SC-20260101-024', name: 'YKK #5 黄铜拉链样卡', cardType: 'trim',
    colorCardCode: null, location: 'A-03-01', status: 'in_stock', notes: 'DEMO: 关联开发单 DEMO-DEV-26002（夹克拉链）',
    quantity: 20, availableQty: 20, minStock: 5, maxStock: 50, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: 'DEMO-DEV-26002', orderId: 'DEMO-PO-2601008', productAssetId: 'DEMO-PROD-TRIM-ZIPPER-YKK5',
    createdAt: BigInt(now - 24 * 86400000), updatedAt: BigInt(now - 24 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-025', code: 'SC-20260101-025', name: '天然牛角扣 22mm 样卡', cardType: 'trim',
    colorCardCode: null, location: 'A-03-02', status: 'in_stock', notes: 'DEMO: 低库存预警，关联开发单 DEMO-DEV-26003（西装扣）',
    quantity: 8, availableQty: 2, minStock: 4, maxStock: 20, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: 'DEMO-DEV-26003', orderId: null, productAssetId: 'DEMO-PROD-TRIM-BUTTON-HORN',
    createdAt: BigInt(now - 25 * 86400000), updatedAt: BigInt(now - 1 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-026', code: 'SC-20260101-026', name: '主标 woven label 样卡', cardType: 'trim',
    colorCardCode: null, location: 'A-03-03', status: 'in_stock', notes: 'DEMO: 主标样品',
    quantity: 15, availableQty: 15, minStock: 5, maxStock: 30, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-TRIM-LABEL-MAIN',
    createdAt: BigInt(now - 26 * 86400000), updatedAt: BigInt(now - 26 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-027', code: 'SC-20260101-027', name: 'YKK #5 拉链样卡-副本', cardType: 'trim',
    colorCardCode: null, location: 'A-03-04', status: 'borrowed', notes: 'DEMO: 逾期未还（工厂打样借用）',
    quantity: 10, availableQty: 0, minStock: 3, maxStock: 20, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-TRIM-ZIPPER-YKK5',
    createdAt: BigInt(now - 27 * 86400000), updatedAt: BigInt(now - 15 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-028', code: 'SC-20260101-028', name: '天然牛角扣 22mm 样卡-退役', cardType: 'trim',
    colorCardCode: null, location: 'A-03-05', status: 'retired', notes: 'DEMO: 已退役',
    quantity: 2, availableQty: 2, minStock: null, maxStock: null, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: 'DEMO-PROD-TRIM-BUTTON-HORN',
    createdAt: BigInt(now - 45 * 86400000), updatedAt: BigInt(now - 18 * 86400000), deletedAt: null,
  },
  // ── 其他样卡 2 个 ──
  {
    id: 'DEMO-SCI-029', code: 'SC-20260101-029', name: '工艺配套说明样卡', cardType: 'other',
    colorCardCode: null, location: 'A-04-01', status: 'in_stock', notes: 'DEMO: 工艺样配套说明',
    quantity: 4, availableQty: 4, minStock: 2, maxStock: 10, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-001', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 29 * 86400000), updatedAt: BigInt(now - 29 * 86400000), deletedAt: null,
  },
  {
    id: 'DEMO-SCI-030', code: 'SC-20260101-030', name: '成衣工艺样卡', cardType: 'other',
    colorCardCode: null, location: 'C-04-01', status: 'in_stock', notes: 'DEMO: 成衣工艺参考样',
    quantity: 3, availableQty: 3, minStock: 1, maxStock: 8, unit: 'PC',
    warehouseId: 'DEMO-WH-SAMPLE-003', devCaseId: null, orderId: null, productAssetId: null,
    createdAt: BigInt(now - 30 * 86400000), updatedAt: BigInt(now - 30 * 86400000), deletedAt: null,
  },
];

// ═══════════════════════════════════════════════════════════════════
// 16. SAMPLE CARD LOANS（借出流水；为 borrowed 状态的样卡附活跃借出记录）
//     含 2 笔逾期未还（SCI-008 / SCI-027）
// ═══════════════════════════════════════════════════════════════════
const sampleCardLoans = [
  {
    id: 'DEMO-SCL-001', itemId: 'DEMO-SCI-007', loanType: 'borrow', loanQuantity: 3,
    borrowerName: 'Peerless 样品间', borrowerUserId: null, relationId: null, relationName: null,
    loanedAt: BigInt(now - 2 * 86400000), dueAt: BigInt(now + 5 * 86400000), returnedAt: null,
    conditionNote: null, operatorId: 'demo-user', createdAt: BigInt(now - 2 * 86400000),
  },
  {
    id: 'DEMO-SCL-002', itemId: 'DEMO-SCI-008', loanType: 'borrow', loanQuantity: 4,
    borrowerName: '设计部-李工', borrowerUserId: null, relationId: null, relationName: null,
    loanedAt: BigInt(now - 3 * 86400000), dueAt: BigInt(now - 1 * 86400000), returnedAt: null, // 逾期
    conditionNote: null, operatorId: 'demo-user', createdAt: BigInt(now - 3 * 86400000),
  },
  {
    id: 'DEMO-SCL-003', itemId: 'DEMO-SCI-015', loanType: 'borrow', loanQuantity: 2,
    borrowerName: '销售部-张经理', borrowerUserId: null, relationId: null, relationName: null,
    loanedAt: BigInt(now - 5 * 86400000), dueAt: BigInt(now + 2 * 86400000), returnedAt: null,
    conditionNote: null, operatorId: 'demo-user', createdAt: BigInt(now - 5 * 86400000),
  },
  {
    id: 'DEMO-SCL-004', itemId: 'DEMO-SCI-021', loanType: 'borrow', loanQuantity: 4,
    borrowerName: '设计部-王工', borrowerUserId: null, relationId: null, relationName: null,
    loanedAt: BigInt(now - 4 * 86400000), dueAt: BigInt(now + 3 * 86400000), returnedAt: null,
    conditionNote: null, operatorId: 'demo-user', createdAt: BigInt(now - 4 * 86400000),
  },
  {
    id: 'DEMO-SCL-005', itemId: 'DEMO-SCI-027', loanType: 'borrow', loanQuantity: 10,
    borrowerName: '南通北星工厂', borrowerUserId: null, relationId: null, relationName: null,
    loanedAt: BigInt(now - 15 * 86400000), dueAt: BigInt(now - 8 * 86400000), returnedAt: null, // 逾期
    conditionNote: null, operatorId: 'demo-user', createdAt: BigInt(now - 15 * 86400000),
  },
];

// ═══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function makeFabricProduct(input: {
  id: string; sku: string; name: string; millId: string; subCatId: string;
  articleNo: string; millQuality: string; millColorCode: string; colorDescription: string;
  construction: string; yarnCount: string; pattern: string;
  weightValue: number; widthValue: number; leadDays: number;
  content: Array<[string, string, string, string, number]>;
  customerCodes: Array<[string, string]>;
  prices: [number, number, number, number];
  certs: string[]; stockStatus: string; stockQuantity: number; riskNote: string;
}): FabricProductSeed {
  return {
    asset: {
      id: input.id, sku: input.sku, name: input.name,
      mainCategory: 'Fabric', subCategoryId: input.subCatId, season: 'DEMO-AW26',
      techPackUrl: null, imageUrl: null, cost: input.prices[0], status: 'Active',
      updatedAt: BigInt(now), deletedAt: null,
    },
    fabricProfile: {
      id: `${input.id}-PROFILE`, productAssetId: input.id,
      articleNo: input.articleNo, millOrganizationId: input.millId,
      millQuality: input.millQuality, millColorCode: input.millColorCode,
      colorDescription: input.colorDescription, construction: input.construction,
      yarnCount: input.yarnCount, pattern: input.pattern,
      weightValue: input.weightValue, weightUnit: 'gsm', weightValueGsm: input.weightValue,
      widthValue: input.widthValue, widthUnit: 'inch',
      productionLeadDays: input.leadDays,
      referenceBatch: `${input.millQuality}-REF-26`,
      stockStatus: input.stockStatus, stockQuantity: input.stockQuantity, stockUnit: 'meter',
      riskNote: `DEMO: ${input.riskNote}`,
      specialNote: '用于甲方验收的拟真面料档案，非真实业务订单。',
      updatedAt: BigInt(now), deletedAt: null,
    },
    composition: input.content.map(([termId, abbreviation, chineseName, englishName, percentage], idx) => ({
      id: `${input.id}-COMP-${idx + 1}`, termId, abbreviation, chineseName, englishName, percentage,
    })),
    customerCodes: input.customerCodes.map(([customerOrganizationId, clientCode], idx) => {
      const nameMap: Record<string, string> = {
        'DEMO-CUST-ATLAS': 'Atlas Outfitters Ltd.',
        'DEMO-CUST-NORDEN': 'Norden Studio AB',
        'DEMO-CUST-PEERLESS': 'Peerless Clothing International',
      };
      return {
        id: `${input.id}-CC-${idx + 1}`, productAssetId: input.id,
        customerOrganizationId, customerNameSnapshot: nameMap[customerOrganizationId] || customerOrganizationId,
        clientCode, note: 'DEMO: 客户品号映射。', updatedAt: BigInt(now), deletedAt: null,
      };
    }),
    prices: [
      ['factory', input.prices[0], 'CNY', 'meter'],
      ['sales', input.prices[1], 'USD', 'meter'],
      ['sample', input.prices[2], 'USD', 'yard'],
      ['cutting', input.prices[3], 'USD', 'yard'],
    ].map(([priceType, amount, currency, unit], idx) => ({
      id: `${input.id}-PRICE-${idx + 1}`, productAssetId: input.id,
      priceType: String(priceType), amount: Number(amount), currency: String(currency), unit: String(unit),
      customerOrganizationId: input.customerCodes[0]?.[0] ?? null,
      sourceType: 'demo-seed', sourceId: input.id, effectiveDate: '2026-01-01',
      note: 'DEMO: 拟真价格历史。', updatedAt: BigInt(now), deletedAt: null,
    })),
    certifications: input.certs.map((cert, idx) => ({
      id: `${input.id}-CERT-${idx + 1}`, productAssetId: input.id,
      certification: cert, certificateNo: `DEMO-CERT-${input.sku}-${idx + 1}`,
      validUntil: '2027-12-31', note: 'DEMO: 认证资料占位。',
      updatedAt: BigInt(now), deletedAt: null,
    })),
  };
}

function makeOrder(input: {
  id: string; customerId: string; customer: string; customerCode: string;
  product: string; status: string; poDate: string; dueDate: string;
  millId: string; millName: string; consignee: string; billTo: string;
  amount: number; purchasePrice: number;
  lines: Array<[string, string, string, string, string, number, number, string, string]>;
}): OrderSeed {
  const totalQty = input.lines.reduce((sum, line) => sum + line[5], 0);
  const isDelivered = input.status === 'Delivered';
  const isShipping = input.status === 'Shipping';
  const isAlert = input.status === 'Alert';
  const hasShipped = isDelivered || isShipping;

  const contactMap: Record<string, { person: string; phone: string; shipAddr1: string; shipAddr2: string; shipCountry: string; shipPhone: string; billAddr: string; billContact: string }> = {
    'DEMO-CUST-ATLAS': { person: 'Emily Carter', phone: '+1 212 555 0188', shipAddr1: '1200 Meadowlands Pkwy', shipAddr2: 'Secaucus, NJ 07094', shipCountry: 'USA', shipPhone: '+1 201 555 0144', billAddr: '450 Seventh Avenue, New York, NY 10123, USA', billContact: 'Emily Carter' },
    'DEMO-CUST-NORDEN': { person: 'Linnea Holm', phone: '+46 8 555 0100', shipAddr1: 'Industrivagen 18', shipAddr2: '417 07 Gothenburg', shipCountry: 'Sweden', shipPhone: '+46 31 555 0133', billAddr: 'Birger Jarlsgatan 22, 114 34 Stockholm, Sweden', billContact: 'Linnea Holm' },
    'DEMO-CUST-PEERLESS': { person: 'Robert Chen', phone: '+1 514 555 0200', shipAddr1: '5555 Rue Saint-Patrick', shipAddr2: 'Montreal, QC H4E 1A2', shipCountry: 'Canada', shipPhone: '+1 514 555 0250', billAddr: '5555 Rue Saint-Patrick, Montreal, QC H4E 1A2, Canada', billContact: 'Robert Chen' },
  };
  const millMap: Record<string, { address: string; contact: string; phone: string }> = {
    'DEMO-MILL-JINHUA': { address: '浙江省金华市婺城区演示路 88 号, Jinhua, China', contact: '王敏', phone: '+86 579 5555 0101' },
    'DEMO-MILL-SUZHOU': { address: '江苏省苏州市吴江区演示工业园 16 号, Suzhou, China', contact: '刘倩', phone: '+86 512 5555 0202' },
    'DEMO-MILL-NANTONG': { address: '江苏省南通市通州区演示针织路 27 号, Nantong, China', contact: '孙磊', phone: '+86 513 5555 0303' },
    'DEMO-MILL-SHAOXING': { address: '浙江省绍兴市柯桥区演示大道 56 号, Shaoxing, China', contact: '周婷', phone: '+86 575 5555 0404' },
    'DEMO-MILL-DAESE': { address: '123 Seocho-daero, Seocho-gu, Seoul, South Korea', contact: 'Kim Sang-ho', phone: '+82 2 555 0500' },
    'DEMO-TRIM-ZJG-LABEL': { address: '江苏省苏州市张家港市杨舍镇演示工业路 18 号, Zhangjiagang, China', contact: '赵颖', phone: '+86 512 5555 0808' },
    'DEMO-MILL-HUZHOU-YARN': { address: '浙江省湖州市吴兴区演示纱线路 88 号, Huzhou, China', contact: '钱伟', phone: '+86 572 5555 0909' },
  };

  const c = contactMap[input.customerId] || contactMap['DEMO-CUST-ATLAS'];
  const mill = millMap[input.millId] || { address: 'DEMO supplier address snapshot', contact: input.millName, phone: '+86 000 5555 0000' };

  return {
    order: {
      id: input.id, customer: input.customer, product: input.product,
      type: input.lines[0][1].startsWith('DEMO-GAR-') ? 'Garment'
        : input.lines[0][1].startsWith('DEMO-OTH-') || input.lines[0][1].startsWith('DEMO-TRM-') || input.lines[0][1].startsWith('DEMO-YRN-') ? 'Other'
        : 'Fabric',
      quantity: Math.round(totalQty), status: input.status, dueDate: input.dueDate,
      quoteAmount: input.amount, updatedAt: BigInt(now), deletedAt: null,
      poNumber: input.id, customerCode: input.customerCode, season: 'DEMO-AW26',
      poDate: input.poDate, contactPerson: c.person, contactPhone: c.phone,
      currency: 'USD', deliveryTerms: 'FOB Shanghai',
      paymentTerms: input.customerId === 'DEMO-CUST-ATLAS' ? 'T/T 30 days after shipment' : input.customerId === 'DEMO-CUST-PEERLESS' ? 'T/T 45 days after shipment' : '30% deposit, 70% before shipment',
      shipToName: input.consignee, shipToAddress1: c.shipAddr1, shipToAddress2: c.shipAddr2,
      shipToCountry: c.shipCountry, shipToPhone: c.shipPhone,
      deliverTo: input.consignee, totalNet: input.amount, totalActual: input.amount,
      source: DEMO_SOURCE, importedAt: BigInt(now),
      fieldSources: { demo: 'manual', source: DEMO_SOURCE } as Prisma.InputJsonValue,
      purchaseCurrency: 'CNY', salesCurrency: 'USD',
      customerRelationId: input.customerId,
      millName: input.millName, millAddress: mill.address,
      millContact: mill.contact,
      millPhone: mill.phone, millRelationId: input.millId,
      consigneeName: input.consignee, consigneeAddress: `${c.shipAddr1}, ${c.shipAddr2}, ${c.shipCountry}`,
      consigneeContact: input.consignee, consigneeRelationId: input.customerId,
      billToName: input.billTo, billToAddress: c.billAddr, billToContact: c.billContact,
      billToIsAgent: false, billToRelationId: input.customerId,
      salesContractNumber: `${input.id}-SC`, finalContractNumber: `${input.id}-FC`,
      productionBatch: `${input.id}-BATCH`,
      productColorCode: input.lines[0][2], clientCode: input.lines[0][1],
      referenceBatch: `${input.lines[0][2]}-REF-26`,
      productionDate: input.lines[0][8], clientDate: input.lines[0][7],
      fabricCode: input.lines[0][1], fabricContent: input.lines[0][3],
      width: input.lines[0][4], gsm: 'See fabric archive',
      asPerson: 'DEMO A/S team', salesPrice: input.lines[0][6],
      contractAmount: input.amount, paymentInstrument: 'T/T',
      expectedPaymentDate: '2026-04-30',
      actualPaymentDate: isDelivered ? '2026-03-05' : null,
      actualPaymentAmount: isDelivered ? input.amount : null,
      invoiceNumber: hasShipped ? `${input.id}-INV` : null,
      invoiceDate: hasShipped ? '2026-02-28' : null,
      shipmentDate: hasShipped ? input.dueDate : null,
      shipmentMethod: 'Sea freight',
      shipmentQuantity: hasShipped ? totalQty : null,
      shipmentAmount: hasShipped ? input.amount : null,
      sampleSentDate: '2026-01-20',
      sampleConfirmedDate: input.status === 'Pending' ? null : '2026-01-28',
      sampleTrackingNumber: `${input.id}-SAMPLE`,
      shipmentSampleComments: 'DEMO: 船样跟踪记录。',
      fabricSampleSentDate: '2026-01-16',
      fabricSampleConfirmedDate: isAlert ? null : '2026-01-24',
      fabricSampleTrackingNumber: `${input.id}-FAB-SAMPLE`,
      paidSampleQuantity: 5,
      purchasePrice: input.purchasePrice,
      purchasePaymentDate: isDelivered ? '2026-03-10' : null,
      supplierInvoiceNumber: isDelivered ? `${input.id}-SUP-INV` : null,
      supplierInvoiceDate: isDelivered ? '2026-03-04' : null,
      supplierInvoiceAmount: input.purchasePrice * totalQty,
      specialInstructions: isAlert
        ? 'DEMO 风险订单：坯布库存不足，需管理层确认是否拆单或延后交期。'
        : 'DEMO 正常订单：用于演示订单闭环。',
      ocDays: 45,
    },
    lines: input.lines.map((line, idx) => ({
      id: `${input.id}-L${String(idx + 1).padStart(3, '0')}`,
      orderId: input.id, lineNumber: idx + 1,
      itemNo: line[0], materialCode: line[1], millQuality: line[2],
      description: line[3], width: line[4],
      exMillDate: line[7], deliveryDate: line[8],
      quantity: line[5], unit: line[1].startsWith('DEMO-GAR-') ? 'piece' : 'meter',
      unitPrice: line[6], netValue: Number((line[5] * line[6]).toFixed(2)),
      via: 'Shanghai', cloth: line[3], weight: 'See fabric archive',
      category: line[1].startsWith('DEMO-GAR-') ? 'DEMO Garment' : 'DEMO Fabric',
      notes: 'DEMO order line seeded for acceptance testing.',
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════
// MAIN LOGIC
// ═══════════════════════════════════════════════════════════════════

function printSummary(): void {
  console.log('Bambook DEMO v2 seed summary');
  console.log('============================');
  console.log(`Organizations: ${organizations.length}`);
  console.log(`  - Customers: ${organizations.filter(r => r.category === 'Customer').length}`);
  console.log(`  - Suppliers: ${organizations.filter(r => r.category === 'Supplier').length}`);
  console.log(`  - Agents: ${organizations.filter(r => r.category === 'Agent').length}`);
  console.log(`  - Partners: ${organizations.filter(r => r.category === 'Partner').length}`);
  console.log(`Contacts: ${contactRelations.length}`);
  console.log(`  - Customer contacts: ${contactRelations.filter(c => c.category === 'Customer').length}`);
  console.log(`  - Supplier contacts: ${contactRelations.filter(c => c.category === 'Supplier').length}`);
  console.log(`  - Agent contacts: ${contactRelations.filter(c => c.category === 'Agent').length}`);
  console.log(`  - Partner contacts: ${contactRelations.filter(c => c.category === 'Partner').length}`);
  console.log(`Sub-categories: ${subCategories.length}`);
  console.log(`Classifications: ${classifications.length}`);
  console.log(`Fabric products: ${fabricProducts.length}`);
  console.log(`Garment products: ${garmentProducts.length}`);
  console.log(`Trimming products: ${trimmingProducts.length}`);
  console.log(`  Composition lines: ${fabricProducts.reduce((sum, p) => sum + p.composition.length, 0)}`);
  console.log(`  Customer codes: ${fabricProducts.reduce((sum, p) => sum + p.customerCodes.length, 0) + garmentProducts.reduce((sum, p) => sum + p.customerCodes.length, 0)}`);
  console.log(`  Prices: ${fabricProducts.reduce((sum, p) => sum + p.prices.length, 0) + garmentProducts.reduce((sum, p) => sum + p.prices.length, 0) + trimmingProducts.reduce((sum, p) => sum + p.prices.length, 0)}`);
  console.log(`  Certifications: ${fabricProducts.reduce((sum, p) => sum + p.certifications.length, 0)}`);
  console.log(`Orders: ${orders.length}`);
  console.log(`  Order lines: ${orders.reduce((sum, o) => sum + o.lines.length, 0)}`);
  console.log(`Entity links: ${entityLinks.length}`);
  console.log(`Development cases: ${developmentCases.length}`);
  console.log(`Invoices: ${invoices.length}`);
  console.log(`Payment vouchers: ${paymentVouchers.length}`);
  console.log(`Shipments: ${shipments.length}`);
  console.log(`  Shipment lines: ${shipmentLines.length}`);
  console.log(`Insights: ${insights.length}`);
  console.log(`Sample room warehouses: ${sampleRoomWarehouses.length}`);
  console.log(`  Sample card items: ${sampleCardItems.length}`);
  console.log(`  Sample card loans: ${sampleCardLoans.length}`);
}

async function rollbackDemo(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // ─── Sample room module (Loans → Items → Warehouses；借出流水先于样卡，避免孤儿引用） ───
    await tx.sampleCardLoan.deleteMany({ where: { id: { startsWith: 'DEMO-SCL-' } } });
    await tx.sampleCardItem.deleteMany({ where: { id: { startsWith: 'DEMO-SCI-' } } });
    await tx.warehouse.deleteMany({ where: { id: { startsWith: 'DEMO-WH-SAMPLE-' } } });

    // ─── New modules (Development / Finance / Shipping / Insight) ───
    // Delete ShipmentLines before Shipments (foreign key)
    await tx.shipmentLine.deleteMany({ where: { id: { startsWith: 'DEMO-SHPL-' } } });
    await tx.shipment.deleteMany({ where: { id: { startsWith: 'DEMO-SHP-' } } });
    // Allocations before vouchers/invoices（DR-045 核销真源，id 前缀 ALLOC__DEMO-）
    await tx.invoiceAllocation.deleteMany({ where: { id: { startsWith: 'ALLOC__DEMO-' } } });
    await tx.paymentVoucher.deleteMany({ where: { id: { startsWith: 'DEMO-PAY-' } } });
    await tx.invoice.deleteMany({ where: { id: { startsWith: 'DEMO-INV-' } } });
    await tx.developmentCase.deleteMany({ where: { id: { startsWith: 'DEMO-DEV-' } } });
    await tx.insight.deleteMany({ where: { id: { startsWith: 'DEMO-INS-' } } });
    // Factory profiles（P1-002；id 前缀 FACP__DEMO-，级联清理 evaluations/certs/capacity）
    await tx.factoryProfile.deleteMany({ where: { id: { startsWith: 'FACP__DEMO-' } } });
    // Sample color batches（REQ2-01；id 前缀 SCB__DEMO- + 色差评分明细 FAEV__COLOR-DEMO-）
    await tx.sampleColorBatch.deleteMany({ where: { id: { startsWith: 'SCB__DEMO-' } } });
    await tx.factoryEvaluation.deleteMany({ where: { id: { startsWith: 'FAEV__COLOR-DEMO-' } } });

    // Order lines & orders
    const demoOrders = await tx.order.findMany({
      where: { OR: [{ source: DEMO_SOURCE }, { id: { startsWith: 'DEMO-PO-' } }, { poNumber: { startsWith: 'DEMO-PO-' } }] },
      select: { id: true },
    });
    const demoOrderIds = demoOrders.map(o => o.id);
    if (demoOrderIds.length) {
      await tx.orderLine.deleteMany({ where: { orderId: { in: demoOrderIds } } });
      await tx.order.deleteMany({ where: { id: { in: demoOrderIds } } });
    }

    // Entity links
    await tx.entityLink.deleteMany({ where: { source: DEMO_SOURCE } });

    // Products (fabric sub-tables first)
    // NOTE: PDML-* products are preserved — only DEMO-* are deleted
    const demoProducts = await tx.productAsset.findMany({
      where: { OR: [{ id: { startsWith: 'DEMO-PROD-' } }, { sku: { startsWith: 'DEMO-' } }] },
      select: { id: true },
    });
    const demoProductIds = demoProducts.map(p => p.id);
    if (demoProductIds.length) {
      await tx.productImage.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.fabricCertification.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.fabricPriceHistory.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.fabricCustomerCode.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.fabricCompositionLine.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.fabricProfile.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.garmentProfile.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.trimmingProfile.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.productClassificationLink.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
      await tx.productAsset.deleteMany({ where: { id: { in: demoProductIds } } });
    }

    // Classifications & sub-categories
    await tx.productClassificationLink.deleteMany({ where: { classificationId: { startsWith: 'DEMO-CLS-' } } });
    await tx.productClassification.deleteMany({ where: { id: { startsWith: 'DEMO-CLS-' } } });
    await tx.productSubCategory.deleteMany({ where: { id: { startsWith: 'DEMO-SUB-' } } });

    // Material composition terms
    await tx.fabricCompositionLine.deleteMany({ where: { id: { startsWith: 'DEMO-' } } });
    await tx.materialCompositionTerm.deleteMany({ where: { id: { startsWith: 'MCT-DEMO-' } } });

    // Relations — exclude PDML-* (庞大面料数据), delete all DEMO-* or DEMO-tagged
    await tx.relation.deleteMany({
      where: {
        AND: [
          { NOT: { id: { startsWith: 'PDML-' } } },
          { OR: [{ id: { startsWith: 'DEMO-' } }, { tags: { has: DEMO_TAG } }] },
        ],
      },
    });
  });
}

async function applyDemo(prisma: PrismaClient): Promise<void> {
  await rollbackDemo(prisma);

  await prisma.$transaction(async (tx) => {
    // 1. Sub-categories
    for (const sub of subCategories) {
      await tx.productSubCategory.upsert({ where: { id: sub.id }, update: sub, create: sub });
    }

    // 2. Classifications
    for (const cls of classifications) {
      await tx.productClassification.upsert({ where: { id: cls.id }, update: cls, create: cls });
    }

    // 3. Relations (organizations + contacts)
    for (const relation of allRelations) {
      await tx.relation.upsert({ where: { id: relation.id }, update: relation, create: relation });
    }

    // 4. Fabric products
    for (const product of fabricProducts) {
      await tx.productAsset.upsert({ where: { id: product.asset.id }, update: product.asset, create: product.asset });
      await tx.fabricProfile.upsert({ where: { productAssetId: product.asset.id }, update: product.fabricProfile, create: product.fabricProfile });

      for (const line of product.composition) {
        await tx.materialCompositionTerm.upsert({
          where: { id: line.termId },
          update: { abbreviation: line.abbreviation, chineseName: line.chineseName, englishName: line.englishName, updatedAt: BigInt(now), deletedAt: null },
          create: { id: line.termId, abbreviation: line.abbreviation, chineseName: line.chineseName, englishName: line.englishName, updatedAt: BigInt(now), deletedAt: null },
        });
        await tx.fabricCompositionLine.create({ data: { id: line.id, productAssetId: product.asset.id, termId: line.termId, percentage: line.percentage, sortOrder: product.composition.findIndex(item => item.id === line.id), updatedAt: BigInt(now), deletedAt: null } });
      }
      await tx.fabricCustomerCode.createMany({ data: product.customerCodes });
      await tx.fabricPriceHistory.createMany({ data: product.prices });
      await tx.fabricCertification.createMany({ data: product.certifications });
    }

    // 5. Garment products
    for (const product of garmentProducts) {
      await tx.productAsset.upsert({ where: { id: product.asset.id }, update: product.asset, create: product.asset });
      await tx.garmentProfile.upsert({ where: { productAssetId: product.asset.id }, update: product.garmentProfile, create: product.garmentProfile });
      await tx.fabricCustomerCode.createMany({ data: product.customerCodes });
      await tx.fabricPriceHistory.createMany({ data: product.prices });
    }

    // 6. Trimming products
    for (const product of trimmingProducts) {
      await tx.productAsset.upsert({ where: { id: product.asset.id }, update: product.asset, create: product.asset });
      await tx.trimmingProfile.upsert({ where: { productAssetId: product.asset.id }, update: product.trimmingProfile, create: product.trimmingProfile });
      await tx.fabricPriceHistory.createMany({ data: product.prices });
    }

    // 7. Orders
    for (const order of orders) {
      await tx.order.create({ data: order.order });
      await tx.orderLine.createMany({ data: order.lines });
    }

    // 8. Entity links
    await tx.entityLink.createMany({ data: entityLinks });

    // 9. Development cases
    for (const dc of developmentCases) {
      await tx.developmentCase.upsert({ where: { id: dc.id }, update: dc, create: dc });
    }

    // 10. Invoices
    for (const inv of invoices) {
      await tx.invoice.upsert({ where: { id: inv.id }, update: inv, create: inv });
    }

    // 11. Payment vouchers
    for (const pv of paymentVouchers) {
      await tx.paymentVoucher.upsert({ where: { id: pv.id }, update: pv, create: pv });
    }

    // 11b. Invoice allocations — DR-045 核销真源（P1-004/005/006 修复）
    for (const alloc of invoiceAllocations) {
      await tx.invoiceAllocation.upsert({
        where: { invoiceId_voucherId: { invoiceId: alloc.invoiceId, voucherId: alloc.voucherId } },
        update: alloc,
        create: alloc,
      });
    }

    // 11c. Factory profiles — P1-002 供应商档案补建（幂等）
    for (const fp of factoryProfiles) {
      await tx.factoryProfile.upsert({ where: { id: fp.id }, update: fp, create: fp });
    }

    // 11d. Sample color batches + 色差质量分明细（REQ2-01 剧本 A；幂等）
    for (const scb of sampleColorBatches) {
      await tx.sampleColorBatch.upsert({ where: { id: scb.id }, update: scb, create: scb });
    }
    for (const fev of colorBatchEvaluations) {
      await tx.factoryEvaluation.upsert({ where: { id: fev.id }, update: fev, create: fev });
    }
    // 重算受影响工厂的质量缓存分（均值口径，与 factoryService.addEvaluation 同公式）
    for (const factoryId of [...new Set(colorBatchEvaluations.map(e => e.factoryId))]) {
      const rows = await tx.factoryEvaluation.findMany({
        where: { factoryId, kind: 'inspection', deletedAt: null },
        select: { score: true },
      });
      const avg = rows.length ? rows.reduce((s: number, r: any) => s + r.score, 0) / rows.length : 0;
      await tx.factoryProfile.update({ where: { id: factoryId }, data: { qualityScore: avg } });
    }

    // 12. Shipments + ShipmentLines
    for (const sh of shipments) {
      await tx.shipment.upsert({ where: { id: sh.id }, update: sh, create: sh });
    }
    await tx.shipmentLine.createMany({ data: shipmentLines });

    // 13. Insights
    await tx.insight.createMany({ data: insights });

    // 14. Sample room warehouses（3 个样品间仓库）
    for (const wh of sampleRoomWarehouses) {
      await tx.warehouse.upsert({ where: { id: wh.id }, update: wh, create: wh });
    }

    // 15. Sample card items（30 个样卡；关联 devCase/order/productAsset/warehouse）
    await tx.sampleCardItem.createMany({ data: sampleCardItems });

    // 16. Sample card loans（借出流水；为 borrowed 状态样卡附活跃借出记录）
    await tx.sampleCardLoan.createMany({ data: sampleCardLoans });
  });
}

async function main(): Promise<void> {
  printSummary();

  if (dryRun) {
    console.log('\nDry-run only. No database connection was opened and no data was written.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for --apply or --rollback');
  }

  const prisma = new PrismaClient();
  try {
    if (rollback) {
      console.log('\nRolling back DEMO v2 data...');
      await rollbackDemo(prisma);
      console.log('Rollback complete.');
      return;
    }

    console.log('\nApplying DEMO v2 data...');
    await applyDemo(prisma);
    console.log('Apply complete.');

    // Verify counts
    const relCount = await prisma.relation.count({ where: { id: { startsWith: 'DEMO-' } } });
    const prodCount = await prisma.productAsset.count({ where: { id: { startsWith: 'DEMO-PROD-' } } });
    const ordCount = await prisma.order.count({ where: { id: { startsWith: 'DEMO-PO-' } } });
    const linkCount = await prisma.entityLink.count({ where: { source: DEMO_SOURCE } });
    const devCount = await prisma.developmentCase.count({ where: { id: { startsWith: 'DEMO-DEV-' } } });
    const invCount = await prisma.invoice.count({ where: { id: { startsWith: 'DEMO-INV-' } } });
    const payCount = await prisma.paymentVoucher.count({ where: { id: { startsWith: 'DEMO-PAY-' } } });
    const shpCount = await prisma.shipment.count({ where: { id: { startsWith: 'DEMO-SHP-' } } });
    const shpLineCount = await prisma.shipmentLine.count({ where: { id: { startsWith: 'DEMO-SHPL-' } } });
    const insCount = await prisma.insight.count({ where: { id: { startsWith: 'DEMO-INS-' } } });
    const whSampleCount = await prisma.warehouse.count({ where: { id: { startsWith: 'DEMO-WH-SAMPLE-' } } });
    const sciCount = await prisma.sampleCardItem.count({ where: { id: { startsWith: 'DEMO-SCI-' } } });
    const sclCount = await prisma.sampleCardLoan.count({ where: { id: { startsWith: 'DEMO-SCL-' } } });
    console.log(`\nVerification:`);
    console.log(`  Relations: ${relCount} | Products: ${prodCount} | Orders: ${ordCount} | EntityLinks: ${linkCount}`);
    console.log(`  DevelopmentCases: ${devCount} | Invoices: ${invCount} | Payments: ${payCount} | Shipments: ${shpCount} | ShipmentLines: ${shpLineCount} | Insights: ${insCount}`);
    console.log(`  SampleRoom: Warehouses: ${whSampleCount} | SampleCardItems: ${sciCount} | SampleCardLoans: ${sclCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
