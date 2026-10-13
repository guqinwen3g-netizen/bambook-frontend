/**
 * Explicitly marked DEMO data seed for Bambook.
 *
 * Recommended (route-backed, goes through REST API + audit/sync):
 *   npx tsx scripts/seed-demo-data.ts --dry-run
 *   npx tsx scripts/seed-demo-data.ts --api-apply
 *   npx tsx scripts/seed-demo-data.ts --api-rollback
 *
 * Unsafe (bypasses REST API, no route audit/sync, direct Prisma write):
 *   npx tsx scripts/seed-demo-data.ts --apply  --unsafe-direct-prisma
 *   npx tsx scripts/seed-demo-data.ts --rollback --unsafe-direct-prisma
 *
 * Safety:
 *   - All rows use deterministic DEMO-* IDs and visible DEMO markers.
 *   - --dry-run does not connect to the database.
 *   - --api-apply / --api-rollback go through REST API (audit, sync, validation).
 *   - --apply / --rollback require --unsafe-direct-prisma; they bypass route audit/sync.
 *   - --rollback deletes only rows matching this script's DEMO markers.
 */

import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
// ★ S4 任务3：演示数据订单金额兜底 ⇒ 走唯一真源（原写法裸用 quoteAmount）
import { orderAmountOf } from '../src/shared/orderAmount';

const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
dotenv.config({ path: path.resolve(SERVER_ROOT, '..', '.env.local'), override: false });

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const apply = args.has('--apply');
const rollback = args.has('--rollback');
const apiApply = args.has('--api-apply');
const apiRollback = args.has('--api-rollback');
const unsafeDirectPrisma = args.has('--unsafe-direct-prisma');

// --apply / --rollback bypass REST API (no route audit/sync), require explicit unsafe flag.
if ((apply || rollback) && !unsafeDirectPrisma) {
  console.error('ERROR: --apply / --rollback bypass REST API (no route audit/sync).');
  console.error('Use --api-apply / --api-rollback for the recommended route-backed path.');
  console.error('If you really need direct Prisma, add --unsafe-direct-prisma to confirm.');
  process.exit(2);
}

if ([dryRun, apply, rollback, apiApply, apiRollback].filter(Boolean).length !== 1) {
  console.error('Usage: npx tsx scripts/seed-demo-data.ts --dry-run | --api-apply | --api-rollback');
  console.error('       npx tsx scripts/seed-demo-data.ts --apply --unsafe-direct-prisma | --rollback --unsafe-direct-prisma');
  process.exit(1);
}

const DEMO_TAG = 'DEMO';
const DEMO_SOURCE = 'demo';
const now = 1767225600000; // 2026-01-01T00:00:00.000Z, stable for deterministic seed output

type RelationSeed = Prisma.RelationUncheckedCreateInput;
type ProductSeed = {
  asset: Prisma.ProductAssetUncheckedCreateInput;
  fabricProfile: Prisma.FabricProfileUncheckedCreateInput;
  composition: Array<{ id: string; termId: string; abbreviation: string; chineseName: string; englishName: string; percentage: number }>;
  customerCodes: Prisma.FabricCustomerCodeUncheckedCreateInput[];
  prices: Prisma.FabricPriceHistoryUncheckedCreateInput[];
  certifications: Prisma.FabricCertificationUncheckedCreateInput[];
};
type OrderSeed = {
  order: Prisma.OrderUncheckedCreateInput;
  lines: Prisma.OrderLineUncheckedCreateInput[];
};

const relations: RelationSeed[] = [
  {
    id: 'DEMO-CUST-ATLAS',
    name: 'Atlas Outfitters Ltd.',
    category: 'Customer',
    type: 'Customer',
    isOrganization: true,
    parentId: null,
    reportsToId: null,
    role: null,
    department: null,
    tags: [DEMO_TAG, 'customer', 'usa', 'menswear'],
    contactInfo: 'orders@atlas-outfitters.example | +1 212 555 0188',
    rating: 4.6,
    lastInteraction: BigInt(now),
    preferences: '偏好稳定交期和可追溯认证；常规付款 T/T 30 days。',
    deletedAt: null,
    chineseName: '阿特拉斯户外服饰',
    englishName: 'Atlas Outfitters Ltd.',
    creditLevel: 'A-',
    summary: '美国男装与户外休闲品牌，采购弹力棉、尼龙棉混纺和功能针织面料。',
    primaryContactName: 'Emily Carter',
    primaryContactEmail: 'emily.carter@atlas-outfitters.example',
    primaryContactPhone: '+1 212 555 0188',
    backupContacts: [
      { name: 'Mark Evans', role: 'Sourcing Manager', email: 'mark.evans@atlas-outfitters.example', phone: '+1 212 555 0191' },
    ],
    shipToAddresses: [
      { label: 'NJ Warehouse', contactName: 'Atlas Receiving', address: '1200 Meadowlands Pkwy, Secaucus, NJ 07094, USA', phone: '+1 201 555 0144' },
      { label: 'LA 3PL', contactName: 'West Coast DC', address: '6880 Alameda St, Los Angeles, CA 90001, USA', phone: '+1 323 555 0122' },
    ],
    financialNotes: 'DEMO: 信用额度 USD 250,000；逾期超过 7 天需暂停新订单。',
    website: 'https://atlas-outfitters.example',
    paymentTerms: 'T/T 30 days after shipment',
    paymentPreference: 'T/T',
    currency: 'USD',
    taxId: 'DEMO-US-ATLAS-001',
    creditLimit: 250000,
    officialAddress: '450 Seventh Avenue, New York, NY 10123, USA',
    factoryAddresses: [],
    warehouseAddress: '1200 Meadowlands Pkwy, Secaucus, NJ 07094, USA',
    billingAddress: '450 Seventh Avenue, New York, NY 10123, USA',
    shippingAddress: '1200 Meadowlands Pkwy, Secaucus, NJ 07094, USA',
    coordinatesLat: 40.757,
    coordinatesLng: -73.988,
    email: 'orders@atlas-outfitters.example',
    phone: '+1 212 555 0188',
    mobile: null,
    wechat: null,
    whatsapp: '+1 212 555 0188',
    otherContacts: [],
    birthday: null,
    language: 'English',
    timezone: 'America/New_York',
    personalNote: null,
  },
  {
    id: 'DEMO-CUST-NORDEN',
    name: 'Norden Studio AB',
    category: 'Customer',
    type: 'Customer',
    isOrganization: true,
    parentId: null,
    reportsToId: null,
    role: null,
    department: null,
    tags: [DEMO_TAG, 'customer', 'sweden', 'premium-casual'],
    contactInfo: 'sourcing@norden-studio.example | +46 8 555 0100',
    rating: 4.3,
    lastInteraction: BigInt(now - 86400000),
    preferences: '重视环保认证和批次稳定性，要求 OEKO-TEX 或 GRS 文件齐全。',
    deletedAt: null,
    chineseName: '诺登设计工作室',
    englishName: 'Norden Studio AB',
    creditLevel: 'B+',
    summary: '北欧高端休闲服装品牌，采购毛感针织、再生涤纶和混纺面料。',
    primaryContactName: 'Linnea Holm',
    primaryContactEmail: 'linnea.holm@norden-studio.example',
    primaryContactPhone: '+46 8 555 0100',
    backupContacts: [
      { name: 'Oskar Nilsson', role: 'Production Coordinator', email: 'oskar.nilsson@norden-studio.example', phone: '+46 8 555 0105' },
    ],
    shipToAddresses: [
      { label: 'Gothenburg DC', contactName: 'Norden DC', address: 'Industrivagen 18, 417 07 Gothenburg, Sweden', phone: '+46 31 555 0133' },
    ],
    financialNotes: 'DEMO: 新客户，首三单建议控制信用额度并跟踪回款。',
    website: 'https://norden-studio.example',
    paymentTerms: '30% deposit, 70% before shipment',
    paymentPreference: 'T/T',
    currency: 'USD',
    taxId: 'DEMO-SE-NORDEN-002',
    creditLimit: 120000,
    officialAddress: 'Birger Jarlsgatan 22, 114 34 Stockholm, Sweden',
    factoryAddresses: [],
    warehouseAddress: 'Industrivagen 18, 417 07 Gothenburg, Sweden',
    billingAddress: 'Birger Jarlsgatan 22, 114 34 Stockholm, Sweden',
    shippingAddress: 'Industrivagen 18, 417 07 Gothenburg, Sweden',
    coordinatesLat: 59.334,
    coordinatesLng: 18.064,
    email: 'sourcing@norden-studio.example',
    phone: '+46 8 555 0100',
    mobile: null,
    wechat: null,
    whatsapp: '+46 8 555 0100',
    otherContacts: [],
    birthday: null,
    language: 'English / Swedish',
    timezone: 'Europe/Stockholm',
    personalNote: null,
  },
  {
    id: 'DEMO-MILL-JINHUA',
    name: 'Jinhua Evergreen Textile Mill',
    category: 'Supplier',
    type: 'Fabric Mill',
    isOrganization: true,
    parentId: null,
    reportsToId: null,
    role: null,
    department: null,
    tags: [DEMO_TAG, 'supplier', 'cotton-stretch', 'zhejiang'],
    contactInfo: 'sales@evergreen-textile.example | +86 579 5555 0101',
    rating: 4.5,
    lastInteraction: BigInt(now - 2 * 86400000),
    preferences: '棉弹力布稳定，染色批差风险低；常用付款月结。',
    deletedAt: null,
    chineseName: '金华常青纺织厂',
    englishName: 'Jinhua Evergreen Textile Mill',
    creditLevel: 'A',
    summary: '以棉弹力斜纹、府绸、帆布为主的面料供应商，适合男装休闲裤和夹克。',
    primaryContactName: '王敏',
    primaryContactEmail: 'wangmin@evergreen-textile.example',
    primaryContactPhone: '+86 579 5555 0101',
    backupContacts: [{ name: '陈浩', role: 'Lab Dip', phone: '+86 579 5555 0102' }],
    shipToAddresses: [],
    financialNotes: 'DEMO: 月结 45 天，开票后付款。',
    website: 'https://evergreen-textile.example',
    paymentTerms: 'Monthly settlement 45 days',
    paymentPreference: 'Bank Transfer',
    currency: 'CNY',
    taxId: 'DEMO-CN-JH-003',
    creditLimit: 800000,
    officialAddress: '浙江省金华市婺城区演示路 88 号',
    factoryAddresses: ['浙江省金华市婺城区演示路 88 号染整园区 3 号楼'],
    warehouseAddress: '浙江省金华市婺城区演示仓库 2 号',
    billingAddress: '浙江省金华市婺城区演示路 88 号',
    shippingAddress: '浙江省金华市婺城区演示仓库 2 号',
    coordinatesLat: 29.079,
    coordinatesLng: 119.648,
    email: 'sales@evergreen-textile.example',
    phone: '+86 579 5555 0101',
    mobile: '+86 138 0000 0101',
    wechat: 'DEMO-JH-MIN',
    whatsapp: null,
    otherContacts: [],
    birthday: null,
    language: 'Chinese',
    timezone: 'Asia/Shanghai',
    personalNote: null,
  },
  {
    id: 'DEMO-MILL-SUZHOU',
    name: 'Suzhou BlueRiver Dyeing & Weaving',
    category: 'Supplier',
    type: 'Fabric Mill',
    isOrganization: true,
    parentId: null,
    reportsToId: null,
    role: null,
    department: null,
    tags: [DEMO_TAG, 'supplier', 'poly-viscose', 'suzhou'],
    contactInfo: 'service@blueriver-textile.example | +86 512 5555 0202',
    rating: 4.1,
    lastInteraction: BigInt(now - 3 * 86400000),
    preferences: '擅长涤粘混纺和毛感针织，但大货前需确认色牢度测试。',
    deletedAt: null,
    chineseName: '苏州蓝河染织',
    englishName: 'Suzhou BlueRiver Dyeing & Weaving',
    creditLevel: 'B+',
    summary: '涤粘混纺、毛感针织和再生涤纶面料供应商。',
    primaryContactName: '刘倩',
    primaryContactEmail: 'liuqian@blueriver-textile.example',
    primaryContactPhone: '+86 512 5555 0202',
    backupContacts: [{ name: '赵强', role: 'Production', phone: '+86 512 5555 0203' }],
    shipToAddresses: [],
    financialNotes: 'DEMO: 高峰期排产紧，建议保留 7 天缓冲。',
    website: 'https://blueriver-textile.example',
    paymentTerms: '30% deposit, 70% before delivery',
    paymentPreference: 'Bank Transfer',
    currency: 'CNY',
    taxId: 'DEMO-CN-SZ-004',
    creditLimit: 500000,
    officialAddress: '江苏省苏州市吴江区演示工业园 16 号',
    factoryAddresses: ['江苏省苏州市吴江区演示工业园 16 号'],
    warehouseAddress: '江苏省苏州市吴江区蓝河仓储中心',
    billingAddress: '江苏省苏州市吴江区演示工业园 16 号',
    shippingAddress: '江苏省苏州市吴江区蓝河仓储中心',
    coordinatesLat: 31.159,
    coordinatesLng: 120.639,
    email: 'service@blueriver-textile.example',
    phone: '+86 512 5555 0202',
    mobile: '+86 139 0000 0202',
    wechat: 'DEMO-SZ-BLUE',
    whatsapp: null,
    otherContacts: [],
    birthday: null,
    language: 'Chinese',
    timezone: 'Asia/Shanghai',
    personalNote: null,
  },
  {
    id: 'DEMO-MILL-NANTONG',
    name: 'Nantong NorthStar Knitting',
    category: 'Supplier',
    type: 'Fabric Mill',
    isOrganization: true,
    parentId: null,
    reportsToId: null,
    role: null,
    department: null,
    tags: [DEMO_TAG, 'supplier', 'knit', 'nantong'],
    contactInfo: 'export@northstar-knit.example | +86 513 5555 0303',
    rating: 4.0,
    lastInteraction: BigInt(now - 4 * 86400000),
    preferences: '针织产能稳定，适合秋冬抓毛和罗纹类订单。',
    deletedAt: null,
    chineseName: '南通北星针织',
    englishName: 'Nantong NorthStar Knitting',
    creditLevel: 'B',
    summary: '针织面料供应商，主营双面布、抓毛布、罗纹和功能针织。',
    primaryContactName: '孙磊',
    primaryContactEmail: 'sunlei@northstar-knit.example',
    primaryContactPhone: '+86 513 5555 0303',
    backupContacts: [{ name: '许芳', role: 'QC', phone: '+86 513 5555 0304' }],
    shipToAddresses: [],
    financialNotes: 'DEMO: 需提前锁定纱线，交期约 45-60 天。',
    website: 'https://northstar-knit.example',
    paymentTerms: 'T/T before shipment',
    paymentPreference: 'Bank Transfer',
    currency: 'CNY',
    taxId: 'DEMO-CN-NT-005',
    creditLimit: 350000,
    officialAddress: '江苏省南通市通州区演示针织路 27 号',
    factoryAddresses: ['江苏省南通市通州区演示针织路 27 号'],
    warehouseAddress: '江苏省南通市通州区北星仓库',
    billingAddress: '江苏省南通市通州区演示针织路 27 号',
    shippingAddress: '江苏省南通市通州区北星仓库',
    coordinatesLat: 32.064,
    coordinatesLng: 120.887,
    email: 'export@northstar-knit.example',
    phone: '+86 513 5555 0303',
    mobile: '+86 137 0000 0303',
    wechat: 'DEMO-NT-KNIT',
    whatsapp: null,
    otherContacts: [],
    birthday: null,
    language: 'Chinese',
    timezone: 'Asia/Shanghai',
    personalNote: null,
  },
  {
    id: 'DEMO-MILL-SHAOXING',
    name: 'Shaoxing GreenLoop Recycled Textiles',
    category: 'Supplier',
    type: 'Fabric Mill',
    isOrganization: true,
    parentId: null,
    reportsToId: null,
    role: null,
    department: null,
    tags: [DEMO_TAG, 'supplier', 'recycled', 'shaoxing'],
    contactInfo: 'export@greenloop-textile.example | +86 575 5555 0404',
    rating: 4.4,
    lastInteraction: BigInt(now - 5 * 86400000),
    preferences: '再生系列资料齐全，GRS 文件响应快。',
    deletedAt: null,
    chineseName: '绍兴绿环再生纺织',
    englishName: 'Shaoxing GreenLoop Recycled Textiles',
    creditLevel: 'A-',
    summary: '再生涤纶、环保混纺和功能涂层供应商。',
    primaryContactName: '周婷',
    primaryContactEmail: 'zhouting@greenloop-textile.example',
    primaryContactPhone: '+86 575 5555 0404',
    backupContacts: [{ name: '韩宇', role: 'Certification', phone: '+86 575 5555 0405' }],
    shipToAddresses: [],
    financialNotes: 'DEMO: GRS 文件需随批次归档。',
    website: 'https://greenloop-textile.example',
    paymentTerms: 'T/T 30 days',
    paymentPreference: 'Bank Transfer',
    currency: 'CNY',
    taxId: 'DEMO-CN-SX-006',
    creditLimit: 600000,
    officialAddress: '浙江省绍兴市柯桥区演示大道 56 号',
    factoryAddresses: ['浙江省绍兴市柯桥区演示大道 56 号'],
    warehouseAddress: '浙江省绍兴市柯桥区绿环仓储',
    billingAddress: '浙江省绍兴市柯桥区演示大道 56 号',
    shippingAddress: '浙江省绍兴市柯桥区绿环仓储',
    coordinatesLat: 30.079,
    coordinatesLng: 120.493,
    email: 'export@greenloop-textile.example',
    phone: '+86 575 5555 0404',
    mobile: '+86 136 0000 0404',
    wechat: 'DEMO-SX-GREEN',
    whatsapp: null,
    otherContacts: [],
    birthday: null,
    language: 'Chinese',
    timezone: 'Asia/Shanghai',
    personalNote: null,
  },
];

const demoContacts = [
  ['DEMO-CONTACT-ATLAS-EMILY', 'Emily Carter', 'Customer', 'DEMO-CUST-ATLAS', 'Merchandising Director', 'emily.carter@atlas-outfitters.example', '+1 212 555 0188'],
  ['DEMO-CONTACT-ATLAS-MARK', 'Mark Evans', 'Customer', 'DEMO-CUST-ATLAS', 'Sourcing Manager', 'mark.evans@atlas-outfitters.example', '+1 212 555 0191'],
  ['DEMO-CONTACT-NORDEN-LINNEA', 'Linnea Holm', 'Customer', 'DEMO-CUST-NORDEN', 'Sourcing Lead', 'linnea.holm@norden-studio.example', '+46 8 555 0100'],
  ['DEMO-CONTACT-JINHUA-WANG', '王敏', 'Supplier', 'DEMO-MILL-JINHUA', 'Sales Manager', 'wangmin@evergreen-textile.example', '+86 579 5555 0101'],
  ['DEMO-CONTACT-SUZHOU-LIU', '刘倩', 'Supplier', 'DEMO-MILL-SUZHOU', 'Account Manager', 'liuqian@blueriver-textile.example', '+86 512 5555 0202'],
  ['DEMO-CONTACT-NANTONG-SUN', '孙磊', 'Supplier', 'DEMO-MILL-NANTONG', 'Export Manager', 'sunlei@northstar-knit.example', '+86 513 5555 0303'],
  ['DEMO-CONTACT-SHAOXING-ZHOU', '周婷', 'Supplier', 'DEMO-MILL-SHAOXING', 'Export Manager', 'zhouting@greenloop-textile.example', '+86 575 5555 0404'],
] as const;

for (const [idx, contact] of demoContacts.entries()) {
  relations.push({
    id: contact[0],
    name: `${contact[1]}`,
    category: contact[2],
    type: 'Contact',
    isOrganization: false,
    parentId: contact[3],
    reportsToId: null,
    role: contact[4],
    department: contact[2] === 'Customer' ? 'Sourcing' : 'Sales',
    tags: [DEMO_TAG, 'contact'],
    contactInfo: `${contact[5]} | ${contact[6]}`,
    rating: 4,
    lastInteraction: BigInt(now - idx * 3600000),
    preferences: `DEMO contact for ${contact[3]}.`,
    deletedAt: null,
    chineseName: contact[1],
    englishName: contact[1],
    creditLevel: null,
    summary: `${contact[4]}，用于关系智库和订单角色验证。`,
    primaryContactName: null,
    primaryContactEmail: null,
    primaryContactPhone: null,
    backupContacts: [],
    shipToAddresses: [],
    financialNotes: null,
    website: null,
    paymentTerms: null,
    paymentPreference: null,
    currency: null,
    taxId: null,
    creditLimit: null,
    officialAddress: null,
    factoryAddresses: [],
    warehouseAddress: null,
    billingAddress: null,
    shippingAddress: null,
    coordinatesLat: null,
    coordinatesLng: null,
    email: contact[5],
    phone: contact[6],
    mobile: contact[6],
    wechat: null,
    whatsapp: contact[6],
    otherContacts: [],
    birthday: null,
    language: contact[2] === 'Customer' ? 'English' : 'Chinese',
    timezone: contact[2] === 'Customer' ? 'UTC' : 'Asia/Shanghai',
    personalNote: 'DEMO: 可用于演示联系人归属、联系方式和业务角色。',
  });
}

const products: ProductSeed[] = [
  makeProduct({
    id: 'DEMO-PROD-COTTON-STRETCH-TWILL',
    sku: 'DEMO-FAB-CST-240-OLIVE',
    name: 'Cotton Stretch Twill 240gsm - Olive',
    millId: 'DEMO-MILL-JINHUA',
    articleNo: 'DEMO-ART-CST240',
    millQuality: 'JH-CST-240',
    millColorCode: 'OLV-536',
    colorDescription: 'Olive Green',
    construction: '3/1 Twill',
    yarnCount: '32/2 x 16 + 40D',
    pattern: 'Solid',
    weightValue: 240,
    widthValue: 57,
    leadDays: 35,
    content: [
      ['MCT-DEMO-COTTON', 'C', '棉', 'Cotton', 97],
      ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 3],
    ],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-CST-OLV-240']],
    prices: [4.6, 6.2, 8.5, 9.8],
    certs: ['OEKO-TEX Standard 100', 'BCI Cotton'],
    stockStatus: 'Available',
    stockQuantity: 1800,
    riskNote: '稳定常规品，注意橄榄色不同批次色差需保留缸差样。',
  }),
  makeProduct({
    id: 'DEMO-PROD-COTTON-POPLIN-WHITE',
    sku: 'DEMO-FAB-CPP-115-WHITE',
    name: 'Cotton Poplin 115gsm - Optical White',
    millId: 'DEMO-MILL-JINHUA',
    articleNo: 'DEMO-ART-CPP115',
    millQuality: 'JH-CPP-115',
    millColorCode: 'WHT-001',
    colorDescription: 'Optical White',
    construction: 'Plain Weave',
    yarnCount: '60s x 60s',
    pattern: 'Solid',
    weightValue: 115,
    widthValue: 58,
    leadDays: 30,
    content: [['MCT-DEMO-COTTON', 'C', '棉', 'Cotton', 100]],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-POP-WHT-115']],
    prices: [3.25, 4.55, 6.0, 7.2],
    certs: ['OEKO-TEX Standard 100'],
    stockStatus: 'Made-to-order',
    stockQuantity: 0,
    riskNote: '白色订单需确认白度和缩水率。',
  }),
  makeProduct({
    id: 'DEMO-PROD-POLY-VISCOSE-MELANGE',
    sku: 'DEMO-FAB-PV-310-GREY',
    name: 'Poly Viscose Melange 310gsm - Grey',
    millId: 'DEMO-MILL-SUZHOU',
    articleNo: 'DEMO-ART-PV310',
    millQuality: 'SZ-PV-310',
    millColorCode: 'GRY-812',
    colorDescription: 'Heather Grey',
    construction: 'Double Knit',
    yarnCount: '40s PV blended',
    pattern: 'Melange',
    weightValue: 310,
    widthValue: 60,
    leadDays: 50,
    content: [
      ['MCT-DEMO-POLYESTER', 'PES', '涤纶', 'Polyester', 65],
      ['MCT-DEMO-VISCOSE', 'VI', '粘胶', 'Viscose', 32],
      ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 3],
    ],
    customerCodes: [['DEMO-CUST-NORDEN', 'NRD-PV-GRY-310']],
    prices: [5.1, 7.2, 9.1, 10.8],
    certs: ['OEKO-TEX Standard 100'],
    stockStatus: 'Low Stock',
    stockQuantity: 420,
    riskNote: '毛感效果好，但需复测起毛起球。',
  }),
  makeProduct({
    id: 'DEMO-PROD-RECYCLED-POLY-RIPSTOP',
    sku: 'DEMO-FAB-RPET-RIP-145-NAVY',
    name: 'Recycled Polyester Ripstop 145gsm - Navy',
    millId: 'DEMO-MILL-SHAOXING',
    articleNo: 'DEMO-ART-RIP145',
    millQuality: 'SX-RPET-RIP-145',
    millColorCode: 'NVY-209',
    colorDescription: 'Deep Navy',
    construction: 'Ripstop',
    yarnCount: '75D x 75D',
    pattern: 'Mini grid',
    weightValue: 145,
    widthValue: 59,
    leadDays: 42,
    content: [['MCT-DEMO-REC-POLY', 'RPET', '再生涤纶', 'Recycled Polyester', 100]],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-RIP-NVY-145']],
    prices: [3.95, 5.75, 7.2, 8.1],
    certs: ['GRS', 'OEKO-TEX Standard 100'],
    stockStatus: 'Available',
    stockQuantity: 2600,
    riskNote: 'GRS 批次证书必须随订单归档。',
  }),
  makeProduct({
    id: 'DEMO-PROD-WOOL-LIKE-KNIT',
    sku: 'DEMO-FAB-WLK-360-CAMEL',
    name: 'Wool-like Brushed Knit 360gsm - Camel',
    millId: 'DEMO-MILL-NANTONG',
    articleNo: 'DEMO-ART-WLK360',
    millQuality: 'NT-WLK-360',
    millColorCode: 'CML-620',
    colorDescription: 'Camel',
    construction: 'Brushed double knit',
    yarnCount: '30s blended yarn',
    pattern: 'Solid brushed',
    weightValue: 360,
    widthValue: 62,
    leadDays: 60,
    content: [
      ['MCT-DEMO-POLYESTER', 'PES', '涤纶', 'Polyester', 70],
      ['MCT-DEMO-VISCOSE', 'VI', '粘胶', 'Viscose', 20],
      ['MCT-DEMO-WOOL', 'W', '羊毛', 'Wool', 10],
    ],
    customerCodes: [['DEMO-CUST-NORDEN', 'NRD-WLK-CML-360']],
    prices: [6.8, 9.6, 12.5, 14.2],
    certs: ['OEKO-TEX Standard 100'],
    stockStatus: 'Development',
    stockQuantity: 0,
    riskNote: '交期长，需提前锁纱；批量前需确认手感样。',
  }),
  makeProduct({
    id: 'DEMO-PROD-NYLON-COTTON-STRETCH',
    sku: 'DEMO-FAB-NC-190-KHAKI',
    name: 'Nylon Cotton Stretch 190gsm - Khaki',
    millId: 'DEMO-MILL-SHAOXING',
    articleNo: 'DEMO-ART-NC190',
    millQuality: 'SX-NC-190',
    millColorCode: 'KHK-408',
    colorDescription: 'Khaki',
    construction: 'Plain weave stretch',
    yarnCount: '70D nylon / 40s cotton + 40D',
    pattern: 'Solid',
    weightValue: 190,
    widthValue: 57,
    leadDays: 45,
    content: [
      ['MCT-DEMO-NYLON', 'N', '尼龙', 'Nylon', 52],
      ['MCT-DEMO-COTTON', 'C', '棉', 'Cotton', 44],
      ['MCT-DEMO-SPANDEX', 'SP', '氨纶', 'Spandex', 4],
    ],
    customerCodes: [['DEMO-CUST-ATLAS', 'ATL-NC-KHK-190']],
    prices: [5.45, 7.65, 9.4, 10.9],
    certs: ['OEKO-TEX Standard 100', 'PFC-Free Finish'],
    stockStatus: 'At Risk',
    stockQuantity: 180,
    riskNote: '坯布库存不足，若客户追加需重新排产。',
  }),
];

const orders: OrderSeed[] = [
  makeOrder({
    id: 'DEMO-PO-2601001',
    customerId: 'DEMO-CUST-ATLAS',
    customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas',
    product: 'Cotton Stretch Twill seasonal program',
    status: 'Production',
    poDate: '2026-01-08',
    dueDate: '2026-03-05',
    millId: 'DEMO-MILL-JINHUA',
    millName: 'Jinhua Evergreen Textile Mill',
    consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.',
    amount: 38850,
    purchasePrice: 4.6,
    lines: [
      ['001', 'DEMO-FAB-CST-240-OLIVE', 'JH-CST-240', 'Cotton Stretch Twill Olive', '57/58"', 4200, 6.2, '2026-02-22', '2026-03-05'],
      ['002', 'DEMO-FAB-COTTON-POPLIN-WHITE', 'JH-CPP-115', 'Cotton Poplin Optical White', '58"', 2800, 4.55, '2026-02-20', '2026-03-03'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601002',
    customerId: 'DEMO-CUST-NORDEN',
    customer: 'Norden Studio AB',
    customerCode: 'norden',
    product: 'Wool-like knit capsule collection',
    status: 'Pending',
    poDate: '2026-01-12',
    dueDate: '2026-04-10',
    millId: 'DEMO-MILL-NANTONG',
    millName: 'Nantong NorthStar Knitting',
    consignee: 'Norden Gothenburg DC',
    billTo: 'Norden Studio AB',
    amount: 42000,
    purchasePrice: 6.8,
    lines: [
      ['001', 'DEMO-FAB-WLK-360-CAMEL', 'NT-WLK-360', 'Wool-like Brushed Knit Camel', '62"', 2500, 9.6, '2026-03-28', '2026-04-10'],
      ['002', 'DEMO-FAB-PV-310-GREY', 'SZ-PV-310', 'Poly Viscose Melange Grey', '60"', 1800, 7.2, '2026-03-20', '2026-04-05'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601003',
    customerId: 'DEMO-CUST-ATLAS',
    customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas',
    product: 'Recycled ripstop outerwear program',
    status: 'Shipping',
    poDate: '2026-01-15',
    dueDate: '2026-03-01',
    millId: 'DEMO-MILL-SHAOXING',
    millName: 'Shaoxing GreenLoop Recycled Textiles',
    consignee: 'Atlas LA 3PL',
    billTo: 'Atlas Outfitters Ltd.',
    amount: 29900,
    purchasePrice: 3.95,
    lines: [
      ['001', 'DEMO-FAB-RPET-RIP-145-NAVY', 'SX-RPET-RIP-145', 'Recycled Polyester Ripstop Navy', '59/60"', 5200, 5.75, '2026-02-18', '2026-03-01'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601004',
    customerId: 'DEMO-CUST-NORDEN',
    customer: 'Norden Studio AB',
    customerCode: 'norden',
    product: 'Premium melange fabric repeat',
    status: 'Delivered',
    poDate: '2025-12-20',
    dueDate: '2026-02-15',
    millId: 'DEMO-MILL-SUZHOU',
    millName: 'Suzhou BlueRiver Dyeing & Weaving',
    consignee: 'Norden Gothenburg DC',
    billTo: 'Norden Studio AB',
    amount: 21600,
    purchasePrice: 5.1,
    lines: [
      ['001', 'DEMO-FAB-PV-310-GREY', 'SZ-PV-310', 'Poly Viscose Melange Grey', '60"', 3000, 7.2, '2026-02-02', '2026-02-15'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601005',
    customerId: 'DEMO-CUST-ATLAS',
    customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas',
    product: 'Nylon cotton stretch urgent order',
    status: 'Alert',
    poDate: '2026-01-18',
    dueDate: '2026-02-25',
    millId: 'DEMO-MILL-SHAOXING',
    millName: 'Shaoxing GreenLoop Recycled Textiles',
    consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.',
    amount: 22950,
    purchasePrice: 5.45,
    lines: [
      ['001', 'DEMO-FAB-NC-190-KHAKI', 'SX-NC-190', 'Nylon Cotton Stretch Khaki', '57/58"', 3000, 7.65, '2026-02-20', '2026-02-25'],
    ],
  }),
  makeOrder({
    id: 'DEMO-PO-2601006',
    customerId: 'DEMO-CUST-ATLAS',
    customer: 'Atlas Outfitters Ltd.',
    customerCode: 'atlas',
    product: 'Cotton program balance shipment',
    status: 'Pending',
    poDate: '2026-01-22',
    dueDate: '2026-03-18',
    millId: 'DEMO-MILL-JINHUA',
    millName: 'Jinhua Evergreen Textile Mill',
    consignee: 'Atlas NJ Warehouse',
    billTo: 'Atlas Outfitters Ltd.',
    amount: 25575,
    purchasePrice: 3.25,
    lines: [
      ['001', 'DEMO-FAB-COTTON-POPLIN-WHITE', 'JH-CPP-115', 'Cotton Poplin Optical White', '58"', 4500, 4.55, '2026-03-07', '2026-03-18'],
      ['002', 'DEMO-FAB-CST-240-OLIVE', 'JH-CST-240', 'Cotton Stretch Twill Olive', '57/58"', 800, 6.2, '2026-03-06', '2026-03-18'],
    ],
  }),
];

function makeProduct(input: {
  id: string;
  sku: string;
  name: string;
  millId: string;
  articleNo: string;
  millQuality: string;
  millColorCode: string;
  colorDescription: string;
  construction: string;
  yarnCount: string;
  pattern: string;
  weightValue: number;
  widthValue: number;
  leadDays: number;
  content: Array<[string, string, string, string, number]>;
  customerCodes: Array<[string, string]>;
  prices: [number, number, number, number];
  certs: string[];
  stockStatus: string;
  stockQuantity: number;
  riskNote: string;
}): ProductSeed {
  return {
    asset: {
      id: input.id,
      sku: input.sku,
      name: input.name,
      mainCategory: 'Fabric',
      subCategoryId: 'DEMO-SUB-FABRIC',
      season: 'DEMO-AW26',
      techPackUrl: null,
      imageUrl: null,
      cost: input.prices[0],
      status: 'Active',
      updatedAt: BigInt(now),
      deletedAt: null,
    },
    fabricProfile: {
      id: `${input.id}-PROFILE`,
      productAssetId: input.id,
      articleNo: input.articleNo,
      millOrganizationId: input.millId,
      millQuality: input.millQuality,
      millColorCode: input.millColorCode,
      colorDescription: input.colorDescription,
      construction: input.construction,
      yarnCount: input.yarnCount,
      pattern: input.pattern,
      weightValue: input.weightValue,
      weightUnit: 'gsm',
      weightValueGsm: input.weightValue,
      widthValue: input.widthValue,
      widthUnit: 'inch',
      productionLeadDays: input.leadDays,
      referenceBatch: `${input.millQuality}-REF-26`,
      stockStatus: input.stockStatus,
      stockQuantity: input.stockQuantity,
      stockUnit: 'meter',
      riskNote: `DEMO: ${input.riskNote}`,
      specialNote: '用于甲方验收的拟真面料档案，非真实业务订单。',
      updatedAt: BigInt(now),
      deletedAt: null,
    },
    composition: input.content.map(([termId, abbreviation, chineseName, englishName, percentage], idx) => ({
      id: `${input.id}-COMP-${idx + 1}`,
      termId,
      abbreviation,
      chineseName,
      englishName,
      percentage,
    })),
    customerCodes: input.customerCodes.map(([customerOrganizationId, clientCode], idx) => ({
      id: `${input.id}-CC-${idx + 1}`,
      productAssetId: input.id,
      customerOrganizationId,
      customerNameSnapshot: customerOrganizationId === 'DEMO-CUST-ATLAS' ? 'Atlas Outfitters Ltd.' : 'Norden Studio AB',
      clientCode,
      note: 'DEMO: 客户品号映射，用于演示客户编码检索。',
      updatedAt: BigInt(now),
      deletedAt: null,
    })),
    prices: [
      ['factory', input.prices[0], 'CNY', 'meter'],
      ['sales', input.prices[1], 'USD', 'meter'],
      ['sample', input.prices[2], 'USD', 'yard'],
      ['cutting', input.prices[3], 'USD', 'yard'],
    ].map(([priceType, amount, currency, unit], idx) => ({
      id: `${input.id}-PRICE-${idx + 1}`,
      productAssetId: input.id,
      priceType: String(priceType),
      amount: Number(amount),
      currency: String(currency),
      unit: String(unit),
      customerOrganizationId: input.customerCodes[0]?.[0] ?? null,
      sourceType: 'demo-seed',
      sourceId: input.id,
      effectiveDate: '2026-01-01',
      note: 'DEMO: 拟真价格历史，用于验收展示。',
      updatedAt: BigInt(now),
      deletedAt: null,
    })),
    certifications: input.certs.map((cert, idx) => ({
      id: `${input.id}-CERT-${idx + 1}`,
      productAssetId: input.id,
      certification: cert,
      certificateNo: `DEMO-CERT-${input.sku}-${idx + 1}`,
      validUntil: '2027-12-31',
      note: 'DEMO: 认证资料占位，正式业务需上传真实证书。',
      updatedAt: BigInt(now),
      deletedAt: null,
    })),
  };
}

function makeOrder(input: {
  id: string;
  customerId: string;
  customer: string;
  customerCode: string;
  product: string;
  status: string;
  poDate: string;
  dueDate: string;
  millId: string;
  millName: string;
  consignee: string;
  billTo: string;
  amount: number;
  purchasePrice: number;
  lines: Array<[string, string, string, string, string, number, number, string, string]>;
}): OrderSeed {
  const totalQty = input.lines.reduce((sum, line) => sum + line[5], 0);
  return {
    order: {
      id: input.id,
      customer: input.customer,
      product: input.product,
      type: 'Fabric',
      quantity: Math.round(totalQty),
      status: input.status,
      dueDate: input.lines[0][7],
      quoteAmount: input.amount,
      updatedAt: BigInt(now),
      deletedAt: null,
      poNumber: input.id,
      customerCode: input.customerCode,
      season: 'DEMO-AW26',
      poDate: input.poDate,
      contactPerson: input.customerId === 'DEMO-CUST-ATLAS' ? 'Emily Carter' : 'Linnea Holm',
      contactPhone: input.customerId === 'DEMO-CUST-ATLAS' ? '+1 212 555 0188' : '+46 8 555 0100',
      currency: 'USD',
      deliveryTerms: 'FOB Shanghai',
      paymentTerms: input.customerId === 'DEMO-CUST-ATLAS' ? 'T/T 30 days after shipment' : '30% deposit, 70% before shipment',
      shipToName: input.consignee,
      shipToAddress1: input.customerId === 'DEMO-CUST-ATLAS' ? '1200 Meadowlands Pkwy' : 'Industrivagen 18',
      shipToAddress2: input.customerId === 'DEMO-CUST-ATLAS' ? 'Secaucus, NJ 07094' : '417 07 Gothenburg',
      shipToCountry: input.customerId === 'DEMO-CUST-ATLAS' ? 'USA' : 'Sweden',
      shipToPhone: input.customerId === 'DEMO-CUST-ATLAS' ? '+1 201 555 0144' : '+46 31 555 0133',
      deliverTo: input.consignee,
      totalNet: input.amount,
      totalActual: input.amount,
      source: DEMO_SOURCE,
      importedAt: BigInt(now),
      fieldSources: { demo: 'manual', source: DEMO_SOURCE } as Prisma.InputJsonValue,
      purchaseCurrency: 'CNY',
      salesCurrency: 'USD',
      customerRelationId: input.customerId,
      millName: input.millName,
      millAddress: 'DEMO supplier address snapshot',
      millContact: input.millName.includes('Jinhua') ? '王敏' : input.millName.includes('Suzhou') ? '刘倩' : input.millName.includes('Nantong') ? '孙磊' : '周婷',
      millPhone: '+86 000 5555 0000',
      millRelationId: input.millId,
      consigneeName: input.consignee,
      consigneeAddress: input.customerId === 'DEMO-CUST-ATLAS' ? '1200 Meadowlands Pkwy, Secaucus, NJ 07094, USA' : 'Industrivagen 18, 417 07 Gothenburg, Sweden',
      consigneeContact: input.consignee,
      consigneeRelationId: input.customerId,
      billToName: input.billTo,
      billToAddress: input.customerId === 'DEMO-CUST-ATLAS' ? '450 Seventh Avenue, New York, NY 10123, USA' : 'Birger Jarlsgatan 22, 114 34 Stockholm, Sweden',
      billToContact: input.customerId === 'DEMO-CUST-ATLAS' ? 'Emily Carter' : 'Linnea Holm',
      billToIsAgent: false,
      billToRelationId: input.customerId,
      salesContractNumber: `${input.id}-SC`,
      finalContractNumber: `${input.id}-FC`,
      productionBatch: `${input.id}-BATCH`,
      productColorCode: input.lines[0][2],
      clientCode: input.lines[0][1],
      referenceBatch: `${input.lines[0][2]}-REF-26`,
      productionDate: input.lines[0][8],
      clientDate: input.lines[0][7],
      fabricCode: input.lines[0][1],
      fabricContent: input.lines[0][3],
      width: input.lines[0][4],
      gsm: 'See fabric archive',
      asPerson: 'DEMO A/S team',
      salesPrice: input.lines[0][6],
      contractAmount: input.amount,
      paymentInstrument: 'T/T',
      expectedPaymentDate: '2026-04-30',
      actualPaymentDate: input.status === 'Delivered' ? '2026-03-05' : null,
      actualPaymentAmount: input.status === 'Delivered' ? input.amount : null,
      invoiceNumber: input.status === 'Delivered' || input.status === 'Shipping' ? `${input.id}-INV` : null,
      invoiceDate: input.status === 'Delivered' || input.status === 'Shipping' ? '2026-02-28' : null,
      shipmentDate: input.status === 'Delivered' || input.status === 'Shipping' ? input.dueDate : null,
      shipmentMethod: 'Sea freight',
      shipmentQuantity: input.status === 'Delivered' || input.status === 'Shipping' ? totalQty : null,
      shipmentAmount: input.status === 'Delivered' || input.status === 'Shipping' ? input.amount : null,
      sampleSentDate: '2026-01-20',
      sampleConfirmedDate: input.status === 'Pending' ? null : '2026-01-28',
      sampleTrackingNumber: `${input.id}-SAMPLE`,
      shipmentSampleComments: 'DEMO: 船样跟踪记录。',
      fabricSampleSentDate: '2026-01-16',
      fabricSampleConfirmedDate: input.status === 'Alert' ? null : '2026-01-24',
      fabricSampleTrackingNumber: `${input.id}-FAB-SAMPLE`,
      paidSampleQuantity: 5,
      purchasePrice: input.purchasePrice,
      purchasePaymentDate: input.status === 'Delivered' ? '2026-03-10' : null,
      supplierInvoiceNumber: input.status === 'Delivered' ? `${input.id}-SUP-INV` : null,
      supplierInvoiceDate: input.status === 'Delivered' ? '2026-03-04' : null,
      supplierInvoiceAmount: input.purchasePrice * totalQty,
      specialInstructions: input.status === 'Alert'
        ? 'DEMO 风险订单：坯布库存不足，需管理层确认是否拆单或延后交期。'
        : 'DEMO 正常订单：用于演示订单闭环。',
      ocDays: 45,
    },
    lines: input.lines.map((line, idx) => ({
      id: `${input.id}-L${String(idx + 1).padStart(3, '0')}`,
      orderId: input.id,
      lineNumber: idx + 1,
      itemNo: line[0],
      materialCode: line[1],
      millQuality: line[2],
      description: line[3],
      width: line[4],
      exMillDate: line[7],
      deliveryDate: line[8],
      quantity: line[5],
      unit: 'meter',
      unitPrice: line[6],
      netValue: Number((line[5] * line[6]).toFixed(2)),
      via: 'Shanghai',
      cloth: line[3],
      weight: 'See fabric archive',
      category: 'DEMO Fabric',
      notes: 'DEMO order line seeded for acceptance testing.',
    })),
  };
}

function printSummary(): void {
  console.log('Bambook DEMO seed summary');
  console.log('-------------------------');
  console.log(`Relations: ${relations.length} (${relations.filter(r => r.isOrganization).length} organizations, ${relations.filter(r => !r.isOrganization).length} contacts)`);
  console.log(`Products: ${products.length}`);
  console.log(`Fabric profiles: ${products.length}`);
  console.log(`Composition lines: ${products.reduce((sum, p) => sum + p.composition.length, 0)}`);
  console.log(`Customer codes: ${products.reduce((sum, p) => sum + p.customerCodes.length, 0)}`);
  console.log(`Prices: ${products.reduce((sum, p) => sum + p.prices.length, 0)}`);
  console.log(`Certifications: ${products.reduce((sum, p) => sum + p.certifications.length, 0)}`);
  console.log(`Orders: ${orders.length}`);
  console.log(`Order lines: ${orders.reduce((sum, o) => sum + o.lines.length, 0)}`);
  console.log('');
  console.log('Visible DEMO markers:');
  console.log('- Relation.tags contains DEMO');
  console.log('- ProductAsset.id/sku starts with DEMO-');
  console.log('- Order.id/poNumber starts with DEMO-PO- and source=demo');
}

async function rollbackDemo(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const demoOrders = await tx.order.findMany({
      where: { OR: [{ source: DEMO_SOURCE }, { id: { startsWith: 'DEMO-PO-' } }, { poNumber: { startsWith: 'DEMO-PO-' } }] },
      select: { id: true },
    });
    const demoOrderIds = demoOrders.map(o => o.id);
    await tx.orderLine.deleteMany({ where: { orderId: { in: demoOrderIds } } });
    await tx.order.deleteMany({ where: { id: { in: demoOrderIds } } });

    const demoProducts = await tx.productAsset.findMany({
      where: { OR: [{ id: { startsWith: 'DEMO-PROD-' } }, { sku: { startsWith: 'DEMO-FAB-' } }] },
      select: { id: true },
    });
    const demoProductIds = demoProducts.map(p => p.id);
    await tx.productImage.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
    await tx.fabricCertification.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
    await tx.fabricPriceHistory.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
    await tx.fabricCustomerCode.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
    await tx.fabricCompositionLine.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
    await tx.fabricProfile.deleteMany({ where: { productAssetId: { in: demoProductIds } } });
    await tx.productAsset.deleteMany({ where: { id: { in: demoProductIds } } });

    await tx.relation.deleteMany({
      where: {
        OR: [
          { id: { startsWith: 'DEMO-' } },
          { tags: { has: DEMO_TAG } },
        ],
      },
    });
  });
}

async function applyDemo(prisma: PrismaClient): Promise<void> {
  await rollbackDemo(prisma);

  await prisma.$transaction(async (tx) => {
    for (const relation of relations) {
      await tx.relation.upsert({
        where: { id: relation.id },
        update: relation,
        create: relation,
      });
    }

    for (const product of products) {
      await tx.productAsset.upsert({
        where: { id: product.asset.id },
        update: product.asset,
        create: product.asset,
      });
      await tx.fabricProfile.upsert({
        where: { productAssetId: product.asset.id },
        update: product.fabricProfile,
        create: product.fabricProfile,
      });
      for (const line of product.composition) {
        await tx.materialCompositionTerm.upsert({
          where: { id: line.termId },
          update: {
            abbreviation: line.abbreviation,
            chineseName: line.chineseName,
            englishName: line.englishName,
            updatedAt: BigInt(now),
            deletedAt: null,
          },
          create: {
            id: line.termId,
            abbreviation: line.abbreviation,
            chineseName: line.chineseName,
            englishName: line.englishName,
            updatedAt: BigInt(now),
            deletedAt: null,
          },
        });
        await tx.fabricCompositionLine.create({
          data: {
            id: line.id,
            productAssetId: product.asset.id,
            termId: line.termId,
            percentage: line.percentage,
            sortOrder: product.composition.findIndex(item => item.id === line.id),
            updatedAt: BigInt(now),
            deletedAt: null,
          },
        });
      }
      await tx.fabricCustomerCode.createMany({ data: product.customerCodes });
      await tx.fabricPriceHistory.createMany({ data: product.prices });
      await tx.fabricCertification.createMany({ data: product.certifications });
    }

    for (const order of orders) {
      await tx.order.create({ data: order.order });
      await tx.orderLine.createMany({ data: order.lines });
    }
  });
}

function jsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map(jsonSafe) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = jsonSafe(item);
    }
    return out as T;
  }
  return value;
}

function getApiConfig(): { endpoint: string; apiKey: string } {
  const endpoint = (
    process.env.BAMBOOK_DEMO_SEED_ENDPOINT ||
    process.env.VITE_CLOUD_ENDPOINT ||
    'https://jiangsupanda.com/bambook'
  ).replace(/\/$/, '');
  const apiKey = process.env.BAMBOOK_SDK_KEY || process.env.BAMBOOK_API_KEY || process.env.VITE_BAMBOOK_API_KEY || '';
  if (!apiKey) {
    throw new Error('API key is required for --api-apply/--api-rollback. Set VITE_BAMBOOK_API_KEY or BAMBOOK_SDK_KEY.');
  }
  return { endpoint, apiKey };
}

function apiUrl(endpoint: string, pathName: string): string {
  const clean = pathName.startsWith('/') ? pathName : `/${pathName}`;
  return `${endpoint}${clean.startsWith('/api/') ? clean : `/api${clean}`}`;
}

async function requestJson<T>(endpoint: string, apiKey: string, pathName: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiUrl(endpoint, pathName), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Bambook-API-Key': apiKey,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${pathName} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data as T;
}

function toProductPayload(product: ProductSeed): Record<string, unknown> {
  return jsonSafe({
    ...product.asset,
    fabricProfile: product.fabricProfile,
    compositionLines: product.composition.map((line, idx) => ({
      id: line.id,
      productAssetId: product.asset.id,
      termId: line.termId,
      percentage: line.percentage,
      sortOrder: idx,
      term: {
        id: line.termId,
        abbreviation: line.abbreviation,
        chineseName: line.chineseName,
        englishName: line.englishName,
      },
    })),
    fabricCustomerCodes: product.customerCodes,
    fabricPrices: product.prices,
    fabricCertifications: product.certifications,
  });
}

function toParsedOrder(seed: OrderSeed): Record<string, unknown> {
  const order = seed.order;
  return {
    customerId: String(order.customerCode || 'demo'),
    poNumber: String(order.poNumber || order.id),
    season: String(order.season || ''),
    poDate: String(order.poDate || ''),
    contactPerson: String(order.contactPerson || ''),
    contactPhone: String(order.contactPhone || ''),
    currency: String(order.currency || 'USD'),
    deliveryTerms: String(order.deliveryTerms || ''),
    paymentTerms: String(order.paymentTerms || ''),
    shipTo: {
      contactName: order.consigneeContact || order.shipToName || '',
      company: order.consigneeName || order.shipToName || '',
      addressLines: [order.shipToAddress1, order.shipToAddress2].filter(Boolean),
      country: order.shipToCountry || '',
    },
    deliverTo: order.deliverTo || order.consigneeName || '',
    lines: seed.lines.map(line => ({
      itemNo: line.itemNo || '',
      materialCode: line.materialCode || '',
      millQuality: line.millQuality || '',
      description: line.description || '',
      width: line.width || '',
      exMillDate: line.exMillDate || '',
      deliveryDate: line.deliveryDate || '',
      quantity: line.quantity,
      unit: line.unit || 'meter',
      unitPrice: line.unitPrice || 0,
      netValue: line.netValue || 0,
      via: line.via || '',
      cloth: line.cloth || '',
      weight: line.weight || '',
      category: line.category || '',
      notes: line.notes ? [String(line.notes)] : [],
    })),
    totalNet: order.totalNet || orderAmountOf(order),
    totalActual: order.totalActual || orderAmountOf(order),
  };
}

function toOrderPatch(seed: OrderSeed): Record<string, unknown> {
  const { id: _id, ...patch } = jsonSafe(seed.order) as Record<string, unknown>;
  return {
    ...patch,
    source: DEMO_SOURCE,
    fieldSources: { demo: 'manual', source: DEMO_SOURCE },
  };
}

async function rollbackDemoViaApi(endpoint: string, apiKey: string): Promise<void> {
  const ordersResp = await requestJson<{ ok: boolean; orders: Array<{ id: string; poNumber?: string; source?: string }> }>(
    endpoint,
    apiKey,
    '/v1/orders',
  );
  for (const order of ordersResp.orders || []) {
    if (order.source === DEMO_SOURCE || order.id?.startsWith('PO-DEMO-PO-') || order.id?.startsWith('DEMO-PO-') || order.poNumber?.startsWith('DEMO-PO-')) {
      await requestJson(endpoint, apiKey, `/v1/orders/${encodeURIComponent(order.id)}`, { method: 'DELETE' });
    }
  }

  const productsResp = await requestJson<{ ok: boolean; assets: Array<{ id: string; sku?: string }> }>(
    endpoint,
    apiKey,
    '/v1/products/assets?search=DEMO',
  );
  for (const product of productsResp.assets || []) {
    if (product.id?.startsWith('DEMO-PROD-') || product.sku?.startsWith('DEMO-FAB-')) {
      await requestJson(endpoint, apiKey, `/v1/products/assets/${encodeURIComponent(product.id)}`, { method: 'DELETE' });
    }
  }

  const relationsResp = await requestJson<{ ok: boolean; relations: Array<{ id: string; tags?: string[] }> }>(
    endpoint,
    apiKey,
    '/v1/relations',
  );
  for (const relation of relationsResp.relations || []) {
    if (relation.id?.startsWith('DEMO-') || relation.tags?.includes(DEMO_TAG)) {
      await requestJson(endpoint, apiKey, `/v1/relations/${encodeURIComponent(relation.id)}`, { method: 'DELETE' });
    }
  }
}

async function applyDemoViaApi(): Promise<void> {
  const { endpoint, apiKey } = getApiConfig();
  await requestJson(endpoint, apiKey, '/health');

  console.log(`Using Cloudflare API endpoint: ${endpoint}`);
  console.log('Rolling back existing API-visible DEMO rows first...');
  await rollbackDemoViaApi(endpoint, apiKey);

  console.log('Writing relations...');
  for (const relation of relations) {
    await requestJson(endpoint, apiKey, '/v1/relations', {
      method: 'POST',
      body: JSON.stringify(jsonSafe(relation)),
    });
  }

  console.log('Writing product assets and fabric archive data...');
  for (const product of products) {
    await requestJson(endpoint, apiKey, '/v1/products/assets', {
      method: 'POST',
      body: JSON.stringify(toProductPayload(product)),
    });
  }

  console.log('Importing orders with real order lines, then patching demo snapshots...');
  const importResp = await requestJson<{ ok: boolean; results: Array<{ poNumber: string; orderId: string; linesSaved: number }> }>(
    endpoint,
    apiKey,
    '/v1/orders/import',
    {
      method: 'POST',
      body: JSON.stringify({
        orders: orders.map(toParsedOrder),
        overwriteExisting: true,
        mode: 'force-overwrite',
      }),
    },
  );
  const orderIdByPo = new Map((importResp.results || []).map(r => [r.poNumber, r.orderId]));
  for (const seed of orders) {
    const po = String(seed.order.poNumber || seed.order.id);
    const orderId = orderIdByPo.get(po);
    if (!orderId) throw new Error(`Import did not return orderId for ${po}`);
    await requestJson(endpoint, apiKey, `/v1/orders/${encodeURIComponent(orderId)}`, {
      method: 'PUT',
      body: JSON.stringify(toOrderPatch(seed)),
    });
  }

  console.log('Cloudflare API apply complete.');
}

async function rollbackDemoApiOnly(): Promise<void> {
  const { endpoint, apiKey } = getApiConfig();
  await requestJson(endpoint, apiKey, '/health');
  console.log(`Using Cloudflare API endpoint: ${endpoint}`);
  await rollbackDemoViaApi(endpoint, apiKey);
  console.log('Cloudflare API rollback complete.');
}

async function main(): Promise<void> {
  printSummary();
  if (dryRun) {
    console.log('');
    console.log('Dry-run only. No database connection was opened and no data was written.');
    return;
  }

  if (apiApply) {
    console.log('');
    console.log('Applying DEMO data through Cloudflare API...');
    await applyDemoViaApi();
    return;
  }

  if (apiRollback) {
    console.log('');
    console.log('Rolling back DEMO data through Cloudflare API...');
    await rollbackDemoApiOnly();
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for --apply or --rollback');
  }

  console.log('');
  console.log('WARNING: --apply/--rollback use direct Prisma, bypassing REST API route audit/sync.');
  console.log('Prefer --api-apply / --api-rollback for production safety.');

  const prisma = new PrismaClient();
  try {
    if (rollback) {
      console.log('');
      console.log('Rolling back DEMO data (direct Prisma)...');
      await rollbackDemo(prisma);
      console.log('Rollback complete.');
      return;
    }

    console.log('');
    console.log('Applying DEMO data (direct Prisma)...');
    await applyDemo(prisma);
    console.log('Apply complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
