// 少收残留（L2 变异 #8）—— 真库只读诊断（**零写入**）
//
// 为什么需要这个诊断：
//   方案文档 L2 #8 判「少收（客户扣款/银行手续费/索赔抵扣）→ 无销账机制 → 发票永远
//   PartiallyPaid + 永久逾期」。这是**判断**，不是**量化**。本脚本回答三个问题：
//     ① 真库里到底有多少张票挂着「少收尾巴」？尾巴多大（是几毛钱的尾差还是几千块）？
//     ② 这些尾巴有没有真的造成逾期？（逾期天数分布）
//     ③ **最要命的连锁**：有没有客户因为一条尾巴被「永久冻结授信」？
//        （冻结后靠「逾期款全额核销」自动解冻 → 尾巴永不清 → 永远解不了冻）
//
// 只读保证：全程 prisma.findMany / count，无 create/update/delete，无 $transaction 写。
// 用法：node scripts/diag-short-receipt-gap.mjs
//
// ── 口径（与系统真源对齐，不另立一套）──
//   open      = invoice.amount − Σ InvoiceAllocation.appliedAmount   （DR-044 净额口径）
//   effectiveDue = dueDate ?? issueDate + 30 天                        （Net 30 推定）
//   逾期判定  = effectiveDue < asOf
//   系统「已结清」判定 = Σ applied ≥ amount（**零容差**，allocationService.recalcInvoiceStatus）
//   催办/账龄收录门槛 = status ∈ {Issued, PartiallyPaid} 且 open > 0.005（dunningService）
//   信用冻结门槛 = maxOverdueDays > 60（creditService.OVERDUE_FREEZE_THRESHOLD_DAYS）
//   自动解冻条件 = maxOverdueDays ≤ 60 且 frozenBy = 'system_credit_scan'

const OPEN_EPS = 0.005;          // 与 dunningService 同阈值
const FREEZE_DAYS = 60;          // 与 creditService.OVERDUE_FREEZE_THRESHOLD_DAYS 同值
const NET30 = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SYSTEM_CREDIT_ACTOR = 'system_credit_scan';

// 「尾差级」判定档位（脚本内部用于分档，不代表业务口径）
const TAIL_ABS = [1, 10, 50, 100];      // 绝对金额档（原币）
const TAIL_PCT = [0.001, 0.005, 0.01];  // 占票面比例档（0.1% / 0.5% / 1%）

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n}${d ? ' — ' + d : ''}`); };
const head = (n) => console.log(`\n${n}`);

const n2 = (x) => Number(x ?? 0);
const money = (x, cur = '') => `${n2(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? ' ' + cur : ''}`;

async function connectPrisma() {
  const { createRequire } = await import('node:module');
  const req = createRequire('/Users/qinwengu/WorkBuddy/Claw/apps/Bambook/server/');
  const { PrismaClient } = req('@prisma/client');
  return new PrismaClient();
}

function dayStr(ms) { return new Date(ms).toISOString().slice(0, 10); }

function effectiveDueMs(dueDate, issueDate) {
  if (dueDate) { const t = new Date(String(dueDate) + 'T00:00:00Z').getTime(); if (!Number.isNaN(t)) return t; }
  if (issueDate) { const t = new Date(String(issueDate) + 'T00:00:00Z').getTime(); if (!Number.isNaN(t)) return t + NET30 * DAY_MS; }
  return null;
}

async function main() {
  const prisma = await connectPrisma();
  const todayMs = new Date(dayStr(Date.now()) + 'T00:00:00Z').getTime();
  console.log(`══ 少收残留 · 真库只读诊断（asOf=${dayStr(todayMs)}）══`);

  // ── 取全部应收票（未删）+ 全部核销明细，内存里算净额 ──
  const invoices = await prisma.invoice.findMany({
    where: { type: 'Receivable', deletedAt: null },
    select: { id: true, invoiceNumber: true, status: true, amount: true, currency: true, issueDate: true, dueDate: true, customerRelationId: true, customerName: true, settlementDate: true },
  });
  const allocs = await prisma.invoiceAllocation.findMany({ select: { invoiceId: true, appliedAmount: true } });
  const paidBy = new Map();
  for (const a of allocs) paidBy.set(a.invoiceId, (paidBy.get(a.invoiceId) ?? 0) + n2(a.appliedAmount));

  const rows = invoices.map((i) => {
    const amount = n2(i.amount);
    const paid = paidBy.get(i.id) ?? 0;
    const open = Math.round((amount - paid) * 10000) / 10000;
    const dueMs = effectiveDueMs(i.dueDate, i.issueDate);
    const daysOverdue = dueMs != null ? Math.floor((todayMs - dueMs) / DAY_MS) : 0;
    return { ...i, amount, paid, open, dueMs, daysOverdue, ratio: amount > 0 ? open / amount : 0 };
  });

  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  head('【0】真库应收票总览');
  info('应收票总数', String(rows.length));
  for (const [k, v] of Object.entries(byStatus).sort()) info(`status=${k}`, String(v));

  // ── ① 少收残留规模 ──
  head('【1】少收残留：status=PartiallyPaid 且 open > 0.005');
  const partial = rows.filter((r) => r.status === 'PartiallyPaid' && r.open > OPEN_EPS);
  const tailTotalByCur = {};
  for (const r of partial) tailTotalByCur[r.currency] = (tailTotalByCur[r.currency] ?? 0) + r.open;
  info('张数', String(partial.length));
  info('尾巴合计', Object.entries(tailTotalByCur).map(([c, v]) => money(v, c)).join(' · ') || '—');

  if (partial.length) {
    const sorted = [...partial].sort((a, b) => b.open - a.open);
    console.log('    最大 15 条：');
    for (const r of sorted.slice(0, 15)) {
      console.log(`      ${r.invoiceNumber} | 票面 ${money(r.amount, r.currency)} | 已核销 ${money(r.paid, r.currency)} | 尾巴 ${money(r.open, r.currency)} (${(r.ratio * 100).toFixed(3)}%) | 逾期 ${r.daysOverdue} 天 | ${r.customerName ?? r.customerRelationId ?? '(无客户)'}`);
    }
    // 分档统计
    head('【1b】尾巴分档（判断「尾差级」还是「真少收」）');
    for (const t of TAIL_ABS) {
      const hit = partial.filter((r) => r.open <= t);
      info(`open ≤ ${t}`, `${hit.length} 张（占 ${((hit.length / partial.length) * 100).toFixed(1)}%）`);
    }
    for (const p of TAIL_PCT) {
      const hit = partial.filter((r) => r.ratio <= p);
      info(`open ≤ 票面 ${(p * 100).toFixed(1)}%`, `${hit.length} 张（占 ${((hit.length / partial.length) * 100).toFixed(1)}%）`);
    }
    // 小尾巴 + 已严重逾期 = 最典型的「客户付了、就差零头、系统永远报警」
    const stuck = partial.filter((r) => r.daysOverdue > FREEZE_DAYS && r.ratio <= 0.01 && r.open <= 100);
    info('★ 小尾巴（≤100 且 ≤1%）但逾期 > 60 天', `${stuck.length} 张`);
    for (const r of stuck.slice(0, 10)) {
      console.log(`      ${r.invoiceNumber} | 尾巴 ${money(r.open, r.currency)} | 逾期 ${r.daysOverdue} 天 | ${r.customerName ?? r.customerRelationId ?? '(无客户)'}`);
    }
    // ★ 样本充分性：别拿「0 条」当「不需要修」的证据
    const smallTail = partial.filter((r) => r.open <= 100 && r.ratio <= 0.01);
    if (smallTail.length === 0) {
      info('★ 样本充分性', '真库**没有**任何小尾巴样本 → **不能用「0 条」推断「少收场景不存在」**');
      info('  ', '真库是 seed 演示数据（残额清一色 50%/70% 整档，是脚本造的「部分收款」），业务尚未真跑过');
      info('  ', '判据只能是「代码事实 + 构造会踩它的输入」，与「order_auto_settle 审计 0 条 ≠ hook 坏了」同病');
    }
  }

  // ── ② 逾期分布 ──
  head('【2】未结清应收的逾期分布（净额口径）');
  const openRows = rows.filter((r) => (r.status === 'Issued' || r.status === 'PartiallyPaid') && r.open > OPEN_EPS);
  const buckets = { 未到期: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  for (const r of openRows) {
    if (r.daysOverdue <= 0) buckets['未到期'] += 1;
    else if (r.daysOverdue <= 30) buckets['1-30'] += 1;
    else if (r.daysOverdue <= 60) buckets['31-60'] += 1;
    else if (r.daysOverdue <= 90) buckets['61-90'] += 1;
    else buckets['90+'] += 1;
  }
  info('未结清票数（Issued/PartiallyPaid 且 open>0）', String(openRows.length));
  for (const [k, v] of Object.entries(buckets)) info(`逾期档 ${k}`, String(v));

  // ── ③ ★ 被尾巴锁死的冻结客户 ──
  head('【3】★ 信用冻结客户：是否被「小尾巴」锁死（自动解冻永不触发）');
  const frozen = await prisma.creditLimit.findMany({
    where: { status: 'Frozen', deletedAt: null },
    select: { id: true, relationId: true, currency: true, status: true, frozenBy: true, frozenAt: true, totalLimit: true, usedAmount: true },
  });
  info('Frozen 额度条数', String(frozen.length));
  const frozenByActor = {};
  for (const f of frozen) frozenByActor[String(f.frozenBy)] = (frozenByActor[String(f.frozenBy)] ?? 0) + 1;
  for (const [k, v] of Object.entries(frozenByActor)) info(`frozenBy=${k}`, String(v));

  let lockedByTail = 0;
  for (const f of frozen) {
    if (String(f.frozenBy) !== SYSTEM_CREDIT_ACTOR) continue;
    const mine = openRows.filter((r) => r.customerRelationId === f.relationId);
    if (mine.length === 0) continue;
    const maxAll = Math.max(...mine.map((r) => r.daysOverdue));
    // 只看「非尾差」的票：排除 open ≤ 100 且 ≤1% 票面的行
    const material = mine.filter((r) => !(r.open <= 100 && r.ratio <= 0.01));
    const maxMaterial = material.length ? Math.max(...material.map((r) => r.daysOverdue)) : 0;
    if (maxAll > FREEZE_DAYS && maxMaterial <= FREEZE_DAYS) {
      lockedByTail += 1;
      const tailSum = mine.filter((r) => r.open <= 100 && r.ratio <= 0.01).reduce((s, r) => s + r.open, 0);
      console.log(`      ${f.relationId} | 最大逾期 ${maxAll} 天（剔除小尾巴后仅 ${maxMaterial} 天）| 尾巴合计 ${money(tailSum, f.currency)} | 额度 ${money(f.totalLimit, f.currency)} 已占用 ${money(f.usedAmount, f.currency)}`);
    }
  }
  if (lockedByTail > 0) fail('★ 被小尾巴锁死、自动解冻永不触发的客户', `${lockedByTail} 个 —— 这就是「业务员开不了新单、只能骂娘」的那一类`);
  else pass('未被小尾巴锁死的冻结客户', '0 个（或真库当前无 system_credit_scan 冻结）');

  // ── ④ bankFee 在 Receipt 凭证上的「死数据」规模 ──
  head('【4】bankFee 的消费面核查');
  const recvFee = await prisma.paymentVoucher.findMany({
    where: { type: 'Receipt', deletedAt: null, bankFee: { gt: 0 } },
    select: { id: true, voucherNumber: true, amount: true, bankFee: true, currency: true, invoiceId: true, appliedAmount: true, status: true },
  });
  const disbFee = await prisma.paymentVoucher.count({ where: { type: 'Disbursement', deletedAt: null, bankFee: { gt: 0 } } });
  info('Receipt 凭证带非零 bankFee', `${recvFee.length} 条（合计 ${recvFee.reduce((s, v) => s + n2(v.bankFee), 0).toFixed(2)}）`);
  info('Disbursement 凭证带非零 bankFee', `${disbFee} 条（唯一被利润表「杂费」消费的一类）`);
  if (recvFee.length) {
    console.log('    Receipt 侧样本（这些手续费在系统里**不影响任何应收核销**）：');
    for (const v of recvFee.slice(0, 8)) {
      console.log(`      ${v.voucherNumber} | 凭证 ${money(v.amount, v.currency)} | 手续费 ${money(v.bankFee, v.currency)} | 已核销 ${v.appliedAmount != null ? money(v.appliedAmount, v.currency) : '—'} | 状态 ${v.status}`);
    }
  }

  // ── ⑤ 一致性护栏：有没有 Paid 却还挂着 open ──
  head('【5】一致性护栏（应全为 0）');
  const paidWithOpen = rows.filter((r) => r.status === 'Paid' && r.open > OPEN_EPS);
  const overAlloc = rows.filter((r) => r.open < -OPEN_EPS);
  // ★ 僵尸票：净额已清零/为负，但状态没跟着重算。
  //   成因（2026-09-17 修掉）：`updateInvoice` 允许改 amount 却从不重算 status。
  //   危害：creditService.maxOverdueDays 只按 status 过滤（连 open 都不看）→ 永久计入
  //   最大逾期天数 → 客户被自动冻结授信后**永不自动解冻**。
  const zombiePartial = rows.filter((r) => r.status === 'PartiallyPaid' && r.open <= OPEN_EPS);
  if (paidWithOpen.length === 0) pass('status=Paid 但 open>0（反向僵尸票）', '0 张');
  else fail('status=Paid 但 open>0（反向僵尸票）', `${paidWithOpen.length} 张 —— 状态与净额不一致：${paidWithOpen.slice(0, 5).map((r) => `${r.invoiceNumber}(${money(r.open, r.currency)})`).join(', ')}`);
  if (zombiePartial.length === 0) pass('status=PartiallyPaid 但 open≤0.005（僵尸票）', '0 张');
  else fail('status=PartiallyPaid 但 open≤0.005（僵尸票）', `${zombiePartial.length} 张 —— 永久计入最大逾期天数、锁死客户授信：${zombiePartial.slice(0, 5).map((r) => `${r.invoiceNumber}(${money(r.open, r.currency)})`).join(', ')}`);
  if (overAlloc.length === 0) pass('超额核销（open<0）', '0 张');
  else fail('超额核销（open<0）', `${overAlloc.length} 张：${overAlloc.slice(0, 5).map((r) => `${r.invoiceNumber}(${money(r.open, r.currency)})`).join(', ')}`);

  // ── ⑥ 口径守卫：writeoff 端点是否存在（本脚本只做「有没有」的事实陈述）──
  head('【6】销账能力的结构事实（供口径决策）');
  info('Invoice.status 合法值', 'Draft | Issued | PartiallyPaid | Paid | Cancelled —— **无 WrittenOff**');
  info('invoices:approve:writeoff 权限码', '已定义（rolePermissionMatrix「坏账核销/发票作废审批」）但**全仓无路由调用** → 设计过、未实现');
  info('CreditNote / 折让 / 尾差核销模型', 'schema 中**不存在**');
  info('bankFee 对 Receipt 的作用', '**无** —— 仅 Disbursement 的「未核销发票」凭证进利润表杂费（profitSheetService:266）');

  console.log('\n──────────────────────────────');
  const failed = results.filter((r) => r.ok === false).length;
  const passed = results.filter((r) => r.ok === true).length;
  console.log(`诊断完成：${passed} 项通过 / ${failed} 项异常 / ${results.filter((r) => r.ok === null).length} 项事实陈述`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('诊断异常：', e?.stack || e); process.exit(1); });
