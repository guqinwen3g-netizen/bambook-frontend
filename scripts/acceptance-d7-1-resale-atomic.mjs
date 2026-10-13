// D7-① 米样转售 —— **成功路径**真库演练验收（写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么需要这个脚本：
//   既有的 `acceptance-d7-1-sample-conversion.mjs` 只跑「必然被拒」的路径，
//   其头部注释写明「成功路径会写 StockMovement（append-only），不适合在真库跑」——
//   于是**转售的成功路径从未在真 HTTP 链路上跑过**。
//   本次修掉了「样品侧与应收侧非同一事务」的缺陷，恰恰最需要实证的
//   就是成功路径下**两侧是否同时落库、金额/客户是否一一对应**。
//
// 验的口径不变量：
//   R1 端点可用：POST /api/v1/samples/:id/convert-to-resale → 200 ok
//   R2 样品侧：Sample.lengthQty 真库回读 = 100 − 20 = 80（Decimal 精度 4 位）
//   R3 流水侧：SampleLengthMovement 恰好 1 条 to_resale，quantity/unit/amount/targetRelationId 正确
//   R4 应收侧：BillingItem 存在，sourceType='Sample'、sourceId=样品、chargeType='other'、status='draft'
//   R5 **双侧对应**：movement.amount == billingItem.amount 且 movement.targetRelationId == billingItem.bearerRelationId
//      （这是「同事务后不留半成品」在事后可观测的判据）
//   R6 审计留痕：两条审计（sample_convert_to_resale / create_billing_item）都在
//
// 演练数据全部 `DRILL_RESALE` 前缀；finally 里按精确 ID 硬删（含流水/计费项/审计/样品）。
// 用法：node scripts/acceptance-d7-1-resale-atomic.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.D7_DEBUG === '1';

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
  if (DEBUG) console.log(`    [diag] ${method} ${path} → ${res.status} ${text.slice(0, 220)}`);
  return { status: res.status, data };
}

const TS = Date.now();
const SMP_ID = `SMP__DRILL_RESALE_${TS}`;
const SMP_CODE = `DRILL-RESALE-${TS}`;
const REL_ID = `REL__DRILL_RESALE_${TS}`;
const START_QTY = 100;
const SELL_QTY = 20;
const AMOUNT = 500;

let prisma = null;
let billingItemId = null;
const created = { sample: false };

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
  await prisma.sample.create({
    data: {
      id: SMP_ID, code: SMP_CODE, type: 'dev', status: 'draft',
      lengthQty: START_QTY, lengthUnit: 'M',
      customerRelationId: REL_ID, notes: 'DRILL 演练用样品（非业务数据）',
      createdAt: now, updatedAt: now,
    },
  });
  created.sample = true;
}

async function rollback() {
  try {
    const gone = [];
    if (created.sample) {
      const mv = await prisma.sampleLengthMovement.deleteMany({ where: { sampleId: SMP_ID } });
      if (mv.count) gone.push(`movement(${mv.count})`);
      if (billingItemId) {
        const bi = await prisma.billingItem.deleteMany({ where: { id: billingItemId } });
        if (bi.count) gone.push('billingItem');
      } else {
        const bi = await prisma.billingItem.deleteMany({ where: { sourceType: 'Sample', sourceId: SMP_ID } });
        if (bi.count) gone.push(`billingItem(${bi.count})`);
      }
      // 审计：样品侧 + 计费侧各一条（billingItemService 会写 create_billing_item）
      const aud = await prisma.auditLog.deleteMany({ where: { targetId: { in: [SMP_ID, billingItemId].filter(Boolean) } } });
      if (aud.count) gone.push(`auditLog(${aud.count})`);
      const sp = await prisma.sample.deleteMany({ where: { id: SMP_ID } });
      if (sp.count) gone.push('sample');
    }
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 ${SMP_ID} / billingItem=${billingItemId}`);
  }
}

async function main() {
  let token = await login('jason.shen@bambook.local');
  if (!token) token = await login('chloe.su@bambook.local');
  if (!token) { fail('登录', 'jason.shen / chloe.su 均失败'); return; }
  console.log('══ D7-① 米样转售 · 成功路径真库演练（自回滚）══\n');
  console.log(`  演练样 ${SMP_CODE}｜持有 ${START_QTY} M → 转售 ${SELL_QTY} M @ ${AMOUNT} CNY\n`);

  await connectPrisma();
  await seed();
  pass('建演练数据', `样品 ${SMP_CODE}（lengthQty=${START_QTY} M）`);

  // ── R1 调用成功路径 ────────────────────────────────────────────────
  const r = await api(token, 'POST', `/api/v1/samples/${encodeURIComponent(SMP_ID)}/convert-to-resale`, {
    quantity: String(SELL_QTY), amount: String(AMOUNT), currency: 'CNY', customerRelationId: REL_ID, note: 'DRILL',
  });
  if (r.status !== 200 || !r.data?.ok) {
    fail('R1 转售成功路径', `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 220)}`);
    return;
  }
  pass('R1 转售成功路径', `HTTP 200｜resoldQty=${r.data.resoldQty}｜balanceAfter=${r.data.balanceAfter}`);
  billingItemId = r.data.billingItem?.id ?? null;

  if (r.data.resoldQty === SELL_QTY) pass('R1 返回 resoldQty', String(r.data.resoldQty));
  else fail('R1 resoldQty', `期望 ${SELL_QTY}，实际 ${r.data.resoldQty}`);
  if (r.data.balanceAfter === START_QTY - SELL_QTY) pass('R1 返回 balanceAfter', String(r.data.balanceAfter));
  else fail('R1 balanceAfter', `期望 ${START_QTY - SELL_QTY}，实际 ${r.data.balanceAfter}`);

  // ── R2 样品侧：真库回读 ────────────────────────────────────────────
  const sample = await prisma.sample.findUnique({ where: { id: SMP_ID } });
  const qty = sample?.lengthQty != null ? Number(sample.lengthQty) : null;
  if (qty === START_QTY - SELL_QTY) pass('R2 真库回读 Sample.lengthQty', `${qty} = ${START_QTY} − ${SELL_QTY}`);
  else fail('R2 Sample.lengthQty', `期望 ${START_QTY - SELL_QTY}，实际 ${qty}`);

  // ── R3 流水侧 ──────────────────────────────────────────────────────
  const mvs = await prisma.sampleLengthMovement.findMany({ where: { sampleId: SMP_ID } });
  if (mvs.length === 1) pass('R3 流水恰好 1 条', `type=${mvs[0].type}`);
  else fail('R3 流水条数', `期望 1，实际 ${mvs.length}`);
  const mv = mvs[0];
  if (mv) {
    if (mv.type === 'to_resale') pass('R3 流水类型 to_resale'); else fail('R3 流水类型', mv.type);
    if (Number(mv.quantity) === SELL_QTY) pass('R3 流水数量', String(Number(mv.quantity))); else fail('R3 流水数量', String(mv.quantity));
    if (mv.unit === 'M') pass('R3 流水单位', mv.unit); else fail('R3 流水单位', mv.unit);
    if (mv.targetRelationId === REL_ID) pass('R3 流水目标客户', mv.targetRelationId); else fail('R3 流水目标客户', String(mv.targetRelationId));
    if (Number(mv.amount) === AMOUNT) pass('R3 流水金额', String(Number(mv.amount))); else fail('R3 流水金额', String(mv.amount));
    if (Number(mv.balanceAfter) === START_QTY - SELL_QTY) pass('R3 流水 balanceAfter 快照', String(Number(mv.balanceAfter)));
    else fail('R3 流水 balanceAfter', String(mv.balanceAfter));
  }

  // ── R4 应收侧 ──────────────────────────────────────────────────────
  const bi = billingItemId
    ? await prisma.billingItem.findUnique({ where: { id: billingItemId } })
    : await prisma.billingItem.findFirst({ where: { sourceType: 'Sample', sourceId: SMP_ID, deletedAt: null } });
  if (!bi) { fail('R4 应收侧 BillingItem', '未找到 —— 成功路径必须同时落两侧'); return; }
  pass('R4 应收侧 BillingItem 已落库', `${bi.itemNo}｜id=${bi.id}`);
  if (bi.sourceType === 'Sample' && bi.sourceId === SMP_ID) pass('R4 来源正确', `${bi.sourceType}/${bi.sourceId}`);
  else fail('R4 来源', `${bi.sourceType}/${bi.sourceId}`);
  if (bi.chargeType === 'other') pass('R4 chargeType 在白名单内', bi.chargeType); else fail('R4 chargeType', bi.chargeType);
  if (bi.status === 'draft') pass('R4 初始状态 draft', bi.status); else fail('R4 状态', bi.status);
  if (Number(bi.amount) === AMOUNT) pass('R4 应收金额', String(Number(bi.amount))); else fail('R4 应收金额', String(bi.amount));
  if (bi.currency === 'CNY') pass('R4 币种', bi.currency); else fail('R4 币种', bi.currency);

  // ── R5 双侧对应（同事务后不留半成品的可观测判据）──────────────────
  if (mv && Number(mv.amount) === Number(bi.amount)) pass('R5 双侧金额一致', `${Number(mv.amount)} = ${Number(bi.amount)}`);
  else fail('R5 双侧金额', `movement=${mv ? Number(mv.amount) : 'null'} vs billingItem=${Number(bi.amount)}`);
  if (mv && mv.targetRelationId === bi.bearerRelationId) pass('R5 双侧客户一致', `${mv.targetRelationId} = ${bi.bearerRelationId}`);
  else fail('R5 双侧客户', `movement=${mv?.targetRelationId} vs billingItem=${bi.bearerRelationId}`);

  // ── R6 审计留痕 ────────────────────────────────────────────────────
  const ops = await prisma.auditLog.findMany({ where: { targetId: { in: [SMP_ID, bi.id] } }, select: { action: true } });
  const opsSet = new Set(ops.map(o => o.action));
  if (opsSet.has('sample_convert_to_resale')) pass('R6 样品侧审计', 'sample_convert_to_resale');
  else fail('R6 样品侧审计', `未找到；实际 ${[...opsSet].join(',') || '无'}`);
  if (opsSet.has('create_billing_item')) pass('R6 应收侧审计', 'create_billing_item');
  else fail('R6 应收侧审计', `未找到；实际 ${[...opsSet].join(',') || '无'}`);
}

try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  if (created.sample) await rollback();
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
