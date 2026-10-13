/**
 * Mist Atelier 参考应用 — 演示数据。
 * 全部取自项目真实演示记录（Cedar & Crown / 顾言 / 沈禾 / DEV-G-2026-031 …）。
 * 接入真实页面时，这些结构对应 types.ts 中的业务实体；字段映射见 docs/mist-atelier/05-migration-playbook.md。
 */
import coat from './assets/coat.webp';
import blazer from './assets/blazer.webp';
import suit from './assets/suit.webp';
import clay from './assets/clay.webp';
import type { Tone } from '../../../components/mist';

export const IMG = { coat, blazer, suit, clay } as const;
export type ImgKey = keyof typeof IMG;

export const STAGES = ['需求与计划', '工厂与实物', 'QC 评审', '需求方确认', '成果留档'] as const;
export const STAGE_COLORS = ['var(--mist-ink-4)', 'var(--mist-brand-mist-1)', 'var(--mist-warn)', 'var(--mist-accent)', 'var(--mist-ok)'];

export type Dev = { id: string; name: string; style: string; owner: string; due: string; dueRel: string; late?: boolean; stage: number; state: string; tone: Tone; ver: string; fac: number; img: ImgKey; factory: string; sample: string; fabric: string; goal: string; customer: string };
export const DEVS: Dev[] = [
  { id: 'DEV-G-2026-031', name: '双面羊毛城市大衣', style: 'CC-AW27-COAT-014', owner: '顾言', due: '10/16', dueRel: '4 天后', stage: 3, state: '待需求方确认', tone: 'accent', ver: 'R2-A-2', fac: 2, img: 'coat', factory: '江南成衣', sample: 'SP-G-2026-0446', fabric: '双面羊毛 · 浅石色', goal: '开发轻量双面羊毛大衣，保留自然肩线；确认领型、手感和袖笼活动量。', customer: 'Cedar & Crown' },
  { id: 'DEV-G-2026-021', name: '炭灰细格轻结构 Blazer', style: 'CC-AW27-CHECK-003', owner: '顾言', due: '10/14', dueRel: '2 天后', late: true, stage: 2, state: '待新样复验', tone: 'bad', ver: 'R2-A-2', fac: 1, img: 'blazer', factory: '江南成衣', sample: 'SP-G-2026-0431', fabric: '炭灰细格毛混纺', goal: '按照准确版本 QC 结论修正袖长，返样复验。', customer: 'Cedar & Crown' },
  { id: 'DEV-G-2026-030', name: '雾蓝精纺羊毛西装', style: 'CC-AW27-SUIT-006', owner: '顾言', due: '10/18', dueRel: '6 天后', stage: 2, state: 'QC 待评审', tone: 'warn', ver: 'R1-A-2', fac: 2, img: 'suit', factory: '远山服装', sample: 'SP-G-2026-0439', fabric: '240g/m² 雾蓝精纺羊毛', goal: '核对 240g/m² 精纺羊毛西装的首样尺寸和袖笼活动量。', customer: 'Cedar & Crown' },
  { id: 'DEV-G-2026-032', name: '轻结构羊毛 Blazer', style: 'CC-AW27-BLZ-008', owner: '沈禾', due: '10/20', dueRel: '8 天后', stage: 1, state: '工厂制作中', tone: 'neutral', ver: 'R1-A-1', fac: 2, img: 'blazer', factory: '远山服装', sample: '—', fabric: '羊毛平纹', goal: '减少肩部结构重量，完成常规码首样并核实面料挺括度。', customer: 'Cedar & Crown' },
  { id: 'DEV-G-2026-029', name: '修身羊毛西装套装', style: 'CC-AW27-SUIT-102', owner: '沈禾', due: '10/22', dueRel: '10 天后', stage: 1, state: '实物已返样', tone: 'ok', ver: 'R2-B-1', fac: 1, img: 'suit', factory: '远山服装', sample: 'SP-G-2026-0442', fabric: '精纺羊毛', goal: '复核改版后腰围和袖长，确认套装比例。', customer: 'Cedar & Crown' },
  { id: 'DEV-G-2026-025', name: '女式短款双排扣大衣', style: 'CC-AW27-COAT-019', owner: '沈禾', due: '10/25', dueRel: '13 天后', stage: 0, state: '开发计划', tone: 'neutral', ver: '—', fac: 0, img: 'clay', factory: '待定', sample: '—', fabric: '待寻样', goal: '确认廓形、面料来源和目标价格。', customer: 'Northwind Atelier' },
];

export const FABRICS = [
  { id: 'SR-F-2026-018', name: '240g/m² 雾蓝精纺羊毛', owner: '沈禾', due: '10/15', state: '寻样中', tone: 'warn' as Tone, sub: '2 家工厂 · 3 个候选' },
  { id: 'SR-F-2026-016', name: '双面羊毛 · 浅石色', owner: '顾言', due: '10/14', state: '待发起人确认', tone: 'accent' as Tone, sub: '1 家工厂 · 2 个候选' },
  { id: 'SR-F-2026-011', name: '炭灰细格毛混纺', owner: '顾言', due: '10/09', state: '已结案', tone: 'ok' as Tone, sub: '2 家工厂 · 4 个候选' },
];

export type Order = { id: string; customer: string; season: string; lines: number; qty: number; amount: number; currency: string; due: string; progress: number; state: string; tone: Tone; owner: string; img: ImgKey };
export const ORDERS: Order[] = [
  { id: 'SO-G-2026-018', customer: 'Cedar & Crown', season: 'AW27 首批', lines: 3, qty: 2600, amount: 140800, currency: 'USD', due: '11/08', progress: 58, state: '生产中', tone: 'accent', owner: '顾言', img: 'coat' },
  { id: 'SO-G-2026-017', customer: 'Northwind Atelier', season: 'AW27 补单', lines: 2, qty: 900, amount: 41850, currency: 'USD', due: '10/30', progress: 82, state: '尾期 QC', tone: 'warn', owner: '沈禾', img: 'suit' },
  { id: 'SO-G-2026-015', customer: 'Cedar & Crown', season: 'SS27 预订', lines: 4, qty: 3200, amount: 118400, currency: 'USD', due: '12/20', progress: 12, state: '采购中', tone: 'neutral', owner: '顾言', img: 'blazer' },
  { id: 'SO-G-2026-012', customer: 'Maison Lune', season: 'AW26 返单', lines: 1, qty: 600, amount: 25200, currency: 'EUR', due: '10/12', progress: 100, state: '已出运', tone: 'ok', owner: '沈禾', img: 'clay' },
  { id: 'SO-G-2026-009', customer: 'Northwind Atelier', season: 'AW26 首批', lines: 3, qty: 1500, amount: 66300, currency: 'USD', due: '10/05', progress: 100, state: '待收尾款', tone: 'bad', owner: '顾言', img: 'coat' },
];

export const ORDER_LINES = [
  { name: '双面羊毛城市大衣', style: 'CC-AW27-COAT-014', img: 'coat' as ImgKey, qty: 1200, price: 64.0, made: 72, qc: 18 },
  { name: '雾蓝精纺羊毛西装', style: 'CC-AW27-SUIT-006', img: 'suit' as ImgKey, qty: 800, price: 48.5, made: 58, qc: 10 },
  { name: '炭灰细格轻结构 Blazer', style: 'CC-AW27-CHECK-003', img: 'blazer' as ImgKey, qty: 600, price: 42.0, made: 35, qc: 0 },
];

/** 财务：银行到账流水 × 应收发票，用于收款核销 */
export type Receipt = { id: string; date: string; payer: string; amount: number; currency: string; ref: string; state: 'unmatched' | 'suggested' | 'matched'; suggest?: string; confidence?: number };
export const RECEIPTS: Receipt[] = [
  { id: 'BR-2026-1012-03', date: '10/12', payer: 'CEDAR & CROWN LTD', amount: 42240, currency: 'USD', ref: 'DEPOSIT SO-G-2026-018', state: 'suggested', suggest: 'INV-G-2026-0412', confidence: 98 },
  { id: 'BR-2026-1011-07', date: '10/11', payer: 'NORTHWIND ATELIER AB', amount: 19890, currency: 'USD', ref: 'PO 77120 BAL', state: 'suggested', suggest: 'INV-G-2026-0398', confidence: 81 },
  { id: 'BR-2026-1009-02', date: '10/09', payer: 'MAISON LUNE SARL', amount: 25200, currency: 'EUR', ref: 'FACT 0388', state: 'matched', suggest: 'INV-G-2026-0388', confidence: 100 },
  { id: 'BR-2026-1008-05', date: '10/08', payer: 'UNKNOWN REMITTER', amount: 3120, currency: 'USD', ref: 'SAMPLE FEE', state: 'unmatched' },
];
export type Invoice = { id: string; order: string; customer: string; due: string; amount: number; open: number; currency: string; overdue?: boolean };
export const INVOICES: Invoice[] = [
  { id: 'INV-G-2026-0412', order: 'SO-G-2026-018', customer: 'Cedar & Crown', due: '10/15', amount: 42240, open: 42240, currency: 'USD' },
  { id: 'INV-G-2026-0398', order: 'SO-G-2026-009', customer: 'Northwind Atelier', due: '10/05', amount: 46410, open: 26520, currency: 'USD', overdue: true },
  { id: 'INV-G-2026-0388', order: 'SO-G-2026-012', customer: 'Maison Lune', due: '10/10', amount: 25200, open: 25200, currency: 'EUR' },
  { id: 'INV-G-2026-0405', order: 'SO-G-2026-017', customer: 'Northwind Atelier', due: '10/30', amount: 12555, open: 12555, currency: 'USD' },
];

export const CONTACTS = [
  { name: 'Emma Clarke', role: '采购总监 · 决策人', email: 'emma@cedarcrown.co.uk', tone: 'accent' as Tone },
  { name: 'Oliver Grant', role: '技术面料经理', email: 'oliver@cedarcrown.co.uk', tone: 'ok' as Tone },
  { name: 'Sophie Hale', role: '跟单 · 日常对接', email: 'sophie@cedarcrown.co.uk', tone: 'ai' as Tone },
];

/** 生产看板 */
export type Prod = { id: string; name: string; order: string; factory: string; qty: number; due: string; pct: number; img: ImgKey; risk?: string };
export const PROD_COLUMNS: Array<{ id: string; title: string; color: string }> = [
  { id: 'cut', title: '裁剪', color: 'var(--mist-brand-mist-1)' },
  { id: 'sew', title: '车缝', color: 'var(--mist-accent)' },
  { id: 'finish', title: '整烫包装', color: 'var(--mist-ai)' },
  { id: 'qc', title: '尾期 QC', color: 'var(--mist-warn)' },
  { id: 'done', title: '待出运', color: 'var(--mist-ok)' },
];
export const PRODS: Array<Prod & { col: string }> = [
  { id: 'PO-L-0418', name: '双面羊毛城市大衣', order: 'SO-G-2026-018', factory: '江南成衣', qty: 1200, due: '10/26', pct: 72, img: 'coat', col: 'sew' },
  { id: 'PO-L-0419', name: '雾蓝精纺羊毛西装', order: 'SO-G-2026-018', factory: '远山服装', qty: 800, due: '10/27', pct: 58, img: 'suit', col: 'sew', risk: '面料到货晚 2 天' },
  { id: 'PO-L-0420', name: '炭灰细格轻结构 Blazer', order: 'SO-G-2026-018', factory: '江南成衣', qty: 600, due: '10/28', pct: 35, img: 'blazer', col: 'cut' },
  { id: 'PO-L-0411', name: '修身羊毛西装套装', order: 'SO-G-2026-017', factory: '远山服装', qty: 500, due: '10/22', pct: 90, img: 'suit', col: 'qc' },
  { id: 'PO-L-0412', name: '轻结构羊毛 Blazer', order: 'SO-G-2026-017', factory: '远山服装', qty: 400, due: '10/22', pct: 86, img: 'blazer', col: 'finish' },
  { id: 'PO-L-0402', name: '羊绒混纺短大衣', order: 'SO-G-2026-012', factory: '江南成衣', qty: 600, due: '10/10', pct: 100, img: 'clay', col: 'done' },
];

export const AI_ANSWERS: Record<string, string> = {
  '细格 Blazer 为什么要复验？': 'QC 许言在 <b>R2-A-2</b> 的评审中记录袖长实测 64.7cm，标准 63.5cm，偏差 <b>+1.2cm</b>，超出 ±1.0cm 公差。江南成衣已按结论修正，新样预计 <b>10/14</b> 到达，到样后需重新评审。',
  'SO-G-2026-018 还缺什么？': '出运准备完成 2/5。缺口：<br>· <b>报关资料</b> 缺面料成分声明 1 份<br>· <b>尾期 QC</b> 待预约（建议 10/28）<br>· <b>订舱</b> 由后勤在 QC 后安排<br>交期 11/08，目前进度按计划。',
  '起草给江南成衣的提醒': '草稿：<br><br>“王经理您好，DEV-G-2026-021 细格 Blazer 新样请于 10/14 前寄达，重点复核袖长（目标 63.5cm ±1.0）。如有延期请提前告知，谢谢。—— 顾言”',
};

export const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
