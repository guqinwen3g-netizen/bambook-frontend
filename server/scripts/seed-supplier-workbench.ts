import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createFactoryService, accumulateCompletedPurchaseOrderStats } from '../src/suppliers/factoryService';
import { createDelayImpactService } from '../src/suppliers/delayImpactService';
import { createTcCertificateService } from '../src/suppliers/tcCertificateService';

// Repeatable local demo enrichment. Historical receipts are imported together,
// not posted as new stock movements or new financial obligations.
dotenv.config({ path: '.env.local' });
const url = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/panda_hub_dev') throw new Error('Only local panda_hub_dev is allowed');
const db = new PrismaClient();
const prefix = 'supplier-workbench-20261009';
async function main() {
  const profiles = await db.factoryProfile.findMany({ where: { id: { startsWith: 'dev-oct08__' }, deletedAt: null }, include: { relation: true }, orderBy: { id: 'asc' } });
  if (!profiles.length) throw new Error('Expected demo factory profiles missing');
  const actor = await db.userAccount.findFirst({ where: { id: { startsWith: 'dev-oct08__' } }, select: { id: true } });
  if (!actor) throw new Error('Demo account missing');
  if (process.argv.includes('--apply')) {
    mkdirSync('../backups', { recursive: true });
    const backup = `../backups/supplier-workbench-${Date.now()}.dump`;
    const dump = spawnSync('pg_dump', ['-Fc', '-f', backup], { env: { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: 'panda_hub_dev' }, encoding: 'utf8' });
    if (dump.status !== 0) throw new Error('Database backup failed; no seed writes performed');
    console.log(`Backup: ${backup}`);
    const service = createFactoryService(db);
    for (const [i, p] of profiles.entries()) {
      const fabric = p.specialties.includes('fabric'), unit = fabric ? 'M' : 'PC';
      const monthlyCapacity = fabric ? 45000 + i * 2200 : 12000 + i * 500;
      await service.updateProfile(p.id, {
        monthlyCapacity, capacityUnit: unit, workerCount: fabric ? 65 + i * 3 : 120 + i * 4,
        equipmentList: fabric ? '剑杆织机、验布机、定型设备' : '电脑平缝机、包缝机、自动裁床、整烫设备',
        priceLevel: i % 3 === 0 ? 'High' : 'Mid', firstOrderAt: '2026-04-10',
        notes: '按批次确认交期；包装与验收要求按采购约定执行。',
        bankName: fabric ? '中国银行苏州分行' : '中国工商银行南通分行', bankAccount: `TEST-ACCOUNT-${String(i+1).padStart(4,'0')}`, bankSwift: fabric ? 'BKCHCNBJ' : 'ICBKCNBJ',
      }, actor.id);
      for (let n = 0; n < 3; n++) {
        const id = `${prefix}-po-${i}-${n}`, quantity = (fabric ? 1800 : 400) + i * 30 + n * 120;
        const price = fabric ? 18 + i % 9 : 86 + i % 15, amount = quantity * price;
        const receivedDate = `2026-0${6 + n}-18`;
        await db.$transaction(async tx => {
          if (await tx.purchaseOrder.findUnique({ where: { id } })) return;
          const stamp = BigInt(new Date(`${receivedDate}T08:00:00+08:00`).getTime());
          await tx.purchaseOrder.create({ data: { id, poNumber: `PO-2026${6 + n}-${String(i + 1).padStart(3,'0')}-H`, status: 'Received', supplierRelationId: p.relationId, supplierName: p.relation.name, currency: 'CNY', totalAmount: amount, orderDate: `2026-0${6+n}-01`, expectedDeliveryDate: receivedDate, actualDeliveryDate: receivedDate, buyer: '业务组', notes: '历史合作及验收记录导入；非新增采购、库存或应付业务。', createdAt: stamp, updatedAt: stamp,
            lines: { create: { id: `${id}-line`, lineNumber: 1, description: fabric ? ['藏青棉斜纹','米白亚麻平纹','炭灰精纺羊毛'][n] : ['藏青衬衫','米白西装','炭灰大衣'][n], category: fabric ? 'Fabric' : 'Other', quantity, receivedQuantity: quantity, unit, unitPrice: price, amount, createdAt: stamp } },
            receipts: { create: { id: `${id}-receipt`, receiptNumber: `RC-2026${6+n}-${String(i+1).padStart(3,'0')}-H`, status: 'Accepted', receivedDate, inspectionDate: receivedDate, totalReceived: quantity, totalAccepted: quantity, totalRejected: 0, qualityNotes: '按合同规格验收合格', notes: '历史验收凭据导入', createdAt: stamp } },
          } });
          await accumulateCompletedPurchaseOrderStats(tx, { relationId: p.relationId, amount, updatedAt: stamp });
        });
        for (const kind of ['inspection','delivery']) {
          const sourceId = id;
          if (!await db.factoryEvaluation.findFirst({ where: { factoryId: p.id, sourceId, kind, deletedAt: null } })) {
            await service.addEvaluation(p.id, { kind, score: kind === 'delivery' ? 100 : 86 + ((i + n) % 13), sourceType: 'purchaseOrder', sourceId: id, evaluatedAt: receivedDate, note: kind === 'delivery' ? '实际到货日与约定交期一致' : '规格、外观及包装验收合格' }, actor.id);
            // Source points at the actual PO; idempotency is by PO and evaluation kind.
          }
        }
      }
      for (const month of ['2026-10','2026-11','2026-12']) await service.upsertCapacity(p.id, { month, capacity: monthlyCapacity, unit }, actor.id);
      for (const [n, type] of (fabric ? ['ISO9001','OEKO-TEX'] : ['BSCI','SEDEX']).entries()) {
        const certificateNo = `CN-${type}-26-${String(i+1).padStart(3,'0')}`;
        const cert = await db.factoryCertification.findFirst({ where: { factoryId: p.id, certificateNo, deletedAt: null } });
        const validUntil = n === 1 && i % 11 === 0 ? '2026-09-25' : n === 1 && i % 7 === 0 ? '2026-10-25' : '2027-01-14';
        if (!cert) await service.addCertification(p.id, { type, certificateNo, issuedAt: '2026-01-15', validUntil }, actor.id);
        else if (cert.validUntil !== validUntil) await service.updateCertification(cert.id, { validUntil }, actor.id);
      }
    }
    const heldRelation = `${prefix}-held-supplier`;
    if (!await db.relation.findUnique({ where: { id: heldRelation } })) await db.relation.create({ data: { id: heldRelation, name: '海宁远志织造有限公司', category: 'Supplier', type: 'Company', isOrganization: true, tags: ['demo-fixture','fabric'], contactInfo: '质量联系人：周文', lastInteraction: BigInt(Date.now()) } });
    let held = await service.getProfileByRelation(heldRelation);
    if (!held) held = await service.createProfile({ relationId: heldRelation, specialties: ['涤纶斜纹','再生面料'], monthlyCapacity: 30000, capacityUnit: 'M', workerCount: 60, priceLevel: 'Mid', notes: '暂停新合作，等待质量整改复核。' }, actor.id);
    if (!held.blacklistedAt) await service.setBlacklist(held.id, '连续两批色牢度未达约定标准，整改复核前暂停新合作', actor.id);
    for (const [n, kind] of ['inspection','delivery'].entries()) {
      if (!await db.factoryEvaluation.findFirst({ where: { factoryId: held.id, sourceId: heldRelation, kind } })) await service.addEvaluation(held.id, { kind, score: [52,78][n], sourceType: 'manual', sourceId: heldRelation, evaluatedAt: '2026-09-20', note: n === 0 ? '两批色牢度抽检未达约定等级' : '返工导致交期延后' }, actor.id);
    }
    if (!await db.factoryCertification.findFirst({ where: { factoryId: held.id, certificateNo: 'CN-ISO9001-26-HOLD' } })) await service.addCertification(held.id, { type: 'ISO9001', certificateNo: 'CN-ISO9001-26-HOLD', issuedAt: '2025-09-15', validUntil: '2026-09-15' }, actor.id);
    for (const month of ['2026-10','2026-11','2026-12']) await service.upsertCapacity(held.id, { month, capacity: 30000, unit: 'M', note: '整改期间暂停接单，设备额定产能保留。' }, actor.id);
    const reference = await db.order.findFirst({ where: { deletedAt: null, millRelationId: profiles[0].relationId } });
    if (!reference) throw new Error('Demo customer/order context missing');
    const tcOrderId = `${prefix}-grs-order`;
    if (!await db.order.findUnique({ where: { id: tcOrderId } })) await db.order.create({ data: {
      id: tcOrderId, code: 'SO-202608-GRS01', customer: reference.customer, customerRelationId: reference.customerRelationId,
      product: '炭灰再生涤纶斜纹', type: 'Fabric', quantity: 1000, unit: 'KG', status: 'Delivered', dueDate: '2026-08-18', quoteAmount: 42000,
      currency: 'CNY', millRelationId: profiles[0].relationId, millName: profiles[0].relation.name, ownerId: reference.ownerId, departmentId: reference.departmentId,
      source: 'legacy-import', importedAt: BigInt(Date.now()), updatedAt: BigInt(Date.now()),
      lines: { create: { id: `${tcOrderId}-line`, lineNumber: 1, itemNo: '0010', materialCode: 'RP-TW240', description: '炭灰再生涤纶斜纹 · 240g/m²', quantity: 1000, unit: 'KG', unitPrice: 42, netValue: 42000, status: 'Delivered', requiredSampleFamilies: ['fabric'] } },
    } });
    const tc = createTcCertificateService(db);
    if (!await db.factoryCertification.findFirst({ where: { factoryId: profiles[0].id, type: 'GRS', certificateNo: 'GRS-SC-2026-0801', deletedAt: null } })) {
      await service.addCertification(profiles[0].id, { type: 'GRS', certificateNo: 'GRS-SC-2026-0801', issuedAt: '2026-01-15', validUntil: '2027-01-14' }, actor.id);
    }
    for (const [n, stage] of ['material_input','factory_output','our_sale'].entries()) {
      const tcNo = `GRS-TC-2026-080${n+1}`;
      if (!await db.tcCertificate.findFirst({ where: { tcNo, deletedAt: null } })) {
        const result = await tc.createTc({ orderId: tcOrderId, stage, tcNo, quantityKg: [1050,1020,1000][n], relationId: profiles[0].relationId, issuedAt: '2026-08-15', validUntil: '2027-08-14', notes: '再生面料历史批次交易证书记录；原料、加工损耗与销售数量按三段勾稽。' });
        if (!result.ok) throw new Error(JSON.stringify(result));
      }
      if (stage === 'our_sale' && reference.customerRelationId) {
        const buyer = await db.relation.findUniqueOrThrow({ where: { id: reference.customerRelationId } });
        await db.tcCertificate.update({ where: { tcNo }, data: { relationId: buyer.id, relationName: buyer.name } });
      }
    }
    const delay = createDelayImpactService(db);
    for (const p of profiles.slice(0, 3)) {
      const note = `${prefix}：织机检修，预计延后3天，业务组跟进替代排期`;
      if (!await db.factoryDelayRecord.findFirst({ where: { supplierRelationId: p.relationId, reasonNote: note, deletedAt: null } })) {
        const result = await delay.registerDelay({ supplierRelationId: p.relationId, delayDays: 3, reason: 'capacity', reasonNote: note, registeredBy: actor.id }, actor.id);
        if (!result.ok) throw new Error(JSON.stringify(result));
      }
    }
  }
  const service = createFactoryService(db);
  const checks = [];
  for (const p of profiles) {
    const overview = await service.getOverview(p.id);
    checks.push({ id: p.id, orders: overview!.profile.totalOrders, amount: Number(overview!.profile.totalAmount), quality: overview!.profile.qualityScore, delivery: overview!.profile.deliveryScore, evaluations: overview!.evaluations.length, certifications: overview!.certifications.length, capacity: overview!.capacity.length, occupied: overview!.capacity.map(row => row.occupied) });
  }
  console.log(JSON.stringify({ profiles: checks.length, checks }, null, 2));
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error.message); process.exitCode = 1; });
