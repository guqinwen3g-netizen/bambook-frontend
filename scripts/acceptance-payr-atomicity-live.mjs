// 付款申请（PAYR）取号原子性 —— **真库**验收（含真并发）
//
// 为什么在单测之外还要这一条：
//   `paymentRequestNumberAtomicity.test.ts` 用一个「能模拟事务回滚与提交期唯一约束」的
//   假库把竞态**真实复现**了（比 mock 强得多），但假库终究是**我们写的**：
//   它不能证明「Prisma 交互式事务 + 嵌套创建审批单 + 真实唯一约束 + 真实并发」也对。
//   本脚本补上这一段 —— 被测行为全部走**真实 API + 真实 DB**。
//
// 要证的不变量（对应 2026-09-19 的修复）：
//   ① 取号/建审批单/落库**同一事务** ⇒ 不存在「审批台有单、业务单不存在」的孤儿审批单
//   ② 审批 payload 里的号 === 落库的号（旧写法撞号重试时二者会脱节）
//   ③ 真并发下**全部成功且号互不相同**（旧写法 `count+1` 先读后写 ⇒ 同号 ⇒ P2002 失败）
//   ④ 号格式不变：`PAYR-YYYYMMDD-NNN`
//
// 用法：node scripts/acceptance-payr-atomicity-live.mjs
import { createRequire } from 'node:module';
import { SERVER_DIR, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
// ★ 全模型残留清扫器（详见 lib 头部注释）：手写回滚清单必然漏 ⇒ 按标识全模型兜底
import { settleAndClean, sweepResidue } from './lib/drill-residue.mjs';

const BASE = 'http://127.0.0.1:8081';
const PASSWORD = 'Bambook@2026';
const DEBUG = process.env.PAYR_DEBUG === '1';
const MARK = `DRILLPAYR${Date.now().toString(36).toUpperCase()}`;
const CONCURRENCY = 5;

const results = [];
const pass = (n, d = '') => { results.push({ ok: true, n }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n, d = '') => { results.push({ ok: false, n }); console.log(`  ✗ ${n} — ${d}`); };
const gap = (n, d = '') => { results.push({ ok: null, n }); console.log(`  ⚠️  [gap] ${n}${d ? ' — ' + d : ''}`); };
const step = (s) => console.log(`\n── ${s} ──`);

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const d = await r.json().catch(() => null);
  return r.ok && d?.token ? d.token : null;
}
async function api(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text().catch(() => '');
  let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = null; }
  if (DEBUG && r.status >= 400) console.log(`    [diag] ${method} ${path} → ${r.status} ${t.slice(0, 240)}`);
  return { status: r.status, data: d, text: t };
}

let prisma = null;
let PrismaRef = null;
const created = { prIds: [], arIds: [], auditIds: [] };
// ★ 发号器行（SequenceRegister）：本次演练会创建 `SEQREG_paymentRequest_<今日>`。
//   只在**演练之前不存在**时才回滚删除 —— 若它本来就存在（真实使用过），
//   删掉会把序号重置，反而可能与存量单号撞车（宁可留一行也不制造重号）。
const SEQ_ID = `SEQREG_paymentRequest_${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
let seqRowExistedBefore = true;

async function rollback() {
  console.log('\n── 回滚 ──');
  const prIds = created.prIds.length ? created.prIds : ['__none__'];
  const arIds = created.arIds.length ? created.arIds : ['__none__'];
  const del = async (name, fn) => {
    try { const r = await fn(); if (r?.count) console.log(`     · 删除 ${name}：${r.count} 行`); }
    catch (e) { console.log(`     ! 删除 ${name} 失败：${String(e?.message ?? e).slice(0, 140)}`); }
  };
  await del('PaymentRequest', () => prisma.paymentRequest.deleteMany({ where: { id: { in: prIds } } }));
  await del('ApprovalRequest', () => prisma.approvalRequest.deleteMany({ where: { OR: [{ id: { in: arIds } }, { targetId: { in: prIds } }] } }));
  await del('Notification', () => prisma.notification.deleteMany({ where: { body: { contains: MARK } } }));
  await del('AuditLog', () => prisma.auditLog.deleteMany({
    where: { OR: [{ targetId: { in: prIds } }, { targetId: { in: arIds } }, { id: { in: created.auditIds.length ? created.auditIds : ['__none__'] } }] },
  }));
  if (!seqRowExistedBefore) {
    await del('SequenceRegister（演练新建的发号行）', () => prisma.sequenceRegister.deleteMany({ where: { id: SEQ_ID } }));
  } else {
    console.log(`     ⓘ 发号行 ${SEQ_ID} 演练前已存在 → 保留（删除会重置序号，可能与存量单号撞车）`);
  }
}

/**
 * 发号行的**条件**复核 —— 这一条全模型扫描**表达不了**，必须单独留着：
 * `SequenceRegister` 行只在「**演练前不存在**」时才算残留；
 * 若它本来就存在（真实使用过），保留是正确的（删了会重置序号、可能与存量单号撞车）。
 */
async function verifySequenceRow() {
  if (seqRowExistedBefore) {
    console.log('  ⓘ SequenceRegister：演练前已存在 ⇒ 保留属正确（不计残留）');
    return 0;
  }
  const c = await prisma.sequenceRegister.count({ where: { id: SEQ_ID } });
  if (c === 0) console.log('  ✓ SequenceRegister（演练新建的发号行）= 0');
  else console.log(`  ✗ SequenceRegister = ${c}（演练新建却未清）`);
  return c;
}

async function main() {
  const req = createRequire(SERVER_DIR + '/');
// ★ G-3c 第 11 批复核处置（BLOCK-2）：构造 client 之前先把**本仓**那份 env 装上；取不到就抛 ENV_MISSING，
//   宁可拒跑也不让 Prisma 去借别的 worktree 的 env（此前 19/21 是这么被借走的）。
loadEnvForScript();
  const { PrismaClient, Prisma } = req('@prisma/client');
  prisma = new PrismaClient();
  PrismaRef = Prisma;
  // ★ 先记下发号行是否**演练前就存在** —— 决定回滚时能否删它（见 rollback 注释）
  seqRowExistedBefore = (await prisma.sequenceRegister.count({ where: { id: SEQ_ID } })) > 0;
  const token = await login('jason.shen@bambook.local');
  if (!token) { console.error('登录失败'); process.exit(1); }
  const la = await prisma.auditLog.findFirst({ where: { action: 'login' }, orderBy: { createdAt: 'desc' } });
  if (la) created.auditIds.push(la.id);
  console.log(`   发号行 ${SEQ_ID}：演练前${seqRowExistedBefore ? '已存在（回滚保留）' : '不存在（回滚删除）'}`);
  console.log(`══ PAYR 取号原子性 · 真库验收 ══`);
  console.log(`   标识 MARK=${MARK}`);

  try {
    step('V1 单笔创建 → 号格式 + 审批 payload 一致 + targetId 有效');
    const r1 = await api(token, 'POST', '/api/v1/payment-requests', {
      supplierName: `DRILL 演练供应商 ${MARK}`, totalAmount: '1234.5600', currency: 'CNY',
      remark: `${MARK} 取号原子性验收`,
    });
    if (r1.status === 201 && r1.data?.paymentRequest?.requestNumber) {
      const pr = r1.data.paymentRequest;
      created.prIds.push(pr.id);
      if (r1.data.approvalRequestId) created.arIds.push(r1.data.approvalRequestId);
      if (/^PAYR-\d{8}-\d{3}$/.test(pr.requestNumber)) pass('号格式不变：PAYR-YYYYMMDD-NNN', pr.requestNumber);
      else fail('号格式', pr.requestNumber);

      const ar = await prisma.approvalRequest.findUnique({ where: { id: r1.data.approvalRequestId } });
      if (ar?.payload?.requestNumber === pr.requestNumber) {
        pass('★ 审批 payload 的号 === 落库的号', `${ar.payload.requestNumber}`);
      } else {
        fail('★ 审批 payload 的号与落库号脱节', `payload=${ar?.payload?.requestNumber} 落库=${pr.requestNumber}`);
      }
      const linked = ar?.targetId ? await prisma.paymentRequest.findUnique({ where: { id: ar.targetId } }) : null;
      if (linked) pass('★ 非孤儿：审批 targetId 指向真实主单', ar.targetId);
      else fail('★ 孤儿审批单', `targetId=${ar?.targetId} 无对应主单`);
    } else if (r1.status === 409 && r1.text.includes('NO_REVIEWER')) {
      gap('本账号未解析到审批人（409 NO_REVIEWER_RESOLVED）', 'fail-closed 语义正确，但成功路径无法用该账号验收 —— 换有部门主管的账号');
    } else {
      fail('单笔创建', `HTTP ${r1.status} ${r1.text.slice(0, 200)}`);
    }

    step(`V2 真并发 ${CONCURRENCY} 笔 → 全部成功且号互不相同（旧写法必然出现同号 P2002）`);
    const conc = await Promise.all(Array.from({ length: CONCURRENCY }, () => api(token, 'POST', '/api/v1/payment-requests', {
      supplierName: `DRILL 演练供应商 ${MARK}`, totalAmount: '100.0000', currency: 'CNY',
      remark: `${MARK} 并发验收`,
    })));
    const okOnes = conc.filter((r) => r.status === 201);
    for (const r of okOnes) {
      created.prIds.push(r.data.paymentRequest.id);
      if (r.data.approvalRequestId) created.arIds.push(r.data.approvalRequestId);
    }
    const nos = okOnes.map((r) => r.data.paymentRequest.requestNumber);
    if (okOnes.length === CONCURRENCY && new Set(nos).size === CONCURRENCY) {
      pass(`★ 并发 ${CONCURRENCY} 笔全部成功且号互不相同`, nos.join(' / '));
    } else if (okOnes.length === 0 && conc.some((r) => r.status === 409)) {
      gap(`并发 ${CONCURRENCY} 笔均因 NO_REVIEWER_RESOLVED 未创建`, '同上，换账号才能验并发成功路径');
    } else {
      const diag = conc.filter((r) => r.status !== 201)
        .map((r) => `${r.status} ${(r.data?.error ?? '')} ${String(r.data?.message ?? r.text).slice(0, 130)}`);
      fail(`并发 ${CONCURRENCY} 笔`, `成功 ${okOnes.length} 笔 · 号=${nos.join('/')}\n       失败明细：\n         ${diag.join('\n         ')}`);
    }

    // 孤儿复核：本次创建的全部审批单 targetId 必须都能对上一个真实主单
    if (created.arIds.length > 0) {
      const ars = await prisma.approvalRequest.findMany({ where: { id: { in: created.arIds } }, select: { id: true, targetId: true } });
      const targets = ars.map((a) => a.targetId).filter(Boolean);
      const found = targets.length ? await prisma.paymentRequest.count({ where: { id: { in: targets } } }) : 0;
      if (found === targets.length) pass('★ 孤儿复核：本次全部审批单都有对应主单', `${found}/${targets.length}`);
      else fail('★ 孤儿复核', `审批单 ${targets.length} 张，仅 ${found} 张有对应主单`);
    }
  } catch (e) {
    fail('脚本异常', String(e?.stack ?? e).slice(0, 400));
  } finally {
    await rollback();
    // ★ 全模型**沉淀式**兜底清扫：付款申请会触发域事件（PaymentVoucherCreated /
    //   AllocationReconciled …）⇒ 扇出 notification + agentJob，且**由服务端异步投递**。
    //   ⚠️ 诚实边界：投递窗口不可控 ⇒ **脚本退出不保证零残留**；
    //      权威兜底是 `clean-drill-residue.mjs --apply` + `db-rowcount.mjs --compare`。
    const cleaned = await settleAndClean({ prisma, Prisma: PrismaRef, markers: [MARK], log: console.log });
    if (cleaned.deleted > 0) console.log(`     · 全模型兜底清扫补删 ${cleaned.deleted} 行：${JSON.stringify(cleaned.byModel)}`);
    const hits = await sweepResidue({ prisma, Prisma: PrismaRef, markers: [MARK] });
    /**
     * ★ 2026-09-29 修正（**脚本沿用了修前的写法 ⇒ 误报脏**）：
     *   `sweepResidue` 返回的 `hits` **含着 count=0 的行**（族扫描下界>0 的也照样进，
     *   见 `lib/drill-residue.mjs:543`）。判"有没有残留"必须看**计数**，不是数组长度 ——
     *   lib 的 `residueVerdict` 早在 **v3.48** 就改对了（`acceptance-selfcheck.mjs:323-327`），
     *   而本脚本是内联写法、沿用了改之前的 `hits.length === 0` ⇒ 真跑会报
     *   「有残留 — UserAccount=0 · EntityReference=0 …」把"没数到"读成"数到了脏东西"。
     */
    const realHits = hits.filter((h) => Number(h && h.count) > 0);
    if (realHits.length === 0) pass('零残留复核（**全模型**扫描）', '演练标识命中 0（若行数对撞仍报增长，跑 clean-drill-residue.mjs --apply）');
    else fail('零残留复核（**全模型**扫描）', realHits.map((h) => `${h.model}=${h.count}`).join(' · '));
    // 发号行的条件复核（全模型扫描表达不了）
    const seqBad = await verifySequenceRow();
    if (seqBad === 0) pass('发号行复核', seqRowExistedBefore ? '演练前已存在 ⇒ 保留正确' : '演练新建已清除');
    else fail('发号行复核', `${SEQ_ID} 残留 ${seqBad} 行`);
    await prisma.$disconnect().catch(() => {});
    const ok = results.filter((r) => r.ok === true).length;
    const bad = results.filter((r) => r.ok === false).length;
    const gaps = results.filter((r) => r.ok === null).length;
    console.log(`\n══ 结果：${ok} 通过 / ${bad} 失败 / ${gaps} 缺口 ══`);
    if (gaps) console.log('   缺口明细：' + results.filter((r) => r.ok === null).map((r) => r.n).join(' · '));
    process.exit(bad === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error('脚本异常', e); process.exit(2); });
