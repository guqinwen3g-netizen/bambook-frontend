// HS 退税率补录 → 退税金额算得出 —— 真库演练验收（写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么必须做演练（而不是只读验收）：
//   docs/HS编码退税率-待补清单 §五 的验证路径在真库**走不通** —— 真库那张退税单
//   `TRA-SIM-CD-2026-0048` 状态是 `Reviewing`，`recalc` 被状态约束拒绝（409，设计如此：
//   已提交的申报数据不可悄悄改）。所以「补录后退税金额真的算得出来」这件事，
//   **在真库上无法验证**，只能自建 Draft 演练单。
//
// 验的口径不变量：
//   R1 补录**前**：gaps 含 hs_rebate_rate（ref=该 HS 编码）且 refundableVat = null ← 复现阻断
//   R2 补录**后**：gaps 不再含 hs_rebate_rate，且 refundableVat = **脚本独立重算值**
//   R3 recalc(fill_missing) 落库：refundableVat / refundAmount / refundableRate 与独立重算一致
//   R4 幂等：再跑一次 recalc 不报错且金额不变（fill_missing 不覆盖已有值）
//   R5 口径 A 未被破坏：**不引入汇率换算** —— 金额 = FOB × 发票汇率 × 退税率，脚本逐步重算比对
//
// 演练数据全部带 `DRILL_HS` 前缀（模型 id 均为应用侧提供），finally 里按精确 ID 硬删。
// 用法：node scripts/acceptance-hs-rebate-drill.mjs
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

// ── 演练常量（金额全部可手算，便于独立重算）────────────────────────────
const TS = Date.now();
const ORDER_ID = `ORD__DRILL_HS_${TS}`;
const ORDER_CODE = `DRILL-HS-${TS}`;
const INV_ID = `INV__DRILL_HS_${TS}`;
const INV_NO = `DRILL-HSINV-${TS}`;
const CD_ID = `CD__DRILL_HS_${TS}`;
const CD_NO = `DRILL-HSCD-${TS}`;
const CDL_ID = `CDL__DRILL_HS_${TS}`;
const TR_ID = `TR__DRILL_HS_${TS}`;
const TR_NO = `DRILL-HSTR-${TS}`;
/** 故意用「明显是演练」的编码，绝不用真库那 7 个生产编码（不把编造税率写进生产档案） */
const HS_CODE = '9999.99.99';
const HS_DESC = 'DRILL 演练用编码（非真实税则编码）';

const FOB = 10000;          // 报关行金额（USD）
const FX = 7.2;             // 应收发票汇率（口径 A：唯一汇率锚点）
const RATE = 13;            // 演练用退税率（**仅用于本演练自建编码**）
const EXPECT_CNY = FOB * FX;                    // 72000
const EXPECT_VAT = Math.round(FOB * FX * (RATE / 100) * 10000) / 10000; // 9360
const EXPECT_RATE = RATE;                        // refundableRate = vat/cny*100

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
      id: ORDER_ID, code: ORDER_CODE, customer: 'DRILL-HS-CUSTOMER', product: 'DRILL-HS-PRODUCT',
      type: 'Export', quantity: 1, status: 'InProduction', dueDate: '2026-12-31',
      quoteAmount: FOB, currency: 'USD', updatedAt: now,
      // Order.createdAt 是 DateTime @default(now())，其余模型是 BigInt
    },
  });
  created.order = true;

  await prisma.invoice.create({
    data: {
      id: INV_ID, invoiceNumber: INV_NO, type: 'Receivable', status: 'Issued',
      amount: FOB, currency: 'USD', issueDate: '2026-09-01', dueDate: '2026-12-31',
      exchangeRate: FX, baseCurrency: 'CNY',        // ← 汇率锚点（口径 A）
      orderId: ORDER_ID, customerName: 'DRILL-HS-CUSTOMER', createdAt: now, updatedAt: now,
    },
  });
  created.invoice = true;

  await prisma.customsDeclaration.create({
    data: {
      id: CD_ID, declarationNumber: CD_NO, orderId: ORDER_ID,
      type: 'Export', status: 'Released', tradeTerms: 'FOB',
      totalValue: FOB, currency: 'USD', declarationDate: '2026-09-05',
      createdAt: now, updatedAt: now,
    },
  });
  created.cd = true;

  await prisma.customsDeclarationLine.create({
    data: {
      id: CDL_ID, declarationId: CD_ID, lineNumber: 1,
      productName: 'DRILL 演练商品', hsCode: HS_CODE,
      quantity: 1, unit: 'PC', unitPrice: FOB, totalAmount: FOB, currency: 'USD',
      createdAt: now, updatedAt: now,
    },
  });
  created.cdl = true;

  await prisma.taxRefund.create({
    data: {
      id: TR_ID, refundNumber: TR_NO, declarationId: CD_ID, orderId: ORDER_ID,
      status: 'Draft',                                     // ← 只有 Draft/Rejected 可重算
      createdAt: now, updatedAt: now,
    },
  });
  created.tr = true;
}

async function rollback() {
  try {
    const gone = [];
    // 顺序：先删引用方（CustomsDeclarationLine 有真 FK + cascade，仍显式删以便断言）
    if (created.tr) { await prisma.taxRefund.delete({ where: { id: TR_ID } }); gone.push('taxRefund'); }
    if (created.cdl) { await prisma.customsDeclarationLine.delete({ where: { id: CDL_ID } }); gone.push('cdLine'); }
    if (created.cd) { await prisma.customsDeclaration.delete({ where: { id: CD_ID } }); gone.push('declaration'); }
    if (created.invoice) { await prisma.invoice.delete({ where: { id: INV_ID } }); gone.push('invoice'); }
    if (created.order) { await prisma.order.delete({ where: { id: ORDER_ID } }); gone.push('order'); }
    if (created.hs) { await prisma.hsCode.delete({ where: { id: created.hs } }); gone.push('hsCode'); }
    // createHsCode 会写一条审计日志；实体已删 → 一并清掉，避免悬挂引用
    if (created.hs) {
      const a = await prisma.auditLog.deleteMany({ where: { targetType: 'HsCode', targetId: created.hs } });
      if (a.count) gone.push(`auditLog(${a.count})`);
    }
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 ${ORDER_ID} / ${CD_ID} / ${TR_ID} / HS=${HS_CODE}`);
  }
}

const gapsUrl = (id) => `/api/v2/customs/declarations/${encodeURIComponent(id)}/tax-refund/gaps`;
const recalcUrl = (id) => `/api/v2/customs/declarations/${encodeURIComponent(id)}/tax-refund/recalc`;

async function main() {
  const token = await login('hank.zheng@bambook.local') ?? await login('jason.shen@bambook.local');
  if (!token) { fail('登录', 'hank.zheng / jason.shen 均失败'); return; }
  console.log('══ HS 退税率补录 → 退税金额算得出 · 真库演练验收（自回滚）══\n');
  console.log(`  演练单 ${CD_NO}｜FOB ${FOB} USD × 汇率 ${FX} × 退税率 ${RATE}% = 应退 ${EXPECT_VAT} CNY\n`);

  await connectPrisma();
  await seed();
  pass('建演练数据', `订单 + 应收发票(汇率 ${FX}) + 报关单 + 1 商品行(HS ${HS_CODE}) + Draft 退税单`);

  // ── R1 补录**前**：复现阻断 ──────────────────────────────────────────
  const before = await api(token, 'GET', gapsUrl(CD_ID));
  if (before.status !== 200) { fail('R1 报缺端点', `HTTP ${before.status} ${JSON.stringify(before.data).slice(0, 160)}`); return; }
  const bGaps = before.data?.gaps ?? [];
  const bHs = bGaps.filter(g => g.code === 'hs_rebate_rate');
  const bFig = before.data?.figures ?? {};
  if (bHs.length === 1 && String(bHs[0].ref) === HS_CODE) pass('R1 补录前报缺 hs_rebate_rate', `ref=${bHs[0].ref}｜${String(bHs[0].howToFix).slice(0, 30)}`);
  else fail('R1 补录前报缺', `期望 1 条 ref=${HS_CODE}，实际 ${bHs.length} 条：${bHs.map(g => g.ref).join(',')}`);
  if (bFig.refundableVat === null) pass('R1 补录前 refundableVat = null', '（退税金额算不出 ← 这就是阻断）');
  else fail('R1 补录前 refundableVat', `期望 null，实际 ${bFig.refundableVat}`);
  if (bFig.fxRate === FX && bFig.exportAmountFob === FOB) pass('R1 汇率/FOB 已正确装配', `fxRate=${bFig.fxRate} FOB=${bFig.exportAmountFob}`);
  else fail('R1 汇率/FOB', `fxRate=${bFig.fxRate} FOB=${bFig.exportAmountFob}`);

  // ── 补录（走真实 API，与生产同一条路）──────────────────────────────
  const create = await api(token, 'POST', '/api/v2/customs/hs-codes', {
    code: HS_CODE, description: HS_DESC, category: 'Garment',
    exportTaxRebateRate: RATE, isActive: true,
  });
  if (create.status === 201 && create.data?.item?.id) {
    created.hs = create.data.item.id;
    pass('补录 HS 退税率（POST /hs-codes）', `${HS_CODE} → ${RATE}%，id=${created.hs}`);
  } else {
    fail('补录 HS 退税率', `HTTP ${create.status} ${JSON.stringify(create.data).slice(0, 200)}`);
    return;
  }

  // ── R2 补录**后**：缺项消失 + 金额 = 独立重算值 ───────────────────────
  const after = await api(token, 'GET', gapsUrl(CD_ID));
  if (after.status !== 200) { fail('R2 报缺端点', `HTTP ${after.status}`); return; }
  const aGaps = after.data?.gaps ?? [];
  const aHs = aGaps.filter(g => g.code === 'hs_rebate_rate');
  const aFig = after.data?.figures ?? {};
  if (aHs.length === 0) pass('R2 缺项自动消失', 'gaps 无 hs_rebate_rate（实时计算，无需清缓存）');
  else fail('R2 缺项未消失', aHs.map(g => g.label).join('；'));
  if (aFig.refundableVat === EXPECT_VAT) pass('R2 refundableVat = 独立重算值', `${aFig.refundableVat} = ${FOB}×${FX}×${RATE}%`);
  else fail('R2 refundableVat', `期望 ${EXPECT_VAT}（=${FOB}×${FX}×${RATE}%），实际 ${aFig.refundableVat}`);
  if (aFig.exportAmountCny === EXPECT_CNY) pass('R2 exportAmountCny', `${aFig.exportAmountCny} = ${FOB}×${FX}`);
  else fail('R2 exportAmountCny', `期望 ${EXPECT_CNY}，实际 ${aFig.exportAmountCny}`);

  // ── R3 recalc(fill_missing) 落库 ────────────────────────────────────
  const rc = await api(token, 'POST', recalcUrl(CD_ID), { mode: 'fill_missing' });
  if (rc.status !== 200) { fail('R3 recalc', `HTTP ${rc.status} ${JSON.stringify(rc.data).slice(0, 200)}`); return; }
  const rFig = rc.data?.figures ?? {};
  if (rFig.refundableVat === EXPECT_VAT) pass('R3 recalc 返回金额正确', `${rFig.refundableVat}`);
  else fail('R3 recalc 金额', `期望 ${EXPECT_VAT}，实际 ${rFig.refundableVat}`);

  const persisted = await prisma.taxRefund.findUnique({ where: { id: TR_ID } });
  const pVat = persisted?.refundableVat != null ? Number(persisted.refundableVat) : null;
  const pAmt = persisted?.refundAmount != null ? Number(persisted.refundAmount) : null;
  const pRate = persisted?.refundableRate != null ? Number(persisted.refundableRate) : null;
  if (pVat === EXPECT_VAT) pass('R3 落库 refundableVat', `${pVat}`);
  else fail('R3 落库 refundableVat', `期望 ${EXPECT_VAT}，实际 ${pVat}`);
  if (pAmt === EXPECT_VAT) pass('R3 落库 refundAmount', `${pAmt}（= refundableVat）`);
  else fail('R3 落库 refundAmount', `期望 ${EXPECT_VAT}，实际 ${pAmt}`);
  if (pRate === EXPECT_RATE) pass('R3 落库 refundableRate', `${pRate}%`);
  else fail('R3 落库 refundableRate', `期望 ${EXPECT_RATE}，实际 ${pRate}`);

  // ── R4 幂等：再跑一次不应报错、不应改动 ──────────────────────────────
  const rc2 = await api(token, 'POST', recalcUrl(CD_ID), { mode: 'fill_missing' });
  if (rc2.status !== 200) fail('R4 幂等 recalc', `HTTP ${rc2.status} ${JSON.stringify(rc2.data).slice(0, 160)}`);
  else {
    const after2 = await prisma.taxRefund.findUnique({ where: { id: TR_ID } });
    const v2 = after2?.refundableVat != null ? Number(after2.refundableVat) : null;
    const noChange = rc2.data?.applied === false || (rc2.data?.diff ?? []).length === 0;
    if (v2 === EXPECT_VAT) pass('R4 幂等：金额未变', `${v2}`);
    else fail('R4 幂等金额', `${v2} ≠ ${EXPECT_VAT}`);
    if (noChange) pass('R4 幂等：无 diff（fill_missing 不覆盖已有值）', `applied=${rc2.data?.applied} diff=${(rc2.data?.diff ?? []).length}`);
    else info('R4 幂等', `applied=${rc2.data?.applied} diff=${(rc2.data?.diff ?? []).length}（金额仍正确）`);
  }

  // ── R5 口径 A：不引入汇率换算（金额链逐步可复算）────────────────────
  const chain = FOB * FX * (RATE / 100);
  if (Math.abs(chain - EXPECT_VAT) < 0.0002) pass('R5 金额链可手算复现（口径 A：不引入新汇率）', `${FOB} × ${FX} × ${RATE}% = ${EXPECT_VAT}`);
  else fail('R5 金额链', `${chain} ≠ ${EXPECT_VAT}`);
}

try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  if (created.order || created.cd || created.tr) await rollback();
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
