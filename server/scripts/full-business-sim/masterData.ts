/**
 * Master data only for the explicit, target-verified dev rebuild driver.
 * No CLI, environment reads, client construction, resets or business verdicts.
 * Imported catalog entries are historical directory material, not development/QC evidence.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { getDatabaseSeedScopeListForRole, SYSTEM_ROLE_IDS, SYSTEM_ROLE_META, type SystemRoleId } from '../../src/_shared/rolePermissionMatrix';

export type ScenarioBusinessFamily = 'fabric' | 'garment';
export type ScenarioMasterDataMode = 'plan' | 'apply';
export type ScenarioBusinessTeamKey = 'fabric1' | 'fabric2' | 'garment1' | 'garment2' | 'garment3';
export type ScenarioActorKey = 'owner' | 'fabricManager' | 'garmentManager'
  | 'fabric1Lead' | 'fabric1Sales' | 'fabric2Lead' | 'fabric2Sales'
  | 'garment1Lead' | 'garment1Sales' | 'garment2Lead' | 'garment2Sales' | 'garment3Lead' | 'garment3Sales'
  | 'fabricQc' | 'garmentQc1' | 'garmentQc2' | 'financeOperator' | 'financeAccountant' | 'financeApprover'
  | 'logistics1' | 'logistics2';

export interface ScenarioActor {
  key: ScenarioActorKey; id: string; name: string; email: string; roleId: SystemRoleId;
  departmentId: string; duty: string; password: string | null;
}
export interface ScenarioBusinessTeam {
  key: ScenarioBusinessTeamKey; id: string; name: string; businessFamily: ScenarioBusinessFamily;
  departmentId: string; leaderId: string; managerId: string; salespersonId: string; memberIds: string[];
  customerIds: string[]; supplierIds: string[];
}
export interface ScenarioOrganization {
  id: string; code: string; name: string; englishName: string; businessFamily: ScenarioBusinessFamily;
  teamKey: ScenarioBusinessTeamKey; ownerId: string; departmentId: string; currency: 'USD' | 'EUR' | 'CNY';
  address: string; primaryContactName: string; primaryContactEmail: string;
}
export type ScenarioSupplierKind = 'fabric_mill' | 'garment_factory' | 'processor' | 'trims_supplier' | 'service_provider';
export interface ScenarioSupplier extends ScenarioOrganization { kind: ScenarioSupplierKind; factoryProfileId: string | null; }
export interface ScenarioCatalogAsset {
  id: string; sku: string; name: string; businessFamily: ScenarioBusinessFamily; subCategoryId: string;
  colorCode: string; colorDescription: string;
  profileId: string; factoryRelationId: string; customerRelationId: string; source: 'other';
  sourceDetail: string; unit: 'M' | 'PC'; moq: number;
}
export interface ScenarioWarehouse {
  id: string; code: string; name: string; type: 'Main' | 'Auxiliary' | 'ThirdParty';
  address: string; responsibleUserId: string; custodianRelationId: string;
}
export interface ScenarioLocation {
  warehouseId: string; businessFamily: ScenarioBusinessFamily; location: string;
  locationDetail: { zone: string; shelf: string; level: string; bin: string };
}
export interface ScenarioMasterData {
  namespace: string; mode: ScenarioMasterDataMode;
  cast: Record<ScenarioActorKey, ScenarioActor>;
  businessTeams: ScenarioBusinessTeam[];
  professionalTeams: Array<{ id: string; name: string; kind: 'qc' | 'finance' | 'logistics'; businessFamily: ScenarioBusinessFamily | null; memberIds: string[] }>;
  departments: Array<{ id: string; name: string; parentId: string | null; headId: string }>;
  approvalAuthorities: Record<ScenarioBusinessFamily, string[]>;
  approvalRouting: { financeRequesterDepartmentId: string; financeReviewerId: string; businessReviewerIds: Record<ScenarioBusinessFamily, string> };
  grants: Array<{ id: string; teamId: string; entityId: string; permission: 'read' | 'read+followup' }>;
  catalog: {
    company: { id: string; name: string; englishName: string; address: string };
    customers: ScenarioOrganization[]; suppliers: ScenarioSupplier[];
    fabricAssets: ScenarioCatalogAsset[]; garmentAssets: ScenarioCatalogAsset[];
    factories: { fabric: ScenarioSupplier[]; garment: ScenarioSupplier[]; processing: ScenarioSupplier[] };
    warehouses: ScenarioWarehouse[]; locations: ScenarioLocation[];
    qcLocations: Array<{ id: string; code: string; name: string; focus: ScenarioBusinessFamily; address: string }>;
  };
}

const PACK = 'bambook-full-business-simulation';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const pad = (value: number) => String(value).padStart(2, '0');
const TEAM_DEFINITIONS = [
  { key: 'fabric1', name: '面料一组', family: 'fabric', lead: 'fabric1Lead', sales: 'fabric1Sales' },
  { key: 'fabric2', name: '面料二组', family: 'fabric', lead: 'fabric2Lead', sales: 'fabric2Sales' },
  { key: 'garment1', name: '成衣一组', family: 'garment', lead: 'garment1Lead', sales: 'garment1Sales' },
  { key: 'garment2', name: '成衣二组', family: 'garment', lead: 'garment2Lead', sales: 'garment2Sales' },
  { key: 'garment3', name: '成衣三组', family: 'garment', lead: 'garment3Lead', sales: 'garment3Sales' },
] as const;
const FABRIC_MATERIALS = [
  { name: '精纺羊毛', english: 'Worsted wool', term: 0, gsm: 240 },
  { name: '粗纺羊毛', english: 'Woollen coating', term: 0, gsm: 420 },
  { name: '棉斜纹', english: 'Cotton twill', term: 1, gsm: 230 },
  { name: '亚麻平纹', english: 'Linen plain weave', term: 2, gsm: 180 },
  { name: '粘胶绉', english: 'Viscose crepe', term: 3, gsm: 160 },
  { name: '涤纶里布', english: 'Polyester lining', term: 4, gsm: 90 },
  { name: '棉针织', english: 'Cotton jersey', term: 1, gsm: 200 },
] as const;
const GARMENT_STYLES = ['双排扣大衣', '单排扣西装', '直筒长裤', '衬衫', '半裙', '针织上衣', '连衣裙'] as const;
const COLORS = ['海军蓝', '炭灰', '米白', '橄榄绿', '驼色'] as const;

/** Pure planning is available without any Prisma access. */
export function planScenarioMasterData(options: { namespace: string; nowMs: number }): ScenarioMasterData {
  const { namespace, nowMs } = options;
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(namespace)) throw new Error('SCENARIO_NAMESPACE_INVALID: use a distinct 3–32 character lowercase simulation namespace');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isFinite(new Date(nowMs).getTime())) throw new Error('SCENARIO_TIME_INVALID: nowMs must be an explicit valid millisecond timestamp');
  const id = (kind: string, key: string) => `${namespace}__${kind}_${key}`;
  const dept = (key: string) => id('dept', key);
  const cast = {} as Record<ScenarioActorKey, ScenarioActor>;
  const actor = (key: ScenarioActorKey, name: string, roleId: SystemRoleId, department: string, duty: string) => {
    cast[key] = { key, id: id('user', key), name, email: `${namespace}.${key.toLowerCase()}@simulation.bambook.local`,
      roleId, departmentId: dept(department), duty, password: null };
  };
  actor('owner', '许衡', SYSTEM_ROLE_IDS.SUPER_ADMIN, 'management', '初始化政策与授权；不代替经办执行整条交易');
  actor('fabricManager', '陆砚', SYSTEM_ROLE_IDS.SALES_MANAGER, 'fabric', '面料业务审批与两组协作');
  actor('garmentManager', '沈明', SYSTEM_ROLE_IDS.SALES_MANAGER, 'garment', '成衣业务审批与三组协作');
  const salesNames = [['林嘉', '陈希'], ['周宁', '许安'], ['顾言', '沈禾'], ['唐悦', '叶青'], ['江予', '白露']];
  TEAM_DEFINITIONS.forEach((team, index) => {
    actor(team.lead, salesNames[index][0], SYSTEM_ROLE_IDS.SALES, team.family, '业务经办、需求/供应与样品交接；不新增专职采购或仓管');
    actor(team.sales, salesNames[index][1], SYSTEM_ROLE_IDS.SALES, team.family, '开发、订单、客户跟进、业务确认与对客发送');
  });
  actor('fabricQc', '白川', SYSTEM_ROLE_IDS.QC, 'qc', '正式面料样品与生产检验');
  actor('garmentQc1', '程露', SYSTEM_ROLE_IDS.QC, 'qc', '成衣逐尺码及生产线检验');
  actor('garmentQc2', '季禾', SYSTEM_ROLE_IDS.QC, 'qc', '成衣QC协作与真实转交');
  actor('financeOperator', '宋澄', SYSTEM_ROLE_IDS.FINANCE, 'finance', '实际收付、票款分配；不以审批生成实付');
  actor('financeAccountant', '孟秋', SYSTEM_ROLE_IDS.FINANCE, 'finance', '原票登记、应收应付、对账与余额读回');
  actor('financeApprover', '乔致', SYSTEM_ROLE_IDS.ADMIN, 'finance', '财务部门申请的真实部门负责人；审批与实付经办分离，非新增财务经理角色');
  actor('logistics1', '方舟', SYSTEM_ROLE_IDS.LOGISTICS, 'logistics', '核厂实装、装箱、CI/PL与业务回程');
  actor('logistics2', '苏临', SYSTEM_ROLE_IDS.LOGISTICS, 'logistics', '后勤协作、外部文件收档与原单据版本核对');

  const departments = [
    { key: 'company', name: '竹衍贸易有限公司', head: 'owner' }, { key: 'fabric', name: '面料业务部', head: 'fabricManager' },
    { key: 'garment', name: '成衣业务部', head: 'garmentManager' }, { key: 'qc', name: '质量部', head: 'fabricQc' },
    { key: 'finance', name: '财务部', head: 'financeApprover' }, { key: 'logistics', name: '后勤单证部', head: 'logistics1' },
    { key: 'management', name: '总经办', head: 'owner' },
  ].map(row => ({ id: dept(row.key), name: row.name, parentId: row.key === 'company' ? null : dept('company'), headId: cast[row.head as ScenarioActorKey].id }));
  const businessTeams: ScenarioBusinessTeam[] = TEAM_DEFINITIONS.map(team => {
    const manager = team.family === 'fabric' ? cast.fabricManager : cast.garmentManager;
    return { key: team.key, id: id('team', team.key), name: team.name, businessFamily: team.family,
      departmentId: dept(team.family), leaderId: cast[team.lead].id, managerId: manager.id, salespersonId: cast[team.sales].id,
      memberIds: [manager.id, cast[team.lead].id, cast[team.sales].id], customerIds: [], supplierIds: [] };
  });
  const professionalTeams: ScenarioMasterData['professionalTeams'] = [
    { id: id('team', 'qc-fabric'), name: '面料QC', kind: 'qc', businessFamily: 'fabric', memberIds: [cast.fabricQc.id] },
    { id: id('team', 'qc-garment'), name: '成衣QC', kind: 'qc', businessFamily: 'garment', memberIds: [cast.garmentQc1.id, cast.garmentQc2.id] },
    { id: id('team', 'finance'), name: '财务协作', kind: 'finance', businessFamily: null, memberIds: [cast.financeOperator.id, cast.financeAccountant.id, cast.financeApprover.id] },
    { id: id('team', 'logistics'), name: '后勤单证', kind: 'logistics', businessFamily: null, memberIds: [cast.logistics1.id, cast.logistics2.id] },
  ];
  const brandNames = ['Westbridge', 'Meridian', 'Cedar Crown', 'Vistula Atelier', 'Casa Norte', 'Harbor Studio', 'Willow House'];
  const countries = ['英国', '西班牙', '美国', '波兰', '墨西哥'];
  const cities = ['London', 'Madrid', 'New York', 'Warsaw', 'Mexico City'];
  const customers: ScenarioOrganization[] = [], suppliers: ScenarioSupplier[] = [];
  businessTeams.forEach((team, teamIndex) => {
    for (let i = 0; i < 7; i++) {
      const number = teamIndex * 7 + i + 1, ownerId = i % 2 ? team.salespersonId : team.leaderId;
      const common = { businessFamily: team.businessFamily, teamKey: team.key, ownerId, departmentId: team.departmentId,
        currency: (i === 6 ? 'CNY' : teamIndex === 1 || teamIndex === 3 ? 'EUR' : 'USD') as ScenarioOrganization['currency'] };
      const customer: ScenarioOrganization = { ...common, id: id('customer', pad(number)), code: `${namespace}-CUS-${pad(number)}`,
        name: `${brandNames[i]} ${countries[teamIndex]} ${team.businessFamily === 'fabric' ? '面料' : '成衣'}`,
        englishName: `${brandNames[i]} ${team.key}`, address: `${number} ${cities[teamIndex]} Avenue, ${cities[teamIndex]}`,
        primaryContactName: ['Eleanor', 'Lucia', 'Morgan', 'Anna', 'Sofia', 'Robin', 'Alex'][i],
        primaryContactEmail: `${namespace}.buyer${pad(number)}@customer.example.invalid` };
      const kind: ScenarioSupplierKind = team.businessFamily === 'fabric' ? (i < 5 ? 'fabric_mill' : 'processor')
        : (i < 5 ? 'garment_factory' : i === 5 ? 'trims_supplier' : 'service_provider');
      const isFactory = kind === 'fabric_mill' || kind === 'garment_factory' || kind === 'processor';
      const supplier: ScenarioSupplier = { ...common, id: id('supplier', pad(number)), code: `${namespace}-SUP-${pad(number)}`,
        name: `${['青川', '云岚', '锦河', '北辰', '栖林', '澄光', '远帆'][i]}${team.name}${({ fabric_mill: '织造', garment_factory: '制衣', processor: '染整', trims_supplier: '辅料', service_provider: '仓储物流' })[kind]}`,
        englishName: `${kind.replace(/_/g, ' ')} ${team.key}-${i + 1}`, address: `中国${team.businessFamily === 'fabric' ? '浙江绍兴' : '江苏苏州'}${number}号`,
        primaryContactName: ['王建华', '李敏', '周伟', '陈静', '赵磊', '孙婷', '吴涛'][i], primaryContactEmail: `${namespace}.supplier${pad(number)}@supplier.example.invalid`,
        kind, factoryProfileId: isFactory ? id('factory-profile', pad(number)) : null };
      customers.push(customer); suppliers.push(supplier); team.customerIds.push(customer.id); team.supplierIds.push(supplier.id);
    }
  });
  const grants: ScenarioMasterData['grants'] = [];
  const grant = (teamId: string, entityId: string, permission: 'read' | 'read+followup') => grants.push({ id: id('grant', digest(`${teamId}:${entityId}`).slice(0, 20)), teamId, entityId, permission });
  for (const team of businessTeams) for (const relationId of [...team.customerIds, ...team.supplierIds]) grant(team.id, relationId, 'read+followup');
  for (const team of professionalTeams) for (const org of [...customers, ...suppliers]) {
    if (!team.businessFamily || team.businessFamily === org.businessFamily) grant(team.id, org.id, 'read');
  }
  const fabricFactories = suppliers.filter(row => row.kind === 'fabric_mill');
  const garmentFactories = suppliers.filter(row => row.kind === 'garment_factory');
  const processingFactories = suppliers.filter(row => row.kind === 'processor');
  const importedSource = `${PACK}:${namespace}:historical-catalog-import`;
  const assets = (family: ScenarioBusinessFamily): ScenarioCatalogAsset[] => Array.from({ length: 35 }, (_, index) => {
    const customer = customers.filter(row => row.businessFamily === family)[index % (family === 'fabric' ? 14 : 21)];
    const sourceFactories = (family === 'fabric' ? fabricFactories : garmentFactories).filter(row => row.teamKey === customer.teamKey);
    const factory = sourceFactories[Math.floor(index / (family === 'fabric' ? 14 : 21)) % sourceFactories.length];
    const colorIndex = Math.floor(index / 7);
    const colorCode = `C${String(colorIndex + 1).padStart(2, '0')}`;
    const colorDescription = COLORS[colorIndex];
    return { id: id('asset', `${family}-${pad(index + 1)}`), sku: `${family === 'fabric' ? 'F' : 'G'}-${String(index + 1).padStart(3, '0')}`,
      name: `${family === 'fabric' ? FABRIC_MATERIALS[index % 7].name : GARMENT_STYLES[index % 7]} · ${colorDescription}`,
      colorCode, colorDescription,
      businessFamily: family, subCategoryId: id('subcategory', family === 'fabric' ? index % 7 === 6 ? 'fabric-knit' : 'fabric-woven' : `garment-${index % 7}`),
      profileId: id('profile', `${family}-${pad(index + 1)}`), factoryRelationId: factory.id, customerRelationId: customer.id,
      source: 'other', sourceDetail: `${importedSource}；历史产品目录资料，未声明开发来源、QC通过、客户认可或实物库存。`,
      unit: family === 'fabric' ? 'M' : 'PC', moq: family === 'fabric' ? 800 : 200 };
  });
  const company = { id: id('organization', 'company'), name: '竹衍贸易有限公司', englishName: 'Bambook Trading Co., Ltd.', address: '中国上海市浦东新区' };
  const custodySupplier = suppliers.find(row => row.kind === 'service_provider')!;
  const warehouses: ScenarioWarehouse[] = [
    { id: id('warehouse', 'sample'), code: `${namespace}-WH-SAMPLE`, name: '办公样品仓', type: 'Auxiliary', address: `${company.address} 样品室`, responsibleUserId: cast.fabric1Lead.id, custodianRelationId: company.id },
    { id: id('warehouse', 'bulk'), code: `${namespace}-WH-BULK`, name: '大货主仓', type: 'Main', address: '中国上海市浦东新区', responsibleUserId: cast.fabric2Lead.id, custodianRelationId: company.id },
    { id: id('warehouse', 'third-party'), code: `${namespace}-WH-THIRD`, name: '第三方保管仓', type: 'ThirdParty', address: custodySupplier.address, responsibleUserId: cast.garment1Lead.id, custodianRelationId: custodySupplier.id },
  ];
  const locations: ScenarioLocation[] = warehouses.flatMap(warehouse => (['fabric', 'garment'] as const).map(family => ({
    warehouseId: warehouse.id, businessFamily: family, location: `${family === 'fabric' ? 'F' : 'G'}-01-01-A`,
    locationDetail: { zone: family === 'fabric' ? '面料区' : '成衣区', shelf: '01', level: '01', bin: 'A' },
  })));
  return { namespace, mode: 'plan', cast, businessTeams, professionalTeams, departments, grants,
    approvalAuthorities: { fabric: [cast.fabricManager.id, cast.owner.id], garment: [cast.garmentManager.id, cast.owner.id] },
    approvalRouting: { financeRequesterDepartmentId: dept('finance'), financeReviewerId: cast.financeApprover.id,
      businessReviewerIds: { fabric: cast.fabricManager.id, garment: cast.garmentManager.id } },
    catalog: { company, customers, suppliers, fabricAssets: assets('fabric'), garmentAssets: assets('garment'),
      factories: { fabric: fabricFactories, garment: garmentFactories, processing: processingFactories }, warehouses, locations,
      qcLocations: [{ id: id('qc-location', 'fabric'), code: `${namespace}-qc-fabric`, name: '绍兴面料驻地', focus: 'fabric', address: '中国浙江省绍兴市' },
        { id: id('qc-location', 'garment'), code: `${namespace}-qc-garment`, name: '苏州成衣驻地', focus: 'garment', address: '中国江苏省苏州市' }] } };
}

/**
 * The caller owns dev target verification/backup/reset; this function deliberately
 * does not discover a database. Apply only provisions masters in one transaction.
 * Passwords are fresh per apply and returned only to the calling driver for its
 * private credential journal. Re-applying the same namespace rotates those demo
 * passwords, so a resume should reuse the driver's saved cast and log in afresh.
 */
export async function seedScenarioMasterData(prisma: PrismaClient, options: {
  namespace: string; nowMs: number; mode: ScenarioMasterDataMode;
}): Promise<ScenarioMasterData> {
  if (options.mode !== 'plan' && options.mode !== 'apply') throw new Error('SCENARIO_MODE_INVALID: explicitly select plan or apply');
  const data = planScenarioMasterData(options);
  if (options.mode === 'plan') return data;
  const prepared = await prepareScenarioMasterData(options);
  await prisma.$transaction(tx => writeScenarioMasterDataInTransaction(tx, prepared),
    { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 60_000 });
  return prepared.data;
}

export interface PreparedScenarioMasterData {
  data: ScenarioMasterData; nowMs: number; passwordHash: string;
}

/** No database access. The caller can durably save this exact private cast
 * before a transaction clears the old dev and provisions the new masters. */
export async function prepareScenarioMasterData(options: { namespace: string; nowMs: number }): Promise<PreparedScenarioMasterData> {
  const data = planScenarioMasterData(options), password = `Scenario-${randomBytes(24).toString('hex')}`;
  const passwordHash = await bcrypt.hash(password, 12);
  for (const actor of Object.values(data.cast)) actor.password = password;
  data.mode = 'apply';
  return { data, nowMs: options.nowMs, passwordHash };
}

/** The caller owns the sole transaction and its exclusive-table locks. This
 * function cannot open a nested transaction or commit a partial reset. */
export async function writeScenarioMasterDataInTransaction(tx: Prisma.TransactionClient, prepared: PreparedScenarioMasterData): Promise<void> {
  const { data, passwordHash, nowMs } = prepared, namespace = data.namespace, now = BigInt(nowMs);
  const actors = Object.values(data.cast), password = actors[0]?.password;
  const plan = planScenarioMasterData({ namespace, nowMs });
  const normalized = { ...data, mode: 'plan', cast: Object.fromEntries(actors.map(actor => [actor.key, { ...actor, password: null }])) };
  if (data.mode !== 'apply' || !password || !password.startsWith('Scenario-') || actors.some(actor => actor.password !== password)
    || JSON.stringify(normalized) !== JSON.stringify(plan) || !await bcrypt.compare(password, passwordHash)) {
    throw Error('SCENARIO_PREPARED_MASTER_MISMATCH');
  }
  const marker = `${PACK}:${namespace}`;
  const metadata = { simulation: true, simulationPack: PACK, simulationNamespace: namespace };
    // Canonical non-login audit anchor, also provisioned by seed-rbac. It is
    // not a business cast member and receives no role, group or credentials.
    const systemActor = await tx.userAccount.findUnique({ where: { id: 'system' } });
    if (systemActor && systemActor.status !== 'disabled') throw new Error('SCENARIO_SYSTEM_ACTOR_NOT_DISABLED');
    if (!systemActor) await tx.userAccount.create({ data: { id: 'system', displayName: '系统服务', email: null,
      passwordHash, status: 'disabled', metadata: { technicalAuditActor: true } } });
    // Provision absent canonical roles, but never silently restore permissions
    // deliberately withdrawn from an existing role during a resumed simulation.
    for (const roleId of Object.values(SYSTEM_ROLE_IDS)) {
      const expectedScopes = getDatabaseSeedScopeListForRole(roleId);
      const existing = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: { include: { permission: true } } } });
      if (existing) {
        const actual = new Set(existing.permissions.map(link => link.permission.scope));
        if (expectedScopes.some(scope => !actual.has(scope))) throw new Error(`SCENARIO_RBAC_NOT_CANONICAL: configure current ${roleId} permissions explicitly before provisioning the cast`);
        continue;
      }
      await tx.role.create({ data: { id: roleId, name: SYSTEM_ROLE_META[roleId].name, description: SYSTEM_ROLE_META[roleId].description, isSystem: true } });
      for (const scope of expectedScopes) {
        const permission = await tx.permission.upsert({ where: { scope }, update: {}, create: { id: `SIMPERM_${digest(scope).slice(0, 24)}`, scope } });
        await tx.rolePermission.create({ data: { id: `SIMRP_${digest(`${roleId}:${scope}`).slice(0, 24)}`, roleId, permissionId: permission.id } });
      }
    }
    for (const department of data.departments) {
      const existing = await tx.department.findUnique({ where: { id: department.id } });
      if (existing && (existing.metadata as any)?.simulationNamespace !== namespace) throw new Error(`SCENARIO_ID_COLLISION: department ${department.id}`);
      const row = { name: department.name, parentId: department.parentId, status: 'active', metadata };
      await tx.department.upsert({ where: { id: department.id }, create: { id: department.id, ...row }, update: row });
    }
    for (const actor of Object.values(data.cast)) {
      const existing = await tx.userAccount.findUnique({ where: { id: actor.id } });
      const emailCollision = await tx.userAccount.findUnique({ where: { email: actor.email } });
      if (emailCollision && emailCollision.id !== actor.id) throw new Error(`SCENARIO_ID_COLLISION: account email ${actor.email}`);
      if (existing && ((existing.metadata as any)?.simulationNamespace !== namespace || (existing.metadata as any)?.simulationPack !== PACK)) throw new Error(`SCENARIO_ID_COLLISION: account ${actor.id}`);
      if (existing && (existing.status !== 'active' || existing.deletedAt != null)) throw new Error(`SCENARIO_ACCOUNT_CHANGED: do not reactivate ${actor.id} through master seeding`);
      if (existing) {
        const roles = await tx.userRole.findMany({ where: { userId: actor.id } });
        if (roles.length !== 1 || roles[0].roleId !== actor.roleId || roles[0].departmentId !== actor.departmentId) throw new Error(`SCENARIO_ACCOUNT_CHANGED: preserve current roles for ${actor.id}`);
      }
      const row = { displayName: actor.name, email: actor.email, passwordHash, primaryDeptId: actor.departmentId, status: 'active',
        metadata: { ...metadata, roleTitle: actor.duty, scenarioActor: actor.key } };
      await tx.userAccount.upsert({ where: { id: actor.id }, create: { id: actor.id, ...row }, update: row });
      if (!existing) await tx.userRole.create({ data: { id: `${actor.id}__role`, userId: actor.id, roleId: actor.roleId, departmentId: actor.departmentId } });
    }
    for (const department of data.departments) await tx.department.update({ where: { id: department.id }, data: { headId: department.headId } });
    const professionalDepartment = { qc: data.cast.fabricQc.departmentId, finance: data.cast.financeOperator.departmentId, logistics: data.cast.logistics1.departmentId };
    for (const team of [...data.businessTeams, ...data.professionalTeams]) {
      const existing = await tx.team.findUnique({ where: { id: team.id } });
      if (existing && (existing.metadata as any)?.simulationNamespace !== namespace) throw new Error(`SCENARIO_ID_COLLISION: team ${team.id}`);
      const isBusiness = 'key' in team;
      const row = { name: team.name, departmentId: isBusiness ? team.departmentId : professionalDepartment[team.kind],
        leaderId: isBusiness ? team.leaderId : team.memberIds[0], status: 'active',
        metadata: { ...metadata, businessFamily: team.businessFamily, scenarioGroupKind: isBusiness ? 'business' : team.kind } };
      await tx.team.upsert({ where: { id: team.id }, create: { id: team.id, ...row }, update: row });
      const currentMembers = await tx.teamMember.findMany({ where: { teamId: team.id } });
      if (currentMembers.some(member => member.leftAt == null ? !team.memberIds.includes(member.userId) : team.memberIds.includes(member.userId))) throw new Error(`SCENARIO_TEAM_CHANGED: preserve current membership of ${team.id}`);
      const currentGrants = await tx.teamDataGrant.findMany({ where: { teamId: team.id, revokedAt: null } });
      if (currentGrants.some(current => current.entityType !== 'relation' || !data.grants.some(planned => planned.teamId === team.id && planned.entityId === current.entityId))) throw new Error(`SCENARIO_GRANT_CHANGED: unexpected current sharing for ${team.id}`);
      for (const userId of team.memberIds) await tx.teamMember.upsert({ where: { teamId_userId: { teamId: team.id, userId } },
        create: { id: `${team.id}__${userId}`, teamId: team.id, userId, role: userId === row.leaderId ? 'leader' : 'member' }, update: {} });
    }
    const organizations = [...data.catalog.customers.map(row => ({ ...row, category: 'Customer' })), ...data.catalog.suppliers.map(row => ({ ...row, category: 'Supplier' }))];
    for (const org of organizations) {
      const existing = await tx.relation.findUnique({ where: { id: org.id } });
      const codeCollision = await tx.relation.findUnique({ where: { code: org.code } });
      if ((existing && !existing.tags.includes(marker)) || (codeCollision && codeCollision.id !== org.id)) throw new Error(`SCENARIO_ID_COLLISION: organization ${org.code}`);
      const row = { code: org.code, name: org.name, chineseName: org.name, englishName: org.englishName, category: org.category,
        type: 'company', isOrganization: true, tags: ['SIMULATION', marker, org.businessFamily], contactInfo: '{}',
        ownerId: org.ownerId, departmentId: org.departmentId, salesRepIds: [org.ownerId], sensitivity: 'normal',
        officialAddress: org.address, billingAddress: org.address, shippingAddress: org.address, currency: org.currency,
        primaryContactName: org.primaryContactName, primaryContactEmail: org.primaryContactEmail,
        paymentTerms: '按对应业务合同约定；目录不推定合同账期', lastInteraction: now,
        summary: `${org.businessFamily === 'fabric' ? '面料' : '成衣'}业务；不代表已发生订单、认可或收付款。`,
        factoryAddresses: org.category === 'Supplier' && 'factoryProfileId' in org && org.factoryProfileId ? [org.address] : [] };
      await tx.relation.upsert({ where: { id: org.id }, create: { id: org.id, ...row }, update: row });
    }
    const company = data.catalog.company;
    const existingCompany = await tx.relation.findUnique({ where: { id: company.id } });
    if (existingCompany && !existingCompany.tags.includes(marker)) throw new Error(`SCENARIO_ID_COLLISION: company ${company.id}`);
    const companyRow = { name: company.name, englishName: company.englishName, category: 'Internal', type: 'company', isOrganization: true,
      tags: ['SIMULATION', marker], contactInfo: '{}', lastInteraction: now, officialAddress: company.address,
      ownerId: data.cast.owner.id, departmentId: data.cast.owner.departmentId, salesRepIds: [] as string[], factoryAddresses: [] as string[] };
    await tx.relation.upsert({ where: { id: company.id }, create: { id: company.id, ...companyRow }, update: companyRow });
    for (const supplier of data.catalog.suppliers.filter(row => row.factoryProfileId)) {
      const existing = await tx.factoryProfile.findUnique({ where: { relationId: supplier.id } });
      if (existing && existing.id !== supplier.factoryProfileId) throw new Error(`SCENARIO_ID_COLLISION: factory profile ${supplier.id}`);
      const row = { relationId: supplier.id, specialties: supplier.kind === 'fabric_mill' ? ['fabric', '梭织面料', '针织面料']
        : supplier.kind === 'garment_factory' ? ['garment', '大衣', '西装', '衬衫'] : ['fabric', '染整加工'],
        capacityUnit: supplier.businessFamily === 'fabric' ? 'M' : 'PC', monthlyCapacity: supplier.businessFamily === 'fabric' ? '180000' : '15000',
        equipmentList: supplier.businessFamily === 'fabric' ? '织机/染整设备' : '平缝/整烫设备',
        notes: `${marker}；工厂自行申报的目录能力，未生成检验评分、历史订单或产量。`, updatedAt: now };
      await tx.factoryProfile.upsert({ where: { relationId: supplier.id }, create: { id: supplier.factoryProfileId!, ...row, createdAt: now }, update: row });
    }
    for (const grant of data.grants) {
      const existing = await tx.teamDataGrant.findUnique({ where: { teamId_entityType_entityId: { teamId: grant.teamId, entityType: 'relation', entityId: grant.entityId } } });
      if (existing && (existing.revokedAt != null || existing.permission !== grant.permission)) throw new Error(`SCENARIO_GRANT_CHANGED: preserve current sharing for ${grant.entityId}`);
      await tx.teamDataGrant.upsert({ where: { teamId_entityType_entityId: { teamId: grant.teamId, entityType: 'relation', entityId: grant.entityId } },
        create: { ...grant, entityType: 'relation', grantedBy: data.cast.owner.id }, update: {} });
    }
    const subCategories = new Map<string, { mainCategory: string; name: string }>();
    for (const asset of [...data.catalog.fabricAssets, ...data.catalog.garmentAssets]) subCategories.set(asset.subCategoryId, {
      mainCategory: asset.businessFamily === 'fabric' ? 'Fabric' : 'Garment', name: asset.businessFamily === 'fabric'
        ? asset.subCategoryId.endsWith('knit') ? '针织面料' : '梭织面料' : `${GARMENT_STYLES[Number(asset.subCategoryId.slice(-1))]}` });
    for (const [categoryId, row] of subCategories) await tx.productSubCategory.upsert({ where: { id: categoryId }, create: { id: categoryId, ...row, updatedAt: now }, update: row });
    const terms = [{ abbreviation: 'WO', chineseName: '羊毛', englishName: 'Wool' }, { abbreviation: 'CO', chineseName: '棉', englishName: 'Cotton' },
      { abbreviation: 'LI', chineseName: '亚麻', englishName: 'Linen' }, { abbreviation: 'VI', chineseName: '粘胶', englishName: 'Viscose' }, { abbreviation: 'PL', chineseName: '涤纶', englishName: 'Polyester' }];
    for (const [index, term] of terms.entries()) await tx.materialCompositionTerm.upsert({ where: { id: `${namespace}__term_${index}` },
      create: { id: `${namespace}__term_${index}`, ...term, updatedAt: now }, update: term });
    for (const [index, asset] of [...data.catalog.fabricAssets, ...data.catalog.garmentAssets].entries()) {
      const existing = await tx.productAsset.findUnique({ where: { id: asset.id } });
      const skuCollision = await tx.productAsset.findUnique({ where: { sku: asset.sku } });
      if ((existing && existing.sourceDetail !== asset.sourceDetail) || (skuCollision && skuCollision.id !== asset.id)) throw new Error(`SCENARIO_ID_COLLISION: historical catalog ${asset.sku}`);
      if (existing && (existing.sourceDevelopmentCaseId || existing.sourceSampleBatchId || existing.sourceSampleVersionId)) throw new Error(`SCENARIO_CATALOG_CHANGED: preserve native development lineage for ${asset.id}`);
      const row = { sku: asset.sku, name: asset.name, mainCategory: asset.businessFamily === 'fabric' ? 'Fabric' : 'Garment',
        subCategoryId: asset.subCategoryId, season: 'AW26', status: 'Active', source: asset.source, sourceDetail: asset.sourceDetail, updatedAt: now };
      await tx.productAsset.upsert({ where: { id: asset.id }, create: { id: asset.id, ...row }, update: row });
      if (asset.businessFamily === 'fabric') {
        const material = FABRIC_MATERIALS[index % 7], mill = data.catalog.suppliers.find(row => row.id === asset.factoryRelationId)!;
        const profile = { articleNo: asset.sku, millOrganizationId: mill.id, millName: mill.name, millQuality: `Q-${asset.sku.slice(2)}`, millColorCode: asset.colorCode, colorDescription: asset.colorDescription,
          construction: index % 7 === 6 ? 'Knit' : 'Woven', weightValue: material.gsm, weightValueGsm: material.gsm, weightUnit: 'gsm',
          widthValue: 150, widthUnit: 'cm', moqValue: asset.moq, sampleMoqValue: 10,
          specialNote: '历史目录规格；成本、库存、工厂合同MOQ与客户认可未知。', updatedAt: now };
        await tx.fabricProfile.upsert({ where: { productAssetId: asset.id }, create: { id: asset.profileId, productAssetId: asset.id, ...profile }, update: profile });
        await tx.fabricCompositionLine.upsert({ where: { id: `${asset.id}__composition` }, create: { id: `${asset.id}__composition`, productAssetId: asset.id,
          termId: `${namespace}__term_${material.term}`, percentage: '100', sortOrder: 0, updatedAt: now }, update: {} });
      } else {
        const garmentIndex = index - data.catalog.fabricAssets.length;
        const factory = data.catalog.suppliers.find(row => row.id === asset.factoryRelationId)!, customer = data.catalog.customers.find(row => row.id === asset.customerRelationId)!;
        const profile = { styleNo: asset.sku, productName: asset.name, garmentCategory: GARMENT_STYLES[garmentIndex % 7],
          customer: customer.name, customerRelationId: customer.id, factory: factory.name, factoryRelationId: factory.id,
          gender: garmentIndex % 3 === 0 ? 'Women' : 'Men', ageGroup: 'Adult', sizeRange: 'XS–XXL', baseSize: 'M', moqValue: asset.moq, moqUnit: 'PCS',
          colorways: asset.colorDescription, qualityNote: '历史目录资料；没有已送审尺码、QC判定、客户认可或库存。', updatedAt: now };
        await tx.garmentProfile.upsert({ where: { productAssetId: asset.id }, create: { id: asset.profileId, productAssetId: asset.id, ...profile }, update: profile });
      }
    }
    for (const warehouse of data.catalog.warehouses) {
      const existing = await tx.warehouse.findUnique({ where: { id: warehouse.id } });
      const codeCollision = await tx.warehouse.findUnique({ where: { code: warehouse.code } });
      if ((existing && !existing.notes?.startsWith(marker)) || (codeCollision && codeCollision.id !== warehouse.id)) throw new Error(`SCENARIO_ID_COLLISION: warehouse ${warehouse.code}`);
      const responsible = Object.values(data.cast).find(actor => actor.id === warehouse.responsibleUserId)!;
      const row = { code: warehouse.code, name: warehouse.name, type: warehouse.type, address: warehouse.address, manager: responsible.name,
        isActive: true, sortOrder: warehouse.type === 'Main' ? 0 : 1,
        profile: { country: '中国', city: warehouse.type === 'ThirdParty' ? '苏州' : '上海', usage: warehouse.type === 'ThirdParty' ? 'custody' : 'owned',
          custodianRelationId: warehouse.custodianRelationId, responsibleUserId: warehouse.responsibleUserId,
          billingBasis: warehouse.type === 'ThirdParty' ? 'agreement' : 'none',
          ...(warehouse.type === 'ThirdParty' ? { currency: 'CNY', billingNotes: '保管协议；实际费用须由业务费用及付款producer登记，目录不生成金额。' } : {}) },
        notes: `${marker}；仅真实仓库档案。库位由后续返样/收货命令引用，不生成库存或收货。`, updatedAt: now };
      await tx.warehouse.upsert({ where: { id: warehouse.id }, create: { id: warehouse.id, ...row, createdAt: now }, update: row });
    }
    for (const location of data.catalog.qcLocations) await tx.qCLocation.upsert({ where: { id: location.id },
      create: { ...location, notes: marker, createdAt: now, updatedAt: now }, update: { name: location.name, address: location.address, focus: location.focus } });
    for (const family of ['fabric', 'garment'] as const) {
      const configured = await tx.orderApprovalAuthority.findMany({ where: { businessLine: family, active: true } });
      if (configured.some(row => !data.approvalAuthorities[family].includes(row.userId))) throw new Error(`SCENARIO_AUTHORITY_EXISTS: configure ${family} policy explicitly; do not overwrite another roster`);
      for (const userId of data.approvalAuthorities[family]) await tx.orderApprovalAuthority.upsert({ where: { userId_businessLine: { userId, businessLine: family } },
        create: { id: `${namespace}__authority_${family}_${digest(userId).slice(0, 12)}`, userId, businessLine: family, active: true, createdBy: data.cast.owner.id }, update: {} });
    }
}
