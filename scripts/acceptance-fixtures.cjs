// Technical baseline only. Never invokes the normal business/demo seed.
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { PrismaClient } = require(path.join(process.cwd(), 'node_modules/@prisma/client'));
const bcrypt = require(path.join(process.cwd(), 'node_modules/bcryptjs'));
const fixtures = process.argv.slice(2);
if (fixtures.some(name => !['system-audit-sentinel', 'rollback-controls'].includes(name)) || new Set(fixtures).size !== fixtures.length) throw Error('Unreviewed fixture');
const prisma = new PrismaClient();
async function main() {
  const identity = await prisma.$queryRawUnsafe("SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port");
  const actual = identity[0];
  if (!/^bambook_acceptance_[a-f0-9]+$/.test(actual.name) || actual.name !== process.env.BAMBOOK_ACCEPTANCE_DB_NAME || actual.directory !== process.env.BAMBOOK_ACCEPTANCE_DB_DIR || actual.port !== Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT)) throw Error('Fixture database is not the independently verified acceptance cluster');
  for (const fixture of fixtures) {
    if (fixture === 'rollback-controls') {
      const { DRILL_ACTOR_PREFIX } = await import(pathToFileURL(path.join(__dirname, 'lib/drill-residue.mjs')).href);
      const actor = DRILL_ACTOR_PREFIX + 'ACCEPTANCE_SHAPE';
      const department = 'acceptance_rollback_dept';
      const reviewer = 'acceptance_rollback_reviewer';
      const order = 'o_realdb_probe';
      await prisma.$transaction(async tx => {
        await tx.userAccount.create({ data: { id: actor, displayName: '验收查询对照' } });
        await tx.notification.create({ data: { id: 'acceptance_shape_notification', userId: actor, type: 'briefing', title: '合成查询对照', body: '仅用于外键统计阳性对照' } });
        await tx.department.create({ data: { id: department, name: '合成验收部门', status: 'active' } });
        await tx.userAccount.create({ data: { id: 'usr_demo_boss', displayName: '合成业务申请人', status: 'active', primaryDeptId: department } });
        await tx.userAccount.create({ data: { id: reviewer, displayName: '合成部门主管', status: 'active', primaryDeptId: department } });
        await tx.department.update({ where: { id: department }, data: { headId: reviewer } });
        await tx.order.create({ data: { id: order, customer: '合成验收客户', product: '合成验收面料', type: 'Fabric', businessLine: 'fabric', quantity: 100, status: 'Confirmed', dueDate: '2026-10-15', quoteAmount: '1000.00', updatedAt: BigInt(Date.now()), ownerId: 'usr_demo_boss', departmentId: department } });
      });
      if (await prisma.approvalRequest.count() || await prisma.orderChangeRequest.count() || await prisma.sequenceRegister.count()) throw Error('Rollback controls must start without previous approvals, changes or numbers');
      console.log(JSON.stringify({ fixture, database: actual.name, records: { actor, notification: 'acceptance_shape_notification', department, requester: 'usr_demo_boss', reviewer, order }, basis: ['actorRefWhereShape.test.ts:71', 'approvalRoutingService.ts:160-180', 'numberingRollbackRealDbB274.test.ts:27-42', 'numberingRollbackRealDbOcrB274.test.ts:45-65'], limits: 'Direct service rollback only; no roles/grants, approval decision, exception policy, order confirmation workflow or HTTP authorization claimed', businessDemoSeedApplied: false }));
      continue;
    }
    // Same technical contract as server/scripts/seed-rbac.ts:362-375.
    // Disabled, random password, no roles or scopes: an audit FK anchor only.
    const row = await prisma.userAccount.create({ data: { id: 'system', displayName: '系统服务', email: null, passwordHash: await bcrypt.hash(crypto.randomUUID(), 12), status: 'disabled' }, select: { id: true, status: true } });
    console.log(JSON.stringify({ fixture, database: actual.name, result: row, basis: 'server/scripts/seed-rbac.ts:362-375', businessSeedApplied: false }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
