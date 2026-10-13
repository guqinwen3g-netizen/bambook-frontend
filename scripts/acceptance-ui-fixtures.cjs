// Synthetic identities and draft business inputs for a private browser rehearsal.
// No approved, confirmed, paid, shipped or QC facts are seeded here.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const server = path.resolve(__dirname, '../server');
require(path.join(server, 'node_modules/ts-node/register/transpile-only'));
const { PrismaClient } = require(path.join(server, 'node_modules/@prisma/client'));
const bcrypt = require(path.join(server, 'node_modules/bcryptjs'));
const { SYSTEM_ROLE_IDS, SYSTEM_ROLE_META, PERMISSION_SCOPES, getDatabaseSeedScopeListForRole } = require(path.join(server, 'src/_shared/rolePermissionMatrix.ts'));
const prisma = new PrismaClient();
async function main() {
  const sandbox = fs.realpathSync(process.env.BAMBOOK_ACCEPTANCE_SANDBOX || '');
  const [actual] = await prisma.$queryRawUnsafe("SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port");
  if (!/^bambook_acceptance_[a-f0-9]+$/.test(actual.name) || actual.name !== process.env.BAMBOOK_ACCEPTANCE_DB_NAME ||
      actual.directory !== process.env.BAMBOOK_ACCEPTANCE_DB_DIR || actual.port !== Number(process.env.BAMBOOK_ACCEPTANCE_DB_PORT) ||
      !fs.realpathSync(actual.directory).startsWith(sandbox + path.sep)) throw Error('UI fixture requires the independently verified private cluster');
  if (await prisma.userAccount.count({ where: { id: { startsWith: 'acceptance_ui_' } } })) throw Error('UI fixture is initial provisioning only');
  const password = 'Acceptance-' + crypto.randomBytes(18).toString('hex');
  const passwordHash = await bcrypt.hash(password, 12), departmentId = 'acceptance_ui_department';
  const users = [];
  await prisma.$transaction(async tx => {
    await tx.department.create({ data: { id: departmentId, name: '合成浏览器验收团队', status: 'active' } });
    for (const [scope, description] of Object.entries(PERMISSION_SCOPES)) await tx.permission.upsert({
      where: { scope }, update: {}, create: { id: 'acceptance_ui_permission_' + crypto.createHash('sha256').update(scope).digest('hex').slice(0, 18), scope, description },
    });
    for (const roleId of Object.values(SYSTEM_ROLE_IDS)) {
      const meta = SYSTEM_ROLE_META[roleId], id = 'acceptance_ui_' + roleId;
      await tx.role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: meta.name, description: meta.description, isSystem: true } });
      for (const scope of getDatabaseSeedScopeListForRole(roleId)) {
        const permission = await tx.permission.findUniqueOrThrow({ where: { scope } });
        await tx.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, update: {},
          create: { id: 'acceptance_ui_grant_' + crypto.createHash('sha256').update(roleId + ':' + scope).digest('hex').slice(0, 18), roleId, permissionId: permission.id } });
      }
      const email = roleId + '@acceptance.invalid';
      await tx.userAccount.create({ data: { id, displayName: '验收 ' + meta.name, email, passwordHash, status: 'active', primaryDeptId: departmentId } });
      await tx.userRole.create({ data: { id: id + '_role', userId: id, roleId, departmentId } });
      users.push({ id, email, roleId });
    }
    const manager = users.find(user => user.roleId === SYSTEM_ROLE_IDS.SALES_MANAGER);
    await tx.department.update({ where: { id: departmentId }, data: { headId: manager.id } });
    const sales = users.find(user => user.roleId === SYSTEM_ROLE_IDS.SALES), now = BigInt(Date.now());
    for (const businessLine of ['fabric', 'garment']) {
      const id = 'acceptance_ui_draft_' + businessLine;
      await tx.order.create({ data: { id, poNumber: id, customer: '合成验收客户', product: '合成待确认订单', businessLine,
        type: businessLine === 'fabric' ? 'Fabric' : 'Garment', quantity: 100, status: 'Draft', dueDate: '2099-11-01', quoteAmount: 2000,
        ownerId: sales.id, departmentId, updatedAt: now } });
      await tx.orderLine.create({ data: { id: id + '_line', orderId: id, lineNumber: 1, itemNo: '1', materialCode: 'acceptance_ui_' + businessLine,
        description: '合成订单输入；无确认、生产或验收事实', quantity: 100, unit: businessLine === 'fabric' ? 'M' : 'PC', unitPrice: 20 } });
    }
  });
  const file = path.join(sandbox, 'ui-credentials.json');
  fs.writeFileSync(file, JSON.stringify({ password, users }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ fixture: 'private-browser-canonical-roles', database: actual.name, users: users.map(({ id, roleId }) => ({ id, roleId })),
    credentialFile: file, limits: 'Canonical default grants and synthetic Draft inputs only; no business approval or full journey qualified.' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
