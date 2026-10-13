import { describe, it, expect, vi, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { getPersonalWorkbench } from '../workbenchService';
import { WorkflowEngine } from '../../workflow/workflowEngine';
import * as releaseSource from '../../production/releaseService';
/** Storage seam only. These controls run the real current permission, L2, workflow and allocation readers.
 * They do not prove PG isolation/locks or rendered/registered navigation. All mutation delegates refuse writes. */
function matches(row: any, where: any = {}): boolean {
    return Object.entries(where).every(([key, w]: [
        string,
        any
    ]) => {
        if (key === 'AND')
            return (Array.isArray(w) ? w : [w]).every(v => matches(row, v));
        if (key === 'OR')
            return w.some((v: any) => matches(row, v));
        const value = row[key] ?? null;
        if (w && typeof w === 'object' && !(w instanceof Date)) {
            if ('path' in w)
                return w.path.reduce((v: any, k: string) => v?.[k], value) === w.equals;
            if ('in' in w)
                return w.in.includes(value);
            if ('notIn' in w)
                return !w.notIn.includes(value);
            if ('array_contains' in w)
                return Array.isArray(value) && w.array_contains.every((id: string) => value.includes(id));
            if ('has' in w)
                return Array.isArray(value) && value.includes(w.has);
            if ('not' in w)
                return typeof w.not === 'object' && w.not !== null ? !matches({ [key]: value }, { [key]: w.not }) : value !== w.not;
            if ('startsWith' in w)
                return typeof value === 'string' && value.startsWith(w.startsWith);
            if ('gt' in w)
                return value > w.gt;
            return matches(value ?? {}, w);
        }
        return value === (w ?? null);
    });
}
const actor = { userId: 'me', roles: [] as any[], permissions: [] as string[], departmentIds: [] as string[] };
function storage(grants: string[] = [], roleIds = ['role-sales']) {
    const data: Record<string, any[]> = { userAccount: [{ id: 'me', displayName: 'Worker', status: 'active', deletedAt: null, primaryDeptId: null,
                roles: roleIds.map(roleId => ({ roleId, departmentId: null, role: { id: roleId, name: roleId, permissions: grants.map(scope => ({ permission: { scope } })) } })) }],
        userPermissionOverrides: [], teamMember: [], teamDataGrant: [], department: [], relation: [], fabricSearchTask: [], developmentSampleQualityReview:[], developmentSampleVersion:[], developmentCase: [], developmentLifecycleEvent: [], workAssignment: [], sample: [], sampleBatch: [], sealSample: [], costRecord: [], order: [], orderLine: [], qCAssignment: [], productionStage: [], shipment: [], shipmentOrderAllocation: [], quotation: [], inventoryItem: [], inventoryTransfer: [], invoice: [], invoiceAllocation: [], creditNoteAllocation: [], approvalRequest: [], claimCase: [], workflowInstance: [], workflowDefinition: [], workflowStep: [], auditLog: [], role: [] };
    const writes = vi.fn(() => { throw Error('Unexpected business write'); });
    const db: any = {};
    const decorate = (row: any, include: any) => row && include?.steps ? { ...row, steps: data.workflowStep.filter(s => s.instanceId === row.id), definition: data.workflowDefinition.find(d => d.id === row.definitionId), initiator: data.userAccount.find(u => u.id === row.initiatedById) } : row ?? null;
    for (const key of Object.keys(data))
        db[key] = {
            findFirst: vi.fn(async ({ where, include }: any = {}) => decorate(data[key].find(r => matches(r, where)), include)),
            findUnique: vi.fn(async ({ where, include }: any = {}) => decorate(data[key].find(r => matches(r, where)), include)),
            findMany: vi.fn(async ({ where, skip = 0, take, include }: any = {}) => data[key].filter(r => matches(r, where)).slice(skip, take === undefined ? undefined : skip + take).map(r => decorate(r, include))),
            count: vi.fn(async ({ where }: any = {}) => data[key].filter(r => matches(r, where)).length),
            create: writes, createMany: writes, update: writes, updateMany: writes, delete: writes, deleteMany: writes, upsert: writes,
        };
    db.$transaction = vi.fn(async (run: any) => run(db));
    db.$queryRaw = writes;
    db.$executeRaw = writes;
    return { db, data, writes };
}
/** Explicit live appointment, separate from role grants; never global/owner bypass. */
function assignDepartment(s:ReturnType<typeof storage>, attribute:string) {
  const department={id:`dept-${attribute}`,parentId:'company',status:'active',metadata:{businessAttributes:[attribute]}};
  s.data.department.push(department);
  s.data.userAccount[0].primaryDeptId=department.id;
  s.data.userAccount[0].primaryDepartment=department;
}
const group = async (s: ReturnType<typeof storage>, key: string, extra: any = {}) => (await getPersonalWorkbench(s.db, actor, { group: key, ...extra })).groups[0];
const customer = { id: 'c1', ownerId: 'me', salesRepIds: [], deletedAt: null };
const development = { id: 'd1', code: 'D-1', name: 'Native case', stage: 'developing', customerRelationId: 'c1', updatedAt: 12n, deletedAt: null, targetDate: null };
const rejectedOrderConfirmation = (overrides: Record<string, unknown> = {}) => ({
    id: 'rejected-oc', requesterId: 'me', reviewerId: 'reviewer', targetType: 'OrderConfirmation', targetId: 'o1',
    actionType: 'order:confirmation_sign', status: 'rejected', createdAt: new Date('2026-10-01T10:00:00.000Z'),
    decisionNote: '此内部退回意见不应展示', payload: { documentSnapshot: { data: { poNumber: 'PO-REWORK-1' } } }, ...overrides,
});
function seedReworkOrder(s: ReturnType<typeof storage>, overrides: Record<string, unknown> = {}) {
    assignDepartment(s,'fabric_business');
    s.data.relation.push(customer);
    s.data.order.push({ id: 'o1', customerRelationId: 'c1', status: 'Confirmed', deletedAt: null, ...overrides });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function nativeWorkflowFixture() {
    const s = storage(['orders:read', 'orders:write'], ['role-sales-manager']);
  assignDepartment(s,'fabric_business');
    const initiator = { ...s.data.userAccount[0], id: 'initiator', displayName: 'Initiator', roles: [{ roleId: 'role-sales', departmentId: null, role: { id: 'role-sales', name: 'Sales', permissions: ['orders:read', 'orders:write'].map(scope => ({ permission: { scope } })) } }] };
    s.data.userAccount.push(initiator);
    s.data.userRole = [];
    s.db.userRole = { findMany: async () => [] };
    s.data.relation.push({...customer,salesRepIds:['initiator']});
    s.data.order.push({ id: 'o1', ownerId: 'initiator', customerRelationId: 'c1', status: 'Pending', quantity: 10, currency: 'USD', quoteAmount: '100.0000', deletedAt: null });
    s.data.workflowDefinition.push({ id: 'wf-def', name: 'Native review', entityType: 'Order', isActive: true, version: 1, steps: [{ name: 'Original step', approverUserId: 'me' }] });
    // Run the real workflow creation producer against private in-memory storage.
    // The source locks here are storage seams, not evidence that PG locks were executed.
    s.db.$queryRaw = async () => [{ id: 'o1' }];
    s.db.workflowInstance.create = async ({ data }: any) => { const row = { ...data, createdAt: new Date(), updatedAt: new Date() }; s.data.workflowInstance.push(row); for (const step of data.steps.create)
        s.data.workflowStep.push({ ...step, instanceId: row.id }); return { ...row, steps: s.data.workflowStep.filter(step => step.instanceId === row.id), definition: s.data.workflowDefinition[0], initiator }; };
    s.db.auditLog.create = async ({ data }: any) => { s.data.auditLog.push(data); return data; };
    const created = await new WorkflowEngine(s.db).createInstance({ definitionId: 'wf-def', entityType: 'Order', entityId: 'o1', actor: { ...actor, userId: 'initiator' }, clientRequestId: 'native-private-workflow' });
    s.db.auditLog.create = s.writes;
    s.db.workflowInstance.create = s.writes;
    s.db.$queryRaw = s.writes;
    s.writes.mockClear();
    return { ...s, created };
}
describe('Personal workbench current authority and real source projection', () => {
    it.each([
        ['role-sales', 'follow-up'], ['role-qc', 'follow-up'], ['role-sales-manager', 'risk'],
    ])('keeps visible unsigned releases out of nonleader %s risk queues', async (roleId, bucket) => {
        const s = storage(['production:pp_release:business_sign'], [roleId]);
        vi.spyOn(releaseSource, 'pendingReleaseRequestActions').mockResolvedValue([{
            request: { id: 'r1', state: 'pending', updatedAt: '1', createdAt: '1' },
            scope: { id: 's1', orderId: 'o1', orderLineId: 'l1' }, line: { label: '面料' },
            canSign: false, allowedRoles: [], blockedReasons: ['尚未完成放行依据'],
        } as any]);
        const result = await group(s, 'approvals');
        expect(result).toMatchObject({ status: 'ready', total: 1, items: [{ bucket, responsibility: { kind: 'scope-visible', userId: null } }] });
        if (bucket === 'follow-up') expect(result.items?.[0]).toMatchObject({ blockedReason: null, reason: '等待领导处理放行申请' });
        else expect(result.items?.[0].blockedReason).toBe('尚未完成放行依据');
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('rejects absent identity without loading a company list', async () => { const s = storage(); await expect(getPersonalWorkbench(s.db, null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' }); expect(s.db.order.findMany).not.toHaveBeenCalled(); });
    it('rejects inactive stored identity rather than trusting token owner role', async () => { const s = storage(); s.data.userAccount[0].status = 'disabled'; await expect(getPersonalWorkbench(s.db, { ...actor, roles: ['owner'] })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' }); });
    it('current grants override stale token capabilities', async () => { const s = storage(); const r = await getPersonalWorkbench(s.db, { ...actor, roles: ['owner'], permissions: ['orders:read'] }, { group: 'orders' }); expect(r.groups[0]).toMatchObject({ status: 'forbidden', items: null, total: null }); expect(s.db.order.findMany).not.toHaveBeenCalled(); });
    it('a current technical SuperAdmin uses the canonical source-read shortcut', async () => { const s = storage([], ['role-super-admin']); expect(await group(s, 'invoices')).toMatchObject({ status: 'ready', total: 0 }); });
    it('retains the signed empty ceiling even for stored owner', async () => { const s = storage(['orders:read'], ['role-super-admin']); const r = await getPersonalWorkbench(s.db, { ...actor, permissionCeiling: [] }, { group: 'orders' }); expect(r.groups[0].status).toBe('forbidden'); });
    it('personal grants enable the genuine source for a custom role', async () => { const s = storage([], ['custom-sales']); s.data.userPermissionOverrides.push({ userId: 'me', scope: 'quotations:read', isActive: true, deletedAt: null, expiresAt: null }); s.data.quotation.push({ id: 'q1', status: 'Draft', ownerId: 'me', quotationNumber: 'QT-1', customerRelationId: null, deletedAt: null }); expect(await group(s, 'quotations')).toMatchObject({ status: 'ready', total: 1, items: [{ target: { kind: 'quotation', quotationId: 'q1' } }] }); });
    it('does not treat a custom role name as leadership', async () => { const s = storage(['orders:read'], ['custom-manager']); s.data.userAccount[0].roles[0].role.name = 'owner'; expect((await group(s, 'approvals')).status).toBe('forbidden'); });
    it('permission-storage failure is not an empty work queue', async () => { const s = storage(); s.db.userPermissionOverrides.findMany.mockRejectedValue(Error('raw SQL secret')); await expect(getPersonalWorkbench(s.db, actor)).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' }); });
    it('source-storage failure has null totals and safe retry text', async () => { const s = storage(['products:read']); s.db.developmentCase.findMany.mockRejectedValue(Error('raw SQL password')); expect(await group(s, 'development')).toMatchObject({ status: 'failed', items: null, total: null, error: { message: '这类事项暂时无法读取，请重试', retryable: true } }); });
    it('team storage failure cannot silently shrink to self or no tasks', async () => { const s = storage(['orders:read']); s.db.teamMember.findMany.mockRejectedValue(Error('team query fault')); expect(await group(s, 'orders')).toMatchObject({ status: 'failed', total: null }); });
    it('actual empty scoped source is the only ready zero', async () => { const s = storage(['products:read']); expect(await group(s, 'development')).toMatchObject({ status: 'ready', items: [], total: 0, hasMore: false }); });
    it('personal expense queue excludes other assignees and preserves exact native target', async () => { const s = storage(['products:read']); s.data.relation.push(customer); s.data.developmentCase.push(development); s.data.workAssignment.push(...['me', 'other'].map((userId, i) => ({ id: 'wa' + i, userId, title: '补费用', status: 'assigned', deletedAt: null, metadata: { managedBy: 'development_cost_closure', kind: 'billing_supplement', caseId: 'd1', billingItemId: 'b1', reason: '缺原凭据' } }))); expect(await group(s, 'development-expenses')).toMatchObject({ total: 1, items: [{ responsibility: { kind: 'assigned-to-me', userId: 'me' }, target: { kind: 'development', caseId: 'd1', section: 'fees', assignmentId: 'wa0', billingItemId: 'b1' } }] }); expect(s.writes).not.toHaveBeenCalled(); });
    it('removed customer sharing returns a restricted own task without leaking source labels', async () => { const s = storage(['products:read']); s.data.relation.push({ ...customer, ownerId: 'other' }); s.data.developmentCase.push({ ...development, name: 'SECRET' }); s.data.workAssignment.push({ id: 'wa1', userId: 'me', title: 'SECRET task', status: 'assigned', deletedAt: null, metadata: { managedBy: 'development_cost_closure', kind: 'billing_supplement', caseId: 'd1' } }); const r = await group(s, 'development-expenses'); expect(r.items?.[0]).toMatchObject({ title: '原案权限或来源已变化', target: null }); expect(JSON.stringify(r)).not.toContain('SECRET'); });
    it('development ownership free text is not treated as an account task assignment', async () => { const s = storage(['products:read']); s.data.relation.push(customer); s.data.developmentCase.push({ ...development, owner: 'me' }); expect((await group(s, 'development')).items?.[0].responsibility.kind).toBe('scope-visible'); });
    it('all sample source anchors must be visible, not merely one OR branch', async () => { const s = storage(['products:read', 'orders:read']); s.data.relation.push(customer, { ...customer, id: 'foreign', ownerId: 'other' }); s.data.developmentCase.push({ ...development, id: 'foreign-case', customerRelationId: 'foreign' }); s.data.order.push({ id: 'own-order', customerRelationId: 'c1', deletedAt: null }); s.data.sample.push({ id: 'sample1', code: 'SMP-1', sourceCaseId: 'foreign-case', sourceOrderId: 'own-order', customerRelationId: 'c1', status: 'making', deletedAt: null }); expect(await group(s, 'samples')).toMatchObject({ status: 'ready', total: 0 }); });
    it('QC own assignment remains readable through genuine assigned-parent path', async () => { const s = storage(['qc:read'], ['custom-qc']); s.data.order.push({ id: 'foreign-order', customerRelationId: 'foreign', deletedAt: null }); s.data.qCAssignment.push({ id: 'a1', qcUserId: 'me', orderId: 'foreign-order', status: 'Assigned', inspectionType: 'final', deletedAt: null, dueDate: null }); expect(await group(s, 'qc')).toMatchObject({ total: 1, items: [{ bucket: 'follow-up', target: { kind: 'qc-assignment', assignmentId: 'a1', orderId: 'foreign-order' } }] }); });
    it('QC execution actions require current professional appointment, inspect and exact chain scopes', async () => { const s = storage(['qc:read', 'qc:write', 'qc:inspect', 'qc:fabric_chain:write'], ['role-qc']); assignDepartment(s,'fabric_qc'); s.data.order.push({ id: 'o1', type:'Fabric', deletedAt: null }); s.data.qCAssignment.push({ id: 'a1', qcUserId: 'me', orderId: 'o1', status: 'InProgress', deletedAt: null }); expect((await group(s, 'qc')).items?.[0].bucket).toBe('action'); });
    it('deleted QC parent prevents an obsolete assigned task target', async () => { const s = storage(['qc:read'], ['role-qc']); s.data.order.push({ id: 'o1', deletedAt: 99n }); s.data.qCAssignment.push({ id: 'a1', qcUserId: 'me', orderId: 'o1', status: 'Assigned', deletedAt: null }); expect((await group(s, 'qc')).total).toBe(0); });
    it('approval queue uses actual reviewer and excludes self-approval and tool jobs', async () => { const s = storage([], ['role-sales-manager']); s.data.approvalRequest.push(...[{ id: 'p1', reviewerId: 'me', requesterId: 'other', actionType: 'order' }, { id: 'self', reviewerId: 'me', requesterId: 'me', actionType: 'order' }, { id: 'foreign', reviewerId: 'other', requesterId: 'other', actionType: 'order' }, { id: 'tool', reviewerId: 'me', requesterId: 'other', actionType: 'tool:execute' }].map(r => ({ ...r, status: 'pending' }))); expect(await group(s, 'approvals')).toMatchObject({ total: 1, items: [{ target: { kind: 'approval', approvalId: 'p1' } }] }); });
    it('extracts the signed document business number without leaking internal IDs or full remarks',async()=>{const s=storage([],['role-sales-manager']);s.data.approvalRequest.push({id:'opaque-approval',status:'pending',reviewerId:'me',requesterId:'other',actionType:'order:request-sign',targetType:'OrderConfirmation',targetId:'opaque-order',payload:{documentSnapshot:{data:{poNumber:'PO-2026-012'}},notes:'Long internal remarks'}});expect((await group(s,'approvals')).items[0]).toMatchObject({title:'订单确认书签署 · PO-2026-012',target:{kind:'approval',approvalId:'opaque-approval'}});});
    it('includes frozen main-order candidates without a legacy reviewer and excludes unrelated and decided records', async () => {
        const s = storage(['orders:read', 'orders:write'], ['owner']);
        const base = { reviewerId: null, requesterId: 'sales-other', actionType: 'order:main_approval', targetType: 'Order', targetId: 'o1', status: 'pending', eligibleReviewerIds: ['me'], createdAt: new Date() };
        s.data.approvalRequest.push({ ...base, id: 'eligible' }, { ...base, id: 'other', eligibleReviewerIds: ['another'] }, { ...base, id: 'self', requesterId: 'me' }, { ...base, id: 'done', status: 'approved' });
        const result = await group(s, 'approvals');
        expect(result).toMatchObject({ status: 'ready', total: 2 });
        expect(result.items?.map(item => item.source.id).sort()).toEqual(['eligible', 'self']);
        expect(result.items?.every(item => item.bucket === 'action' && item.target?.kind === 'approval')).toBe(true);
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('projects an applicant own rejected Order Confirmation for a non-manager Sales user with current order scopes', async () => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation());
        const result = await group(s, 'approvals');
        expect(result).toMatchObject({ status: 'ready', total: 1, items: [{ kind: 'approval-rework', bucket: 'action', responsibility: { kind: 'assigned-to-me', userId: 'me' }, target: { kind: 'approval', approvalId: 'rejected-oc' }, title: '订单确认书签署 · PO-REWORK-1', reason: '待修改并重新提交', dueDate: null, timeBucket: 'undated' }] });
        expect(JSON.stringify(result)).not.toContain('此内部退回意见不应展示');
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('does not expose an applicant rework action without current orders:write', async () => {
        const s = storage(['orders:read'], ['role-sales']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation());
        expect(await group(s, 'approvals')).toMatchObject({ status: 'forbidden', items: null, total: null });
        expect(s.db.approvalRequest.findMany).not.toHaveBeenCalled();
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('does not add an applicant self-approval pending record to rework or the legacy reviewer queue', async () => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales-manager']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation(), { id: 'own-pending', requesterId: 'me', reviewerId: 'me', targetType: 'OrderConfirmation', targetId: 'unrelated-order', actionType: 'order:confirmation_sign', status: 'pending', createdAt: new Date('2026-10-01T10:00:00.000Z') });
        expect(await group(s, 'approvals')).toMatchObject({ total: 1, items: [{ kind: 'approval-rework', target: { kind: 'approval', approvalId: 'rejected-oc' } }] });
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('does not project another applicant rejected Order Confirmation', async () => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation({ requesterId: 'another-sales' }));
        expect(await group(s, 'approvals')).toMatchObject({ status: 'ready', total: 0, items: [] });
        expect(s.writes).not.toHaveBeenCalled();
    });
    it.each(['pending', 'approved', 'cancelled', 'voided'])('a later %s native request supersedes the old rejection regardless of requester', async status => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation(), { id: `later-${status}`, requesterId: 'different-requester', reviewerId: 'reviewer', targetType: 'OrderConfirmation', targetId: 'o1', actionType: 'order:confirmation_sign', status, createdAt: new Date('2026-10-01T10:00:00.001Z') });
        expect(await group(s, 'approvals')).toMatchObject({ status: 'ready', total: 0, items: [] });
        expect(s.writes).not.toHaveBeenCalled();
    });
    it.each(['pending', 'approved'])('an equal-millisecond %s request suppresses the ambiguous rejection without ID ordering', async status => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation({ id: 'z-rejected' }), { id: 'a-other', requesterId: 'different-requester', targetType: 'OrderConfirmation', targetId: 'o1', actionType: 'order:confirmation_sign', status, createdAt: new Date('2026-10-01T10:00:00.000Z') });
        expect(await group(s, 'approvals')).toMatchObject({ status: 'ready', total: 0, items: [] });
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('keeps an equal-millisecond cancelled request ambiguous rather than inventing chronology', async () => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation({ id: 'z-rejected' }), { id: 'a-other', requesterId: 'different-requester', targetType: 'OrderConfirmation', targetId: 'o1', actionType: 'order:confirmation_sign', status: 'cancelled', createdAt: new Date('2026-10-01T10:00:00.000Z') });
        expect(await group(s, 'approvals')).toMatchObject({ status: 'ready', total: 1, items: [{ target: { kind: 'approval', approvalId: 'z-rejected' } }] });
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('excludes deleted, cancelled, and out-of-L2-scope original orders', async () => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales']);
        assignDepartment(s,'fabric_business');
        s.data.relation.push(customer, { ...customer, id: 'foreign', ownerId: 'other' });
        s.data.order.push({ id: 'deleted-order', customerRelationId: 'c1', status: 'Confirmed', deletedAt: 1n }, { id: 'cancelled-order', customerRelationId: 'c1', status: 'Canceled', deletedAt: null }, { id: 'foreign-order', customerRelationId: 'foreign', status: 'Confirmed', deletedAt: null });
        s.data.approvalRequest.push(rejectedOrderConfirmation({ id: 'deleted-rejection', targetId: 'deleted-order' }), rejectedOrderConfirmation({ id: 'cancelled-rejection', targetId: 'cancelled-order' }), rejectedOrderConfirmation({ id: 'foreign-rejection', targetId: 'foreign-order' }));
        expect(await group(s, 'approvals')).toMatchObject({ status: 'ready', total: 0, items: [] });
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('reports rework source read failures as failed instead of an empty queue', async () => {
        const s = storage(['orders:read', 'orders:write'], ['role-sales']); seedReworkOrder(s);
        s.data.approvalRequest.push(rejectedOrderConfirmation());
        s.db.order.findMany.mockRejectedValue(Error('order scope source fault'));
        expect(await group(s, 'approvals')).toMatchObject({ status: 'failed', items: null, total: null, error: { retryable: true } });
        expect(s.writes).not.toHaveBeenCalled();
    });
    it('a signed empty ceiling also refuses the role-based approval inbox', async () => { const s = storage([], ['role-sales-manager']); const r = await getPersonalWorkbench(s.db, { ...actor, permissionCeiling: [] }, { group: 'approvals' }); expect(r.groups[0].status).toBe('forbidden'); });
    it('order risks are actual due dates and blocked facts; no missing stage self-heal', async () => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 2, 1)); const s = storage(['orders:read']); s.data.relation.push(customer); s.data.order.push({ id: 'o1', poNumber: 'PO1', status: 'Confirmed', dueDate: '2026-10-02', customerRelationId: 'c1', deletedAt: null }, { id: 'o2', status: 'Confirmed', dueDate: '2026-12-01', customerRelationId: 'c1', deletedAt: null }); const r = await group(s, 'orders'); expect(r).toMatchObject({ total: 1, items: [{ dueDate: '2026-10-02', timeBucket: 'today' }] }); expect(s.writes).not.toHaveBeenCalled(); });
    it('blocked production directs to the exact original order production context', async () => { const s = storage(['orders:read']); s.data.relation.push(customer); s.data.order.push({ id: 'o1', status: 'Confirmed', customerRelationId: 'c1', deletedAt: null }); s.data.productionStage.push({ id: 'st1', orderId: 'o1', status: 'blocked' }); expect((await group(s, 'orders')).items?.[0].target).toEqual({ kind: 'order', orderId: 'o1', section: 'production' }); });
    it('shipment visibility includes real multi-order allocation without requiring primary order match', async () => { const s = storage(['shipments:read']); s.data.relation.push(customer); s.data.order.push({ id: 'own-order', customerRelationId: 'c1', deletedAt: null }); s.data.shipment.push({ id: 'ship1', orderId: 'foreign-order', shipmentNumber: 'SHP1', status: 'Booked', deletedAt: null }); s.data.shipmentOrderAllocation.push({ shipmentId: 'ship1', orderId: 'own-order' }); expect((await group(s, 'shipments')).items?.[0].target).toEqual({ kind: 'shipment', shipmentId: 'ship1', section: 'packing' }); });
    it('stock alerts use exact native quantities and actual stock scope', async () => { const s = storage(['orders:read']); s.data.inventoryItem.push({ id: 'stock1', orderId: null, quantity: new Prisma.Decimal('90071992547409.0001'), minStock: new Prisma.Decimal('90071992547409.0002'), description: 'Fabric', unit: 'M', deletedAt: null }); expect(await group(s, 'inventory')).toMatchObject({ total: 1, items: [{ reason: '实际库存 90071992547409.0001 M 低于原预警线 90071992547409.0002 M' }] }); });
    it('AR balance sums receipt and credit note allocations using exact Decimal', async () => { const s = storage(['invoices:read'], ['role-finance']); s.data.invoice.push({ id: 'i1', invoiceNumber: 'INV1', status: 'Issued', amount: new Prisma.Decimal('90071992547409.0003'), currency: 'USD', type: 'Receivable', deletedAt: null }); s.data.invoiceAllocation.push({ invoiceId: 'i1', appliedAmount: new Prisma.Decimal('90071992547409.0001') }); s.data.creditNoteAllocation.push({ invoiceId: 'i1', appliedAmount: new Prisma.Decimal('0.0001') }); expect((await group(s, 'invoices')).items?.[0].amounts).toEqual([{ amount: '0.0001', currency: 'USD', meaning: '未核销金额', visibility: 'visible' }]); expect(s.writes).not.toHaveBeenCalled(); });
    it('absence of the credit note store is unknown and cannot invent zero applied amount', async () => { const s = storage(['invoices:read'], ['role-finance']); delete s.db.creditNoteAllocation; expect(await group(s, 'invoices')).toMatchObject({ status: 'failed', items: null, total: null }); });
    it('does not promote a JS numeric financial amount to false exact storage', async () => { const s = storage(['invoices:read'], ['role-finance']); s.data.invoice.push({ id: 'i1', status: 'Draft', amount: 0.1, deletedAt: null }); expect((await group(s, 'invoices')).status).toBe('failed'); });
    it('source filtering precedes count and paging', async () => { const s = storage(['products:read']); s.data.relation.push(customer, { ...customer, id: 'foreign', ownerId: 'other' }); s.data.developmentCase.push({ ...development, id: 'visible1' }, { ...development, id: 'visible2' }, { ...development, id: 'foreign1', customerRelationId: 'foreign' }); const first = await group(s, 'development', { limit: 1 }); expect(first.total).toBe(2); expect(first.hasMore).toBe(true); const second = await group(s, 'development', { limit: 1, cursor: first.nextCursor }); expect(second.total).toBe(2); expect(second.items?.[0].source.id).not.toBe(first.items?.[0].source.id); expect(second.hasMore).toBe(false); });
    it('cross-group cursor and fractional limit cannot broaden a read', async () => { const s = storage(); await expect(getPersonalWorkbench(s.db, actor, { group: 'orders', cursor: Buffer.from(JSON.stringify({ group: 'invoices', offset: 0 })).toString('base64url') })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); await expect(getPersonalWorkbench(s.db, actor, { limit: 1.5 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); });
    it('native workflow read storage failure is a failed group, never a fake approved task', async () => { const s = storage(['orders:read']); s.db.workflowInstance.findMany.mockRejectedValue(Error('broken source')); expect(await group(s, 'workflow')).toMatchObject({ status: 'failed', total: null }); expect(s.writes).not.toHaveBeenCalled(); });
    it('real WorkflowEngine owned read transaction can return an empty permitted queue', async () => { const s = storage(['orders:read']); expect(await group(s, 'workflow')).toMatchObject({ status: 'ready', total: 0 }); expect(s.db.$transaction).toHaveBeenCalled(); expect(s.writes).not.toHaveBeenCalled(); });
    it('an actual permission withdrawal during the projection invalidates its global response', async () => { const s = storage(['products:read']); s.db.developmentCase.findMany.mockImplementationOnce(async () => { s.data.userAccount[0].roles[0].role.permissions = []; return []; }); await expect(getPersonalWorkbench(s.db, actor, { group: 'development' })).rejects.toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' }); });
    it('actual native WorkflowEngine source/audit yields the precise current review step', async () => { const s = await nativeWorkflowFixture(); const r = await group(s, 'workflow'); expect(r).toMatchObject({ status: 'ready', total: 1, items: [{ target: { kind: 'workflow', instanceId: s.created.id, stepId: s.created.currentStepId }, responsibility: { kind: 'my-review-step', userId: 'me' } }] }); expect(s.writes).not.toHaveBeenCalled(); });
    it('missing native workflow source audit cannot become an action task', async () => { const s = await nativeWorkflowFixture(); s.data.auditLog.splice(0); expect(await group(s, 'workflow')).toMatchObject({ status: 'ready', total: 0 }); expect(s.writes).not.toHaveBeenCalled(); });
    it('stored workflow source changing after the original producer removes review eligibility', async () => { const s = await nativeWorkflowFixture(); s.data.order[0].quantity = 11; expect((await group(s, 'workflow')).total).toBe(0); expect(s.writes).not.toHaveBeenCalled(); });
    it('workflow nested actual read transaction preserves honest team-storage failure', async () => { const s = await nativeWorkflowFixture(); s.db.teamMember.findMany.mockRejectedValue(Error('team scope failure')); expect(await group(s, 'workflow')).toMatchObject({ status: 'failed', total: null }); expect(s.writes).not.toHaveBeenCalled(); });
    it('finance handoff uses actual recipient/source contract and exact billing task target', async () => { const s = storage(['invoices:read', 'invoices:write'], ['role-finance']); assignDepartment(s,'finance'); s.data.relation.push(customer); s.data.developmentCase.push(development); s.data.billingItem = [{ id: 'b1', sourceType: 'DevelopmentCase', sourceId: 'd1', deletedAt: null }]; s.db.billingItem = { findFirst: vi.fn(async ({ where }: any) => s.data.billingItem.find(r => matches(r, where))) }; s.data.workAssignment.push({ id: 'wa1', userId: 'me', title: 'Finance review', status: 'assigned', deletedAt: null, metadata: { managedBy: 'development_cost_closure', kind: 'finance_review', caseId: 'd1', billingItemId: 'b1' } }); expect(await group(s, 'finance-handoffs')).toMatchObject({ status: 'ready', total: 1, items: [{ target: { kind: 'billing-item', billingItemId: 'b1', caseId: 'd1', assignmentId: 'wa1', tab: 'billingItems' } }] }); expect(s.writes).not.toHaveBeenCalled(); });
    it('bill source moved away from its original handoff case keeps own task restricted', async () => { const s = storage(['invoices:read', 'invoices:write'], ['role-finance']); assignDepartment(s,'finance'); s.data.relation.push(customer); s.data.developmentCase.push(development); s.db.billingItem = { findFirst: async () => null }; s.data.workAssignment.push({ id: 'wa1', userId: 'me', title: 'Finance review', status: 'assigned', deletedAt: null, metadata: { managedBy: 'development_cost_closure', kind: 'finance_review', caseId: 'd1', billingItemId: 'b1' } }); expect(await group(s, 'finance-handoffs')).toMatchObject({ total: 1, items: [{ target: null, title: '原案权限或来源已变化' }] }); });
    it.each([
        ['role-sales', 'products:read', 'development'], ['role-sales-manager', 'orders:read', 'approvals'],
        ['role-qc', 'qc:read', 'qc'], ['role-logistics', 'shipments:read', 'shipments'],
        ['role-finance', 'invoices:read', 'invoices'], ['role-admin', 'orders:read', 'approvals'], ['role-super-admin', 'orders:read', 'orders'],
    ])('current stored %s reaches its actual source contract using explicit fixture grants', async (role, grant, key) => { const s = storage([grant], [role]); expect(await group(s, key)).toMatchObject({ status: 'ready', total: 0 }); expect(s.writes).not.toHaveBeenCalled(); });
    it('union of multiple actual roles returns source capability groups and no business writes', async () => { const s = storage(['qc:read', 'invoices:read'], ['role-qc', 'role-finance']); const result = await getPersonalWorkbench(s.db, actor); expect(result.groups.find(g => g.key === 'qc')?.status).toBe('ready'); expect(result.groups.find(g => g.key === 'invoices')?.status).toBe('ready'); expect(result.subject.roleIds).toEqual(['role-qc', 'role-finance']); expect(s.writes).not.toHaveBeenCalled(); });
    it('a real closed lifecycle is not presented as an active development followup',async()=>{const s=storage(['products:read']);s.data.relation.push(customer);s.data.developmentCase.push(development);s.data.developmentLifecycleEvent.push({id:'closed',developmentCaseId:'d1',revision:2,state:'closed'});expect((await group(s,'development')).total).toBe(0);expect(s.writes).not.toHaveBeenCalled();});
    it('a later real reopen uses the highest lifecycle revision rather than an earlier closed event',async()=>{const s=storage(['products:read']);s.data.relation.push(customer);s.data.developmentCase.push(development);s.data.developmentLifecycleEvent.push({id:'closed',developmentCaseId:'d1',revision:2,state:'closed'},{id:'reopened',developmentCaseId:'d1',revision:3,state:'active'});expect((await group(s,'development')).total).toBe(1);expect(s.writes).not.toHaveBeenCalled();});
    it('missing lifecycle storage is a failed source and cannot assert every case is active',async()=>{const s=storage(['products:read']);s.data.relation.push(customer);s.data.developmentCase.push(development);delete s.db.developmentLifecycleEvent;expect(await group(s,'development')).toMatchObject({status:'failed',total:null});});

});

describe('fabric search personal responsibility',()=>{
 it('shows only the current handler and moves action to requester after feedback',async()=>{
  const s=storage(['products:read','products:write'],['role-sales']); assignDepartment(s,'fabric_business');
  s.data.fabricSearchTask.push({id:'fs',code:'FS-TEST',name:'羊毛寻样',status:'pending',assigneeId:'me',requesterId:'requester',targetDate:null,updatedAt:new Date('2026-10-06T01:00:00Z')});
  expect(await group(s,'development')).toMatchObject({status:'ready',total:1,items:[{bucket:'action',reason:'接手寻样',target:{kind:'fabric-search',taskId:'fs'}}]});
  s.data.fabricSearchTask[0].status='awaiting_confirmation';
  expect(await group(s,'development')).toMatchObject({status:'ready',total:0});
  s.data.fabricSearchTask[0].requesterId='me';
  expect(await group(s,'development')).toMatchObject({status:'ready',total:1,items:[{reason:'确认寻样结果'}]});
  s.data.fabricSearchTask[0].status='completed';
  expect(await group(s,'development')).toMatchObject({status:'ready',total:0});
  expect(s.writes).not.toHaveBeenCalled();
 });
});


describe('workbench current appointment and native QC authority intersection',()=>{
  function qcFixture(scopes:string[],attribute:string|null='fabric_qc',type:string|null='Fabric') {
    const s=storage(['qc:read',...scopes],['role-qc']);
    if(attribute) assignDepartment(s,attribute);
    s.data.order.push({id:'qc-order',type,deletedAt:null});
    s.data.qCAssignment.push({id:'qc-assignment',orderId:'qc-order',qcUserId:'me',status:'Assigned',deletedAt:null});
    return s;
  }
  it('business arrangement alone does not become a professional executor task',async()=>{
    const s=qcFixture(['qc:write'],'fabric_business');
    expect(await group(s,'qc')).toMatchObject({status:'ready',items:[{bucket:'follow-up',responsibility:{kind:'assigned-to-me'},target:{kind:'qc-assignment',assignmentId:'qc-assignment',orderId:'qc-order'}}]});
    expect(s.writes).not.toHaveBeenCalled();
  });
  it('explicit inspect grants without current QC appointment remain read-only',async()=>{
    const s=qcFixture(['qc:inspect','qc:fabric_chain:write'],null);
    expect((await group(s,'qc')).items?.[0].bucket).toBe('follow-up');
  });
  it('actual garment QC may execute its exact garment source',async()=>{
    const s=qcFixture(['qc:inspect','qc:garment_chain:write'],'garment_qc','Garment');
    expect((await group(s,'qc')).items?.[0].bucket).toBe('action');
    expect(s.writes).not.toHaveBeenCalled();
  });
  it('another chain grant and an unknown order family never infer execution authority',async()=>{
    expect((await group(qcFixture(['qc:inspect','qc:garment_chain:write'],'garment_qc','Fabric'),'qc')).items?.[0].bucket).toBe('follow-up');
    expect((await group(qcFixture(['qc:inspect','qc:fabric_chain:write'],'fabric_qc',null),'qc')).items?.[0].bucket).toBe('follow-up');
  });
  it('signed ceiling does not expand to current account professional grants',async()=>{
    const s=qcFixture(['qc:inspect','qc:fabric_chain:write']);
    const result=await getPersonalWorkbench(s.db,{...actor,permissionCeiling:['qc:read']},{group:'qc'});
    expect(result.groups[0].items?.[0].bucket).toBe('follow-up');
  });
  it('withdrawal of the actual appointment invalidates the in-flight action projection',async()=>{
    const s=qcFixture(['qc:inspect','qc:fabric_chain:write']);
    s.db.qCAssignment.findMany.mockImplementationOnce(async()=>{s.data.userAccount[0].primaryDepartment.metadata.businessAttributes=[];return s.data.qCAssignment;});
    await expect(getPersonalWorkbench(s.db,actor,{group:'qc'})).rejects.toMatchObject({code:'AUTHORIZATION_UNAVAILABLE'});
    expect(s.writes).not.toHaveBeenCalled();
  });
  it('unqualified business write grant does not expose applicant rework action',async()=>{
    const s=storage(['orders:read','orders:write'],['role-sales']);seedReworkOrder(s);
    s.data.userAccount[0].primaryDepartment=null;s.data.userAccount[0].primaryDeptId=null;
    s.data.approvalRequest.push(rejectedOrderConfirmation());
    expect(await group(s,'approvals')).toMatchObject({status:'forbidden',items:null});
    expect(s.db.approvalRequest.findMany).not.toHaveBeenCalled();
  });
  it('unqualified finance assignment remains restricted rather than granting source access',async()=>{
    const s=storage(['invoices:read','invoices:write'],['role-finance']);
    s.data.relation.push(customer);s.data.developmentCase.push(development);
    s.data.billingItem=[{id:'b1',sourceType:'DevelopmentCase',sourceId:'d1',deletedAt:null}];
    s.db.billingItem={findFirst:vi.fn(async()=>s.data.billingItem[0])};
    s.data.workAssignment.push({id:'wa',userId:'me',title:'Original finance task',status:'assigned',deletedAt:null,metadata:{managedBy:'development_cost_closure',kind:'finance_review',caseId:'d1',billingItemId:'b1'}});
    expect(await group(s,'finance-handoffs')).toMatchObject({items:[{kind:'restricted',target:null}]});
    expect(s.db.billingItem.findFirst).not.toHaveBeenCalled();
  });
});
