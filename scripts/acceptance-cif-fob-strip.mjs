// CIF/CFR 退税运保费剥离 —— 真库演练验收（走真实 API 写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么必须做演练（而不是只读验收）：
//   「填运费 → 退税基数变对」是一条**写路径**：要改报关单、要生成退税草稿、要重算落库。
//   真库里那张退税单是 Reviewing（已提交不可改），所以在真库上无法验证这条链，
//   只能自建 Draft 演练单（与 acceptance-hs-rebate-drill.mjs 同一范式）。
//
// 验的口径不变量（R1–R9）：
//   R1 CIF 未登记运保费 → 报 freight_missing，**FOB 与退税额都是 null**（复现「不给数」）
//   R2 登记运费但缺保费 → insurance_missing，仍不给数（**不给半成品**「毛额−运费」）
//   R3 两项都登记 → FOB = 毛额 − 运费 − 保费（脚本独立手算比对）
//   R4 ★ 钱也剥离：refundableVat = FOB × 汇率 × 退税率，**不是**毛额 × 汇率 × 退税率
//      （第一刀只修了 FOB 字段没修钱；本脚本 R4 是钉住钱的那一条）
//   R5 recalc(fill_missing) 落库后，DB 里的金额与 R3/R4 一致
//   R6 清空运费（改回未登记）→ 立刻转回不给数，**不留旧数**
//   R7 CFR → 只剥运费，**保费不参与**（不误剥）
//   R8 FOB 单 → 即使登记了运保费也不剥（不误剥）
//   R9 剥离后 ≤0 → 报 fob_not_positive（**不是** freight_missing，不叫用户去填已填的字段）
//   R10 DDP → trade_terms_unsupported，且**不报 freight_missing**（不误导用户去补运费）
//
// 演练数据全部带 DRILL-CIF 前缀（模型 id 由脚本显式提供），finally 里按精确 ID 硬删 + 独立复核零残留。
// 用法：node scripts/acceptance-cif-fob-strip.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

// ── 演练常量（金额可手算，便于独立重算）──────────────────────────────
const TS = Date.now();
const ORDER_ID = `ORD__DRILL_CIF_${TS}`;
const ORDER_CODE = `DRILL-CIF-ORD-${TS}`;
const INV_ID = `INV__DRILL_CIF_${TS}`;
const INV_NO = `DRILL-CIFINV-${TS}`;
const HS_CODE = '9999.99.98';        // 演练专用（明显非真实税则编码）
const HS_DESC = 'DRILL CIF 演练用编码（非真实税则编码）';

const GROSS = 100000;   // 申报总额（CIF 口径：含运保费）
const FREIGHT = 3000;   // 报关单登记的运费
const INSURANCE = 500;  // 报关单登记的保费
const FX = 7.2;         // 应收发票汇率（口径 A：唯一汇率锚点）
const RATE = 13;        // 演练用退税率（仅用于本演练自建编码）

const FOB_CIF = GROSS - FREIGHT - INSURANCE;              // 96500
const FOB_CFR = GROSS - FREIGHT;                          // 97000
const CNY_CIF = round4(FOB_CIF * FX);                     // 694800
const VAT_CIF = round4(FOB_CIF * FX * (RATE / 100));      // 90324
const VAT_WRONG = round4(GROSS * FX * (RATE / 100));      // 93600（修复前会拿到的虚高值）
const VAT_WRONG_CFR = round4(GROSS * FX * (RATE / 100));

function round4(n) { return Math.round(n * 10000) / 10000; }

let prisma = null;
const created = {};

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
  const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient } = req('@prisma/client');
  prisma = new PrismaClient();
}

async function seed() {
  const now = BigInt(Date.now());
  await prisma.order.create({
    data: {
      id: ORDER_ID, code: ORDER_CODE, customer: 'DRILL-CIF-CUSTOMER', product: 'DRILL-CIF-PRODUCT',
      type: 'Export', quantity: 1, status: 'InProduction', dueDate: '2026-12-31',
      quoteAmount: GROSS, currency: 'USD', updatedAt: now,
    },
  });
  created.order = true;

  await prisma.invoice.create({
    data: {
      id: INV_ID, invoiceNumber: INV_NO, type: 'Receivable', status: 'Issued',
      amount: GROSS, currency: 'USD', issueDate: '2026-09-01', dueDate: '2026-12-31',
      exchangeRate: FX, baseCurrency: 'CNY',
      orderId: ORDER_ID, customerName: 'DRILL-CIF-CUSTOMER', createdAt: now, updatedAt: now,
    },
  });
  created.invoice = true;
}

async function rollback() {
  try {
    const gone = [];
    // 顺序：引用方 → 被引用方。EntityLink / AuditLog 是联动副作用，一并清（否则留悬挂引用）
    if (created.trId) {
      await prisma.entityLink.deleteMany({ where: { OR: [{ fromId: created.trId }, { toId: created.trId }] } }).catch(() => {});
      await prisma.taxRefund.deleteMany({ where: { id: created.trId } });
      gone.push('taxRefund');
    }
    if (created.cdId || created.cd2Id) {
      for (const id of [created.cdId, created.cd2Id].filter(Boolean)) {
        const lines = await prisma.customsDeclarationLine.deleteMany({ where: { declarationId: id } });
        if (lines.count) gone.push(`cdLine(${lines.count})`);
        const links = await prisma.entityLink.deleteMany({ where: { OR: [{ fromId: id }, { toId: id }] } });
        if (links.count) gone.push(`entityLink(${links.count})`);
        await prisma.customsDeclaration.deleteMany({ where: { id } });
        gone.push('declaration');
      }
    }
    // 审计日志：报关单/退税单的创建与更新都会写（targetId 即实体 id）
    const auditIds = [created.cdId, created.cd2Id, created.trId].filter(Boolean);
    if (auditIds.length) {
      const a = await prisma.auditLog.deleteMany({ where: { targetId: { in: auditIds } } });
      if (a.count) gone.push(`auditLog(${a.count})`);
    }
    if (created.invoice) { await prisma.invoice.delete({ where: { id: INV_ID } }); gone.push('invoice'); }
    if (created.order) { await prisma.order.delete({ where: { id: ORDER_ID } }); gone.push('order'); }
    if (created.hs) {
      await prisma.hsCode.delete({ where: { id: created.hs } });
      const a = await prisma.auditLog.deleteMany({ where: { targetType: 'HsCode', targetId: created.hs } });
      gone.push(`hsCode${a.count ? `+auditLog(${a.count})` : ''}`);
    }
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 ORDER=${ORDER_ID} CD=${created.cdId} TR=${created.trId} HS=${HS_CODE}`);
  }
}

/** 独立复核零残留（不信回滚自述，按精确标识回查） */
async function verifyNoResidue() {
  const checks = [];
  for (const [label, id] of [['cd1', created.cdId], ['cd2', created.cd2Id]]) {
    if (!id) continue;
    checks.push([`${label}:declaration`, await prisma.customsDeclaration.count({ where: { id } })]);
    checks.push([`${label}:cdLine`, await prisma.customsDeclarationLine.count({ where: { declarationId: id } })]);
    checks.push([`${label}:entityLink`, await prisma.entityLink.count({ where: { OR: [{ fromId: id }, { toId: id }] } })]);
    checks.push([`${label}:auditLog`, await prisma.auditLog.count({ where: { targetId: id } })]);
  }
  if (created.trId) checks.push(['taxRefund', await prisma.taxRefund.count({ where: { id: created.trId } })]);
  checks.push(['order', await prisma.order.count({ where: { id: ORDER_ID } })]);
  checks.push(['invoice', await prisma.invoice.count({ where: { id: INV_ID } })]);
  checks.push(['hsCode', await prisma.hsCode.count({ where: { code: HS_CODE } })]);
  const dirty = checks.filter(([, n]) => n > 0);
  if (dirty.length === 0) pass('回滚复核：零残留', checks.map(([k]) => k).join('/') + ' 全为 0');
  else fail('回滚复核：仍有残留', dirty.map(([k, n]) => `${k}=${n}`).join(' '));
}

const gapsUrl = (id) => `/api/v2/customs/declarations/${encodeURIComponent(id)}/tax-refund/gaps`;
const recalcUrl = (id) => `/api/v2/customs/declarations/${encodeURIComponent(id)}/tax-refund/recalc`;
const declUrl = (id) => `/api/v2/customs/declarations/${encodeURIComponent(id)}`;

async function gaps(token, id) {
  const r = await api(token, 'GET', gapsUrl(id));
  return { status: r.status, gaps: r.data?.gaps ?? [], fig: r.data?.figures ?? {} };
}
const codes = (g) => g.map((x) => x.code);

async function main() {
  const token = await login('hank.zheng@bambook.local') ?? await login('jason.shen@bambook.local');
  if (!token) { fail('登录', 'hank.zheng / jason.shen 均失败'); return; }
  console.log('══ CIF/CFR 退税运保费剥离 · 真库演练验收（真实 API 写路径 + 自回滚）══\n');
  console.log(`  申报毛额 ${GROSS} USD｜运费 ${FREIGHT}｜保费 ${INSURANCE}｜汇率 ${FX}｜退税率 ${RATE}%`);
  console.log(`  正确退税额（CIF）= ${FOB_CIF} × ${FX} × ${RATE}% = ${VAT_CIF}`);
  console.log(`  修复前会拿到（毛额算）= ${VAT_WRONG}  → 虚高 ${round4(VAT_WRONG - VAT_CIF)}\n`);

  await connectPrisma();
  await seed();
  pass('建演练底账', `订单 + 应收发票(汇率 ${FX})`);

  // 演练用 HS 编码（退税率）
  const hs = await api(token, 'POST', '/api/v2/customs/hs-codes', {
    code: HS_CODE, description: HS_DESC, category: 'Garment', exportTaxRebateRate: RATE, isActive: true,
  });
  if (hs.status === 201 && hs.data?.item?.id) {
    created.hs = hs.data.item.id;
    pass('补录演练 HS 退税率', `${HS_CODE} → ${RATE}%`);
  } else { fail('补录 HS 退税率', `HTTP ${hs.status} ${JSON.stringify(hs.data).slice(0, 160)}`); return; }

  // ── 建报关单（**走 API**：真实创建路径，验证 freightAmount/insuranceAmount 被接住）──
  const create = await api(token, 'POST', '/api/v2/customs/declarations', {
    type: 'Export', tradeTerms: 'CIF', currency: 'USD', totalValue: GROSS,
    orderId: ORDER_ID, relationId: undefined, declarationDate: '2026-09-05',
    // 故意**不填**运保费 —— 复现「CIF 未登记运保费」
    lines: [{ productName: 'DRILL CIF 演练商品', hsCode: HS_CODE, quantity: 1, unit: 'PC', unitPrice: GROSS, totalAmount: GROSS, currency: 'USD' }],
  });
  if (create.status !== 201 || !create.data?.item?.id) {
    fail('建报关单（POST /declarations）', `HTTP ${create.status} ${JSON.stringify(create.data).slice(0, 200)}`);
    return;
  }
  created.cdId = create.data.item.id;
  const cdNo = create.data.item.declarationNumber;
  pass('建 CIF 报关单（不填运保费）', `${cdNo}｜毛额 ${GROSS}`);

  // ── 生成退税草稿（**走 API**：报关放行自动核算那条路）────────────────
  const trCreate = await api(token, 'POST', `/api/v2/customs/tax-refunds/from-declaration/${encodeURIComponent(created.cdId)}`);
  if (trCreate.status !== 201 && trCreate.status !== 200) {
    fail('生成退税草稿（from-declaration）', `HTTP ${trCreate.status} ${JSON.stringify(trCreate.data).slice(0, 200)}`);
    return;
  }
  created.trId = trCreate.data?.item?.id ?? trCreate.data?.id;
  const trFob0 = trCreate.data?.item?.exportAmountFob ?? null;
  if (created.trId) pass('生成退税草稿', `${trCreate.data?.item?.refundNumber}（Draft）`);
  else { fail('生成退税草稿', '返回无 id'); return; }
  if (trFob0 == null) pass('R1 草稿生成时 FOB 为 null', '（算不出就不落数，不留半成品）');
  else fail('R1 草稿 FOB', `期望 null，实际 ${trFob0}`);

  // ── R1 CIF 未登记运保费 → 不给数 ────────────────────────────────────
  let g = await gaps(token, created.cdId);
  if (g.status !== 200) { fail('R1 报缺端点', `HTTP ${g.status}`); return; }
  if (codes(g.gaps).includes('freight_missing')) pass('R1 报 freight_missing', g.gaps.find((x) => x.code === 'freight_missing').label.slice(0, 60));
  else fail('R1 报 freight_missing', `实际 gaps=${codes(g.gaps).join(',')}`);
  if (g.fig.exportAmountFob === null && g.fig.refundAmount === null) pass('R1 FOB 与退税额都是 null', '（fail-closed，不拿毛额冒充 FOB）');
  else fail('R1 不给数', `exportAmountFob=${g.fig.exportAmountFob} refundAmount=${g.fig.refundAmount}`);

  // ── R2 只登记运费 → 仍不给数（不给「毛额−运费」这个半成品）────────────
  let put = await api(token, 'PUT', declUrl(created.cdId), { freightAmount: FREIGHT });
  if (put.status !== 200) { fail('R2 登记运费（PUT）', `HTTP ${put.status} ${JSON.stringify(put.data).slice(0, 160)}`); return; }
  const putFreight = put.data?.item?.freightAmount;
  if (Number(putFreight) === FREIGHT) pass('R2 运费登记成功并回读', `freightAmount=${putFreight}`);
  else fail('R2 运费回读', `期望 ${FREIGHT}，实际 ${putFreight}`);
  g = await gaps(token, created.cdId);
  if (codes(g.gaps).includes('insurance_missing')) pass('R2 转报 insurance_missing', '（缺保费）');
  else fail('R2 报 insurance_missing', `实际 gaps=${codes(g.gaps).join(',')}`);
  if (g.fig.exportAmountFob === null) pass('R2 仍不给数', '（缺一项就不给，不返回半成品）');
  else fail('R2 半成品泄漏', `exportAmountFob=${g.fig.exportAmountFob}`);

  // ── R3 两项都登记 → FOB = 毛额 − 运费 − 保费 ────────────────────────
  put = await api(token, 'PUT', declUrl(created.cdId), { insuranceAmount: INSURANCE });
  if (put.status !== 200) { fail('R3 登记保费（PUT）', `HTTP ${put.status}`); return; }
  g = await gaps(token, created.cdId);
  if (codes(g.gaps).filter((c) => c.endsWith('_missing')).length === 0) pass('R3 运保费缺项消失', `gaps=${codes(g.gaps).join(',') || '（空）'}`);
  else fail('R3 缺项未消失', codes(g.gaps).join(','));
  if (g.fig.exportAmountFob === FOB_CIF) pass('R3 FOB = 毛额 − 运费 − 保费', `${GROSS} − ${FREIGHT} − ${INSURANCE} = ${g.fig.exportAmountFob}`);
  else fail('R3 FOB', `期望 ${FOB_CIF}，实际 ${g.fig.exportAmountFob}`);
  if (g.fig.exportAmountCny === CNY_CIF) pass('R3 FOB 折 CNY', `${FOB_CIF} × ${FX} = ${g.fig.exportAmountCny}`);
  else fail('R3 exportAmountCny', `期望 ${CNY_CIF}，实际 ${g.fig.exportAmountCny}`);

  // ── R4 ★ 钱也要剥离（本脚本最关键的一条）────────────────────────────
  if (g.fig.refundableVat === VAT_CIF) pass('R4 ★ 退税额按 FOB 算', `${FOB_CIF} × ${FX} × ${RATE}% = ${g.fig.refundableVat}`);
  else fail('R4 ★ 退税额', `期望 ${VAT_CIF}，实际 ${g.fig.refundableVat}${g.fig.refundableVat === VAT_WRONG ? '（= 按毛额算的虚高值！）' : ''}`);
  if (g.fig.refundableVat !== VAT_WRONG) pass('R4 ★ 不等于毛额口径的虚高值', `≠ ${VAT_WRONG}（虚高差 ${round4(VAT_WRONG - VAT_CIF)}）`);
  else fail('R4 ★ 退税额仍是毛额口径', `= ${VAT_WRONG}（虚高未修）`);
  if (g.fig.refundableRate === RATE) pass('R4 退税率是真实退税率', `${g.fig.refundableRate}%（毛额口径会凑出 ${round4((VAT_WRONG / CNY_CIF) * 100)}% 这种不存在的数）`);
  else fail('R4 refundableRate', `期望 ${RATE}，实际 ${g.fig.refundableRate}`);

  // ── R5 recalc 落库 ─────────────────────────────────────────────────
  const rc = await api(token, 'POST', recalcUrl(created.cdId), { mode: 'fill_missing' });
  if (rc.status !== 200) { fail('R5 recalc', `HTTP ${rc.status} ${JSON.stringify(rc.data).slice(0, 200)}`); return; }
  const dbTr = await prisma.taxRefund.findUnique({ where: { id: created.trId } });
  const n = (v) => (v == null ? null : Number(v));
  const rows = [
    ['exportAmountFob', n(dbTr?.exportAmountFob), FOB_CIF],
    ['exportAmountCny', n(dbTr?.exportAmountCny), CNY_CIF],
    ['refundableVat', n(dbTr?.refundableVat), VAT_CIF],
    ['refundAmount', n(dbTr?.refundAmount), VAT_CIF],
    ['refundableRate', n(dbTr?.refundableRate), RATE],
  ];
  for (const [field, actual, want] of rows) {
    if (actual === want) pass(`R5 落库 ${field}`, `${actual}`);
    else fail(`R5 落库 ${field}`, `期望 ${want}，实际 ${actual}`);
  }

  // ── R6 清空运费 → 立刻转回不给数（不留旧数）──────────────────────────
  put = await api(token, 'PUT', declUrl(created.cdId), { freightAmount: null });
  if (put.status !== 200) { fail('R6 清空运费（PUT null）', `HTTP ${put.status}`); return; }
  if (put.data?.item?.freightAmount == null) pass('R6 运费已清空并回读为 null', '（undefined=不改 / null=清空 语义生效）');
  else fail('R6 清空语义', `期望 null，实际 ${put.data?.item?.freightAmount}`);
  g = await gaps(token, created.cdId);
  if (g.fig.exportAmountFob === null && codes(g.gaps).includes('freight_missing')) pass('R6 转回不给数', '（改回未登记 → 旧数不残留）');
  else fail('R6 转回不给数', `exportAmountFob=${g.fig.exportAmountFob} gaps=${codes(g.gaps).join(',')}`);

  // ── R7 CFR → 只剥运费（保费不参与）──────────────────────────────────
  await api(token, 'PUT', declUrl(created.cdId), { tradeTerms: 'CFR', freightAmount: FREIGHT });
  g = await gaps(token, created.cdId);
  if (g.fig.exportAmountFob === FOB_CFR) pass('R7 CFR 只剥运费', `${GROSS} − ${FREIGHT} = ${g.fig.exportAmountFob}（保费 ${INSURANCE} 未参与）`);
  else fail('R7 CFR FOB', `期望 ${FOB_CFR}，实际 ${g.fig.exportAmountFob}`);
  if (g.fig.refundableVat !== VAT_WRONG_CFR && g.fig.refundableVat === round4(FOB_CFR * FX * (RATE / 100))) pass('R7 CFR 退税额同步剥离', `${g.fig.refundableVat}`);
  else fail('R7 CFR 退税额', `期望 ${round4(FOB_CFR * FX * (RATE / 100))}，实际 ${g.fig.refundableVat}`);

  // ── R8 FOB 单 → 不剥（即使运保费还挂着）─────────────────────────────
  await api(token, 'PUT', declUrl(created.cdId), { tradeTerms: 'FOB' });
  g = await gaps(token, created.cdId);
  if (g.fig.exportAmountFob === GROSS) pass('R8 FOB 单不剥', `= ${g.fig.exportAmountFob}（运保费 ${FREIGHT}/${INSURANCE} 已登记但不动）`);
  else fail('R8 FOB 单', `期望 ${GROSS}，实际 ${g.fig.exportAmountFob}`);

  // ── R9 剥离后 ≤0 → fob_not_positive（不是 freight_missing）───────────
  // 用**第二张报关单**：毛额取「明细行合计」（有行时 totalValue 不参与），
  // 故必须在建单时就把行金额设为 1000，PUT 改不动行。
  const create2 = await api(token, 'POST', '/api/v2/customs/declarations', {
    type: 'Export', tradeTerms: 'CIF', currency: 'USD', totalValue: 1000,
    orderId: ORDER_ID, declarationDate: '2026-09-06',
    freightAmount: 900, insuranceAmount: 200,   // 运保费 ≥ 申报额 → 数据异常
    lines: [{ productName: 'DRILL CIF 异常数据行', hsCode: HS_CODE, quantity: 1, unit: 'PC', unitPrice: 1000, totalAmount: 1000, currency: 'USD' }],
  });
  if (create2.status !== 201) { fail('R9 建第二张报关单', `HTTP ${create2.status} ${JSON.stringify(create2.data).slice(0, 160)}`); return; }
  created.cd2Id = create2.data.item.id;
  // POST 直接带运保费 → 同时验证创建路径也接住了这两个字段
  if (Number(create2.data.item.freightAmount) === 900 && Number(create2.data.item.insuranceAmount) === 200) {
    pass('R9 POST 创建时运保费即被接住', 'freightAmount=900 insuranceAmount=200');
  } else {
    fail('R9 POST 运保费', `回读 freight=${create2.data.item.freightAmount} insurance=${create2.data.item.insuranceAmount}`);
  }

  g = await gaps(token, created.cd2Id);
  if (codes(g.gaps).includes('fob_not_positive')) pass('R9 报 fob_not_positive', g.gaps.find((x) => x.code === 'fob_not_positive').label.slice(0, 60));
  else fail('R9 报缺码', `期望 fob_not_positive，实际 gaps=${codes(g.gaps).join(',') || '（空）'}`);
  if (!codes(g.gaps).includes('freight_missing')) pass('R9 不误报 freight_missing', '（运保费都登记了，不该叫用户去填已填的字段）');
  else fail('R9 误报 freight_missing', '会把用户引到「填一个已经填了的字段」');
  if (g.fig.exportAmountFob === null && g.fig.refundAmount === null) pass('R9 不给数', '（不产出 0 或负数退税额）');
  else fail('R9 给了数', `exportAmountFob=${g.fig.exportAmountFob} refundAmount=${g.fig.refundAmount}`);

  // ── R10 DDP → trade_terms_unsupported，且不报 freight_missing ────────
  await api(token, 'PUT', declUrl(created.cd2Id), { tradeTerms: 'DDP' });
  g = await gaps(token, created.cd2Id);
  if (codes(g.gaps).includes('trade_terms_unsupported')) pass('R10 报 trade_terms_unsupported', g.gaps.find((x) => x.code === 'trade_terms_unsupported').label.slice(0, 56));
  else fail('R10 报缺码', `期望 trade_terms_unsupported，实际 gaps=${codes(g.gaps).join(',')}`);
  if (!codes(g.gaps).includes('freight_missing')) pass('R10 不误导去补运费', '（D 组是不核算，不是漏填）');
  else fail('R10 误报 freight_missing', 'D 组不该引导用户去补运费');
  if (g.fig.exportAmountFob === null) pass('R10 D 组不给数', '（本票不自动核算）');
  else fail('R10 D 组给了数', `exportAmountFob=${g.fig.exportAmountFob}`);
}

try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  if (prisma) {
    if (created.order || created.cdId || created.trId) await rollback();
    await verifyNoResidue();
  }
  const ok = results.filter((r) => r.ok === true).length;
  const bad = results.filter((r) => r.ok === false).length;
  const notes = results.filter((r) => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
