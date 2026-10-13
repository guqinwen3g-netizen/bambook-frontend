/**
 * audit-batch-settlement-dryrun.ts —— 批次结清判据「干跑」稽核（只读，事务内跑完即回滚）
 *
 * 为什么存在：`recalcSettlement`（shipping/orderShipmentBatchService.ts:408）的判据是
 *   `paid >= batch.amount` —— 而 `batch.amount` 是**计划额**（= 订单额 × plannedRatio%，
 *   见同文件 deriveAmount L152）。**短装**（实际出运 < 计划）时 paid 是「实际开票额」，
 *   永远追不上计划额 ⇒ 该批次**永远结不清**。
 *
 * 本脚本用**生产同一份服务**逐批真跑一次（在事务里），对比「库里的现状」与「代码算出的结果」，
 * 跑完**强制回滚**，绝不写库。
 *
 * 用法：cd server && npx tsx scripts/audit-batch-settlement-dryrun.ts
 */
import { PrismaClient } from '@prisma/client';
import { createOrderShipmentBatchService } from '../src/shipping/orderShipmentBatchService';

const prisma = new PrismaClient() as any;
const svc = createOrderShipmentBatchService(prisma);

async function main() {
  const batches = await prisma.orderShipmentBatch.findMany({
    where: { deletedAt: null, status: { not: 'cancelled' } },
    select: { id: true, batchNo: true, orderId: true, amount: true, invoicedAmount: true, paidAmount: true, settleStatus: true },
    orderBy: { orderId: 'asc' },
  });

  type Row = { id: string; batchNo: number; orderId: string; amount: number | null; paid: number; invoiced: number; stored: string; computed: string | null; flips: boolean };
  const rows: Row[] = [];
  let errors = 0;

  for (const b of batches) {
    let computed: string | null = null;
    try {
      await prisma.$transaction(async (tx: any) => {
        const r = await svc.recalcSettlement(b.id, tx);
        if (r?.ok) {
          const d = r.data as any;
          computed = d?.settleStatus ?? d?.batch?.settleStatus ?? null;
        } else {
          computed = `ERR:${r?.error?.code ?? 'UNKNOWN'}`;
        }
        throw new Error('__ROLLBACK__');
      });
    } catch (e: any) {
      if (String(e?.message) !== '__ROLLBACK__') { errors += 1; computed = `ERR:${String(e?.message).slice(0, 40)}`; }
    }
    const amount = b.amount != null ? Number(b.amount) : null;
    const paid = b.paidAmount != null ? Number(b.paidAmount) : 0;
    const invoiced = b.invoicedAmount != null ? Number(b.invoicedAmount) : 0;
    rows.push({ id: b.id, batchNo: b.batchNo, orderId: b.orderId, amount, paid, invoiced, stored: b.settleStatus, computed, flips: computed != null && computed !== b.settleStatus });
  }

  const flipped = rows.filter((r) => r.flips);
  console.log('════════ 批次结清判据 干跑稽核 ════════');
  console.log(`批次总数（未删未取消） ${rows.length}`);
  console.log(`重算异常             ${errors}`);
  console.log(`★ 现状 ≠ 代码算出     ${flipped.length}`);

  if (flipped.length) {
    console.log('\n── 不一致明细（现状 → 代码算出）──');
    for (const r of flipped) {
      console.log(
        `  ${r.orderId} #${r.batchNo}  计划=${r.amount}  已开票=${r.invoiced}  已收=${r.paid}  ` +
        `${r.stored} → ${r.computed}${r.amount != null && r.paid < r.amount ? '   ← 短装：实收 < 计划额' : ''}`,
      );
    }
  }

  // 分类计数（口径必须分清，别把「部分收款」误叫「短装」）
  //   短装（已收齐但票额 < 计划额）= invoiced>0 且 invoiced < 计划额 且 paid >= invoiced
  //     ⇒ 修前这类批次永远结不清；修后应能 settled
  //   部分收款 = paid < invoiced（客户还没付完，与短装无关）
  const eps = 1e-6;
  const shortShipped = rows.filter((r) => r.amount != null && r.amount > 0 && r.invoiced > 0
    && r.invoiced < r.amount - eps && r.paid >= r.invoiced - eps);
  const partialPaid = rows.filter((r) => r.invoiced > 0 && r.paid < r.invoiced - eps);
  console.log(`\n★ 短装（票额 < 计划额，且已收齐票额）  ${shortShipped.length}   ← 修前永不结清的那一类`);
  for (const r of shortShipped.slice(0, 12)) {
    console.log(`  ${r.orderId} #${r.batchNo}  计划=${r.amount} 已开票=${r.invoiced} 已收=${r.paid} 状态=${r.stored}`);
  }
  console.log(`\n△ 部分收款（票额内还没收齐，与短装无关）  ${partialPaid.length}`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('稽核失败:', e); await prisma.$disconnect(); process.exit(2); });
