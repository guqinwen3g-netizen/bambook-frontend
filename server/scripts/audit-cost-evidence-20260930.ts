/** Local PostgreSQL integration check. All fixture writes roll back. */
import dotenv from 'dotenv';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createProfitSheetService } from '../src/pricing/profitSheetService';
import { createCostRingsService } from '../src/pricing/costRingsService';

dotenv.config({ path: '.env.local' });
dotenv.config();
const url = new URL(process.env.DATABASE_URL || '');
assert(['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/panda_hub_local');
const db = new PrismaClient();
const tag = `AUDIT-COST-0930-${Date.now()}`;
const rollback = new Error('AUDIT_TRANSACTION_ROLLBACK');

async function main() {
  const identity: any[] = await db.$queryRaw`SELECT current_database() AS name, inet_server_addr()::text AS address`;
  assert.equal(identity[0].name, 'panda_hub_local');
  assert(['127.0.0.1', '::1'].includes(String(identity[0].address).split('/')[0]));
  try {
    await db.$transaction(async tx => {
      const now = BigInt(Date.now());
      await tx.userAccount.create({ data: { id: tag, displayName: '成本隔离验收', status: 'inactive' } });
      await tx.order.create({ data: { id: tag, customer: '成本隔离验收', product: '材料投入案例', type: 'Fabric', quantity: 1000, status: 'Production', dueDate: '2026-12-01', quoteAmount: 15000, currency: 'CNY' } });
      const po = await tx.purchaseOrder.create({ data: {
        id: `${tag}-confirmed`, poNumber: `${tag}-confirmed`, orderId: tag, status: 'PartiallyReceived', currency: 'CNY', totalAmount: 10000, orderDate: '2026-09-30', createdAt: now, updatedAt: now,
        lines: { create: { id: `${tag}-line`, lineNumber: 1, materialCode: tag, description: '面料', quantity: 1000, unit: 'M', unitPrice: 10, amount: 10000, receivedQuantity: 600, createdAt: now } },
      } });
      await tx.purchaseOrder.create({ data: { id: `${tag}-draft`, poNumber: `${tag}-draft`, orderId: tag, status: 'Draft', currency: 'CNY', totalAmount: 10000, orderDate: '2026-09-30', createdAt: now, updatedAt: now } });
      const receipt = await tx.materialReceipt.create({ data: { id: `${tag}-receipt`, receiptNumber: `${tag}-receipt`, purchaseOrderId: po.id, status: 'Accepted', receivedDate: '2026-09-30', totalReceived: 600, totalAccepted: 600, totalRejected: 0, createdAt: now } });
      await tx.auditLog.create({ data: { id: `${tag}-audit`, actorId: tag, action: 'create_material_receipt', targetType: 'PurchaseOrder', targetId: po.id, detail: { after: { receiptId: receipt.id, lineReceipts: [{ lineId: `${tag}-line`, materialCode: tag, description: '面料', unit: 'M', accepted: 600, rejected: 0 }] } } } });
      await tx.paymentVoucher.create({ data: { id: `${tag}-advance`, voucherNumber: `${tag}-advance`, orderId: tag, type: 'Disbursement', voucherCategory: 'advance', amount: 3000, currency: 'CNY', paymentDate: '2026-09-30', paymentMethod: 'TT', createdAt: now, updatedAt: now } });
      const service = createProfitSheetService(tx as any);
      const sheet: any = await service.generateOrderProfitSheet(tag, tag);
      const evidence = sheet.details.costEvidence;
      assert.equal(evidence.committedAmountCny, 10000);
      assert.equal(evidence.acceptedAmountCny, 6000);
      assert.equal(evidence.paidPrincipalCny, 3000);
      assert.equal(evidence.actualCostCny, null);
      assert.equal(evidence.actualProfitCny, null);
      assert.equal(sheet.grossProfit, null);
      assert.equal(Number(sheet.miscCost), 0);
      const regenerated: any = await service.generateOrderProfitSheet(tag, tag);
      assert.equal(regenerated.id, sheet.id);
      assert.equal(regenerated.version, sheet.version + 1);
      assert.equal(regenerated.details.costEvidence.committedAmountCny, 10000);
      const readback: any = await service.getProfitSheetByOrder(tag);
      assert.equal(readback.grossProfit, null);
      const rings: any = await createCostRingsService(tx as any).getOrderCostRings(tag);
      assert.equal(rings.actualRing.actualCostCny, null);
      assert.equal(rings.actualRing.actualProfitCny, null);
      console.log(JSON.stringify({ result: 'PASS', tag, database: identity[0].name, evidence, verified: ['draft excluded from commitment', '600 accepted at 10 = 6000', '3000 payment not extra cost', 'actual profit unresolved', 'repeated generation stable', 'readback and cost ring guarded'], fixturePolicy: 'transaction rolled back' }));
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) { if (error !== rollback) throw error; }
  assert.equal(await db.order.count({ where: { id: tag } }), 0);
  console.log('ROLLBACK_VERIFIED');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
