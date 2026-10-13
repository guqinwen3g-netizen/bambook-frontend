import { fabricSearchEligibleTeams } from '../development/developmentPersonnelService';
import { authorizeDevelopmentSource } from '../development/developmentConversionAuthority';
import { developmentQcMember } from '../development/developmentQcRouting';
import { authorizeDevelopmentQualityExecution, assertReviewSourceCurrent } from '../development/developmentSampleQualityService';
import { DevelopmentDomainError } from '../development/developmentOperationalGuard';
import { searchActionLabel } from '../development/fabricSearchFlow';
import { qcAssignmentAccess, QcAssignmentError } from '../qc/qcAssignmentAccess';
import { bulkInvoiceSourcesInTx } from '../finance/bulkInvoiceReadProjection';
import { pendingQcBusinessReports } from '../qc/qcReportReadProjection';
import { pendingReleaseRequestActions } from '../production/releaseService';
import { qcReportSourceFingerprint } from '../qc/qcReportAuthority';
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { loadUserWithRoles, buildLoadedAuthTokenPayload } from '../auth/tokenHelpers';
import { hasScope, createPermissionService } from '../auth/permissionService';
import type { PermissionScope } from '../_shared/rolePermissionMatrix';
import { resolveWriteKind, isLeaderPrincipal } from '../_shared/rolePermissionMatrix';
import { createTeamShareService } from '../teams/teamShareService';
import { freshOrderLineScope } from '../orders/orderLineWriteAccess';
import { resolveVisibleOrderIds, resolveVisibleShipmentIds } from '../auth/orderVisibility';
import { qcAssignmentReadWhere } from '../qc/qcAssignmentAccess';
import { createOperationalReadAccess } from '../auth/operationalReadAccess';
import { createClaimVisibility } from '../claims/claimVisibility';
import { developmentBillingReadWhere } from '../development/developmentBillingRouteAccess';
import { assertDevelopmentFinanceRecipient } from '../development/developmentExpenseAccess';
import { buildScopeWhereFromResolver } from '../auth/dataScopeWhere';
import { sumAppliedAmount } from '../finance/allocationService';
import { WorkflowEngine } from '../workflow/workflowEngine';
import { businessError } from '../shared/errorCodes';
import { isValidLocalDateKey, todayLocalKey } from '../shared/localDate';
/** Read destinations only. Consumer registration belongs to the application shell. */
export type WorkbenchTarget = {kind:'development-qc-review';reviewId:string;caseId:string;sampleVersionId:string} | {kind: 'fabric-search'; taskId: string;} | {
    kind: 'order';
    orderId: string;
    orderLineId?: string;
    section?: 'production';
} | {
    kind: 'development';
    caseId: string;
    section: 'overview' | 'fees';
    sampleVersionId?: string;
    billingItemId?: string;
    assignmentId?: string;
} | {
    kind: 'sample';
    sampleId: string;
} | {
    kind: 'quotation';
    quotationId: string;
} | {
    kind: 'qc-report';
    reportId: string;
    orderId: string;
} | {
    kind: 'release-request';
    requestId: string;
    scopeId: string;
    orderId: string;
    orderLineId: string;
} | {
    kind: 'qc-assignment';
    assignmentId: string;
    orderId: string;
} | {
    kind: 'shipment';
    shipmentId: string;
    section: 'overview' | 'packing';
} | {
    kind: 'inventory-item';
    section?: 'stock' | 'transfers';
    transferId?: string;
    inventoryItemId: string;
} | {
    kind: 'invoice';
    invoiceId: string;
    tab: 'invoices';
} | {
    kind: 'bulk-invoice-source';
    orderId: string;
    batchId: string;
    tab: 'invoices';
} | {
    kind: 'billing-item';
    billingItemId: string;
    caseId?: string;
    assignmentId?: string;
    tab: 'billingItems';
} | {
    kind: 'claim';
    caseId: string;
    dispositionId?: string;
} | {
    kind: 'approval';
    approvalId: string;
} | {
    kind: 'workflow';
    instanceId: string;
    stepId: string;
};
export type WorkbenchItem = {
    id: string;
    kind: string;
    title: string;
    bucket: 'action' | 'follow-up' | 'risk' | 'notification';
    source: {
        type: string;
        id: string;
        state: string | null;
        version: string | null;
    };
    reference: {
        type: string;
        id: string;
        label: string | null;
    } | null;
    responsibility: {
        kind: 'assigned-to-me' | 'owned-by-me' | 'my-review-step' | 'scope-visible' | 'unknown';
        userId: string | null;
    };
    dueDate: string | null;
    timeBucket: 'overdue' | 'today' | 'later' | 'undated';
    reason: string;
    amounts: Array<{
        amount: string | null;
        currency: string;
        meaning: string;
        visibility: 'visible' | 'unknown' | 'withheld';
    }>;
    target: WorkbenchTarget | null;
    blockedReason: string | null;
};
export const WORKBENCH_GROUPS = [
    ['development-expenses', '我的费用补充'], ['finance-handoffs', '我的财务交接'], ['qc', '我的检验'],
    ['workflow', '我的流程审核'], ['approvals', '指派给我的审批'], ['development', '开发与寻样跟进'],
    ['samples', '样品跟进'], ['quotations', '我的报价草稿'], ['orders', '订单交付与生产异常'],
    ['shipments', '运单与装箱跟进'], ['inventory', '库存与仓储事项'], ['invoices', '账款跟进'], ['claims', '售后跟进'],
] as const;
export type WorkbenchGroupKey = typeof WORKBENCH_GROUPS[number][0];
export interface WorkbenchGroup {
    key: WorkbenchGroupKey;
    label: string;
    status: 'ready' | 'forbidden' | 'failed';
    items: WorkbenchItem[] | null;
    total: number | null;
    hasMore: boolean | null;
    nextCursor: string | null;
    error: {
        code: string;
        message: string;
        retryable: boolean;
    } | null;
}
export interface PersonalWorkbench {
    schemaVersion: 1;
    subject: {
        userId: string;
        displayName: string;
        roleIds: string[];
        roleLabels: string[];
    };
    businessDate: string;
    generatedAt: string;
    groups: WorkbenchGroup[];
}
const deny = () => { throw businessError('FORBIDDEN', '当前账号没有这类事项的读取权限。'); };
const unavailable = () => businessError('AUTHORIZATION_UNAVAILABLE', '暂时无法核验个人工作台权限，请重试。');
const exact = (value: unknown): string | null => {
    if (value == null)
        return null;
    // Decimal storage/strings are the truth. A Float/JS number is not promoted to an exact amount.
    if (typeof value === 'number')
        throw Error('WORKBENCH_AMOUNT_STORAGE_NOT_EXACT');
    const amount = new Prisma.Decimal(String(value));
    if (!amount.isFinite())
        throw Error('WORKBENCH_AMOUNT_INVALID');
    return amount.toString();
};
const version = (value: unknown): string | null => value == null ? null : value instanceof Date ? value.toISOString() : String(value);
function allowed(actor: TokenPayload, scope: PermissionScope) { return hasScope(actor, scope); }
function requireScope(actor: TokenPayload, scope: PermissionScope) { if (!allowed(actor, scope))
    deny(); }
async function currentActor(db: any, prior: TokenPayload | null | undefined) {
    if (!prior?.userId)
        throw businessError('UNAUTHORIZED', '请登录后查看个人工作台。');
    try {
        const user = await loadUserWithRoles(db, prior.userId);
        if (!user || user.status !== 'active' || user.deletedAt != null)
            throw businessError('ACCOUNT_DISABLED', '当前账号不可用，请重新登录。');
        const actor = await buildLoadedAuthTokenPayload(db, user);
        if (prior.permissionCeiling !== undefined)
            actor.permissionCeiling = [...prior.permissionCeiling];
        return { actor, user };
    }
    catch (error: any) {
        if (['ACCOUNT_DISABLED', 'UNAUTHORIZED'].includes(error?.code))
            throw error;
        throw unavailable();
    }
}
/** Observe exact legacy team-query faults while reusing its policy. No silent self/empty fallback. */
function strictStorage(db: any) {
    let fault = false;
    const client = new Proxy(db, { get(target, key) {
            if (key === '$transaction' && typeof target.$transaction === 'function')
                return async (run: any, options: any) => target.$transaction(async (raw: any) => {
                    const transaction = strictStorage(raw);
                    const result = await run(transaction.client);
                    transaction.check();
                    return result;
                }, options);
            if (key !== 'teamMember')
                return Reflect.get(target, key);
            const delegate = target.teamMember;
            if (!delegate) {
                fault = true;
                throw unavailable();
            }
            return new Proxy(delegate, { get(model, method) { if (method !== 'findMany')
                    return Reflect.get(model, method); return async (...args: any[]) => { try {
                    return await model.findMany(...args);
                }
                catch (error) {
                    fault = true;
                    throw error;
                } }; } });
        } });
    return { client, check() { if (fault)
            throw unavailable(); } };
}
/** Home is a read projection of native routing facts; management never supplies an executor. */
export async function fabricSearchWorkbenchItems(db: any, actor: TokenPayload, today: string): Promise<WorkbenchItem[]> {
    const rows = await db.fabricSearchTask.findMany({where:{status:{in:['unclaimed','pending','in_progress','awaiting_confirmation']},OR:[{assigneeId:actor.userId},{requesterId:actor.userId},{responsibleHeadId:actor.userId},{status:'unclaimed',assigneeId:null}]}});
    const eligibleTeams = rows.some((row:any)=>row.status==='unclaimed' && !row.assigneeId && row.responsibleHeadId!==actor.userId)
        ? await fabricSearchEligibleTeams(db,actor.userId,actor) : [];
    const items: WorkbenchItem[]=[];
    for(const row of rows) {
        const actorId=actor.userId, target:WorkbenchTarget={kind:'fabric-search',taskId:row.id};
        let kind='fabric-search', bucket:WorkbenchItem['bucket']='follow-up', responsibility:WorkbenchItem['responsibility']={kind:'owned-by-me',userId:actorId}, reason='';
        if(row.status==='awaiting_confirmation' && row.requesterId===actorId) {bucket='action';reason='确认寻样结果';}
        else if(['pending','in_progress'].includes(row.status) && row.assigneeId===actorId) {bucket='action';responsibility={kind:'assigned-to-me',userId:actorId};reason=searchActionLabel(row);}
        else if(row.status==='unclaimed' && !row.assigneeId && row.responsibleHeadId===actorId) {kind='fabric-search-routing';bucket='action';reason='由你分配未认领寻样；尚无实际执行人';}
        else if(row.status==='unclaimed' && !row.assigneeId && row.routingTeamId && eligibleTeams.includes(row.routingTeamId)) {kind='fabric-search-pool';bucket='action';responsibility={kind:'scope-visible',userId:null};reason='本专业团队未认领寻样，可在原任务明确领取';}
        else if(row.requesterId===actorId) {kind='fabric-search-followup';reason=row.status==='unclaimed'?'寻样尚未认领，继续跟进原需求':'等待当前执行人反馈，需求主线仍由你跟进';}
        else if(row.responsibleHeadId===actorId) {kind='fabric-search-routing';reason='当前执行人已明确，跟进团队交付；你未被指派执行';}
        else continue;
        if (bucket === 'action' && !allowed(actor, 'products:write')) { bucket = 'follow-up'; reason = '当前凭据可读此寻样责任；处理前仍需原页面核对写权限'; }
        items.push(item(today,'FabricSearchTask',row,kind,`${row.code} · ${row.name}`,target,{bucket,responsibility,reason,dueDate:row.targetDate}));
    }
    return items;
}

export async function developmentQcWorkbenchItems(db:any,actor:TokenPayload,today:string,business:boolean):Promise<WorkbenchItem[]> {
    const rows=await db.developmentSampleQualityReview.findMany({where:business
        ? {requestedBy:actor.userId,status:{in:['queued','in_progress','reviewed']}}
        : {status:{in:['queued','in_progress']},OR:[{startedBy:actor.userId},{responsibleHeadId:actor.userId},{startedBy:null}]}});
    const items:WorkbenchItem[]=[];
    for(const row of rows) {
        let source:any;
        try { source=await authorizeDevelopmentSource(db,actor.userId,actor,row.developmentCaseId,{scope:business?'products:read':'qc:read',write:false}); }
        catch(error) {if(error instanceof DevelopmentDomainError && ['FORBIDDEN','NOT_FOUND','UNAUTHORIZED'].includes(error.code)) continue;throw error;}
        if(!row.sampleVersionId) continue; // No UUID/unit/parent status may manufacture an exact version.
        const versionRow=await db.developmentSampleVersion.findFirst({where:{id:row.sampleVersionId,developmentCaseId:row.developmentCaseId,deletedAt:null}});
        if(!versionRow) continue;
        const title=`${source.development.code} · ${versionRow.versionLabel || row.sampleVersionId} · 样品 QC`;
        if(business) {
            const ready=row.status==='reviewed' && allowed(actor,'products:write');
            items.push(item(today,'DevelopmentSampleQualityReview',row,'development-qc-feedback',title,{kind:'development',caseId:row.developmentCaseId,section:'overview',sampleVersionId:row.sampleVersionId},{bucket:ready?'action':'follow-up',responsibility:{kind:'owned-by-me',userId:actor.userId},reason:row.status==='reviewed'?'本版 QC 已回传，回原开发核对结论并登记已阅':'本版 QC 已交接，继续跟进原开发需求；专业执行另有实际责任人'}));
            continue;
        }
        const head=row.responsibleHeadId===actor.userId, executor=row.startedBy===actor.userId;
        let professional=false;
        try {
            await authorizeDevelopmentQualityExecution(db,row.developmentCaseId,actor.userId,actor);
            professional=row.routingTeamId ? !!await developmentQcMember(db,{caseId:row.developmentCaseId,type:source.development.type,teamId:row.routingTeamId,userId:actor.userId,requesterId:row.requestedBy}) : executor;
        } catch(error) {if(!(error instanceof DevelopmentDomainError) || !['FORBIDDEN','NOT_FOUND','UNAUTHORIZED'].includes(error.code)) throw error;}
        if(!professional || row.requestedBy===actor.userId) continue;
        if(row.startedBy && !executor && !head) continue;
        let current=true;
        const lifecycle=await db.developmentLifecycleEvent.findFirst({where:{developmentCaseId:row.developmentCaseId},orderBy:{revision:'desc'}});
        if(lifecycle && lifecycle.state!=='active') current=false;
        if(current) try {await assertReviewSourceCurrent(db,row);} catch(error) {if(error instanceof DevelopmentDomainError && error.code==='DEVELOPMENT_SOURCE_CHANGED') current=false;else throw error;}
        if(!current && !head && !executor) continue;
        const kind=executor?'development-qc-execution':head?'development-qc-routing':'development-qc-pool';
        const target:WorkbenchTarget={kind:'development-qc-review',reviewId:row.id,caseId:row.developmentCaseId,sampleVersionId:row.sampleVersionId};
        const action=current && (executor || !row.startedBy);
        items.push(item(today,'DevelopmentSampleQualityReview',row,kind,title,target,{bucket:!current?'risk':action?'action':'follow-up',responsibility:{kind:executor?'assigned-to-me':head?'owned-by-me':'scope-visible',userId:executor || head?actor.userId:null},reason:!current?'本版来源已变化，先核对原 QC 任务':executor?'完成你实际接手的本版 QC':head?row.startedBy?'跟进本团队 QC 交付；执行人另有明确指派':'分配本版专业 QC，尚无实际执行人':'本专业团队的准确版本 QC 尚未认领，可在原任务明确领取',blockedReason:current?null:'当前准确来源不满足原 QC 执行门禁'}));
    }
    return items;
}

async function developmentWhere(db: any, actor: TokenPayload) {
    const permission = createPermissionService({ prisma: db });
    const resolver = await permission.getDataScopeResolver(actor, 'relations');
    const all = resolveWriteKind(resolver.rule) === 'all';
    const customerIds = all ? null : await createTeamShareService(db).resolveVisibleRelationIds(actor, { fresh: true });
    const customers = await db.relation.findMany({ where: { deletedAt: null, ...(customerIds ? { id: { in: customerIds } } : {}) }, select: { id: true } });
    return all ? { OR: [{ customerRelationId: null }, { customerRelationId: { in: customers.map((r: any) => r.id) } }] } : { customerRelationId: { in: customers.map((r: any) => r.id) } };
}
function item(today: string, type: string, row: any, kind: string, title: string, target: WorkbenchTarget | null, opts: Partial<WorkbenchItem> & {
    dueDate?: string | null;
} = {}): WorkbenchItem {
    const date = isValidLocalDateKey(opts.dueDate) ? opts.dueDate : null;
    return { id: `${type}:${row.id}:${kind}`, kind, title, bucket: 'follow-up', source: { type, id: row.id, state: row.status ?? row.stage ?? null, version: version(row.updatedAt) },
        reference: null, responsibility: { kind: 'scope-visible', userId: null }, reason: '查看原业务记录并继续跟进', amounts: [], target, blockedReason: null,
        ...opts, dueDate: date, timeBucket: date ? date < today ? 'overdue' : date === today ? 'today' : 'later' : 'undated' };
}
function approvalCardTitle(row:any):string {
    const labels:Record<string,string>={OrderConfirmation:'订单确认书签署',Contract:'销售合同签署',Quotation:'报价审批',QuotationLine:'报价条目审批',OrderChangeRequest:'订单变更审批',PaymentRequest:'付款审批',DevelopmentBillingItem:'开发费审批'};
    const payload=row.payload&&typeof row.payload==='object'?row.payload:{};
    const document=payload.documentSnapshot?.data;
    const ref=[document?.poNumber,document?.quotationNumber,payload.quotationSnapshot?.quotationNumber,payload.poNumber,payload.caseNumber,payload.requestNumber].find(value=>typeof value==='string'&&value.trim()&&!/^[a-f0-9]{32,}$/i.test(value));
    const label=labels[row.targetType]||'业务审批';
    return ref?`${label} · ${ref.trim()}`:label;
}
function approvalCreatedAtMs(row: any): number {
    const value = row?.createdAt;
    const millis = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(millis)) throw Error('WORKBENCH_APPROVAL_CREATED_AT_INVALID');
    return millis;
}
async function orderConfirmationReworkItems(db: any, actor: TokenPayload, today: string): Promise<WorkbenchItem[]> {
    const where = { targetType: 'OrderConfirmation', actionType: 'order:confirmation_sign' };
    const rejected = await db.approvalRequest.findMany({ where: { ...where, requesterId: actor.userId, status: 'rejected', targetId: { not: null } } });
    const targetIds = [...new Set(rejected.map((r: any) => typeof r.targetId === 'string' ? r.targetId.trim() : '').filter(Boolean))];
    if (!targetIds.length) return [];

    const orderScope = await freshOrderLineScope(db, actor);
    const orders = await db.order.findMany({ where: { id: { in: targetIds }, deletedAt: null, status: { notIn: ['Cancelled', 'Canceled'] }, AND: [orderScope] }, select: { id: true } });
    const visibleOrderIds = new Set(orders.map((order: any) => order.id));
    const visibleTargetIds = targetIds.filter(id => visibleOrderIds.has(id));
    if (!visibleTargetIds.length) return [];

    // Rejections are superseded by any later native request for the same target/action,
    // even when another user created it. Same-millisecond requests are ambiguous unless
    // the other request is still active or already approved; never order by opaque IDs.
    const applications = await db.approvalRequest.findMany({ where: { ...where, targetId: { in: visibleTargetIds } } });
    const byTarget = new Map<string, any[]>();
    for (const application of applications) {
        if (typeof application.targetId !== 'string') continue;
        const rows = byTarget.get(application.targetId) ?? [];
        rows.push(application);
        byTarget.set(application.targetId, rows);
    }
    return rejected.filter((row: any) => {
        const targetId = typeof row.targetId === 'string' ? row.targetId.trim() : '';
        if (!targetId || !visibleOrderIds.has(targetId)) return false;
        const rejectedAt = approvalCreatedAtMs(row);
        return !(byTarget.get(targetId) ?? []).some((next: any) => {
            if (next.id === row.id) return false;
            const nextAt = approvalCreatedAtMs(next);
            return nextAt > rejectedAt || (nextAt === rejectedAt && ['pending', 'approved'].includes(next.status));
        });
    }).map((row: any) => item(today, 'ApprovalRequest', row, 'approval-rework', approvalCardTitle(row), { kind: 'approval', approvalId: row.id }, {
        bucket: 'action', responsibility: { kind: 'assigned-to-me', userId: actor.userId }, reason: '待修改并重新提交',
    }));
}
async function projection(db: any, actor: TokenPayload, key: WorkbenchGroupKey, today: string): Promise<WorkbenchItem[]> {
    const own = { kind: 'assigned-to-me' as const, userId: actor.userId };
    if (key === 'development-expenses' || key === 'finance-handoffs') {
        requireScope(actor, key === 'development-expenses' ? 'products:read' : 'invoices:read');
        const kinds = key === 'development-expenses' ? ['billing_supplement'] : ['finance_handoff', 'finance_review'];
        const rows = await db.workAssignment.findMany({ where: { userId: actor.userId, deletedAt: null, status: 'assigned', AND: [{ metadata: { path: ['managedBy'], equals: 'development_cost_closure' } }, { OR: kinds.map(kind => ({ metadata: { path: ['kind'], equals: kind } })) }] } });
        const where = key === 'development-expenses' ? await developmentWhere(db, actor) : await developmentBillingReadWhere(db, actor, { fresh: true });
        const items: WorkbenchItem[] = [];
        for (const row of rows) {
            const meta = row.metadata as any;
            let accessible = false;
            if (typeof meta?.caseId === 'string') {
                if (key === 'development-expenses')
                    accessible = !!await db.developmentCase.findFirst({ where: { id: meta.caseId, deletedAt: null, AND: [where] } });
                else if (typeof meta.billingItemId === 'string') {
                    try {
                        await assertDevelopmentFinanceRecipient(db, meta.caseId, actor.userId, { fresh: true });
                        accessible = !!await db.billingItem.findFirst({ where: { id: meta.billingItemId, sourceType: 'DevelopmentCase', sourceId: meta.caseId, deletedAt: null, AND: [where] } });
                    }
                    catch (error: any) {
                        if (error?.code !== 'INVALID_FINANCE_RECIPIENT')
                            throw error;
                    }
                }
            }
            if (!accessible) {
                items.push(item(today, 'WorkAssignment', row, 'restricted', '原案权限或来源已变化', null, { bucket: 'action', responsibility: own, blockedReason: '请联系负责人核对交接，不能直接处理原案', reason: '原事项仍指派给你，但当前来源不可访问', dueDate: row.dueDate }));
                continue;
            }
            const target: WorkbenchTarget = key === 'development-expenses' ? { kind: 'development', caseId: meta.caseId, section: 'fees', assignmentId: row.id, ...(typeof meta.billingItemId === 'string' ? { billingItemId: meta.billingItemId } : {}) } : { kind: 'billing-item', billingItemId: meta.billingItemId, caseId: meta.caseId, assignmentId: row.id, tab: 'billingItems' };
            items.push(item(today, 'WorkAssignment', row, meta.kind, row.title, target, { bucket: 'action', responsibility: own, dueDate: row.dueDate, reason: typeof meta.reason === 'string' ? meta.reason : key === 'finance-handoffs' ? '业务已交接，请核对费用与开票来源' : '按原任务要求补充费用资料' }));
        }
        if (key === 'finance-handoffs' && allowed(actor, 'orders:read') && allowed(actor, 'shipments:read')) {
            const sources = await bulkInvoiceSourcesInTx(db, actor);
            for (const source of sources.filter(source => source.disposition !== 'existing-invoices')) {
                const ready = source.disposition === 'first-invoice-review';
                items.push(item(today, 'OrderShipmentBatch', { ...source.batch, updatedAt: source.sourceFingerprint }, 'bulk-invoice-source',
                    `大货货款 · ${source.order.poNumber || source.order.code || source.order.id} · 第${source.batch.batchNo}批`,
                    { kind: 'bulk-invoice-source', orderId: source.order.id, batchId: source.batch.id, tab: 'invoices' }, {
                        bucket: ready && source.canStartInvoice ? 'action' : ready ? 'follow-up' : 'risk',
                        source: { type: 'OrderShipmentBatch', id: source.batch.id, state: source.batch.status, version: source.sourceFingerprint },
                        reference: { type: 'Order', id: source.order.id, label: source.order.poNumber || source.order.code || source.order.id },
                        responsibility: { kind: 'scope-visible', userId: null },
                        reason: ready ? source.batch.status === 'planned' ? '核对本批计划与客户约定，可由原发票入口人工预开票；计划金额不是已确认债权' : '原实物出运已确认，请核对约定金额后人工开票' : '原批次历史或当前来源须先核对',
                        amounts: [{ amount: source.batch.plannedAmount, currency: source.batch.currency, meaning: '批次计划金额', visibility: source.batch.plannedAmount === null ? 'unknown' : 'visible' }],
                        blockedReason: source.blockedReason,
                    }));
            }
        }
        return items;
    }
    if (key === 'qc') {
        requireScope(actor, 'qc:read');
        const access = await qcAssignmentReadWhere(db, actor);
        const rows = await db.qCAssignment.findMany({ where: { AND: [access.where, { qcUserId: actor.userId, status: { in: ['Assigned', 'InProgress'] } }] } });
        const assignments: WorkbenchItem[] = [];
        for (const row of rows) {
            let canInspect = false;
            try {
                // Reuse the native start/complete authority, with readonly source reads.
                // Arrangement (qc:write) never makes a professional execution task.
                await qcAssignmentAccess(db, actor, { orderId: row.orderId, assignmentId: row.id, mode: 'inspect' });
                canInspect = true;
            } catch (error) {
                if (!(error instanceof QcAssignmentError) || !['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) throw error;
            }
            assignments.push(item(today, 'QCAssignment', row, 'inspection', `${row.inspectionType === 'final' ? '终期' : row.inspectionType === 'midline' ? '中期' : '类型待核对'}检验 · ${row.orderId}`,
                { kind: 'qc-assignment', assignmentId: row.id, orderId: row.orderId }, {
                    bucket: canInspect ? 'action' : 'follow-up', responsibility: own, dueDate: row.dueDate,
                    reason: canInspect ? '按当前指派完成原检验流程' : '当前可查看检验指派；专业执行资格仍由原页面核验',
                }));
        }
        const reports = await pendingQcBusinessReports(db, actor);
        const developmentReviews = await developmentQcWorkbenchItems(db,actor,today,false);
        return [...assignments, ...developmentReviews, ...reports.map(({ report, responsibility }) => {
            const ready = report.canBusinessDecide === true;
            const projected = item(today, 'InspectionReport', { ...report, status: 'pending-business-decision' }, 'business-decision',
                `检验业务决定 · ${report.orderId}`, { kind: 'qc-report', reportId: report.id, orderId: report.orderId }, {
                    bucket: ready ? 'action' : 'risk', responsibility,
                    reason: ready ? '原报告已完成检验，由实际订单负责人或部门主管核对并作业务决定' : '原报告范围、修订或内容已不匹配，请在原报告核对',
                    blockedReason: ready ? null : '当前报告证据不满足原业务决定门禁',
                });
            projected.source.version = qcReportSourceFingerprint(report);
            return projected;
        })];
    }
    if (key === 'workflow') {
        if (!(['orders:read', 'products:read', 'invoices:read'] as PermissionScope[]).some(s => allowed(actor, s)))
            deny();
        // Reuse the complete source/audit/current-step policy; never query reviewer role strings as approval authority.
        const result = await new WorkflowEngine(db).listInstances({ actor, view: 'pending', status: 'running', limit: 200 });
        // Native engine max page is 200; exhaust pages instead of claiming its first page is the whole queue.
        const rows = [...result.items];
        while (rows.length < result.total) {
            const next = await new WorkflowEngine(db).listInstances({ actor, view: 'pending', status: 'running', limit: 200, offset: rows.length });
            if (!next.items.length)
                throw Error('WORKFLOW_PAGE_INCOMPLETE');
            rows.push(...next.items);
        }
        return rows.map(r => { const step = r.steps.find(s => s.stepIndex === r.currentStepIndex); if (!step)
            throw Error('WORKFLOW_CURRENT_STEP_MISSING'); return item(today, 'WorkflowInstance', r, 'review', `${r.definitionName} · ${step.stepName}`, { kind: 'workflow', instanceId: r.id, stepId: step.id }, { bucket: 'action', responsibility: { kind: 'my-review-step', userId: actor.userId }, reference: { type: r.entityType, id: r.entityId, label: null }, reason: '原流程确认你是当前可审核人，进入原步骤处理' }); });
    }
    if (key === 'approvals') {
        const legacyAllowed = actor.roles.some(r => ['owner', 'admin', 'manager'].includes(r)) && actor.permissionCeiling?.length !== 0;
        const nativeAllowed = ['production:pp_release:production_sign', 'production:pp_release:business_sign'].some(cap => hasScope(actor, cap as PermissionScope));
        const orderConfirmationReworkAllowed = allowed(actor, 'orders:read') && allowed(actor, 'orders:write');
        if (!legacyAllowed && !nativeAllowed && !orderConfirmationReworkAllowed) deny();
        const items: WorkbenchItem[] = [];
        if (legacyAllowed) {
            // Preserve the original ApprovalRequest policy and projection.
            const rows = await db.approvalRequest.findMany({ where: { status: 'pending', reviewerId: actor.userId, requesterId: { not: actor.userId }, actionType: { not: { startsWith: 'tool:' } } } });
            items.push(...rows.map((r: any) => item(today, 'ApprovalRequest', r, 'approval', approvalCardTitle(r), { kind: 'approval', approvalId: r.id }, { bucket: 'action', responsibility: { kind: 'my-review-step', userId: actor.userId }, reason: '原审批记录指定你为审核人；业务门禁仍在原审批入口核验' })));
        }
        if (orderConfirmationReworkAllowed) {
            // Main-order approvals freeze a candidate list; reviewerId intentionally stays null.
            const rows = await db.approvalRequest.findMany({ where: { status: 'pending', actionType: 'order:main_approval', targetType: 'Order', eligibleReviewerIds: { array_contains: [actor.userId] } } });
            const projectedIds = new Set(items.map(entry => entry.source.id));
            items.push(...rows.filter((r: any) => !projectedIds.has(r.id)).map((r: any) => item(today, 'ApprovalRequest', r, 'approval', approvalCardTitle(r), { kind: 'approval', approvalId: r.id }, { bucket: 'action', responsibility: { kind: 'my-review-step', userId: actor.userId }, reason: '订单提交时冻结的审核候选名单包含你；处理时仍由原订单审批核验授权和业务门禁' })));
        }
        if (nativeAllowed) {
            const leadershipSigner = isLeaderPrincipal([...(actor.roleIds ?? []), ...actor.roles]);
            for (const context of await pendingReleaseRequestActions(db, actor)) {
                const r = context.request;
                const projected = item(today, 'ReleaseRequest', { ...r, status: r.state }, 'release-signature', `放行签署 · ${context.scope.orderId}`,
                    { kind: 'release-request', requestId: r.id, scopeId: context.scope.id, orderId: context.scope.orderId, orderLineId: context.scope.orderLineId }, {
                        bucket: context.canSign ? 'action' : leadershipSigner ? 'risk' : 'follow-up', responsibility: { kind: 'scope-visible', userId: null },
                        reference: { type: 'ReleaseScope', id: context.scope.id, label: context.line.label },
                        reason: context.canSign ? '当前账号可签署原请求；执行仍由原签署入口核验' : leadershipSigner ? context.blockedReasons.join('；') : '等待领导处理放行申请',
                        blockedReason: context.canSign || !leadershipSigner ? null : context.blockedReasons.join('；'),
                    });
                projected.source.version = qcReportSourceFingerprint(context);
                items.push(projected);
            }
        }
        if (orderConfirmationReworkAllowed) items.push(...await orderConfirmationReworkItems(db, actor, today));
        return items;
    }
    if (key === 'development' || key === 'samples') {
        requireScope(actor, 'products:read');
        const where = await developmentWhere(db, actor);
        if (key === 'development') {
            const searchItems = await fabricSearchWorkbenchItems(db,actor,today);
            const qcFeedback = await developmentQcWorkbenchItems(db,actor,today,true);
            const rows = await db.developmentCase.findMany({ where: { deletedAt: null, stage: { notIn: ['approved', 'cancelled'] }, AND: [where] } });
            const lifecycleRows = await db.developmentLifecycleEvent.findMany({ where: { developmentCaseId: { in: rows.map((row: any) => row.id) } } });
            const latest = new Map<string, any>();
            for (const event of lifecycleRows) if (!latest.has(event.developmentCaseId) || latest.get(event.developmentCaseId).revision < event.revision) latest.set(event.developmentCaseId, event);
            return searchItems.concat(qcFeedback,rows.filter((row: any) => latest.get(row.id)?.state !== 'closed').map((r: any) => item(today, 'DevelopmentCase', r, 'development', `${r.code} · ${r.name}`, { kind: 'development', caseId: r.id, section: 'overview' }, { dueDate: r.targetDate, reason: latest.get(r.id)?.state === 'paused' ? '开发已暂停，请在原案核对下一步安排' : r.nextAction || '查看当前开发轮次、样品与客户反馈' })));
        }
        const cases = await db.developmentCase.findMany({ where: { deletedAt: null, AND: [where] }, select: { id: true } });
        const orderIds = allowed(actor, 'orders:read') ? await resolveVisibleOrderIds(db, actor, { fresh: true, strict: true }) : [];
        const customerIds = await createTeamShareService(db).resolveVisibleRelationIds(actor, { fresh: true });
        const resolver = await createPermissionService({ prisma: db }).getDataScopeResolver(actor, 'relations');
        const sourceScope = { AND: [
                { OR: [{ sourceCaseId: null }, { sourceCaseId: { in: cases.map((r: any) => r.id) } }] },
                ...(orderIds === null ? [] : [{ OR: [{ sourceOrderId: null }, { sourceOrderId: { in: orderIds } }] }]),
                ...(resolveWriteKind(resolver.rule) === 'all' ? [] : [{ OR: [{ customerRelationId: null }, { customerRelationId: { in: customerIds } }] }, { OR: [{ sourceCaseId: { not: null } }, { sourceOrderId: { not: null } }, { customerRelationId: { not: null } }] }]),
            ] };
        const rows = await db.sample.findMany({ where: { deletedAt: null, status: { notIn: ['confirmed', 'sealed', 'approved', 'cancelled'] }, AND: [sourceScope] } });
        return rows.map((r: any) => item(today, 'Sample', r, 'sample', r.code, { kind: 'sample', sampleId: r.id }, { reason: '查看样品制作、寄送及客户确认的实际进展' }));
    }
    if (key === 'quotations') {
        requireScope(actor, 'quotations:read');
        const resolver = await createPermissionService({ prisma: db }).getDataScopeResolver(actor, 'quotations');
        const ids = resolver.rule.kind === 'all' ? null : await createTeamShareService(db).resolveVisibleRelationIds(actor, { fresh: true });
        const scope = ids === null ? {} : { OR: [{ customerRelationId: { in: ids } }, { customerRelationId: null, ownerId: actor.userId }] };
        const rows = await db.quotation.findMany({ where: { deletedAt: null, status: 'Draft', ownerId: actor.userId, AND: [scope] } });
        return rows.map((r: any) => item(today, 'Quotation', r, 'quotation', r.quotationNumber || r.id, { kind: 'quotation', quotationId: r.id }, { bucket: allowed(actor, 'quotations:write') ? 'action' : 'follow-up', responsibility: { kind: 'owned-by-me', userId: actor.userId }, reason: '你创建的报价仍为草稿，请核对后按原流程处理' }));
    }
    if (key === 'orders') {
        requireScope(actor, 'orders:read');
        const scope = await freshOrderLineScope(db, actor);
        const rows = await db.order.findMany({ where: { deletedAt: null, status: { notIn: ['Delivered', 'Cancelled'] }, AND: [scope] } });
        const stages = await db.productionStage.findMany({ where: { orderId: { in: rows.map((r: any) => r.id) }, status: 'blocked' } });
        return rows.filter((r: any) => isValidLocalDateKey(r.dueDate) && r.dueDate <= today || stages.some((s: any) => s.orderId === r.id)).map((r: any) => {
            const blocked = stages.filter((s: any) => s.orderId === r.id);
            return item(today, 'Order', r, 'delivery', r.poNumber || r.code || r.id, { kind: 'order', orderId: r.id, ...(blocked.length ? { section: 'production' as const } : {}) }, { bucket: 'risk', dueDate: r.dueDate, responsibility: r.ownerId === actor.userId ? { kind: 'owned-by-me', userId: actor.userId } : { kind: 'scope-visible', userId: null }, reason: blocked.length ? '原生产阶段已记录阻塞，请核对实际原因' : '订单交付日期已到，请核对交付进展' });
        });
    }
    if (key === 'shipments') {
        requireScope(actor, 'shipments:read');
        const ids = await resolveVisibleOrderIds(db, actor, { fresh: true, strict: true });
        const scope = ids === null ? {} : { OR: [{ orderId: { in: ids } }, { id: { in: await resolveVisibleShipmentIds(db, ids, { strict: true }) } }] };
        const rows = await db.shipment.findMany({ where: { deletedAt: null, status: { in: ['Draft', 'Booked', 'Loading', 'Shipped', 'Arrived', 'Cleared'] }, AND: [scope] } });
        return rows.map((r: any) => {
            if (['Draft', 'Booked', 'Loading'].includes(r.status))
                return item(today, 'Shipment', r, 'packing', r.shipmentNumber, { kind: 'shipment', shipmentId: r.id, section: 'packing' }, { reason: '核对原运单的实物分配、装箱与单据；此状态不代表已经可以发运' });
            const reasons: Record<string, string> = {
                Shipped: '原票已发运，请核对实际到港记录、单据与报关，并继续跟进交付。',
                Arrived: '原票处于到港阶段，请核对实际到港记录、清关和交付。',
                Cleared: '原票处于清关后阶段，请核对实际交付，按原流程完成履约。',
            };
            return item(today, 'Shipment', r, 'fulfillment', r.shipmentNumber, { kind: 'shipment', shipmentId: r.id, section: 'overview' }, { reason: reasons[r.status] });
        });
    }
    if (key === 'inventory') {
        requireScope(actor, 'orders:read');
        const access = createOperationalReadAccess(db, actor);
        const scope = await access.orderWhere(true);
        const rows = await db.inventoryItem.findMany({ where: { deletedAt: null, minStock: { not: null }, AND: [scope] } });
        const warnings = rows.filter((r: any) => new Prisma.Decimal(exact(r.quantity)!).lt(exact(r.minStock)!)).map((r: any) => item(today, 'InventoryItem', r, 'low-stock', r.description, { kind: 'inventory-item', inventoryItemId: r.id }, { bucket: 'risk', reason: `实际库存 ${exact(r.quantity)} ${r.unit} 低于原预警线 ${exact(r.minStock)} ${r.unit}` }));
        const transfers=await db.inventoryTransfer.findMany({where:{status:{in:['pending','in_transit']},sourceItem:{deletedAt:null,AND:[scope]}},include:{sourceItem:{select:{id:true,description:true}},targetWarehouse:{select:{profile:true}}}});
        const tasks=transfers.filter((t:any)=>hasScope(actor,'inventory:write')&&(t.status==='pending'?t.createdBy===actor.userId:((t.targetWarehouse.profile as any)?.responsibleUserId||t.createdBy)===actor.userId)).map((t:any)=>item(today,'InventoryTransfer',t,t.status==='pending'?'dispatch-transfer':'receive-transfer',t.sourceItem.description,{kind:'inventory-item',inventoryItemId:t.sourceItemId,section:'transfers',transferId:t.id},{bucket:'action',reason:t.status==='pending'?'待你登记实际发出':'货物在途，待你登记目标仓签收'}));
        return [...warnings,...tasks];
    }
    if (key === 'invoices') {
        requireScope(actor, 'invoices:read');
        const resolver = await createPermissionService({ prisma: db }).getDataScopeResolver(actor, 'finance');
        const scope = buildScopeWhereFromResolver(resolver, actor.userId);
        const rows = await db.invoice.findMany({ where: { deletedAt: null, status: { in: ['Draft', 'Issued', 'PartiallyPaid'] }, AND: [scope] } });
        // The native schema always provides both allocations; absence is a storage outage, never a zero balance.
        if (!db.invoiceAllocation?.findMany || !db.creditNoteAllocation?.findMany)
            throw Error('INVOICE_ALLOCATION_STORAGE_UNAVAILABLE');
        const items: WorkbenchItem[] = [];
        for (const r of rows) {
            const amount = exact(r.amount)!;
            const balance = new Prisma.Decimal(amount).minus(await sumAppliedAmount(db, r.id));
            if (r.status !== 'Draft' && !balance.gt(0))
                continue;
            items.push(item(today, 'Invoice', r, r.status === 'Draft' ? 'invoice-draft' : 'invoice-balance', r.invoiceNumber, { kind: 'invoice', invoiceId: r.id, tab: 'invoices' }, { bucket: r.status !== 'Draft' && isValidLocalDateKey(r.dueDate) && r.dueDate < today ? 'risk' : 'follow-up', dueDate: r.dueDate,
                reason: r.status === 'Draft' ? '核对原草稿的费用与开票来源' : r.type === 'Payable' ? '核对原应付账款和付款核销' : r.type === 'Receivable' ? '核对原应收账款和收款核销' : '账款类型待核对，请查看原票据',
                amounts: [{ amount: r.status === 'Draft' ? amount : balance.toString(), currency: r.currency, meaning: r.status === 'Draft' ? '草稿金额' : '未核销金额', visibility: 'visible' }] }));
        }
        return items;
    }
    if (key === 'claims') {
        requireScope(actor, 'aftersales:read');
        const visibility = createClaimVisibility(db, actor);
        const scope = await visibility.caseScopeWhere();
        const rows = await db.claimCase.findMany({ where: { deletedAt: null, status: { notIn: ['Closed', 'Cancelled'] }, AND: [scope] } });
        return rows.map((r: any) => item(today, 'ClaimCase', r, 'claim', r.caseNumber, { kind: 'claim', caseId: r.id }, { reason: '查看原售后案件及处置、退货或财务交接的实际进度' }));
    }
    throw businessError('VALIDATION_FAILED', '未知工作台分组。');
}
/** Stable digest of actual storage results, never request time or generatedAt.
 * Root findMany collections are sets; nested business JSON (for example workflow
 * step order) retains its order. Decimal/BigInt remain exact and type-distinct. */
function canonicalResult(value: unknown, collection = false): unknown {
    if (value === undefined) return ['undefined'];
    if (typeof value === 'bigint') return ['bigint', String(value)];
    if (Prisma.Decimal.isDecimal(value)) return ['decimal', value.toString()];
    if (value instanceof Date) return ['date', value.toISOString()];
    if (Array.isArray(value)) {
        const rows = value.map(row => canonicalResult(row));
        return collection ? rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : rows;
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key,
        canonicalResult((value as Record<string, unknown>)[key], ['roles', 'permissions', 'salesRepIds'].includes(key))]));
    if (typeof value === 'number' && !Number.isFinite(value)) throw unavailable();
    return value;
}
function resultDigest(value: unknown, collection = false): string {
    return createHash('sha256').update(JSON.stringify(canonicalResult(value, collection))).digest('hex');
}
function authority(actor: TokenPayload) {
    return resultDigest({ userId: actor.userId, roles: [...actor.roles].sort(), roleIds: [...(actor.roleIds ?? [])].sort(),
        permissions: [...(actor.permissions ?? [])].sort(), departmentIds: [...(actor.departmentIds ?? [])].sort(),
        permissionCeiling: actor.permissionCeiling === undefined ? undefined : [...actor.permissionCeiling].sort() });
}
/** Observe only real readonly delegate results. Missing methods still fail through
 * their actual caller; unsupported read methods/SQL cannot claim a complete stamp.
 * Nested WorkflowEngine transactions execute natively and share this read trace. */
function observedStorage(db: any) {
    const reads: string[] = [];
    const readMethods = new Set(['findMany', 'findFirst', 'findUnique', 'count']);
    const wrap = (raw: any): any => new Proxy(raw, { get(target, key) {
        if (key === '$transaction' && typeof target.$transaction === 'function')
            return (run: any, options: any) => target.$transaction((tx: any) => run(wrap(tx)), options);
        if (key === '$queryRaw' || key === '$queryRawUnsafe' || key === '$executeRaw' || key === '$executeRawUnsafe')
            return () => { throw unavailable(); };
        const delegate = Reflect.get(target, key);
        if (typeof key !== 'string' || key.startsWith('$') || !delegate || typeof delegate !== 'object') return delegate;
        return new Proxy(delegate, { get(model, method) {
            const native = Reflect.get(model, method);
            if (typeof method !== 'string' || typeof native !== 'function') return native;
            if (readMethods.has(method)) return async (...args: any[]) => {
                const result = await Reflect.apply(native, model, args);
                // Hash immediately: later storage/reference changes cannot rewrite a prior observation.
                reads.push(`${key}.${method}:${resultDigest(result, method === 'findMany')}`);
                return result;
            };
            // No broad proxy fallback for an unknown query or a business write.
            return () => { throw unavailable(); };
        } });
    } });
    return { client: wrap(db), stamp: () => resultDigest([...reads].sort()) };
}
function failedGroup(key: WorkbenchGroupKey, label: string, forbidden: boolean): WorkbenchGroup {
    return { key, label, status: forbidden ? 'forbidden' : 'failed', items: null, total: null, hasMore: null, nextCursor: null,
        error: { code: forbidden ? 'FORBIDDEN' : 'WORKBENCH_SOURCE_UNAVAILABLE', message: forbidden ? '当前权限不包含这类事项' : '这类事项暂时无法读取，请重试', retryable: !forbidden } };
}
function readPage(query: {
    group?: unknown;
    cursor?: unknown;
    limit?: unknown;
}) {
    const group = query.group == null ? undefined : String(query.group);
    if (group && !WORKBENCH_GROUPS.some(([key]) => key === group))
        throw businessError('VALIDATION_FAILED', '工作台分组无效。');
    const limit = query.limit == null ? 20 : Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        throw businessError('VALIDATION_FAILED', '每页条数必须为 1–50 的整数。');
    let offset = 0;
    if (query.cursor != null) {
        if (!group || typeof query.cursor !== 'string' || query.cursor.length > 500)
            throw businessError('VALIDATION_FAILED', '分页位置无效。');
        try {
            const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
            if (parsed.group !== group || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0)
                throw Error();
            offset = parsed.offset;
        }
        catch {
            throw businessError('VALIDATION_FAILED', '分页位置无效。');
        }
    }
    return { group, limit, offset };
}
/** Pure projection: it reads existing producers; it never creates tasks, initializes stages, or recalculates finance. */
export async function getPersonalWorkbench(prisma: PrismaClient, prior: TokenPayload | null | undefined, query: {
    group?: unknown;
    cursor?: unknown;
    limit?: unknown;
} = {}): Promise<PersonalWorkbench> {
    const page = readPage(query);
    const { actor, user } = await currentActor(prisma, prior);
    const today = todayLocalKey();
    const groups: WorkbenchGroup[] = [];
    const initial = new Map<WorkbenchGroupKey, { rows: WorkbenchItem[]; sourceStamp: string; projectionStamp: string }>();
    const readGroup = async (key: WorkbenchGroupKey) => {
        const run = async (raw: any) => {
            const observed = observedStorage(raw);
            const strict = strictStorage(observed.client);
            const fresh = await currentActor(strict.client, prior);
            if (authority(fresh.actor) !== authority(actor)) throw unavailable();
            const rows = await projection(strict.client, fresh.actor, key, today);
            strict.check();
            return { rows, sourceStamp: observed.stamp(), projectionStamp: resultDigest(rows, true) };
        };
        // The engine retains its own real source/audit/current-step transaction.
        return key === 'workflow' ? run(prisma) : prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    };
    for (const [key, label] of WORKBENCH_GROUPS) {
        if (page.group && key !== page.group) continue;
        try {
            initial.set(key, await readGroup(key));
            // Ready data remains private and unpaginated until the final same-projection check.
            groups.push({ key, label, status: 'ready', items: null, total: null, hasMore: null, nextCursor: null, error: null });
        } catch (error: any) {
            groups.push(failedGroup(key, label, error?.code === 'FORBIDDEN'));
        }
    }
    for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        const first = initial.get(group.key);
        if (!first) continue;
        try {
            const final = await readGroup(group.key);
            if (final.sourceStamp !== first.sourceStamp || final.projectionStamp !== first.projectionStamp)
                throw unavailable();
            const urgency = { overdue: 0, today: 1, later: 2, undated: 3 };
            const sorted = [...final.rows].sort((a, b) => urgency[a.timeBucket] - urgency[b.timeBucket] || (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id.localeCompare(b.id));
            const offset = page.group ? page.offset : 0;
            const items = sorted.slice(offset, offset + page.limit);
            const hasMore = offset + items.length < sorted.length;
            groups[index] = { key: group.key, label: group.label, status: 'ready', items, total: sorted.length, hasMore,
                nextCursor: hasMore ? Buffer.from(JSON.stringify({ group: group.key, offset: offset + items.length })).toString('base64url') : null, error: null };
        } catch {
            // A once-readable source that changed/faulted is unknown, never a new empty or stale page.
            groups[index] = failedGroup(group.key, group.label, false);
        }
    }
    const last = await currentActor(prisma, prior);
    if (authority(last.actor) !== authority(actor))
        throw unavailable();
    return { schemaVersion: 1, subject: { userId: actor.userId, displayName: actor.displayName || actor.userId, roleIds: actor.roleIds ?? [], roleLabels: user.roles.map((r: any) => r.role.name).filter((r: unknown) => typeof r === 'string') }, businessDate: today, generatedAt: new Date().toISOString(), groups };
}
