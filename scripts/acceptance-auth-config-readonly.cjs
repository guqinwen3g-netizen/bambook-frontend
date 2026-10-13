// Read-only configuration observation of the current local test database.
// Not acceptance execution, company policy, production account truth or a seed.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { parse } = require(path.join(root, 'server/node_modules/dotenv'));
const { PrismaClient } = require(path.join(root, 'server/node_modules/@prisma/client'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const alias = id => id ? sha(id).slice(0, 12) : null;
const env = { ...process.env };
for (const [file, override] of [['server/.env.local', true], ['server/.env', false]]) {
  if (!fs.existsSync(path.join(root, file))) continue;
  for (const [key, value] of Object.entries(parse(fs.readFileSync(path.join(root, file))))) {
    if (override || env[key] == null) env[key] = value;
  }
}
let prisma;
async function status() {
  const response = await fetch('http://localhost:8081/api/dev/status');
  if (response.status !== 200) throw Error('Live dev database identity unavailable; no DB observation attempted');
  const body = await response.json();
  if (body.ok !== true || body.devPanelEnabled !== true || typeof body.currentDb !== 'string') throw Error('Invalid live dev identity');
  return { currentDb: body.currentDb, nodeEnv: body.env?.nodeEnv, accountCount: body.stats?.accountCount };
}
async function main() {
  const before = await status();
  const url = new URL(env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Only current loopback test PG may be observed');
  if (!['panda_hub_local', 'panda_hub_empty'].includes(before.currentDb)) throw Error('Unrecognized dev database; refusing observation');
  // The live dual-mode pointer, not the original .env DB name, is authoritative.
  url.pathname = '/' + before.currentDb;
  prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const observed = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const identity = await tx.$queryRawUnsafe("SELECT current_database() AS name, current_setting('transaction_read_only') AS read_only, inet_server_port() AS port");
    if (identity.length !== 1 || identity[0].name !== before.currentDb || identity[0].read_only !== 'on' || String(identity[0].port) !== (url.port || '5432')) throw Error('Actual PG read-only identity mismatch');
    const [roles, users, grants, departments] = await Promise.all([
      tx.role.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, isSystem: true,
        permissions: { select: { permission: { select: { scope: true } } } }, users: { select: { userId: true } } } }),
      tx.userAccount.findMany({ select: { id: true, status: true, deletedAt: true, primaryDeptId: true, roles: { select: { roleId: true } } } }),
      tx.userPermissionOverrides.findMany({ select: { userId: true, scope: true, isActive: true, deletedAt: true, expiresAt: true } }),
      tx.department.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, status: true, headId: true } }),
    ]);
    const now = new Date();
    const active = user => user?.status === 'active' && user.deletedAt === null;
    const byUser = new Map(users.map(user => [user.id, user]));
    const unique = values => [...new Set(values)].sort();
    const roleRows = roles.map(role => ({ id: role.id, name: role.name, isSystem: role.isSystem,
      scopes: unique(role.permissions.map(row => row.permission.scope)), permissionRows: role.permissions.length,
      linkedUsers: unique(role.users.map(row => row.userId)).length,
      activeLinkedUsers: unique(role.users.map(row => row.userId).filter(id => active(byUser.get(id)))).length,
      activeAccountAliases: unique(role.users.map(row => row.userId).filter(id => active(byUser.get(id))).map(alias)) }));
    return { readOnly: true, database: { name: identity[0].name, host: url.hostname, port: identity[0].port },
      accounts: { total: users.length, undeleted: users.filter(user => user.deletedAt === null).length,
        active: users.filter(active).length, activeWithoutRoles: users.filter(user => active(user) && !user.roles.length).length },
      roles: roleRows,
      personalGrants: { total: grants.length,
        currentlyEffective: grants.filter(grant => grant.isActive && !grant.deletedAt && (!grant.expiresAt || grant.expiresAt > now) && active(byUser.get(grant.userId))).length,
        orphanUser: grants.filter(grant => !byUser.has(grant.userId)).length,
        inactiveOrExpiredOrDeleted: grants.filter(grant => !grant.isActive || grant.deletedAt || (grant.expiresAt && grant.expiresAt <= now)).length },
      departments: departments.map(dept => { const head = dept.headId ? byUser.get(dept.headId) : undefined; return {
        id: dept.id, name: dept.name, status: dept.status, hasHead: Boolean(dept.headId), headAlias: alias(dept.headId),
        headExists: Boolean(head), headActive: active(head), headPrimaryDepartmentMatches: Boolean(head && head.primaryDeptId === dept.id),
        headRoleIds: head?.roles.map(row => row.roleId).sort() ?? [] }; }),
    };
  }, { isolationLevel: 'RepeatableRead', timeout: 15000 });
  const after = await status();
  if (before.currentDb !== after.currentDb || before.accountCount !== observed.accounts.undeleted || after.accountCount !== observed.accounts.undeleted) throw Error('Live dev identity/account count changed or did not match; snapshot discarded');
  const output = { observedAt: new Date().toISOString(), sourceHead: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    scriptSha256: sha(fs.readFileSync(__filename)), liveApiBefore: before, liveApiAfter: after, ...observed,
    zeroPermissionRoleIds: observed.roles.filter(role => !role.permissionRows).map(role => role.id),
    limit: 'Current local test configuration only, not company/production account truth, approval policy or functional acceptance. SQL transaction is read-only. No account names/emails, credentials, business amounts, grants or seed writes exported. Aliases identify candidate overlap only; role labels do not establish authorization.' };
  fs.writeFileSync(path.join(root, 'artifacts/acceptance-20261001/execution/current-auth-configuration.json'), JSON.stringify(output, null, 2) + '\n');
  console.log(JSON.stringify({ readOnly: true, database: output.database.name, accounts: output.accounts,
    roles: output.roles.length, zeroPermissionRoleIds: output.zeroPermissionRoleIds, personalGrants: output.personalGrants }));
}
main().catch(error => { console.error('Read-only configuration observation failed:', String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted DB URL]')); process.exitCode = 1; }).finally(async () => { await prisma?.$disconnect(); });
