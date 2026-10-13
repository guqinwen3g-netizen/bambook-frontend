// H16-② 客户对账确认回执 —— 真库验收（写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 验的口径不变量：
//   R1 对账单按期间计算：期初 / 本期开票 / 本期收款 / 期末余额，**按币种分组**
//   R2 期末余额 = 期初 + 本期开票 − 本期收款（脚本独立重算比对）
//   R3 期间非法 → 400（格式错 / start > end）
//   R4 提交回执：异议缺说明 → 400；非法 decision → 400
//   R5 **成功路径**：用**未来期间**（无业务数据）提交确认 → 201 落库；同期间再提交 → 409
//   R6 未登录 → 401
//
// 自回滚：R5 创建的回执跑完**硬删**，并按其 id 前缀清掉本次产生的通知
//   （`submitAck` 会给所有 active 用户各发一条 `ntf_cra_<ackId>_<userId>`），不在真库留残留。
//
// 用法：node scripts/acceptance-h16-reconciliation-ack.mjs
const BASE = 'http://127.0.0.1:8081';
const CUSTOMER_PASSWORD = 'Customer@123';
const CUST = 'sakurabrandskk@portal.demo';

const results = [];
function pass(name, detail = '') { results.push({ ok: true }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail = '') { results.push({ ok: false }); console.log(`  ✗ ${name} — ${detail}`); }
function info(name, detail = '') { results.push({ ok: null }); console.log(`  ⓘ ${name} — ${detail}`); }

async function customerLogin(email) {
  const res = await fetch(`${BASE}/api/v2/customer/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: CUSTOMER_PASSWORD }),
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

const round4 = (n) => Math.round(n * 10000) / 10000;

async function main() {
  console.log('══ H16-② 客户对账确认回执 · 真库验收 ══\n');

  const token = await customerLogin(CUST);
  if (!token) { fail('客户登录', CUST); return exit(); }
  pass('客户登录', CUST);

  // ── R1/R2 对账单（只读）：取一段有业务的期间 ──
  const stmt = await api(token, 'GET', '/api/v2/customer/reconciliation/statement?periodStart=2026-09-01&periodEnd=2026-09-30');
  if (stmt.status !== 200 || !Array.isArray(stmt.data?.byCurrency)) {
    fail('R1 对账单', `HTTP ${stmt.status} ${JSON.stringify(stmt.data).slice(0, 140)}`);
    return exit();
  }
  const rows = stmt.data.byCurrency;
  pass('R1 对账单按期间返回', `${rows.length} 个币种分组`);
  info('R1 数据', rows.map(r => `${r.currency} 期初${r.openingBalance}/开票${r.invoiced}/收款${r.received}/期末${r.closingBalance}`).join(' | ') || '(无业务数据)');

  let r2ok = true;
  for (const r of rows) {
    const expect = round4(r.openingBalance + r.invoiced - r.received);
    if (Math.abs(round4(r.closingBalance) - expect) > 0.0002) {
      fail(`R2 ${r.currency} 期末余额`, `${r.closingBalance} ≠ 期初${r.openingBalance}+开票${r.invoiced}−收款${r.received}=${expect}`);
      r2ok = false;
    }
  }
  if (r2ok) pass('R2 期末余额 = 期初 + 本期开票 − 本期收款（脚本独立重算）');
  const curs = rows.map(r => r.currency);
  if (new Set(curs).size === curs.length) pass('R2 按币种分组（无重复币种桶）', curs.join('/') || '(空)');
  else fail('R2 币种分组', JSON.stringify(curs));

  // ── R3 期间非法 → 400 ──
  const badFmt = await api(token, 'GET', '/api/v2/customer/reconciliation/statement?periodStart=2026/09/01&periodEnd=2026-09-30');
  if (badFmt.status === 400) pass('R3 期间格式非法 → 400', badFmt.data?.error ?? '');
  else fail('R3 格式', `期望 400，实际 ${badFmt.status}`);
  const badRange = await api(token, 'GET', '/api/v2/customer/reconciliation/statement?periodStart=2026-09-30&periodEnd=2026-09-01');
  if (badRange.status === 400) pass('R3 start > end → 400');
  else fail('R3 区间', `期望 400，实际 ${badRange.status}`);

  // ── R4 提交校验（零写入：都应在落库前被拒）──
  const noNote = await api(token, 'POST', '/api/v2/customer/reconciliation/acks', {
    periodStart: '2099-01-01', periodEnd: '2099-01-31', decision: 'disputed',
  });
  if (noNote.status === 400) pass('R4 异议缺说明 → 400', noNote.data?.error ?? '');
  else fail('R4 异议缺说明', `期望 400，实际 ${noNote.status}`);
  const badDecision = await api(token, 'POST', '/api/v2/customer/reconciliation/acks', {
    periodStart: '2099-01-01', periodEnd: '2099-01-31', decision: 'whatever',
  });
  if (badDecision.status === 400) pass('R4 非法 decision → 400');
  else fail('R4 decision', `期望 400，实际 ${badDecision.status}`);

  // ── R5 成功路径（未来期间，跑完硬删 + 清通知）──
  const P_START = '2099-01-01';
  const P_END = '2099-01-31';
  const ok1 = await api(token, 'POST', '/api/v2/customer/reconciliation/acks', {
    periodStart: P_START, periodEnd: P_END, decision: 'confirmed',
  });
  let createdId = null;
  if (ok1.status === 201 && ok1.data?.ack?.id) {
    createdId = ok1.data.ack.id;
    pass('R5 提交确认回执 → 201 落库', `${createdId}（期间 ${P_START}~${P_END}，跑完硬删）`);
    if (ok1.data.ack.snapshot?.byCurrency) pass('R5 快照已冻结', `${ok1.data.ack.snapshot.byCurrency.length} 个币种`);
    else fail('R5 快照', '缺少 byCurrency');
  } else {
    fail('R5 提交回执', `HTTP ${ok1.status} ${JSON.stringify(ok1.data).slice(0, 160)}`);
  }

  const dup = await api(token, 'POST', '/api/v2/customer/reconciliation/acks', {
    periodStart: P_START, periodEnd: P_END, decision: 'confirmed',
  });
  if (dup.status === 409) pass('R5 同期间重复提交 → 409', dup.data?.error ?? '');
  else fail('R5 防重复', `期望 409，实际 ${dup.status}`);

  const list = await api(token, 'GET', '/api/v2/customer/reconciliation/acks');
  const listed = (list.data?.acks ?? []).some(a => a.id === createdId);
  if (listed) pass('R5 历史回执可见');
  else fail('R5 历史回执', '未出现在列表');

  // ── R6 未登录 → 401 ──
  const anon = await api(null, 'GET', '/api/v2/customer/reconciliation/acks');
  if (anon.status === 401) pass('R6 未登录 → 401');
  else fail('R6 未登录', `期望 401，实际 ${anon.status}`);

  // ── 自回滚：硬删本次创建的回执 + 其通知 ──
  // ⚠️ 原来只**软删回执**、**不清通知** → 每次跑都在真库留 14 条孤儿通知
  //    （`submitAck` 会给所有 active 用户各发一条 `ntf_cra_<ackId>_<userId>`）。
  //    已改为「硬删回执 + 按前缀删通知」，并断言两处都清干净。
  if (createdId) {
    try {
      // 本脚本在仓库根运行，而 @prisma/client 装在 server/ 下 —— 用 createRequire 以 server 为基准解析
      const { createRequire } = await import('node:module');
      const { SERVER_DIR } = await import('./lib/acceptance-selfcheck.mjs');
      const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
      const { PrismaClient } = req('@prisma/client');
      const prisma = new PrismaClient();
      const ntf = await prisma.notification.deleteMany({ where: { id: { startsWith: `ntf_cra_${createdId}` } } });
      await prisma.customerReconciliationAck.delete({ where: { id: createdId } });
      await prisma.$disconnect();
      pass('回滚：硬删临时回执 + 其通知', `${createdId}｜通知 ${ntf.count} 条`);
    } catch (e) {
      fail('回滚失败', `${createdId} — ${e?.message}（需手工清理）`);
    }
  }

  console.log('');
  info('口径', '按期间 / 按币种分组 / 期末=期初+开票−收款 / 不锁定数据 / 同期间仅一条回执');
  exit();

  function exit() {
    const ok = results.filter(r => r.ok === true).length;
    const bad = results.filter(r => r.ok === false).length;
    const notes = results.filter(r => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
    process.exit(bad === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
