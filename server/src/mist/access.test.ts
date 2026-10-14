import { describe, expect, it } from 'vitest';
import type { TokenPayload } from '../auth/service';
import { createMistState, type MistFile } from '../shared/mistWorkspace';
import { canReadFile, projectState, MIST_READ_SECTIONS } from './access';

const context = { id: () => 'test-record', now: '2026-10-14T00:00:00Z', actorName: '测试' };
const empty = () => createMistState(context, 'empty');
const actor = (permissions: string[], userId = 'member'): TokenPayload => ({ userId, roles: [], permissions, authorizationLoaded: true, departmentIds: [] } as TokenPayload);
const file = (id: string, uploadedBy?: string): MistFile => ({ id, name: id + '.pdf', mimeType: 'application/pdf', size: 10, storageKey: 'space/' + id, createdAt: context.now, uploadedBy });

describe('按已有业务查看权限投影，不因成员资格扩大权限', () => {
  it('所有业务集合都有明确读规则，未来增加集合不能静默开放给成员', () => {
    const state = empty(), paths = new Set(MIST_READ_SECTIONS.flatMap(section => section.paths.map(path => path.join('.'))));
    const shared = new Set(['schemaVersion', 'workspaceArchive', 'settings', 'files', 'events', 'tasks', 'notifications', 'calendar', 'reviewerIds', 'memberIds', 'members', 'memberLog']);
    for (const key of Object.keys(state).filter(key => !shared.has(key))) {
      if (['market', 'platform', 'fulfillment'].includes(key)) for (const child of Object.keys((state as any)[key])) expect(paths.has(key + '.' + child), key + '.' + child).toBe(true);
      else expect(paths.has(key), key).toBe(true);
    }
  });
  it('报价查看不能开放整组产品、供应商、营销或员工档案，原状态不被裁剪写回', () => {
    const state = empty();
    for (const key of Object.keys(state.market)) (state.market as any)[key] = [{ id: key }];
    state.platform.employees = [{ id: 'employee-private' }] as any;
    const original = structuredClone(state), result = projectState(state, actor(['quotations:read']), empty, 'owner');
    expect(result.state.market.quotations).toHaveLength(1);
    for (const key of Object.keys(state.market).filter(key => key !== 'quotations')) expect((result.state.market as any)[key]).toEqual([]);
    expect(result.state.platform.employees).toEqual([]);
    expect(result.hidden.map(section => section.key)).toContain('employees');
    expect(state).toEqual(original);
  });

  it('采购查看不能顺便开放库存、生产、质检或出运集合', () => {
    const state = empty();
    for (const key of Object.keys(state.fulfillment)) (state.fulfillment as any)[key] = [{ id: key }];
    const visible = projectState(state, actor(['procurement:read']), empty, 'owner').state;
    expect(visible.fulfillment.purchases).toHaveLength(1);
    expect(visible.fulfillment.receipts).toHaveLength(1);
    for (const key of Object.keys(state.fulfillment).filter(key => !['purchases', 'receipts'].includes(key))) expect((visible.fulfillment as any)[key]).toEqual([]);
  });

  it('仅有财务总览权限不能通过资金归属、事件和提醒绕过票款查看权限', () => {
    const state = empty();
    state.orderFunding = { assignments: [{ id: 'hidden-funding', amount: 8888 }] } as any;
    state.events = ['finance', 'invoice', 'payment', 'payable', 'orderFunding', 'unclassified-private'].map(entityType => ({ id: entityType, entityType, entityId: 'hidden', actor: '财务', at: context.now, text: '银行流水 SECRET-BANK', fileIds: [] }));
    state.tasks = [{ id: 'hidden-task', title: '付款 SECRET-BANK', due: '', done: false, kind: 'finance', target: { view: 'finance' } }] as any;
    state.notifications = [{ id: 'hidden-notice', title: '付款 SECRET-BANK', target: { view: 'payables' } }] as any;
    state.calendar = [{ id: 'hidden-calendar', title: '付款 SECRET-BANK', target: { view: 'funding' } }] as any;
    const visible = projectState(state, actor(['finance:read']), empty, 'owner').state;
    expect(visible.events).toEqual([]);
    expect(visible.tasks).toEqual([]);
    expect(visible.notifications).toEqual([]);
    expect(visible.calendar).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain('SECRET-BANK');
    expect(JSON.stringify(visible.orderFunding)).not.toContain('hidden-funding');
  });

  it('未引用的历史附件只给所有者；新上传的未引用附件只给上传人及所有者', () => {
    const state = empty();
    state.files = [file('legacy-unattached'), file('member-upload', 'member'), file('other-upload', 'other')];
    expect(projectState(state, actor(['*']), empty, 'owner').state.files.map(item => item.id)).toEqual(['member-upload']);
    expect(projectState(state, actor(['*'], 'owner'), empty, 'owner').state.files).toHaveLength(3);
    expect(canReadFile(state, actor(['*']), 'legacy-unattached', empty, 'owner')).toBe(false);
  });

  it('隐藏来源附件不可下载，近似文本不能重新开放；可见来源附件仍可使用', () => {
    const state = empty();
    state.files = [file('finance-file', 'member'), file('product-file', 'owner')];
    state.payables = { bills: [{ id: 'bill', fileIds: ['finance-file'] }], payments: [], allocations: [] } as any;
    state.devs = [{ id: 'dev', fileIds: ['product-file'], note: '前缀 finance-file 后缀' }] as any;
    const member = actor(['products:read']);
    expect(projectState(state, member, empty, 'owner').state.files.map(item => item.id)).toEqual(['product-file']);
    expect(canReadFile(state, member, 'finance-file', empty, 'owner')).toBe(false);
    expect(canReadFile(state, member, 'product-file', empty, 'owner')).toBe(true);
  });

  it('权限上限撤销查看权限后，即使原来有全部权限也仍会隐藏', () => {
    const state = empty();
    state.invoices = [{ id: 'private-invoice' }] as any;
    const subject = { ...actor(['*']), permissionCeiling: ['orders:read'] } as TokenPayload;
    expect(projectState(state, subject, empty, 'owner').state.invoices).toEqual([]);
  });
});