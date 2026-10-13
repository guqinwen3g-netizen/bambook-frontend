// probe-v1-gaps.mjs —— 批量探针：逐条验证《v1 补完清单》里的 ① 类缺口
//
// ★ 设计原则（吸取今天 4 次误报的教训）：
//   1. **每条都查三个层级**（Prisma 模型 / 服务逻辑 / 路由或界面），单层零命中**不算结论**；
//   2. **每条的搜索词全部打印**，任何人可复核；
//   3. **不写死结论** —— 结论由"命中情况"算出；
//   4. 命中即 `hit`，零命中即 `miss`，**miss 一律标"候选"而不是"确证缺失"**。
//
// 用法：node scripts/probe-v1-gaps.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRV = path.join(ROOT, 'server/src');
const SCHEMA = path.join(ROOT, 'server/prisma/schema.prisma');

/** 收集源码（排除测试与 node_modules） */
function collect(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|__tests__|\.git/.test(p)) collect(p, acc); }
    else if (/\.(ts|tsx|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const FILES = collect(SRV);
const SCHEMA_SRC = fs.readFileSync(SCHEMA, 'utf8');

/** 在一组文件里搜多个词，返回 {hit, files, terms} */
function search(terms, files = FILES) {
  const hitFiles = new Set();
  const hitTerms = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const t of terms) {
      if (t instanceof RegExp ? t.test(s) : s.includes(t)) {
        hitFiles.add(path.relative(ROOT, f));
        hitTerms.push(t instanceof RegExp ? String(t) : t);
      }
    }
  }
  return { hit: hitFiles.size > 0, files: [...hitFiles].slice(0, 4), terms: [...new Set(hitTerms)].slice(0, 5) };
}

/** 在 schema 里搜字段/模型 */
function schemaSearch(terms) {
  const hits = terms.filter((t) => (t instanceof RegExp ? t.test(SCHEMA_SRC) : SCHEMA_SRC.includes(t)));
  return { hit: hits.length > 0, terms: hits.map((t) => String(t)) };
}

const CHECKS = [
  {
    id: '①-1', name: '超短装容差按数量分档',
    model: () => schemaSearch([/tolerancePercent/, /tolerance/i]),
    service: () => search([/\b999\b/, /\b3000\b/, /\b5000\b/, /\b5001\b/]),
    surface: () => search([/toleranceBand/i, /bandTolerance/i, /按数量分档/]),
    real: '1–999m ±5% · 1000–3000m ±3% · 3001–5000m ±2% · 5001m+ ±1%',
  },
  {
    id: '①-2', name: '大货批准（bulk approval）前置',
    model: () => schemaSearch([/bulkApproval/i, /BulkApproval/]),
    service: () => search([/bulkApproval/i, /bulk_approval/i, /大货批准/, /大货放行/]),
    surface: () => search([/bulkApprovalSentAt/i, /大货批准日/]),
    real: 'bulk approval must be sent 1 week prior to ex-mill',
  },
  {
    id: '①-3', name: '<20kg 按体积重（volumetric weight）',
    model: () => schemaSearch([/volumetric/i, /chargeableWeight/i, /volumeWeight/i]),
    service: () => search([/volumetricWeight/i, /chargeableWeight/i, /计费重/, /体积重/]),
    surface: () => search([/volumetric/i]),
    real: 'SHIPMENT LESS THAN 20 KILOS, VOLUME WEIGHT NOT ACTUAL WEIGHT',
  },
  {
    id: '①-4', name: 'B31 表（出运 > CAD 10,000）',
    model: () => schemaSearch([/\bB31\b/]),
    service: () => search([/\bB31\b/, /B31Form/i]),
    surface: () => search([/b31/i, /canadaCustomsInvoice/i]),
    real: 'B31 form must accompany shipments exceeding $10 000 Canadian funds',
  },
  {
    id: '①-6', name: '迟于 ex-mill 5 工作日 ⇒ 空运费归供应商',
    model: () => schemaSearch([/exMill/i]),
    service: () => search([/airFreightAtSellerExpense/i, /空运.*费用.*供应商/, /迟发.*空运/, /lateShipmentPenalty/i]),
    surface: () => search([/exMillDate/]),
    real: 'goods shipped 5 business days after Ex-Mill ⇒ air at the supplier expense',
  },
  {
    id: '①-7', name: '窄幅索赔扣款比例（≤3%→10% · ≤4.5%→25% · ≤6%→30%）',
    model: () => schemaSearch([/narrowWidth/i, /widthClaim/i]),
    service: () => search([/4\.5/, /narrowWidthClaim/i, /窄幅.*扣款/, /widthDeduction/i]),
    surface: () => search([/narrowWidth/i]),
    real: '与订购幅宽偏差 ≤3%→扣10% · ≤4.5%→扣25% · ≤6%→扣30%',
  },
  {
    id: '①-8', name: 'QC 检测项有阈值',
    model: () => schemaSearch([/threshold/i, /specMin/i, /specMax/i]),
    service: () => search([/\bppm\b/, /6~8|6-8/, /specMin/i, /阈值/]),
    surface: () => search([/TEST_ITEMS/]),
    real: 'pH 6~8 · 甲醛 ≤75ppm · 克重 ±5% · 缩水率家庭≤3%/干洗≤2% …（20+ 项，每项带阈值）',
  },
  {
    id: '①-11', name: '回潮率（moisture regain）',
    model: () => schemaSearch([/regain/i, /moisture/i]),
    service: () => search([/moistureRegain/i, /回潮/, /regain/i]),
    surface: () => search([/回潮/]),
    real: '合理损耗按 18.25% ±1% 回潮计算',
  },
  {
    id: '①-12', name: '保险：发票金额 110% 投保一切险及战争险',
    model: () => schemaSearch([/insurance/i]),
    service: () => search([/110%/, /一切险/, /战争险/, /AllRisks/i, /WarRisk/i]),
    surface: () => search([/insuranceAmount/i]),
    real: '由出卖人按发票金额 110% 投保一切险及战争险（PICC 1981/1/1）',
  },
  {
    id: '①-13', name: '索赔期（货到目的口岸 30/15 天内）',
    model: () => schemaSearch([/claimPeriod/i, /claimDeadline/i]),
    service: () => search([/claimPeriod/i, /索赔期/, /异议期.*天/, /claimWindow/i]),
    surface: () => search([/claimDeadline/i]),
    real: '货到目的口岸 30/15 天内提出索赔，凭公证机构检验报告',
  },
];

console.log('══ v1 缺口批量探针（三层查：模型 / 服务 / 界面）══\n');
const rows = [];
for (const c of CHECKS) {
  const m = c.model(), s = c.service(), u = c.surface();
  const levelHits = [m.hit, s.hit, u.hit].filter(Boolean).length;
  // ★ 判定规则：三层全零 ⇒ "候选缺失"；任一层命中 ⇒ "需人工判是否同一件事"
  const verdict = levelHits === 0 ? '候选缺失（三层零命中）' : `有命中（${levelHits}/3 层）— 需人工判语义`;
  rows.push({ id: c.id, name: c.name, model: m, service: s, surface: u, levelHits, verdict, real: c.real });
  console.log(`【${c.id}】${c.name}`);
  console.log(`   真实：${c.real}`);
  console.log(`   模型层：${m.hit ? '命中 ' + m.terms.join(', ') : '零命中'}`);
  console.log(`   服务层：${s.hit ? '命中 ' + s.terms.join(', ') + `（${s.files.join(' · ')}）` : '零命中'}`);
  console.log(`   界面层：${u.hit ? '命中 ' + u.terms.join(', ') : '零命中'}`);
  console.log(`   ⇒ ${verdict}\n`);
}

const missing = rows.filter((r) => r.levelHits === 0);
const partial = rows.filter((r) => r.levelHits > 0 && r.levelHits < 3);
console.log(`══ 汇总：${rows.length} 条 · 三层零命中 ${missing.length} 条 · 部分命中 ${partial.length} 条 ══`);
console.log(`三层零命中：${missing.map((r) => r.id).join(' · ') || '（无）'}`);
console.log('\n★ 纪律：三层零命中只写"候选缺失"，**不写"确证缺失"** —— 还需行为级验证（调接口看返回）才允许定罪。');
fs.writeFileSync('/tmp/probe-v1-gaps.json', JSON.stringify(rows, null, 2));
console.log('明细：/tmp/probe-v1-gaps.json');
