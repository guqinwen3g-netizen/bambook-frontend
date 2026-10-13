// L2 #17「未投产取消被挡 / 已出运反而能取消」—— 真库演练验收（真实 API + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// ── 本脚本要证的东西（对撞法：系统写死的假设 × 业务侧变异）──
//   业务变异：「客户刚下单、还没投产就取消」——这是面料外贸**最常见**的取消场景。
//   设计真源 `docs/design/03-业务规则/订单变更规则.md` §2A.1 原文：
//     | 草稿/待审批 | 变更：业务员可直接修改/撤回 | **取消/暂停：业务员可直接取消/暂停** |
//     | 已批准（正式承诺） | 不得直接修改，须走正式申请与审批 | 须走取消/暂停申请与审批 |
//   → 设计明确要求「Pending 订单业务员可直接取消」。**系统里有没有这条路？**
//
//   代码事实（三条路逐条对撞）：
//     ① 变更申请链：`APPROVED_ORDER_STATUSES = ['Confirmed','Production','Shipping','Delivered']`
//        （orderChangeRequestService.ts:86）→ Pending 被 `ORDER_NOT_APPROVED` 拒（:336-338）
//     ② 状态机：`VALID_ORDER_STATUSES` 只有 6 态、**不含 Cancelled**（orderLifecycleService.ts:24）
//        → `toStatus='Cancelled'` 被 `INVALID_STATUS` 拒
//     ③ 软删（DELETE /orders/:id）：`requireRole('owner','admin','manager')`（orders/route.ts:519）
//        → **业务员（sales）被 403 挡**
//   → 若三条全堵：**业务员对 Pending 订单的「取消」零路径** = 设计要的入口不存在。
//
//   反向（同一处状态判据的另一面）：
//     ④ `APPROVED_ORDER_STATUSES` **含 `Delivered`** → 已交付（订单状态机里的**终态**）
//        反而**可以**发起取消申请 → 与「Pending 不能取消」形成不对称。
//     ⑤ `deleteOrder`（orderLifecycleService.ts:117-191）**只查依赖、不查状态**
//        → owner/admin/manager 可对**已批准订单**直接软删 = 绕过 DR-010 整条审批链
//          （无影响汇总、无审批、无结案处置）。UI 把它叫「归档」，但结果就是订单消失。
//
// ── 断言清单 ──
//   S1 ★前置   底账：建 3 张 DRILL 订单，初始状态均为 Pending
//   S2 ★承重   sales 对 Pending 订单 DELETE → **403**（角色门，不是 404/400）
//   S3 ★承重   sales 对 Pending 订单发取消变更申请 → **400 ORDER_NOT_APPROVED**
//   S4 ★承重   owner 对 Pending 订单 status-transition → Cancelled → **400 INVALID_STATUS**
//   S5  护栏   三条路全堵 ⇒ 「Pending 取消」零路径（S2+S3+S4 的合成结论）
//   S6 ★前置   订单 B 推进到 Confirmed（已批准态）且依赖数为 0
//   S7  缺口   owner 对 **Confirmed** 订单 DELETE → 200 ⇒ 绕过 DR-010 取消审批链【待口径】
//   S8 ★前置   订单 C 推进到 Delivered（终态）
//   S9  缺口   owner 对 **Delivered** 订单发取消变更申请 → 201 ⇒ 终态可取消（不对称）【待口径】
//   S10 护栏   取消申请落库（OrderChangeRequest 一行）+ 订单进入 CancelRequested（守卫态）
//   S11 ★承重   守卫态推进 → **409 ORDER_LIFECYCLE_GUARDED**（修前是 500，见下）
//   S12        回滚 + 独立复核零残留
//
// ★★ 本脚本 2026-09-17 首跑就抓到一个**真 bug（不需要口径）**，已修：
//   首跑 S11 实测 **HTTP 500**（应 409）。根因 = 本仓第**三**次踩「错误码 → HTTP 白名单漏码」：
//   `orders/route.ts` 的 statusCodeMap 漏了 DR-010 守卫的两个码
//   （`ORDER_LIFECYCLE_GUARDED` / `ORDER_ALREADY_CLOSED` —— 它们由 `throw` 抛出、
//   **刻意不进 `OrderLifecycleErrorCode` 联合类型**，见 orderLifecycleService.ts:55-58）
//   → `map[code] || 500` 兜成 500 ⇒ 用户看到「服务器错误」，而不是「请先完成取消申请」。
//   修法（不只补码，从结构上断掉第四次）：
//     ① 映射收成唯一真源 `orderLifecycleService.ORDER_LIFECYCLE_ERROR_HTTP_STATUS`，
//        类型 `Record<OrderLifecycleErrorCode | OrderLifecycleExtensionErrorCode, number>`
//        ⇒ **少一个键就编译不过**；V1 路由改为读它。
//     ② `agent/orderLifecycleFlow.ts` 把两个码纳入联合类型 + userAction 文案
//        （此前 `userActionMap[code]` 取不到 → `userAction: undefined`）。
//     ③ 回归门禁：`orders/__tests__/orderLifecycleRoute.test.ts`（4 例，含 PauseRequested/Closing/Paused）
//        + `orders/__tests__/orderLifecycleErrorStatusMap.test.ts`（映射完整性结构守卫 4 例）。
//
// ★ 承重 vs 护栏 vs 缺口：
//   承重 = 有区分度的断言（改代码/换角色就会翻）
//   护栏 = 证的是「没误伤 / 状态确实进对了 / 留痕还在」，证伪态也全绿
//   缺口 = 系统行为已确认、但改不改要业务拍板 → **单独计数，不计入失败**（脚本可随时复跑）
//
// 证伪方式（launchd 托管后端不继承 shell env → 只能改代码 + kickstart -k）：
//   A 把 `orders/route.ts` 的 `requireRole(...HIGH_RISK_ROLES)` 摘掉
//     → 预期 **S2 转红**（sales 变成能删）
//   B 把 `orderChangeRequestService.ts:86` 的 APPROVED_ORDER_STATUSES 去掉 'Delivered'
//     → 预期 **S9 缺口消失**（Delivered 不能发起取消）
//   C 把 `ORDER_LIFECYCLE_ERROR_HTTP_STATUS.ORDER_LIFECYCLE_GUARDED` 改回 500
//     → 预期 **S11 转红**（这就是本次修的那个 bug 的证伪）
//   ★ 注意：**不要用 `if (false && cond)` 关代码块** —— TS 判不可达 → 丢类型收窄 →
//     ts-node 启动失败 → 演练报 `fetch failed`（本仓已踩，见 handoff-074500 §四.1）。
//
// 演练数据全部带 `DRILL-CXL-` 前缀；finally 里按前缀 + 精确 orderId 硬删 + 独立复核零残留。
// 用法：node scripts/acceptance-pending-cancel-path.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
/**
 * 已知缺口（待口径）：**不是脚本/测试缺陷**，而是「系统行为已确认，但要不要改需业务拍板」。
 * 与 fail 分开计数，这样本脚本可以随时复跑、退出码只反映「脚本本身是否健康」；
 * 缺口在汇总行单独列出，不会因为「不是失败」而被忽略。
 */
const gap = (n, d = '') => { results.push({ ok: 'gap' }); console.log(`  ⚠ 缺口（待口径）${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 演练常量 ──────────────────────────────────────────────────────────
const TS = Date.now();
const PREFIX = `DRILL-CXL-`;
const PO_NO = (k) => `${PREFIX}${k}-${TS}`;
const CUSTOMER = `DRILL-CXL-CUST-${TS}`;
const MILL = `DRILL-CXL-MILL-${TS}`;
const ORDER_KEYS = ['A', 'B', 'C'];

let prisma = null;
const created = { orders: {} };
let notifBefore = new Set();
let agentJobBefore = new Set();

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

async function snapshotSideEffects() {
  const [notifs, jobs] = await Promise.all([
    prisma.notification.findMany({ select: { id: true } }),
    prisma.agentJob.findMany({ select: { id: true } }),
  ]);
  notifBefore = new Set(notifs.map((n) => n.id));
  agentJobBefore = new Set(jobs.map((j) => j.id));
}

/** 直接读库拿订单当前态（不经过被测 API，避免自己跟自己比） */
async function orderState(orderId) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, deletedAt: true } });
  if (!o) return null;
  const [inv, alloc, ship, shipAlloc, vou] = await Promise.all([
    prisma.invoice.count({ where: { orderId, deletedAt: null } }),
    prisma.invoiceOrderAllocation.count({ where: { orderId, deletedAt: null } }),
    prisma.shipment.count({ where: { orderId, deletedAt: null } }),
    prisma.shipmentOrderAllocation.count({ where: { orderId } }),
    prisma.paymentVoucher.count({ where: { orderId, deletedAt: null } }),
  ]);
  return { status: o.status, deleted: o.deletedAt != null, deps: inv + alloc + ship + shipAlloc + vou };
}

/** 推进订单状态（走真实 API，事务 + 审计 + 事件全走一遍） */
async function transition(token, orderId, toStatus) {
  return api(token, 'POST', `/api/v1/orders/${orderId}/status-transition`, {
    toStatus, note: 'DRILL-CXL 演练状态推进', operator: 'DRILL-CXL',
  });
}

const CANCEL_REQ = (orderId) => ({
  orderId,
  changeType: 'cancel',
  beforeSnapshot: { status: 'DRILL-CXL' },
  afterDelta: { status: 'Cancelled' },
  changeReason: 'DRILL-CXL 演练：验证订单取消路径是否存在（仅取证，随后回滚）',
  impactSummary: 'DRILL-CXL 演练影响说明：仅用于验收取证，无真实业务影响，随后回滚。',
});

// ── 回滚 ──────────────────────────────────────────────────────────────
async function rollback() {
  try {
    await sleep(2500); // fire-and-forget 事件/通知落定
    const gone = [];
    const ids = Object.values(created.orders);
    const allIds = [...ids];

    // 审批单（取消申请会产生）——先取出 id，供审计/通知清理用
    const apprs = ids.length
      ? await prisma.approvalRequest.findMany({ where: { targetType: 'Order', targetId: { in: ids } }, select: { id: true } })
      : [];
    const apprIds = apprs.map((a) => a.id);
    const scoped = [...allIds, ...apprIds];

    for (const [label, fn] of [
      ['OrderStatusTransition', () => prisma.orderStatusTransition.deleteMany({ where: { orderId: { in: ids } } })],
      ['OrderChangeRequest', () => prisma.orderChangeRequest.deleteMany({ where: { orderId: { in: ids } } })],
      ['ProductionStage', () => prisma.productionStage.deleteMany({ where: { orderId: { in: ids } } })],
      ['ApprovalRequest', () => prisma.approvalRequest.deleteMany({ where: { id: { in: apprIds } } })],
      ['EntityReference', () => prisma.entityReference.deleteMany({ where: { OR: [{ ownerId: { in: scoped } }, { targetId: { in: scoped } }] } })],
      ['EntityLink', () => prisma.entityLink.deleteMany({ where: { OR: [{ fromId: { in: scoped } }, { toId: { in: scoped } }] } })],
      ['AuditLog', () => prisma.auditLog.deleteMany({ where: { targetId: { in: scoped } } })],
      ['Order', () => prisma.order.deleteMany({ where: { id: { in: ids } } })],
    ]) {
      const r = await fn();
      if (r.count) gone.push(`${label}(${r.count})`);
    }

    const [notifsNow, jobsNow] = await Promise.all([
      prisma.notification.findMany({ select: { id: true } }),
      prisma.agentJob.findMany({ select: { id: true } }),
    ]);
    const newNotifs = notifsNow.map((n) => n.id).filter((id) => !notifBefore.has(id));
    const newJobs = jobsNow.map((j) => j.id).filter((id) => !agentJobBefore.has(id));
    if (newNotifs.length) gone.push(`Notification(${(await prisma.notification.deleteMany({ where: { id: { in: newNotifs } } })).count})`);
    if (newJobs.length) gone.push(`AgentJob(${(await prisma.agentJob.deleteMany({ where: { id: { in: newJobs } } })).count})`);

    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 orders=${JSON.stringify(created.orders)}`);
  }
}

/** 独立复核零残留（不信回滚自述，按前缀 + 精确 id 回查） */
async function verifyNoResidue() {
  const checks = [];
  const ids = Object.values(created.orders);
  checks.push(['order(DRILL-CXL 前缀)', await prisma.order.count({ where: { poNumber: { startsWith: PREFIX } } })]);
  checks.push(['order(精确 id)', ids.length ? await prisma.order.count({ where: { id: { in: ids } } }) : 0]);
  checks.push(['orderStatusTransition', ids.length ? await prisma.orderStatusTransition.count({ where: { orderId: { in: ids } } }) : 0]);
  checks.push(['orderChangeRequest', ids.length ? await prisma.orderChangeRequest.count({ where: { orderId: { in: ids } } }) : 0]);
  checks.push(['productionStage', ids.length ? await prisma.productionStage.count({ where: { orderId: { in: ids } } }) : 0]);
  checks.push(['approvalRequest', ids.length ? await prisma.approvalRequest.count({ where: { targetType: 'Order', targetId: { in: ids } } }) : 0]);
  checks.push(['entityReference', ids.length ? await prisma.entityReference.count({ where: { OR: [{ ownerId: { in: ids } }, { targetId: { in: ids } }] } }) : 0]);
  checks.push(['entityLink', ids.length ? await prisma.entityLink.count({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } }) : 0]);
  checks.push(['auditLog', ids.length ? await prisma.auditLog.count({ where: { targetId: { in: ids } } }) : 0]);
  checks.push(['orderChangeRequest(全库前缀)', await prisma.orderChangeRequest.count({ where: { requestNumber: { contains: TS.toString() } } })]);
  const dirty = checks.filter(([, n]) => n > 0);
  if (dirty.length === 0) pass('回滚复核：零残留', `${checks.length} 项全为 0`);
  else fail('回滚复核：仍有残留', dirty.map(([k, n]) => `${k}=${n}`).join(' '));
}

async function main() {
  const ownerToken = await login('jason.shen@bambook.local');
  const salesToken = await login('chloe.su@bambook.local');
  if (!ownerToken || !salesToken) {
    fail('登录', `owner=${!!ownerToken} sales=${!!salesToken}（jason.shen / chloe.su）`);
    return;
  }

  console.log('══ L2 #17 未投产取消被挡 · 真库演练验收（真实 API + 自回滚）══\n');
  console.log('  被测：DELETE /api/v1/orders/:id（角色门）· POST /api/v1/order-changes（状态门）');
  console.log('        POST /api/v1/orders/:id/status-transition（6 态枚举）');
  console.log('  设计真源：订单变更规则.md §2A.1「草稿/待审批：业务员可直接取消/暂停」\n');

  await connectPrisma();
  await snapshotSideEffects();

  // ── S1 ★前置：建 3 张 Pending 订单 ──
  for (const k of ORDER_KEYS) {
    const r = await api(ownerToken, 'POST', '/api/v1/orders', {
      poNumber: PO_NO(k), customer: CUSTOMER, millName: MILL,
      product: 'DRILL-CXL-FABRIC', type: 'Fabric', quantity: 1000000,
      quoteAmount: 1000000, dueDate: '2027-12-31', status: 'Pending',
    });
    if ((r.status === 200 || r.status === 201) && r.data?.order?.id) created.orders[k] = r.data.order.id;
    else fail(`底账：建订单 ${k}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const stA0 = created.orders.A ? await orderState(created.orders.A) : null;
  if (Object.keys(created.orders).length === 3 && stA0?.status === 'Pending' && !stA0.deleted) {
    pass('S1 ★前置 底账：3 张 DRILL 订单建成且均为 Pending', `A/B/C=${ORDER_KEYS.map((k) => created.orders[k]).join(' / ')}`);
  } else {
    fail('S1 ★前置 底账建成', `orders=${JSON.stringify(created.orders)} 状态=${JSON.stringify(stA0)} —— **前置不成立，后续断言不可信**`);
  }

  // ── S2 ★承重：sales 对 Pending 订单 DELETE → 403 ──
  const r2 = await api(salesToken, 'DELETE', `/api/v1/orders/${created.orders.A}`);
  const stA1 = await orderState(created.orders.A);
  if (r2.status === 403 && stA1 && !stA1.deleted) {
    pass('S2 ★承重 sales 对 Pending 订单 DELETE → 403（角色门）', `HTTP 403；订单仍在（deleted=${stA1.deleted}）`);
  } else if (r2.status === 200) {
    fail('S2 ★承重 sales 竟然能删订单', `HTTP 200；deleted=${stA1?.deleted} —— 与 requireRole(HIGH_RISK_ROLES) 不符`);
  } else {
    fail('S2 ★承重 sales DELETE 的拒绝形态非 403', `HTTP ${r2.status} ${JSON.stringify(r2.data).slice(0, 160)}（期望 403 角色门）`);
  }

  // ── S3 ★承重：sales 对 Pending 订单发取消变更申请 → 400 ORDER_NOT_APPROVED ──
  const r3 = await api(salesToken, 'POST', '/api/v1/order-changes', CANCEL_REQ(created.orders.A));
  const code3 = r3.data?.error ?? r3.data?.code ?? '';
  if (r3.status === 400 && code3 === 'ORDER_NOT_APPROVED') {
    pass('S3 ★承重 sales 对 Pending 订单发取消申请 → 400 ORDER_NOT_APPROVED', `「${String(r3.data?.message ?? '').slice(0, 60)}…」`);
  } else {
    fail('S3 ★承重 Pending 取消申请未被 ORDER_NOT_APPROVED 拒', `HTTP ${r3.status} code=${code3} ${JSON.stringify(r3.data).slice(0, 160)}`);
  }

  // ── S4 ★承重：owner 对 Pending 订单 status-transition → Cancelled → 400 INVALID_STATUS ──
  const r4 = await transition(ownerToken, created.orders.A, 'Cancelled');
  const code4 = r4.data?.error?.code ?? r4.data?.code ?? '';
  if (r4.status === 400 && code4 === 'INVALID_STATUS') {
    pass('S4 ★承重 直接推 Cancelled → 400 INVALID_STATUS（6 态枚举不含 Cancelled）', `「${String(r4.data?.error?.message ?? r4.data?.message ?? '').slice(0, 60)}…」`);
  } else {
    fail('S4 ★承重 推 Cancelled 未被 INVALID_STATUS 拒', `HTTP ${r4.status} code=${code4} ${JSON.stringify(r4.data).slice(0, 160)}`);
  }

  // ── S5 护栏：三条路全堵 = 零路径（合成结论）──
  const stA2 = await orderState(created.orders.A);
  const blocked = r2.status === 403 && r3.status === 400 && r4.status === 400;
  if (blocked && stA2?.status === 'Pending' && !stA2.deleted) {
    pass('S5 护栏 Pending 订单「取消」三条路全堵 = 业务员零路径', 'DELETE 403 + 变更申请 400 + 状态机 400；订单原封不动');
  } else {
    fail('S5 护栏 零路径结论不成立', `HTTP ${r2.status}/${r3.status}/${r4.status}；状态=${JSON.stringify(stA2)}`);
  }

  // ── S6 ★前置：订单 B 推进到 Confirmed ──
  const b1 = await transition(ownerToken, created.orders.B, 'Confirmed');
  const stB1 = await orderState(created.orders.B);
  if (b1.status === 200 && stB1?.status === 'Confirmed' && stB1.deps === 0) {
    pass('S6 ★前置 订单 B 推进到 Confirmed 且依赖数为 0', `status=${stB1.status} deps=${stB1.deps}`);
  } else {
    fail('S6 ★前置 订单 B 推进到 Confirmed', `HTTP ${b1.status} ${JSON.stringify(b1.data).slice(0, 200)}；状态=${JSON.stringify(stB1)} —— 后续 S7 不可信`);
  }

  // ── S7 ★承重：owner 对 Confirmed 订单 DELETE → 200（绕过 DR-010）──
  const r7 = await api(ownerToken, 'DELETE', `/api/v1/orders/${created.orders.B}`);
  const stB2 = await orderState(created.orders.B);
  if (r7.status === 200 && stB2?.deleted) {
    gap(
      'S7 已批准订单（Confirmed）可被直接软删 → 绕过 DR-010 取消审批链',
      `HTTP 200；deletedAt 已置位。deleteOrder 只查依赖、不查状态 ⇒ 无影响汇总/无审批/无结案处置的「静默取消」。` +
      `【待口径】软删算不算「取消」？「归档已完成订单」是否要保留？加状态守卫会不会误伤归档？`,
    );
  } else if (r7.status === 409) {
    pass('S7 ★承重 已批准订单被拒绝软删（有状态守卫）', `HTTP 409 ${r7.data?.error?.code ?? ''} —— 与 DR-010「已批准不得直接取消」一致`);
  } else {
    info('S7 已批准订单 DELETE 的实际形态', `HTTP ${r7.status} ${JSON.stringify(r7.data).slice(0, 160)}；deleted=${stB2?.deleted}`);
  }

  // ── S8 ★前置：订单 C 推进到 Delivered（终态）──
  const hops = ['Confirmed', 'Production', 'Shipping', 'Delivered'];
  const hopRes = [];
  for (const h of hops) {
    const r = await transition(ownerToken, created.orders.C, h);
    hopRes.push(`${h}:${r.status}`);
    if (r.status !== 200) break;
  }
  const stC1 = await orderState(created.orders.C);
  if (stC1?.status === 'Delivered') {
    pass('S8 ★前置 订单 C 推进到 Delivered（订单状态机终态）', hopRes.join(' → '));
  } else {
    fail('S8 ★前置 订单 C 推进到 Delivered', `${hopRes.join(' → ')}；状态=${JSON.stringify(stC1)} —— 后续 S9 不可信`);
  }

  // ── S9 ★承重：owner 对 Delivered 订单发取消变更申请 → 200/201（终态可取消）──
  const r9 = await api(ownerToken, 'POST', '/api/v1/order-changes', CANCEL_REQ(created.orders.C));
  const stC2 = await orderState(created.orders.C);
  if ((r9.status === 200 || r9.status === 201) && stC2?.status === 'CancelRequested') {
    gap(
      'S9 已交付（Delivered=订单状态机终态）订单**可以**发起取消申请 → 与 Pending 被挡形成不对称',
      `HTTP ${r9.status}；订单 → ${stC2.status}。APPROVED_ORDER_STATUSES 含 Delivered，而 Pending 不在其中。` +
      `【待口径】已交付订单的「取消」实际是退货/索赔——该走取消链、还是该单独建售后退货模型？`,
    );
  } else if (r9.status === 400) {
    pass('S9 ★承重 Delivered 订单被拒发取消申请', `HTTP 400 ${r9.data?.error ?? ''} —— 终态不可取消（与 Pending 一致）`);
  } else {
    info('S9 Delivered 订单发取消申请的实际形态', `HTTP ${r9.status} ${JSON.stringify(r9.data).slice(0, 160)}；状态=${stC2?.status}`);
  }

  // ── S10 护栏：取消申请落库 + 订单进入 CancelRequested ──
  const crRows = await prisma.orderChangeRequest.findMany({
    where: { orderId: created.orders.C }, select: { id: true, requestNumber: true, status: true, changeTypes: true },
  });
  if (crRows.length > 0) {
    pass('S10 护栏 取消申请落库（OrderChangeRequest）', `${crRows.length} 行 requestNumber=${crRows[0].requestNumber} status=${crRows[0].status}`);
  } else {
    info('S10 护栏 无 OrderChangeRequest 落库', '（若 S9 被拒则属预期）');
  }

  // ── S11 护栏：CancelRequested 是守卫态 → 常规推进 409 ──
  if (stC2?.status === 'CancelRequested') {
    const r11 = await transition(ownerToken, created.orders.C, 'Production');
    const code11 = r11.data?.error?.code ?? r11.data?.code ?? '';
    if (r11.status === 409 && code11 === 'ORDER_LIFECYCLE_GUARDED') {
      pass('S11 护栏 CancelRequested 守卫态 → 常规推进 409 ORDER_LIFECYCLE_GUARDED', 'fail-closed 生效');
    } else {
      fail('S11 护栏 守卫态未拦截常规推进', `HTTP ${r11.status} code=${code11}`);
    }
  } else {
    info('S11 护栏 跳过（订单未进入 CancelRequested）', `status=${stC2?.status}`);
  }
}

main()
  .catch((e) => fail('演练异常', String(e?.stack || e)))
  .finally(async () => {
    if (prisma) {
      await rollback();
      await verifyNoResidue();
      await prisma.$disconnect();
    }
    const failed = results.filter((r) => r.ok === false).length;
    const passed = results.filter((r) => r.ok === true).length;
    const gaps = results.filter((r) => r.ok === 'gap').length;
    console.log(`\n──────────────\n结果：${passed} 通过 / ${failed} 失败 / ${gaps} 缺口（待口径）`);
    process.exit(failed ? 1 : 0);
  });
