// Real PostgreSQL conversion segment. Starts at an Accepted quotation fixture;
// does not prove customer acceptance, HTTP authorization, approval policy or UI.
// Synthetic MOQ snapshots exercise inheritance, not company threshold policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createQuotationService } from '../src/quotations/quotationService';
import { summarizeOrderQuantity } from '../src/shared/orderQuantitySummary';

const acceptanceDatabaseUrl = process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL;
if (!acceptanceDatabaseUrl) throw Error('Dedicated isolated acceptance database URL is required');
const prisma = new PrismaClient({ datasources: { db: { url: acceptanceDatabaseUrl } } });
const conversionScopes = ['quotations:read', 'quotations:write', 'relations:read', 'relations:write'];
function verifiedConversion(actorId: string) {
  return { mode: 'verified_actor' as const, actor: { userId: actorId, roles: ['sales'], permissions: conversionScopes, permissionCeiling: conversionScopes } };
}
beforeAll(async()=>{
  const {BAMBOOK_ACCEPTANCE_SANDBOX:sandbox,BAMBOOK_ACCEPTANCE_DB_NAME:name,BAMBOOK_ACCEPTANCE_DB_DIR:directory,BAMBOOK_ACCEPTANCE_DB_PORT:port}=process.env;
  if(!sandbox||!name||!directory||!port)throw Error('Reviewed independent acceptance sandbox is required');
  const url=new URL(acceptanceDatabaseUrl);expect(name).toMatch(/^bambook_acceptance_[a-f0-9]+$/);expect(url.protocol).toBe('postgresql:');
  expect(['127.0.0.1','localhost']).toContain(url.hostname);expect(url.pathname).toBe('/'+name);expect(url.port).toBe(port);
  expect(path.basename(realpathSync(sandbox))).toMatch(/^bambook-acceptance-/);expect(realpathSync(directory)).toBe(path.join(realpathSync(sandbox),'postgres'));
  const actual=await prisma.$queryRaw<Array<{name:string;directory:string;port:number}>>`SELECT current_database() AS name,current_setting('data_directory') AS directory,inet_server_port() AS port`;
  expect(actual,'physical identity before any fixture mutation').toEqual([{name,directory,port:Number(port)}]);
});
afterAll(async () => { await prisma.$disconnect(); });

async function fixture(key: string, type: 'Fabric' | 'Garment') {
  const id = 'acceptance-quotation-' + key;
  const actorId = id + '-sales';
  const customerId = id + '-customer';
  const departmentId=id+'-department',caseId=id+'-case';
  const now = BigInt(Date.now());
  const snapshot = { fabricDefaultMoq: 800, garmentDefaultMoq: 200, capsuleMoq: 20,
    configId: null, source: 'fallback_constant', snapshotAt: '2026-10-01T00:00:00.000Z' };
  await prisma.department.create({data:{id:departmentId,name:'Synthetic sales department'}});
  await prisma.userAccount.create({ data: { id: actorId, displayName: 'Acceptance quotation sales', status: 'active',primaryDeptId:departmentId } });
  await prisma.role.upsert({where:{id:'role-sales'},create:{id:'role-sales',name:'Acceptance sales',isSystem:true},update:{}});
  await prisma.userRole.create({data:{id:actorId+'-sales-role',userId:actorId,roleId:'role-sales',departmentId}});
  for (const scope of conversionScopes) {
    const permission = await prisma.permission.upsert({where:{scope},create:{id:'acceptance-permission-'+scope.replaceAll(':','-'),scope},update:{}});
    await prisma.rolePermission.upsert({where:{roleId_permissionId:{roleId:'role-sales',permissionId:permission.id}},create:{id:'acceptance-role-scope-'+scope.replaceAll(':','-'),roleId:'role-sales',permissionId:permission.id},update:{}});
  }
  await prisma.relation.create({ data: { id: customerId, name: id, category: 'customer', type: 'company', ownerId: actorId,
    isOrganization: true, tags: [], contactInfo: '{}', lastInteraction: now } });
  await prisma.developmentCase.create({data:{id:caseId,code:caseId,name:'Synthetic source development',type:type.toLowerCase(),stage:'approved',customerRelationId:customerId,createdAt:now,updatedAt:now}});
  const lines = [
    { id: id + '-line-1', lineNumber: 1, description: 'Acceptance item A', fabricCode: id + '-A',
      quantity: 10000, unit: type === 'Fabric' ? 'M' : 'PC', unitPrice: '2.1250', amount: '21250.0000', notes: 'Customer specification A', createdAt: now },
    { id: id + '-line-2', lineNumber: 2, description: 'Acceptance item B', fabricCode: id + '-B',
      quantity: 12000, unit: type === 'Fabric' ? 'M' : 'PC', unitPrice: '3.2500', amount: '39000.0000', notes: null, createdAt: now },
  ];
  await prisma.quotation.create({ data: { id, quotationNumber: id, status: 'Accepted', currency: 'USD',
    totalAmount: '60250.0000', issueDate: '2026-10-01', validUntil: '2026-11-01', customerRelationId: customerId,
    customerName: id, customerCode: id + '-code', baseCurrency: 'CNY', deliveryTerms: 'FOB Shanghai',
    paymentTerms: 'As agreed', paymentInstrument: type === 'Fabric' ? 'L/C' : null,
    ownerId: actorId, developmentCaseId:caseId,moqSnapshot: snapshot, createdAt: now, updatedAt: now, lines: { create: lines } } });
  const otherQuotationId = id + '-other';
  await prisma.quotation.create({ data: { id: otherQuotationId, quotationNumber: otherQuotationId,
    status: 'Draft', currency: 'USD', totalAmount: 0, issueDate: '2026-10-01', createdAt: now, updatedAt: now } });
  const priorOrderId = id + '-prior-order';
  await prisma.order.create({ data: { id: priorOrderId, customer: id, product: 'Existing pricing association',
    type, quantity: 10000, status: 'Pending', dueDate: '2026-11-01', quoteAmount: 1 } });
  const pricing = (suffix: string, quotationId: string, orderId: string | null, deletedAt: bigint | null) => ({
    id: id + '-pricing-' + suffix, quotationId, orderId, deletedAt, status: 'Confirmed',
    purchaseCostCny: '10.5000', refundRate: '0.1300', exchangeRate: '7.0000', profitMargin: '0.1000',
    commissionRate: '0.0200', netUsdCost: '1.3050', profitAmount: '0.1305', commissionAmount: '0.0300',
    finalUnitPrice: '1.4655', createdAt: now, updatedAt: now,
  });
  const pricingRows = [pricing('eligible', id, null, null), pricing('deleted', id, null, now),
    pricing('linked', id, priorOrderId, null), pricing('other', otherQuotationId, null, null)];
  await prisma.pricingCalculation.createMany({ data: pricingRows });
  return { id, actorId, customerId,departmentId,caseId,type, snapshot, lines, priorOrderId, pricingRows };
}

// Both callers must observe the same unconverted row before either continues.
// The claim and all writes then use actual PG transactions/row locks.
function simultaneousReaders(id: string) {
  let reads = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const quotation = new Proxy(prisma.quotation, { get(target, key) {
    if (key === 'findUnique') return async (args: any) => {
      const row = await target.findUnique(args);
      if (args.where.id === id && args.include?.lines && reads < 2) {
        expect(row?.convertedOrderId).toBeNull();
        reads++;
        if (reads === 2) release();
        await ready;
      }
      return row;
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { client: new Proxy(prisma, { get(target, key) {
    if (key === 'quotation') return quotation;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } }), readCount: () => reads };
}

async function pricingState(id: string) {
  const rows = await prisma.pricingCalculation.findMany({ where: { id: { startsWith: id + '-pricing-' } }, orderBy: { id: 'asc' } });
  return rows.map(row => ({ ...row, orderId: null }));
}

describe('acceptance: real PG quotation conversion atomicity and data handoff', () => {
  it.each(['Fabric', 'Garment'] as const)('%s: simultaneous conversion creates one order and preserves quotation/pricing facts', async type => {
    const f = await fixture(type.toLowerCase(), type);
    const beforePricing = await pricingState(f.id);
    const parallel = simultaneousReaders(f.id);
    const service = createQuotationService(parallel.client);
    const results = await Promise.allSettled([
      service.convertToOrder(f.id, f.actorId, { type }, verifiedConversion(f.actorId)), service.convertToOrder(f.id, f.actorId, { type }, verifiedConversion(f.actorId)),
    ]);
    expect(parallel.readCount()).toBe(2);
    const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.convertToOrder>>> => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason.message).toContain('已转为订单');
    const orderId = winners[0].value.orderId;
    const quote = await prisma.quotation.findUniqueOrThrow({ where: { id: f.id }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { orderBy: { lineNumber: 'asc' } } } });
    expect(await prisma.order.count({ where: { poNumber: f.id } })).toBe(1);
    expect(quote.convertedOrderId).toBe(orderId);
    expect([quote.status, quote.totalAmount.toString(), quote.version]).toEqual(['Accepted', '60250', 1]);
    expect([order.customerRelationId, order.type, order.quantity?.toString(), order.currency, order.purchaseCurrency,
      order.quoteAmount.toString(), order.paymentInstrument, order.dueDate]).toEqual([
      f.customerId, type, '22000', 'USD', 'CNY', '60250', type === 'Fabric' ? 'L/C' : null, '2026-11-01',
    ]);
    expect(order.moqSnapshot).toEqual(f.snapshot);
    expect([order.sourceCaseId,order.ownerId,order.departmentId]).toEqual([f.caseId,f.actorId,f.departmentId]);
    expect(order.lines.every(line=>line.confirmedSourceId===null&&line.confirmedSourceType===null&&line.confirmedAt===null&&line.specSnapshot===null)).toBe(true);
    expect(order.lines.map(line => [line.lineNumber, line.materialCode, line.description, line.quantity.toString(),
      line.unit, line.unitPrice.toString(), line.netValue?.toString(), line.notes, line.moqOverride])).toEqual([
      [1, f.id + '-A', 'Acceptance item A', '10000', type === 'Fabric' ? 'M' : 'PC', '2.125', '21250', 'Customer specification A', null],
      [2, f.id + '-B', 'Acceptance item B', '12000', type === 'Fabric' ? 'M' : 'PC', '3.25', '39000', null, null],
    ]);
    const rows = await prisma.pricingCalculation.findMany({ where: { id: { startsWith: f.id + '-pricing-' } } });
    expect(Object.fromEntries(rows.map(row => [row.id.slice((f.id + '-pricing-').length), row.orderId]))).toEqual({
      eligible: orderId, deleted: null, linked: f.priorOrderId, other: null,
    });
    expect(await pricingState(f.id)).toEqual(beforePricing); // Every other persisted pricing/snapshot field is unchanged.
    expect(await prisma.entityLink.count({ where: { fromType: 'quotation', fromId: f.id, toType: 'order', toId: orderId, linkKind: 'convertedToOrder', status: 'active' } })).toBe(1);
    const audits = await prisma.auditLog.findMany({ where: { OR: [{ targetId: f.id }, { targetId: orderId }], action: { in: ['convert_quotation_to_order', 'create_order_from_quotation'] } } });
    expect(audits).toHaveLength(2);
    expect(audits.every(row => row.actorId === f.actorId)).toBe(true);
    await expect(service.convertToOrder(f.id, f.actorId, { type }, verifiedConversion(f.actorId))).rejects.toThrow('已转为订单');
    expect(await prisma.order.count({ where: { poNumber: f.id } })).toBe(1);
  });

  it.each(['M', 'YD'] as const)('exact fractional line quantities survive conversion; header %s behavior follows actual units', async secondUnit => {
    const f=await fixture('decimal-'+secondUnit,'Fabric');
    const firstLine=f.id+'-line-1',secondLine=f.id+'-line-2';
    await prisma.quotationLine.update({where:{id:firstLine},data:{quantity:'10000.125',unit:'M',unitPrice:'1.0000',amount:'10000.1250'}});
    await prisma.quotationLine.update({where:{id:secondLine},data:{quantity:'12000.5',unit:secondUnit,unitPrice:'1.0000',amount:'12000.5000'}});
    await prisma.quotation.update({where:{id:f.id},data:{totalAmount:'22000.6250'}});
    const converted=await createQuotationService(prisma).convertToOrder(f.id,f.actorId,{type:'Fabric'},verifiedConversion(f.actorId));
    const order=await prisma.order.findUniqueOrThrow({where:{id:converted.orderId},include:{lines:{orderBy:{lineNumber:'asc'}}}});
    expect(order.lines.map(line=>[line.quantity.toString(),line.unit])).toEqual([['10000.125','M'],['12000.5',secondUnit]]);
    const summary=summarizeOrderQuantity({activeOrderLines:order.lines.map(line=>({quantity:String(line.quantity),unit:line.unit}))});
    if(secondUnit==='M'){
      expect(summary).toMatchObject({state:'single_unit',quantity:'22000.625',unit:'M'});
      expect(order.quantity?.toString()).toBe('22000.625');expect(order.unit).toBe('M');
    }else{
      expect(summary).toMatchObject({state:'mixed_units',quantity:null,unit:null,groups:[{unit:'M',quantity:'10000.125'},{unit:'YD',quantity:'12000.5'}]});
      expect(order.quantity).toBeNull();expect(order.unit).toBeNull();
    }
  });

  it.each(['pricing', 'before-commit'] as const)('real SQL failure at %s rolls back the complete conversion; retry succeeds once', async point => {
    const f = await fixture('rollback-' + point, 'Fabric');
    const beforePricing = await prisma.pricingCalculation.findMany({ where: { id: { startsWith: f.id + '-pricing-' } }, orderBy: { id: 'asc' } });
    const absentActor = f.id + '-absent-audit-actor';
    expect(await prisma.userAccount.count({ where: { id: absentActor } })).toBe(0);
    let injected = false;
    let attemptedOrderId: string | undefined;
    const failSql = async (tx: any) => {
      injected = true;
      await tx.auditLog.create({ data: { id: f.id + '-injected-audit', actorId: absentActor,
        action: 'acceptance-injected-write-failure', targetType: 'Quotation', targetId: f.id } });
    };
    const client = new Proxy(prisma, { get(target, key) {
      if (key === '$transaction') return (callback: any) => target.$transaction(async tx => {
        const wrapped = new Proxy(tx, { get(inner, txKey) {
          if (txKey === 'order') return new Proxy(inner.order, { get(model, modelKey) {
            if (modelKey === 'create') return async (args: any) => { attemptedOrderId = args.data.id; return model.create(args); };
            const value = Reflect.get(model, modelKey); return typeof value === 'function' ? value.bind(model) : value;
          } });
          if (txKey === 'pricingCalculation' && point === 'pricing') return new Proxy(inner.pricingCalculation, { get(model, modelKey) {
            if (modelKey === 'updateMany') return async (args: any) => { const result = await model.updateMany(args); await failSql(tx); return result; };
            const value = Reflect.get(model, modelKey); return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(inner, txKey); return typeof value === 'function' ? value.bind(inner) : value;
        } });
        const result = await callback(wrapped);
        if (point === 'before-commit') {
          // Prove graph/audit writes really existed inside PG before triggering the failed final write.
          expect(await tx.entityLink.count({ where: { fromId: f.id, linkKind: 'convertedToOrder' } })).toBe(1);
          expect(await tx.auditLog.count({ where: { targetId: f.id, action: 'convert_quotation_to_order' } })).toBe(1);
          await failSql(tx);
        }
        return result;
      });
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(createQuotationService(client).convertToOrder(f.id, f.actorId, { type: 'Fabric' }, verifiedConversion(f.actorId))).rejects.toMatchObject({ code: 'P2003' });
    expect(injected).toBe(true);
    expect(attemptedOrderId).toBeDefined();
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: f.id } })).convertedOrderId).toBeNull();
    expect(await prisma.order.count({ where: { poNumber: f.id } })).toBe(0);
    expect(await prisma.orderLine.count({ where: { orderId: attemptedOrderId } })).toBe(0);
    expect(await prisma.productionStage.count({ where: { orderId: attemptedOrderId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { targetId: { in: [f.id, attemptedOrderId!] } } })).toBe(0);
    expect(await prisma.entityLink.count({ where: { OR: [{ fromId: f.id }, { fromId: attemptedOrderId }] } })).toBe(0);
    expect(await prisma.entityReference.count({ where: { OR: [{ ownerId: f.id }, { ownerId: attemptedOrderId }] } })).toBe(0);
    expect(await prisma.pricingCalculation.findMany({ where: { id: { startsWith: f.id + '-pricing-' } }, orderBy: { id: 'asc' } })).toEqual(beforePricing);
    const retry = await createQuotationService(prisma).convertToOrder(f.id, f.actorId, { type: 'Fabric' }, verifiedConversion(f.actorId));
    expect(await prisma.order.count({ where: { poNumber: f.id } })).toBe(1);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: f.id } })).convertedOrderId).toBe(retry.orderId);
    expect((await prisma.pricingCalculation.findUniqueOrThrow({ where: { id: f.id + '-pricing-eligible' } })).orderId).toBe(retry.orderId);
  });
  it.each(['missing-case','changed-customer','inactive-owner','source-query-fault'] as const)('%s blocks conversion without a partial order or claim',async point=>{
    const f=await fixture('source-'+point,'Garment');
    if(point==='missing-case')await prisma.developmentCase.update({where:{id:f.caseId},data:{deletedAt:BigInt(Date.now())}});
    if(point==='changed-customer')await prisma.developmentCase.update({where:{id:f.caseId},data:{customerRelationId:null}});
    if(point==='inactive-owner')await prisma.userAccount.update({where:{id:f.actorId},data:{status:'disabled'}});
    const client=point!=='source-query-fault'?prisma:new Proxy(prisma,{get(target,key){
      if(key==='$transaction')return(callback:any)=>target.$transaction(async tx=>callback(new Proxy(tx,{get(inner,k){
        if(k==='developmentCase')return new Proxy(inner.developmentCase,{get(model,m){
          if(m==='findFirst')return async()=>{await tx.$queryRawUnsafe('SELECT * FROM acceptance_nonexistent_conversion_source');};
          const v=Reflect.get(model,m);return typeof v==='function'?v.bind(model):v;
        }});
        const v=Reflect.get(inner,k);return typeof v==='function'?v.bind(inner):v;
      }})));
      const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
    }});
    if(point==='source-query-fault')await expect(createQuotationService(client).convertToOrder(f.id,f.actorId,undefined,verifiedConversion(f.actorId))).rejects.toThrow('acceptance_nonexistent_conversion_source');
    else if(point==='inactive-owner')await expect(createQuotationService(client).convertToOrder(f.id,f.actorId,undefined,verifiedConversion(f.actorId))).rejects.toMatchObject({code:'UNAUTHORIZED',statusCode:401});
    else await expect(createQuotationService(client).convertToOrder(f.id,f.actorId,undefined,verifiedConversion(f.actorId))).rejects.toMatchObject({code:'SOURCE_CHANGED',statusCode:409});
    expect((await prisma.quotation.findUniqueOrThrow({where:{id:f.id}})).convertedOrderId).toBeNull();
    expect(await prisma.order.count({where:{poNumber:f.id}})).toBe(0);
    expect(await prisma.auditLog.count({where:{targetId:f.id,action:'convert_quotation_to_order'}})).toBe(0);
    expect((await prisma.pricingCalculation.findUniqueOrThrow({where:{id:f.id+'-pricing-eligible'}})).orderId).toBeNull();
  });

});
