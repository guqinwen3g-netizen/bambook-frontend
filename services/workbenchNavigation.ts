import {fabricSearchRequest, type FabricSearchTask} from './fabricSearchService';
import { View } from '../types';
import { bulkInvoiceSourceService } from './bulkInvoiceSourceService';
import { apiService } from './apiService';
import { developmentService } from './developmentService';
import { sampleService } from './sampleService';
import { shipmentService } from './shipmentService';
import { paymentVoucherService } from './paymentVoucherService';
import { developmentReviewHandoffService } from './developmentReviewHandoffService';
import { qcService } from './qcService';
import { billingItemService } from './billingItemService';
import { approvalKernelService } from './approvalKernelService';
import { developmentClosureService } from './developmentClosureService';
import { releaseService } from './releaseService';
import { getAuthState, hasPermission, hasRole, subscribe } from './authService';
import { dashboardReadIdentity, isWorkbenchTarget, type WorkbenchTarget } from './dashboardTaskService';

/** Existing notification destinations extend local navigation only, never Dashboard data. */
export type BusinessNavigationTarget = WorkbenchTarget | { kind: 'payment-voucher'; voucherId: string; tab: 'vouchers' };
export function isBusinessNavigationTarget(target: any): target is BusinessNavigationTarget {
  if (target?.kind !== 'payment-voucher') return isWorkbenchTarget(target);
  return typeof target === 'object' && !Array.isArray(target)
    && Object.keys(target).length === 3 && Object.keys(target).every(key => ['kind', 'voucherId', 'tab'].includes(key))
    && typeof target.voucherId === 'string' && target.voucherId.length > 0 && target.voucherId.trim() === target.voucherId
    && target.tab === 'vouchers';
}

/** An ephemeral read destination. It is never a business fact or browser cache. */
export interface WorkbenchFocusRequest {
  target: BusinessNavigationTarget;
  identity: string;
  sequence: number;
}

export function workbenchTargetView(target: BusinessNavigationTarget): View {
  switch (target.kind) {
    case 'order': return View.Orders;
    case 'fabric-search': case 'development': return View.Development;
    case 'sample': return View.Samples;
    case 'quotation': return View.Quotations;
    case 'development-qc-review': case 'qc-assignment': case 'qc-report': return View.QcWorkbench;
    case 'release-request': return View.Dashboard;
    case 'shipment': return View.Shipments;
    case 'inventory-item': return View.Inventory;
    case 'claim': return View.Claims;
    case 'invoice': case 'billing-item': case 'bulk-invoice-source': return View.Invoices;
    case 'payment-voucher': return View.PaymentVouchers;
    // Personal review uses the existing original workflow panel in the shell.
    // Opening a review never grants access to the administration module.
    case 'approval': case 'workflow': return View.Cockpit;
  }
}

export function workbenchFocusIsCurrent(focus: WorkbenchFocusRequest | undefined): boolean {
  return !!focus && getAuthState().isAuthenticated && focus.identity === dashboardReadIdentity();
}

export interface WorkbenchDevelopmentDetails { billingItem?: any; assignment?: any }
const developmentDetails = new WeakMap<object, WorkbenchDevelopmentDetails>();
const billingAssignments = new WeakMap<object, any>();
export function getWorkbenchBillingAssignment(response: object): any | undefined { return billingAssignments.get(response); }
export function getWorkbenchDevelopmentDetails(record: object): WorkbenchDevelopmentDetails | undefined { return developmentDetails.get(record); }

function exactRecord(record: any, id: string): any {
  if (!record || record.id !== id || record.deletedAt != null) throw new Error('原事项不存在、已归档或不在当前可见范围，请重新读取。');
  return record;
}

async function originalAssignment(id: string, caseId: string | undefined, billingItemId: string | undefined, finance: boolean): Promise<any> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = finance ? await developmentClosureService.myFinanceTasks('assigned', cursor) : await developmentClosureService.myBusinessTasks(cursor);
    if (!Array.isArray(response.tasks)) throw new Error('原交接任务响应不完整，请重新读取。');
    const task: any = response.tasks.find(row => row.id === id);
    if (task) {
      if (task.restricted || task.caseId !== caseId || finance && task.billingItem?.id !== billingItemId) throw new Error('原交接任务的来源或权限已变化，请重新读取。');
      return task;
    }
    const next = response.nextCursor;
    if (next && (typeof next !== 'string' || seen.has(next))) throw new Error('原交接任务分页未能确认，请重新读取。');
    if (next) seen.add(next);
    cursor = next || undefined;
  } while (cursor);
  throw new Error('原交接任务已变化，请重新读取个人事项。');
}

/** Read the actual native entity, rejecting missing or mismatched object/line/step IDs. */
async function nativeRecord(target: BusinessNavigationTarget): Promise<any> {
  switch (target.kind) {
    case 'development-qc-review': {
      const review = exactRecord((await developmentReviewHandoffService.read(target.reviewId)).item, target.reviewId);
      if (review.developmentCaseId !== target.caseId || review.sampleVersionId !== target.sampleVersionId) throw new Error('原样品 QC 的开发案或版本已变化，请重新读取。');
      return review;
    }
    case 'fabric-search': return exactRecord(await fabricSearchRequest<FabricSearchTask>(`fabric-search/${encodeURIComponent(target.taskId)}`), target.taskId);
    case 'bulk-invoice-source': return bulkInvoiceSourceService.getSource(target.orderId,target.batchId);
    case 'order': {
      const order = exactRecord(await apiService.getOrderById(target.orderId), target.orderId);
      if (target.orderLineId && (!Array.isArray(order.lines) || !order.lines.some((line: any) => line.id === target.orderLineId))) throw new Error('原订单行已变化，请重新读取。');
      return order;
    }
    case 'development': {
      const source = exactRecord(await developmentService.getDevelopmentCase(target.caseId), target.caseId);
      const details: WorkbenchDevelopmentDetails = {};
      if (target.billingItemId) {
        const response = await billingItemService.get(target.billingItemId);
        const billing = exactRecord(response.billingItem, target.billingItemId);
        if (billing.sourceType !== 'DevelopmentCase' || billing.sourceId !== target.caseId) throw new Error('收费记录与原开发案不一致，请重新读取。');
        details.billingItem = billing;
      }
      if (target.assignmentId) details.assignment = await originalAssignment(target.assignmentId, target.caseId, target.billingItemId, false);
      developmentDetails.set(source, details);
      return source;
    }
    case 'sample': return exactRecord(await sampleService.getSample(target.sampleId), target.sampleId);
    case 'quotation': return exactRecord(await apiService.getQuotation(target.quotationId), target.quotationId);
    case 'qc-assignment': {
      const context = await qcService.getAssignmentInspectionContext(target.assignmentId);
      exactRecord(context.assignment, target.assignmentId);
      if (context.assignment.orderId !== target.orderId || context.order.id !== target.orderId) throw new Error('验货任务与原订单不一致，请重新读取。');
      return context;
    }
    case 'qc-report': {
      const auth = getAuthState();
      if (auth.isLoading || !Array.isArray(auth.user?.permissions) || !hasPermission('qc:read')) throw new Error('当前验货读取权限尚未确认，请重新读取个人事项。');
      const report = exactRecord(await qcService.getReport(target.reportId), target.reportId);
      if (report.orderId !== target.orderId || !Number.isSafeInteger(report.revision) || report.revision < 1
        || typeof report.scopeFingerprint !== 'string' || !report.scopeFingerprint
        || !(report.contentFingerprint === null || typeof report.contentFingerprint === 'string')
        || ['coverageCurrent', 'isCurrentRevision', 'contentCurrent', 'canBusinessDecide'].some(key => typeof report[key] !== 'boolean')
        || report.canBusinessDecide && (!/^[a-f0-9]{64}$/.test(report.scopeFingerprint) || !/^[a-f0-9]{64}$/.test(report.contentFingerprint ?? '')
          || ['coverageCurrent', 'isCurrentRevision', 'contentCurrent'].some(key => report[key] !== true)))
        throw new Error('原报告的订单、修订或内容范围无法核验，请重新读取。');
      return report;
    }
    case 'release-request': {
      const auth = getAuthState();
      if (auth.isLoading || !Array.isArray(auth.user?.permissions) || !hasPermission('production:pp_release:business_sign', 'production:pp_release:production_sign'))
        throw new Error('当前签署权限尚未确认，请重新读取个人事项。');
      const item = await releaseService.getRequestActionContext(target.requestId);
      if (item.scope.id !== target.scopeId || item.scope.orderId !== target.orderId || item.scope.orderLineId !== target.orderLineId)
        throw new Error('原放行申请与范围、订单或订单行不一致，请重新读取。');
      return item;
    }
    case 'shipment': return exactRecord(await shipmentService.getShipment(target.shipmentId), target.shipmentId);
    case 'inventory-item': {const record=exactRecord(await apiService.getInventoryItem(target.inventoryItemId), target.inventoryItemId);if(target.section==='transfers'){if(!target.transferId)throw new Error('调拨任务身份缺失');const [transfer]=await apiService.listInventoryTransfers(target.transferId);if(!transfer||transfer.sourceItem.id!==target.inventoryItemId)throw new Error('原调拨任务不存在或来源已变化');}return record;}
    case 'invoice': return exactRecord(await apiService.getInvoice(target.invoiceId), target.invoiceId);
    case 'payment-voucher': return exactRecord(await paymentVoucherService.getPaymentVoucher(target.voucherId), target.voucherId);
    case 'billing-item': {
      const response = await billingItemService.get(target.billingItemId);
      const billing = exactRecord(response.billingItem, target.billingItemId);
      if (target.caseId && (billing.sourceType !== 'DevelopmentCase' || billing.sourceId !== target.caseId)) throw new Error('收费记录与原开发案不一致，请重新读取。');
      if (target.assignmentId) billingAssignments.set(response, await originalAssignment(target.assignmentId, target.caseId, target.billingItemId, true));
      return response;
    }
    case 'claim': {
      const response = await fetch(apiService.buildApiUrl(`/v1/claims/${encodeURIComponent(target.caseId)}`, apiService.getStoredConfig().cloudEndpoint), { method: 'GET', headers: apiService.getAuthHeaders() });
      if (!response.ok) throw new Error('原售后案件无法读取，请核对权限或稍后重试。');
      const data = await response.json();
      const claim = exactRecord(data.claimCase, target.caseId);
      if (target.dispositionId && (!Array.isArray(claim.dispositions) || !claim.dispositions.some((row: any) => row.id === target.dispositionId))) throw new Error('原处置记录已变化，请重新读取。');
      return claim;
    }
    case 'approval': {
      const approval = exactRecord(await approvalKernelService.getBusinessApproval(target.approvalId), target.approvalId);
      const currentUserId = getAuthState().user?.id;
      const isAssignedReviewer = approval.reviewerId === currentUserId;
      const isOwnerFallback = approval.status === 'pending' && hasRole('owner') && approval.reviewerId == null;
      const isOwnBossDecision = hasRole('owner') && approval.bossFinalBypassBy === currentUserId;
      const isApplicant = approval.requesterId === currentUserId;
      if (!isAssignedReviewer && !isOwnerFallback && !isApplicant && !isOwnBossDecision)
        throw new Error('此审批详情不在当前账号的可读范围内，请核对权限。');
      return approval;
    }
    case 'workflow': {
      const instance = exactRecord(await apiService.getWorkflowInstance(target.instanceId), target.instanceId);
      if (!Array.isArray(instance.steps) || !instance.steps.some((step: any) => step.id === target.stepId)) throw new Error('原工作流步骤已变化，请重新读取。');
      return instance;
    }
  }
}

/** Fence account/token/ceiling/endpoint changes, including observed A→B→A transitions. */
export async function readWorkbenchTarget(focus: WorkbenchFocusRequest, options: { signal?: AbortSignal } = {}): Promise<any> {
  if (!isBusinessNavigationTarget(focus.target) || !workbenchFocusIsCurrent(focus)) throw new Error('账号、权限或服务地址已变化，请重新读取个人事项。');
  if (options.signal?.aborted) throw new Error('原事项读取已取消，请重新打开。');
  let invalidated = false;
  let abort: (() => void) | undefined;
  const watch = () => { if (!workbenchFocusIsCurrent(focus)) { invalidated = true; abort?.(); } };
  const stop = subscribe(watch);
  window.addEventListener('storage', watch);
  window.addEventListener('focus', watch);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => { invalidated = true; reject(new Error('原事项读取已取消，请重新打开。')); };
    options.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, 20000);
  });
  try {
    const result = await Promise.race([nativeRecord(focus.target), aborted]);
    watch();
    if (invalidated) throw new Error('账号、权限或服务地址已变化，原事项响应已丢弃。');
    return result;
  } catch (error) {
    watch();
    if (invalidated) throw new Error('账号、权限或服务地址已变化，原事项响应已丢弃。');
    throw error;
  } finally {
    stop();
    window.removeEventListener('storage', watch);
    window.removeEventListener('focus', watch);
    if (abort) options.signal?.removeEventListener('abort', abort);
    clearTimeout(timer);
  }
}
