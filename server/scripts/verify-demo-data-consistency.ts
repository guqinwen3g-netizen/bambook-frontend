import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { Prisma, PrismaClient } from '@prisma/client';
import fs from 'node:fs/promises';
import { assertManualOrderLineSource } from '../src/orders/manualOrderLineSource';
const db = new PrismaClient(), D = Prisma.Decimal;
const problems: string[] = [], check = (yes: unknown, text: string) => { if (!yes) problems.push(text); };
async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== 'localhost' || url.pathname !== '/panda_hub_dev') throw Error('WRONG_TARGET');
  const orders = await db.order.findMany({ where: { deletedAt: null }, include: { lines: true } });
  let approvedSources = 0, gatedSources = 0;
  for (const o of orders) {
    const quantity = o.lines.reduce((a, l) => a.plus(l.quantity), new D(0));
    const amount = o.lines.reduce((a, l) => a.plus(l.netValue || 0), new D(0));
    check(o.quantity?.equals(quantity), `${o.code}: header quantity`);
    check(o.quoteAmount.equals(amount), `${o.code}: header amount`);
    if (!o.orderPurpose || ['external', 'external_customer'].includes(o.orderPurpose)) {
      check(o.poNumber, `${o.code}: missing PO reference`);
      check(o.customerRelationId && await db.relation.findFirst({ where: { id: o.customerRelationId, deletedAt: null } }), `${o.code}: customer missing`);
    } else {
      check(o.internalDemandTeamId && o.internalReceiverId && o.internalPurpose, `${o.code}: internal demand identity missing`);
      check(o.customerRelationId === null && o.poNumber === null, `${o.code}: internal order misrepresented as customer PO`);
    }
    check(o.ownerId && await db.userAccount.findUnique({ where: { id: o.ownerId } }), `${o.code}: owner missing`);
    for (const l of o.lines) {
      check(l.description && !/待复验|出运|业务|QC|审批/.test(l.description), `${l.id}: workflow in product description`);
      check(new RegExp(o.type === 'fabric' ? '^F-\\d{3}$' : '^G-\\d{3}$').test(l.materialCode || ''), `${l.id}: commercial SKU`);
      check(l.unit === (o.type === 'fabric' ? 'M' : 'PC'), `${l.id}: unit`);
      check(l.unitPrice && l.netValue?.equals(l.quantity.mul(l.unitPrice)), `${l.id}: line amount`);
      if (o.type === 'garment') check(l.sizeBreakdown && Object.values(l.sizeBreakdown as object).reduce((a: Prisma.Decimal, n: any) => a.plus(n), new D(0)).equals(l.quantity), `${l.id}: size total`);
      try { await assertManualOrderLineSource(db, l.id, o.id); approvedSources++; }
      catch (e) { if (o.status === 'Pending') gatedSources++; else problems.push(`${l.id}: approved source invalid: ${String(e)}`); }
    }
  }
  const stock = await db.inventoryItem.findMany({ where: { deletedAt: null } });
  for (const item of stock) {
    check(item.quantity.gte(0) && item.lockedQuantity.gte(0) && item.lockedQuantity.lte(item.quantity), `${item.id}: stock bounds`);
    check(!/待复验|出运|审批|QC/.test(item.description), `${item.id}: stock product semantics`);
    check(await db.warehouse.findUnique({ where: { id: item.warehouseId } }), `${item.id}: warehouse missing`);
  }
  const quotes = await db.quotation.findMany({ where: { deletedAt: null }, include: { lines: true } });
  for (const q of quotes) {
    check(q.totalAmount.equals(q.lines.reduce((a, l) => a.plus(l.amount), new D(0))), `${q.id}: quote sum`);
    for (const l of q.lines) check(l.amount.equals(l.quantity.mul(l.unitPrice)), `${l.id}: quote line amount`);
  }
  const boms = await db.bOM.findMany({ where: { deletedAt: null }, include: { lines: true, costEstimates: true } });
  for (const b of boms) {
    check(!b.orderId || orders.some(o=>o.id===b.orderId), `${b.id}: BOM for archived order`);
    check(!/自动生成|待复验|出运/.test(b.description), `${b.id}: BOM product semantics`);
    for (const l of b.lines) {
      check(l.effectiveQty.equals(l.quantity.mul(new D(1).plus(l.wastagePercent.div(100)))), `${l.id}: BOM wastage quantity`);
      check(l.amount.equals(l.effectiveQty.mul(l.unitCost)), `${l.id}: BOM line amount`);
    }
    check(b.totalCost.equals(b.totalMaterialCost.plus(b.totalLaborCost).plus(b.totalOverheadCost)), `${b.id}: BOM total`);
    check(b.totalMaterialCost.equals(b.lines.reduce((n,l)=>n.plus(l.amount),new D(0))), `${b.id}: BOM material total`);
  }
  const assignments = await db.qCAssignment.findMany({ where: { deletedAt: null } });
  for (const a of assignments) check(orders.some(o => o.id === a.orderId), `${a.id}: active QC task for archived order`);
  const cases = await db.developmentCase.findMany({ where: { deletedAt: null } });
  for (const c of cases) {
    if (c.specComposition === '100% Wool') check(c.name.includes('羊毛'), `${c.id}: composition/name mismatch`);
    if (c.styleSpec === 'Tailored blazer') check(c.name.includes('西装'), `${c.id}: style/name mismatch`);
  }
  const cards = await db.sampleCardItem.findMany({ where: { deletedAt: null } });
  for (const c of cards) {
    if (c.devCaseId) check(cases.some(d => d.id === c.devCaseId) && !c.name.startsWith('dev-oct08-'), `${c.id}: sample card product name`);
    check(c.availableQty >= 0 && c.availableQty <= c.quantity, `${c.id}: sample count bounds`);
    if (c.physicalLengthQty) check(c.availableLengthQty && c.availableLengthQty.gte(0) && c.availableLengthQty.lte(c.physicalLengthQty), `${c.id}: sample length bounds`);
  }
  const assets = await db.productAsset.findMany({ where: { deletedAt: null }, include: {fabricProfile:true,garmentProfile:true} });
  for (const a of assets) {
    check(!/出运|待复验|审批|QC/.test(a.name), `${a.id}: asset name semantics`);
    if (a.mainCategory === 'Fabric') check(a.fabricProfile?.articleNo === a.sku, `${a.id}: fabric article number mismatch`);
    if (a.mainCategory === 'Garment') check(a.garmentProfile?.styleNo === a.sku, `${a.id}: garment style number mismatch`);
  }
  for (const [entity, delegate, field, where] of [
    ['account', db.userAccount, 'displayName', { deletedAt: null }],
    ['relation', db.relation, 'name', { deletedAt: null }],
    ['department', db.department, 'name', { status: 'active' }],
    ['team', db.team, 'name', { deletedAt: null }],
  ] as const) {
    const rows = await (delegate as any).findMany({ where, select: { id: true, [field]: true } });
    for (const row of rows) check(!/模拟/.test(row[field]), `${entity}:${row.id}: simulation marker in display name`);
  }
  const invoices = await db.invoice.findMany({ where: { deletedAt: null } });
  const vouchers = await db.paymentVoucher.findMany({ where: { deletedAt: null } });
  const allocations = await db.invoiceAllocation.findMany();
  const credits = await db.creditNoteAllocation.findMany();
  for (const allocation of allocations) {
    const invoice = invoices.find(i => i.id === allocation.invoiceId), voucher = vouchers.find(v => v.id === allocation.voucherId);
    check(invoice && voucher, `${allocation.id}: allocation source missing`);
    check(allocation.appliedAmount.greaterThan(0), `${allocation.id}: nonpositive writeoff`);
    if (invoice && voucher) {
      check(invoice.currency === voucher.currency, `${allocation.id}: currency mismatch`);
      check((invoice.type === 'Receivable') === (voucher.type === 'Receipt'), `${allocation.id}: cash direction mismatch`);
      check(invoice.customerRelationId === voucher.customerRelationId, `${allocation.id}: counterparty mismatch`);
    }
  }
  const financeContent = invoices.map(invoice => {
    const paid = allocations.filter(a => a.invoiceId === invoice.id).reduce((sum, a) => sum.plus(a.appliedAmount), new D(0));
    const credited = credits.filter(a => a.invoiceId === invoice.id).reduce((sum, a) => sum.plus(a.appliedAmount), new D(0));
    const open = invoice.amount.minus(paid).minus(credited);
    check(invoice.amount.greaterThan(0) && !open.lessThan(0), `${invoice.id}: invoice amount / writeoff balance`);
    if (invoice.status === 'Paid') check(open.equals(0), `${invoice.id}: paid invoice has balance`);
    if (invoice.status === 'PartiallyPaid') check(open.greaterThan(0) && open.lessThan(invoice.amount), `${invoice.id}: partial invoice balance`);
    return { id: invoice.id, type: invoice.type, status: invoice.status, currency: invoice.currency, amount: invoice.amount.toString(), paid: paid.toString(), credited: credited.toString(), open: open.toString() };
  });
  for (const voucher of vouchers) {
    const applied = allocations.filter(a => a.voucherId === voucher.id).reduce((sum, a) => sum.plus(a.appliedAmount), new D(0));
    check(!applied.greaterThan(voucher.amount), `${voucher.id}: voucher overallocated`);
  }
  const shipmentContent = await db.shipment.findMany({ where: { deletedAt: null }, select: { id: true, shipmentNumber: true, status: true, atd: true } });
  for (const shipment of shipmentContent) {
    if (shipment.status === 'Shipped') check(shipment.atd && /^\d{4}-\d{2}-\d{2}$/.test(shipment.atd), `${shipment.id}: shipped without actual departure date`);
  }
  const cardContent = cards.map(c => ({id:c.id,name:c.name,devCaseId:c.devCaseId,orderId:c.orderId}));
  const counts: Record<string, number> = {};
  for (const model of Prisma.dmmf.datamodel.models) {
    const delegate = (db as any)[model.name[0].toLowerCase() + model.name.slice(1)];
    if (delegate?.count) counts[model.name] = await delegate.count({ where: model.fields.some(f => f.name === 'deletedAt') ? { deletedAt: null } : {} });
  }
  const report = { target: 'localhost/panda_hub_dev', generatedAt: new Date().toISOString(), orders: { fabric: orders.filter(o => o.type === 'fabric').length, garment: orders.filter(o => o.type === 'garment').length, lines: orders.reduce((n, o) => n + o.lines.length, 0) }, approvedSources, gatedSources, problems, shipmentContent, financeContent, cardContent, bomContent:boms.map(b=>({id:b.id,orderId:b.orderId,description:b.description,lines:b.lines.map(l=>({id:l.id,description:l.description}))})), counts };
  await fs.writeFile('../scratch/demo-data-consistency.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, counts: undefined }));
  if (problems.length) process.exitCode = 1;
}
main().finally(() => db.$disconnect());
