/** All stock facts use native HTTP; only master data/current authorization are fixture data. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthService } from '../src/auth/service';
import { buildLoadedAuthTokenPayload, loadUserWithRoles } from '../src/auth/tokenHelpers';
import { assertIsolatedAcceptanceDatabase } from './isolatedDatabase';
import { createGlobalBusinessHttpFixture, createReturnedDevelopmentSample, completeExactDevelopmentQc,
  requireHttpSuccess, type GlobalBusinessHttpFixture } from './globalBusinessFixtures';

const prisma = new PrismaClient({ datasources: { db: { url: process.env.BAMBOOK_ACCEPTANCE_DATABASE_URL
  ?? 'postgresql://acceptance_disabled:disabled@127.0.0.1:1/acceptance_disabled' } } });
let f: GlobalBusinessHttpFixture, loseMeterAck = false;
const room = '/api/v1/samples/room', e = encodeURIComponent;
const ok = requireHttpSuccess;
const metadata = (kind: 'garment' | 'fabric') => ({ version: 1, purpose: 'sales',
  sampleKind: kind === 'garment' ? 'sales_garment' : 'sales_stock_yardage', sourceType: 'supplier_recommend',
  sourceName: '真实供应商送来的独立实物', tags: [] });
const manual = (name: string, kind: 'garment' | 'fabric', extra: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(), name, cardType: kind, quantity: 1, unit: kind === 'garment' ? 'PC' : '米',
  ...(kind === 'fabric' ? { physicalLengthQty: '2.75' } : {}), location: '办公室北墙 / 架 B / 第 2 层',
  libraryMetadata: metadata(kind), ...extra,
});
async function currentItem(id: string) { return prisma.sampleCardItem.findUniqueOrThrow({ where: { id } }); }
async function stock(id: string) {
  const item = await currentItem(id);
  return { total: item.physicalLengthQty?.toString(), available: item.availableLengthQty?.toString(),
    quantity: item.quantity, availableQty: item.availableQty, status: item.status };
}
beforeAll(async () => {
  await assertIsolatedAcceptanceDatabase(prisma);
  const client = new Proxy({} as PrismaClient, { get(_target, key) {
    if (key === '$transaction') return async (...args: unknown[]) => {
      const run = prisma.$transaction as (...values: unknown[]) => Promise<unknown>;
      const result = await run.apply(prisma, args);
      if (loseMeterAck && (result as any)?.ok === true && (result as any)?.data?.loan?.meterRequestKey) {
        loseMeterAck = false; throw new Error('PRIVATE sample loan committed; original transport ACK lost');
      }
      return result;
    };
    const value = Reflect.get(prisma, key); return typeof value === 'function' ? value.bind(prisma) : value;
  } });
  f = await createGlobalBusinessHttpFixture(client, { prefix: `library-${randomUUID().slice(0, 8)}` });
}, 120_000);
afterAll(async () => { await f?.close(); await prisma.$disconnect(); });

describe.sequential('physical Sample Library continuous native HTTP and isolated PostgreSQL', () => {
  it('registers each garment piece once, permits similar independent objects, and preserves original registration identity', async () => {
    const name = `${f.prefix} 同规格的两件真实展示衣`, firstInput = manual(name, 'garment');
    const first = ok(await f.request('salesOwner', 'post', `${room}/items`, firstInput), 'register first actual garment', 201).item;
    const second = ok(await f.request('salesOwner', 'post', `${room}/items`, manual(name, 'garment')), 'register another actual garment', 201).item;
    expect(first.id).not.toBe(second.id); expect(first.code).not.toBe(second.code);
    expect([first, second]).toEqual([expect.objectContaining({ quantity: 1, availableQty: 1, batchId: null }),
      expect.objectContaining({ quantity: 1, availableQty: 1, batchId: null })]);
    const replay = ok(await f.request('salesOwner', 'post', `${room}/items`, firstInput), 'original registration replay', 201);
    expect(replay).toMatchObject({ created: false, item: { id: first.id, code: first.code } });
    expect((await f.request('salesOwner', 'post', `${room}/items`, { ...firstInput, name: `${name} changed` })).status).toBe(409);
    const count = await prisma.sampleCardItem.count({ where: { name } });
    expect((await f.request('salesOwner', 'post', `${room}/items`, manual(name, 'garment', { quantity: 2 }))).status).toBe(400);
    expect(await prisma.sampleCardItem.count({ where: { name } })).toBe(count);
    expect(await currentItem(first.id)).toMatchObject({ custodianUserId: f.actors.salesOwner.id,
      location: firstInput.location, receiptSnapshot: { kind: 'manual' }, devCaseId: null, sampleId: null, batchId: null });
    const moved = ok(await f.request('salesOwner', 'patch', `${room}/items/${e(first.id)}/library`,
      { location: '办公室 / 模特架 3' }), 'locate the exact first piece').item;
    expect(moved.location).toBe('办公室 / 模特架 3'); expect((await currentItem(second.id)).location).toBe(firstInput.location);
  }, 120_000);

  it('keeps decimal metre stock exact through lost ACK, concurrent partial return, original-loan completion and actual shipment', async () => {
    const input = manual(`${f.prefix} 2.75 米实物`, 'fabric');
    const item = ok(await f.request('salesOwner', 'post', `${room}/items`, input), 'register exact metre stock', 201).item;
    const borrow = { loanType: 'borrow', loanLength: '0.75', requestKey: randomUUID(),
      borrowerName: '实际借样同事', dueAt: Date.parse('2099-01-01T00:00:00Z') };
    loseMeterAck = true;
    expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/loans`, borrow)).status).toBe(500);
    const recovered = ok(await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/loans`, borrow), 'recover original committed metre loan', 201);
    expect(recovered.replayed).toBe(true); const loan = recovered.loan;
    expect(await prisma.sampleCardLoan.count({ where: { itemId: item.id } })).toBe(1);
    expect(await stock(item.id)).toMatchObject({ total: '2.75', available: '2' });
    const original = await prisma.sampleCardLoan.findUniqueOrThrow({ where: { id: loan.id } });
    const partial = { requestKey: randomUUID(), returnLength: '0.25', conditionNote: '第一段实际归还' };
    const returned = await Promise.all([f.request('salesOwner', 'post', `${room}/loans/${e(loan.id)}/return`, partial),
      f.request('salesOwner', 'post', `${room}/loans/${e(loan.id)}/return`, partial)]);
    returned.forEach(response => ok(response, 'same actual partial return'));
    expect(returned.map(response => response.body.replayed).sort()).toEqual([false, true]);
    expect(await stock(item.id)).toMatchObject({ total: '2.75', available: '2.25' });
    const partialLoan = await prisma.sampleCardLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(partialLoan.returnedAt).toBeNull(); expect(partialLoan.returnedLengthQty?.toString()).toBe('0.25');
    expect(partialLoan.lengthReturnHistory).toEqual([expect.objectContaining({ requestKey: partial.requestKey,
      length: '0.25', operatorId: f.actors.salesOwner.id })]);
    expect((await f.request('salesOwner', 'post', `${room}/loans/${e(loan.id)}/return`,
      { requestKey: randomUUID(), returnLength: '0.6' })).status).toBe(409);
    ok(await f.request('salesOwner', 'post', `${room}/loans/${e(loan.id)}/return`,
      { requestKey: randomUUID(), returnLength: '0.5', conditionNote: '余下实际归还' }), 'complete original metre loan');
    const completed = await prisma.sampleCardLoan.findUniqueOrThrow({ where: { id: loan.id } });
    expect(completed.returnedAt).not.toBeNull(); expect(completed.returnedLengthQty?.toString()).toBe('0.75');
    expect(completed).toMatchObject({ id: original.id, itemId: original.itemId, operatorId: original.operatorId,
      meterRequestKey: original.meterRequestKey, loanedAt: original.loanedAt, dueAt: original.dueAt });
    expect(completed.loanLength?.toString()).toBe('0.75'); expect(completed.lengthReturnHistory).toHaveLength(2);
    const dispatch = { requestKey: randomUUID(), shipLength: '0.5', recipientName: '实际客户收件处' };
    ok(await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, dispatch), 'ship exact metre stock', 201);
    expect(ok(await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, dispatch), 'replay original exact shipment', 201).replayed).toBe(true);
    expect(await stock(item.id)).toMatchObject({ total: '2.25', available: '2.25' });
    expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`,
      { ...dispatch, requestKey: randomUUID(), shipLength: '2.2501' })).status).toBe(409);
    const directory = ok(await f.request('salesOwner', 'get', `${room}/custody-directory?lane=fabric&search=${e(input.name)}&limit=50&offset=0`), 'read fractional physical library');
    expect(directory.directoryVersion).toBe(4);
    expect(JSON.stringify(directory.items)).toContain(item.id);
    expect(JSON.stringify(directory.items)).toContain('2.25');
    expect(await prisma.sampleCardLoan.count({ where: { itemId: item.id, loanType: 'ship' } })).toBe(1);
  }, 120_000);

  it('uses the same returned development objects and exact QC source without a second warehouse intake', async () => {
    const source = await createReturnedDevelopmentSample(f, { key: 'same-physical-objects', type: 'garment', quantity: 2 });
    const ids = [...source.physicalCardIds].sort();
    await completeExactDevelopmentQc(f, source);
    const library = ok(await f.request('salesOwner', 'get', `${room}/items?devCaseId=${e(source.caseId)}`), 'read shared returned garments');
    expect(library.items.map((item: { id: string }) => item.id).sort()).toEqual(ids);
    for (const id of ids) expect(await currentItem(id)).toMatchObject({ batchId: source.batchId, devCaseId: source.caseId,
      quantity: 1, availableQty: 1 });
    const before = await prisma.sampleCardItem.count({ where: { devCaseId: source.caseId } });
    expect((await f.request('salesOwner', 'post', `${room}/items`, manual('不能伪造同批次再次入库', 'garment',
      { batchId: source.batchId, devCaseId: source.caseId }))).status).toBe(400);
    expect(await prisma.sampleCardItem.count({ where: { devCaseId: source.caseId } })).toBe(before);
  }, 120_000);

  it('recovers counted custody with original commands across partial returns and terminal shipment', async () => {
    const input = manual(`${f.prefix} 三份实体面料样卡`, 'fabric', { quantity: 3, unit: '份',
      libraryMetadata: { ...metadata('fabric'), sampleKind: 'sales_card' } });
    delete input.physicalLengthQty;
    const item = ok(await f.request('salesOwner', 'post', `${room}/items`, input), 'register three counted physical portions', 201).item;
    const borrow = { requestKey: randomUUID(), loanType: 'borrow', loanQuantity: 2, borrowerName: '实际借样同事',
      dueAt: Date.parse('2099-01-01T00:00:00Z') };
    loseMeterAck = true;
    expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/loans`, borrow)).status).toBe(500);
    const recovered = ok(await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/loans`, borrow), 'recover original counted borrow', 201);
    expect(recovered.replayed).toBe(true);
    expect(recovered.loan).toMatchObject({ itemId: item.id, operatorId: f.actors.salesOwner.id, loanQuantity: 2,
      meterRequestKey: borrow.requestKey });
    expect(await stock(item.id)).toMatchObject({ quantity: 3, availableQty: 1 });
    const partial = { requestKey: randomUUID(), returnQuantity: 1, conditionNote: '第一份实际归还' };
    const returns = await Promise.all([f.request('salesOwner', 'post', `${room}/loans/${e(recovered.loan.id)}/return`, partial),
      f.request('salesOwner', 'post', `${room}/loans/${e(recovered.loan.id)}/return`, partial)]);
    returns.forEach(response => ok(response, 'concurrent original counted return'));
    expect(returns.map(response => response.body.replayed).sort()).toEqual([false, true]);
    expect(await stock(item.id)).toMatchObject({ quantity: 3, availableQty: 2 });
    expect((await f.request('salesOwner', 'post', `${room}/loans/${e(recovered.loan.id)}/return`,
      { requestKey: randomUUID(), returnQuantity: 2 })).status).toBe(409);
    ok(await f.request('salesOwner', 'post', `${room}/loans/${e(recovered.loan.id)}/return`,
      { requestKey: randomUUID(), returnQuantity: 1, conditionNote: '第二份实际归还' }), 'return remaining original portion');
    const ship = { requestKey: randomUUID(), shipQuantity: 3, recipientName: '实际接收客户' };
    loseMeterAck = true;
    expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, ship)).status).toBe(500);
    expect(await stock(item.id)).toMatchObject({ quantity: 0, availableQty: 0, status: 'shipped' });
    const replay = ok(await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, ship), 'recover original shipment after terminal stock', 201);
    expect(replay.replayed).toBe(true); expect(replay.archived).toBe(true);
    expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, { ...ship, shipQuantity: 2 })).status).toBe(409);
    expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, { ...ship, requestKey: randomUUID() })).status).toBe(409);
    expect(await prisma.sampleCardLoan.count({ where: { itemId: item.id, loanType: 'borrow' } })).toBe(1);
    expect(await prisma.sampleCardLoan.count({ where: { itemId: item.id, loanType: 'ship' } })).toBe(1);
  }, 120_000);

  it('rechecks the actual account, permission ceiling and physical owner before any library mutation', async () => {
    const item = ok(await f.request('salesOwner', 'post', `${room}/items`, manual(`${f.prefix} 权限真实实物`, 'fabric')), 'register scoped physical object', 201).item;
    const command = { requestKey: randomUUID(), shipLength: '0.5', recipientName: '实际接收人' };
    const original = await stock(item.id), loans = await prisma.sampleCardLoan.count({ where: { itemId: item.id } });
    expect([403, 404]).toContain((await f.request('salesOutsider', 'post', `${room}/items/${e(item.id)}/ship`, command)).status);
    const loaded = await buildLoadedAuthTokenPayload(prisma, (await loadUserWithRoles(prisma, f.actors.salesOwner.id))!);
    const limited = { ...f.actors.salesOwner, token: createAuthService().signToken({ ...loaded, permissionCeiling: ['products:read'] }) };
    expect((await f.request(limited, 'post', `${room}/items/${e(item.id)}/ship`, command)).status).toBe(403);
    const roles = await prisma.userRole.findMany({ where: { userId: f.actors.salesOwner.id } });
    try {
      await prisma.userRole.deleteMany({ where: { userId: f.actors.salesOwner.id } });
      expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, command)).status).toBe(403);
    } finally { await prisma.userRole.createMany({ data: roles }); }
    try {
      await prisma.userAccount.update({ where: { id: f.actors.salesOwner.id }, data: { status: 'disabled' } });
      expect((await f.request('salesOwner', 'post', `${room}/items/${e(item.id)}/ship`, command)).status).toBe(401);
    } finally { await prisma.userAccount.update({ where: { id: f.actors.salesOwner.id }, data: { status: 'active' } }); }
    expect(await stock(item.id)).toEqual(original); expect(await prisma.sampleCardLoan.count({ where: { itemId: item.id } })).toBe(loans);
  }, 120_000);
});
