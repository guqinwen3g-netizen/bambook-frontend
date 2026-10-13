import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { todayLocalKey } from '../shared/localDate';

/** Preserve FB/GR-YYYYMMDD-4HEX. A deleted or differently categorized asset
 * still owns its SKU. The caller owns the complete conversion transaction;
 * only the actual asset INSERT has a savepoint, not source/audit mutations. */
export async function createDevelopmentAssetWithSku(
  tx: Prisma.TransactionClient,
  prefix: 'FB' | 'GR',
  data: Omit<Prisma.ProductAssetUncheckedCreateInput, 'sku'>,
) {
  const day = todayLocalKey().replace(/-/g, ''), namespace = `${prefix}-${day}-`;
  // executeRaw avoids attempting to deserialize PostgreSQL's void lock result.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`development-sku:${namespace}`}))`;
  const attempted = new Set<string>();
  while (true) {
    const occupied = new Set((await tx.productAsset.findMany({ where: { sku: { startsWith: namespace } }, select: { sku: true } })).map(row => row.sku));
    let sku: string | undefined;
    for (let slot = 0; slot < 65536; slot++) {
      const candidate = namespace + slot.toString(16).toUpperCase().padStart(4, '0');
      if (!occupied.has(candidate) && !attempted.has(candidate)) { sku = candidate; break; }
    }
    if (!sku) throw new DevelopmentDomainError('CONFLICT', '当日开发档案编号已用完，请联系管理员核对编号后重试。');
    // This identifier is server-generated hex; no command field enters SQL.
    const savepoint = `development_sku_${randomUUID().replace(/-/g, '')}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    let created;
    try {
      created = await tx.productAsset.create({ data: { ...data, sku } });
    } catch (error) {
      const skuConflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
        && error.meta?.modelName === 'ProductAsset' && Array.isArray(error.meta?.target)
        && error.meta.target.length === 1 && error.meta.target[0] === 'sku';
      if (!skuConflict) throw error; // The outer business transaction must roll back.
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      attempted.add(sku); // A non-cooperating producer claimed this actual slot.
      continue; // Re-read committed occupancy after recovering the transaction.
    }
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
    return created;
  }
}
