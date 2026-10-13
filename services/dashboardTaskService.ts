import { apiService } from './apiService';
import { getAuthState, subscribe } from './authService';
/** Read destinations only. Consumer registration belongs to the application shell. */
export type WorkbenchTarget = {kind:'development-qc-review'; reviewId:string; caseId:string; sampleVersionId:string;} | {kind: 'fabric-search'; taskId: string;} | {
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
    kind: 'qc-assignment';
    assignmentId: string;
    orderId: string;
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
    ['workflow', '我的流程审核'], ['approvals', '指派给我的审批'], ['development', '开发跟进'],
    ['samples', '样品跟进'], ['quotations', '我的报价草稿'], ['orders', '订单交付与生产异常'],
    ['shipments', '运单与装箱跟进'], ['inventory', '库存预警'], ['invoices', '账款跟进'], ['claims', '售后跟进'],
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
export class DashboardReadError extends Error {
    constructor(public readonly code: string, message: string, public readonly status?: number) { super(message); this.name = 'DashboardReadError'; }
}
/** Local identity fence only; no business state is stored in the browser. Never log this value. */
export function dashboardReadIdentity(): string {
    const auth = getAuthState();
    const user = auth.user;
    return JSON.stringify([auth.isAuthenticated, auth.isLoading, user?.id, user?.roleIds, user?.roles, user?.permissions, user?.permissionCeiling,
        user?.departmentIds, user?.department,
        apiService.getStoredConfig().cloudEndpoint, apiService.getAuthHeaders()]);
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const exactAmount = (value: unknown) => value === null || typeof value === 'string' && /^-?\d+(\.\d{1,4})?$/.test(value);
function exactTarget(target: any, keys: string[]): boolean {
    return !Array.isArray(target) && Object.keys(target).length === keys.length && keys.every(key =>
        Object.prototype.hasOwnProperty.call(target, key) && typeof target[key] === 'string' && target[key].length > 0 && target[key].trim() === target[key]);
}
export function isWorkbenchTarget(target: any): target is WorkbenchTarget {
    if (!target || typeof target !== 'object')
        return false;
    switch (target.kind) {
        case 'development-qc-review': return exactTarget(target, ['kind','reviewId','caseId','sampleVersionId']);
        case 'fabric-search': return exactTarget(target, ['kind','taskId']);
        case 'order': return text(target.orderId) && (target.orderLineId === undefined || text(target.orderLineId)) && (target.section === undefined || target.section === 'production');
        case 'development': return text(target.caseId) && ['overview', 'fees'].includes(target.section) && (target.billingItemId === undefined || text(target.billingItemId)) && (target.assignmentId === undefined || text(target.assignmentId)) && (target.sampleVersionId === undefined || text(target.sampleVersionId));
        case 'sample': return text(target.sampleId);
        case 'quotation': return text(target.quotationId);
        case 'qc-assignment': return text(target.assignmentId) && text(target.orderId);
        case 'qc-report': return exactTarget(target, ['kind', 'reportId', 'orderId']);
        case 'release-request': return exactTarget(target, ['kind', 'requestId', 'scopeId', 'orderId', 'orderLineId']);
        case 'shipment': return text(target.shipmentId) && ['overview', 'packing'].includes(target.section);
        case 'inventory-item': return text(target.inventoryItemId) && (target.section === undefined || target.section === 'stock' || target.section === 'transfers') && (target.section === 'transfers' ? text(target.transferId) : target.transferId === undefined);
        case 'invoice': return text(target.invoiceId) && target.tab === 'invoices';
        case 'bulk-invoice-source': return exactTarget(target, ['kind', 'orderId', 'batchId', 'tab']) && target.tab === 'invoices';
        case 'billing-item': return text(target.billingItemId) && target.tab === 'billingItems' && (target.caseId === undefined || text(target.caseId)) && (target.assignmentId === undefined || text(target.assignmentId));
        case 'claim': return text(target.caseId) && (target.dispositionId === undefined || text(target.dispositionId));
        case 'approval': return text(target.approvalId);
        case 'workflow': return text(target.instanceId) && text(target.stepId);
        default: return false;
    }
}
export function parsePersonalWorkbench(data: any, userId: string): PersonalWorkbench {
    const invalid = () => { throw new DashboardReadError('INVALID_RESPONSE', '个人工作台响应不完整，请重新读取。'); };
    if (data?.schemaVersion !== 1 || data.subject?.userId !== userId || typeof data.subject.displayName !== 'string'
        || !Array.isArray(data.subject.roleIds) || !data.subject.roleIds.every(text) || !Array.isArray(data.subject.roleLabels) || !data.subject.roleLabels.every(text)
        || typeof data.businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.businessDate) || typeof data.generatedAt !== 'string' || !Array.isArray(data.groups))
        invalid();
    const seen = new Set<string>();
    for (const group of data.groups) {
        if (!WORKBENCH_GROUPS.some(([key]) => key === group?.key) || seen.has(group.key) || typeof group.label !== 'string' || !['ready', 'forbidden', 'failed'].includes(group.status))
            invalid();
        seen.add(group.key);
        if (group.status !== 'ready') {
            if (group.items !== null || group.total !== null || group.hasMore !== null || group.nextCursor !== null || !text(group.error?.code) || !text(group.error?.message) || typeof group.error.retryable !== 'boolean')
                invalid();
            continue;
        }
        if (!Array.isArray(group.items) || !Number.isSafeInteger(group.total) || group.total < group.items.length || typeof group.hasMore !== 'boolean'
            || !nullableText(group.nextCursor) || group.hasMore !== !!group.nextCursor || group.error !== null)
            invalid();
        const ids = new Set<string>();
        for (const item of group.items) {
            if (!text(item?.id) || ids.has(item.id) || !text(item.title) || !text(item.kind) || !['action', 'follow-up', 'risk', 'notification'].includes(item.bucket)
                || !text(item.source?.type) || !text(item.source.id) || !nullableText(item.source.state) || !nullableText(item.source.version)
                || !['assigned-to-me', 'owned-by-me', 'my-review-step', 'scope-visible', 'unknown'].includes(item.responsibility?.kind) || !nullableText(item.responsibility.userId)
                || !nullableText(item.dueDate) || !['overdue', 'today', 'later', 'undated'].includes(item.timeBucket) || typeof item.reason !== 'string' || !nullableText(item.blockedReason)
                || !(item.target === null || isWorkbenchTarget(item.target)) || !Array.isArray(item.amounts))
                invalid();
            if (item.reference !== null && (!text(item.reference?.type) || !text(item.reference.id) || !nullableText(item.reference.label)))
                invalid();
            for (const amount of item.amounts)
                if (!exactAmount(amount?.amount) || !text(amount.currency) || !text(amount.meaning) || !['visible', 'unknown', 'withheld'].includes(amount.visibility) || amount.visibility !== 'visible' && amount.amount !== null)
                    invalid();
            ids.add(item.id);
        }
    }
    return data;
}
export const dashboardTaskService = {
    async read(query: {
        group?: WorkbenchGroupKey;
        cursor?: string;
        limit?: number;
    } = {}, options: {
        signal?: AbortSignal;
    } = {}): Promise<PersonalWorkbench> {
        const auth = getAuthState();
        if (!auth.isAuthenticated || !auth.user?.id)
            throw new DashboardReadError('UNAUTHORIZED', '请登录后查看个人工作台。', 401);
        const identity = dashboardReadIdentity(), userId = auth.user.id;
        let invalidated = false;
        const controller = new AbortController();
        const check = () => { if (invalidated || dashboardReadIdentity() !== identity) {
            invalidated = true;
            controller.abort();
            throw new DashboardReadError('IDENTITY_CHANGED', '账号、权限或服务地址已变化，请重新读取。');
        } if (controller.signal.aborted)
            throw new DashboardReadError('READ_CANCELLED', '读取已取消，请重新读取。'); };
        const watch = () => { if (dashboardReadIdentity() !== identity) {
            invalidated = true;
            controller.abort();
        } };
        const stop = subscribe(watch);
        window.addEventListener('storage', watch);
        window.addEventListener('focus', watch);
        const abort = () => controller.abort();
        options.signal?.addEventListener('abort', abort);
        if (options.signal?.aborted)
            controller.abort();
        const timeout = window.setTimeout(() => controller.abort(), 20000);
        try {
            check();
            const params = new URLSearchParams();
            if (query.group)
                params.set('group', query.group);
            if (query.cursor)
                params.set('cursor', query.cursor);
            if (query.limit !== undefined)
                params.set('limit', String(query.limit));
            const response = await fetch(apiService.buildApiUrl(`/v1/dashboard/workbench${params.size ? '?' + params.toString() : ''}`, apiService.getStoredConfig().cloudEndpoint), { method: 'GET', headers: apiService.getAuthHeaders(), signal: controller.signal });
            check();
            const data = await response.json().catch(() => null);
            check();
            if (!response.ok)
                throw new DashboardReadError(typeof data?.error?.code === 'string' ? data.error.code : 'WORKBENCH_FAILED', response.status === 401 ? '登录状态已失效，请重新登录。' : response.status === 403 ? '当前账号没有读取权限。' : '个人工作台暂时无法读取，请重试。', response.status);
            return parsePersonalWorkbench(data, userId);
        }
        catch (error) {
            check();
            if (error instanceof DashboardReadError)
                throw error;
            throw new DashboardReadError('WORKBENCH_FAILED', '个人工作台暂时无法读取，请重试。');
        }
        finally {
            stop();
            window.removeEventListener('storage', watch);
            window.removeEventListener('focus', watch);
            options.signal?.removeEventListener('abort', abort);
            window.clearTimeout(timeout);
        }
    }
};
