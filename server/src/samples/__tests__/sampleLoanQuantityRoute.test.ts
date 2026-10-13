/** Real router and custody service, synthetic storage only; no company DB. */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createSampleRouter } from '../sampleRoute';
import { authHeader } from '../../__tests__/authTestHelper';

function appFixture() {
  let item: any = { id: 'CARD', code: 'CARD', name: 'Physical custody', cardType: 'garment', quantity: 3, availableQty: 3, status: 'in_stock', deletedAt: null,createdAt:0n,updatedAt:0n,sampleId:null,devCaseId:null,orderId:null,batchId:null,productAssetId:null,warehouseId:null,receiptSnapshot:null };
  const loans: any[] = []; const audits: any[] = [];
  const user={id:'u_owner',status:'active',deletedAt:null,primaryDeptId:null,roles:[{departmentId:null,role:{id:'role-super-admin',permissions:['products:read','sample:room:write'].map(scope=>({permission:{scope}}))}}]};
  const tx: any = { userAccount:{findUnique:vi.fn(async()=>user),findFirst:vi.fn(async()=>user)},userPermissionOverrides:{findMany:vi.fn(async()=>[])}, $queryRaw: vi.fn(async () => [{ id: 'CARD' }]), sampleCardItem: {
    findFirst: vi.fn(async () => item),findUnique:vi.fn(async()=>item), update: vi.fn(async ({ data }: any) => { item = { ...item, ...data }; return item; }) },
    sampleCardLoan: { create: vi.fn(async ({ data }: any) => { const row={returnedAt:null,loanLength:null,...data};loans.push(row); return row; }), findMany: vi.fn(async ({where}:any={}) => loans.filter(l=>!where||Object.entries(where).every(([k,v])=>l[k]===v))) },
    auditLog: { create: vi.fn(async ({ data }: any) => { audits.push(data); return data; }) } };
  const prisma: any = { ...tx, $transaction: vi.fn(async (fn: any) => fn(tx)) }; const notify = vi.fn();
  const app = express(); app.use(express.json()); app.use('/api/v1/samples', createSampleRouter({ prisma, requireAuth: false, onDataChange: notify }));
  return { app, tx, loans, audits, notify, readItem: () => item };
}
describe('Custody loan quantity HTTP boundary', () => {
  it('recovers an original counted loan without deducting the same physical quantity twice', async () => {
    const f = appFixture(), body = { loanType: 'borrow', borrowerName: 'Actual borrower', loanQuantity: 1,
      requestKey: 'COUNTED-BORROW-ORIGINAL' };
    const first = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader()).send(body);
    const replay = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader()).send(body);
    expect(first.status).toBe(201); expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true, loan: { id: first.body.loan.id, meterRequestKey: body.requestKey } });
    expect(f.loans).toHaveLength(1); expect(f.audits).toHaveLength(1); expect(f.readItem().availableQty).toBe(2);
    const changed = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader()).send({ ...body, loanQuantity: 2 });
    expect(changed.status).toBe(409); expect(f.readItem().availableQty).toBe(2);
  });
  it('replays original counted shipment after terminal archive and refuses key reuse for another operation', async () => {
    const f = appFixture(), body = { shipQuantity: 3, recipientName: 'Actual recipient', requestKey: 'COUNTED-SHIP-ORIGINAL' };
    const first = await request(f.app).post('/api/v1/samples/room/items/CARD/ship').set(authHeader()).send(body);
    const replay = await request(f.app).post('/api/v1/samples/room/items/CARD/ship').set(authHeader()).send(body);
    expect(first.status).toBe(201); expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ replayed: true, loan: { id: first.body.loan.id }, archived: true });
    expect(f.readItem()).toMatchObject({ quantity: 0, availableQty: 0, status: 'shipped' });
    expect(f.loans).toHaveLength(1); expect(f.audits).toHaveLength(1);
    const changed = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader())
      .send({ loanType: 'viewing', loanQuantity: 1, borrowerName: 'Actual recipient', requestKey: body.requestKey });
    expect(changed.status).toBe(409); expect(f.loans).toHaveLength(1);
  });
  it('requires a stable counted stock request before any deduction', async () => {
    const f = appFixture(); const res = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader())
      .send({ loanType: 'borrow', borrowerName: 'Actual borrower', loanQuantity: 1 });
    expect(res.status).toBe(400); expect(f.loans).toHaveLength(0); expect(f.readItem().availableQty).toBe(3);
  });
  it.each([true, false, 2.5, null, '2', [2], {}, 0, -1, 9007199254740992])('refuses raw malformed quantity %j without custody or audit writes', async loanQuantity => {
    const f = appFixture(); const res = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader())
      .send({ loanType: 'borrow', borrowerName: 'Synthetic borrower', loanQuantity });
    expect(res.status).toBe(400); expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(f.loans).toHaveLength(0); expect(f.audits).toHaveLength(0); expect(f.tx.sampleCardItem.update).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled();
  });
  it('keeps omission as the existing one-unit default and accepts an explicit safe integer', async () => {
    const f = appFixture(); const first = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader()).send({ loanType: 'borrow', borrowerName: 'Borrower 1', requestKey: 'DEFAULT-ONE-UNIT' });
    expect(first.status).toBe(201); expect(f.loans[0].loanQuantity).toBe(1); expect(f.readItem().availableQty).toBe(2);
    const second = await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader()).send({ loanType: 'borrow', borrowerName: 'Borrower 2', loanQuantity: 2, requestKey: 'EXPLICIT-TWO-UNITS' });
    expect(second.status).toBe(201); expect(f.loans[1].loanQuantity).toBe(2); expect(f.readItem().availableQty).toBe(0);
  });
});


it('fresh DB grant withdrawal blocks a well-formed loan despite legacy owner JWT',async()=>{
  const f=appFixture(),user=await f.tx.userAccount.findUnique({where:{id:'u_owner'}});user.roles[0].role.permissions=[];
  const r=await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader()).send({loanType:'borrow',borrowerName:'Synthetic borrower',loanQuantity:1});
  expect(r.status).toBe(403);expect(r.body.error.code).toBe('FORBIDDEN');expect(f.loans).toHaveLength(0);expect(f.audits).toHaveLength(0);expect(f.readItem().availableQty).toBe(3);expect(f.notify).not.toHaveBeenCalled();
});
it('signed permission ceiling cannot restore room write from a cached owner role',async()=>{
  const f=appFixture(),token=jwt.sign({userId:'u_owner',roles:['owner'],permissions:['products:read','sample:room:write'],permissionCeiling:['products:read']},process.env.JWT_SECRET||'change-me-in-production-at-least-32-chars');
  const r=await request(f.app).post('/api/v1/samples/room/items/CARD/loans').set(authHeader(token)).send({loanType:'borrow',borrowerName:'Synthetic borrower',loanQuantity:1});
  expect(r.status).toBe(403);expect(f.loans).toHaveLength(0);expect(f.audits).toHaveLength(0);expect(f.readItem().availableQty).toBe(3);expect(f.notify).not.toHaveBeenCalled();
});
