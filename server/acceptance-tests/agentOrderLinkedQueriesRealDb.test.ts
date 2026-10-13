/** Opt-in actual PG, registered Agent query and native human route comparison.
 * §10.4.2 BOM/PO follow Orders; DR-042 customer follow-up/shared anchor;
 * actual current module grant AND signed credential cap; sensitive:cost mask.
 * Synthetic server context is injected at the real dispatcher, not body input.
 * This does not prove complete Agent HTTP/model/company-role journeys. */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { createIdentityService } from '../src/agent/identity';
import { registerNewDomainQueryTools } from '../src/agent/newDomainQueryTools';
import { dispatchFromRegistry, type ToolExecutionContext } from '../src/agent/toolDispatchRegistry';
import { createProcurementRouter } from '../src/procurement/procurementRoute';
import { createBOMRouter } from '../src/bom/bomRoute';
import { createCustomsRouter } from '../src/customs/customsRoute';

let prisma: PrismaClient | undefined, counter = 0;
const prefix = `acceptance-agent-order-query-${randomUUID()}`, reviewerId = `${prefix}-reviewer`;
const scopes = ['procurement:read', 'bom:read', 'customs:read', 'products:read'];
function db() { if (!prisma) throw Error('Independent Agent read client not initialized'); return prisma; }
beforeAll(async () => {
  const { DATABASE_URL, BAMBOOK_ACCEPTANCE_SANDBOX: sandbox, BAMBOOK_ACCEPTANCE_DB_NAME: name,
    BAMBOOK_ACCEPTANCE_DB_DIR: directory, BAMBOOK_ACCEPTANCE_DB_PORT: port } = process.env;
  if (!DATABASE_URL || !sandbox || !name || !directory || !port) throw Error('Reviewed independent acceptance sandbox is required');
  const url = new URL(DATABASE_URL);
  expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/); expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1', 'localhost']).toContain(url.hostname); expect(url.pathname).toBe(`/${name}`); expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);
  expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox), 'postgres')); expect(process.env.BAMBOOK_NO_SCHEDULER).toBe('1');
  prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const identity = await db().$queryRaw<Array<{ name: string; directory: string; port: number }>>`
    SELECT current_database() AS name, current_setting('data_directory') AS directory, inet_server_port() AS port`;
  expect(identity, 'actual PG identity before ANY mutation').toEqual([{ name, directory, port: Number(port) }]);
  await db().userAccount.create({ data: { id: reviewerId, displayName: 'Synthetic independent customer follower', status: 'active' } });
  for (const roleId of ['sales', 'finance', 'owner']) {
    await db().role.upsert({ where: { id: roleId }, update: {}, create: { id: roleId, name: `Synthetic canonical ${roleId}`, isSystem: true } });
    expect(await db().rolePermission.count({ where: { roleId } }), 'no undisclosed default fixture grants').toBe(0);
  }
  registerNewDomainQueryTools();
});
afterAll(async () => { await prisma?.$disconnect(); });
async function fixture(label: string) {
  const id = `${prefix}-${++counter}-${label}`, userId = `${id}-user`, teamId = `${id}-team`, shareId = `${id}-share`;
  const customerIds = ['own', 'other', 'shared'].map(suffix => `${id}-customer-${suffix}`);
  const orderIds = ['own', 'other', 'shared'].map(suffix => `${id}-order-${suffix}`);
  await db().$transaction(async tx => {
    await tx.userAccount.create({ data: { id: userId, displayName: 'Synthetic Agent employee', status: 'active' } });
    await tx.userRole.create({ data: { id: `${id}-role`, userId, roleId: 'sales' } });
    for (const scope of scopes) await tx.userPermissionOverrides.create({ data: { id: `${id}-${scope}`, userId, scope,
      grantedBy: reviewerId, reason: 'Synthetic explicit query grant, not actual company role policy' } });
    for (const [index, customerId] of customerIds.entries()) {
      await tx.relation.create({ data: { id: customerId, name: customerId, category: 'Customer', type: 'Company', isOrganization: true,
        tags: [], contactInfo: '{}', lastInteraction: BigInt(1), ownerId: index === 0 ? userId : reviewerId, salesRepIds: [] } });
      const orderId = orderIds[index];
      await tx.order.create({ data: { id: orderId, poNumber: `${orderId}-number`, customer: customerId, product: 'Synthetic fabric',
        type: 'fabric', quantity: 3, status: 'Pending', dueDate: '2099-01-01', quoteAmount: 3, importedAt: BigInt(1),
        customerRelationId: customerId, ownerId: index === 1 ? userId : reviewerId } });
      await tx.purchaseOrder.create({ data: { id: `${id}-po-${index}`, poNumber: `${id}-PO-${index}`, orderId,
        status: 'Confirmed', currency: 'CNY', totalAmount: '987.4321', orderDate: '2099-01-01', createdAt: BigInt(index), updatedAt: BigInt(index) } });
      await tx.bOM.create({ data: { id: `${id}-bom-${index}`, bomNumber: `${id}-BOM-${index}`, orderId,
        description: 'Synthetic BOM', status: 'Confirmed', totalCost: '987.4321', profitAmount: '200.0000', profitMargin: '20.0000',
        totalMaterialCost: '900.0000', totalLaborCost: '80.0000', totalOverheadCost: '7.4321', createdAt: BigInt(index), updatedAt: BigInt(index),
        lines: { create: { id: `${id}-line-${index}`, lineNumber: 1, materialType: 'Main', description: 'Synthetic material', quantity: '1',
          unit: 'M', effectiveQty: '1', unitCost: '900', amount: '900', createdAt: BigInt(1), updatedAt: BigInt(1) } },
        costEstimates: { create: { id: `${id}-estimate-${index}`, costType: 'Labor', description: 'Synthetic labor', amount: '80', createdAt: BigInt(1), updatedAt: BigInt(1) } } } });
    }
    await tx.bOM.create({ data: { id: `${id}-bom-library`, bomNumber: `${id}-BOM-library`, description: 'Synthetic unlinked library BOM',
      status: 'Draft', createdAt: BigInt(0), updatedAt: BigInt(0) } });
    for (const shipment of ['multi', 'hidden']) await tx.shipment.create({ data: { id: `${id}-shipment-${shipment}`,
      shipmentNumber: `${id}-SHP-${shipment}`, type: 'Export', status: 'Draft', shippingMethod: 'Sea', orderId: orderIds[1],
      createdAt: BigInt(1), updatedAt: BigInt(1) } });
    for (const [index, [shipment, orderId]] of [['multi', orderIds[0]], ['multi', orderIds[1]], ['hidden', orderIds[1]]].entries()) {
      await tx.shipmentOrderAllocation.create({ data: { id: `${id}-allocation-${index}`, shipmentId: `${id}-shipment-${shipment}`,
        orderId, status: 'Planned', plannedQty: '1', unit: 'M', createdAt: BigInt(1), updatedAt: BigInt(1) } });
    }
    for (const [index, [name, orderId, shipmentId]] of [
      ['own', orderIds[0], null], ['other', orderIds[1], null], ['multi', null, `${id}-shipment-multi`],
      ['projection', orderIds[1], `${id}-shipment-multi`], ['hidden', null, `${id}-shipment-hidden`],
    ].entries()) {
      await tx.customsDeclaration.create({ data: { id: `${id}-declaration-${name}`, declarationNumber: `${id}-CD-${name}`,
        orderId, shipmentId, type: 'Export', status: 'Draft', createdAt: BigInt(index + 1), updatedAt: BigInt(index + 1) } });
    }
    for (const type of ['pioneer', 'ship', 'head']) await tx.sample.create({ data: { id: `${id}-sample-${type}`,
      code: `${id}-SMP-${type}`, type, sourceOrderId: orderIds[0], createdAt: BigInt(1), updatedAt: BigInt(1) } });
    await tx.taxRefund.create({ data: { id: `${id}-refund`, refundNumber: `${id}-TR`, orderId: orderIds[0], status: 'Draft',
      refundAmount: '13.0000', refundableRate: '13.0000', exportAmountFob: '100.0000', exportAmountFobCurrency: 'USD',
      createdAt: BigInt(1), updatedAt: BigInt(1) } });
    await tx.team.create({ data: { id: teamId, name: `${id}-team`, status: 'active' } });
    await tx.teamMember.create({ data: { id: `${id}-member`, teamId, userId } });
    await tx.teamDataGrant.create({ data: { id: shareId, teamId, entityType: 'relation', entityId: customerIds[2], permission: 'read', grantedBy: reviewerId } });
  });
  const token = await buildLoadedAuthTokenPayload(db(), await loadUserWithRoles(db(), userId));
  const actor = await createIdentityService().resolveActorContext({ ...token, authorizationLoaded: true });
  expect(actor.permissionsAuthoritative).toBe(true); expect(actor.permissionScopes).toEqual([...scopes].sort());
  return { id, userId, token, context: { actor } as ToolExecutionContext, teamId, shareId, orderIds, customerIds };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function query(f: Fixture, toolId: string, input: any = {}, context: ToolExecutionContext | undefined = f.context, client: any = db()) {
  const value = await dispatchFromRegistry(client, { toolId, input: { search: f.id, ...input } }, context);
  expect(value.hit).toBe(true); if (!value.hit) throw Error('Missing real registered query'); return value.result as any;
}
async function snapshot(f: Fixture) {
  return { orders: await db().order.findMany({ where: { id: { in: f.orderIds } }, orderBy: { id: 'asc' } }),
    purchases: await db().purchaseOrder.findMany({ where: { poNumber: { contains: f.id } }, include: { lines: true, receipts: true }, orderBy: { id: 'asc' } }),
    boms: await db().bOM.findMany({ where: { bomNumber: { contains: f.id } }, include: { lines: true, costEstimates: true }, orderBy: { id: 'asc' } }),
    declarations: await db().customsDeclaration.findMany({ where: { declarationNumber: { contains: f.id } }, orderBy: { id: 'asc' } }),
    allocations: await db().shipmentOrderAllocation.findMany({ where: { orderId: { in: f.orderIds } }, orderBy: { id: 'asc' } }),
    samples: await db().sample.findMany({ where: { sourceOrderId: { in: f.orderIds } }, orderBy: { id: 'asc' } }),
    refunds: await db().taxRefund.findMany({ where: { refundNumber: { contains: f.id } }, orderBy: { id: 'asc' } }),
    audits: await db().auditLog.findMany({ where: { actorId: f.userId }, orderBy: { id: 'asc' } }) };
}
function fault(modelName: string, queryMethod = modelName === 'userAccount' ? 'findFirst' : 'findMany') {
  let reached = false;
  const client = new Proxy(db(), { get(target, key) {
    if (key === modelName) return new Proxy(Reflect.get(target, key), { get(delegate, method) {
      if (method === queryMethod) return async () => {
        reached = true; return target.$queryRaw`SELECT "missing_agent_read_probe_column" FROM "UserAccount" LIMIT 1`;
      };
      const value = Reflect.get(delegate, method); return typeof value === 'function' ? value.bind(delegate) : value;
    } });
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { client, reached: () => reached };
}

describe.each(['purchase_orders.query', 'bom.query'])('real PG registered %s', toolId => {
  const suffix = toolId === 'bom.query' ? 'bom' : 'po';
  it('native human route and Agent list/count/detail honor actual customer plus shared anchors', async () => {
    const f = await fixture('human-comparison'), before = await snapshot(f);
    const app = express(); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
    app.use('/po', createProcurementRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
    app.use('/bom', createBOMRouter({ prisma: db(), requireAuth: true, apiKeys: new Set() }));
    const human = await request(app).get(`/${suffix}`).query({ search: f.id, limit: 1, offset: 1 })
      .set('Authorization', `Bearer ${createAuthService().signToken(f.token)}`);
    expect(human.status).toBe(200);
    const agent = await query(f, toolId, { limit: 1, offset: 1, actor: { userId: reviewerId, roles: ['owner'], permissions: ['*'] } });
    expect(agent.total).toBe(toolId === 'bom.query' ? 3 : 2);
    expect(agent.items.map((item: any) => item.id)).toEqual(human.body.items.map((item: any) => item.id));
    expect(agent.total).toBe(human.body.total);
    expect((await query(f, toolId, { id: `${f.id}-${suffix}-0` })).ok).toBe(true);
    expect((await query(f, toolId, { id: `${f.id}-${suffix}-1` })).errorCode).toBe('NOT_FOUND');
    expect(await snapshot(f)).toEqual(before);
  });
  it('actual grant/role withdrawal or signed limited owner cap denies before row read', async () => {
    const f = await fixture('revoked'), before = await snapshot(f);
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId }, data: { isActive: false } });
    await db().userRole.deleteMany({ where: { userId: f.userId } });
    await expect(query(f, toolId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId }, data: { isActive: true } });
    await db().userRole.create({ data: { id: `${f.id}-owner-role`, userId: f.userId, roleId: 'owner' } });
    await expect(query(f, toolId, {}, { actor: { ...f.context.actor!, permissionCeiling: ['orders:read'] } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await snapshot(f)).toEqual(before);
  });
  it('real share revocation/withdrawn customer follow-up is reflected without old read cache', async () => {
    const f = await fixture('share-revoke');
    expect((await query(f, toolId, { id: `${f.id}-${suffix}-2` })).ok).toBe(true);
    await db().teamDataGrant.update({ where: { id: f.shareId }, data: { revokedAt: new Date() } });
    expect((await query(f, toolId, { id: `${f.id}-${suffix}-2` })).errorCode).toBe('NOT_FOUND');
    await db().relation.update({ where: { id: f.customerIds[0] }, data: { ownerId: reviewerId } });
    expect((await query(f, toolId, { id: `${f.id}-${suffix}-0` })).errorCode).toBe('NOT_FOUND');
  });
  it('missing trusted server context is refused despite forged owner input', async () => {
    const f = await fixture('missing-context'), before = await snapshot(f);
    await expect(dispatchFromRegistry(db(), { toolId, input: { actor: f.context.actor, id: `${f.id}-${suffix}-0` } }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await snapshot(f)).toEqual(before);
  });
});

describe('real PG cost mask and resolver failure', () => {
  it('BOM detail/list/summary reuse sensitive mask and actual cost grant remains ceiling bounded', async () => {
    const f = await fixture('cost-mask'), before = await snapshot(f);
    const hidden = await query(f, 'bom.query', { id: `${f.id}-bom-0` });
    expect(hidden.item).toMatchObject({ totalCost: null, profitAmount: null, profitMargin: null, lines: [{ unitCost: null, amount: null }], costEstimates: [{ amount: null }] });
    expect(hidden.summary).not.toContain('987.4321');
    const list = await query(f, 'bom.query'); expect(list.items.every((item: any) => item.profitAmount == null && item.profitMargin == null && item.totalCost == null)).toBe(true);
    await db().userPermissionOverrides.create({ data: { id: `${f.id}-cost`, userId: f.userId, scope: 'sensitive:cost', grantedBy: reviewerId, reason: 'Synthetic explicit sensitive grant' } });
    const allowed = await query(f, 'bom.query', { id: `${f.id}-bom-0` });
    expect(Number(allowed.item.totalCost)).toBe(987.4321); expect(Number(allowed.item.lines[0].unitCost)).toBe(900);
    expect(allowed.summary).toContain('987.4321');
    const limited = await query(f, 'bom.query', { id: `${f.id}-bom-0` }, { actor: { ...f.context.actor!, permissionCeiling: scopes } });
    expect(limited.item.totalCost).toBeNull(); expect(limited.summary).not.toContain('987.4321');
    expect((await query(f, 'bom.query', { id: `${f.id}-bom-library` })).ok).toBe(true);
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(['userPermissionOverrides', 'teamMember', 'teamDataGrant', 'relation', 'order'])('actual failed %s SELECT cannot be silent empty success', async model => {
    const f = await fixture(`sql-${model}`), before = await snapshot(f), failed = fault(model);
    await expect(query(f, 'purchase_orders.query', {}, f.context, failed.client)).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' });
    expect(failed.reached()).toBe(true); expect(await snapshot(f)).toEqual(before);
  });
});


function customsApp(client: any = db()) {
  const app = express(); app.set('json replacer', (_key: string, value: any) => typeof value === 'bigint' ? value.toString() : value);
  app.use('/customs', createCustomsRouter({ prisma: client, requireAuth: true, apiKeys: new Set() })); return app;
}

describe('real PG Agent declarations Order/ShipmentAllocation and native human parity', () => {
  it('native V1 route and registered Agent count/page/detail permit actual multi-order allocation, not guessed source', async () => {
    const f = await fixture('declarations'), before = await snapshot(f), app = customsApp();
    const human = await request(app).get('/customs/declarations').query({ search: f.id, limit: 2, offset: 1 })
      .set('Authorization', `Bearer ${createAuthService().signToken(f.token)}`);
    expect(human.status).toBe(200);
    const agent = await query(f, 'customs.query_declarations', { limit: 2, offset: 1, actor: { userId: reviewerId, roles: ['owner'], permissions: ['*'] } });
    expect(agent.total).toBe(3); expect(agent.total).toBe(human.body.total);
    expect(agent.items.map((item: any) => item.id)).toEqual(human.body.items.map((item: any) => item.id));
    for (const name of ['own', 'multi', 'projection']) expect((await query(f, 'customs.query_declarations', { id: `${f.id}-declaration-${name}` })).ok).toBe(true);
    for (const name of ['other', 'hidden', 'missing']) expect((await query(f, 'customs.query_declarations', { id: `${f.id}-declaration-${name}` })).errorCode).toBe('NOT_FOUND');
    expect(await snapshot(f)).toEqual(before);
  });
  it('actual current grant withdrawal, capped owner and absent server actor cannot authorize forged input', async () => {
    const f = await fixture('declaration-grants'), before = await snapshot(f);
    await expect(dispatchFromRegistry(db(), { toolId: 'customs.query_declarations', input: { actor: f.context.actor } })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId, scope: 'customs:read' }, data: { isActive: false } });
    await expect(query(f, 'customs.query_declarations')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db().userPermissionOverrides.updateMany({ where: { userId: f.userId }, data: { isActive: true } });
    await db().userRole.update({ where: { id: `${f.id}-role` }, data: { roleId: 'owner' } });
    await expect(query(f, 'customs.query_declarations', {}, { actor: { ...f.context.actor!, permissionCeiling: ['bom:read'] } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await snapshot(f)).toEqual(before);
  });
  it('current real all-scope personnel remain usable, withdrawn follower changes the narrow source set', async () => {
    const f = await fixture('declaration-personnel');
    await db().userRole.update({ where: { id: `${f.id}-role` }, data: { roleId: 'finance' } });
    expect((await query(f, 'customs.query_declarations')).total).toBe(5);
    await db().userRole.update({ where: { id: `${f.id}-role` }, data: { roleId: 'sales' } });
    await db().relation.update({ where: { id: f.customerIds[0] }, data: { ownerId: reviewerId } });
    expect((await query(f, 'customs.query_declarations')).total).toBe(0);
    expect((await query(f, 'customs.query_declarations', { id: `${f.id}-declaration-projection` })).errorCode).toBe('NOT_FOUND');
  });
  it('actual inactive account cannot use still-signed current query context', async () => {
    const f = await fixture('declaration-inactive');
    await db().userAccount.update({ where: { id: f.userId }, data: { status: 'inactive' } });
    await expect(query(f, 'customs.query_declarations')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
  it('actual failed allocation SELECT is 503, never partial/empty success', async () => {
    const f = await fixture('declaration-alloc-fault'), before = await snapshot(f), injected = fault('shipmentOrderAllocation');
    await expect(query(f, 'customs.query_declarations', {}, f.context, injected.client)).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE', statusCode: 503 });
    expect(injected.reached()).toBe(true); expect(await snapshot(f)).toEqual(before);
  });
  it.each(['findMany', 'findFirst'])('actual declaration %s SQL failure has safe500 rather than counterfeit404', async method => {
    const f = await fixture(`declaration-${method}`), before = await snapshot(f), injected = fault('customsDeclaration', method);
    await expect(query(f, 'customs.query_declarations', method === 'findFirst' ? { id: `${f.id}-declaration-own` } : {}, f.context, injected.client))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500, message: '服务器内部错误，请稍后重试。' });
    expect(injected.reached()).toBe(true); expect(await snapshot(f)).toEqual(before);
  });
  it('native human detail distinguishes real missing404 from actual SQL500 without leaking source', async () => {
    const f = await fixture('declaration-human-error'), signed = `Bearer ${createAuthService().signToken(f.token)}`;
    const missing = await request(customsApp()).get(`/customs/declarations/${f.id}-missing`).set('Authorization', signed);
    expect(missing.status).toBe(404); expect(missing.body.error).toBe(`报关单 ${f.id}-missing 不存在`);
    const injected = fault('customsDeclaration', 'findFirst');
    const failed = await request(customsApp(injected.client)).get(`/customs/declarations/${f.id}-declaration-own`).set('Authorization', signed);
    expect(failed.status).toBe(500); expect(failed.body.error).toBe('服务器内部错误，请稍后重试。'); expect(injected.reached()).toBe(true);
  });
});


describe('real PG samples and refunds do not counterfeit empty/missing on source failure', () => {
  it.each(['fabric_shipment', 'early_production'])('sample %s returns actual rows and legitimate no-record result without writes', async mode => {
    const f = await fixture(`sample-${mode}`), before = await snapshot(f);
    const result = await query(f, 'samples.query', { mode, orderId: f.orderIds[0] });
    expect(result.ok).toBe(true); expect(result.items).toHaveLength(mode === 'early_production' ? 1 : 2);
    const empty = await query(f, 'samples.query', { mode, orderId: f.orderIds[1] });
    expect(empty).toMatchObject({ ok: true, items: [] }); expect(await snapshot(f)).toEqual(before);
  });
  it.each(['fabric_shipment', 'early_production', 'garment_rounds'])('sample %s actual failed SELECT is safe500, never successful zero rows', async mode => {
    const f = await fixture(`sample-sql-${mode}`), before = await snapshot(f);
    const injected = fault(mode === 'garment_rounds' ? 'developmentCase' : 'sample', mode === 'garment_rounds' ? 'findFirst' : 'findMany');
    await expect(query(f, 'samples.query', { mode, orderId: f.orderIds[0], caseId: `${f.id}-missing-case` }, f.context, injected.client))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500, message: '服务器内部错误，请稍后重试。' });
    expect(injected.reached()).toBe(true); expect(await snapshot(f)).toEqual(before);
  });
  it('actual missing garment source case remains explicit NOT_FOUND', async () => {
    const f = await fixture('missing-garment'), before = await snapshot(f);
    expect((await query(f, 'samples.query', { mode: 'garment_rounds', caseId: `${f.id}-missing-case` })).errorCode).toBe('NOT_FOUND');
    expect(await snapshot(f)).toEqual(before);
  });
  it('tax refund real row/empty list/missing detail retain their separate meanings', async () => {
    const f = await fixture('refund-truth'), before = await snapshot(f);
    const found = await query(f, 'customs.query_tax_refunds', { id: `${f.id}-refund` });
    expect(found.ok).toBe(true); expect(found.item.refundAmount).toBe(13); expect(found.summary).toContain('13%');
    expect(await query(f, 'customs.query_tax_refunds', { search: `${f.id}-absent` })).toMatchObject({ ok: true, items: [], total: 0 });
    expect((await query(f, 'customs.query_tax_refunds', { id: `${f.id}-missing-refund` })).errorCode).toBe('NOT_FOUND');
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(['findMany', 'findFirst'])('tax refund %s actual failed SELECT is safe500, never NOT_FOUND/successful empty', async method => {
    const f = await fixture(`refund-sql-${method}`), before = await snapshot(f), injected = fault('taxRefund', method);
    await expect(query(f, 'customs.query_tax_refunds', method === 'findFirst' ? { id: `${f.id}-refund` } : {}, f.context, injected.client))
      .rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500, message: '服务器内部错误，请稍后重试。' });
    expect(injected.reached()).toBe(true); expect(await snapshot(f)).toEqual(before);
  });
  it('native human refund detail real missing404 and failed SQL500 use accurate safe errors', async () => {
    const f = await fixture('refund-human-error'), signed = `Bearer ${createAuthService().signToken(f.token)}`;
    const missing = await request(customsApp()).get(`/customs/tax-refunds/${f.id}-missing-refund`).set('Authorization', signed);
    expect(missing.status).toBe(404); expect(missing.body.error).toBe(`退税记录 ${f.id}-missing-refund 不存在`);
    const injected = fault('taxRefund', 'findFirst');
    const failed = await request(customsApp(injected.client)).get(`/customs/tax-refunds/${f.id}-refund`).set('Authorization', signed);
    expect(failed.status).toBe(500); expect(failed.body.error).toBe('服务器内部错误，请稍后重试。'); expect(injected.reached()).toBe(true);
  });
});
