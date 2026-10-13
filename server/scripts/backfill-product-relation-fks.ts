/**
 * 阶段 D / D2：产品档案 Relation FK 存量回填
 *
 * D2 将产品档案的供应商/客户/工厂从裸文本升级为 snapshot + FK 双写：
 *   FabricProfile.millOrganizationId（FK）+ millName（快照）
 *   GarmentProfile.customerRelationId / factoryRelationId（FK）+ customer/factory（快照）
 *   TrimmingProfile.supplierRelationId（FK）+ supplier（快照）
 *
 * 本脚本扫描存量记录，按 Relation.name 精确匹配回填 FK：
 *   - 仅唯一精确命中才回填（大小写/首尾空格归一）；多命中/零命中保持原样
 *   - 已是合法 Relation.id 的 millOrganizationId 仅补 millName 快照
 *   - 已有 FK 的记录不覆盖（幂等，可重复执行）
 *   - 每次回填写字段级审计日志（operationType: link）
 *   - 回填完成后对受影响产品触发 syncProductAssetReferences 入图
 *
 * 用法：cd server && npx tsx scripts/backfill-product-relation-fks.ts
 */
import { PrismaClient } from '@prisma/client';
import { syncProductAssetReferences } from '../src/entities/sync';
import { writeFieldAuditLog } from '../src/audit/routeAudit';

const SOURCE = 'backfill-d2';

/** 名称归一化：trim + 大小写折叠（精确匹配前的唯一预处理，不做模糊匹配） */
function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * AuditLog.actorId 有 UserAccount 外键，回填操作必须挂在真实用户下。
 * 解析顺序：BACKFILL_ACTOR_ID 环境变量 → 库内第一个用户 → 'system'（无外键约束环境兜底）。
 */
async function resolveAuditActor(prisma: PrismaClient): Promise<string> {
  if (process.env.BACKFILL_ACTOR_ID) return process.env.BACKFILL_ACTOR_ID;
  const first = await prisma.userAccount.findFirst({ select: { id: true }, orderBy: { id: 'asc' } });
  return first?.id ?? 'system';
}

(async () => {
  const prisma = new PrismaClient();

  console.log('=== D2 产品档案 Relation FK 存量回填 ===\n');

  const ACTOR = await resolveAuditActor(prisma);
  console.log(`审计 actorId: ${ACTOR}`);

  // 1. 加载全部未软删的组织档案，构建 name → Relation[] 索引
  const relations = await prisma.relation.findMany({
    where: { deletedAt: null, isOrganization: true },
    select: { id: true, name: true, category: true },
  });
  const byId = new Map(relations.map((r) => [r.id, r]));
  const byName = new Map<string, typeof relations>();
  for (const rel of relations) {
    const key = normalizeName(rel.name);
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(rel);
    byName.set(key, list);
  }
  console.log(`加载组织档案 ${relations.length} 条，名称索引 ${byName.size} 个\n`);

  /**
   * 唯一精确命中解析：
   *   - 返回值已是 Relation.id → { kind: 'id', relation }
   *   - 名称唯一命中 → { kind: 'name', relation }
   *   - 零命中/多命中 → null（不动数据）
   */
  function resolveUnique(value: unknown): { kind: 'id' | 'name'; relation: { id: string; name: string } } | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const byIdHit = byId.get(raw);
    if (byIdHit) return { kind: 'id', relation: byIdHit };
    const hits = byName.get(normalizeName(raw));
    if (hits && hits.length === 1) return { kind: 'name', relation: hits[0] };
    return null;
  }

  const stats = {
    fabric: { scanned: 0, linked: 0, named: 0, skipped: 0 },
    garmentCustomer: { scanned: 0, linked: 0, skipped: 0 },
    garmentFactory: { scanned: 0, linked: 0, skipped: 0 },
    trimmingSupplier: { scanned: 0, linked: 0, skipped: 0 },
  };
  const affectedProductIds = new Set<string>();

  async function linkField(params: {
    model: 'fabricProfile' | 'garmentProfile' | 'trimmingProfile';
    rowId: string;
    productAssetId: string;
    fkField: string;
    nameField: string;
    textValue: unknown;
    currentFk: unknown;
  }): Promise<'linked' | 'named' | 'skipped'> {
    const { model, rowId, productAssetId, fkField, nameField, textValue, currentFk } = params;
    if (currentFk) return 'skipped'; // 已有 FK，不覆盖（幂等）
    const hit = resolveUnique(textValue);
    if (!hit) return 'skipped';

    const data: Record<string, any> = { updatedAt: BigInt(Date.now()) };
    if (hit.kind === 'name') data[fkField] = hit.relation.id;
    // 面料有独立 millName 快照字段；成衣/辅料的快照即文本字段本身（已存在，无需回写）
    if (model === 'fabricProfile') data[nameField] = hit.relation.name;
    if (hit.kind === 'id' && model !== 'fabricProfile') return 'skipped'; // 文本位已是 id 且无快照字段可补

    await (prisma as any)[model].update({ where: { id: rowId }, data });
    await writeFieldAuditLog({
      prisma,
      actorId: ACTOR,
      source: SOURCE,
      operation: `backfill_product_relation_fk:${model}.${fkField}`,
      targetType: 'ProductAsset',
      targetId: productAssetId,
      fieldPath: `${model}.${fkField}`,
      beforeValue: currentFk ?? null,
      afterValue: hit.kind === 'name' ? hit.relation.id : currentFk,
      operationType: 'link',
    });
    affectedProductIds.add(productAssetId);
    return hit.kind === 'name' ? 'linked' : 'named';
  }

  // 2. FabricProfile：millOrganizationId（文本 → FK）+ millName（快照）
  const fabricProfiles = await prisma.fabricProfile.findMany({
    where: { deletedAt: null, millOrganizationId: { not: null } },
  });
  for (const row of fabricProfiles) {
    stats.fabric.scanned += 1;
    const result = await linkField({
      model: 'fabricProfile',
      rowId: row.id,
      productAssetId: row.productAssetId,
      fkField: 'millOrganizationId',
      nameField: 'millName',
      textValue: row.millOrganizationId,
      currentFk: byId.has(String(row.millOrganizationId ?? '')) && row.millName ? row.millOrganizationId : null,
    });
    if (result === 'linked') stats.fabric.linked += 1;
    else if (result === 'named') stats.fabric.named += 1;
    else stats.fabric.skipped += 1;
  }
  console.log(`  fabricProfile: 扫描 ${stats.fabric.scanned} → 回填 FK ${stats.fabric.linked} / 补快照 ${stats.fabric.named} / 跳过 ${stats.fabric.skipped}`);

  // 3. GarmentProfile：customer → customerRelationId / factory → factoryRelationId
  const garmentProfiles = await prisma.garmentProfile.findMany({ where: { deletedAt: null } });
  for (const row of garmentProfiles) {
    if (row.customer) {
      stats.garmentCustomer.scanned += 1;
      const result = await linkField({
        model: 'garmentProfile', rowId: row.id, productAssetId: row.productAssetId,
        fkField: 'customerRelationId', nameField: 'customer',
        textValue: row.customer, currentFk: row.customerRelationId,
      });
      if (result === 'linked') stats.garmentCustomer.linked += 1;
      else stats.garmentCustomer.skipped += 1;
    }
    if (row.factory) {
      stats.garmentFactory.scanned += 1;
      const result = await linkField({
        model: 'garmentProfile', rowId: row.id, productAssetId: row.productAssetId,
        fkField: 'factoryRelationId', nameField: 'factory',
        textValue: row.factory, currentFk: row.factoryRelationId,
      });
      if (result === 'linked') stats.garmentFactory.linked += 1;
      else stats.garmentFactory.skipped += 1;
    }
  }
  console.log(`  garmentProfile.customer: 扫描 ${stats.garmentCustomer.scanned} → 回填 FK ${stats.garmentCustomer.linked} / 跳过 ${stats.garmentCustomer.skipped}`);
  console.log(`  garmentProfile.factory:  扫描 ${stats.garmentFactory.scanned} → 回填 FK ${stats.garmentFactory.linked} / 跳过 ${stats.garmentFactory.skipped}`);

  // 4. TrimmingProfile：supplier → supplierRelationId
  const trimmingProfiles = await prisma.trimmingProfile.findMany({
    where: { deletedAt: null, supplier: { not: null } },
  });
  for (const row of trimmingProfiles) {
    stats.trimmingSupplier.scanned += 1;
    const result = await linkField({
      model: 'trimmingProfile', rowId: row.id, productAssetId: row.productAssetId,
      fkField: 'supplierRelationId', nameField: 'supplier',
      textValue: row.supplier, currentFk: row.supplierRelationId,
    });
    if (result === 'linked') stats.trimmingSupplier.linked += 1;
    else stats.trimmingSupplier.skipped += 1;
  }
  console.log(`  trimmingProfile.supplier: 扫描 ${stats.trimmingSupplier.scanned} → 回填 FK ${stats.trimmingSupplier.linked} / 跳过 ${stats.trimmingSupplier.skipped}`);

  // 5. 受影响产品触发 EntityLink 入图
  console.log(`\n触发 EntityLink 入图（${affectedProductIds.size} 个产品）...`);
  const affected = await prisma.productAsset.findMany({
    where: { id: { in: [...affectedProductIds] }, deletedAt: null },
    include: { fabricProfile: true, garmentProfile: true, trimmingProfile: true },
  });
  for (const product of affected) {
    await syncProductAssetReferences(prisma, product, { source: SOURCE });
  }
  const productLinks = await (prisma as any).entityLink.count({
    where: { fromType: 'product', deletedAt: null, status: 'active' },
  });
  console.log(`  入图完成 → 全库 active product EntityLinks: ${productLinks}`);

  console.log('\n=== Summary ===');
  const totalLinked = stats.fabric.linked + stats.garmentCustomer.linked + stats.garmentFactory.linked + stats.trimmingSupplier.linked;
  console.log(`回填 FK 总数: ${totalLinked}（fabric ${stats.fabric.linked} / garmentCustomer ${stats.garmentCustomer.linked} / garmentFactory ${stats.garmentFactory.linked} / trimmingSupplier ${stats.trimmingSupplier.linked}）`);
  console.log(`补充 millName 快照: ${stats.fabric.named}`);
  console.log(`受影响产品: ${affectedProductIds.size}`);

  await prisma.$disconnect();
})().catch((e) => {
  console.error('backfill failed:', e);
  process.exit(1);
});
