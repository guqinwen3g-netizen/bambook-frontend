/**
 * company-sim/season-marketing.ts — 季节/趋势/展会/营销域 seed（五张空表开荒）
 *
 * 剧情（确定性，13 周窗口 2026-06-08 ~ 2026-08-30）：
 *   - Season 4 季：SS26（Active：56 单主链 + 面料外销 13 单归属，季度回顾可实时聚合）/
 *     SS26-PRE（Active：春夏预售已收官结转主季）/ AW26（Planning：12 款面料档案已挂，
 *     开发日历排定）/ AW27（Planning：调研中，无开发日历，配 Kingpin 考察计划）
 *   - TrendTag 9 枚四型齐（fabric×4 / color×1 / craft×2 / composition×2）：
 *     Balletcore 芭蕾风 / Quiet Luxury 静奢风 / Sheer & Lace 蕾丝透视 / Air-Layer 空气感 /
 *     Morandi Earth 莫兰迪大地色 / Digital Blossom 数码印花 / Botanical Dyeing 植物染色 /
 *     Recycled 再生纤维 / Tencel-Linen 天丝麻；其中 4 枚展会采集（Texworld×3 + Intertextile×1），
 *     TrendTagFabric 挂接 FabricProfile 18 链（DB 实查，缺档跳过 + warn）
 *   - TradeShow 3 场：Texworld Paris（W2 已参加，附 13 条展会线索：2 转化挂真实会后首单 /
 *     4 跟进（含 2 条逾期催办）/ 6 新 / 1 流失）；Intertextile Shanghai（W13 进行中，
 *     3 条现场新线索）；Kingpin New York（计划中，未来 6 周，AW27 调研配套）
 *   - MarketingCampaign 5 个：SS26 新品发布邮件营销（Completed W1-W6）/ SS26 社媒画册推广
 *     （Active W6-W14）/ Texworld 展会营销（Completed W2）/ 老客答谢转介绍（Active W9-W13）/
 *     AW26 开发季预热（Draft 计划中）——预算/花费/线索/转化数字段齐全，ROI 可算
 *     （actualCost > 0 且 Converted 线索带 actualValue）
 *   - MarketingLead 15 条：New 4 / Contacted 4 / Qualified 3 / Converted 2 / Lost 2，
 *     来源五通道混合（email / website / social_media / trade_show / referral）；
 *     2 条 Converted 从 DB 实查最近 Delivered 成衣单 + 面料单，挂真实 relationId /
 *     Contact 联系人 / 订单金额，notes 记录订单号——「营销线索→成交」闭环证据
 *
 * 锚点全部 DB 实查（FabricProfile / Order / Relation / Contact / UserAccount），
 * 查不到跳过 + warn；SIM- 前缀确定性 ID；createMany skipDuplicates 幂等可重放。
 * 编号避让：MarketingCampaign.code 用 SIM-MKT-2026-0xx，不占发号器 MKT-{year}-{seq} 区间。
 */

import { Prisma, PrismaClient } from '@prisma/client';
// ★ S4 任务3：营销线索闭环锚点的订单金额 ⇒ 走唯一真源
import { orderAmountOf } from '../../src/shared/orderAmount';
import { at, isoDate, round2, createManyLogged, USERS } from './common';

// ─── 确定性 ID 常量 ───
const SEASON_SS26 = 'SIM-SEA-SS26';
const SEASON_SS26_PRE = 'SIM-SEA-SS26-PRE';
const SEASON_AW26 = 'SIM-SEA-AW26';
const SEASON_AW27 = 'SIM-SEA-AW27';

const SHOW_TEXWORLD = 'SIM-TSW-001';
const SHOW_INTERTEXTILE = 'SIM-TSW-002';
const SHOW_KINGPIN = 'SIM-TSW-003';

const CAMPAIGN_EMAIL = 'SIM-MKT-001';
const CAMPAIGN_SOCIAL = 'SIM-MKT-002';
const CAMPAIGN_EXHIBITION = 'SIM-MKT-003';
const CAMPAIGN_REFERRAL = 'SIM-MKT-004';
const CAMPAIGN_AW26_PRE = 'SIM-MKT-005';

/** 展会线索转化目标（老客户新采购对接人，会后追加订单归入展会 ROI） */
const TS_CONVERT_RELS = ['SIM-CUS-02', 'SIM-CUS-05'];

// ─── 趋势标签 ↔ 面料档案挂接（FabricProfile.id 确定性，DB 实查缺档跳过） ───
const TREND_FABRIC_LINKS: Array<{ tagId: string; fabId: string; note: string }> = [
  { tagId: 'SIM-TRD-001', fabId: 'SIM-FAB-010-PF', note: '缎面本体，Balletcore 主打面料' },
  { tagId: 'SIM-TRD-001', fabId: 'SIM-FAB-009-PF', note: '欧根纱感雪纺，裙撑层叠叙事' },
  { tagId: 'SIM-TRD-002', fabId: 'SIM-FAB-001-PF', note: '天丝棉平纹，静奢基础款首选' },
  { tagId: 'SIM-TRD-002', fabId: 'SIM-FAB-005-PF', note: '高支全棉府绸，无 logo 基础款' },
  { tagId: 'SIM-TRD-002', fabId: 'SIM-FAB-006-PF', note: '精纺涤粘西装呢，通勤套装线' },
  { tagId: 'SIM-TRD-002', fabId: 'SIM-FAB-007-PF', note: '天丝斜纹，垂坠手感卖点' },
  { tagId: 'SIM-TRD-003', fabId: 'SIM-FAB-021-PF', note: '蕾丝本体，透视叠穿核心' },
  { tagId: 'SIM-TRD-003', fabId: 'SIM-FAB-024-PF', note: '仿麻雪纺，半透明罩层' },
  { tagId: 'SIM-TRD-004', fabId: 'SIM-FAB-017-PF', note: '空气层本体，廓形体量感' },
  { tagId: 'SIM-TRD-005', fabId: 'SIM-FAB-004-PF', note: '亚麻混纺，燕麦/灰绿基底' },
  { tagId: 'SIM-TRD-005', fabId: 'SIM-FAB-011-PF', note: '全棉双绉，陶土/雾霾蓝染色' },
  { tagId: 'SIM-TRD-006', fabId: 'SIM-FAB-003-PF', note: '人棉印花布，数码直喷工艺' },
  { tagId: 'SIM-TRD-007', fabId: 'SIM-FAB-005-PF', note: '全棉府绸，天然染料适配' },
  { tagId: 'SIM-TRD-007', fabId: 'SIM-FAB-013-PF', note: '棉氨汗布，吊染渐变底坯' },
  { tagId: 'SIM-TRD-008', fabId: 'SIM-FAB-015-PF', note: '涤氨网眼布，可切 GRS 再生涤' },
  { tagId: 'SIM-TRD-008', fabId: 'SIM-FAB-019-PF', note: '摇粒绒，再生涤纶主力品类' },
  { tagId: 'SIM-TRD-009', fabId: 'SIM-FAB-020-PF', note: '天丝麻针织，成分即卖点' },
  { tagId: 'SIM-TRD-009', fabId: 'SIM-FAB-007-PF', note: '天丝斜纹，同成分梭织补充' },
];

// ─── 展会线索（Texworld 13 条 + Intertextile 3 条；converted 由 DB 锚点补全） ───
interface ShowLeadDef {
  id: string;
  showId: string;
  customerName: string;
  company?: string; // converted 两条由 DB Relation.name 补全
  country?: string;
  email?: string;
  phone?: string;
  demand?: string;
  status: 'New' | 'Following' | 'Converted' | 'Lost';
  convertRelId?: string; // Converted：转化目标 Relation
  nextFollowUpAt?: string;
  notes?: string;
  createdMs: number;
  updatedMs?: number;
}

const SHOW_LEAD_DEFS: ShowLeadDef[] = [
  // Texworld Paris（W2，2026-06-15 ~ 06-18 现场收集）
  { id: 'SIM-TSL-001', showId: SHOW_TEXWORLD, customerName: 'Élodie Marchand', country: 'FR', email: 'elodie.marchand@bleumarlin.example.fr', phone: '+33-1-44-51-28-06', demand: 'AW26 再生纤维女装置面料（梭织）', status: 'Converted', convertRelId: 'SIM-CUS-05', createdMs: at(2, 1, 14), updatedMs: at(5, 3, 10) },
  { id: 'SIM-TSL-002', showId: SHOW_TEXWORLD, customerName: 'Katrin Vogel', country: 'DE', email: 'katrin.vogel@nordicapparel.example.de', phone: '+49-40-38-62-51-70', demand: '中厚梭织外套面料，AW26 开发', status: 'Converted', convertRelId: 'SIM-CUS-02', createdMs: at(2, 2, 10), updatedMs: at(6, 1, 15) },
  { id: 'SIM-TSL-003', showId: SHOW_TEXWORLD, customerName: 'Marco Bianchi', company: 'Atelier Roma S.r.l.', country: 'IT', email: 'm.bianchi@atelierroma.example.it', phone: '+39-06-482-9134', demand: '蕾丝与透视面料，AW26 系列主料', status: 'Following', nextFollowUpAt: '2026-09-04', notes: '样卡已寄，等待 AW26 色卡确认', createdMs: at(2, 2, 15), updatedMs: at(8, 4, 11) },
  { id: 'SIM-TSL-004', showId: SHOW_TEXWORLD, customerName: 'Sarah Whitfield', company: 'Bluefield Apparel Ltd', country: 'GB', email: 's.whitfield@bluefield.example.co.uk', phone: '+44-161-496-0218', demand: '泳装面料（氨纶混纺）询价', status: 'Following', nextFollowUpAt: '2026-09-10', notes: '第二轮报价跟进中', createdMs: at(2, 3, 11), updatedMs: at(10, 2, 9) },
  { id: 'SIM-TSL-005', showId: SHOW_TEXWORLD, customerName: '刘思远（Liu Siyuan）', company: 'Tokyo Aoki Trading K.K.', country: 'JP', email: 'siyuan.liu@aokitrading.example.jp', phone: '+81-3-5321-8874', demand: '精品针织小批量（MOQ 敏感）', status: 'Following', nextFollowUpAt: '2026-08-26', notes: 'MOQ 谈判中，跟进已逾期，需电话催办', createdMs: at(2, 3, 16), updatedMs: at(11, 1, 10) },
  { id: 'SIM-TSL-006', showId: SHOW_TEXWORLD, customerName: 'Pierre Laurent', company: 'Atelier du Nord', country: 'FR', email: 'p.laurent@atelierdunord.example.fr', phone: '+33-3-20-74-56-12', demand: '亚麻混纺平纹，生态认证要求', status: 'Following', nextFollowUpAt: '2026-08-28', notes: 'OEKO-TEX 证书已发，跟进已逾期', createdMs: at(2, 4, 10), updatedMs: at(12, 3, 14) },
  { id: 'SIM-TSL-007', showId: SHOW_TEXWORLD, customerName: 'Grace Kim', company: 'Seoul Mode Inc.', country: 'KR', email: 'grace.kim@seoulmode.example.kr', phone: '+82-2-517-3890', demand: '雪纺印花，K 女装线上品牌', status: 'New', nextFollowUpAt: '2026-09-02', createdMs: at(2, 2, 9) },
  { id: 'SIM-TSL-008', showId: SHOW_TEXWORLD, customerName: 'Anna Kowalska', company: 'Vistula Fashion', country: 'PL', email: 'a.kowalska@vistulafashion.example.pl', phone: '+48-22-621-7745', demand: '西装呢外套面料', status: 'New', nextFollowUpAt: '2026-09-03', createdMs: at(2, 3, 9) },
  { id: 'SIM-TSL-009', showId: SHOW_TEXWORLD, customerName: 'Daniel Silva', company: 'Amazonas Textil', country: 'BR', email: 'd.silva@amazonastextil.example.br', phone: '+55-11-3255-8060', demand: '价格敏感型基础针织', status: 'New', nextFollowUpAt: '2026-09-07', createdMs: at(2, 4, 9) },
  { id: 'SIM-TSL-010', showId: SHOW_TEXWORLD, customerName: 'Mei Chen', company: 'Pacific Textile Group', country: 'US', email: 'mei.chen@pactextile.example.com', phone: '+1-212-555-0184', demand: '大批量涤纶坯布询价', status: 'New', nextFollowUpAt: '2026-09-04', createdMs: at(2, 4, 11) },
  { id: 'SIM-TSL-011', showId: SHOW_TEXWORLD, customerName: 'Laura García', company: 'Madrid Moda', country: 'ES', email: 'l.garcia@madridmoda.example.es', phone: '+34-91-521-4407', demand: '色丁礼服面料', status: 'New', nextFollowUpAt: '2026-09-08', createdMs: at(2, 4, 14) },
  { id: 'SIM-TSL-012', showId: SHOW_TEXWORLD, customerName: '森田健二（Morita Kenji）', company: 'Osaka Textile', country: 'JP', email: 'kenji.morita@osakatextile.example.jp', phone: '+81-6-6352-1109', demand: '色丁布与礼服面料', status: 'New', nextFollowUpAt: '2026-09-09', createdMs: at(2, 4, 16) },
  { id: 'SIM-TSL-013', showId: SHOW_TEXWORLD, customerName: 'Ivan Petrov', company: 'Baltic Wear', country: 'LV', email: 'i.petrov@balticwear.example.lv', phone: '+371-67-210-534', demand: '基础款圆机针织', status: 'Lost', notes: '目标价低于成本线，已锁定波罗的海本地供应商', createdMs: at(2, 3, 13), updatedMs: at(7, 2, 10) },
  // Intertextile Shanghai（W13 进行中，2026-08-27 现场新收集）
  { id: 'SIM-TSL-014', showId: SHOW_INTERTEXTILE, customerName: 'Sofia Almeida', company: 'Lisbon Garments', country: 'PT', email: 'sofia.almeida@lisbongarments.example.pt', phone: '+351-21-342-7789', demand: '针织汗布（莫代尔混纺）', status: 'New', nextFollowUpAt: '2026-09-07', notes: '展会首日登记，待周一回访', createdMs: at(13, 4, 10) },
  { id: 'SIM-TSL-015', showId: SHOW_INTERTEXTILE, customerName: "Kevin O'Brien", company: 'Dublin Knitworks', country: 'IE', email: 'kevin.obrien@dublinknit.example.ie', phone: '+353-1-685-3304', demand: '粗针距针织（AW26）', status: 'New', nextFollowUpAt: '2026-09-08', notes: '展会现场交换样卡', createdMs: at(13, 4, 11) },
  { id: 'SIM-TSL-016', showId: SHOW_INTERTEXTILE, customerName: 'Emma van Dijk', company: 'Amsterdam Atelier', country: 'NL', email: 'emma.vandijk@amsatelier.example.nl', phone: '+31-20-523-6612', demand: '液态光泽面料（趋势标签同款）', status: 'New', nextFollowUpAt: '2026-09-09', notes: '对 SIM-TRD-009 同类成分感兴趣', createdMs: at(13, 4, 15) },
];

// ─── 营销线索（15 条；两条 Converted 由 DB 订单锚点补全） ───
interface LeadDef {
  id: string;
  campaignId: string;
  source: string; // email | website | social_media | trade_show | referral
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  status: 'New' | 'Contacted' | 'Qualified' | 'Converted' | 'Lost';
  converted?: boolean; // 从 DB 订单锚点补全（成衣/面料各一）
  estimatedValue?: number;
  notes?: string;
  createdMs: number;
}

const LEAD_DEFS: LeadDef[] = [
  // C1 SS26 新品发布邮件营销（Completed W1-W6）
  { id: 'SIM-MLD-001', campaignId: CAMPAIGN_EMAIL, source: 'email', contactName: 'Sophie Laurent', contactEmail: 'sophie@boutique-celeste.example.fr', contactPhone: '+33-4-42-18-63-07', status: 'New', estimatedValue: 12000, notes: '两次邮件触达已读，待回复', createdMs: at(1, 3, 10) },
  { id: 'SIM-MLD-002', campaignId: CAMPAIGN_EMAIL, source: 'email', contactName: 'Felix Braun', contactEmail: 'f.braun@alpenstyle.example.de', contactPhone: '+49-89-342-706-15', status: 'Contacted', estimatedValue: 26000, notes: '已回复样卡需求，安排寄样', createdMs: at(1, 4, 11) },
  { id: 'SIM-MLD-003', campaignId: CAMPAIGN_EMAIL, source: 'website', contactName: 'Yuki Sato', contactEmail: 'yuki.sato@satonuno.example.jp', contactPhone: '+81-3-6402-7719', status: 'Contacted', estimatedValue: 18000, notes: '官网表单询盘后导入邮件培育序列', createdMs: at(2, 2, 10) },
  { id: 'SIM-MLD-004', campaignId: CAMPAIGN_EMAIL, source: 'email', contactName: 'Michael Chang', contactEmail: 'm.chang@pacificouterwear.example.com', contactPhone: '+1-415-555-0126', status: 'Qualified', estimatedValue: 45000, notes: '需求明确：SS26 补单，等客户预算审批', createdMs: at(3, 1, 9) },
  { id: 'SIM-MLD-005', campaignId: CAMPAIGN_EMAIL, source: 'email', status: 'Converted', converted: true, estimatedValue: 0, notes: '', createdMs: at(1, 2, 10) },
  { id: 'SIM-MLD-006', campaignId: CAMPAIGN_EMAIL, source: 'email', contactName: 'Robert King', contactEmail: 'r.king@kingtextiles.example.co.uk', contactPhone: '+44-113-496-0284', status: 'Lost', estimatedValue: 15000, notes: '明确回复本季无采购计划', createdMs: at(4, 3, 10) },
  // C2 SS26 社媒画册推广（Active W6-W14）
  { id: 'SIM-MLD-007', campaignId: CAMPAIGN_SOCIAL, source: 'social_media', contactName: 'Valentina Rossi', contactEmail: 'v.rossi@milanoluxe.example.it', contactPhone: '+39-02-8735-4416', status: 'New', estimatedValue: 22000, notes: 'Instagram 画册评论询价', createdMs: at(7, 2, 11) },
  { id: 'SIM-MLD-008', campaignId: CAMPAIGN_SOCIAL, source: 'social_media', contactName: 'Lucas Meyer', contactEmail: 'l.meyer@hamburgatelier.example.de', contactPhone: '+49-40-228-610-73', status: 'Contacted', estimatedValue: 30000, notes: 'DM 已互关，等待需求清单', createdMs: at(8, 4, 10) },
  { id: 'SIM-MLD-009', campaignId: CAMPAIGN_SOCIAL, source: 'website', contactName: 'Aisha Rahman', contactEmail: 'aisha@klfashion.example.my', contactPhone: '+60-3-2181-4406', status: 'Qualified', estimatedValue: 60000, notes: '社媒引流官网询盘：SS26 雪纺系列，已寄样卡', createdMs: at(10, 1, 10) },
  // C3 Texworld 展会营销（Completed W2）
  { id: 'SIM-MLD-010', campaignId: CAMPAIGN_EXHIBITION, source: 'trade_show', contactName: 'Mathilde Roux', contactEmail: 'm.roux@maisonlyon.example.fr', contactPhone: '+33-4-78-62-91-03', status: 'New', estimatedValue: 35000, notes: 'Texworld 展位名片登记', createdMs: at(2, 2, 9) },
  { id: 'SIM-MLD-011', campaignId: CAMPAIGN_EXHIBITION, source: 'trade_show', contactName: 'Klaus Hoffmann', contactEmail: 'k.hoffmann@berlinmodeshop.example.de', contactPhone: '+49-30-247-881-62', status: 'Contacted', estimatedValue: 40000, notes: '展会后第二轮邮件跟进中', createdMs: at(2, 3, 10) },
  { id: 'SIM-MLD-012', campaignId: CAMPAIGN_EXHIBITION, source: 'trade_show', status: 'Converted', converted: true, estimatedValue: 0, notes: '', createdMs: at(2, 1, 15) },
  // C4 老客答谢季转介绍（Active W9-W13）
  { id: 'SIM-MLD-013', campaignId: CAMPAIGN_REFERRAL, source: 'referral', contactName: 'Nina Petrova', contactEmail: 'nina@sofiastyle.example.bg', contactPhone: '+359-2-963-4127', status: 'New', estimatedValue: 16000, notes: '老客户 Maple & Thread 转介绍', createdMs: at(9, 2, 10) },
  { id: 'SIM-MLD-014', campaignId: CAMPAIGN_REFERRAL, source: 'referral', contactName: 'David Cohen', contactEmail: 'd.cohen@tlvfashion.example.co.il', contactPhone: '+972-3-561-8340', status: 'Qualified', estimatedValue: 38000, notes: 'Nordic Apparel 转介绍，已发报价单', createdMs: at(10, 3, 11) },
  { id: 'SIM-MLD-015', campaignId: CAMPAIGN_REFERRAL, source: 'referral', contactName: 'Amira Hassan', contactEmail: 'amira@dubaiatelier.example.ae', contactPhone: '+971-4-332-6615', status: 'Lost', estimatedValue: 25000, notes: '预算与 MOQ 未谈拢', createdMs: at(11, 1, 10) },
];

// ═══════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════
export async function seedSeasonMarketing(prisma: PrismaClient): Promise<void> {
  console.log('── 季节/营销域：Season / TrendTag / TradeShow / MarketingCampaign / MarketingLead ──');
  const nowMs = at(1, 1, 9);

  // 0) DB 锚点实查 ──────────────────────────────────────────
  // 0a. FabricProfile（趋势挂接）
  const wantFabricIds = [...new Set(TREND_FABRIC_LINKS.map((l) => l.fabId))];
  const fabricProfiles = await prisma.fabricProfile.findMany({
    where: { id: { in: wantFabricIds }, deletedAt: null },
    select: { id: true },
  });
  const fabricIdOk = new Set(fabricProfiles.map((f) => f.id));
  for (const id of wantFabricIds) {
    if (!fabricIdOk.has(id)) console.warn(`  ⚠ FabricProfile ${id} 不存在，趋势面料挂接跳过`);
  }

  // 0b. Campaign 归属人（ownerId 软 FK）
  const ownerWanted = [USERS.salesManager, USERS.salesA, USERS.salesB];
  const ownerFound = await prisma.userAccount.findMany({ where: { id: { in: ownerWanted } }, select: { id: true } });
  const ownerOk = new Set(ownerFound.map((u) => u.id));
  const ownerOf = (id: string): string | null => {
    if (ownerOk.has(id)) return id;
    console.warn(`  ⚠ UserAccount ${id} 不存在，campaign.ownerId 置空`);
    return null;
  };

  // 0c. 展会线索转化目标 Relation + 会后首单（convertedAt / notes 闭环证据）
  const convertRels = await prisma.relation.findMany({
    where: { id: { in: TS_CONVERT_RELS }, category: 'Customer', deletedAt: null },
    select: { id: true, name: true },
  });
  const relNameOf = new Map(convertRels.map((r) => [r.id, r.name]));
  for (const id of TS_CONVERT_RELS) {
    if (!relNameOf.has(id)) console.warn(`  ⚠ Relation ${id} 不存在，该展会线索降级为 Following（不落转化）`);
  }

  // 0d. 营销线索闭环锚点：最近 Delivered 成衣单 + 面料单（金额/客户/联系人真源）
  const garmentOrder = await prisma.order.findFirst({
    where: { deletedAt: null, type: 'Garment', status: 'Delivered' },
    orderBy: { createdAt: 'desc' },
    // ★ S4 任务3：真源 orderAmountOf 的链是 totalNet → quoteAmount ⇒ 两者都必须在 select 里，
    //   否则 totalNet 为空时真源会静默返回 0（比原 `contractAmount ?? totalNet ?? 0` 更差）。
    select: { id: true, code: true, customerRelationId: true, contractAmount: true, totalNet: true, quoteAmount: true, currency: true, createdAt: true },
  });
  const fabricOrder = await prisma.order.findFirst({
    where: { deletedAt: null, type: 'Fabric', status: 'Delivered' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, code: true, customerRelationId: true, contractAmount: true, totalNet: true, quoteAmount: true, currency: true, createdAt: true },
  });
  if (!garmentOrder) console.warn('  ⚠ 未找到 Delivered 成衣订单，SIM-MLD-005 转化闭环降级为 Contacted');
  if (!fabricOrder) console.warn('  ⚠ 未找到 Delivered 面料订单，SIM-MLD-012 转化闭环降级为 Contacted');

  const contactOf = async (relId: string | null | undefined) => {
    if (!relId) return null;
    return prisma.contact.findFirst({
      where: { relationId: relId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { name: true, email: true, phone: true, mobile: true },
    });
  };
  const garmentContact = await contactOf(garmentOrder?.customerRelationId);
  const fabricContact = await contactOf(fabricOrder?.customerRelationId);
  const amountOf = (o: typeof garmentOrder): number => orderAmountOf(o);

  // 1) Season（4 季）──────────────────────────────────────────
  const seasonRows: Prisma.SeasonUncheckedCreateInput[] = [
    {
      id: SEASON_SS26, code: 'SS26', name: '2026 春夏（Spring/Summer）',
      startDate: '2026-01-05', endDate: '2026-06-30', status: 'Active',
      calendar: [
        { key: 'dev', label: '面料开发', startDate: '2025-09-01', endDate: '2025-10-15' },
        { key: 'sample', label: '样衣确认', startDate: '2025-10-16', endDate: '2025-11-30' },
        { key: 'order', label: '订单下达', startDate: '2025-12-01', endDate: '2025-12-31' },
        { key: 'production', label: '大货生产', startDate: '2026-01-05', endDate: '2026-03-31' },
        { key: 'shipping', label: '出运交付', startDate: '2026-04-01', endDate: '2026-08-31' },
      ] as unknown as Prisma.InputJsonValue,
      notes: '已发布上市：56 单主链与面料外销 13 单均挂本季（订单 season=SS26），季度回顾可按订单实时聚合。',
      createdAt: BigInt(nowMs), updatedAt: BigInt(nowMs), deletedAt: null,
    },
    {
      id: SEASON_SS26_PRE, code: 'SS26-PRE', name: '2026 春夏预售（Pre-Collection）',
      startDate: '2025-10-01', endDate: '2026-01-04', status: 'Active',
      calendar: [
        { key: 'dev', label: '胶囊系列开发', startDate: '2025-06-01', endDate: '2025-07-31' },
        { key: 'sample', label: '预售样衣', startDate: '2025-08-01', endDate: '2025-09-15' },
        { key: 'launch', label: '预售上架', startDate: '2025-10-01', endDate: '2025-12-15' },
      ] as unknown as Prisma.InputJsonValue,
      notes: '预售系列已收官并结转 SS26 主季；订单未拆预售标记，本季回顾为空属预期。',
      createdAt: BigInt(nowMs), updatedAt: BigInt(nowMs), deletedAt: null,
    },
    {
      id: SEASON_AW26, code: 'AW26', name: '2026 秋冬（Autumn/Winter）',
      startDate: '2026-07-01', endDate: '2026-12-31', status: 'Planning',
      calendar: [
        { key: 'research', label: '趋势调研（Texworld / Intertextile）', startDate: '2026-06-15', endDate: '2026-09-11' },
        { key: 'dev', label: '面料开发', startDate: '2026-08-24', endDate: '2026-10-30' },
        { key: 'sample', label: '样衣确认', startDate: '2026-11-02', endDate: '2026-12-18' },
        { key: 'order', label: '订单下达', startDate: '2027-01-04', endDate: '2027-02-26' },
        { key: 'production', label: '大货生产', startDate: '2027-03-01', endDate: '2027-05-31' },
        { key: 'shipping', label: '出运交付', startDate: '2027-06-01', endDate: '2027-08-31' },
      ] as unknown as Prisma.InputJsonValue,
      notes: '规划中：12 款面料档案已挂 AW26，Texworld/Intertextile 两场展会趋势采集就位，开发案待启动。',
      createdAt: BigInt(nowMs), updatedAt: BigInt(nowMs), deletedAt: null,
    },
    {
      id: SEASON_AW27, code: 'AW27', name: '2027 秋冬（调研中）',
      startDate: '2027-07-01', endDate: '2027-12-31', status: 'Planning',
      calendar: null,
      notes: '调研中：Kingpin Show New York（2026-10）考察精品洗水与丹宁工艺，流行趋势洞察阶段，未建开发日历。',
      createdAt: BigInt(nowMs), updatedAt: BigInt(nowMs), deletedAt: null,
    },
  ];
  await createManyLogged(prisma, 'season', 'Season', seasonRows);

  // 2) TradeShow（3 场）──────────────────────────────────────
  const tradeShowRows: Prisma.TradeShowUncheckedCreateInput[] = [
    {
      id: SHOW_TEXWORLD, seasonId: SEASON_AW26,
      name: 'Texworld Paris 2026 巴黎国际面料展',
      location: 'Paris, France（Paris Le Bourget）',
      startDate: '2026-06-15', endDate: '2026-06-18', boothNo: 'Hall 2 · B34',
      attendees: ['Grace Liu', 'Tony Fang', 'Vivian Chen'],
      cost: new Prisma.Decimal(186000), currency: 'CNY', status: 'Completed',
      notes: 'AW26 面料开发主力展会：莫兰迪大地色 / 蕾丝透视等趋势现场采集（见趋势标签来源），13 条展会线索，2 条已转化。',
      createdAt: BigInt(at(2, 1, 9)), updatedAt: BigInt(at(13, 1, 9)), deletedAt: null,
    },
    {
      id: SHOW_INTERTEXTILE, seasonId: SEASON_AW26,
      name: 'Intertextile Shanghai 2026 上海国际面料展',
      location: 'Shanghai, China（国家会展中心）',
      startDate: '2026-08-27', endDate: '2026-08-31', boothNo: 'Hall 5.1 · E128',
      attendees: ['Grace Liu', 'Ivy Zhang', 'Marcus Zhou'],
      cost: new Prisma.Decimal(120000), currency: 'CNY', status: 'Ongoing',
      notes: '进行中：AW26 面料补充开发，液态光泽/天丝麻成分现场初判，3 条现场新线索。',
      createdAt: BigInt(at(13, 4, 9)), updatedAt: BigInt(at(13, 4, 9)), deletedAt: null,
    },
    {
      id: SHOW_KINGPIN, seasonId: SEASON_AW27,
      name: 'Kingpin Show New York 2026 纽约精品展',
      location: 'New York, USA',
      startDate: '2026-10-13', endDate: '2026-10-14', boothNo: null,
      attendees: ['Chloe Su'],
      cost: new Prisma.Decimal(85000), currency: 'CNY', status: 'Planned',
      notes: '计划中：AW27 调研配套，考察精品洗水与丹宁工艺，展位待确认（费用为预算口径）。',
      createdAt: BigInt(at(13, 1, 9)), updatedAt: BigInt(at(13, 1, 9)), deletedAt: null,
    },
  ];
  await createManyLogged(prisma, 'tradeShow', 'TradeShow', tradeShowRows);

  // 3) TrendTag（9 枚）───────────────────────────────────────
  const trendTagRows: Prisma.TrendTagUncheckedCreateInput[] = [
    { id: 'SIM-TRD-001', seasonId: SEASON_SS26, type: 'fabric', name: 'Balletcore 芭蕾风', description: '缎面、欧根纱与蝴蝶结细节的柔美芭蕾叙事，SS26 连衣裙主线风格。', source: 'manual', tradeShowId: null, createdAt: BigInt(at(1, 2, 9)), updatedAt: BigInt(at(1, 2, 9)), deletedAt: null },
    { id: 'SIM-TRD-002', seasonId: null, type: 'fabric', name: 'Quiet Luxury 静奢风', description: '低调奢华：精纺天然纤维、无 logo 化设计与中性基础款，跨季长青趋势。', source: 'manual', tradeShowId: null, createdAt: BigInt(at(1, 2, 9)), updatedAt: BigInt(at(1, 2, 9)), deletedAt: null },
    { id: 'SIM-TRD-003', seasonId: SEASON_AW26, type: 'fabric', name: 'Sheer & Lace 蕾丝透视', description: '半透明叠穿：蕾丝 / 网眼 / 欧根纱，Texworld 现场观察到的 AW26 主导面料方向。', source: 'trade_show', tradeShowId: SHOW_TEXWORLD, createdAt: BigInt(at(2, 4, 9)), updatedAt: BigInt(at(2, 4, 9)), deletedAt: null },
    { id: 'SIM-TRD-004', seasonId: SEASON_AW26, type: 'fabric', name: 'Air-Layer 空气感廓形', description: '空气层面料与蓬松廓形回归，秋冬保暖与体量感并存。', source: 'manual', tradeShowId: null, createdAt: BigInt(at(1, 2, 9)), updatedAt: BigInt(at(1, 2, 9)), deletedAt: null },
    { id: 'SIM-TRD-005', seasonId: SEASON_AW26, type: 'color', name: 'Morandi Earth 莫兰迪大地色', description: '低饱和灰调大地色系：燕麦、灰绿、陶土，Texworld AW26 色卡主力。', source: 'trade_show', tradeShowId: SHOW_TEXWORLD, createdAt: BigInt(at(2, 4, 9)), updatedAt: BigInt(at(2, 4, 9)), deletedAt: null },
    { id: 'SIM-TRD-006', seasonId: SEASON_SS26, type: 'craft', name: 'Digital Blossom 数码印花', description: '高精度数码印花工艺：小批量快反花型，SS26 人棉印花主力工艺。', source: 'manual', tradeShowId: null, createdAt: BigInt(at(1, 2, 9)), updatedAt: BigInt(at(1, 2, 9)), deletedAt: null },
    { id: 'SIM-TRD-007', seasonId: null, type: 'craft', name: 'Botanical Dyeing 植物染色', description: '植物染整工艺趋势：天然染料与吊染渐变，跨季环保叙事。', source: 'manual', tradeShowId: null, createdAt: BigInt(at(1, 2, 9)), updatedAt: BigInt(at(1, 2, 9)), deletedAt: null },
    { id: 'SIM-TRD-008', seasonId: null, type: 'composition', name: 'Recycled 再生纤维', description: 'GRS 认证再生涤纶 / 再生棉混纺，欧洲客户询盘高频成分要求。', source: 'manual', tradeShowId: null, createdAt: BigInt(at(1, 2, 9)), updatedAt: BigInt(at(1, 2, 9)), deletedAt: null },
    { id: 'SIM-TRD-009', seasonId: SEASON_AW26, type: 'composition', name: 'Tencel-Linen 天丝麻', description: '天丝×亚麻混纺：垂坠感与天然肌理平衡，Intertextile 现场初判热门成分。', source: 'trade_show', tradeShowId: SHOW_INTERTEXTILE, createdAt: BigInt(at(13, 4, 9)), updatedAt: BigInt(at(13, 4, 9)), deletedAt: null },
  ];
  await createManyLogged(prisma, 'trendTag', 'TrendTag', trendTagRows);

  // 4) TrendTagFabric（18 链，FabricProfile DB 实查）────────
  const trendFabricRows: Prisma.TrendTagFabricUncheckedCreateInput[] = TREND_FABRIC_LINKS
    .filter((l) => fabricIdOk.has(l.fabId))
    .map((l, i) => ({
      id: `SIM-TRF-${String(i + 1).padStart(3, '0')}`,
      trendTagId: l.tagId, fabricId: l.fabId, note: l.note,
      createdAt: BigInt(at(2, 4, 10)),
    }));
  await createManyLogged(prisma, 'trendTagFabric', 'TrendTagFabric', trendFabricRows);

  // 5) TradeShowLead（16 条，Converted 挂会后首单闭环）─────
  const showStartMs = at(2, 1, 0); // Texworld 开展
  const showLeadRows: Prisma.TradeShowLeadUncheckedCreateInput[] = [];
  for (const d of SHOW_LEAD_DEFS) {
    let status = d.status;
    let convertedRelationId: string | null = null;
    let convertedAt: bigint | null = null;
    let company = d.company ?? null;
    let notes = d.notes ?? null;

    if (d.status === 'Converted' && d.convertRelId) {
      if (relNameOf.has(d.convertRelId)) {
        convertedRelationId = d.convertRelId;
        company = relNameOf.get(d.convertRelId)!;
        // 会后首单 = 真实闭环证据（convertedAt 与订单对齐）
        const firstOrderAfterShow = await prisma.order.findFirst({
          where: { deletedAt: null, customerRelationId: d.convertRelId, createdAt: { gt: new Date(showStartMs) } },
          orderBy: { createdAt: 'asc' },
          select: { code: true, createdAt: true },
        });
        convertedAt = firstOrderAfterShow
          ? BigInt(firstOrderAfterShow.createdAt.getTime())
          : BigInt(d.updatedMs ?? d.createdMs);
        notes = firstOrderAfterShow
          ? `展会新采购对接人，会后首单 ${firstOrderAfterShow.code}（${isoDate(firstOrderAfterShow.createdAt.getTime())}）转化入档，展会 ROI 归因客户。`
          : '展会新采购对接人，会后转化为客户档案（暂无会后订单，按跟进时间落转化）。';
      } else {
        status = 'Following';
        company = d.company ?? `${d.customerName}（未建档）`;
        notes = '转化目标 Relation 不存在，暂按跟进中处理。';
      }
    }

    showLeadRows.push({
      id: d.id, tradeShowId: d.showId,
      customerName: d.customerName, company, country: d.country ?? null,
      email: d.email ?? null, phone: d.phone ?? null, demand: d.demand ?? null,
      status, convertedRelationId, convertedAt,
      nextFollowUpAt: d.nextFollowUpAt ?? null, notes,
      createdAt: BigInt(d.createdMs), updatedAt: BigInt(d.updatedMs ?? d.createdMs), deletedAt: null,
    });
  }
  await createManyLogged(prisma, 'tradeShowLead', 'TradeShowLead', showLeadRows);

  // 6) MarketingCampaign（5 个，code 避开发号器区间）────────
  const campaignRows: Prisma.MarketingCampaignUncheckedCreateInput[] = [
    {
      id: CAMPAIGN_EMAIL, code: 'SIM-MKT-2026-001',
      name: 'SS26 新品发布邮件营销',
      description: '面向 A/B 级存量客户的 SS26 新品发布邮件序列（3 触达），含样卡预约与专属报价入口。',
      type: 'email', status: 'Completed',
      startDate: '2026-06-08', endDate: '2026-07-19',
      budget: new Prisma.Decimal(8000), actualCost: new Prisma.Decimal(7640),
      targetSegment: { tier: ['A', 'B'], region: ['US', 'DE', 'JP', 'FR'] } as unknown as Prisma.InputJsonValue,
      seasonId: SEASON_SS26, tradeShowId: null,
      ownerId: ownerOf(USERS.salesManager), departmentId: null,
      createdAt: BigInt(at(1, 1, 9)), updatedAt: BigInt(at(6, 5, 9)), deletedAt: null,
    },
    {
      id: CAMPAIGN_SOCIAL, code: 'SIM-MKT-2026-002',
      name: 'SS26 社媒画册推广（Instagram / LINE）',
      description: 'SS26 画册社媒投放：lookbook 拆条 + 博主寄样，私域询盘导入官网表单。',
      type: 'socialMedia', status: 'Active',
      startDate: '2026-07-13', endDate: '2026-09-11',
      budget: new Prisma.Decimal(15000), actualCost: new Prisma.Decimal(9860),
      targetSegment: { channel: ['Instagram', 'LINE'], audience: 'overseas boutique buyers' } as unknown as Prisma.InputJsonValue,
      seasonId: SEASON_SS26, tradeShowId: null,
      ownerId: ownerOf(USERS.salesA), departmentId: null,
      createdAt: BigInt(at(6, 1, 9)), updatedAt: BigInt(at(13, 1, 9)), deletedAt: null,
    },
    {
      id: CAMPAIGN_EXHIBITION, code: 'SIM-MKT-2026-003',
      name: 'Texworld Paris 2026 展会营销',
      description: 'AW26 面料招商参展：展位搭建 + 会前邀约 + 现场线索收集，费用含差旅与样品海运。',
      type: 'exhibition', status: 'Completed',
      startDate: '2026-06-15', endDate: '2026-06-18',
      budget: new Prisma.Decimal(186000), actualCost: new Prisma.Decimal(186000),
      targetSegment: { objective: 'AW26 面料招商' } as unknown as Prisma.InputJsonValue,
      seasonId: SEASON_AW26, tradeShowId: SHOW_TEXWORLD,
      ownerId: ownerOf(USERS.salesManager), departmentId: null,
      createdAt: BigInt(at(2, 1, 9)), updatedAt: BigInt(at(2, 4, 18)), deletedAt: null,
    },
    {
      id: CAMPAIGN_REFERRAL, code: 'SIM-MKT-2026-004',
      name: '老客户答谢季（转介绍激励）',
      description: 'A 级客户答谢礼盒 + 转介绍返佣激励（1%），新线索由老客户背书进入培育池。',
      type: 'referral', status: 'Active',
      startDate: '2026-08-03', endDate: '2026-09-04',
      budget: new Prisma.Decimal(12000), actualCost: new Prisma.Decimal(11200),
      targetSegment: { tier: ['A'], incentive: '返佣 1%' } as unknown as Prisma.InputJsonValue,
      seasonId: null, tradeShowId: null,
      ownerId: ownerOf(USERS.salesManager), departmentId: null,
      createdAt: BigInt(at(9, 1, 9)), updatedAt: BigInt(at(13, 1, 9)), deletedAt: null,
    },
    {
      id: CAMPAIGN_AW26_PRE, code: 'SIM-MKT-2026-005',
      name: 'AW26 开发季社媒预热',
      description: 'AW26 趋势面料（莫兰迪大地色 / 天丝麻）预告投放，配合 Intertextile 会后内容运营。',
      type: 'socialMedia', status: 'Draft',
      startDate: '2026-09-14', endDate: '2026-10-30',
      budget: new Prisma.Decimal(10000), actualCost: null,
      targetSegment: { channel: ['Instagram', 'LinkedIn'], theme: 'AW26 开发季预热' } as unknown as Prisma.InputJsonValue,
      seasonId: SEASON_AW26, tradeShowId: null,
      ownerId: ownerOf(USERS.salesB), departmentId: null,
      createdAt: BigInt(at(13, 2, 9)), updatedAt: BigInt(at(13, 2, 9)), deletedAt: null,
    },
  ];
  await createManyLogged(prisma, 'marketingCampaign', 'MarketingCampaign', campaignRows);

  // 7) MarketingLead（15 条，2 条 Converted 挂真实订单闭环）──
  const leadRows: Prisma.MarketingLeadUncheckedCreateInput[] = [];
  for (const d of LEAD_DEFS) {
    let status: string = d.status;
    let relationId: string | null = null;
    let contactName = d.contactName ?? null;
    let contactEmail = d.contactEmail ?? null;
    let contactPhone = d.contactPhone ?? null;
    let estimatedValue = d.estimatedValue ? new Prisma.Decimal(d.estimatedValue) : null;
    let actualValue: Prisma.Decimal | null = null;
    let convertedAt: bigint | null = null;
    let notes = d.notes ?? null;

    if (d.converted) {
      // 闭环锚点：最近 Delivered 订单（成衣→SIM-MLD-005 / 面料→SIM-MLD-012）
      const o = d.id === 'SIM-MLD-005' ? garmentOrder : fabricOrder;
      if (o && o.customerRelationId) {
        const contact = d.id === 'SIM-MLD-005' ? garmentContact : fabricContact;
        status = 'Converted';
        relationId = o.customerRelationId;
        if (contact) {
          contactName = contact.name;
          contactEmail = contact.email;
          contactPhone = contact.phone ?? contact.mobile ?? null;
        } else {
          console.warn(`  ⚠ Relation ${o.customerRelationId} 无 Contact，线索联系人置空`);
        }
        const amount = amountOf(o);
        actualValue = new Prisma.Decimal(round2(amount));
        estimatedValue = new Prisma.Decimal(round2(amount * (d.id === 'SIM-MLD-005' ? 1.15 : 1.1)));
        convertedAt = BigInt(o.createdAt.getTime());
        notes = `已转化成交：${d.id === 'SIM-MLD-005' ? '成衣' : '面料'}订单 ${o.code}（${o.id}，${isoDate(o.createdAt.getTime())}），金额 ${round2(amount)} ${o.currency}——营销线索→订单闭环。`;
      } else {
        status = 'Contacted';
        estimatedValue = new Prisma.Decimal(30000);
        notes = '订单锚点缺失，转化未落库（降级为跟进中）。';
        console.warn(`  ⚠ ${d.id} 转化闭环锚点缺失，降级为 Contacted`);
      }
    }

    leadRows.push({
      id: d.id, campaignId: d.campaignId, relationId, source: d.source,
      contactName, contactEmail, contactPhone,
      status, estimatedValue, actualValue, convertedAt, notes,
      createdAt: BigInt(d.createdMs), updatedAt: BigInt(convertedAt ?? d.createdMs), deletedAt: null,
    });
  }
  await createManyLogged(prisma, 'marketingLead', 'MarketingLead', leadRows);

  // 8) 闭环证据回执
  const garAmt = garmentOrder ? round2(amountOf(garmentOrder)) : null;
  const fabAmt = fabricOrder ? round2(amountOf(fabricOrder)) : null;
  console.log(`  闭环证据：SIM-MLD-005（邮件营销）→ ${garmentOrder ? `${garmentOrder.code}（${garmentOrder.currency} ${garAmt}）` : '（跳过）'}`);
  console.log(`  闭环证据：SIM-MLD-012（展会营销）→ ${fabricOrder ? `${fabricOrder.code}（${fabricOrder.currency} ${fabAmt}）` : '（跳过）'}`);
}
