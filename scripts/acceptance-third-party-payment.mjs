// L2 高危 3 号「第三方代付」—— 真库演练验收（真实 API 写路径 + 自回滚）
import { loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
//
// 为什么必须做演练（而不是只读验收）：
//   代付口径落在**写路径**上：要真的发 POST 建票/建凭证/核销/认领，才能确认
//     ① 跨客户**不再被拦**（修前业务员认领通道直接 400 CUSTOMER_MISMATCH）
//     ② 跨客户**留下了痕**（修前财务通道放行但零留痕，A 替 B 付在账上看不见）
//     ③ 只放开了「客户」这一道，币种等其它边界**没有被顺手放开**
//   只读验收看不到这些。
//
// ── 口径（Kevin 2026-09-17 拍板）：允许 + 留痕，不阻断 ──
//
// 验的口径不变量：
//   T1 ★承重  跨客户核销（B 的收款 → A 的票）→ 201 **放行** + AuditLog
//             action=third_party_payment_detected（含付款方/合同客户/判据）
//   T2 护栏   同客户核销（走 L5 自动核销联动）→ 落库且**不写**代付审计行（不误报）
//   T3 ★承重  业务员认领通道跨客户 → 201（修前 400 CUSTOMER_MISMATCH）+ 留痕
//   T4        跨客户 + 非 USD（CNY）→ 201 + 留痕（币种维度不误伤代付判定）
//   T5 护栏   跨客户但币种不符 → 400 CURRENCY_MISMATCH（只放开客户这一道）
//   T6 护栏   Payable 票 + Disbursement 凭证 → 201 且**不写**代付审计行
//             （口径隔离：Payable 的 customerRelationId 是供应商，不是「谁付的钱」）
//   T7        两侧都无客户档案、名称不同 → 201 + 留痕 basis=name（旧数据兜底）
//   T8 护栏   超额 → 400 + AMOUNT_EXCEEDS_*（错误码映射，修前兜成 500 CREATE_FAILED）
//
// ── 本脚本首跑（2026-09-17）抓到的两个**真缺陷**（均已修）──
//   ① applyAllocation 的 invoice select 少了 `customerName` → 「名称兜底判定」分支在
//      生产里**恒不触发**（T7 转红）。单测全绿是因为 mock 无视 select 直接返回整行。
//      修法：select 补字段 + 给 ledger 测试的 mock 加「尊重 select」投影。
//   ② 币种不符/超额等业务校验码不在 toAllocationError 白名单 → 兜成 CREATE_FAILED →
//      route 映射 **500**（T5 转红）。财务看到「服务器错误」而实际只是「币种不一致」。
//      修法：白名单补齐 + route 映射 400。
//
// ── 演练设计坑（下次写同类脚本先看这条）──
//   **建 Receipt 凭证会触发 L5 自动核销联动**（PaymentVoucherCreated → 同客户最早未结清
//   Receivable 票，金额 = min(凭证剩余, 发票剩余)）。若演练还要手动核销同一张凭证，
//   两者会抢余额 → 谁先谁吃光 → 结果不确定（T2 首跑就是这么被打成假红的）。
//   做法：要么**别手动核销**、直接断言 L5 落库后的结果（本脚本 T2），
//   要么让演练凭证的客户**没有**匹配的未结清应收票（L5 会 no matching invoice 跳过）。
//
// ★ 承重 vs 护栏（**实测标注，别猜**）：
//   承重 = T1 / T3 / T4 / T7 的**留痕断言**（同一个机制：applyAllocation 里的代付检测）。
//   护栏 = T2 / T5 / T6 / T8 —— 它们证的是「没误报 / 没过度放开 / 错误码没兜成 500」，
//          **证伪态也全绿**，不具区分度。
//   实测（2026-09-17）：
//     · 摘掉 applyAllocation 的检测 → T1/T3/T4/T7 的留痕断言转红（4 条），T2/T5/T6/T8 全绿
//     · 恢复认领通道的 CUSTOMER_MISMATCH 硬拒 → T3 转红（400），其余全绿
//   别把护栏当承重：看到「证伪只红了留痕那几条」是**正确**结果，不是没钉住。
//
// 证伪方式（launchd 托管后端不继承 shell env → 只能改代码 + kickstart）：
//   A 注释掉 server/src/finance/allocationService.ts 的 step 5b 检测块
//     → T1/T3/T4/T7 的「留痕」断言转红（T1/T3 的 201 仍绿）
//   B 恢复 server/src/finance/receiptClaimService.ts 的 `fail('CUSTOMER_MISMATCH', ...)`
//     → T3 转红（400）
//   跑完务必改回 + 再 kickstart -k。
//
// 演练数据全部带 DRILL-3P 前缀 / 精确 id；finally 里按精确 ID 硬删 + 独立复核零残留。
// 联动副作用一并清：InvoiceAllocation / EntityReference / EntityLink / AuditLog /
// CreditLimit(+History) / Notification / AgentJob(bev:ThirdPartyPaymentDetected)。
// 用法：node scripts/acceptance-third-party-payment.mjs
const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';

const results = [];
const pass = (n, d = '') => { results.push({ ok: true }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false }); console.log(`  ✗ ${n} — ${d}`); };
const info = (n, d = '') => { results.push({ ok: null }); console.log(`  ⓘ ${n} — ${d}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

// ── 演练常量 ──────────────────────────────────────────────────────────
const TS = Date.now();
const REL_PAYER = `REL__DRILL_3P_PAYER_${TS}`;   // 实际付款方（母公司/货代）
const REL_CUST = `REL__DRILL_3P_CUST_${TS}`;     // 合同客户（票开给谁）
const REL_SUP = `REL__DRILL_3P_SUP_${TS}`;       // 供应商（Payable 票头）
// 专供 T2：该客户名下**只有一张**应收票 → L5 自动核销的目标唯一（否则 orderBy issueDate
// 在 issueDate 相同的情况下是任意序，L5 可能挑到别的票 → 断言条件恒不成立 = 空过）
const REL_CUST2 = `REL__DRILL_3P_CUST2_${TS}`;
const NAME_PAYER = `DRILL-3P-PAYER-${TS}`;
const NAME_CUST = `DRILL-3P-CUST-${TS}`;
const NAME_CUST2 = `DRILL-3P-CUST2-${TS}`;
const NAME_NN_INV = `DRILL-3P-NN-INV-${TS}`;
const NAME_NN_VOU = `DRILL-3P-NN-VOU-${TS}`;

const INV_NO = (k) => `DRILL-3P-INV-${k}-${TS}`;
const VOU_NO = (k) => `DRILL-3P-PAY-${k}-${TS}`;
/** 所有走 POST 建单的用例 key —— 回滚与复核按这批号**无条件**扫，不依赖 API 是否返回 201 */
const INV_KEYS = ['A', 'CCY', 'PAY', 'NN', 'CLM', 'S'];
const VOU_KEYS = ['PAYER', 'CUST', 'CNY', 'DISB', 'NN', 'CLM'];

let prisma = null;
const drillStart = new Date();
const created = { invoices: {}, vouchers: {} };   // key → id
let notifBefore = new Set();
let agentJobBefore = new Set();

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

/** 演练前置快照：用于事后 diff 出「本次演练新产生的」通知/事件行（精确，不靠文案匹配） */
async function snapshotSideEffects() {
  const [notifs, jobs] = await Promise.all([
    prisma.notification.findMany({ select: { id: true } }),
    prisma.agentJob.findMany({ select: { id: true } }),
  ]);
  notifBefore = new Set(notifs.map(n => n.id));
  agentJobBefore = new Set(jobs.map(j => j.id));
}

const allocIdOf = (invKey, vouKey) => `ALLOC__${created.invoices[invKey]}__${created.vouchers[vouKey]}`;

/** 该核销是否留下了「第三方代付」审计行（targetId = ALLOC__<invoiceId>__<voucherId>） */
async function thirdPartyAuditRows(allocId) {
  return prisma.auditLog.findMany({
    where: { action: 'third_party_payment_detected', targetId: allocId },
    select: { id: true, detail: true, actorId: true, operationType: true },
  });
}

async function rollback() {
  try {
    // fire-and-forget：事件发布 → 通知订阅 → 落 Notification 是异步的，先等落定再 diff
    await sleep(2000);
    const gone = [];
    const invIds = Object.values(created.invoices);
    const vouIds = Object.values(created.vouchers);
    const allocIds = [];
    for (const ik of Object.keys(created.invoices)) {
      for (const vk of Object.keys(created.vouchers)) allocIds.push(allocIdOf(ik, vk));
    }
    const allIds = [...invIds, ...vouIds];

    // ① 核销明细（按发票/凭证两侧无条件扫，含被拒用例意外落库的）
    const alloc = await prisma.invoiceAllocation.deleteMany({
      where: { OR: [{ invoiceId: { in: invIds } }, { voucherId: { in: vouIds } }] },
    });
    if (alloc.count) gone.push(`InvoiceAllocation(${alloc.count})`);

    // ② 引用/链接副作用（syncInvoiceReferences / syncPaymentVoucherReferences / syncAllocationVoucherLinks）
    const refs = await prisma.entityReference.deleteMany({
      where: { OR: [{ ownerId: { in: allIds } }, { targetId: { in: allIds } }] },
    });
    if (refs.count) gone.push(`EntityReference(${refs.count})`);
    const links = await prisma.entityLink.deleteMany({
      where: { OR: [{ fromId: { in: allIds } }, { toId: { in: allIds } }] },
    });
    if (links.count) gone.push(`EntityLink(${links.count})`);

    // ③ 审计（含代付留痕本身）—— targetId 覆盖 发票 / 凭证 / 核销 id
    const audit = await prisma.auditLog.deleteMany({
      where: { targetId: { in: [...allIds, ...allocIds] } },
    });
    if (audit.count) gone.push(`AuditLog(${audit.count})`);

    // ④ 信用额度联动（createInvoice / applyAllocation 会写）
    const cl = await prisma.creditLimit.deleteMany({ where: { relationId: { in: [REL_PAYER, REL_CUST, REL_CUST2, REL_SUP] } } });
    if (cl.count) gone.push(`CreditLimit(${cl.count})`);
    const clh = await prisma.creditLimitHistory.deleteMany({ where: { relationId: { in: [REL_PAYER, REL_CUST, REL_CUST2, REL_SUP] } } });
    if (clh.count) gone.push(`CreditLimitHistory(${clh.count})`);

    // ⑤ 本次演练新产生的通知 / 事件行（diff 快照，精确，不靠文案匹配）
    const [notifsNow, jobsNow] = await Promise.all([
      prisma.notification.findMany({ select: { id: true } }),
      prisma.agentJob.findMany({ select: { id: true } }),
    ]);
    const newNotifs = notifsNow.map(n => n.id).filter(id => !notifBefore.has(id));
    const newJobs = jobsNow.map(j => j.id).filter(id => !agentJobBefore.has(id));
    if (newNotifs.length) {
      const r = await prisma.notification.deleteMany({ where: { id: { in: newNotifs } } });
      gone.push(`Notification(${r.count})`);
    }
    if (newJobs.length) {
      const r = await prisma.agentJob.deleteMany({ where: { id: { in: newJobs } } });
      gone.push(`AgentJob(${r.count})`);
    }

    // ⑥ 主实体：按单号无条件扫（证伪跑时「被拦的用例」也可能落库）
    const invs = await prisma.invoice.findMany({ where: { invoiceNumber: { in: INV_KEYS.map(INV_NO) } }, select: { id: true } });
    if (invs.length) {
      const r = await prisma.invoice.deleteMany({ where: { id: { in: invs.map(i => i.id) } } });
      gone.push(`Invoice(${r.count})`);
    }
    const vous = await prisma.paymentVoucher.findMany({ where: { voucherNumber: { in: VOU_KEYS.map(VOU_NO) } }, select: { id: true } });
    if (vous.length) {
      const r = await prisma.paymentVoucher.deleteMany({ where: { id: { in: vous.map(v => v.id) } } });
      gone.push(`PaymentVoucher(${r.count})`);
    }

    pass('回滚：硬删演练行', gone.join(' / ') || '（无）');
  } catch (e) {
    fail('回滚失败', `${e?.message} —— 需手工清理 invoices=${JSON.stringify(created.invoices)} vouchers=${JSON.stringify(created.vouchers)}`);
  }
}

/** 独立复核零残留（不信回滚自述，按精确标识回查） */
async function verifyNoResidue() {
  const checks = [];
  const invs = await prisma.invoice.findMany({ where: { invoiceNumber: { in: INV_KEYS.map(INV_NO) } }, select: { id: true } });
  const vous = await prisma.paymentVoucher.findMany({ where: { voucherNumber: { in: VOU_KEYS.map(VOU_NO) } }, select: { id: true } });
  checks.push(['invoice', invs.length]);
  checks.push(['paymentVoucher', vous.length]);
  const ids = [...invs.map(i => i.id), ...vous.map(v => v.id)];
  checks.push(['invoiceAllocation', await prisma.invoiceAllocation.count({ where: { OR: [{ invoiceId: { in: ids } }, { voucherId: { in: ids } }] } })]);
  checks.push(['entityReference', await prisma.entityReference.count({ where: { OR: [{ ownerId: { in: ids } }, { targetId: { in: ids } }] } })]);
  checks.push(['entityLink', await prisma.entityLink.count({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } })]);
  checks.push(['auditLog', await prisma.auditLog.count({ where: { targetId: { in: ids } } })]);
  checks.push(['creditLimit', await prisma.creditLimit.count({ where: { relationId: { in: [REL_PAYER, REL_CUST, REL_CUST2, REL_SUP] } } })]);
  checks.push(['creditLimitHistory', await prisma.creditLimitHistory.count({ where: { relationId: { in: [REL_PAYER, REL_CUST, REL_CUST2, REL_SUP] } } })]);
  // 全库前缀兜底（不信单个脚本的复核）
  checks.push(['DRILL-3P invoice 前缀', await prisma.invoice.count({ where: { invoiceNumber: { startsWith: 'DRILL-3P-' } } })]);
  checks.push(['DRILL-3P voucher 前缀', await prisma.paymentVoucher.count({ where: { voucherNumber: { startsWith: 'DRILL-3P-' } } })]);
  const dirty = checks.filter(([, n]) => n > 0);
  if (dirty.length === 0) pass('回滚复核：零残留', `${checks.length} 项全为 0`);
  else fail('回滚复核：仍有残留', dirty.map(([k, n]) => `${k}=${n}`).join(' '));
}

async function main() {
  // 建票要 invoices:write（财务/超管）；认领要 invoices:read；核销要 invoices:reconcile
  const financeToken = await login('charlie.qian@bambook.local')
    ?? await login('melissa.zhao@bambook.local');
  const adminToken = await login('jason.shen@bambook.local');
  const token = financeToken ?? adminToken;
  if (!token) { fail('登录', 'charlie.qian / melissa.zhao / jason.shen 均失败'); return; }
  const claimToken = adminToken ?? financeToken;

  console.log('══ L2 高危 3 号「第三方代付」· 真库演练验收（真实 API 写路径 + 自回滚）══\n');
  console.log(`  实际付款方档案 = ${REL_PAYER}（${NAME_PAYER}）`);
  console.log(`  合同客户档案   = ${REL_CUST}（${NAME_CUST}）`);
  console.log('  口径 = 允许 + 留痕（不阻断）；判定真源 server/src/finance/thirdPartyPaymentGuard.ts\n');

  await connectPrisma();
  await snapshotSideEffects();

  // ── 底账：建 5 张票 + 6 张凭证（全部 DRILL-3P 前缀，按精确单号可硬删）──
  const invBase = (over) => ({
    type: 'Receivable', status: 'Issued', amount: '1000', currency: 'USD',
    issueDate: '2026-09-17', dueDate: '2026-12-31', ...over,
  });
  const vouBase = (over) => ({
    type: 'Receipt', amount: '500', currency: 'USD',
    paymentDate: '2026-09-17', paymentMethod: 'TT', ...over,
  });

  const invSpecs = [
    ['A', invBase({ invoiceNumber: INV_NO('A'), customerRelationId: REL_CUST, customerName: NAME_CUST })],
    ['CCY', invBase({ invoiceNumber: INV_NO('CCY'), currency: 'CNY', customerRelationId: REL_CUST, customerName: NAME_CUST })],
    ['PAY', invBase({ type: 'Payable', invoiceNumber: INV_NO('PAY'), customerRelationId: REL_SUP, customerName: 'DRILL-3P-SUPPLIER' })],
    ['NN', invBase({ invoiceNumber: INV_NO('NN'), customerRelationId: null, customerName: NAME_NN_INV })],
    ['CLM', invBase({ invoiceNumber: INV_NO('CLM'), customerRelationId: REL_CUST, customerName: NAME_CUST })],
    // T2 专用：客户 REL_CUST2 名下唯一应收票 → L5 自动核销目标唯一
    ['S', invBase({ invoiceNumber: INV_NO('S'), customerRelationId: REL_CUST2, customerName: NAME_CUST2 })],
  ];
  for (const [k, body] of invSpecs) {
    const r = await api(token, 'POST', '/api/v1/finance', body);
    if (r.status === 201 && r.data?.id) { created.invoices[k] = r.data.id; }
    else fail(`底账：建票 ${k}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const vouSpecs = [
    ['PAYER', vouBase({ voucherNumber: VOU_NO('PAYER'), customerRelationId: REL_PAYER, customerName: NAME_PAYER })],
    ['CUST', vouBase({ voucherNumber: VOU_NO('CUST'), customerRelationId: REL_CUST2, customerName: NAME_CUST2 })],
    ['CNY', vouBase({ voucherNumber: VOU_NO('CNY'), currency: 'CNY', customerRelationId: REL_PAYER, customerName: NAME_PAYER })],
    ['DISB', vouBase({ type: 'Disbursement', voucherNumber: VOU_NO('DISB'), customerRelationId: REL_PAYER, customerName: NAME_PAYER })],
    ['NN', vouBase({ voucherNumber: VOU_NO('NN'), customerRelationId: null, customerName: NAME_NN_VOU })],
    ['CLM', vouBase({ voucherNumber: VOU_NO('CLM'), customerRelationId: REL_PAYER, customerName: NAME_PAYER })],
  ];
  for (const [k, body] of vouSpecs) {
    if (k === 'DISB') continue; // 付款凭证有 DR-017「先申请后付款」门禁，API 建不了 → 见下
    const r = await api(token, 'POST', '/api/v1/finance/vouchers', body);
    if (r.status === 201 && r.data?.id) { created.vouchers[k] = r.data.id; }
    else fail(`底账：建凭证 ${k}`, `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  // Disbursement 凭证走 prisma 脚手架（脚手架走 prisma、被测写路径走真实 API —— 与 seed 订单同规）。
  // 目的只是覆盖 detectThirdPartyPayment 的「非 Receipt 不判定」分支；核销本身仍走真实 API。
  {
    const now = BigInt(Date.now());
    const id = `PAY__DRILL3PDISB_${TS}`;
    await prisma.paymentVoucher.create({
      data: {
        id, voucherNumber: VOU_NO('DISB'), type: 'Disbursement', voucherCategory: 'normal',
        amount: '500', currency: 'USD', paymentDate: '2026-09-17', paymentMethod: 'TT',
        status: 'unreconciled', bankFee: '0', baseCurrency: 'CNY',
        customerRelationId: REL_PAYER, customerName: NAME_PAYER,
        createdAt: now, updatedAt: now,
      },
    });
    created.vouchers.DISB = id;
  }
  const builtInv = Object.keys(created.invoices).length;
  const builtVou = Object.keys(created.vouchers).length;
  const wantInv = invSpecs.length;
  const wantVou = vouSpecs.length;
  if (builtInv === wantInv && builtVou === wantVou) pass('建演练底账', `${wantInv} 张票（含 1 Payable / 1 CNY / 1 无档案）+ ${wantVou} 张凭证`);
  else info('建演练底账', `票 ${builtInv}/${wantInv}，凭证 ${builtVou}/${wantVou} —— 后续依赖项会连带失败`);

  const alloc = (invKey, vouKey, amount) => api(token, 'POST', '/api/v1/finance/allocations', {
    invoiceId: created.invoices[invKey], voucherId: created.vouchers[vouKey], appliedAmount: amount,
    appliedDate: '2026-09-17',
  });

  /**
   * 核销 POST 在真库上会偶发 409 CONFLICT（Serializable 隔离中止，P2034）。
   * 根因：建票/建凭证是 fire-and-forget 的信用重算/批次重算还在跑，与随后的核销事务
   * 撞同一行 → SSI 中止。服务端语义明确是「可安全重试」，所以这里重试，不算失败。
   */
  const allocWithRetry = async (invKey, vouKey, amount, tries = 4) => {
    let r = null;
    for (let i = 0; i < tries; i++) {
      r = await alloc(invKey, vouKey, amount);
      if (r.status !== 409) return r;
      info(`核销 ${invKey}×${vouKey} 遇 409 CONFLICT（SSI 可安全重试）`, `第 ${i + 1} 次重试`);
      await sleep(600);
    }
    return r;
  };

  // ── T1 ★承重：跨客户核销 → 放行 + 留痕 ────────────────────────────
  const t1 = await allocWithRetry('A', 'PAYER', 400);
  if (t1.status === 201) pass('T1 ★跨客户核销**放行**（不阻断）', '201');
  else fail('T1 ★跨客户核销放行', `HTTP ${t1.status} ${JSON.stringify(t1.data).slice(0, 200)}`);
  const t1Rows = await thirdPartyAuditRows(allocIdOf('A', 'PAYER'));
  if (t1Rows.length === 1) {
    const d = t1Rows[0].detail?.after ?? {};
    const okFields = d.thirdPartyPayment === true && d.thirdPartyPaymentBasis === 'relationId'
      && d.payerRelationId === REL_PAYER && d.invoiceCustomerRelationId === REL_CUST
      && d.payerName === NAME_PAYER && d.invoiceCustomerName === NAME_CUST;
    if (okFields) pass('T1 ★留痕：third_party_payment_detected 审计行字段完整', `basis=relationId，付款方=${d.payerName}，合同客户=${d.invoiceCustomerName}`);
    else fail('T1 ★留痕字段', JSON.stringify(d).slice(0, 300));
  } else fail('T1 ★留痕：代付审计行', `找到 ${t1Rows.length} 行（期望 1）—— 修前这里是 0 行（放行但零留痕）`);

  // ── T2 护栏：同客户核销 → 不写代付审计行 ──────────────────────────
  // ★ 这里**刻意不手动 POST**：Receipt 凭证登记会触发 L5 自动核销联动
  //   （`PaymentVoucherCreated` → 核销到该客户最早的未结清 Receivable 票），
  //   手动 POST 会与 L5 抢同一张凭证（谁先谁把余额吃光）→ 演练不确定。
  //   改成「等 L5 自己核完，再断言没写代付审计行」：既确定，又走的是真实自动化路径。
  //   （首跑 2026-09-17 正是被这条联动打成假红：手动 POST 时凭证余额已被 L5 吃成 0。）
  const sameCustAllocId = allocIdOf('S', 'CUST');
  let l5Allocated = false;
  for (let i = 0; i < 24; i++) {
    const rows = await prisma.invoiceAllocation.findMany({
      where: { invoiceId: created.invoices.S, voucherId: created.vouchers.CUST },
      select: { appliedAmount: true },
    });
    if (rows.length > 0) { l5Allocated = true; break; }
    await sleep(500);
  }
  // ★ 必须先证「分配行确实存在」再断言「没写代付审计行」——
  //   否则被断言的那条核销压根不存在，'0 行代付审计' 恒真 = 空过的验证器。
  //   （首版就是这么空过的：L5 把凭证核到了同客户另一张票上，等待条件恒不成立。）
  if (l5Allocated) pass('T2 同客户核销已落库（L5 自动核销联动）', 'ALLOC__INV_S__VOU_CUST');
  else fail('T2 同客户核销落库', '等待 12s 未出现 —— L5 是否被配置关掉了？');
  const t2Rows = await thirdPartyAuditRows(sameCustAllocId);
  if (l5Allocated && t2Rows.length === 0) pass('T2 护栏：同客户**不误报**代付', '分配行在、代付审计行 = 0');
  else fail('T2 护栏：同客户误报代付', `找到 ${t2Rows.length} 行`);

  // ── T3 ★承重：业务员认领通道跨客户 → 放行 + 留痕（修前 400）────────
  let t3 = await api(claimToken, 'POST', '/api/v1/finance/receipt-claims/claim', {
    voucherId: created.vouchers.CLM, invoiceId: created.invoices.CLM, amount: 100,
  });
  if (t3.status === 404 && t3.data?.error?.code === 'INVOICE_NOT_VISIBLE' && financeToken) {
    info('T3 可见性门禁（与代付口径无关）', 'admin 看不到该票 → 换财务账号重试');
    t3 = await api(financeToken, 'POST', '/api/v1/finance/receipt-claims/claim', {
      voucherId: created.vouchers.CLM, invoiceId: created.invoices.CLM, amount: 100,
    });
  }
  if (t3.status === 201) pass('T3 ★业务员认领通道跨客户**放行**', '201（修前 400 CUSTOMER_MISMATCH）');
  else fail('T3 ★业务员认领通道跨客户放行', `HTTP ${t3.status} ${JSON.stringify(t3.data).slice(0, 200)}`);
  const t3Rows = await thirdPartyAuditRows(allocIdOf('CLM', 'CLM'));
  if (t3Rows.length === 1) pass('T3 ★留痕：认领通道也写了代付审计行', `basis=${t3Rows[0].detail?.after?.thirdPartyPaymentBasis}`);
  else fail('T3 ★留痕：认领通道代付审计行', `找到 ${t3Rows.length} 行（期望 1）`);

  // ── T4 跨客户 + 非 USD → 放行 + 留痕 ──────────────────────────────
  const t4 = await allocWithRetry('CCY', 'CNY', 300);
  if (t4.status === 201) pass('T4 跨客户 + CNY 核销放行', '201');
  else fail('T4 跨客户 + CNY 核销放行', `HTTP ${t4.status} ${JSON.stringify(t4.data).slice(0, 200)}`);
  const t4Rows = await thirdPartyAuditRows(allocIdOf('CCY', 'CNY'));
  if (t4Rows.length === 1) pass('T4 留痕：非 USD 同样判定代付', `currency 维度不误伤判定`);
  else fail('T4 留痕：非 USD 代付审计行', `找到 ${t4Rows.length} 行（期望 1）`);

  // ── T5 护栏：跨客户但币种不符 → 仍拒绝（只放开客户这一道）─────────
  const t5 = await allocWithRetry('CCY', 'PAYER', 100);
  if (t5.status === 400 && t5.data?.error?.code === 'CURRENCY_MISMATCH') {
    pass('T5 护栏：跨客户 + 币种不符仍被拒', '400 CURRENCY_MISMATCH（没把币种一起放开）');
  } else fail('T5 护栏：币种校验', `HTTP ${t5.status} ${JSON.stringify(t5.data).slice(0, 200)}`);
  const t5Rows = await thirdPartyAuditRows(allocIdOf('CCY', 'PAYER'));
  if (t5Rows.length === 0) pass('T5 护栏：被拒的核销零留痕（拦在写之前）', '代付审计行 = 0');
  else fail('T5 护栏：被拒却留痕', `${t5Rows.length} 行 —— 拦在写之后了`);

  // ── T6 护栏：Payable 票 + Disbursement 凭证 → 不判定（口径隔离）──
  const t6 = await allocWithRetry('PAY', 'DISB', 100);
  if (t6.status === 201) pass('T6 Payable 票核销放行', '201');
  else fail('T6 Payable 票核销放行', `HTTP ${t6.status} ${JSON.stringify(t6.data).slice(0, 200)}`);
  const t6Rows = await thirdPartyAuditRows(allocIdOf('PAY', 'DISB'));
  if (t6Rows.length === 0) pass('T6 护栏：Payable/Disbursement 不误判代付', '代付审计行 = 0（供应商口径不同）');
  else fail('T6 护栏：Payable 误判代付', `${t6Rows.length} 行`);

  // ── T7 两侧无档案、名称不同 → 名称兜底判定 ────────────────────────
  const t7 = await allocWithRetry('NN', 'NN', 200);
  if (t7.status === 201) pass('T7 两侧无客户档案核销放行', '201');
  else fail('T7 两侧无客户档案核销放行', `HTTP ${t7.status} ${JSON.stringify(t7.data).slice(0, 200)}`);
  const t7Rows = await thirdPartyAuditRows(allocIdOf('NN', 'NN'));
  if (t7Rows.length === 1 && t7Rows[0].detail?.after?.thirdPartyPaymentBasis === 'name') {
    pass('T7 留痕：名称兜底判定（旧数据）', 'basis=name');
  } else fail('T7 留痕：名称兜底判定', `找到 ${t7Rows.length} 行，basis=${t7Rows[0]?.detail?.after?.thirdPartyPaymentBasis}`);

  // ── T8 护栏：超额仍 400（钉住错误码映射；修前是 500 CREATE_FAILED）────
  const t8 = await allocWithRetry('A', 'PAYER', 99999);
  if (t8.status === 400 && String(t8.data?.error?.code || '').startsWith('AMOUNT_EXCEEDS')) {
    pass('T8 护栏：超额返回 400 + 明确错误码', `400 ${t8.data.error.code}（修前兜成 500 CREATE_FAILED）`);
  } else fail('T8 护栏：超额错误码', `HTTP ${t8.status} ${JSON.stringify(t8.data).slice(0, 200)}`);
}

console.log('');
try {
  await main();
} catch (e) {
  fail('演练异常', String(e?.stack || e));
} finally {
  console.log('\n── 回滚与复核 ──');
  if (prisma) { await rollback(); await verifyNoResidue(); }
  const failed = results.filter(r => r.ok === false).length;
  const okCount = results.filter(r => r.ok === true).length;
  console.log(`\n═══ 汇总：${okCount} 通过 / ${failed} 失败 ═══`);
  await prisma?.$disconnect?.();
  process.exit(failed === 0 ? 0 : 1);
}
