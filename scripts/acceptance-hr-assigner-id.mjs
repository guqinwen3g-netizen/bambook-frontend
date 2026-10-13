// 「派活人」丢失 —— 真库演练验收（真实 API 写路径 + 自回滚）
//
// ── 病灶（本脚本要证的东西）──
//   `POST /api/hr/assignments`（hr/route.ts）创建派工单时写
//     `assignerId: (req as any).user?.id || null`
//   而 **`req.user` 在本仓从未被赋值** —— 全库只有测试 mock 赋过它
//   （`production/__tests__/rbac.test.ts:15` 的 `req.user = { roles }`），
//   生产代码里没有任何中间件写 `req.user`。
//   ⇒ `(req as any).user?.id` **恒为 undefined** ⇒ `assignerId` **恒为 null**。
//
//   后果：「谁派的活」**永久丢失**（不是"偶尔丢"，是 100% 丢）。
//   而同 handler 下方 7 行的审计日志用的是 `actorIdFromRequest(req)` ——
//   **同一个请求，审计日志记得住派活人，业务字段记不住**（两处取 actor 的方式不一致）。
//
// ── 验的口径不变量 ──
//   S1  ★前置   两个账号都能登录，且**是两个不同的人**（否则 S4 无区分度）
//   S2  ★承重   派工单创建成功，且返回体 `assignment.assignerId === 派活人 id`（修前 === null）
//   S3  ★承重   **独立回读**（绕开返回体，直接按 id 查库）→ `assignerId === 派活人 id`
//   S4  护栏   `assignerId !== 被派活人 id`（证明记的是「派活的人」而不是「被派的人」）
//   S5  护栏   审计日志留痕（`source='route:hr:create_assignment'` 且 `actorId = 派活人`）
//   S6          回滚后**独立复核零残留**
//
// ── 演练设计坑 ──
//   · 必须**派给别人**（assignerId ≠ userId），否则「assignerId 记的是派活人」与
//     「记的是被派人」两种实现都能过 S2/S3 —— **无区分度**。
//   · 用 `DRILL-` 前缀 + 时间戳，按**精确 id** 硬删，并**连审计日志一起清**
//     （创建接口会顺带写 AuditLog，漏清就是残留）。
//
// 用法：node scripts/acceptance-hr-assigner-id.mjs
//   依赖：本地后端 8081 在跑（`ts-node src/index.ts`，**无文件监听 → 改完必须重启**）

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';

const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
// 派活人需要 `hr:write`（矩阵里只有总领导/管理员档持有）→ 用 boss 当派活人，
// 派给另一个人（**必须不同**，否则「记派活人」与「记被派人」两种实现都过 S2/S3，无区分度）
const ACTOR_EMAIL = 'jason.shen@bambook.local';
const ASSIGNEE_EMAIL = 'hank.zheng@bambook.local';

// PrismaClient 从 server/ 解析（与仓内其它演练脚本一致）
const { createRequire } = await import('node:module');
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const req = createRequire(SERVER_DIR + '/');
// 与 server/src/test-setup.ts 同源：.env.local 优先（本地 Postgres）
req('dotenv').config({ path: path.join(SERVER_DIR, '.env.local'), override: true });
req('dotenv').config({ path: path.join(SERVER_DIR, '.env') });
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();
const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n}${d ? ' — ' + d : ''}`); };

const TS = Date.now();
const TITLE = `DRILL-ASSIGNER-${TS}`;

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

let createdId = null;

async function main() {
  console.log(`\n═══ 派活人丢失演练（${TITLE}）═══\n`);

  // ── S1 前置：两个不同的人 ─────────────────────────────────
  console.log('[S1] 前置：登录两个账号');
  const actorToken = await login(ACTOR_EMAIL);
  const assigneeToken = await login(ASSIGNEE_EMAIL);
  if (!actorToken || !assigneeToken) {
    fail('S1 两个账号都能登录', `actor=${!!actorToken} assignee=${!!assigneeToken}`);
    return;
  }
  const actor = await prisma.userAccount.findFirst({ where: { email: ACTOR_EMAIL }, select: { id: true, email: true } });
  const assignee = await prisma.userAccount.findFirst({ where: { email: ASSIGNEE_EMAIL }, select: { id: true, email: true } });
  if (!actor || !assignee) { fail('S1 能查到两个账号', '未找到'); return; }
  if (actor.id === assignee.id) { fail('S1 必须是两个不同的人', '同一 id'); return; }
  pass('S1 前置成立', `派活人=${actor.email}(${actor.id}) 被派活人=${assignee.email}(${assignee.id})`);

  // ── S2 承重：创建 + 返回体的 assignerId ──────────────────
  console.log('\n[S2] 创建派工单（派给**别人**，便于区分「派活人」与「被派人」）');
  const create = await api(actorToken, 'POST', '/api/hr/assignments', {
    title: TITLE,
    description: 'DRILL 用，脚本结束会按 id 硬删',
    userId: assignee.id,
    priority: 'normal',
  });
  if (create.status !== 200 || !create.json?.ok) {
    fail('S2 创建成功', `status=${create.status} body=${create.text.slice(0, 200)}`);
    return;
  }
  const assignment = create.json.assignment;
  createdId = assignment.id;
  info('创建返回', `id=${createdId} assignerId=${JSON.stringify(assignment.assignerId)}`);
  if (assignment.assignerId === actor.id) {
    pass('S2 返回体 assignerId = 派活人', actor.id);
  } else {
    fail('S2 返回体 assignerId = 派活人', `实得 ${JSON.stringify(assignment.assignerId)}（期望 ${actor.id}）`);
  }

  // ── S3 承重：独立回读（绕开返回体）──────────────────────
  console.log('\n[S3] 独立回读（直接按 id 查库，不信返回体）');
  const row = await prisma.workAssignment.findUnique({ where: { id: createdId }, select: { assignerId: true, userId: true, title: true } });
  if (!row) { fail('S3 能查到刚创建的行', '未找到'); }
  else if (row.assignerId === actor.id) pass('S3 库内 assignerId = 派活人', actor.id);
  else fail('S3 库内 assignerId = 派活人', `实得 ${JSON.stringify(row.assignerId)}（期望 ${actor.id}）`);

  // ── S4 护栏：不是「被派人」──────────────────────────────
  console.log('\n[S4] 护栏：assignerId 不是「被派活人」');
  if (row && row.assignerId === assignee.id) fail('S4 assignerId ≠ 被派人', '记成了被派人 → 语义反了');
  else pass('S4 assignerId ≠ 被派人', `assignerId=${JSON.stringify(row?.assignerId)} 被派人=${assignee.id}`);

  // ── S5 护栏：审计留痕 ───────────────────────────────────
  console.log('\n[S5] 护栏：审计留痕');
  // ⚠️ `source` **不是列**，它被 writeRouteAuditLog 放进 `detail` JSON（detail.source）
  const audit = await prisma.auditLog.findFirst({
    where: { targetType: 'WorkAssignment', targetId: createdId },
    select: { actorId: true, action: true, detail: true },
  });
  const auditSource = audit && audit.detail && typeof audit.detail === 'object'
    ? audit.detail.source
    : undefined;
  if (audit && audit.actorId === actor.id) {
    pass('S5 审计 actorId = 派活人', `action=${audit.action} source=${String(auditSource)}`);
  } else {
    fail('S5 审计 actorId = 派活人', `实得 ${JSON.stringify(audit)}`);
  }

  // ── S6 回滚 ────────────────────────────────────────────
  console.log('\n[S6] 回滚');
  const delA = await prisma.workAssignment.deleteMany({ where: { id: createdId } });
  const delL = await prisma.auditLog.deleteMany({ where: { targetType: 'WorkAssignment', targetId: createdId } });
  info('已删', `WorkAssignment=${delA.count} AuditLog=${delL.count}`);
  const leftA = await prisma.workAssignment.count({ where: { id: createdId } });
  const leftL = await prisma.auditLog.count({ where: { targetId: createdId } });
  const leftT = await prisma.workAssignment.count({ where: { title: TITLE } });
  if (leftA === 0 && leftL === 0 && leftT === 0) pass('S6 零残留（按 id + 按 title 双查）');
  else fail('S6 零残留', `assignment=${leftA} audit=${leftL} byTitle=${leftT}`);
}

try {
  await main();
} catch (e) {
  console.error('\n脚本异常：', e?.message || e);
  results.push({ ok: false });
} finally {
  // 兜底清理：即使中途抛错也按精确标识清干净
  if (createdId) {
    try { await prisma.workAssignment.deleteMany({ where: { id: createdId } }); } catch { /* ignore */ }
    try { await prisma.auditLog.deleteMany({ where: { targetType: 'WorkAssignment', targetId: createdId } }); } catch { /* ignore */ }
  }
  try { await prisma.workAssignment.deleteMany({ where: { title: TITLE } }); } catch { /* ignore */ }
  await prisma.$disconnect();

  const ok = results.filter(r => r.ok === true).length;
  const bad = results.filter(r => r.ok === false).length;
  const skip = results.filter(r => r.ok === null).length;
  console.log(`\n═══ 结果：${ok} 通过 / ${bad} 失败 / ${skip} 信息 ═══\n`);
  process.exit(bad > 0 ? 1 : 0);
}
