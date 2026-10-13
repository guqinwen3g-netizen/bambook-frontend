/**
 * seed-customer-portal.ts — 客户门户演示账号种子
 *
 * 为「有订单且 customerRelationId 存在的客户公司」各建一个 CustomerUser 演示账号。
 * 幂等：按 email 去重，重复执行不产生重复行。
 *
 * 用法：
 *   cd server && npx tsx scripts/seed-customer-portal.ts
 *   # 可覆盖默认演示口令：CUSTOMER_PORTAL_PASSWORD=xxx npx tsx scripts/seed-customer-portal.ts
 */
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { createCustomerAuthService } from '../src/customer/authService';

const prisma = new PrismaClient();
const customerAuth = createCustomerAuthService();

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 32) || 'customer';
}

async function main() {
  const orders = await prisma.order.findMany({
    where: { deletedAt: null, customerRelationId: { not: null } },
    select: { customerRelationId: true },
  });
  const relIds = Array.from(new Set(orders.map(o => o.customerRelationId as string)));
  const relations = await prisma.relation.findMany({
    where: { id: { in: relIds }, isOrganization: true },
    select: { id: true, name: true, englishName: true, email: true },
  });

  if (!relations.length) {
    console.log('[seed-customer-portal] 未找到有订单的客户公司 Relation，跳过。');
    return;
  }

  const password = process.env.CUSTOMER_PORTAL_PASSWORD || 'Customer@123';
  const passwordHash = await customerAuth.hashPassword(password);

  let created = 0;
  for (const r of relations) {
    const companyName = r.englishName || r.name;
    const email = `${slugify(companyName)}@portal.demo`;
    const existing = await prisma.customerUser.findUnique({ where: { email } });
    if (existing) {
      console.log(`  skip  ${email} (exists)`);
      continue;
    }
    await prisma.customerUser.create({
      data: {
        id: `CUSU__${crypto.randomUUID()}`,
        email,
        passwordHash,
        displayName: companyName,
        relationId: r.id,
        relationName: companyName,
        status: 'active',
      },
    });
    console.log(`  create ${email}  ->  ${companyName} (${r.id})`);
    created += 1;
  }

  console.log(`\n[done] 创建 ${created} 个客户门户演示账号。默认口令: ${password}`);
  console.log('      生产环境请务必覆盖 CUSTOMER_PORTAL_PASSWORD 并即时改密。');
}

main()
  .catch(e => {
    console.error('[seed-customer-portal] failed', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());