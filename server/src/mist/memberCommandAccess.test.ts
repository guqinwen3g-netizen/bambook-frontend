import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as contract from '../shared/mistWorkspace';
import type { MistCommand } from '../shared/mistWorkspace';
import { MIST_READ_SECTIONS } from './access';
import { MistRepository } from './repository';
import { MistPrivateFiles } from './files';
import { MemoryMistDatabase, testActor, testAuthority } from './__tests__/support';

let directory: string, workspaceId: string, db: MemoryMistDatabase, repo: MistRepository;
let auth: ReturnType<typeof testAuthority>;
const now = '2026-10-14T04:00:00.000Z';
const actor = (id = 'other') => ({ ...testActor(id), roles: [], authorizationLoaded: true as const });
const execute = (command: MistCommand, requestId = command.type, subject = actor()) =>
  repo.execute(subject, workspaceId, { requestId, expectedRevision: db.workspaces.get(workspaceId).revision, command });

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'mist-member-commands-'));
  db = new MemoryMistDatabase(); auth = testAuthority();
  auth.users.get('owner')!.permissions = [...new Set(MIST_READ_SECTIONS.flatMap(section => section.permissions)), 'vouchers:write', 'invoices:write', 'invoices:reconcile'];
  auth.users.get('other')!.permissions = ['orders:read'];
  repo = new MistRepository(db, contract, new MistPrivateFiles(directory), auth.authorize, () => new Date(now));
  workspaceId = (await repo.create(actor('owner'), { name: '隔离权限回归', seed: 'empty' })).id;
  const state = db.workspaces.get(workspaceId).state;
  state.memberIds = ['other'];
  for (const [prefix, target] of [['visible', { view: 'orders/list', id: 'order' }], ['hidden', { view: 'payables', id: 'bill' }]] as const) {
    state.tasks.push({ id: prefix + '-task', title: prefix, due: '', done: false, kind: 'finance', target });
    state.notifications.push({ id: prefix + '-notice', title: prefix, body: '', at: now, target });
    state.calendar.push({ id: prefix + '-calendar', title: prefix, date: '2026-10-14', time: '10:00', note: '', target });
  }
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('共享提醒动作只能处理当前账号可见来源，不另造个人提醒模型', () => {
  for (const subject of ['other', 'owner']) {
    it.each([
      { type: 'notification.read', payload: { id: 'hidden-notice' } },
      { type: 'task.complete', payload: { id: 'hidden-task', done: true } },
      { type: 'calendar.save', payload: { id: 'hidden-calendar', title: '覆盖隐藏日程', date: '2026-10-14', time: '12:00', note: '' } },
    ] as MistCommand[])(`${subject} 知道隐藏 ID 也不能执行 $type`, async command => {
      auth.users.get(subject)!.permissions = ['orders:read'];
      const before = structuredClone(db.workspaces.get(workspaceId)), receipts = db.receipts.size;
      await expect(execute(command, 'hidden-attempt', actor(subject))).rejects.toMatchObject({ status: 404 });
      expect(db.workspaces.get(workspaceId)).toEqual(before);
      expect(db.receipts.size).toBe(receipts);
    });

    it(`${subject} 全部已读只改变可见通知，并可原样重放`, async () => {
      auth.users.get(subject)!.permissions = ['orders:read'];
      const input = { requestId: 'visible-read-all', expectedRevision: 0, command: { type: 'notification.readAll' as const, payload: {} } };
      const first = await repo.execute(actor(subject), workspaceId, input);
      const state = db.workspaces.get(workspaceId).state;
      expect(state.notifications.find((item: any) => item.id === 'visible-notice').readAt).toBe(now);
      expect(state.notifications.find((item: any) => item.id === 'hidden-notice').readAt).toBeUndefined();
      const replay = await repo.execute(actor(subject), workspaceId, input);
      expect(replay.replayed).toBe(true);
      expect(replay.workspace.revision).toBe(first.workspace.revision);
      expect(db.workspaces.get(workspaceId).state.notifications).toEqual(state.notifications);
    });
  }

  it('可见通知、任务、日程仍可办理，隐藏记录保持完整', async () => {
    const hidden = structuredClone(db.workspaces.get(workspaceId).state.calendar[1]);
    await execute({ type: 'notification.read', payload: { id: 'visible-notice' } });
    await execute({ type: 'task.complete', payload: { id: 'visible-task', done: true } });
    await execute({ type: 'calendar.save', payload: { id: 'visible-calendar', title: '可见日程更新', date: '2026-10-14', time: '12:00', note: '', target: { view: 'orders/list', id: 'order' } } });
    const state = db.workspaces.get(workspaceId).state;
    expect(state.tasks.find((item: any) => item.id === 'visible-task').done).toBe(true);
    expect(state.calendar.find((item: any) => item.id === 'visible-calendar').title).toBe('可见日程更新');
    expect(state.calendar.find((item: any) => item.id === 'hidden-calendar')).toEqual(hidden);
    expect(state.notifications.find((item: any) => item.id === 'hidden-notice').readAt).toBeUndefined();
  });

  it('不能借新建或修改可见日程关联无读取权限的来源', async () => {
    const before = structuredClone(db.workspaces.get(workspaceId)), receipts = db.receipts.size;
    for (const id of [undefined, 'visible-calendar']) {
      await expect(execute({ type: 'calendar.save', payload: { id, title: '隐藏财务来源', date: '2026-10-14', time: '12:00', note: '', target: { view: 'payables', id: 'bill' } } }, 'hidden-target-' + id)).rejects.toMatchObject({ status: 403 });
    }
    expect(db.workspaces.get(workspaceId)).toEqual(before);
    expect(db.receipts.size).toBe(receipts);
  });
});

function paymentFixture(reconcile = false) {
  auth.users.get('other')!.permissions = ['invoices:read', 'vouchers:read', 'vouchers:write', ...(reconcile ? ['invoices:reconcile'] : [])];
  const state = db.workspaces.get(workspaceId).state;
  state.fulfillment.purchases.push({ id: 'purchase', supplierId: 'supplier', supplier: '隔离供应商', state: 'approved', kind: 'material', currency: 'CNY', amount: 1000, terms: '合同付款条件', lines: [] });
  state.payables.bills.push({ id: 'bill', code: 'AP-TEST', supplierId: 'supplier', supplier: '隔离供应商', invoiceNo: 'VAT-TEST', invoiceDate: '2026-10-13', currency: 'CNY', amount: 1000, taxAmount: 0, taxRate: '', lines: [], terms: [], due: '2026-11-14', dueBasis: '合同付款条件', fileIds: [], note: '', state: 'open', registeredAt: now, registeredBy: 'owner' });
  // 所有付款须先有主管已批准的付款申请：票据付款申请带分配，预付款申请不带。
  const approved = { reviewerIds: ['manager'], requesterId: 'sales', requester: '业务', submittedAt: '2026-10-12T01:00:00.000Z', reason: '按合同付款', fileIds: [], snapshot: [], state: 'approved', paymentHistory: [], decision: { actorId: 'manager', actor: '主管', at: '2026-10-12T02:00:00.000Z', decision: 'approved', note: '同意' } };
  state.payables.requests = [
    { id: 'req-bill', code: 'PR-TEST-1', purpose: 'bill', supplierId: 'supplier', supplier: '隔离供应商', currency: 'CNY', amount: 600, lines: [{ billId: 'bill', billCode: 'AP-TEST', invoiceNo: 'VAT-TEST', amount: 600 }], ...approved },
    { id: 'req-pre', code: 'PR-TEST-2', purpose: 'prepayment', supplierId: 'supplier', supplier: '隔离供应商', currency: 'CNY', amount: 600, planId: 'plan', purchaseId: 'purchase', purchaseCode: 'PO-TEST', lines: [], ...approved },
  ];
}
const payment = (allocations?: Array<{ billId: string; amount: number }>): MistCommand => ({
  type: 'payable.payment.register',
  payload: { requestId: allocations?.length ? 'req-bill' : 'req-pre', date: '2026-10-13', amount: 600, reference: 'BANK-ISOLATED', allocations },
});
describe('供应商付款登记附带分配必须同时具有既有凭证写和核销权限', () => {
  it('只有付款登记权限不能附带分配，拒绝时款项、核销和回执均不改变', async () => {
    paymentFixture();
    const before = structuredClone(db.workspaces.get(workspaceId)), receipts = db.receipts.size;
    await expect(execute(payment([{ billId: 'bill', amount: 600 }]))).rejects.toMatchObject({ status: 403 });
    expect(db.workspaces.get(workspaceId)).toEqual(before);
    expect(db.receipts.size).toBe(receipts);
  });
  it.each([undefined, []])('没有核销权限仍可按已批准预付申请登记付款（不分配），分配参数为 %j', async allocations => {
    paymentFixture();
    await execute(payment(allocations));
    const state = db.workspaces.get(workspaceId).state;
    expect(state.payables.payments).toHaveLength(1);
    expect(state.payables.allocations).toEqual([]);
    expect(state.payments).toHaveLength(1);
  });
  it('同时有两项权限时原子登记和分配，重放不会重复计款，撤权后不能重放', async () => {
    paymentFixture(true);
    const input = { requestId: 'compound-payment', expectedRevision: 0, command: payment([{ billId: 'bill', amount: 600 }]) };
    const first = await repo.execute(actor(), workspaceId, input);
    const replay = await repo.execute(actor(), workspaceId, input);
    expect(replay.replayed).toBe(true);
    expect(replay.workspace.revision).toBe(first.workspace.revision);
    expect(db.workspaces.get(workspaceId).state.payables.allocations).toHaveLength(1);
    auth.users.get('other')!.permissions = ['invoices:read', 'vouchers:read', 'vouchers:write'];
    await expect(repo.execute(actor(), workspaceId, input)).rejects.toMatchObject({ status: 403 });
    expect(db.workspaces.get(workspaceId).state.payments).toHaveLength(1);
  });
  it('冲回付款会连带冲回分配，只有凭证写权限时拒绝且不改变任何记录', async () => {
    paymentFixture(true);
    await execute(payment([{ billId: 'bill', amount: 600 }]), 'pay-before-reverse');
    const paid = db.workspaces.get(workspaceId).state.payables.payments[0].id;
    auth.users.get('other')!.permissions = ['invoices:read', 'vouchers:read', 'vouchers:write'];
    const before = structuredClone(db.workspaces.get(workspaceId));
    await expect(execute({ type: 'payable.payment.reverse', payload: { supplierPaymentId: paid, reason: '流水录错' } } as MistCommand, 'reverse-no-reconcile')).rejects.toMatchObject({ status: 403 });
    expect(db.workspaces.get(workspaceId)).toEqual(before);
  });
  it('当前岗位有核销权限但会话权限上限不允许时仍拒绝复合动作', async () => {
    paymentFixture(true);
    const subject = { ...actor(), permissionCeiling: ['invoices:read', 'vouchers:read', 'vouchers:write'] };
    await expect(execute(payment([{ billId: 'bill', amount: 600 }]), 'ceiling', subject)).rejects.toMatchObject({ status: 403 });
    expect(db.workspaces.get(workspaceId).state.payments).toEqual([]);
  });
  it('事务末尾再次核验核销权限，期间撤权会完整回滚', async () => {
    paymentFixture(true);
    repo = new MistRepository(db, { ...contract, applyMistCommand: (...args) => {
      const applied = contract.applyMistCommand(...args);
      auth.users.get('other')!.permissions = ['invoices:read', 'vouchers:read', 'vouchers:write'];
      return applied;
    } }, new MistPrivateFiles(directory), auth.authorize, () => new Date(now));
    const before = structuredClone(db.workspaces.get(workspaceId)), receipts = db.receipts.size;
    await expect(execute(payment([{ billId: 'bill', amount: 600 }]))).rejects.toMatchObject({ status: 403 });
    expect(db.workspaces.get(workspaceId)).toEqual(before);
    expect(db.receipts.size).toBe(receipts);
  });
});