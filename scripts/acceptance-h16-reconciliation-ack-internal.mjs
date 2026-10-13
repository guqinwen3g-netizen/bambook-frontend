// H16-② 客户对账回执 · **内部侧查看**验收（跨端写读 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么需要这个脚本：
//   H16-② 只做了**客户门户**侧（客户能回签 + 内部收到通知）。通知一闪而过，
//   内部侧**没有任何入口**能看到「谁回签了 / 谁提了异议」。本批补了
//   `GET /api/v1/reconciliation/acks` + 对账面板「客户回执」视图。
//   本脚本跨端验证：**客户门户提交 → 内部侧列表可见 + 可筛**。
//
// 验的口径不变量：
//   R1 内部端点可用（未登录 → 401；登录 → 200 且含 items/total/summary）
//   R2 客户门户提交的回执，内部侧**按 id 能查到**，字段齐全
//   R3 客户名由 Relation 补出（customerName）
//   R4 status 筛选：confirmed 命中；且 **summary 不受 status 影响**（两态计数都给出）
//   R5 期间筛选是**区间相交**（用期间内的一天起筛仍命中；用完全不重叠的区间不命中）
//   R6 非法 status / 非法日期 → 400（不静默忽略）
//   R7 软删后的回执**不再出现**在内部列表
//
// 自回滚：跑完按精确 id 硬删回执 + 其通知（`ntf_cra_<ackId>_*`），真库零残留。
// 用法：node scripts/acceptance-h16-reconciliation-ack-internal.mjs
const BASE = 'http://127.0.0.1:8081';
const CUSTOMER_PASSWORD = 'Customer@123';
const CUST = 'sakurabrandskk@portal.demo';
const INTERNAL_PASSWORD = 'Bambook@2026';
const INTERNAL_LOGINS = ['charlie.qian@bambook.local', 'jason.shen@bambook.local'];

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };

async function login(path, email, password) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
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

/** 用未来期间，避免与真库既有业务数据/回执撞期 */
const P_START = '2099-01-01';
const P_END = '2099-01-31';

let prisma = null;
let ackId = null;
let ackRelationId = null;

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

async function rollback() {
  try {
    const gone = [];
    if (ackId) {
      const n = await prisma.notification.deleteMany({ where: { id: { startsWith: `ntf_cra_${ackId}` } } });
      if (n.count) gone.push(`notification(${n.count})`);
      const a = await prisma.customerReconciliationAck.deleteMany({ where: { id: ackId } });
      if (a.count) gone.push('ack');
    }
    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 ackId=${ackId}`);
  }
}

async function main() {
  console.log('══ H16-② 客户回执 · 内部侧查看验收（跨端 + 自回滚）══\n');
  // 直连 prisma 仅用于：补客户名核对（R3）/ 软删（R7）/ 回滚。必须在 main 内先连上。
  await connectPrisma();

  // ── 客户门户提交（造一条可被内部看到的回执）──────────────────────────
  const custToken = await login('/api/v2/customer/auth/login', CUST, CUSTOMER_PASSWORD);
  if (!custToken) { fail('客户登录', CUST); return; }
  pass('客户登录', CUST);

  const submitted = await api(custToken, 'POST', '/api/v2/customer/reconciliation/acks', {
    periodStart: P_START, periodEnd: P_END, decision: 'confirmed',
  });
  if (submitted.status !== 201 || !submitted.data?.ack?.id) {
    fail('客户提交回执', `HTTP ${submitted.status} ${JSON.stringify(submitted.data).slice(0, 180)}`);
    return;
  }
  ackId = submitted.data.ack.id;
  ackRelationId = submitted.data.ack.customerRelationId;
  pass('客户门户提交确认回执', `${ackId}（期间 ${P_START}~${P_END}，跑完硬删）`);

  // ── 内部侧登录 ────────────────────────────────────────────────────────
  let token = null, who = '';
  for (const e of INTERNAL_LOGINS) {
    token = await login('/api/auth/login', e, INTERNAL_PASSWORD);
    if (token) { who = e; break; }
  }
  if (!token) { fail('内部登录', INTERNAL_LOGINS.join(' / ')); return; }
  pass('内部登录', who);

  // ── R1 端点可用 + 未登录 401 ─────────────────────────────────────────
  const anon = await api(null, 'GET', '/api/v1/reconciliation/acks');
  if (anon.status === 401) pass('R1 未登录 → 401');
  else fail('R1 未登录', `期望 401，实际 ${anon.status}`);

  const list = await api(token, 'GET', '/api/v1/reconciliation/acks');
  if (list.status !== 200 || !Array.isArray(list.data?.items)) {
    fail('R1 内部端点可用', `HTTP ${list.status} ${JSON.stringify(list.data).slice(0, 180)}`);
    return;
  }
  if (typeof list.data.summary?.confirmed === 'number' && typeof list.data.summary?.disputed === 'number') {
    pass('R1 端点返回 items/total/summary', `total=${list.data.total} 确认=${list.data.summary.confirmed} 异议=${list.data.summary.disputed}`);
  } else {
    fail('R1 summary 结构', JSON.stringify(list.data.summary));
  }

  // ── R2 按 id 能查到刚提交的回执 ──────────────────────────────────────
  const mine = (list.data.items ?? []).find((a) => a.id === ackId);
  if (mine) pass('R2 内部侧可见刚提交的回执', `${mine.periodStart} ~ ${mine.periodEnd} / ${mine.status}`);
  else fail('R2 内部侧不可见', `列表 ${list.data.items?.length ?? 0} 条里没有 ${ackId}`);

  if (mine) {
    const okFields = mine.customerRelationId === ackRelationId
      && mine.periodStart === P_START && mine.periodEnd === P_END
      && mine.status === 'confirmed' && typeof mine.createdAt === 'number' && mine.createdAt > 0;
    if (okFields) pass('R2 字段齐全且正确', `relation=${mine.customerRelationId} createdAt=${mine.createdAt}`);
    else fail('R2 字段', JSON.stringify(mine).slice(0, 200));
  }

  // ── R3 客户名由 Relation 补出 ────────────────────────────────────────
  const rel = ackRelationId
    ? await prisma.relation.findUnique({ where: { id: ackRelationId }, select: { name: true } }).catch(() => null)
    : null;
  const expectedName = rel?.name ?? null;
  if (mine) {
    if (expectedName && mine.customerName === expectedName) pass('R3 客户名已补', mine.customerName);
    else if (!expectedName) info('R3 客户名', `Relation ${ackRelationId} 无 name → customerName=${JSON.stringify(mine.customerName)}（不阻断）`);
    else fail('R3 客户名', `期望 ${expectedName}，实际 ${JSON.stringify(mine.customerName)}`);
  }

  // ── R4 status 筛选 + summary 不受 status 影响 ────────────────────────
  const onlyConfirmed = await api(token, 'GET', '/api/v1/reconciliation/acks?status=confirmed');
  if (onlyConfirmed.status === 200) {
    const hit = (onlyConfirmed.data.items ?? []).some(a => a.id === ackId);
    const allConfirmed = (onlyConfirmed.data.items ?? []).every(a => a.status === 'confirmed');
    if (hit && allConfirmed) pass('R4 status=confirmed 筛选命中且全为 confirmed');
    else fail('R4 status 筛选', `命中=${hit} 全 confirmed=${allConfirmed}`);
    const s = onlyConfirmed.data.summary ?? {};
    const full = await api(token, 'GET', '/api/v1/reconciliation/acks');
    if (s.confirmed === full.data?.summary?.confirmed && s.disputed === full.data?.summary?.disputed) {
      pass('R4 summary **不受 status 筛选影响**', `confirmed=${s.confirmed} disputed=${s.disputed}`);
    } else {
      fail('R4 summary 被 status 影响', `筛选后 ${JSON.stringify(s)} vs 全量 ${JSON.stringify(full.data?.summary)}`);
    }
  } else {
    fail('R4 status 筛选', `HTTP ${onlyConfirmed.status}`);
  }

  // ── R5 期间筛选是区间相交 ───────────────────────────────────────────
  const intersect = await api(token, 'GET', `/api/v1/reconciliation/acks?periodFrom=2099-01-15&periodTo=2099-01-20`);
  if (intersect.status === 200) {
    const hit = (intersect.data.items ?? []).some(a => a.id === ackId);
    if (hit) pass('R5 期间相交命中（2099-01-15~01-20 与 2099-01 相交）');
    else fail('R5 期间相交', '期望命中却未命中');
  } else fail('R5 期间筛选', `HTTP ${intersect.status}`);

  const disjoint = await api(token, 'GET', `/api/v1/reconciliation/acks?periodFrom=2098-01-01&periodTo=2098-12-31`);
  if (disjoint.status === 200) {
    const hit = (disjoint.data.items ?? []).some(a => a.id === ackId);
    if (!hit) pass('R5 期间不重叠 → 不命中');
    else fail('R5 期间不重叠', '不该命中却命中');
  } else fail('R5 期间不重叠', `HTTP ${disjoint.status}`);

  // ── R6 参数非法 → 400 ───────────────────────────────────────────────
  const badStatus = await api(token, 'GET', '/api/v1/reconciliation/acks?status=nope');
  if (badStatus.status === 400 && badStatus.data?.error?.code === 'INVALID_STATUS') pass('R6 非法 status → 400 INVALID_STATUS');
  else fail('R6 非法 status', `期望 400/INVALID_STATUS，实际 ${badStatus.status} ${JSON.stringify(badStatus.data).slice(0, 100)}`);

  const badDate = await api(token, 'GET', '/api/v1/reconciliation/acks?periodFrom=2099/01/01');
  if (badDate.status === 400 && badDate.data?.error?.code === 'INVALID_PERIOD') pass('R6 非法日期 → 400 INVALID_PERIOD');
  else fail('R6 非法日期', `期望 400/INVALID_PERIOD，实际 ${badDate.status}`);

  // ── R7 软删后不再出现 ───────────────────────────────────────────────
  await prisma.customerReconciliationAck.update({
    where: { id: ackId }, data: { deletedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()) },
  });
  const afterDel = await api(token, 'GET', '/api/v1/reconciliation/acks?limit=200');
  if (afterDel.status === 200) {
    const hit = (afterDel.data.items ?? []).some(a => a.id === ackId);
    if (!hit) pass('R7 软删后不再出现在内部列表');
    else fail('R7 软删', '软删后仍可见（列表未过滤 deletedAt）');
  } else fail('R7 软删后查询', `HTTP ${afterDel.status}`);
}

try {
  await main();
} catch (e) {
  console.error('脚本异常', e);
  fail('脚本异常', String(e).slice(0, 300));
} finally {
  await connectPrisma().catch(() => {});
  if (prisma) await rollback();
  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const notes = results.filter(r => r.ok === null).length;
  console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${notes} 需知会 ══`);
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(bad === 0 ? 0 : 1);
}
