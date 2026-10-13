/**
 * Seed a role-complete local development cast without business transactions.
 * Safe scope: panda_hub_dev on localhost only. Idempotent; never deletes existing rows.
 * Sign in through the Dev Debug Panel's one-click account action; no shared password is set.
 */
import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { createCustomerAuthService } from '../src/customer/authService';

const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

const prisma = new PrismaClient();
const customerAuth = createCustomerAuthService();
const CUSTOMER_PORTAL_PASSWORD = process.env.DEVSIM_CUSTOMER_PORTAL_PASSWORD || 'PandaDev@2026';
const ROLE_IDS = {
  sales: 'role-sales',
  salesManager: 'role-sales-manager',
  finance: 'role-finance',
  leader: 'role-admin',
  qc: 'role-qc',
  logistics: 'role-logistics',
  owner: 'role-super-admin',
} as const;

const SIM_ACCOUNTS = [
  { id: 'devsim-sales-manager', name: '面料业务主管', email: 'sales.fabric.manager@bambook.local', roleId: ROLE_IDS.salesManager, deptId: 'dept-sales', title: '面料业务主管' },
  { id: 'devsim-garment-manager', name: '成衣业务主管', email: 'sales.garment.manager@bambook.local', roleId: ROLE_IDS.salesManager, deptId: 'dept-sales', title: '成衣业务主管' },
  { id: 'devsim-outdoor-a', name: '林嘉（面料一组组长）', email: 'sales.fabric1.lead@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '面料一组组长' },
  { id: 'devsim-outdoor-b', name: '陈希（面料一组）', email: 'sales.fabric1.member@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '面料业务员' },
  { id: 'devsim-fabric2-a', name: '周宁（面料二组组长）', email: 'sales.fabric2.lead@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '面料二组组长' },
  { id: 'devsim-fabric2-b', name: '许安（面料二组）', email: 'sales.fabric2.member@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '面料业务员' },
  { id: 'devsim-apparel-a', name: '顾言（成衣一组组长）', email: 'sales.garment1.lead@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '成衣一组组长' },
  { id: 'devsim-apparel-b', name: '沈禾（成衣一组）', email: 'sales.garment1.member@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '成衣业务员' },
  { id: 'devsim-garment2-a', name: '唐悦（成衣二组组长）', email: 'sales.garment2.lead@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '成衣二组组长' },
  { id: 'devsim-garment2-b', name: '叶青（成衣二组）', email: 'sales.garment2.member@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '成衣业务员' },
  { id: 'devsim-garment3-a', name: '江予（成衣三组组长）', email: 'sales.garment3.lead@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '成衣三组组长' },
  { id: 'devsim-garment3-b', name: '白露（成衣三组）', email: 'sales.garment3.member@bambook.local', roleId: ROLE_IDS.sales, deptId: 'dept-sales', title: '成衣业务员' },
  { id: 'devsim-finance', name: '财务专员', email: 'finance@bambook.local', roleId: ROLE_IDS.finance, deptId: 'dept-finance', title: '财务专员' },
  { id: 'devsim-qc', name: '面料QC', email: 'qc.fabric@bambook.local', roleId: ROLE_IDS.qc, deptId: 'dept-qc', title: '面料QC' },
  { id: 'devsim-garment-qc-a', name: '成衣QC一', email: 'qc.garment1@bambook.local', roleId: ROLE_IDS.qc, deptId: 'dept-qc', title: '成衣QC' },
  { id: 'devsim-garment-qc-b', name: '成衣QC二', email: 'qc.garment2@bambook.local', roleId: ROLE_IDS.qc, deptId: 'dept-qc', title: '成衣QC' },
  { id: 'devsim-logistics', name: '后勤单证专员', email: 'logistics@bambook.local', roleId: ROLE_IDS.logistics, deptId: 'dept-logistics', title: '物流与单证专员' },
] as const;

const TEAM_DEFS = [
  { id: 'devsim-team-outdoor', name: '面料一组', description: '面料业务团队；羊毛精纺、半精纺、粗纺为主，兼有TR与麻棉。', leaderId: 'devsim-outdoor-a', managerId: 'devsim-sales-manager', memberIds: ['devsim-sales-manager', 'devsim-outdoor-a', 'devsim-outdoor-b'], relationId: 'DEVSIM-REL-OUTDOOR', code: 'DEVSIM-CUS-001', customerName: 'Westbridge 英伦正装（英国）', englishName: 'Westbridge Formalwear', ownerId: 'devsim-outdoor-a', primaryContactName: 'Eleanor Shaw', officialAddress: 'London, United Kingdom', currency: 'USD', summary: '英国高端正装品牌面料客户，主做大衣、Blazer、Suit；男装约70%、女装约30%，羊毛精纺/半精纺/粗纺为主，兼有TR与麻棉。出口合同通常以USD计价。', qcIds: ['devsim-qc'] },
  { id: 'devsim-team-fabric2', name: '面料二组', description: '面料业务团队；覆盖欧美品牌和国内工厂配套采购场景。', leaderId: 'devsim-fabric2-a', managerId: 'devsim-sales-manager', memberIds: ['devsim-sales-manager', 'devsim-fabric2-a', 'devsim-fabric2-b'], relationId: 'DEVSIM-REL-FABRIC-2', code: 'DEVSIM-CUS-003', customerName: 'Meridian Wool House（西班牙）', englishName: 'Meridian Wool House', ownerId: 'devsim-fabric2-a', primaryContactName: 'Lucia Navarro', officialAddress: 'Madrid, Spain', currency: 'USD', summary: '西班牙高端正装面料客户；大衣、Blazer、Suit用料，羊毛为主，兼有TR与麻棉。可演练海外USD合同、国内工厂收货并以CNY付款。', qcIds: ['devsim-qc'] },
  { id: 'devsim-team-apparel', name: '成衣一组', description: '成衣业务团队；高端大衣、Blazer、Suit开发。', leaderId: 'devsim-apparel-a', managerId: 'devsim-garment-manager', memberIds: ['devsim-garment-manager', 'devsim-apparel-a', 'devsim-apparel-b'], relationId: 'DEVSIM-REL-APPAREL', code: 'DEVSIM-CUS-002', customerName: 'Cedar & Crown Tailoring（美国）', englishName: 'Cedar & Crown Tailoring', ownerId: 'devsim-apparel-a', primaryContactName: 'Morgan Ellis', officialAddress: 'New York, United States', currency: 'USD', summary: '美国高端正装品牌，主做大衣、Blazer、Suit；男装约70%、女装约30%，羊毛面料为主。', qcIds: ['devsim-garment-qc-a', 'devsim-garment-qc-b'] },
  { id: 'devsim-team-garment2', name: '成衣二组', description: '成衣业务团队；覆盖欧洲品牌和男女装混合开发。', leaderId: 'devsim-garment2-a', managerId: 'devsim-garment-manager', memberIds: ['devsim-garment-manager', 'devsim-garment2-a', 'devsim-garment2-b'], relationId: 'DEVSIM-REL-GARMENT-2', code: 'DEVSIM-CUS-004', customerName: 'Vistula Atelier（波兰）', englishName: 'Vistula Atelier', ownerId: 'devsim-garment2-a', primaryContactName: 'Anna Kowalska', officialAddress: 'Warsaw, Poland', currency: 'USD', summary: '波兰高端正装品牌，开发大衣、Blazer、Suit；男装约70%、女装约30%，优先羊毛精纺与粗纺面料。', qcIds: ['devsim-garment-qc-a', 'devsim-garment-qc-b'] },
  { id: 'devsim-team-garment3', name: '成衣三组', description: '成衣业务团队；覆盖美洲及少量国内销售场景。', leaderId: 'devsim-garment3-a', managerId: 'devsim-garment-manager', memberIds: ['devsim-garment-manager', 'devsim-garment3-a', 'devsim-garment3-b'], relationId: 'DEVSIM-REL-GARMENT-3', code: 'DEVSIM-CUS-005', customerName: 'Casa del Traje（墨西哥）', englishName: 'Casa del Traje', ownerId: 'devsim-garment3-a', primaryContactName: 'Sofia Reyes', officialAddress: 'Mexico City, Mexico', currency: 'USD', summary: '墨西哥高端正装品牌，开发大衣、Blazer、Suit；男装约70%、女装约30%，羊毛为主，兼有TR、麻棉；另可扩展少量国内CNY内销案例。', qcIds: ['devsim-garment-qc-a', 'devsim-garment-qc-b'] },
] as const;

const DEPARTMENTS = [
  { id: 'dept-company', name: '总公司', parentId: null },
  { id: 'dept-sales', name: '业务部', parentId: 'dept-company' },
  { id: 'dept-finance', name: '财务部', parentId: 'dept-company' },
  { id: 'dept-admin', name: '行政人事部', parentId: 'dept-company' },
  { id: 'dept-management', name: '总经办', parentId: 'dept-company' },
  { id: 'dept-qc', name: '质量部', parentId: 'dept-company' },
  { id: 'dept-logistics', name: '后勤部', parentId: 'dept-company' },
] as const;

async function main() {
  const databaseUrl = process.env.DATABASE_URL || '';
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, '').split('/')[0];
  if (parsed.hostname !== 'localhost' || databaseName !== 'panda_hub_dev') {
    throw new Error(`Refusing to seed: expected localhost/panda_hub_dev, got ${parsed.hostname}/${databaseName}`);
  }

  const owner = await prisma.userAccount.findFirst({
    where: { email: 'owner@bambook.local', status: 'active', deletedAt: null },
    select: { id: true },
  });
  if (!owner) throw new Error('Required active owner@bambook.local bootstrap account was not found.');
  const ownerRole = await prisma.userRole.findFirst({ where: { userId: owner.id, roleId: ROLE_IDS.owner } });
  if (!ownerRole) throw new Error('Bootstrap account is missing role-super-admin; refusing to seed.');

  const requiredRoles = Object.values(ROLE_IDS);
  const roles = await prisma.role.findMany({ where: { id: { in: requiredRoles } }, select: { id: true } });
  if (roles.length !== requiredRoles.length) throw new Error('Run the canonical RBAC seed first; one or more system roles are missing.');

  // Refuse to take over any pre-existing real identity with one of the deterministic fixture emails.
  const collision = await prisma.userAccount.findFirst({
    where: { email: { in: SIM_ACCOUNTS.map(a => a.email) }, NOT: { id: { in: SIM_ACCOUNTS.map(a => a.id) } } },
    select: { id: true, email: true },
  });
  if (collision) throw new Error(`Refusing to overwrite account ${collision.email}; id=${collision.id} is not a simulation fixture.`);

  const portalUsers = [
    { id: 'DEVSIM-CUSU-OUTDOOR', email: 'buyer.westbridge@portal.demo', displayName: 'Eleanor Shaw', relationId: 'DEVSIM-REL-OUTDOOR', relationName: 'Westbridge 英伦正装（英国）' },
    { id: 'DEVSIM-CUSU-FABRIC-2', email: 'buyer.meridian@portal.demo', displayName: 'Lucia Navarro', relationId: 'DEVSIM-REL-FABRIC-2', relationName: 'Meridian Wool House（西班牙）' },
    { id: 'DEVSIM-CUSU-APPAREL', email: 'buyer.cedar@portal.demo', displayName: 'Morgan Ellis', relationId: 'DEVSIM-REL-APPAREL', relationName: 'Cedar & Crown Tailoring（美国）' },
    { id: 'DEVSIM-CUSU-GARMENT-2', email: 'buyer.vistula@portal.demo', displayName: 'Anna Kowalska', relationId: 'DEVSIM-REL-GARMENT-2', relationName: 'Vistula Atelier（波兰）' },
    { id: 'DEVSIM-CUSU-GARMENT-3', email: 'buyer.casadeltraje@portal.demo', displayName: 'Sofia Reyes', relationId: 'DEVSIM-REL-GARMENT-3', relationName: 'Casa del Traje（墨西哥）' },
  ] as const;
  const portalCollision = await prisma.customerUser.findFirst({
    where: { email: { in: portalUsers.map(user => user.email) }, NOT: { id: { in: portalUsers.map(user => user.id) } } },
    select: { id: true, email: true },
  });
  if (portalCollision) throw new Error(`Refusing to overwrite customer portal account ${portalCollision.email}; id=${portalCollision.id} is not a simulation fixture.`);
  const portalPasswordHash = await customerAuth.hashPassword(CUSTOMER_PORTAL_PASSWORD);

  await prisma.$transaction(async tx => {
    for (const department of DEPARTMENTS) {
      await tx.department.upsert({
        where: { id: department.id },
        update: { name: department.name, parentId: department.parentId, status: 'active' },
        create: { ...department, status: 'active' },
      });
    }

    for (const account of SIM_ACCOUNTS) {
      await tx.userAccount.upsert({
        where: { id: account.id },
        update: {
          displayName: account.name, email: account.email, status: 'active', primaryDeptId: account.deptId,
          metadata: { simulation: true, roleTitle: account.title, simulationPack: 'role-play-2026-10' },
        },
        create: {
          id: account.id, displayName: account.name, email: account.email, status: 'active',
          primaryDeptId: account.deptId, passwordHash: '',
          metadata: { simulation: true, roleTitle: account.title, simulationPack: 'role-play-2026-10' },
        },
      });
      await tx.userRole.upsert({
        where: { userId_roleId_departmentId: { userId: account.id, roleId: account.roleId, departmentId: account.deptId } },
        update: {},
        create: { id: `devsim-ur-${account.id}`, userId: account.id, roleId: account.roleId, departmentId: account.deptId },
      });
    }

    const departmentHeads: Record<string, string> = {
      'dept-company': owner.id,
      'dept-sales': 'devsim-sales-manager',
      'dept-finance': 'devsim-finance',
      'dept-admin': owner.id,
      'dept-management': owner.id,
      'dept-qc': 'devsim-qc',
      'dept-logistics': 'devsim-logistics',
    };
    for (const [id, headId] of Object.entries(departmentHeads)) {
      await tx.department.update({ where: { id }, data: { headId } });
    }

    // The previous role-play pack had a redundant simulated leader; the real bootstrap owner is the sole final boss.
    await tx.userAccount.updateMany({
      where: { id: 'devsim-leader' },
      data: { displayName: '（停用）旧账号', status: 'disabled' },
    });

    for (const team of TEAM_DEFS) {
      const activeMemberIds = [...team.memberIds, ...team.qcIds];
      await tx.team.upsert({
        where: { id: team.id },
        update: {
          name: team.name, description: team.description, leaderId: team.leaderId,
          departmentId: 'dept-sales', status: 'active', deletedAt: null,
          metadata: { simulation: true, simulationPack: 'role-play-2026-10', businessFamily: team.name.includes('面料') ? 'fabric' : 'garment' },
        },
        create: {
          id: team.id, name: team.name, description: team.description, leaderId: team.leaderId,
          departmentId: 'dept-sales', status: 'active',
          metadata: { simulation: true, simulationPack: 'role-play-2026-10', businessFamily: team.name.includes('面料') ? 'fabric' : 'garment' },
        },
      });
      await tx.teamMember.updateMany({
        where: { teamId: team.id, leftAt: null, userId: { notIn: activeMemberIds } },
        data: { leftAt: new Date() },
      });
      for (const userId of activeMemberIds) {
        await tx.teamMember.upsert({
          where: { teamId_userId: { teamId: team.id, userId } },
          update: { role: userId === team.leaderId ? 'leader' : 'member', leftAt: null },
          create: { id: `devsim-tm-${team.id}-${userId}`, teamId: team.id, userId, role: userId === team.leaderId ? 'leader' : 'member' },
        });
      }

      const relationCodeConflict = await tx.relation.findFirst({ where: { code: team.code, NOT: { id: team.relationId } }, select: { id: true } });
      if (relationCodeConflict) throw new Error(`Synthetic customer code collision: ${team.code}`);
      await tx.relation.upsert({
        where: { id: team.relationId },
        update: {
          code: team.code, name: team.customerName, chineseName: team.customerName,
          englishName: team.englishName, category: 'Customer', type: 'company', isOrganization: true,
          tags: ['SIMULATION', 'TEAM_SCENARIO', 'FORMAL_WEAR', 'WOOL_FOCUS'], contactInfo: '{}', summary: team.summary,
          officialAddress: team.officialAddress, currency: team.currency,
          preferences: '高端正装；大衣、Blazer、Suit；男装约70%、女装约30%；羊毛精纺、半精纺、粗纺为主，兼有TR、麻棉。',
          primaryContactName: team.primaryContactName, stage: 'Customer', tier: 'B', ownerId: team.ownerId,
          departmentId: 'dept-sales', salesRepIds: [team.ownerId], sensitivity: 'normal',
          lastInteraction: BigInt(Date.now()), deletedAt: null,
        },
        create: {
          id: team.relationId, code: team.code, name: team.customerName, chineseName: team.customerName,
          englishName: team.englishName, category: 'Customer', type: 'company', isOrganization: true,
          tags: ['SIMULATION', 'TEAM_SCENARIO', 'FORMAL_WEAR', 'WOOL_FOCUS'], contactInfo: '{}', summary: team.summary,
          officialAddress: team.officialAddress, currency: team.currency,
          preferences: '高端正装；大衣、Blazer、Suit；男装约70%、女装约30%；羊毛精纺、半精纺、粗纺为主，兼有TR、麻棉。',
          primaryContactName: team.primaryContactName, stage: 'Customer', tier: 'B', ownerId: team.ownerId,
          departmentId: 'dept-sales', salesRepIds: [team.ownerId], sensitivity: 'normal',
          lastInteraction: BigInt(Date.now()),
        },
      });
      await tx.teamDataGrant.upsert({
        where: { teamId_entityType_entityId: { teamId: team.id, entityType: 'relation', entityId: team.relationId } },
        update: { permission: 'read+followup', grantedBy: owner.id, revokedAt: null, revokedBy: null, revokeReason: null },
        create: { teamId: team.id, entityType: 'relation', entityId: team.relationId, permission: 'read+followup', grantedBy: owner.id },
      });
    }

    for (const user of portalUsers) {
      await tx.customerUser.upsert({
        where: { id: user.id },
        update: {
          email: user.email, passwordHash: portalPasswordHash, displayName: user.displayName,
          relationId: user.relationId, relationName: user.relationName, status: 'active', deletedAt: null,
        },
        create: {
          id: user.id, email: user.email, passwordHash: portalPasswordHash, displayName: user.displayName,
          relationId: user.relationId, relationName: user.relationName, status: 'active',
        },
      });
    }
  });

  console.log('Role-play seed complete: 17 active internal simulation accounts + sole existing owner; 5 business teams; 5 synthetic customers with read+followup grants; 5 relation-scoped customer portal accounts.');
  console.log('Customer portal credentials are local-dev only; override the password with DEVSIM_CUSTOMER_PORTAL_PASSWORD.');
  console.log('No development cases, quotations, orders, shipments, or finance transactions were created.');
}

main().catch(error => {
  console.error('Role-play seed failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
