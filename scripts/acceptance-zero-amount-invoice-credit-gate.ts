// 0 元 / 负额应收票 → 虚假逾期 → 挡单 —— 真库演练验收（真实 API + 真实服务 + 自回滚）
//
// ── 病灶（本脚本要证的东西）──
//   「未结清应收」的判据在 3 处都写成 `type='Receivable' && status ∈ {Issued, PartiallyPaid}`，
//   **不看金额、也不看未结额（open）**。而 `amount` 的符号守卫只禁「负数」，**放行 0**
//   （invoiceMutationService.ts:63-82：`POSITIVE_ONLY_FIELDS={exchangeRate}`，
//    `NON_NEGATIVE_FIELDS={amount}`）。
//   → 一张 **0 元应收票**（API 可建）会被当成「未结清逾期应收」：
//       · creditService.maxOverdueDays 计入它的账龄 → 虚增最大逾期天数
//       · checkCreditAvailable 命中 `maxOverdueDays > 60` → **blocked / OVERDUE_60_DAYS**
//       · scheduler/tasks/receivableOverdueDetector 给它发「逾期未收清」催办通知
//   而 `recalcInvoiceStatus` 的 Paid 判据是 `invoiceAmount.gt(0) && …`
//   → amount=0 时**永远不可能 Paid** → 这张票永久停在 Issued
//   → 于是「虚增的逾期」**永不清零**：客户被永久挡单，且没有任何自动路径能解除。
//
//   ★ 这也是 L2 高危 5 号「客户索赔模型」的**地基**：客户索赔/折让在实务上就是
//     「负向应收（贷项）」，若判据不放行，贷项票会立刻制造虚假逾期 + 永久冻结。
//
// ── 验的口径不变量 ──
//   S0  ★前置   真 API 建 0 元应收票 **被放行**（201）—— 这是病灶的入口，先钉住
//   S1  ★前置   阳性对照客户（正额票，issueDate=today−95）→ maxOverdueDays > 60
//               （**证明机制真的在工作**，否则 S2 的 0 可能只是脚本没生效 = 空过的验证器）
//   S2  ★承重   被测客户（**只有** 0 元票，issueDate=today−95）→ maxOverdueDays **必须为 0**
//               （不欠钱 → 不存在逾期）
//   S3  ★承重   checkCreditAvailable(被测客户) → **必须不挡**；实得 blocked=true / OVERDUE_60_DAYS
//   S4  gap     0 元票的终态：`recalcInvoiceStatus` 期望「不欠钱 ⇒ 已结清」，
//               实得停在 Issued（**永不 Paid**）—— 属状态语义口径，待 Kevin 判
//   S5  护栏    被测客户名下**不存在**任何正额未结清票（证明 S2 不是被别的票污染）
//   S6          回滚 + 独立复核零残留
//
// ── 证伪方式（**必做**）──
//   给这 3 处查询各加 `amount: { gt: 0 }`：
//     server/src/credit/creditService.ts（maxOverdueDays + runAutoFreezeScan 内联查询）
//     server/src/scheduler/tasks/receivableOverdueDetector.ts（detectAndNotify）
//   → 真库 S2 / S3 应转绿；单测应转绿。跑完必须改回并复跑本脚本。
//
// 用法：cd server && npx tsx ../scripts/acceptance-zero-amount-invoice-credit-gate.ts
//
// ★ 只写 DRILL 实体：客户档案 / 信用额度 / 发票全部用 `__DRILL_ZERO_*` 前缀，
//   回滚按前缀**无条件**扫（不信「API 返回成功」的那些），删完独立复核。

import { createRequire } from 'node:module';
import { SERVER_DIR, REPO_ROOT, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';

// ★ 这批此前**连 dotenv 都不装**，靠环境里已有的 DATABASE_URL（在本 worktree 里 = 被 Prisma 从主 checkout 借来的那份）
//   ⇒ 现显式走本仓 env 真源：取不到就抛 ENV_MISSING，宁可拒跑也不署错账。
loadEnvForScript();
const requireFromServer = createRequire(SERVER_DIR + '/');
const { PrismaClient } = requireFromServer('@prisma/client');
// 被测的**真实服务**（不是脚本里复制的查询）
const { createCreditService, OVERDUE_FREEZE_THRESHOLD_DAYS } = await import(
  '../server/src/credit/creditService'
);
const { recalcInvoiceStatus } = await import('../server/src/finance/allocationService');

const prisma = new PrismaClient();
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';

const TS = Date.now();
const TAG = `DRILL_ZERO_${TS}`;
const REL_Z = `REL__${TAG}_Z`; // 被测客户：只有 0 元票
const REL_P = `REL__${TAG}_P`; // 阳性对照客户：正额逾期票
const CL_Z = `CL__${TAG}_Z`;
const CL_P = `CL__${TAG}_P`;
const INV_NO = (k: string) => `DRILL-ZERO-INV-${k}-${TS}`;
const INV_KEYS = ['Z', 'P'];

const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const TODAY = ymd(Date.now());
const OLD = ymd(Date.now() - 95 * DAY_MS); // issueDate + Net30 = today−65 → 逾期 65 天（> 60）

let passCount = 0;
let failCount = 0;
let gapCount = 0;
function pass(name: string, detail = '') { passCount += 1; console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`); }
function fail(name: string, detail = '') { failCount += 1; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
function gap(name: string, detail = '') { gapCount += 1; console.log(`  ○ 缺口 ${name}${detail ? `  — ${detail}` : ''}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(email: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const data: any = await res.json().catch(() => null);
  return res.ok && data?.token ? data.token : null;
}

async function api(token: string | null, method: string, path: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, data };
}

async function rollback() {
  try {
    await sleep(1500);
    const gone: string[] = [];
    const invRows = await prisma.invoice.findMany({
      where: { invoiceNumber: { startsWith: `DRILL-ZERO-INV-` } }, select: { id: true },
    });
    const invIds = invRows.map((r) => r.id);

    const del = async (label: string, fn: () => Promise<{ count: number }>) => {
      const r = await fn();
      if (r.count) gone.push(`${label}(${r.count})`);
    };

    await del('InvoiceAllocation', () => prisma.invoiceAllocation.deleteMany({ where: { invoiceId: { in: invIds } } }));
    await del('EntityReference', () => prisma.entityReference.deleteMany({ where: { OR: [{ ownerId: { in: invIds } }, { targetId: { in: invIds } }, { ownerId: { in: [REL_Z, REL_P] } }, { targetId: { in: [REL_Z, REL_P] } }] } }));
    await del('EntityLink', () => prisma.entityLink.deleteMany({ where: { OR: [{ fromId: { in: [...invIds, REL_Z, REL_P] } }, { toId: { in: [...invIds, REL_Z, REL_P] } }] } }));
    await del('AuditLog', () => prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [...invIds, REL_Z, REL_P] } }, { targetId: { in: [CL_Z, CL_P] } }] } }));
    // 注意：本脚本**不调用** receivableOverdueDetector（它会扫全库并向真实用户发催办通知），
    // 所以不产生 Notification；若将来加进来，回滚必须按 metadata.entityId 精确清。
    await del('Invoice', () => prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: 'DRILL-ZERO-INV-' } } }));
    await del('CreditLimitHistory', () => prisma.creditLimitHistory.deleteMany({ where: { relationId: { in: [REL_Z, REL_P] } } }));
    await del('CreditLimit', () => prisma.creditLimit.deleteMany({ where: { relationId: { in: [REL_Z, REL_P] } } }));
    await del('Relation', () => prisma.relation.deleteMany({ where: { id: { in: [REL_Z, REL_P] } } }));

    console.log(`\n  回滚：${gone.length ? gone.join(' / ') : '（无需清理）'}`);
  } catch (e: any) {
    console.log(`\n  ⚠ 回滚异常：${e?.message}`);
  }
}

async function verifyNoResidue() {
  const checks: Array<[string, number]> = [];
  checks.push(['invoice 前缀', await prisma.invoice.count({ where: { invoiceNumber: { startsWith: 'DRILL-ZERO-INV-' } } })]);
  checks.push(['relation 前缀', await prisma.relation.count({ where: { id: { contains: TAG } } })]);
  checks.push(['creditLimit 前缀', await prisma.creditLimit.count({ where: { relationId: { in: [REL_Z, REL_P] } } })]);
  checks.push(['creditLimitHistory', await prisma.creditLimitHistory.count({ where: { relationId: { in: [REL_Z, REL_P] } } })]);
  const dirty = checks.filter(([, n]) => n > 0);
  if (dirty.length === 0) pass('S6 回滚复核：零残留', `${checks.length} 项全为 0`);
  else fail('S6 回滚复核：仍有残留', dirty.map(([k, n]) => `${k}=${n}`).join(' '));
}

async function main() {
  const token =
    (await login('charlie.qian@bambook.local')) ??
    (await login('melissa.zhao@bambook.local')) ??
    (await login('jason.shen@bambook.local'));
  if (!token) { fail('登录', 'charlie.qian / melissa.zhao / jason.shen 均失败'); return; }

  console.log('══ 0 元应收票 → 虚假逾期 → 挡单 · 真库演练验收 ══\n');
  console.log('  被测：「未结清应收」判据 type=Receivable && status∈{Issued,PartiallyPaid}（不看金额/open）');
  console.log(`  口径：effectiveDue = dueDate ?? issueDate+30；冻结阈值 daysOverdue > ${OVERDUE_FREEZE_THRESHOLD_DAYS}`);
  console.log(`  演练票：issueDate=${OLD} → 推定到期 ${ymd(Date.now() - 65 * DAY_MS)} → 逾期 65 天\n`);

  const creditService = createCreditService({ prisma } as any);

  // ── 底账：两个 DRILL 客户 + 各自的 Active 信用额度（额度给大，排除「超额度」这条别的拦截）──
  for (const [relId, clId, label] of [[REL_Z, CL_Z, '被测'], [REL_P, CL_P, '阳性对照']] as const) {
    await prisma.relation.create({
      data: {
        id: relId, name: `验收客户-${label}-${TS}`, category: 'Customer', type: 'organization',
        isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: BigInt(Date.now()),
      },
    });
    await prisma.creditLimit.create({
      data: {
        id: clId, relationId: relId, totalLimit: 9999999, usedAmount: 0, currency: 'USD',
        validFrom: OLD, status: 'Active', createdAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      },
    });
  }
  console.log('  底账：2 个 DRILL 客户 + 2 条 Active 额度（额度 9,999,999 USD，排除超额度干扰）');

  // ── S0 ★前置：真 API 建 0 元应收票 —— 是否被放行 ──
  const invBase = (over: any) => ({
    type: 'Receivable', status: 'Issued', currency: 'USD', dueDate: null, ...over,
  });
  const specs: Array<[string, any]> = [
    ['Z', invBase({ invoiceNumber: INV_NO('Z'), amount: '0', issueDate: OLD, customerRelationId: REL_Z, customerName: `验收客户-被测-${TS}` })],
    ['P', invBase({ invoiceNumber: INV_NO('P'), amount: '1000', issueDate: OLD, customerRelationId: REL_P, customerName: `验收客户-阳性对照-${TS}` })],
  ];
  const invIds: Record<string, string> = {};
  for (const [k, body] of specs) {
    const r = await api(token, 'POST', '/api/v1/finance', body);
    if (r.status === 201 && r.data?.id) invIds[k] = r.data.id;
    else fail(`底账：建票 ${k}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  if (Object.keys(invIds).length === 2) {
    pass('底账：建票', 'Z=0 USD（被测）/ P=1000 USD（阳性对照）');
  }
  const zCreated = !!invIds.Z;
  if (!zCreated) {
    fail('S0 ★前置 0 元应收票能否建', '建票失败 → 病灶入口不成立，后续断言不可信');
    return;
  }
  const zRow = await prisma.invoice.findUnique({ where: { id: invIds.Z }, select: { amount: true, status: true, issueDate: true } });
  if (Number(zRow?.amount) === 0 && zRow?.status === 'Issued') {
    pass('S0 ★前置 真 API **放行** 0 元应收票（201）', `amount=${zRow?.amount} status=${zRow?.status} issueDate=${zRow?.issueDate}`);
  } else {
    fail('S0 ★前置 0 元应收票落库形态', `amount=${zRow?.amount} status=${zRow?.status}（期望 0 / Issued）`);
  }

  // ── S1 ★前置（阳性对照）：正额逾期票 → 机制确实在工作 ──
  const pStatus = await creditService.getCreditStatus(REL_P);
  if (pStatus && pStatus.maxOverdueDays > OVERDUE_FREEZE_THRESHOLD_DAYS) {
    pass('S1 ★前置 阳性对照：正额逾期票 → maxOverdueDays 确实被计入', `REL_P.maxOverdueDays=${pStatus.maxOverdueDays}`);
  } else {
    fail('S1 ★前置 阳性对照未生效', `REL_P.maxOverdueDays=${pStatus?.maxOverdueDays}（期望 > ${OVERDUE_FREEZE_THRESHOLD_DAYS}）—— **机制没跑起来，S2 的 0 不可信**`);
  }

  // ── S2 ★承重：被测客户**只有** 0 元票 → maxOverdueDays 必须为 0 ──
  const zStatus = await creditService.getCreditStatus(REL_Z);
  const zMax = zStatus?.maxOverdueDays ?? -1;
  if (zMax === 0) {
    pass('S2 ★承重 0 元票不计逾期', `REL_Z.maxOverdueDays=${zMax}`);
  } else {
    fail(
      'S2 ★承重 0 元票被当成逾期应收',
      `REL_Z.maxOverdueDays=${zMax}（期望 0）—— 该客户名下**只有一张 0 元票**，不欠任何钱，却被记了 ${zMax} 天逾期`,
    );
  }

  // ── S3 ★承重：信用门禁必须不挡 ──
  const gate: any = await creditService.checkCreditAvailable({ relationId: REL_Z });
  const blocked = gate?.ok ? gate.data.blocked : null;
  const code = gate?.ok ? gate.data.blockCode : null;
  if (blocked === false) {
    pass('S3 ★承重 信用门禁不挡', `blocked=false`);
  } else {
    fail(
      'S3 ★承重 信用门禁被 0 元票挡住',
      `blocked=${blocked} blockCode=${code}（期望 blocked=false）—— 业务员开不了新单，且该票永不 Paid ⇒ 无任何自动路径可解除`,
    );
  }

  // ── S5 护栏：被测客户名下不存在正额未结清票（证明 S2 不是被别的票污染）──
  const zPos = await prisma.invoice.count({
    where: { customerRelationId: REL_Z, type: 'Receivable', deletedAt: null, amount: { gt: 0 } },
  });
  if (zPos === 0) pass('S5 护栏 被测客户名下无任何正额应收票', `count=${zPos}`);
  else fail('S5 护栏 被测客户名下竟有正额票', `count=${zPos} —— S2 结论被污染`);

  // ── S4 gap：0 元票的终态语义（待口径）──
  const zRecalc = await recalcInvoiceStatus(prisma as any, invIds.Z);
  if (zRecalc === 'Paid') {
    pass('S4 0 元票被重算为 Paid（不欠钱 ⇒ 已结清）');
  } else {
    gap(
      'S4 0 元票的终态语义',
      `recalcInvoiceStatus → '${zRecalc}'（期望 Paid：不欠钱即已结清）。Paid 判据是 \`amount.gt(0) && Σapplied ≥ amount\` ⇒ amount=0 时**永不 Paid**。` +
      `对 0 元票只是状态语义问题（S2/S3 修好后已无信用后果）；**但对 L2 高危 5 号的「负向贷项票」是必须先定的口径**`,
    );
  }

}

try {
  await main();
} catch (e: any) {
  fail('脚本异常', e?.stack ?? String(e));
} finally {
  await rollback();
  await verifyNoResidue();
  console.log(`\n══ 结果：${passCount} 通过 / ${failCount} 失败 / ${gapCount} 缺口（待口径）══`);
  await prisma.$disconnect();
  process.exit(failCount > 0 ? 1 : 0);
}
