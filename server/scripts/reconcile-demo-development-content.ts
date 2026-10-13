import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
const db = new PrismaClient();
async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  if (url.hostname !== 'localhost' || url.pathname !== '/panda_hub_dev') throw Error('WRONG_TARGET');
  const changes: unknown[] = [];
  await db.$transaction(async tx => {
    const cases = await tx.developmentCase.findMany({ where: { deletedAt: null, code: { startsWith: 'dev-oct08-dev-' } } });
    for (const c of cases) {
      // Use actual saved specifications; never rewrite frozen sample/QC evidence.
      if (c.type === 'fabric' && c.specComposition && (c.specComposition !== '100% Wool' || c.specWeave !== 'Twill')) throw Error('UNEXPECTED_SAVED_SPEC');
      if (c.type === 'garment' && c.styleSpec && c.styleSpec !== 'Tailored blazer') throw Error('UNEXPECTED_SAVED_SPEC');
      const productName = c.type === 'fabric' ? '羊毛斜纹 · 280gsm' : '羊毛单排扣西装';
      const name = `${productName} · AW26开发`;
      await tx.developmentCase.update({ where: { id: c.id }, data: { name, productName: c.productName ? productName : null } });
      const assets = await tx.productAsset.findMany({ where: { sourceDevelopmentCaseId: c.id, deletedAt: null } });
      for (const a of assets) {
        await tx.productAsset.update({ where: { id: a.id }, data: { name: productName } });
        if (c.type === 'garment') await tx.garmentProfile.updateMany({ where: { productAssetId: a.id }, data: { productName, styleNo: a.sku } });
        else await tx.fabricProfile.updateMany({ where: { productAssetId: a.id }, data: { articleNo: a.sku } });
      }
      const cards = await tx.sampleCardItem.findMany({ where: { devCaseId: c.id, deletedAt: null } });
      for (const card of cards) {
        const suffix = card.name.startsWith(c.code) ? card.name.slice(c.code.length) : '';
        if (suffix) await tx.sampleCardItem.update({ where: { id: card.id }, data: { name: productName + suffix } });
      }
      changes.push({ sampleCardIds: cards.map(card => card.id), caseId: c.id, before: c.name, after: name, linkedAssetIds: assets.map(a => a.id) });
    }
    const archived = await tx.auditLog.findFirst({ where: { action: 'archive_invalid_simulation_replacements' }, orderBy: { createdAt: 'desc' } });
    const ids = (archived?.detail as any)?.orderIds || [];
    const shipmentIds=(archived?.detail as any)?.shipmentIds||[];
    const oldDocuments=await tx.tradeDocument.findMany({where:{deletedAt:null,OR:[{orderId:{in:ids}},{shipmentId:{in:shipmentIds}}]},select:{id:true}});
    await tx.tradeDocument.updateMany({where:{id:{in:oldDocuments.map(d=>d.id)}},data:{deletedAt:BigInt(Date.now())}});
    const oldBoms = await tx.bOM.findMany({where:{orderId:{in:ids},deletedAt:null},select:{id:true}});
    await tx.bOM.updateMany({where:{id:{in:oldBoms.map(b=>b.id)}},data:{deletedAt:BigInt(Date.now())}});
    const currentBoms = await tx.bOM.findMany({where:{deletedAt:null,status:'Draft'},include:{lines:true}});
    for(const b of currentBoms) {
      if(!b.orderId||!b.description.includes('自动生成'))continue;
      const order=await tx.order.findFirst({where:{id:b.orderId,deletedAt:null}});
      if(!order?.ownerId?.startsWith('dev-oct08__user_'))continue;
      const product=b.lines[0]?.description.replace('（占位行，请编辑补充）','');
      if(!product)continue;
      await tx.bOM.update({where:{id:b.id},data:{description:product,notes:'系统自动建立的成本草稿，物料与实际成本未录；零值不可作为已核算成本。'}});
      for(const line of b.lines) if(line.description.includes('（占位行，请编辑补充）'))await tx.bOMLine.update({where:{id:line.id},data:{description:line.description.replace('（占位行，请编辑补充）',''),notes:'物料用量及成本待补充，未确认。'}});
    }
    const assignments = await tx.qCAssignment.findMany({ where: { orderId: { in: ids }, deletedAt: null }, select: { id: true } });
    await tx.qCAssignment.updateMany({ where: { id: { in: assignments.map(a => a.id) } }, data: { deletedAt: BigInt(Date.now()) } });
    await tx.auditLog.create({ data: { id: randomUUID(), actorId: 'dev-oct08__user_owner', action: 'reconcile_simulation_development_content', targetType: 'SimulationDataset', targetId: 'dev-oct08', detail: { changes: changes as any, archivedTradeDocumentIds:oldDocuments.map(d=>d.id), archivedBomIds: oldBoms.map(b=>b.id), archivedQcAssignments: assignments.map(a => a.id), reason: '开发名称按已保存规格修正；仅归档被替代旧单的待办，冻结QC和审批证据不改。' } } });
    console.log(JSON.stringify({ developmentCases: changes.length, archivedBoms:oldBoms.length, archivedQcAssignments: assignments.length }));
  }, { timeout: 30000 });
}
main().finally(() => db.$disconnect());
