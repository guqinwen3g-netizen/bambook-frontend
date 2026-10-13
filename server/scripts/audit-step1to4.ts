import { PrismaClient } from '@prisma/client';

(async () => {
  const prisma = new PrismaClient();
  const tables: Array<[string, () => Promise<{ total: number; demo: number }>]> = [
    ['relation', async () => {
      const total = await prisma.relation.count({ where: { deletedAt: null } });
      const demo = await prisma.relation.count({ where: { deletedAt: null, OR: [{ id: { startsWith: 'DEMO-' } }, { source: 'demo' }] } });
      return { total, demo };
    }],
    ['productAsset', async () => {
      const total = await prisma.productAsset.count({ where: { deletedAt: null } });
      const demo = await prisma.productAsset.count({ where: { deletedAt: null, OR: [{ id: { startsWith: 'DEMO-' } }, { source: 'demo' }] } });
      return { total, demo };
    }],
    ['order', async () => {
      const total = await prisma.order.count({ where: { deletedAt: null } });
      const demo = await prisma.order.count({ where: { deletedAt: null, OR: [{ id: { startsWith: 'DEMO-' } }, { id: { startsWith: 'ORD-FROMDEV-' } }, { fieldSources: { path: ['_source'], equals: 'demo' } }] } });
      return { total, demo };
    }],
    ['orderLine', async () => {
      const total = await prisma.orderLine.count();
      const demo = await prisma.orderLine.count({ where: { OR: [{ id: { startsWith: 'DEMO-' } }, { id: { startsWith: 'OL-' } }] } });
      return { total, demo };
    }],
    ['fabricProfile', async () => {
      const total = await prisma.fabricProfile.count({ where: { deletedAt: null } });
      const demo = await prisma.fabricProfile.count({ where: { deletedAt: null, productAssetId: { startsWith: 'DEMO-' } } });
      return { total, demo };
    }],
    ['garmentProfile', async () => {
      const total = await prisma.garmentProfile.count({ where: { deletedAt: null } });
      const demo = await prisma.garmentProfile.count({ where: { deletedAt: null, productAssetId: { startsWith: 'DEMO-' } } });
      return { total, demo };
    }],
    ['trimmingProfile', async () => {
      const total = await prisma.trimmingProfile.count({ where: { deletedAt: null } });
      const demo = await prisma.trimmingProfile.count({ where: { deletedAt: null, productAssetId: { startsWith: 'DEMO-' } } });
      return { total, demo };
    }],
    ['developmentCase', async () => {
      const total = await prisma.developmentCase.count({ where: { deletedAt: null } });
      const demo = await prisma.developmentCase.count({ where: { deletedAt: null, OR: [{ id: { startsWith: 'DEMO-' } }, { code: { startsWith: 'DEMO-' } }] } });
      return { total, demo };
    }],
    ['entityLink', async () => {
      const total = await (prisma as any).entityLink.count({ where: { deletedAt: null, status: 'active' } });
      return { total, demo: total };
    }],
    ['entityReference', async () => {
      const total = await (prisma as any).entityReference.count({ where: { deletedAt: null, status: 'active' } });
      return { total, demo: total };
    }],
    ['orderStatusTransition', async () => {
      const total = await (prisma as any).orderStatusTransition.count();
      return { total, demo: total };
    }],
  ];
  console.log('| 表名 | total | demo | dirty |');
  console.log('|---|---|---|---|');
  for (const [name, fn] of tables) {
    try {
      const r = await fn();
      const dirty = r.total - r.demo;
      console.log(`| ${name} | ${r.total} | ${r.demo} | ${dirty} |`);
    } catch (e: any) {
      console.log(`| ${name} | ERROR | - | ${e.message} |`);
    }
  }

  // Coverage check: every dev-case should have customer + product/supplier links
  console.log('\n=== Dev-case link coverage ===');
  const cases = await prisma.developmentCase.findMany({ where: { deletedAt: null }, select: { id: true, code: true, customerRelationId: true, supplierRelationId: true, productAssetId: true } });
  for (const c of cases) {
    const links = await (prisma as any).entityLink.count({ where: { fromType: 'development-case', fromId: c.id, status: 'active', deletedAt: null } });
    const expected = (c.customerRelationId ? 1 : 0) + (c.supplierRelationId ? 1 : 0) + (c.productAssetId ? 1 : 0);
    const flag = links === expected ? '✓' : '✗ MISSING';
    console.log(`  ${c.code} expected=${expected} actual=${links} ${flag}`);
  }

  // Coverage check: every order should have at least customer link
  console.log('\n=== Order link coverage ===');
  const orders = await prisma.order.findMany({ where: { deletedAt: null }, select: { id: true, poNumber: true, customerRelationId: true, millRelationId: true } });
  for (const o of orders) {
    const links = await (prisma as any).entityLink.count({ where: { fromType: 'order', fromId: o.id, status: 'active', deletedAt: null } });
    const expected = (o.customerRelationId ? 1 : 0) + (o.millRelationId ? 1 : 0);
    const flag = links >= expected ? '✓' : '✗ MISSING';
    console.log(`  ${o.poNumber} expected>=${expected} actual=${links} ${flag}`);
  }

  await prisma.$disconnect();
})();
