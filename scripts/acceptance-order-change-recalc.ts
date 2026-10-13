// ★★ 端到端验证：改单（改数量 / 改价）后，**明细行 + 派生金额**是否真的联动重算
//
// Kevin 2026-09-18 拍板：① 以明细行为准 ② 跟着改，金额重算。
//
// 判据（**来源必须不同** ✗ —— 不能拿同一来源自证 ✓）：
//   · 改单动作走 `recalcOrderAmountFromLines`
//   · 校验读**明细行表**（OrderLine，与写入不同来源 ✓）再对撞主档
//
// ★ 阳性对照（必须有，否则「机制没跑」与「机制跑对了」都是绿，无法区分）：
//   重算后的数量/金额**必须 ≠ 原值**，证明重算真的发生了。
//
// ★ 零污染：全部在 **一个事务** 内跑完并 `throw` 回滚，演示库不留任何痕迹。
import { createRequire } from 'node:module';
import { SERVER_DIR, REPO_ROOT, loadEnvForScript } from './lib/acceptance-selfcheck.mjs';
const req = createRequire(SERVER_DIR + '/');
loadEnvForScript();
const { PrismaClient } = req('@prisma/client');
const prisma = new PrismaClient();

import * as recalcMod from '../server/src/orderChanges/orderAmountRecalc';
const recalcOrderAmountFromLines: (tx: any, orderId: string, mode: 'quantity' | 'price', value: number) => Promise<any> =
  (recalcMod as any).recalcOrderAmountFromLines ?? (recalcMod as any).default?.recalcOrderAmountFromLines;

const results: { ok: boolean; n: string; d?: string }[] = [];
const pass = (n: string, d = '') => { results.push({ ok: true, n, d }); console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const fail = (n: string, d = '') => { results.push({ ok: false, n, d }); console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const R = (x: any) => Math.round(Number(x ?? 0) * 100) / 100;

async function main() {
  console.log('════════════════════════════════════════════════════════');
  console.log(' 改单金额联动 —— 端到端验收（真库事务 · 自回滚）');
  console.log('════════════════════════════════════════════════════════');

  // 找一单有明细行的订单
  const target = await prisma.order.findFirst({
    where: { deletedAt: null, lines: { some: {} } },
    select: { id: true, code: true, quantity: true, totalNet: true, quoteAmount: true, contractAmount: true },
  });
  if (!target) { console.log('✗ 找不到带明细行的订单，无法验收'); process.exit(1); }
  console.log(`\n靶子 ${target.code ?? target.id}`);
  console.log(`  原值 quantity=${R(target.quantity)} totalNet=${R(target.totalNet)} quoteAmount=${R(target.quoteAmount)} contractAmount=${R(target.contractAmount)}`);

  const origQty = R(target.quantity);
  const origNet = R(target.totalNet);
  const newQty = origQty > 100 ? Math.round(origQty * 0.8) : origQty + 10;   // 砍到 80%
  const newAmount = Math.round(origNet * 0.75 * 100) / 100;                   // 改价到 75%

  await prisma.$transaction(async (tx: any) => {
    // ── ① 改数量 ────────────────────────────────────────────
    const r1 = await recalcOrderAmountFromLines(tx, target.id, 'quantity', newQty);
    if (!r1) { fail('改数量：重算返回 null', '应返回重算结果'); return; }
    pass('改数量：重算执行', `lines=${r1.linesUpdated} quantity=${R(r1.quantity)} totalNet=${R(r1.totalNet)}`);

    // 独立读回（来源不同 ✓）
    const lines1 = await tx.orderLine.findMany({ where: { orderId: target.id } });
    const o1 = await tx.order.findUnique({ where: { id: target.id } });
    const sumQty1 = R(lines1.reduce((s: number, l: any) => s + Number(l.quantity ?? 0), 0));
    const sumNet1 = R(lines1.reduce((s: number, l: any) => s + Number(l.netValue ?? 0), 0));

    if (sumQty1 === R(newQty)) pass('改数量：Σ明细行数量 = 目标数量', `${sumQty1}`);
    else fail('改数量：Σ明细行数量 = 目标数量', `${sumQty1} ≠ ${R(newQty)}`);

    if (R(o1.quantity) === R(newQty)) pass('改数量：主档 quantity 同步', `${R(o1.quantity)}`);
    else fail('改数量：主档 quantity 同步', `${R(o1.quantity)} ≠ ${R(newQty)}`);

    if (sumNet1 === R(o1.totalNet)) pass('改数量：Σ明细行金额 = totalNet', `${sumNet1}`);
    else fail('改数量：Σ明细行金额 = totalNet', `${sumNet1} ≠ ${R(o1.totalNet)}`);

    if (R(o1.totalNet) === R(o1.quoteAmount) && R(o1.totalNet) === R(o1.contractAmount)) {
      pass('改数量：主档三个金额字段一致（口径分裂已消除）', `totalNet=quoteAmount=contractAmount=${R(o1.totalNet)}`);
    } else {
      fail('改数量：主档三个金额字段一致', `totalNet=${R(o1.totalNet)} quote=${R(o1.quoteAmount)} contract=${R(o1.contractAmount)}`);
    }

    // ★ 阳性对照：必须真的变了
    if (sumQty1 !== origQty && sumNet1 !== origNet) pass('阳性对照：数量与金额确实变了', `原 ${origQty}/${origNet} → ${sumQty1}/${sumNet1}`);
    else fail('阳性对照：数量与金额确实变了', `没变 ⇒ 重算可能是空操作`);

    // ── ② 改价 ─────────────────────────────────────────────
    const r2 = await recalcOrderAmountFromLines(tx, target.id, 'price', newAmount);
    if (!r2) { fail('改价：重算返回 null', '应返回重算结果'); return; }
    const lines2 = await tx.orderLine.findMany({ where: { orderId: target.id } });
    const o2 = await tx.order.findUnique({ where: { id: target.id } });
    const sumNet2 = R(lines2.reduce((s: number, l: any) => s + Number(l.netValue ?? 0), 0));

    if (sumNet2 === R(newAmount)) pass('改价：Σ明细行金额 = 目标总额（尾差已兜底）', `${sumNet2}`);
    else fail('改价：Σ明细行金额 = 目标总额（尾差已兜底）', `${sumNet2} ≠ ${R(newAmount)}`);

    if (R(o2.totalNet) === sumNet2 && R(o2.quoteAmount) === sumNet2 && R(o2.contractAmount) === sumNet2) {
      pass('改价：totalNet/quoteAmount/contractAmount 全部 = Σ明细行', `${sumNet2}`);
    } else {
      fail('改价：主档金额全部 = Σ明细行', `totalNet=${R(o2.totalNet)} quote=${R(o2.quoteAmount)} contract=${R(o2.contractAmount)} Σ=${sumNet2}`);
    }

    // 硬恒等：Σ(qty × unitPrice) ≈ ΣnetValue
    // ⚠️ 用「≈」而不是「=」：`OrderLine.unitPrice` 是 Decimal(18,4)，单价存盘被截到 4 位，
    //    反算后 `q × 存盘单价` 与目标分位必有残差（实测 0.03/行）。总额精确优先，此处容忍残差。
    const sumCalc = R(lines2.reduce((s: number, l: any) => s + Number(l.quantity ?? 0) * Number(l.unitPrice ?? 0), 0));
    /**
     * ★ 2026-09-29 修正：容差**必须随数量放大**。
     *   `OrderLine.unitPrice` 是 Decimal(18,4) ⇒ 反算残差上界 ≈ `Σ(q × 0.00005)`（半格末位）。
     *   原式 `0.05 × 行数` **与数量无关** ⇒ 单行大批量时假红（实测挑到 q≈20000 的单，
     *   残差 0.38 > 0.05）。这里按"每行数量 × 半格末位"求和，再加 0.05 的常数底。
     */
    const tol = 0.05 + lines2.reduce((s: number, l: any) => s + Number(l.quantity ?? 0) * 0.00005, 0);
    if (Math.abs(sumCalc - sumNet2) <= tol) pass('改价：硬恒等 Σ(qty×单价) ≈ ΣnetValue（容差内）', `${sumCalc} ≈ ${sumNet2}（容差 ${R(tol)}）`);
    else fail('改价：硬恒等 Σ(qty×单价) ≈ ΣnetValue', `${sumCalc} vs ${sumNet2}（容差 ${R(tol)}）`);

    // ★ 回滚：抛异常让整个事务撤销
    throw new Error('ROLLBACK_FOR_CLEAN_VERIFICATION');
  }).catch((e: any) => {
    if (!String(e?.message ?? '').includes('ROLLBACK_FOR_CLEAN_VERIFICATION')) {
      fail('事务异常（非预期回滚）', String(e?.message ?? e));
    }
  });

  // ── ③ 回滚复核（独立来源）───────────────────────────────
  const after = await prisma.order.findUnique({ where: { id: target.id } });
  const linesAfter = await prisma.orderLine.findMany({ where: { orderId: target.id } });
  const sumQtyA = R(linesAfter.reduce((s: number, l: any) => s + Number(l.quantity ?? 0), 0));
  const sumNetA = R(linesAfter.reduce((s: number, l: any) => s + Number(l.netValue ?? 0), 0));
  if (R(after?.quantity) === origQty && sumQtyA === origQty && sumNetA === origNet) {
    pass('回滚复核：演示库零污染', `quantity=${origQty} Σ行=${sumQtyA} Σ额=${sumNetA}`);
  } else {
    fail('回滚复核：演示库零污染', `quantity=${R(after?.quantity)}(应${origQty}) Σ行=${sumQtyA}(应${origQty}) Σ额=${sumNetA}(应${origNet})`);
  }

  await prisma.$disconnect();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n结果：${ok}/${results.length} 通过`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length) console.log('失败项：\n  - ' + bad.map((r) => `${r.n}${r.d ? ' :: ' + r.d : ''}`).join('\n  - '));
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
