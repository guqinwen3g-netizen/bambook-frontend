import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';
import { getDataScopeRule, SYSTEM_ROLE_IDS } from '../../src/_shared/rolePermissionMatrix';
import { planScenarioMasterData, seedScenarioMasterData, prepareScenarioMasterData, writeScenarioMasterDataInTransaction } from './masterData';

const options = { namespace: 'native-scenario', nowMs: Date.parse('2026-10-08T00:18:00.000Z'), mode: 'apply' as const };
/** Only masters have delegates. An accidental stock/QC/approval/payment/audit
 * write throws immediately instead of being accepted by a permissive mock. */
function masterStore() {
  const models = ['role', 'permission', 'rolePermission', 'department', 'userAccount', 'userRole', 'team', 'teamMember', 'teamDataGrant',
    'relation', 'factoryProfile', 'productSubCategory', 'materialCompositionTerm', 'productAsset', 'fabricProfile', 'fabricCompositionLine',
    'garmentProfile', 'warehouse', 'qCLocation', 'orderApprovalAuthority'];
  const tables: Record<string, Map<string, any>> = Object.fromEntries(models.map(model => [model, new Map()]));
  const touched = new Set<string>();
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([field, value]: [string, any]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in value) return value.in.includes(row[field]);
      if (!(field in row)) return matches(row, value); // Prisma compound unique key.
    }
    return (row[field] ?? null) === value;
  });
  const hydrate = (model: string, row: any) => !row ? null : model === 'role' ? { ...row,
    permissions: [...tables.rolePermission.values()].filter(link => link.roleId === row.id).map(link => ({ ...link, permission: tables.permission.get(link.permissionId) })) } : { ...row };
  const delegates = Object.fromEntries(models.map(model => [model, {
    findUnique: async ({ where }: any) => hydrate(model, [...tables[model].values()].find(row => matches(row, where))),
    findMany: async ({ where }: any = {}) => [...tables[model].values()].filter(row => matches(row, where)).map(row => hydrate(model, row)),
    create: async ({ data }: any) => {
      touched.add(model);
      if (!data.id || tables[model].has(data.id)) throw new Error(`Duplicate/missing master id in ${model}`);
      const row = { deletedAt: null, leftAt: null, revokedAt: null, ...data };
      tables[model].set(row.id, row); return hydrate(model, row);
    },
    update: async ({ where, data }: any) => {
      touched.add(model); const row = [...tables[model].values()].find(row => matches(row, where));
      if (!row) throw new Error(`Missing ${model}`); Object.assign(row, data); return hydrate(model, row);
    },
    upsert: async ({ where, create, update }: any) => {
      touched.add(model); const row = [...tables[model].values()].find(candidate => matches(candidate, where));
      if (row) { Object.assign(row, update); return hydrate(model, row); }
      return (delegates as any)[model].create({ data: create });
    },
  }]));
  const db: any = new Proxy({ ...delegates, $transaction: async (run: (tx: any) => Promise<void>) => {
    const before = structuredClone(tables);
    try { return await run(db); } catch (error) { for (const model of models) tables[model] = before[model]; throw error; }
  } }, { get(target, key) { if (!(key in target)) throw new Error(`Forbidden/non-master delegate: ${String(key)}`); return (target as any)[key]; } });
  return { db: db as PrismaClient, tables, touched, rows: (model: string) => [...tables[model].values()] };
}

describe('full business simulation master constructor (pure in-memory, no database)', () => {
  it('prepares the exact login cast before writes and joins the caller transaction without a nested commit', async () => {
    const prepared = await prepareScenarioMasterData(options);
    const f = masterStore();
    expect(f.rows('userAccount')).toHaveLength(0);
    expect(Object.values(prepared.data.cast).every(actor => Boolean(actor.password))).toBe(true);
    const outerTx = new Proxy(f.db, { get(target, key) {
      if (key === '$transaction') throw Error('Nested transaction is forbidden');
      return (target as any)[key];
    } });
    await expect(f.db.$transaction(async () => {
      await writeScenarioMasterDataInTransaction(outerTx as any, prepared);
      expect(await bcrypt.compare(prepared.data.cast.owner.password!, f.tables.userAccount.get(prepared.data.cast.owner.id).passwordHash)).toBe(true);
      throw Error('Caller audit failed; rollback clear and masters together');
    })).rejects.toThrow('Caller audit failed');
    expect(f.rows('userAccount')).toHaveLength(0); expect(f.rows('relation')).toHaveLength(0);
    await writeScenarioMasterDataInTransaction(outerTx as any, prepared);
    expect(f.rows('userAccount')).toHaveLength(22);
    expect(await bcrypt.compare(prepared.data.cast.owner.password!, f.tables.userAccount.get(prepared.data.cast.owner.id).passwordHash)).toBe(true);
  });
  it('rejects a changed prepared roster or password before provisioning any master', async () => {
    const prepared = await prepareScenarioMasterData(options), f = masterStore();
    prepared.data.cast.financeOperator.departmentId = prepared.data.cast.owner.departmentId;
    await expect(writeScenarioMasterDataInTransaction(f.db as any, prepared)).rejects.toThrow('SCENARIO_PREPARED_MASTER_MISMATCH');
    expect(f.rows('userAccount')).toHaveLength(0);
    const passwordChanged = await prepareScenarioMasterData(options);
    for (const actor of Object.values(passwordChanged.data.cast)) actor.password = 'Scenario-not-the-durable-cast';
    await expect(writeScenarioMasterDataInTransaction(f.db as any, passwordChanged)).rejects.toThrow('SCENARIO_PREPARED_MASTER_MISMATCH');
    expect(f.rows('userAccount')).toHaveLength(0);
  });
  it('plans 21 real responsibilities, five business groups and each required catalog without accessing Prisma', async () => {
    const noDatabase = new Proxy({}, { get() { throw new Error('plan must not access a client'); } }) as PrismaClient;
    const plan = await seedScenarioMasterData(noDatabase, { ...options, mode: 'plan' });
    expect(Object.keys(plan.cast)).toHaveLength(21); expect(plan.businessTeams).toHaveLength(5);
    expect(plan.businessTeams.map(team => team.businessFamily)).toEqual(['fabric', 'fabric', 'garment', 'garment', 'garment']);
    for (const list of [plan.catalog.customers, plan.catalog.suppliers, plan.catalog.fabricAssets, plan.catalog.garmentAssets]) expect(list).toHaveLength(35);
    expect(Object.values(plan.cast).every(actor => actor.password === null)).toBe(true);
    expect(plan.catalog.factories.fabric).toHaveLength(10); expect(plan.catalog.factories.garment).toHaveLength(15);
    expect(plan.catalog.factories.processing).toHaveLength(4);
    for (const asset of [...plan.catalog.fabricAssets, ...plan.catalog.garmentAssets]) {
      const customer = plan.catalog.customers.find(row => row.id === asset.customerRelationId)!;
      const factory = plan.catalog.suppliers.find(row => row.id === asset.factoryRelationId)!;
      expect(factory.teamKey).toBe(customer.teamKey);
      expect(factory.businessFamily).toBe(asset.businessFamily);
      expect(customer.businessFamily).toBe(asset.businessFamily);
    }
    expect(plan.catalog.suppliers.filter(row => !row.factoryProfileId).map(row => row.kind)).toEqual(['trims_supplier', 'service_provider', 'trims_supplier', 'service_provider', 'trims_supplier', 'service_provider']);
    expect(() => planScenarioMasterData({ ...options, namespace: '../current-db' })).toThrow('SCENARIO_NAMESPACE_INVALID');
    expect(() => planScenarioMasterData({ ...options, nowMs: NaN })).toThrow('SCENARIO_TIME_INVALID');
    await expect(seedScenarioMasterData(noDatabase, { ...options, mode: 'reset' as any })).rejects.toThrow('SCENARIO_MODE_INVALID');
  });

  it('provisions usable distinct logins and honest historical catalogs with no terminal business facts', async () => {
    const f = masterStore(), data = await seedScenarioMasterData(f.db, options);
    expect(f.rows('userAccount')).toHaveLength(22); expect(f.rows('userRole')).toHaveLength(21);
    expect(f.tables.userAccount.get('system')).toMatchObject({ status: 'disabled', email: null });
    expect(f.rows('userRole').some(row => row.userId === 'system')).toBe(false);
    expect(f.rows('relation').filter(row => row.category === 'Customer' && row.isOrganization)).toHaveLength(35);
    expect(f.rows('relation').filter(row => row.category === 'Supplier' && row.isOrganization)).toHaveLength(35);
    expect(f.rows('productAsset').filter(row => row.mainCategory === 'Fabric')).toHaveLength(35);
    expect(f.rows('productAsset').filter(row => row.mainCategory === 'Garment')).toHaveLength(35);
    const owner = f.tables.userAccount.get(data.cast.owner.id);
    expect(await bcrypt.compare(data.cast.owner.password!, owner.passwordHash)).toBe(true);
    expect(new Set(Object.values(data.cast).map(actor => actor.email)).size).toBe(21);
    expect(f.rows('productAsset').every(row => row.source === 'other' && row.sourceDetail.includes('historical-catalog-import')
      && !row.sourceDevelopmentCaseId && !row.sourceSampleBatchId && !row.sourceSampleVersionId && row.cost == null)).toBe(true);
    expect(f.rows('fabricProfile').every(row => row.stockQuantity == null && row.factoryMoqValue == null && row.stockStatus == null)).toBe(true);
    expect(f.rows('garmentProfile').every(row => row.confirmedDate == null && row.sampleVersion == null)).toBe(true);
    expect(f.rows('factoryProfile').every(row => !row.firstOrderAt && !row.totalOrders && !row.totalAmount && !row.qualityScore && !row.deliveryScore)).toBe(true);
    expect(data.catalog.locations.every(location => f.tables.warehouse.has(location.warehouseId))).toBe(true);
    for (const warehouse of f.rows('warehouse')) expect(f.tables.relation.get(warehouse.profile.custodianRelationId)?.isOrganization).toBe(true);
    expect([...f.touched].filter(model => /audit|invoice|payment|inspection|stock|sample|production|development|shipment/i.test(model))).toEqual([]);
  });

  it('gives each business group exactly its own seven customer and seven supplier follow-up grants', async () => {
    const f = masterStore(), data = await seedScenarioMasterData(f.db, options);
    for (const team of data.businessTeams) {
      const grants = f.rows('teamDataGrant').filter(row => row.teamId === team.id);
      expect(grants).toHaveLength(14); expect(grants.every(row => row.permission === 'read+followup')).toBe(true);
      expect(grants.map(row => row.entityId).sort()).toEqual([...team.customerIds, ...team.supplierIds].sort());
      expect(team.customerIds).toHaveLength(7); expect(team.supplierIds).toHaveLength(7);
      expect(f.rows('teamMember').filter(row => row.teamId === team.id).map(row => row.userId).sort()).toEqual(team.memberIds.slice().sort());
      expect(team.memberIds).not.toContain(data.cast.financeOperator.id); expect(team.memberIds).not.toContain(data.cast.logistics1.id);
      for (const foreign of data.businessTeams.filter(row => row.id !== team.id)) expect(grants.some(row => foreign.customerIds.includes(row.entityId))).toBe(false);
      expect(f.tables.team.get(team.id).metadata.businessFamily).toBe(team.businessFamily);
    }
    for (const team of data.professionalTeams) {
      const grants = f.rows('teamDataGrant').filter(row => row.teamId === team.id);
      expect(grants.every(row => row.permission === 'read')).toBe(true);
      expect(grants).toHaveLength(team.businessFamily === 'fabric' ? 28 : team.businessFamily === 'garment' ? 42 : 70);
      if (team.businessFamily) expect(grants.every(row => f.tables.relation.get(row.entityId).tags.includes(team.businessFamily))).toBe(true);
    }
    // Professional roles retain their actual canonical read scope. The explicit
    // shares above do not pretend to turn a configured all scope into team scope.
    expect(getDataScopeRule(data.cast.fabricQc.roleId, 'qc').kind).toBe('all');
    expect(getDataScopeRule(data.cast.financeOperator.roleId, 'finance').kind).toBe('all');
    expect(getDataScopeRule(data.cast.logistics1.roleId, 'shipping').kind).toBe('all');
    expect(getDataScopeRule(data.cast.fabric1Sales.roleId, 'orders').kind).toBe('team');
  });

  it('configures line-specific main approval and real department heads without inventing an approval or a payment', async () => {
    const f = masterStore(), data = await seedScenarioMasterData(f.db, options);
    const authority = f.rows('orderApprovalAuthority');
    expect(authority.filter(row => row.businessLine === 'fabric').map(row => row.userId).sort()).toEqual([data.cast.fabricManager.id, data.cast.owner.id].sort());
    expect(authority.filter(row => row.businessLine === 'garment').map(row => row.userId).sort()).toEqual([data.cast.garmentManager.id, data.cast.owner.id].sort());
    expect(data.cast.financeOperator.roleId).toBe(SYSTEM_ROLE_IDS.FINANCE);
    expect(data.cast.financeApprover.roleId).toBe(SYSTEM_ROLE_IDS.ADMIN);
    expect(data.cast.financeOperator.id).not.toBe(data.cast.financeApprover.id);
    expect(f.tables.department.get(data.cast.financeOperator.departmentId).headId).toBe(data.cast.financeApprover.id);
    expect(f.tables.department.get(data.cast.fabric1Sales.departmentId).headId).toBe(data.cast.fabricManager.id);
    expect(f.tables.department.get(data.cast.garment1Sales.departmentId).headId).toBe(data.cast.garmentManager.id);
    expect(Object.values(data.cast).some(actor => /采购员|仓管员|财务经理/.test(actor.name))).toBe(false);
  });

  it('replays masters without duplicates and refuses to restore subsequently withdrawn roles or sharing', async () => {
    const f = masterStore(), original = await seedScenarioMasterData(f.db, options);
    const counts = Object.fromEntries(Object.entries(f.tables).map(([name, rows]) => [name, rows.size]));
    const replay = await seedScenarioMasterData(f.db, options);
    expect(Object.fromEntries(Object.entries(f.tables).map(([name, rows]) => [name, rows.size]))).toEqual(counts);
    expect(replay.businessTeams).toEqual(original.businessTeams);
    const ownerPasswordHash = f.tables.userAccount.get(original.cast.owner.id).passwordHash;
    const grant = f.rows('teamDataGrant').find(row => row.teamId === original.businessTeams[0].id)!;
    grant.revokedAt = new Date('2026-10-08T00:19:00.000Z');
    await expect(seedScenarioMasterData(f.db, options)).rejects.toThrow('SCENARIO_GRANT_CHANGED');
    expect(f.tables.userAccount.get(original.cast.owner.id).passwordHash).toBe(ownerPasswordHash);
    expect(f.tables.teamDataGrant.get(grant.id).revokedAt).not.toBeNull();
    f.tables.teamDataGrant.get(grant.id).revokedAt = null;
    const operatorRole = f.rows('userRole').find(row => row.userId === original.cast.financeOperator.id)!;
    f.tables.userRole.delete(operatorRole.id);
    await expect(seedScenarioMasterData(f.db, options)).rejects.toThrow('SCENARIO_ACCOUNT_CHANGED');
    expect(f.rows('userRole').some(row => row.userId === original.cast.financeOperator.id)).toBe(false);
  });

  it('never takes over another account, approval roster or deliberately modified canonical permission', async () => {
    const collision = masterStore(), planned = planScenarioMasterData(options);
    await collision.db.userAccount.create({ data: { id: 'actual-identity', displayName: 'Keep me', email: planned.cast.owner.email } });
    await expect(seedScenarioMasterData(collision.db, options)).rejects.toThrow('SCENARIO_ID_COLLISION');
    expect(collision.rows('userAccount')).toEqual([expect.objectContaining({ id: 'actual-identity', displayName: 'Keep me' })]);
    expect(collision.rows('role')).toHaveLength(0);
    const policy = masterStore();
    await policy.db.orderApprovalAuthority.create({ data: { id: 'actual-policy', businessLine: 'fabric', active: true, userId: 'actual-manager', createdBy: 'actual-owner' } });
    await expect(seedScenarioMasterData(policy.db, options)).rejects.toThrow('SCENARIO_AUTHORITY_EXISTS');
    expect(policy.rows('orderApprovalAuthority')).toEqual([expect.objectContaining({ userId: 'actual-manager', active: true })]);
    expect(policy.rows('userAccount')).toHaveLength(0);
    const withdrawn = masterStore();
    await withdrawn.db.role.create({ data: { id: SYSTEM_ROLE_IDS.FINANCE, name: '财务', isSystem: true } });
    await expect(seedScenarioMasterData(withdrawn.db, options)).rejects.toThrow('SCENARIO_RBAC_NOT_CANONICAL');
    expect(withdrawn.rows('rolePermission')).toHaveLength(0); expect(withdrawn.rows('userAccount')).toHaveLength(0);
  });
});
