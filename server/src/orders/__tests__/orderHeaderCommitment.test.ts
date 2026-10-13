import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../auth/permissionService', async importOriginal => ({ ...await importOriginal<typeof import('../../auth/permissionService')>(), createPermissionService: () => ({ getDataScopeResolver: async () => ({ rule: { kind:'all' } }) }) }));
vi.mock('../../teams/teamShareService', () => ({ createTeamShareService: () => ({ resolveVisibleRelationIds: async () => [] }) }));
vi.mock('../../sequence/sequenceService', () => ({ createSequenceService: () => ({}) }));
vi.mock('../../dictionaries/dataDictionaryService', () => ({ getDataDictionaryService: () => ({ getEntries: async () => [] }) }));
vi.mock('../../config/systemConfigService', () => ({ getSystemConfigService: () => ({}) }));
vi.mock('../../lib/logger', () => ({ logger:{ info:vi.fn(),warn:vi.fn(),error:vi.fn() } }));

import { createOrderServiceV2 } from '../orderServiceV2';

const actor = { userId:'business-1', roles:['merchandiser'], permissions:['orders:write'], departmentIds:[] };
function fixture(status = 'Confirmed') {
  const order = { id:'order-1',status,currency:'USD',paymentTerms:'TT',dueDate:'2026-12-01',customer:'Customer',
    product:'Fabric',quantity:new Prisma.Decimal(100),unit:'M',quoteAmount:new Prisma.Decimal(200),
    shipToName:'Receiver',shipToAddress1:'Original address',contactPerson:'Alice',contactPhone:'100',
    specialInstructions:'Original note',type:'Fabric',deletedAt:null,updatedAt:1n };
  const tx = { order:{ findUniqueOrThrow:vi.fn(async () => order),update:vi.fn(async ({data}) => ({ ...order,...data,lines:[] })) },
    approvalRequest:{ findFirst:vi.fn(async () => null) }, $queryRawUnsafe:vi.fn(async () => [{id:order.id}]),
    orderLine:{ findMany:vi.fn(async () => []) },auditLog:{ create:vi.fn(async ({data}) => data) } };
  const db = { order:{ findFirst:vi.fn(async () => order) },approvalRequest:tx.approvalRequest,
    $transaction:vi.fn(async fn => fn(tx)) };
  const user = { id:actor.userId, status:'active', deletedAt:null, primaryDeptId:'business', roles:[{roleId:'role-sales',
    role:{permissions:[{permission:{scope:'orders:write'}}]}}] };
  const auth = { userAccount:{findFirst:vi.fn(async () => user)},userPermissionOverrides:{findMany:vi.fn(async () => [])} };
  Object.assign(db,auth); Object.assign(tx,auth);
  const scoped = vi.fn(async () => tx.order.findUniqueOrThrow());
  Object.assign(tx.order,{findFirst:scoped});
  Object.assign(tx,{$queryRaw:vi.fn(async () => [{id:order.id}])});
  return { order,tx,db,user,auth,scoped,service:createOrderServiceV2(db as never) };
}

describe('approved main order commercial commitments', () => {
  it('requires original-order change approval instead of directly changing currency', async () => {
    const f = fixture();
    const result = await f.service.updateOrder(actor,'order-1',{ currency:'EUR' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('CONFLICT');
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });
  it.each([
    ['payment terms',{paymentTerms:'LC'}],
    ['consignee address',{shipToAddress1:'New address'}],
    ['contract quantity',{quantity:120}],
  ])('rejects direct formal-order changes to %s before any quantity side effects', async (_, patch) => {
    const f=fixture();
    const result=await f.service.updateOrder(actor,'order-1',patch);
    expect(result).toMatchObject({ok:false,error:{code:'CONFLICT'}});
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });
  it('allows a draft commercial edit', async () => {
    const f=fixture('Pending');
    const result=await f.service.updateOrder(actor,'order-1',{currency:'EUR'});
    expect(result.ok).toBe(true);
    expect(f.tx.order.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({currency:'EUR'})}));
  });
  it('keeps harmless contact and note edits available with actual field audit', async () => {
    const f=fixture();
    const result=await f.service.updateOrder(actor,'order-1',{contactPhone:'200',specialInstructions:'Call before loading'});
    expect(result.ok).toBe(true);
    expect(f.tx.auditLog.create).toHaveBeenCalled();
    const written=JSON.stringify(f.tx.auditLog.create.mock.calls);
    expect(written).toContain('100');
    expect(written).toContain('200');
    expect(written).toContain('Call before loading');
  });
  it('accepts unchanged commercial fields returned by a full editor', async () => {
    const f=fixture();
    const result=await f.service.updateOrder(actor,'order-1',{currency:'USD',quoteAmount:'200.0000',contactPhone:'200'});
    expect(result.ok).toBe(true);
  });
  it('rechecks the locked order if approval completed after the initial read', async () => {
    const f=fixture('Pending');
    f.tx.order.findUniqueOrThrow.mockResolvedValue({...f.order,status:'Confirmed'});
    const result=await f.service.updateOrder(actor,'order-1',{currency:'EUR'});
    expect(result).toMatchObject({ok:false,error:{code:'CONFLICT'}});
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });
  it('freezes notes as well while main approval is pending', async () => {
    const f=fixture('Pending');
    f.db.approvalRequest.findFirst.mockResolvedValue({id:'approval-1'} as never);
    const result=await f.service.updateOrder(actor,'order-1',{specialInstructions:'Changed during approval'});
    expect(result).toMatchObject({ok:false,error:{code:'CONFLICT'}});
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });
  it('reloads a revoked write grant before any business edit', async () => {
    const f=fixture('Pending'); f.user.roles[0].role.permissions=[];
    const result=await f.service.updateOrder(actor,'order-1',{contactPhone:'200'});
    expect(result).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });
  it('retains a restricted credential ceiling after reloading current grants', async () => {
    const f=fixture('Pending');
    const result=await f.service.updateOrder({...actor,permissionCeiling:['orders:read']},'order-1',{contactPhone:'200'});
    expect(result).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });
  it('rechecks source visibility after locking the original order', async () => {
    const f=fixture('Pending'); f.scoped.mockResolvedValueOnce(f.order).mockResolvedValueOnce(null as never);
    const result=await f.service.updateOrder(actor,'order-1',{contactPhone:'200'});
    expect(result).toMatchObject({ok:false,error:{code:'ORDER_NOT_FOUND'}});
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });
  it('rejects a grant revoked while waiting for the original order lock', async () => {
    const f=fixture('Pending');
    (f.tx as any).$queryRaw.mockImplementation(async () => { f.user.roles[0].role.permissions=[]; return [{id:f.order.id}]; });
    const result=await f.service.updateOrder(actor,'order-1',{contactPhone:'200'});
    expect(result).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
    expect(f.tx.order.update).not.toHaveBeenCalled();
  });
});
