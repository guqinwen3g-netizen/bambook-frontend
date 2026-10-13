/**
 * company-sim/sample-finance.ts — 样品间 + 财务补数（6 个空域一次收口，独立可重放）
 *
 * 覆盖（dev 库当前全 0 的 6 个域）：
 *   Warehouse        3 仓：主样品间 / 面料样仓 / 成衣样仓（与 SIM-WH-MAIN 主仓并立）
 *   SampleCardItem   30 张样卡：面料 12 + 成衣 8 + 辅料 5 + 色卡 5
 *                    （in_stock 19 含低库存 4 ＋ borrowed 4 ＋ retired 3）
 *   SampleCardLoan   8 笔借出：按时已还 3 ＋ 逾期已还 1（喂逾期报表）＋ 在借 4
 *                    （逾期未还 1 笔 dueAt 已过 ＋ 期内 3 笔）；借用人混合 =
 *                    内部员工（库内真实账号 3 人）/ 客户联系人（挂 Relation）/
 *                    工厂（挂 Relation）；13 周窗口分布
 *   PaymentRequest   9 条：挂采购单（attachments.sourceDocument 依 API 契约），
 *                    Draft 1 / Pending 2（喂审批流）/ Approved 2 / VoucherIssued 4
 *                    （其中 4 条全部回链真实 Disbursement 凭证——DR-017 先申请后付款）
 *   应付链（2026-09-02 补数，审计 P1：Invoice type=Payable 0 行 / Disbursement 凭证
 *   0 行——供应商对账/付款链无法演示）：
 *                    Payable 发票 9 张（挂供应商+采购单：5 Issued 未付（对应
 *                    Draft/Pending/Approved 申请单）+ 3 Paid 全额 + 1 PartiallyPaid 60%
 *                    分批付款）+ Disbursement 凭证 4 张 + InvoiceAllocation 核销 4 条，
 *                    与 PaymentRequest 状态勾稽（申请未批/未付 ⇔ 发票未付；
 *                    VoucherIssued ⇔ 凭证已出已核销）
 *   VatInvoice       7 张：进项 4（挂供应商 + 采购单；Received 2 / Verified 1 /
 *                    Declared 1）＋ 销项 3（挂客户 + 应收发票；Received 2 /
 *                    Verified 1）；三栏金额 13% 自洽（totalAmount = netAmount +
 *                    taxAmount 精确一致，与后端校验同口径）
 *   FxSettlement     4 笔结汇：挂真实回款凭证（Receipt USD/EUR），结汇额 ≤ 回款额，
 *                    3 笔汇率与凭证 exchangeRate 一致（零损益）＋ 1 笔结汇汇率低于
 *                    记账汇率 0.05 → 汇兑损失为负值（喂汇率损益/结汇台账报表）
 *
 * 约束落实：
 *   - FK 锚点全部 DB 实查（产品档案 / 开发案 / 订单 / Relation / Contact /
 *     UserAccount / 采购单 / 应收发票 / 回款凭证 / 退税单），查不到跳过该行 + warn
 *   - SIM- 前缀确定性 ID（SIM-WH-SAMPLE / SIM-SCI / SIM-SCL / SIM-PAYR /
 *     SIM-VAT / SIM-FXS 段位互不冲突）
 *   - 幂等：重跑 = 先 deleteMany 本模块 SIM 前缀再重建（确定性重放）
 *   - 已知取舍（不产生断链，仅语义留空 + warn）：
 *     ApprovalRequest / TaxRefund 不在本次范围 → Pending 的 approvalRequestId
 *     留 null（Approved/VoucherIssued 的审批单不建，语义以申请单状态承载）、
 *     Declared 的 taxRefundId 优先实挂 DB 退税单，无则留 null
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { at, isoDate, round2, round4, createManyLogged, USERS, SIM_END, DAY_MS } from './common';

const DAY = DAY_MS;

const OUR_COMPANY = '竹衍服饰（上海）有限公司';
const OUR_TAX_NO = '91310000MA1FL2XK7A';

const WH_MAIN = 'SIM-WH-SAMPLE-01';
const WH_FABRIC = 'SIM-WH-SAMPLE-02';
const WH_GARMENT = 'SIM-WH-SAMPLE-03';

const SIM_END_MS = SIM_END; // 2026-08-30

function dateOf(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}
function addDays(ms: number, d: number): number {
  return ms + d * DAY;
}
function capEnd(ms: number): number {
  return Math.min(ms, SIM_END_MS);
}

// ════════════════════════════════════════════════════════════════════
// 样卡规格表（确定性）：30 张
//   borrowed 4：SCI-005 / 015 / 025 / 028（与 4 笔在借流水一一对应）
//   retired 3：SCI-010 / 020 / 029
//   低库存 4（in_stock 且 availableQty ≤ minStock）：SCI-003 / 016 / 023 / 030
// ════════════════════════════════════════════════════════════════════
interface CardSpec {
  no: number;
  type: 'fabric' | 'garment' | 'trim' | 'colorcard';
  ai: number; // 对应资产列表下标（colorcard 忽略）
  cc?: string; // 色卡 Pantone 号（colorcard 专用）
  ccName?: string; // 色卡名（colorcard 专用）
  loc: string;
  qty: number;
  avail: number;
  min: number | null;
  max: number | null;
  unit: string;
  status: 'in_stock' | 'borrowed' | 'retired';
  note: string;
  cMs: number; // createdAt
  uMs: number; // updatedAt（≥ cMs）
  dev?: number; // devCases 下标
  ordG?: number; // garmentOrders 下标
  ordF?: number; // fabricOrders 下标
}

const CARD_SPECS: CardSpec[] = [
  // ── 面料样卡 12（面料样仓） ──
  { no: 1, type: 'fabric', ai: 0, loc: 'B-01-01', qty: 8, avail: 8, min: 3, max: 20, unit: '张', status: 'in_stock', note: '主力面料样卡，客户看样高频', cMs: at(1, 1, 9, 5), uMs: at(1, 1, 9, 5), dev: 0 },
  { no: 2, type: 'fabric', ai: 1, loc: 'B-01-02', qty: 5, avail: 5, min: 2, max: 15, unit: '张', status: 'in_stock', note: '莫代尔弹力斜纹，SS26 主推', cMs: at(1, 2, 9, 20), uMs: at(1, 2, 9, 20), dev: 1 },
  { no: 3, type: 'fabric', ai: 2, loc: 'B-01-03', qty: 4, avail: 1, min: 3, max: 10, unit: '张', status: 'in_stock', note: '低库存：客户看样消耗大，待补制', cMs: at(1, 3, 10, 10), uMs: at(11, 2, 9, 0), dev: 2 },
  { no: 4, type: 'fabric', ai: 3, loc: 'B-01-04', qty: 6, avail: 6, min: 2, max: 12, unit: '张', status: 'in_stock', note: '亚麻混纺平纹，面料外销大货主面料', cMs: at(1, 4, 9, 35), uMs: at(1, 4, 9, 35), ordF: 0 },
  { no: 5, type: 'fabric', ai: 4, loc: 'B-01-05', qty: 6, avail: 4, min: 2, max: 12, unit: '张', status: 'borrowed', note: '在借：物流出差随行客户拜访（部分借出）', cMs: at(1, 5, 11, 15), uMs: at(12, 2, 9, 0) },
  { no: 6, type: 'fabric', ai: 5, loc: 'B-01-06', qty: 3, avail: 2, min: 1, max: 8, unit: '张', status: 'in_stock', note: '全棉府绸，日常消耗后补齐', cMs: at(2, 1, 9, 45), uMs: at(10, 3, 9, 0) },
  { no: 7, type: 'fabric', ai: 6, loc: 'B-01-07', qty: 5, avail: 5, min: 2, max: 12, unit: '张', status: 'in_stock', note: '天丝斜纹，环保系列', cMs: at(2, 2, 10, 25), uMs: at(2, 2, 10, 25) },
  { no: 8, type: 'fabric', ai: 7, loc: 'B-01-08', qty: 5, avail: 5, min: 2, max: 10, unit: '张', status: 'in_stock', note: '棉锦弹力，曾借客户看样（逾期已还，见借还流水）', cMs: at(2, 3, 9, 5), uMs: at(8, 2, 14, 0), dev: 3 },
  { no: 9, type: 'fabric', ai: 8, loc: 'B-01-09', qty: 4, avail: 4, min: 2, max: 10, unit: '张', status: 'in_stock', note: '雪纺，配连衣裙系列', cMs: at(2, 4, 11, 40), uMs: at(2, 4, 11, 40) },
  { no: 10, type: 'fabric', ai: 9, loc: 'B-01-10', qty: 2, avail: 2, min: null, max: null, unit: '张', status: 'retired', note: '长期光照褪色，退役存档', cMs: at(1, 2, 9, 10), uMs: at(8, 1, 10, 0) },
  { no: 11, type: 'fabric', ai: 10, loc: 'B-01-11', qty: 7, avail: 7, min: 3, max: 15, unit: '张', status: 'in_stock', note: '棉氨汗布，针织系列主力', cMs: at(2, 5, 9, 55), uMs: at(2, 5, 9, 55) },
  { no: 12, type: 'fabric', ai: 11, loc: 'B-01-12', qty: 4, avail: 4, min: 2, max: 10, unit: '张', status: 'in_stock', note: '莫代尔针织，内搭系列', cMs: at(3, 1, 10, 15), uMs: at(3, 1, 10, 15) },
  // ── 成衣样卡 8（成衣样仓） ──
  { no: 13, type: 'garment', ai: 0, loc: 'C-01-01', qty: 2, avail: 2, min: 1, max: 5, unit: 'PC', status: 'in_stock', note: '法式碎花连衣裙 PP 样，已转大货', cMs: at(2, 1, 9, 30), uMs: at(2, 1, 9, 30), ordG: 0 },
  { no: 14, type: 'garment', ai: 1, loc: 'C-01-02', qty: 3, avail: 3, min: 2, max: 8, unit: 'PC', status: 'in_stock', note: '吊带雪纺连衣裙样衣，客户看样已还', cMs: at(2, 3, 10, 20), uMs: at(5, 2, 14, 0), ordG: 1 },
  { no: 15, type: 'garment', ai: 2, loc: 'C-01-03', qty: 2, avail: 0, min: 1, max: 4, unit: 'PC', status: 'borrowed', note: '在借：客户确认版型中', cMs: at(2, 5, 9, 50), uMs: at(11, 3, 14, 0) },
  { no: 16, type: 'garment', ai: 3, loc: 'C-01-04', qty: 1, avail: 1, min: 2, max: 4, unit: 'PC', status: 'in_stock', note: '低库存：仅剩 M 码', cMs: at(3, 2, 10, 5), uMs: at(10, 4, 9, 0) },
  { no: 17, type: 'garment', ai: 4, loc: 'C-01-05', qty: 3, avail: 3, min: 1, max: 6, unit: 'PC', status: 'in_stock', note: 'V 领雪纺衬衫，挂开发案', cMs: at(3, 4, 9, 40), uMs: at(3, 4, 9, 40), dev: 4 },
  { no: 18, type: 'garment', ai: 5, loc: 'C-01-06', qty: 4, avail: 4, min: 2, max: 8, unit: 'PC', status: 'in_stock', note: '泡泡袖衬衫，多客户轮转看样', cMs: at(3, 5, 11, 10), uMs: at(3, 5, 11, 10) },
  { no: 19, type: 'garment', ai: 6, loc: 'C-01-07', qty: 2, avail: 2, min: 1, max: 4, unit: 'PC', status: 'in_stock', note: '圆领针织上衣', cMs: at(4, 1, 9, 25), uMs: at(4, 1, 9, 25) },
  { no: 20, type: 'garment', ai: 7, loc: 'C-01-08', qty: 1, avail: 1, min: null, max: null, unit: 'PC', status: 'retired', note: '试穿磨损，退役存档', cMs: at(2, 2, 9, 15), uMs: at(7, 2, 10, 0) },
  // ── 辅料样卡 5（主样品间） ──
  { no: 21, type: 'trim', ai: 0, loc: 'A-01-01', qty: 20, avail: 20, min: 5, max: 50, unit: 'PC', status: 'in_stock', note: '尼龙隐形拉链 5#，工厂打样曾借已还', cMs: at(3, 1, 9, 20), uMs: at(7, 1, 15, 0) },
  { no: 22, type: 'trim', ai: 1, loc: 'A-01-02', qty: 12, avail: 12, min: 4, max: 24, unit: 'PC', status: 'in_stock', note: '金属拉链 8#', cMs: at(3, 3, 10, 35), uMs: at(3, 3, 10, 35) },
  { no: 23, type: 'trim', ai: 2, loc: 'A-01-03', qty: 8, avail: 2, min: 4, max: 20, unit: 'PC', status: 'in_stock', note: '低库存：树脂纽扣打样消耗大', cMs: at(3, 5, 9, 5), uMs: at(11, 4, 9, 0) },
  { no: 24, type: 'trim', ai: 3, loc: 'A-01-04', qty: 10, avail: 10, min: 4, max: 20, unit: 'PC', status: 'in_stock', note: '贝壳纽扣 20L，高单价', cMs: at(4, 2, 11, 20), uMs: at(4, 2, 11, 20) },
  { no: 25, type: 'trim', ai: 4, loc: 'A-01-05', qty: 10, avail: 6, min: 3, max: 20, unit: 'PC', status: 'borrowed', note: '在借：QC 出差比对色差（部分借出）', cMs: at(4, 4, 9, 45), uMs: at(12, 5, 16, 0) },
  // ── 色卡 5（主样品间，无产品档案挂接） ──
  { no: 26, type: 'colorcard', ai: 0, cc: '19-4052 TCX', ccName: 'Classic Blue 色卡', loc: 'A-02-01', qty: 10, avail: 10, min: 3, max: 20, unit: '张', status: 'in_stock', note: '经典蓝（Pantone 19-4052 TCX），客户看样已还', cMs: at(4, 1, 9, 10), uMs: at(5, 2, 14, 0) },
  { no: 27, type: 'colorcard', ai: 1, cc: '15-0343 TCX', ccName: 'Sage Green 色卡', loc: 'A-02-02', qty: 8, avail: 8, min: 3, max: 15, unit: '张', status: 'in_stock', note: '鼠尾草绿（15-0343 TCX），SS26 流行色', cMs: at(4, 3, 10, 30), uMs: at(4, 3, 10, 30) },
  { no: 28, type: 'colorcard', ai: 2, cc: '16-1546 TCX', ccName: 'Pastel Pink 色卡', loc: 'A-02-03', qty: 6, avail: 4, min: 2, max: 10, unit: '张', status: 'borrowed', note: '在借：工厂对色中，已逾期未还（见借还流水）', cMs: at(4, 5, 9, 15), uMs: at(9, 2, 10, 0) },
  { no: 29, type: 'colorcard', ai: 3, cc: '16-1526 TCX', ccName: 'Terracotta 色卡', loc: 'A-02-04', qty: 3, avail: 3, min: null, max: null, unit: '张', status: 'retired', note: '色号停用，退役归档', cMs: at(4, 2, 9, 50), uMs: at(9, 3, 10, 0) },
  { no: 30, type: 'colorcard', ai: 4, cc: '14-0740 TCX', ccName: 'Lemon Yellow 色卡', loc: 'A-02-05', qty: 2, avail: 2, min: 3, max: 8, unit: '张', status: 'in_stock', note: '低库存：流行色需求高，待补制', cMs: at(5, 1, 10, 40), uMs: at(10, 5, 9, 0) },
];

// ════════════════════════════════════════════════════════════════════
// 借出规格表（确定性）：8 笔
//   按时已还 3（SCL-001/002/003）＋ 逾期已还 1（SCL-004，returnedAt > dueAt，喂逾期报表）
//   在借 4（SCL-005/006/007/008，其中 SCL-007 dueAt 已过 = 逾期未还）
// ════════════════════════════════════════════════════════════════════
type BorrowerSpec =
  | { kind: 'internal'; userId: string }
  | { kind: 'customer'; relId: string } // 借用人 = 该客户 Relation 主联系人（Contact 实查）
  | { kind: 'factory'; relId: string }; // 借用人 = 供应商 Relation 本体

interface LoanSpec {
  no: number;
  item: number; // SCI 序号
  qty: number;
  borrower: BorrowerSpec;
  loanedMs: number;
  dueMs: number | null;
  returnedMs: number | null;
  conditionNote?: string;
}

const LOAN_SPECS: LoanSpec[] = [
  { no: 1, item: 1, qty: 2, borrower: { kind: 'internal', userId: USERS.salesA }, loanedMs: at(2, 2, 10, 15), dueMs: at(3, 2, 17, 0), returnedMs: at(3, 1, 11, 20) },
  { no: 2, item: 14, qty: 1, borrower: { kind: 'customer', relId: 'SIM-CUS-01' }, loanedMs: at(4, 3, 9, 30), dueMs: at(5, 3, 17, 0), returnedMs: at(5, 2, 14, 10) },
  { no: 3, item: 21, qty: 4, borrower: { kind: 'factory', relId: 'SIM-SUP-08' }, loanedMs: at(6, 2, 10, 0), dueMs: at(7, 2, 17, 0), returnedMs: at(7, 1, 15, 0) },
  { no: 4, item: 8, qty: 2, borrower: { kind: 'customer', relId: 'SIM-CUS-03' }, loanedMs: at(5, 4, 10, 0), dueMs: at(6, 4, 17, 0), returnedMs: at(8, 2, 14, 0), conditionNote: '归还时边角轻微污渍，已登记留痕（逾期 12 天归还）' },
  { no: 5, item: 5, qty: 2, borrower: { kind: 'internal', userId: USERS.logistics }, loanedMs: at(12, 2, 9, 0), dueMs: SIM_END_MS + 7 * DAY, returnedMs: null },
  { no: 6, item: 15, qty: 2, borrower: { kind: 'customer', relId: 'SIM-CUS-04' }, loanedMs: at(11, 3, 14, 0), dueMs: SIM_END_MS + 3 * DAY, returnedMs: null },
  { no: 7, item: 28, qty: 2, borrower: { kind: 'factory', relId: 'SIM-SUP-09' }, loanedMs: at(9, 2, 10, 0), dueMs: at(10, 2, 17, 0), returnedMs: null },
  { no: 8, item: 25, qty: 4, borrower: { kind: 'internal', userId: USERS.qc }, loanedMs: at(12, 5, 16, 0), dueMs: SIM_END_MS + 7 * DAY, returnedMs: null },
];

// ════════════════════════════════════════════════════════════════════
// 付款申请规格表（确定性）：9 条（Draft 1 / Pending 2 / Approved 2 / VoucherIssued 4）
// 2026-09-02：+3 条 VoucherIssued（no.7/8/9）与应付链勾稽——VoucherIssued 必须
// 回链真实 Disbursement 凭证（DR-017 先申请后付款；原 no.6 凭证回链留空是状态机违例）
// ════════════════════════════════════════════════════════════════════
interface PrSpec {
  no: number;
  poIdx: number; // 采购单锚点下标（Received 列表）
  status: 'Draft' | 'Pending' | 'Approved' | 'VoucherIssued';
  applicantId: string;
  reviewerId: string;
  category: string;
  ratio: number; // 占 PO 总额比例（1 = 全额）
  reqMs: number;
  expectedDays: number;
  remark: string;
}

const PR_SPECS: PrSpec[] = [
  { no: 1, poIdx: 0, status: 'Draft', applicantId: USERS.finance, reviewerId: USERS.financeManager, category: 'normal', ratio: 1, reqMs: at(12, 3, 10, 5), expectedDays: 7, remark: '（草稿）面料采购月结货款，核对中待提交审批' },
  { no: 2, poIdx: 1, status: 'Pending', applicantId: USERS.salesManager, reviewerId: USERS.financeManager, category: 'deposit', ratio: 0.3, reqMs: at(12, 1, 9, 40), expectedDays: 5, remark: '采购定金 30%（PO 注明先付定金排产）' },
  { no: 3, poIdx: 2, status: 'Pending', applicantId: USERS.logistics, reviewerId: USERS.financeManager, category: 'advance', ratio: 0.5, reqMs: at(12, 5, 9, 20), expectedDays: 5, remark: '预付 50% 锁定染缸排期（供应商要求预付）' },
  { no: 4, poIdx: 3, status: 'Approved', applicantId: USERS.finance, reviewerId: USERS.financeManager, category: 'normal', ratio: 1, reqMs: at(10, 2, 10, 0), expectedDays: 7, remark: '已批准，待财务排付款' },
  { no: 5, poIdx: 4, status: 'Approved', applicantId: USERS.financeManager, reviewerId: USERS.gm, category: 'normal', ratio: 1, reqMs: at(9, 3, 10, 30), expectedDays: 7, remark: '大额面料款（财务经理申请，分管副总审批）' },
  { no: 6, poIdx: 5, status: 'VoucherIssued', applicantId: USERS.finance, reviewerId: USERS.financeManager, category: 'normal', ratio: 1, reqMs: at(8, 2, 9, 15), expectedDays: 7, remark: '已批准并已出付款凭证（月结货款全额付讫并核销）' },
  { no: 7, poIdx: 6, status: 'VoucherIssued', applicantId: USERS.finance, reviewerId: USERS.financeManager, category: 'normal', ratio: 1, reqMs: at(7, 4, 10, 20), expectedDays: 7, remark: '已批准并已出付款凭证（月结货款全额付讫并核销）' },
  { no: 8, poIdx: 7, status: 'VoucherIssued', applicantId: USERS.finance, reviewerId: USERS.financeManager, category: 'normal', ratio: 1, reqMs: at(7, 2, 9, 40), expectedDays: 7, remark: '已批准并已出付款凭证（月结货款全额付讫并核销）' },
  { no: 9, poIdx: 8, status: 'VoucherIssued', applicantId: USERS.finance, reviewerId: USERS.financeManager, category: 'normal', ratio: 0.6, reqMs: at(8, 5, 10, 10), expectedDays: 7, remark: '分批付款 60%（质量保留 40% 待复验后付）' },
];

// ════════════════════════════════════════════════════════════════════
// 应付链规格表（确定性）：9 张 Payable 发票（挂供应商 + 采购单，金额 = PO 全额）
//   paid    ：发票 Paid + Disbursement 凭证全额核销（对应 PR VoucherIssued ratio=1）
//   partial ：发票 PartiallyPaid + 凭证 60% 部分核销（对应 PR VoucherIssued ratio=0.6）
//   issued  ：发票 Issued 未付（对应 PR Draft/Pending/Approved——申请未批或未排款）
// ════════════════════════════════════════════════════════════════════
interface PayableSpec {
  no: number;
  poIdx: number;
  kind: 'paid' | 'partial' | 'issued';
  ratio?: number; // partial 时的付款比例
}

const PAYABLE_SPECS: PayableSpec[] = [
  { no: 1, poIdx: 0, kind: 'issued' },
  { no: 2, poIdx: 1, kind: 'issued' },
  { no: 3, poIdx: 2, kind: 'issued' },
  { no: 4, poIdx: 3, kind: 'issued' },
  { no: 5, poIdx: 4, kind: 'issued' },
  { no: 6, poIdx: 5, kind: 'paid' },
  { no: 7, poIdx: 6, kind: 'paid' },
  { no: 8, poIdx: 7, kind: 'paid' },
  { no: 9, poIdx: 8, kind: 'partial', ratio: 0.6 },
];

// ════════════════════════════════════════════════════════════════════
// 主入口
// ════════════════════════════════════════════════════════════════════
export async function seedSampleFinance(prisma: PrismaClient): Promise<void> {
  console.log('── 样品间 + 财务补数（6 空域：Warehouse/SampleCard/PaymentRequest/VatInvoice/FxSettlement） ──');

  // ── 0. 锚点实查（全部从 DB 取，查不到跳过 + warn） ──
  const fabrics = await prisma.productAsset.findMany({
    where: { mainCategory: 'Fabric', status: 'Active', deletedAt: null },
    orderBy: { id: 'asc' }, take: 12, select: { id: true, sku: true, name: true },
  });
  const garments = await prisma.productAsset.findMany({
    where: { mainCategory: 'Garment', status: 'Active', deletedAt: null },
    orderBy: { id: 'asc' }, take: 8, select: { id: true, sku: true, name: true },
  });
  const trims = await prisma.productAsset.findMany({
    where: { mainCategory: 'Trimmings', status: 'Active', deletedAt: null },
    orderBy: { id: 'asc' }, take: 5, select: { id: true, sku: true, name: true },
  });
  const devCases = await prisma.developmentCase.findMany({
    where: { deletedAt: null }, orderBy: { id: 'asc' }, take: 5, select: { id: true },
  });
  const garmentOrders = await prisma.order.findMany({
    where: { id: { startsWith: 'SIM-ORD-' }, status: 'Delivered', deletedAt: null },
    orderBy: { id: 'asc' }, take: 2, select: { id: true },
  });
  const fabricOrders = await prisma.order.findMany({
    where: { id: { startsWith: 'SIM-FORD-' }, status: 'Delivered', deletedAt: null },
    orderBy: { id: 'asc' }, take: 1, select: { id: true },
  });
  const users = await prisma.userAccount.findMany({
    where: { id: { in: [USERS.salesA, USERS.qc, USERS.logistics, USERS.finance, USERS.financeManager, USERS.gm, USERS.salesManager] }, status: 'active', deletedAt: null },
    select: { id: true, displayName: true },
  });
  const userById = new Map(users.map((u) => [u.id, u.displayName] as const));
  const relIds = ['SIM-CUS-01', 'SIM-CUS-03', 'SIM-CUS-04', 'SIM-SUP-08', 'SIM-SUP-09'];
  const rels = await prisma.relation.findMany({
    where: { id: { in: relIds }, deletedAt: null }, select: { id: true, name: true },
  });
  const relById = new Map(rels.map((r) => [r.id, r.name] as const));
  const contacts = rels.length
    ? await prisma.contact.findMany({
        where: { relationId: { in: rels.map((r) => r.id) }, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
        select: { relationId: true, name: true },
      })
    : [];
  const contactByRel = new Map<string, string>();
  for (const c of contacts) if (!contactByRel.has(c.relationId)) contactByRel.set(c.relationId, c.name);
  const pos = await prisma.purchaseOrder.findMany({
    where: { id: { startsWith: 'SIM-PO-' }, status: 'Received', deletedAt: null },
    orderBy: { id: 'asc' }, take: 10,
    select: { id: true, poNumber: true, supplierRelationId: true, supplierName: true, totalAmount: true, orderId: true, orderDate: true, actualDeliveryDate: true },
  });
  const recvInvoices = await prisma.invoice.findMany({
    where: { type: 'Receivable', deletedAt: null, status: { in: ['Paid', 'PartiallyPaid'] } },
    orderBy: [{ issueDate: 'asc' }, { id: 'asc' }], take: 3,
    select: { id: true, invoiceNumber: true, customerRelationId: true, customerName: true, amount: true, currency: true, exchangeRate: true, issueDate: true, orderId: true },
  });
  const vouchers = await prisma.paymentVoucher.findMany({
    where: { type: 'Receipt', currency: { in: ['USD', 'EUR'] }, deletedAt: null },
    orderBy: [{ paymentDate: 'asc' }, { id: 'asc' }],
    select: { id: true, voucherNumber: true, amount: true, currency: true, exchangeRate: true, orderId: true, customerRelationId: true, customerName: true, paymentDate: true },
  });
  const taxRefund = await prisma.taxRefund.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });

  if (pos.length < 10) console.warn(`[sample-finance] 采购单锚点仅 ${pos.length}/10（付款申请/进项票按实际数量）`);
  if (recvInvoices.length < 3) console.warn(`[sample-finance] 应收发票锚点仅 ${recvInvoices.length}/3（销项票按实际数量）`);
  if (vouchers.length < 4) console.warn(`[sample-finance] 回款凭证锚点仅 ${vouchers.length}/4（结汇按实际数量）`);
  if (!taxRefund) console.warn('[sample-finance] 库内无 TaxRefund 退税单 → Declared 进项票 taxRefundId 留空（6 域范围外，不建退税单）');

  // ── 幂等清理：重跑 = 删本模块 SIM 前缀再重建（顺序防孤儿引用） ──
  await prisma.sampleCardLoan.deleteMany({ where: { id: { startsWith: 'SIM-SCL-' } } });
  await prisma.sampleCardItem.deleteMany({ where: { id: { startsWith: 'SIM-SCI-' } } });
  await prisma.warehouse.deleteMany({ where: { id: { startsWith: 'SIM-WH-SAMPLE-' } } });
  await prisma.invoiceAllocation.deleteMany({ where: { id: { startsWith: 'SIM-PALLOC-' } } });
  await prisma.paymentVoucher.deleteMany({ where: { id: { startsWith: 'SIM-DPV-' } } });
  await prisma.invoice.deleteMany({ where: { id: { startsWith: 'SIM-PINV-' } } });
  await prisma.paymentRequest.deleteMany({ where: { id: { startsWith: 'SIM-PAYR-' } } });
  await prisma.vatInvoice.deleteMany({ where: { id: { startsWith: 'SIM-VAT-' } } });
  await prisma.fxSettlement.deleteMany({ where: { id: { startsWith: 'SIM-FXS-' } } });

  // ── 1. Warehouse：3 仓（主样品间 / 面料样仓 / 成衣样仓） ──
  const whBase = BigInt(at(1, 1, 8));
  const warehouseRows: Prisma.WarehouseUncheckedCreateInput[] = [
    {
      id: WH_MAIN, code: 'SH-SAMPLE-MAIN', name: '主样品间', type: 'Main',
      address: '上海总部 3F-A 区样品间', manager: 'Grace Liu', phone: '021-5555-0101',
      isActive: true, sortOrder: 11, notes: '色卡/辅料样/工艺样集中展示，客户来访看样主场地',
      createdAt: whBase, updatedAt: whBase, deletedAt: null,
    },
    {
      id: WH_FABRIC, code: 'SH-SAMPLE-FABRIC', name: '面料样仓', type: 'Auxiliary',
      address: '上海总部 3F-B 区面料档案室', manager: 'Tony Fang', phone: '021-5555-0102',
      isActive: true, sortOrder: 12, notes: '面料实物样卡，恒温恒湿存档',
      createdAt: whBase, updatedAt: whBase, deletedAt: null,
    },
    {
      id: WH_GARMENT, code: 'SH-SAMPLE-GARMENT', name: '成衣样仓', type: 'Auxiliary',
      address: '上海总部 3F-C 区成衣样品间', manager: 'Ivy Zhang', phone: '021-5555-0103',
      isActive: true, sortOrder: 13, notes: '成衣样衣，按客户分区挂样',
      createdAt: whBase, updatedAt: whBase, deletedAt: null,
    },
  ];
  await createManyLogged(prisma, 'warehouse', 'Warehouse（样品间 3 仓）', warehouseRows);

  // ── 2. SampleCardItem：30 张样卡（产品档案/开发案/订单锚点实查） ──
  const itemRows: Prisma.SampleCardItemUncheckedCreateInput[] = [];
  const itemsByNo = new Map<number, string>(); // no → itemId（借出流水用）
  for (const s of CARD_SPECS) {
    const id = `SIM-SCI-${String(s.no).padStart(3, '0')}`;
    const assets = s.type === 'fabric' ? fabrics : s.type === 'garment' ? garments : s.type === 'trim' ? trims : [];
    const asset = s.type === 'colorcard' ? undefined : assets[s.ai];
    if (s.type !== 'colorcard' && !asset) {
      console.warn(`[sample-finance] 样卡 ${id}：${s.type} 档案第 ${s.ai} 个锚点缺失，跳过`);
      continue;
    }
    let name: string;
    if (s.type === 'colorcard') {
      name = s.ccName!;
    } else {
      const [cn, en] = asset!.name.split(' ');
      name = s.type === 'garment' ? `${cn}样衣${en ? `（${en}）` : ''}` : `${cn}样卡${en ? `（${en}）` : ''}`;
    }
    const devCaseId = s.dev !== undefined ? devCases[s.dev]?.id : undefined;
    const orderId = s.ordG !== undefined ? garmentOrders[s.ordG]?.id : s.ordF !== undefined ? fabricOrders[s.ordF]?.id : undefined;
    const warehouseId = s.type === 'fabric' ? WH_FABRIC : s.type === 'garment' ? WH_GARMENT : WH_MAIN;
    itemRows.push({
      id, code: `SC-20260610-${String(s.no).padStart(3, '0')}`, name,
      cardType: s.type, colorCardCode: s.cc ?? null, location: s.loc, status: s.status,
      notes: s.note, createdAt: BigInt(s.cMs), updatedAt: BigInt(s.uMs), deletedAt: null,
      quantity: s.qty, availableQty: s.avail, minStock: s.min, maxStock: s.max, unit: s.unit,
      warehouseId, devCaseId: devCaseId ?? null, orderId: orderId ?? null,
      productAssetId: asset?.id ?? null,
    });
    itemsByNo.set(s.no, id);
  }
  await createManyLogged(prisma, 'sampleCardItem', 'SampleCardItem（样卡 30 张）', itemRows);

  // ── 3. SampleCardLoan：8 笔借还流水（借用人锚点实查） ──
  const loanRows: Prisma.SampleCardLoanUncheckedCreateInput[] = [];
  for (const s of LOAN_SPECS) {
    const id = `SIM-SCL-${String(s.no).padStart(3, '0')}`;
    const itemId = itemsByNo.get(s.item);
    if (!itemId) {
      console.warn(`[sample-finance] 借出 ${id}：样卡 SCI-${s.item} 未建，跳过`);
      continue;
    }
    let borrowerName: string;
    let borrowerUserId: string | null = null;
    let relationId: string | null = null;
    let relationName: string | null = null;
    if (s.borrower.kind === 'internal') {
      const dn = userById.get(s.borrower.userId);
      if (!dn) {
        console.warn(`[sample-finance] 借出 ${id}：内部账号 ${s.borrower.userId} 不在库，跳过`);
        continue;
      }
      borrowerName = dn;
      borrowerUserId = s.borrower.userId;
    } else {
      const relName = relById.get(s.borrower.relId);
      if (!relName) {
        console.warn(`[sample-finance] 借出 ${id}：Relation ${s.borrower.relId} 不在库，跳过`);
        continue;
      }
      relationId = s.borrower.relId;
      relationName = relName;
      if (s.borrower.kind === 'customer') {
        borrowerName = contactByRel.get(s.borrower.relId) ?? relName;
      } else {
        borrowerName = relName;
      }
    }
    loanRows.push({
      id, itemId, loanType: 'borrow', loanQuantity: s.qty,
      borrowerName, borrowerUserId, relationId, relationName,
      loanedAt: BigInt(s.loanedMs), dueAt: s.dueMs !== null ? BigInt(s.dueMs) : null,
      returnedAt: s.returnedMs !== null ? BigInt(s.returnedMs) : null,
      conditionNote: s.conditionNote ?? null, operatorId: USERS.salesManager,
      createdAt: BigInt(s.loanedMs),
    });
  }
  await createManyLogged(prisma, 'sampleCardLoan', 'SampleCardLoan（借出流水：已还 4 含逾期 1 / 在借 4 含逾期 1）', loanRows);

  // ── 4. 应付链：Payable 发票 + Disbursement 凭证 + InvoiceAllocation（2026-09-02 补数） ──
  // 与 PaymentRequest 勾稽：凭证 attachments.paymentRequestId 留痕（DR-017 口径），
  // VoucherIssued 申请单随后回链 paymentVoucherId（见第 5 节）。
  const payableInvoiceRows: Prisma.InvoiceUncheckedCreateInput[] = [];
  const disbursementRows: Prisma.PaymentVoucherUncheckedCreateInput[] = [];
  const payableAllocRows: Prisma.InvoiceAllocationUncheckedCreateInput[] = [];
  const payableVoucherByPoIdx = new Map<number, string>(); // poIdx → Disbursement 凭证 id
  for (const s of PAYABLE_SPECS) {
    const po = pos[s.poIdx];
    if (!po) {
      console.warn(`[sample-finance] 应付发票 SIM-PINV-${String(s.no).padStart(3, '0')}：采购单锚点 ${s.poIdx} 缺失，跳过`);
      continue;
    }
    const invoiceId = `SIM-PINV-${String(s.no).padStart(3, '0')}`;
    const invNo = `SIM-PINV-${String(6001 + s.no)}`;
    const poMs = dateOf(po.orderDate);
    const recvMs = po.actualDeliveryDate ? dateOf(po.actualDeliveryDate) : poMs + 6 * DAY;
    const issueMs = capEnd(recvMs + 3 * DAY); // 供应商交货后开票
    const total = round2(Number(po.totalAmount));
    const paidAmount = s.kind === 'paid' ? total : s.kind === 'partial' ? round2(total * (s.ratio ?? 0.6)) : 0;
    const payMs = paidAmount > 0 ? capEnd(issueMs + 20 * DAY) : null; // 月结 30 天内排款
    const status = s.kind === 'paid' ? 'Paid' : s.kind === 'partial' ? 'PartiallyPaid' : 'Issued';
    const prForPo = PR_SPECS.find((p) => p.poIdx === s.poIdx);
    payableInvoiceRows.push({
      id: invoiceId, invoiceNumber: invNo,
      type: 'Payable', status,
      amount: new Prisma.Decimal(total), currency: 'CNY',
      issueDate: isoDate(issueMs), dueDate: isoDate(addDays(issueMs, 30)),
      settlementDate: s.kind === 'paid' && payMs ? isoDate(payMs) : null,
      exchangeRate: null, baseCurrency: 'CNY',
      orderId: po.orderId, customerRelationId: po.supplierRelationId, customerName: po.supplierName,
      notes: `供应商月结对账发票（挂采购单 ${po.poNumber}，13% 价税合计口径）`,
      attachments: { sourceDocument: { type: 'purchase_order', id: po.id } } as unknown as Prisma.InputJsonValue,
      ownerId: USERS.financeManager, departmentId: null,
      createdAt: BigInt(issueMs), updatedAt: BigInt(payMs ?? issueMs), deletedAt: null,
    });
    if (paidAmount > 0 && payMs !== null) {
      const voucherId = `SIM-DPV-${String(s.no).padStart(3, '0')}`;
      payableVoucherByPoIdx.set(s.poIdx, voucherId);
      disbursementRows.push({
        id: voucherId, voucherNumber: `SIM-DPV-${String(6001 + s.no)}`,
        type: 'Disbursement', voucherCategory: 'normal',
        amount: new Prisma.Decimal(paidAmount), currency: 'CNY',
        paymentDate: isoDate(payMs), paymentMethod: 'TT',
        // 凭证状态看自身核销进度（amount=appliedAmount=付款额 → 已全额核销）；月结发票的部分付款由 Invoice 状态表达
        status: 'reconciled',
        bankFee: new Prisma.Decimal(15), exchangeRate: null, baseCurrency: 'CNY',
        invoiceId, appliedAmount: new Prisma.Decimal(paidAmount),
        orderId: po.orderId, customerRelationId: po.supplierRelationId, customerName: po.supplierName,
        notes: s.kind === 'paid'
          ? `月结货款全额付讫并核销（挂采购单 ${po.poNumber}）。`
          : `分批付款 ${Math.round((s.ratio ?? 0.6) * 100)}%（质量保留余款待复验后付，挂采购单 ${po.poNumber}）。`,
        attachments: prForPo
          ? { paymentRequestId: `SIM-PAYR-${String(prForPo.no).padStart(3, '0')}` } as unknown as Prisma.InputJsonValue
          : null,
        ownerId: USERS.finance, departmentId: null,
        createdAt: BigInt(payMs), updatedAt: BigInt(payMs), deletedAt: null,
      });
      payableAllocRows.push({
        id: `SIM-PALLOC-${String(s.no).padStart(3, '0')}`, invoiceId, voucherId,
        appliedAmount: new Prisma.Decimal(paidAmount), appliedDate: isoDate(payMs),
        createdAt: BigInt(payMs), updatedAt: BigInt(payMs),
      });
    }
  }
  await createManyLogged(prisma, 'invoice', 'Invoice（Payable 应付：Issued 5 / Paid 3 / PartiallyPaid 1）', payableInvoiceRows);
  await createManyLogged(prisma, 'paymentVoucher', 'PaymentVoucher（Disbursement 付款：全额 3 + 部分 1）', disbursementRows);
  await createManyLogged(prisma, 'invoiceAllocation', 'InvoiceAllocation（应付核销 4 条）', payableAllocRows);

  // ── 5. PaymentRequest：9 条（挂采购单；VoucherIssued 回链真实 Disbursement 凭证） ──
  const prRows: Prisma.PaymentRequestUncheckedCreateInput[] = [];
  for (const s of PR_SPECS) {
    const po = pos[s.poIdx];
    if (!po) {
      console.warn(`[sample-finance] 付款申请 SIM-PAYR-${String(s.no).padStart(3, '0')}：采购单锚点 ${s.poIdx} 缺失，跳过`);
      continue;
    }
    const id = `SIM-PAYR-${String(s.no).padStart(3, '0')}`;
    const poTotal = Number(po.totalAmount);
    const amount = round2(poTotal * s.ratio);
    const decidedMs = s.status === 'Draft' ? s.reqMs
      : s.status === 'Pending' ? s.reqMs + DAY
      : s.reqMs + 2 * DAY;
    // VoucherIssued 回链真实 Disbursement 凭证（第 4 节应付链；DR-017 先申请后付款闭环）
    const wiredVoucherId = s.status === 'VoucherIssued' ? (payableVoucherByPoIdx.get(s.poIdx) ?? null) : null;
    if (s.status === 'VoucherIssued' && !wiredVoucherId) {
      console.warn(`[sample-finance] 付款申请 ${id} 状态 VoucherIssued 但应付链无对应凭证（采购单锚点 ${s.poIdx}），回链留空`);
    }
    prRows.push({
      id,
      requestNumber: `PAYR-${isoDate(s.reqMs).replace(/-/g, '')}-${String(s.no).padStart(3, '0')}`,
      supplierId: po.supplierRelationId, supplierName: po.supplierName,
      requestDate: isoDate(s.reqMs), expectedPaymentDate: isoDate(s.reqMs + s.expectedDays * DAY),
      totalAmount: new Prisma.Decimal(amount), currency: 'CNY',
      applicantId: s.applicantId, reviewerId: s.reviewerId,
      status: s.status, approvalRequestId: null, paymentVoucherId: wiredVoucherId,
      paymentCategory: s.category, ownerId: s.applicantId, departmentId: null,
      remark: `${s.remark}（挂采购单 ${po.poNumber}${s.ratio < 1 ? `，占比 ${Math.round(s.ratio * 100)}%` : '，全额'}）`,
      attachments: { sourceDocument: { type: 'purchase_order', id: po.id } } as unknown as Prisma.InputJsonValue,
      createdAt: new Date(s.reqMs), updatedAt: new Date(decidedMs), deletedAt: null,
    });
    if (s.status === 'Pending') {
      console.warn(`[sample-finance] 付款申请 ${id} 状态 Pending：ApprovalRequest 域不在本次范围，approvalRequestId 留空`);
    }
  }
  await createManyLogged(prisma, 'paymentRequest', 'PaymentRequest（Draft 1 / Pending 2 / Approved 2 / VoucherIssued 4 回链凭证）', prRows);

  // ── 6. VatInvoice：进项 4（挂供应商+采购单）+ 销项 3（挂客户+应收发票） ──
  const vatRows: Prisma.VatInvoiceUncheckedCreateInput[] = [];
  // 进项：Received 2 / Verified 1 / Declared 1（采购单锚点 pos[6..9]）
  const INPUT_SPECS = [
    { no: 1, poIdx: 6, status: 'Received' as const },
    { no: 2, poIdx: 7, status: 'Received' as const },
    { no: 3, poIdx: 8, status: 'Verified' as const },
    { no: 4, poIdx: 9, status: 'Declared' as const },
  ];
  for (const s of INPUT_SPECS) {
    const po = pos[s.poIdx];
    if (!po) {
      console.warn(`[sample-finance] 进项票 SIM-VAT-${String(s.no).padStart(3, '0')}：采购单锚点 ${s.poIdx} 缺失，跳过`);
      continue;
    }
    const poMs = dateOf(po.orderDate);
    const issueMs = capEnd(poMs + 8 * DAY);
    const verifiedMs = capEnd(poMs + 20 * DAY);
    const net = round4(Number(po.totalAmount) / 1.13);
    const tax = round4(net * 0.13);
    vatRows.push({
      id: `SIM-VAT-${String(s.no).padStart(3, '0')}`,
      vatCode: `03100260${String(s.no).padStart(2, '0')}`, vatNumber: String(24600001 + s.no),
      direction: 'Input', invoiceType: 'Special', status: s.status,
      sellerName: po.supplierName ?? '供应商',
      sellerTaxNo: `91320594MA1WCX0${String(s.no + 10)}K`,
      buyerName: OUR_COMPANY, buyerTaxNo: OUR_TAX_NO,
      issueDate: isoDate(issueMs),
      netAmount: new Prisma.Decimal(net), taxRate: new Prisma.Decimal(13),
      taxAmount: new Prisma.Decimal(tax), totalAmount: new Prisma.Decimal(round4(net + tax)),
      currency: 'CNY',
      verifiedDate: s.status === 'Received' ? null : isoDate(verifiedMs),
      deductionPeriod: s.status === 'Received' ? null : isoDate(verifiedMs).slice(0, 7),
      taxRefundId: s.status === 'Declared' ? (taxRefund?.id ?? null) : null,
      redFlushNumber: null, redFlushDate: null,
      invoiceId: null, orderId: po.orderId, relationId: po.supplierRelationId,
      notes: `采购面料增值税专用发票（挂采购单 ${po.poNumber}），13% 三栏金额自洽${s.status === 'Declared' && !taxRefund ? '；退税申报单待关联（库内暂无 TaxRefund）' : ''}`,
      attachments: null,
      createdAt: BigInt(issueMs), updatedAt: BigInt(verifiedMs), deletedAt: null,
    });
  }
  // 销项：Received 2 / Verified 1（应收发票锚点 recvInvoices[0..2]）
  const OUTPUT_SPECS = [
    { no: 5, invIdx: 0, status: 'Received' as const },
    { no: 6, invIdx: 1, status: 'Received' as const },
    { no: 7, invIdx: 2, status: 'Verified' as const },
  ];
  for (const s of OUTPUT_SPECS) {
    const inv = recvInvoices[s.invIdx];
    if (!inv) {
      console.warn(`[sample-finance] 销项票 SIM-VAT-${String(s.no).padStart(3, '0')}：应收发票锚点 ${s.invIdx} 缺失，跳过`);
      continue;
    }
    const issueMs = capEnd(dateOf(inv.issueDate) + 2 * DAY);
    const verifiedMs = capEnd(dateOf(inv.issueDate) + 15 * DAY);
    const cny = round2(Number(inv.amount) * Number(inv.exchangeRate));
    const net = round4(cny / 1.13);
    const tax = round4(net * 0.13);
    vatRows.push({
      id: `SIM-VAT-${String(s.no).padStart(3, '0')}`,
      vatCode: null, vatNumber: `2441200000000000${String(s.no - 4).padStart(4, '0')}`,
      direction: 'Output', invoiceType: 'Special', status: s.status,
      sellerName: OUR_COMPANY, sellerTaxNo: OUR_TAX_NO,
      buyerName: inv.customerName ?? '客户', buyerTaxNo: null,
      issueDate: isoDate(issueMs),
      netAmount: new Prisma.Decimal(net), taxRate: new Prisma.Decimal(13),
      taxAmount: new Prisma.Decimal(tax), totalAmount: new Prisma.Decimal(round4(net + tax)),
      currency: 'CNY',
      verifiedDate: s.status === 'Received' ? null : isoDate(verifiedMs),
      deductionPeriod: s.status === 'Received' ? null : isoDate(verifiedMs).slice(0, 7),
      taxRefundId: null, redFlushNumber: null, redFlushDate: null,
      invoiceId: inv.id, orderId: inv.orderId, relationId: inv.customerRelationId,
      notes: `内销销项专票（全电票，挂应收发票 ${inv.invoiceNumber}，${inv.currency} ${Number(inv.amount)} 按记账汇率折 CNY 口径）`,
      attachments: null,
      createdAt: BigInt(issueMs), updatedAt: BigInt(verifiedMs), deletedAt: null,
    });
  }
  await createManyLogged(prisma, 'vatInvoice', 'VatInvoice（进项 4 + 销项 3，13% 三栏自洽）', vatRows);

  // ── 7. FxSettlement：4 笔结汇（挂回款凭证；1 笔汇兑损失喂报表） ──
  const fxsRows: Prisma.FxSettlementUncheckedCreateInput[] = [];
  const RATIOS = [1, 0.6, 0.8, 0.5];
  const BANKS = ['中国银行上海分行', '中国工商银行上海分行', '中国银行上海分行', '招商银行上海分行'];
  if (vouchers.length) {
    const n = vouchers.length;
    const idxSet = new Set<number>();
    if (n >= 4) {
      [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1].forEach((i) => idxSet.add(Math.min(i, n - 1)));
    } else {
      for (let i = 0; i < n; i++) idxSet.add(i);
    }
    const picked = [...idxSet].sort((a, b) => a - b).map((i) => vouchers[i]);
    // 汇兑损失笔：优先选 USD 凭证（结汇汇率 = 记账汇率 - 0.05 → 损益为负）
    const lossIdx = Math.max(0, picked.findIndex((v) => v.currency === 'USD'));
    picked.forEach((v, i) => {
      const rate = Number(v.exchangeRate);
      const isLoss = i === lossIdx && picked.length > 1;
      const fxRate = isLoss ? round4(rate - 0.05) : rate;
      const foreignAmount = round2(Number(v.amount) * RATIOS[i]);
      const cnyAmount = round4(foreignAmount * fxRate);
      const settleMs = capEnd(dateOf(v.paymentDate) + (2 + i) * DAY);
      const seq = i + 1;
      fxsRows.push({
        id: `SIM-FXS-${String(seq).padStart(3, '0')}`,
        settlementNumber: `FXS-${isoDate(settleMs).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`,
        voucherId: v.id, orderId: v.orderId, customerRelationId: v.customerRelationId,
        settleDate: isoDate(settleMs),
        foreignAmount: new Prisma.Decimal(foreignAmount), currency: v.currency,
        fxRate: new Prisma.Decimal(fxRate), cnyAmount: new Prisma.Decimal(cnyAmount),
        bank: BANKS[i], slipNumber: `SL-${isoDate(settleMs).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`,
        notes: isLoss
          ? `结汇汇率 ${fxRate} 低于收汇记账汇率 ${rate}，产生汇兑损失 ${round4((fxRate - rate) * foreignAmount).toFixed(2)} CNY（喂汇率损益报表）`
          : `货款${RATIOS[i] >= 1 ? '全额' : `部分（${Math.round(RATIOS[i] * 100)}%）`}结汇，汇率与凭证一致，无汇兑损益`,
        createdAt: BigInt(settleMs), updatedAt: BigInt(settleMs), deletedAt: null,
      });
    });
  } else {
    console.warn('[sample-finance] 库内无 Receipt USD/EUR 凭证，跳过 FxSettlement');
  }
  await createManyLogged(prisma, 'fxSettlement', 'FxSettlement（结汇 4 笔：3 笔平价 + 1 笔汇兑损失）', fxsRows);

  console.log('── 样品间 + 财务补数完成（喂点：逾期未还借出 1 / 逾期已还 1 / 低库存 4 / 汇兑损失 1 / 审批流 Pending 2 / 退税 Declared 1） ──');
}
