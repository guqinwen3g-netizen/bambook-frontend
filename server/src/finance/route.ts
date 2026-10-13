import { InvoiceAttachmentError, invoiceAttachmentKey, invoiceAttachmentDirectory, preflightInvoiceAttachment, registerInvoiceAttachment, readInvoiceAttachment, readOwnInvoiceAttachmentReceipt } from './invoiceAttachmentService';
import crypto from 'crypto';
import { extractActorFromRequest } from '../auth/middleware';
/**
 * 财务管理 API — /api/v1/finance
 *
 * 由 scaffold-module.ts 生成于 2026-06-15T00:39:31.882Z.
 * 生成器只搭骨架，业务校验/字段白名单/审计需要人工补全。
 *
 * 契约钩子（来自 docs/MODULE_CONTRACT.md）：
 *   - L2.2 输入校验：在每个 mutation 入口加 zod / 手写白名单
 *   - L3.1 EntityLink 同步：mutation 必须调用 syncFinanceReferences
 *   - L4 审批：高风险 mutation 默认走 manifest.safety.approval=required
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createModuleAuthGuard, requireJwtForWrite } from '../auth/moduleGuard';
import { requirePermission } from '../auth/permissionGuard';
import { logger } from '../lib/logger';
import { Prisma, PrismaClient } from '@prisma/client';
import { renderHtmlToPdf } from '../templates/pdf';
import { syncInvoiceReferences, syncPaymentVoucherReferences } from '../entities/sync';
import { writeRouteAuditLog, actorIdFromRequest } from '../audit/routeAudit';
import { safeRouteError } from '../shared/routeError';
import { readCiInvoiceSource } from '../customs/ciInvoiceSource';
import { businessError, lookupErrorCode } from '../shared/errorCodes';
import { cancelInvoice, cancelVoucher, deleteInvoice, deleteVoucher } from './voidDeleteService';
import { recalcInvoiceStatus, recalcVoucherStatus, validateAllocationInput, syncAllocationVoucherLinks, applyAllocation, listInvoiceAllocations } from './allocationService';
import { sumAppliedAmountByInvoice } from '../shared/invoiceAppliedSum';
import { createAllocation, updateAllocation, deleteAllocation } from './allocationMutationService';
import { visibleFinanceInvoiceWhere, requireFinanceInvoiceAccess, listVisibleFinanceAllocations } from './financeSourceAccess';
import { DEVELOPMENT_CI_SOURCE } from '../development/developmentCiSource';
import { readDevelopmentCiInvoiceSource } from './developmentCiInvoiceSource';
import { listClaimableReceipts, claimReceipt, resolveInvoiceOrderIds } from './receiptClaimService';
import { suggestReceiptAllocation } from '../events/linkages/L5AutoAllocate';
import { resolveVisibleOrderIds } from '../auth/orderVisibility';
import { validateStatusTransition } from '../statusTransition';
import { createPaymentVoucher, updatePaymentVoucher } from './paymentVoucherMutationService';
import { createInvoice, updateInvoice } from './invoiceMutationService';
import { listPendingBusinessCiReceivables, registerIssuedBusinessCiReceivable } from './businessCiReceivableService';
import { getAgingReport, getCustomerStatement, getSupplierStatement, getFxGainLoss, getConsolidatedProfitReport, getCashCalendar } from './reportService';
import { createDunningService } from './dunningService';
import { createDunningStageService } from './dunningStageService';
import { createFxSettlement, deleteFxSettlement, getFxLedger, getVoucherSettlementSummary } from './fxSettlementService';
import { createOutwardRemittance, deleteOutwardRemittance, getVoucherRemittanceSummary, listOutwardRemittances } from './outwardRemittanceService';
import { createVatInvoice, updateVatInvoice, transitionVatInvoiceStatus, deleteVatInvoice, listVatInvoices, getVatInvoice } from './vatInvoiceService';
import { visibleFinanceObjectWhere, requireFinanceObjectAccess } from './financeSourceAccess';
import { getSystemConfigService } from '../config/systemConfigService';
import { DEFAULT_EXPORTER_PROFILE, EXPORTER_PROFILE_CONFIG_KEY } from '../config/systemConfigRoute';
import { agingToSheets, customerStatementToSheets, statementExportFileName, supplierStatementToSheets, fxGainLossToSheets, cashCalendarToSheets, consolidatedProfitToSheets } from './reportExportService';
import { maskConsolidatedProfitReport } from './sensitiveMask';
// B11 结构收编：财务发票模板原位提取至 templates/docTemplates/financeInvoice.ts
// （invoicePdfHtml / loadInvoiceDoc / renderFinanceInvoiceDocument），路由文件只留端点装配
import { invoicePdfHtml, loadInvoiceDoc, renderFinanceInvoiceDocument } from '../templates/docTemplates/financeInvoice';
import { renderServerDocument } from '../templates/docTemplates/registry';
import { buildXlsx, xlsxDownloadHeaders } from '../templates/xlsxExport';
// ★ D6：与银行的远期结汇合约
import { createForwardFxContract, settleForwardFx, listForwardFxContracts } from './forwardFxService';
import { createCompanyCashAccountRouter } from './companyCashAccountRoute';
import { createSupplierVatPayableRouter } from './supplierVatPayableRoute';
import { createFabricCommissionFinanceRouter } from './fabricCommissionRoute';

/** 发票附件上传根目录（与静态服务根同源：BAMBOOK_UPLOAD_DIR 或 apps/Bambook/uploads——
 *  index.ts 静态服务 /api/uploads 的根；本文件在 server/src/finance/ 下需三级回溯） */
const FINANCE_UPLOAD_DIR = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../../uploads');

function ensureDir(p: string): void { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }


export interface FinanceRouterOptions {
  prisma: PrismaClient;
  requireAuth: boolean;
  apiKeys: Set<string>;
  onDataChange?: (event: { entity: string; action: string; ids?: string[] }) => void;
}

type FinanceCreateInput = {
  invoiceNumber: string;
  type: string;
  status?: string;
  amount: number;
  currency: string;
  issueDate: string;
  dueDate?: string;
  exchangeRate?: number;
  baseCurrency?: string;
  orderId?: string;
  customerRelationId?: string;
  customerName?: string;
  notes?: string;
  attachments?: any;
};

type VoucherCreateInput = {
  voucherNumber: string;
  type: string;
  amount: number;
  currency: string;
  paymentDate: string;
  paymentMethod: string;
  status?: string; // task_mqxwgafj: unreconciled|partially_reconciled|reconciled
  bankFee?: number;
  exchangeRate?: number;
  baseCurrency?: string;
  invoiceId?: string;
  appliedAmount?: number;
  orderId?: string;
  customerRelationId?: string;
  customerName?: string;
  notes?: string;
  attachments?: any;
};

/** Whitelisted fields for PATCH updates on Invoice */
const INVOICE_PATCH_FIELDS = [
  'type', 'status', 'amount', 'currency', 'issueDate', 'dueDate',
  'exchangeRate', 'baseCurrency', 'orderId', 'customerRelationId',
  'customerName', 'notes', 'attachments',
] as const;

/** Whitelisted fields for PATCH updates on PaymentVoucher */
const VOUCHER_PATCH_FIELDS = [
  'type', 'amount', 'currency', 'paymentDate', 'paymentMethod', 'bankFee',
  'exchangeRate', 'baseCurrency', 'invoiceId', 'appliedAmount',
  'orderId', 'customerRelationId', 'customerName', 'notes', 'attachments',
] as const;

function pickFields(body: Record<string, any>, fields: readonly string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of fields) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
}

function serializeFinanceValue<T>(value: T): T {
  if (typeof value === 'bigint') return Number(value) as T;
  if (Array.isArray(value)) return value.map(serializeFinanceValue) as T;
  if (value && typeof value === 'object') {
    // instanceof 判定（constructor.name 在打包压缩后不可靠）；与 index.ts 全局
    // Decimal.prototype.toJSON=Number 补丁对齐 —— GET 直出路径金额均为 number，
    // 此处统一序列化契约为 number，避免创建/更新响应与列表响应类型分裂。
    if (value instanceof Prisma.Decimal) return Number(value) as T;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = serializeFinanceValue(item as any);
    return out as T;
  }
  return value;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * DR-044 净额口径：批量汇总「已核销金额」。列表响应附派生字段
 * appliedAmount（已核销合计）/ openAmount（未结清余额 = 单据金额 − 已核销），
 * KPI/账龄/对账单跨模块同口径，不消费可能过期的 PaymentVoucher.appliedAmount 快照
 * （DR-045：快照仅为向后兼容展示）。
 *
 * ★ 2026-09-19（上线验收修）：**发票侧必须与状态判定真源同源** ——
 *   走 `sumAppliedAmountByInvoice`（收款核销 + **贷项票抵扣**），而不是只 groupBy
 *   `invoiceAllocation`。否则客户索赔折让抵扣后：**状态显示已结清、列表却仍显示欠着折让额**
 *   （同一张票两个数，正是「跨页数字一致」要消灭的东西）。
 *   ⚠️ 凭证侧（voucher）仍只算 InvoiceAllocation —— 贷项票没有凭证，语义不同。
 */
async function attachAllocationDerivedFields(
  prisma: PrismaClient,
  items: any[],
  scope: 'invoice' | 'voucher',
): Promise<any[]> {
  if (items.length === 0) return items;
  const ids = items.map(i => i.id);
  let appliedMap: Map<string, number>;
  if (scope === 'invoice') {
    appliedMap = await sumAppliedAmountByInvoice(prisma as any, ids);
  } else {
    const allocSums = await (prisma as any).invoiceAllocation.groupBy({
      by: ['voucherId'],
      where: { voucherId: { in: ids } },
      _sum: { appliedAmount: true },
    });
    appliedMap = new Map<string, number>(
      allocSums.map((a: any) => [
        a.voucherId,
        a._sum.appliedAmount != null ? Number(a._sum.appliedAmount) : 0,
      ]),
    );
  }
  return items.map(item => {
    const applied = appliedMap.get(item.id) ?? 0;
    return { ...item, appliedAmount: round4(applied), openAmount: round4(Number(item.amount) - applied) };
  });
}

/**
 * T2/H14 + D8-Q3：发票品类派生 + 批次锚点（两跳反查运单）。
 * 品类不冗余存储（D8-Q3 拍板）：发票由 Invoice.orderId / IOA.orderId → Order.businessLine 派生；
 * 批次锚点：IOA.batchId → OrderShipmentBatch(batchNo/shipmentId) 两跳到运单（方案 A 零新 FK）。
 */
async function attachInvoiceCategoryFields(prisma: PrismaClient, items: any[]): Promise<any[]> {
  if (items.length === 0) return items;
  const invoiceIds = items.map(i => i.id);
  const ioaRows = await (prisma as any).invoiceOrderAllocation.findMany({
    where: { invoiceId: { in: invoiceIds }, deletedAt: null },
    select: { id: true, invoiceId: true, orderId: true, orderNumber: true, poNumber: true, batchId: true, allocatedAmount: true, note: true },
  });
  const batchIds = [...new Set(ioaRows.map((a: any) => a.batchId).filter(Boolean))];
  const batches = batchIds.length > 0
    ? await (prisma as any).orderShipmentBatch.findMany({
        where: { id: { in: batchIds } },
        select: { id: true, batchNo: true, shipmentId: true, amount: true },
      })
    : [];
  const batchById = new Map<string, any>(batches.map((b: any) => [b.id, b]));
  const orderIds = [...new Set([
    ...ioaRows.map((a: any) => a.orderId),
    ...items.map((i: any) => i.orderId).filter(Boolean),
  ])];
  const orders = orderIds.length > 0
    ? await (prisma as any).order.findMany({ where: { id: { in: orderIds } }, select: { id: true, businessLine: true } })
    : [];
  const lineById = new Map<string, string | null>(orders.map((o: any) => [o.id, o.businessLine ?? null]));
  const byInvoice = new Map<string, any[]>();
  for (const a of ioaRows) {
    const list = byInvoice.get(a.invoiceId) ?? [];
    list.push(a);
    byInvoice.set(a.invoiceId, list);
  }
  return items.map(item => {
    const allocs = byInvoice.get(item.id) ?? [];
    // 品类：主订单优先，其次首个分配订单（合票同业务线由服务层校验，取任一一致）
    const businessLine = (item.orderId ? lineById.get(item.orderId) : null)
      ?? (allocs.length > 0 ? lineById.get(allocs[0].orderId) ?? null : null)
      ?? null;
    const batchAnchors = allocs
      .filter((a: any) => a.batchId)
      .map((a: any) => {
        const b = batchById.get(a.batchId);
        return {
          orderId: a.orderId,
          batchId: a.batchId,
          batchNo: b?.batchNo ?? null,
          shipmentId: b?.shipmentId ?? null,
          allocatedAmount: a.allocatedAmount != null ? String(a.allocatedAmount) : null,
        };
      });
    // Both invoice reads expose the complete active union. Human labels belong
    // to the saved IOA snapshot; the legacy direct anchor has only its source ID.
    const references = new Map<string, any>();
    if (item.orderId) references.set(item.orderId, {
      orderId: item.orderId, orderNumber: null, poNumber: null, direct: true,
      allocationId: null, batchId: null, allocatedAmount: null, note: null,
    });
    for (const a of allocs) references.set(a.orderId, {
      orderId: a.orderId, orderNumber: a.orderNumber ?? null, poNumber: a.poNumber ?? null,
      direct: a.orderId === item.orderId, allocationId: a.id, batchId: a.batchId ?? null,
      allocatedAmount: a.allocatedAmount != null ? String(a.allocatedAmount) : null, note: a.note ?? null,
    });
    return { ...item, businessLine, batchAnchors, orderReferences: [...references.values()] };
  });
}

export function createFinanceRouter(options: FinanceRouterOptions): Router {
  const { prisma, onDataChange, requireAuth, apiKeys } = options;
  const router = Router();

  // Shared auth guard: JWT or API-key (restored — was silently dropped by scaffold)
  const guard = createModuleAuthGuard({ requireAuth, apiKeys });
  router.use(guard);
  router.use('/cash-accounts',createCompanyCashAccountRouter({prisma}));
  router.use('/supplier-vat-payables', createSupplierVatPayableRouter({ prisma }));
  router.use('/fabric-commission-cis', createFabricCommissionFinanceRouter({ prisma }));

  const requireWrite = requireJwtForWrite({ requireAuth, apiKeys });
  // W-C 批三-E：GET 读端点按资源挂 scope 门（_shared/rolePermissionMatrix 真源）。
  // QC 仅持 finance:read（不持 vouchers/invoices/vat/remit:read）→ 单据族读面被拒属预期收紧。
  // 权限矩阵全组合审计 P0-3：发票列表此前仅模块认证门，QC 无 invoices:read 却可拉全公司
  // 发票列表——2026-09-03 起 GET / 挂 requireInvoicesRead（与 /:id 详情同门）。API-Key
  // 无映射 principal 时同样 401（与 /vouchers 列表口径一致），契约测试已同步收紧。
  const requireVouchersRead = requirePermission('vouchers:read');
  const requireInvoicesRead = requirePermission('invoices:read');
  const requireVatRead = requirePermission('vat:read');
  const requireRemitRead = requirePermission('remit:read');
  const requireFinanceRead = requirePermission('finance:read');
  // S3 走查 ε 车道：写端点从 legacy HIGH_RISK_ROLES（owner/admin/manager/finance，SM 实锤可写
  // 凭证/VAT/结汇）收编为资源 scope 门（rolePermissionMatrix 真源）。效果：FINANCE 全通；
  // SM 无财务写 scope → 403；ADMIN 按文档 §6.6 业务只读 → 403（预期收紧）；owner/超管特判全通。
  // 矩阵无 fx:write scope 且本路由无汇率写端点（汇率行情在 risk/systemConfig 域），无需 fx 门。
  const requireInvoicesWrite = requirePermission('invoices:write');
  const requireVouchersWrite = requirePermission('vouchers:write');
  const requireInvoicesReconcile = requirePermission('invoices:reconcile');
  const requireVatWrite = requirePermission('vat:write');
  const requireRemitWrite = requirePermission('remit:write');
  const dunningService = createDunningService(prisma);
  // P0-2：催款分级状态机（提醒→催款→严催→法务准备；auto 定级 + manual 钉住合成）
  const dunningStageService = createDunningStageService(prisma);

  // High-risk role guard: owner/admin/manager only

  // GET /api/v1/finance — list / search（P0-3：挂 invoices:read 门，QC 无此 scope → 403）
  router.get('/', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const where: any = { deletedAt: null };
    if (req.query.type) where.type = String(req.query.type);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.orderId) {
      const orderId = String(req.query.orderId);
      const linked = await prisma.invoiceOrderAllocation.findMany({
        where: { orderId, deletedAt: null }, select: { invoiceId: true },
      });
      where.AND = [{ OR: [{ orderId }, { id: { in: [...new Set(linked.map(row => row.invoiceId))] } }] }];
    }
    if (req.query.customerRelationId) where.customerRelationId = String(req.query.customerRelationId);
    if (req.query.customer) where.customerName = { contains: String(req.query.customer), mode: 'insensitive' };
    if (req.query.search) {
      const q = String(req.query.search);
      const qInsensitive = { contains: q, mode: 'insensitive' };
      where.OR = [{ invoiceNumber: qInsensitive }, { customerName: qInsensitive }];
    }
    const visible = await visibleFinanceInvoiceWhere(prisma, (req as any).actor ?? null, where);
    const [items, total] = await Promise.all([
      prisma.invoice.findMany({ where: visible.where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      prisma.invoice.count({ where: visible.where }),
    ]);
    // DR-044 净额口径：附 appliedAmount/openAmount（InvoiceAllocation 真源派生）
    const itemsWithOpen = await attachAllocationDerivedFields(prisma, items as any[], 'invoice');
    const itemsWithCategory = await attachInvoiceCategoryFields(prisma, itemsWithOpen);
    for (const item of items) await requireFinanceInvoiceAccess(prisma, (req as any).actor ?? null, item.id);
    await visible.access.finish();
    res.json({ items: serializeFinanceValue(itemsWithCategory), total });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '财务单据列表加载失败，请稍后重试；持续失败请联系管理员核对财务数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // Logistics issues the CI; Finance sees it here and records the matching AR.
  router.get('/business-ci-pending', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const result = await listPendingBusinessCiReceivables(prisma, (req as any).actor ?? null, {
        limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0,
      });
      res.json(serializeFinanceValue(result));
    } catch (err) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '待登记 CI 加载失败，请刷新后重试。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // Read-only reconciliation: the canonical command refuses creation in this mode.
  router.post('/bulk-first/reconcile', requireInvoicesWrite, async (req: Request, res: Response) => {
    if (!req.body?.bulkFirstIntent) { res.status(400).json({ error: { code: 'INVALID_INPUT', message: '请保留完整原开票请求核对。' } }); return; }
    const result = await createInvoice({ prisma, input: { ...req.body, bulkFirstIntent: { ...req.body.bulkFirstIntent, mode: 'reconcile' } }, actorId: actorIdFromRequest(req), actor: (req as any).actor ?? null, ip: req.ip || null });
    if (!result.ok) { res.status(lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error, ...(result.bulkFirstRejection ? { bulkFirstRejection: result.bulkFirstRejection } : {}) }); return; }
    res.json(serializeFinanceValue({ ...result.data!.invoice, bulkFirstAcknowledgement: result.data!.bulkFirstAcknowledgement, replayed: true }));
  });

  router.post('/business-ci/:documentId/register', requireWrite, requireInvoicesWrite, async (req: Request, res: Response) => {
    try {
      if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
        throw businessError('INVALID_INPUT', 'CI 应收金额、客户和订单分配均由已签发原票自动带入，不接受手工改写。');
      const result = await registerIssuedBusinessCiReceivable(prisma, req.params.documentId,
        (req as any).actor ?? null, actorIdFromRequest(req), req.ip || null);
      if (!result.replayed) onDataChange?.({ entity: 'finance', action: 'register_business_ci', ids: [result.invoice.id] });
      res.status(result.replayed ? 200 : 201).json(serializeFinanceValue({ item: result.invoice, replayed: result.replayed }));
    } catch (err) {
      const se = safeRouteError(err, { fallbackCode: 'HANDOFF_CONFLICT', fallbackMessage: 'CI 应收登记结果暂不可确认，请刷新待登记清单后核对。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance — create (high risk, approval upstream)
  router.post('/', requireInvoicesWrite, async (req: Request, res: Response) => {
    const result = await createInvoice({
      prisma,
      input: req.body as FinanceCreateInput,
      actorId: actorIdFromRequest(req),
      actor: (req as any).actor ?? null,
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { INVALID_STATUS: 400, INVALID_TRANSITION: 400, INVALID_CURRENT_STATUS: 400, INVALID_AMOUNT: 400, INVALID_CURRENCY: 400, INVALID_VOUCHER_CATEGORY: 400, INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH: 409, INVOICE_CUSTOMER_MISMATCH: 409, LINE_ALREADY_ALLOCATED: 409, CREATE_FAILED: 500 };
      // ★ 漏码不再兜成 500：本地表没有的码去查**注册表真源**（shared/errorCodes），查到几就是几。
      //   为什么不往上面那张表里加码 —— 它是 §9 B32 冻结的本地映射（149 条，只减不增），
      //   新码登记进真源才是收敛方向（G-4 的 LC_GATE_BLOCKED / LC_EXCEPTION_CHECK_FAILED 即走这条路）。
      //   真源也没有才落 500（那才是"服务端自己没结论"）。
      const status = statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500;
      res.status(status).json({ error: result.error, ...(result.bulkFirstRejection ? { bulkFirstRejection: result.bulkFirstRejection } : {}) });
      return;
    }
    const created = result.data!.invoice;
    if (!result.data!.replayed) onDataChange?.({ entity: 'finance', action: 'create', ids: [created.id] });
    res.status(result.data!.replayed ? 200 : 201).json(serializeFinanceValue(result.data!.bulkFirstAcknowledgement ? { ...created, bulkFirstAcknowledgement: result.data!.bulkFirstAcknowledgement, replayed: !!result.data!.replayed } : created));
  });

  // ────────────────────────────────────────────────────────────────
  // 收付款凭证（PaymentVoucher） — /api/v1/finance/vouchers
  // ⚠️ 字面路由 /vouchers 必须在参数路由 /:id 之前，否则 Express 会
  //    把 /vouchers 匹配到 /:id（id='vouchers'）导致 404。
  // ────────────────────────────────────────────────────────────────

  // GET /api/v1/finance/vouchers — list / search
  router.get('/vouchers', requireVouchersRead, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const where: any = { deletedAt: null };
    if (req.query.type) where.type = String(req.query.type);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.orderId) where.orderId = String(req.query.orderId);
    if (req.query.invoiceId) where.invoiceId = String(req.query.invoiceId);
    if (req.query.customer) where.customerName = { contains: String(req.query.customer), mode: 'insensitive' };
    if (req.query.search) {
      const q = String(req.query.search);
      const qInsensitive = { contains: q, mode: 'insensitive' };
      where.OR = [{ voucherNumber: qInsensitive }, { customerName: qInsensitive }];
    }
    const visible = await visibleFinanceObjectWhere(prisma, (req as any).actor, 'voucher', where);
    const [items, total] = await Promise.all([
      (prisma as any).paymentVoucher.findMany({ where: visible.where, take: limit, skip: offset, orderBy: { createdAt: 'desc' } }),
      (prisma as any).paymentVoucher.count({ where: visible.where }),
    ]);
    // DR-044 净额口径：附 appliedAmount/openAmount（InvoiceAllocation 真源派生）
    const itemsWithOpen = await attachAllocationDerivedFields(prisma, items as any[], 'voucher');
    await visible.access.finish();
    res.json({ items: serializeFinanceValue(itemsWithOpen), total });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '收付款凭证列表加载失败，请稍后重试；持续失败请联系管理员核对凭证数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/vouchers/:id
  router.get('/vouchers/:id', requireVouchersRead, async (req: Request, res: Response) => {
    try {
      const { row: item, access } = await requireFinanceObjectAccess(prisma, (req as any).actor, 'voucher', req.params.id, ['vouchers:read']);
      const [withAmounts] = await attachAllocationDerivedFields(prisma, [item], 'voucher');
      await access.finish();
      res.json(serializeFinanceValue(withAmounts));
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'GET_FAILED', fallbackMessage: '该凭证详情加载失败，请稍后重试；若反复出现请核对凭证编号是否正确。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance/vouchers — create (high risk, approval upstream)
  router.post('/vouchers', requireVouchersWrite, async (req: Request, res: Response) => {
    // task ERP-P1-payment-voucher-mutation-shared-service-foundation: route 只调用 service
    const result = await createPaymentVoucher({
      prisma,
      input: req.body as VoucherCreateInput,
      actorId: actorIdFromRequest(req),
      actor: (req as any).actor ?? null,
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { VALIDATION_ERROR: 400, INVALID_STATUS: 400, INVALID_AMOUNT: 400, INVALID_CURRENCY: 400, INVALID_VOUCHER_CATEGORY: 400, PAYMENT_REQUEST_REQUIRED: 403, PAYMENT_REQUEST_ALREADY_LINKED: 409, CREATE_FAILED: 500 };
      /**
       * ★ 2026-09-29：与上面那张表（:313-319）**同一口径** —— `INVALID_FEE_BEARER` 登记进真源
       *   `shared/errorCodes`，**不往 B32 冻结的本地映射里加**（那张表只减不增；D7 当初加了两处，
       *   实测让 `finance/route.ts` 从 149 涨到 151，触发棘轮）。
       *   漏码去查注册表真源，真源也没有才落 500（那才是"服务端自己没结论"）。
       *   行为不变：本码在本地表与真源两处都取 400。
       */
      const error = result.error;
      const status = statusCodeMap[error.code] ?? lookupErrorCode(error.code)?.status ?? 500;
      res.status(status).json({ error });
      return;
    }
    const created = result.data!.voucher;
    onDataChange?.({ entity: 'finance.vouchers', action: 'create', ids: [created.id] });
    res.status(201).json(serializeFinanceValue({...created,financeCommand:result.data.financeCommand}));
  });

  // PATCH /api/v1/finance/vouchers/:id
  router.patch('/vouchers/:id', requireVouchersWrite, async (req: Request, res: Response) => {
    // task ERP-P1-payment-voucher-mutation-shared-service-foundation: route 只调用 service
    const result = await updatePaymentVoucher({
      prisma,
      voucherId: req.params.id,
      input: req.body as any,
      actorId: actorIdFromRequest(req),
      actor: (req as any).actor ?? null,
      ip: req.ip || null,
    });
    if (!result.ok) {
      // ★ 2026-09-29：口径同上一处（见上面那段注释）—— 新码登记进真源、不往 B32 冻结的本地映射里加。
      const statusCodeMap: Record<string, number> = { INVALID_STATUS: 400, INVALID_AMOUNT: 400, INVALID_CURRENCY: 400, INVALID_VOUCHER_CATEGORY: 400, NOT_FOUND: 404, STATUS_NOT_MANUAL_SETTABLE: 400, UPDATE_FAILED: 500 };
      const error = result.error;
      const status = statusCodeMap[error.code] ?? lookupErrorCode(error.code)?.status ?? 500;
      res.status(status).json({ error });
      return;
    }
    const updated = result.data!.voucher;
    onDataChange?.({ entity: 'finance.vouchers', action: 'update', ids: [updated.id] });
    res.json(serializeFinanceValue({...updated,financeCommand:result.data.financeCommand}));
  });


  // ────────────────────────────────────────────────────────────────
  // 收付款核销明细（InvoiceAllocation） — /api/v1/finance/allocations
  // task ERP-P1-payment-allocation-route-foundation
  // 业务写入 + status 重算 + AuditLog 同事务闭环（fail closed）
  // ────────────────────────────────────────────────────────────────

  // task ERP-P1: DELETE /vouchers/:id — Voucher 软删（调 voidDeleteService，allocation 阻断）
  // POST /api/v1/finance/vouchers/:id/cancel — cancel (void) voucher
  router.post('/vouchers/:id/cancel', requireVouchersWrite, async (req: Request, res: Response) => {
    const result = await cancelVoucher({
      prisma,
      voucherId: req.params.id,
      actorId: actorIdFromRequest(req),
      actor: (req as any).actor ?? null, requestKey: req.body?.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt,
      reason: req.body?.reason,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { VOUCHER_NOT_FOUND: 404, HAS_ALLOCATIONS: 400, INVALID_STATUS: 400, CANCEL_FAILED: 500 };
      const error = result.error!;
      res.status(statusCodeMap[error.code] ?? lookupErrorCode(error.code)?.status ?? 500).json({ error });
      return;
    }
    res.json(serializeFinanceValue({ok:true,...result.data}));
  });

  router.delete('/vouchers/:id', requireVouchersWrite, async (req: Request, res: Response) => {
    try {
      const result = await deleteVoucher({
        prisma, voucherId: req.params.id, actorId: actorIdFromRequest(req), actor: (req as any).actor ?? null,
        requestKey: req.body?.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt,
      });
      if (!result.ok) {
        const statusCodeMap: Record<string, number> = { INVOICE_NOT_FOUND: 404, VOUCHER_NOT_FOUND: 404, INVALID_STATUS: 400, HAS_ALLOCATIONS: 409, HANDOFF_CONFLICT: 409, CANCEL_FAILED: 500, DELETE_FAILED: 500 };
        const error = result.error!;
        res.status(statusCodeMap[error.code] ?? lookupErrorCode(error.code)?.status ?? 500).json({ ok: false, error });
        return;
      }
      onDataChange?.({ entity: 'finance', action: 'delete_voucher', ids: [req.params.id] });
      res.json(serializeFinanceValue({ok:true,...result.data}));
    } catch (err: any) {
      logger.error('[finance] DELETE /vouchers/:id failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'DELETE_FAILED', fallbackMessage: '该凭证未能作废，这张凭证仍然保留，请稍后重试；持续失败请联系管理员。' });
      res.status(se.status).json({ ok: false, error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/allocations — list/query
  router.get('/allocations', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const { items, total } = await listVisibleFinanceAllocations(prisma, (req as any).actor ?? null, {
        invoiceId: req.query.invoiceId ? String(req.query.invoiceId) : undefined,
        voucherId: req.query.voucherId ? String(req.query.voucherId) : undefined,
        limit: Number(req.query.limit) || 200,
      });
      res.json({ items, total });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '核销分配记录加载失败，请稍后重试；持续失败请联系管理员核对核销数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance/allocations — create（apply voucher to invoice）
  router.post('/allocations', requireInvoicesReconcile, async (req: Request, res: Response) => {
    const result = await createAllocation({ prisma, input: req.body, actor: (req as any).actor ?? null, actorId: actorIdFromRequest(req), ip: req.ip || null });
    if (!result.ok) {
      // 2026-09-17 真库演练 T5：applyAllocation 的业务校验码（币种不符 / 超额 / 状态不允许）
      // 此前不在白名单 → 兜成 CREATE_FAILED → 500。财务看到「服务器错误」，
      // 实际只是「币种不一致」，不知道该改什么。这些码统一映射 400（可自助修正）。
      const statusCodeMap: Record<string, number> = {
        MISSING_INVOICE: 400, MISSING_VOUCHER: 400, MISSING_AMOUNT: 400, INVALID_AMOUNT: 400,
        INVALID_INVOICE_STATUS: 400, INVALID_VOUCHER_STATUS: 400, CURRENCY_MISMATCH: 400,
        PAYABLE_SUPPLIER_IDENTITY_REQUIRED: 409, PAYABLE_SUPPLIER_MISMATCH: 409,
        AMOUNT_EXCEEDS_INVOICE: 400, AMOUNT_EXCEEDS_VOUCHER: 400,
        AMOUNT_EXCEEDS_INVOICE_REMAINING: 400, AMOUNT_EXCEEDS_VOUCHER_REMAINING: 400,
        INVOICE_NOT_FOUND: 404, VOUCHER_NOT_FOUND: 404, NOT_FOUND: 404, CONFLICT: 409, CREATE_FAILED: 500,
      };
      const error = result.error!;
      res.status(statusCodeMap[error.code] ?? lookupErrorCode(error.code)?.status ?? 500).json({ error });
      return;
    }
    const allocId = result.data!.allocation.id;
    onDataChange?.({ entity: 'finance.allocations', action: 'create', ids: [allocId] });
    res.status(201).json(result.data);
  });

  // ══════════════════════════════════════════════════════════════════
  // 收款匹配可查看；claim 会写正式核销，必须与 allocations 共用财务核销权限。
  // 业务员匹配不等于财务批准，禁止先记账后复核。
  // GET /api/v1/finance/receipt-claims — 业务员可见的待认领收款
  router.get('/receipt-claims', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const visibleOrderIds = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      const result = await listClaimableReceipts(prisma, {
        visibleOrderIds,
        limit: Number(req.query.limit) || undefined,
      });
      if (!result.ok) return res.status(500).json({ error: result.error });
      res.json({ items: result.data ?? [], total: result.data?.length ?? 0 });
    } catch (e: any) {
      const se = safeRouteError(e, { fallbackCode: 'LIST_FAILED', fallbackMessage: '待认领收款列表加载失败，请稍后重试；持续失败请联系管理员核对收款数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.get('/receipt-claims/:voucherId/suggestion', requireInvoicesReconcile, async (req: Request, res: Response) => {
    try {
      const visibleOrderIds = await resolveVisibleOrderIds(prisma, (req as any).actor ?? null);
      if (visibleOrderIds !== null) {
        const visible = await listClaimableReceipts(prisma, { visibleOrderIds });
        if (!visible.ok || !visible.data?.some(item => item.voucherId === req.params.voucherId)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '收款不存在或不在当前可见范围' } });
      }
      const result = await suggestReceiptAllocation(prisma, { sourceEntityId: req.params.voucherId, payload: {}, id: 'finance-preview' });
      if (!result.ok) return res.status(400).json({ error: { code: 'SUGGESTION_FAILED', message: '匹配建议暂不可用，请核对收款凭证后重试' } });
      if (result.created && visibleOrderIds !== null) {
        const invoice = await prisma.invoice.findUnique({ where: { id: result.created.invoiceId }, select: { orderId: true } });
        const orderIds = await resolveInvoiceOrderIds(prisma, result.created.invoiceId, invoice?.orderId ?? null);
        if (!orderIds.some(id => visibleOrderIds.includes(id))) return res.json({ suggestion: null });
      }
      return res.json({ suggestion: result.created ?? null });
    } catch (e) {
      const se = safeRouteError(e, { fallbackCode: 'SUGGESTION_FAILED', fallbackMessage: '匹配建议加载失败，请稍后重试。' });
      return res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance/receipt-claims/claim — 财务明确确认后写核销
  router.post('/receipt-claims/claim', requireInvoicesReconcile, async (req: Request, res: Response) => {
    const { voucherId, invoiceId, amount, requestId } = req.body ?? {};
    if (!voucherId || !invoiceId || amount == null || typeof requestId !== 'string' || !requestId.trim() || requestId.length > 128) {
      return res.status(400).json({ error: { code: 'MISSING_INPUT', message: 'voucherId / invoiceId / amount / requestId 必填' } });
    }
    try {
    const result = await claimReceipt(prisma, {
      voucherId: String(voucherId),
      invoiceId: String(invoiceId),
      amount: Number(amount),
      requestId,
      actorId: actorIdFromRequest(req),
      actor: (req as any).actor ?? null,
      ip: req.ip ?? null,
      visibleOrderIds: await resolveVisibleOrderIds(prisma, (req as any).actor ?? null),
    });
    if (!result.ok) {
      const map: Record<string, number> = {
        // 注：原 CUSTOMER_MISMATCH（跨客户认领硬拒）已按 L2 高危 3 号口径移除 ——
        // 第三方代付改为「允许 + 留痕」（判定真源 finance/thirdPartyPaymentGuard.ts）。
        INVALID_AMOUNT: 400, AMOUNT_EXCEEDED: 400, CURRENCY_MISMATCH: 400,
        NOT_A_RECEIPT: 400, NOT_RECEIVABLE: 400, VOUCHER_RECONCILED: 409, INVOICE_NOT_CLAIMABLE: 409,
        INVOICE_NOT_VISIBLE: 404, VOUCHER_NOT_FOUND: 404, INVOICE_NOT_FOUND: 404, CONFLICT: 409,
      };
      return res.status(map[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
    }
    onDataChange?.({ entity: 'finance.allocations', action: 'create', ids: [result.data!.allocationId] });
    res.status(201).json(result.data);
    } catch {
      return res.status(500).json({ error: { code: 'CLAIM_FAILED', message: '核销结果暂不可确认，请使用原请求重试并核对余额。' } });
    }
  });

  // PATCH /api/v1/finance/allocations/:id — update + status 重算
  router.patch('/allocations/:id', requireInvoicesReconcile, async (req: Request, res: Response) => {
    const result = await updateAllocation({ prisma, allocationId: req.params.id, input: req.body, actor: (req as any).actor ?? null, actorId: actorIdFromRequest(req), ip: req.ip || null });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { INVALID_AMOUNT: 400, NOT_FOUND: 404, CONFLICT: 409, UPDATE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'finance.allocations', action: 'update', ids: [req.params.id] });
    res.json(result.data);
  });

  // DELETE /api/v1/finance/allocations/:id — delete（撤销核销）+ status 反向重算
  router.delete('/allocations/:id', requireInvoicesReconcile, async (req: Request, res: Response) => {
    const result = await deleteAllocation({ prisma, allocationId: req.params.id, actor: (req as any).actor ?? null, actorId: actorIdFromRequest(req), ip: req.ip || null });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, CONFLICT: 409, DELETE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'finance.allocations', action: 'delete', ids: [req.params.id] });
    res.json(result.data);
  });

  // ────────────────────────────────────────────────────────────────
  // 结汇水单（FxSettlement） — /api/v1/finance/fx-settlements
  // 阶段 F / F2 外汇核销闭环：收汇凭证 → 结汇 → 台账
  // ⚠️ 字面路由 /fx-settlements 必须在参数路由 /:id 之前注册。
  // ────────────────────────────────────────────────────────────────

  // GET /api/v1/finance/fx-settlements/ledger — 外汇台账（只读聚合）
  router.get('/fx-settlements/ledger', requireRemitRead, async (req: Request, res: Response) => {
    try {
      const ledger = await getFxLedger(prisma, {
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(serializeFinanceValue(ledger));
    } catch (err: any) {
      logger.error('[finance] GET /fx-settlements/ledger failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'LEDGER_FAILED', fallbackMessage: '结汇台账加载失败，请稍后重试；持续失败请联系管理员核对结汇数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/fx-settlements — list / search
  router.get('/fx-settlements', requireRemitRead, async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const where: any = { deletedAt: null };
      if (req.query.voucherId) where.voucherId = String(req.query.voucherId);
      if (req.query.orderId) where.orderId = String(req.query.orderId);
      if (req.query.customerRelationId) where.customerRelationId = String(req.query.customerRelationId);
      if (req.query.currency) where.currency = String(req.query.currency);
      if (req.query.from) where.settleDate = { ...(where.settleDate || {}), gte: String(req.query.from) };
      if (req.query.to) where.settleDate = { ...(where.settleDate || {}), lte: String(req.query.to) };
      const [items, total] = await Promise.all([
        (prisma as any).fxSettlement.findMany({ where, take: limit, skip: offset, orderBy: { settleDate: 'desc' } }),
        (prisma as any).fxSettlement.count({ where }),
      ]);
      res.json(serializeFinanceValue({ items, total }));
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '结汇记录列表加载失败，请稍后重试；持续失败请联系管理员核对结汇数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/fx-settlements/:id
  router.get('/fx-settlements/:id', requireRemitRead, async (req: Request, res: Response) => {
    try {
      const item = await (prisma as any).fxSettlement.findUnique({ where: { id: req.params.id } });
      if (!item || item.deletedAt) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '结汇水单不存在' } });
      res.json(serializeFinanceValue(item));
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'GET_FAILED', fallbackMessage: '该结汇记录加载失败，请稍后重试；若反复出现请核对记录编号是否正确。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance/fx-settlements — create（核销校验 + cnyAmount 服务端计算）
  router.post('/fx-settlements', requireRemitWrite, async (req: Request, res: Response) => {
    const result = await createFxSettlement({
      prisma,
      input: req.body,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        INVALID_INPUT: 400, INVALID_AMOUNT: 400, INVALID_DATE: 400,
        VOUCHER_NOT_FOUND: 404, NOT_A_RECEIPT: 400, CNY_VOUCHER_NO_SETTLEMENT: 400,
        CURRENCY_MISMATCH: 400, OVER_SETTLEMENT: 409, CREATE_FAILED: 500,
      };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    const created = result.data!.settlement;
    onDataChange?.({ entity: 'finance.fx-settlements', action: 'create', ids: [created.id] });
    res.status(201).json(serializeFinanceValue(created));
  });

  // DELETE /api/v1/finance/fx-settlements/:id — 软删（回滚核销余额）
  router.delete('/fx-settlements/:id', requireRemitWrite, async (req: Request, res: Response) => {
    const result = await deleteFxSettlement({
      prisma,
      settlementId: req.params.id,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { SETTLEMENT_NOT_FOUND: 404, DELETE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
      return;
    }
    onDataChange?.({ entity: 'finance.fx-settlements', action: 'delete', ids: [req.params.id] });
    res.json({ ok: true });
  });

  /**
   * ★ D6（2026-09-18）远期结汇合约（与银行签的远期）。
   *
   * 为什么需要：本仓已有 `FxRateLock`（订单级锁汇）与 `FxSettlement`（结汇水单），
   * 缺的是**与银行的远期合约**这一层 ⇒ 到期日没人管、合约汇率 vs 实际结汇汇率的**损益**算不出来。
   */
  router.get('/forward-fx', requireRemitRead, async (req: Request, res: Response) => {
    const r = await listForwardFxContracts(prisma, {
      currency: req.query.currency ? String(req.query.currency) : undefined,
      includeCancelled: req.query.includeCancelled === 'true',
    });
    if (!r.ok) { res.status(r.error.status).json({ error: r.error }); return; }
    res.json(serializeFinanceValue(r.data));
  });

  router.post('/forward-fx', requireRemitWrite, async (req: Request, res: Response) => {
    const r = await createForwardFxContract(prisma, req.body ?? {}, actorIdFromRequest(req));
    if (!r.ok) {
      const statusCodeMap: Record<string, number> = {
        INVALID_INPUT: 400, INVALID_AMOUNT: 400, INVALID_DATE: 400,
        DUPLICATE_CONTRACT: 409, CREATE_FAILED: 500,
      };
      res.status(statusCodeMap[r.error!.code] || 500).json({ error: r.error });
      return;
    }
    const created = r.data!.contract;
    onDataChange?.({ entity: 'finance.forward-fx', action: 'create', ids: [created.id] });
    res.status(201).json(serializeFinanceValue(created));
  });

  /** 远期合约交割（一笔合约可分次交割；一笔结汇水单只能挂一张合约；损益 = (实际汇率 − 合约汇率) × 本次金额（CNY） */
  router.post('/forward-fx/:id/settlements', requireRemitWrite, async (req: Request, res: Response) => {
    const r = await settleForwardFx(prisma, {
      contractId: req.params.id,
      settlementId: String((req.body ?? {}).settlementId ?? ''),
      foreignAmount: (req.body ?? {}).foreignAmount,
      settleDate: (req.body ?? {}).settleDate,
    }, actorIdFromRequest(req));
    if (!r.ok) {
      const statusCodeMap: Record<string, number> = {
        INVALID_INPUT: 400, INVALID_AMOUNT: 400, CURRENCY_MISMATCH: 400,
        CONTRACT_NOT_FOUND: 404, SETTLEMENT_NOT_FOUND: 404,
        CONTRACT_CANCELLED: 409, SETTLEMENT_ALREADY_LINKED: 409, LINK_ALREADY_EXISTS: 409,
        OVER_CONTRACT: 409, OVER_SETTLEMENT: 409, SETTLE_FAILED: 500,
      };
      res.status(statusCodeMap[r.error!.code] || 500).json({ error: r.error });
      return;
    }
    onDataChange?.({ entity: 'finance.forward-fx', action: 'settle', ids: [r.data!.contract.id] });
    res.status(201).json(serializeFinanceValue(r.data!));
  });

  // GET /api/v1/finance/vouchers/:id/settlements — 凭证核销摘要（已结汇/余额/明细）
  router.get('/vouchers/:id/settlements', requireVouchersRead, async (req: Request, res: Response) => {
    const result = await getVoucherSettlementSummary(prisma, req.params.id);
    if (!result.ok) {
      res.status(result.error!.code === 'VOUCHER_NOT_FOUND' ? 404 : 500).json({ error: result.error });
      return;
    }
    res.json(serializeFinanceValue(result.data));
  });

  // ────────────────────────────────────────────────────────────────
  // 付汇水单（OutwardRemittance） — /api/v1/finance/outward-remittances
  // 阶段 C6：付款凭证 → 购汇/自有外汇 → 境外付汇（镜像 fx-settlements 付款侧）
  // ⚠️ 字面路由必须在参数路由 /:id 之前注册。
  // ────────────────────────────────────────────────────────────────

  // GET /api/v1/finance/outward-remittances — list / search
  router.get('/outward-remittances', requireRemitRead, async (req: Request, res: Response) => {
    try {
      const result = await listOutwardRemittances(prisma, {
        voucherId: req.query.voucherId ? String(req.query.voucherId) : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(serializeFinanceValue(result));
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '付汇记录列表加载失败，请稍后重试；持续失败请联系管理员核对付汇数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance/outward-remittances — create（余额校验 + cnyAmount 服务端计算）
  router.post('/outward-remittances', requireRemitWrite, async (req: Request, res: Response) => {
    const result = await createOutwardRemittance({
      prisma,
      input: req.body,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        INVALID_INPUT: 400, INVALID_AMOUNT: 400, INVALID_DATE: 400, INVALID_PURPOSE: 400,
        VOUCHER_NOT_FOUND: 404, NOT_A_DISBURSEMENT: 400, CNY_VOUCHER_NO_REMITTANCE: 400,
        CURRENCY_MISMATCH: 400, OVER_REMITTANCE: 409, CREATE_FAILED: 500,
      };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    const created = result.data!.remittance;
    onDataChange?.({ entity: 'finance.outward-remittances', action: 'create', ids: [created.id] });
    res.status(201).json(serializeFinanceValue(created));
  });

  // DELETE /api/v1/finance/outward-remittances/:id — 软删（回滚未付余额）
  router.delete('/outward-remittances/:id', requireRemitWrite, async (req: Request, res: Response) => {
    const result = await deleteOutwardRemittance({
      prisma,
      remittanceId: req.params.id,
      actorId: actorIdFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { REMITTANCE_NOT_FOUND: 404, DELETE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
      return;
    }
    onDataChange?.({ entity: 'finance.outward-remittances', action: 'delete', ids: [req.params.id] });
    res.json({ ok: true });
  });

  // GET /api/v1/finance/vouchers/:id/remittances — 凭证付汇摘要（已付汇/余额/明细）
  router.get('/vouchers/:id/remittances', requireVouchersRead, async (req: Request, res: Response) => {
    const result = await getVoucherRemittanceSummary(prisma, req.params.id);
    if (!result.ok) {
      res.status(result.error!.code === 'VOUCHER_NOT_FOUND' ? 404 : 500).json({ error: result.error });
      return;
    }
    res.json(serializeFinanceValue(result.data));
  });

  // ────────────────────────────────────────────────────────────────
  // 增值税发票（VatInvoice） — /api/v1/finance/vat-invoices
  // 阶段 C6：专票全生命周期（收票→认证→申报退税→红冲/作废）
  // ────────────────────────────────────────────────────────────────

  // GET /api/v1/finance/vat-invoices — list / search
  router.get('/vat-invoices', requireVatRead, async (req: Request, res: Response) => {
    try {
      const result = await listVatInvoices(prisma, {
        status: req.query.status ? String(req.query.status) : undefined,
        direction: req.query.direction ? String(req.query.direction) : undefined,
        relationId: req.query.relationId ? String(req.query.relationId) : undefined,
        taxRefundId: req.query.taxRefundId ? String(req.query.taxRefundId) : undefined,
        invoiceId: req.query.invoiceId ? String(req.query.invoiceId) : undefined,
        orderId: req.query.orderId ? String(req.query.orderId) : undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      }, extractActorFromRequest(req));
      res.json(serializeFinanceValue(result));
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'LIST_FAILED', fallbackMessage: '增值税发票列表加载失败，请稍后重试；持续失败请联系管理员核对发票数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance/vat-invoices — create（金额三栏校验 + 查重）
  router.post('/vat-invoices', requireVatWrite, async (req: Request, res: Response) => {
    const result = await createVatInvoice({
      prisma,
      input: req.body,
      actorId: actorIdFromRequest(req),
      actor: extractActorFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        INVALID_INPUT: 400, INVALID_AMOUNT: 400, INVALID_DATE: 400,
        AMOUNT_MISMATCH: 400, TAX_MISMATCH: 400,
        DUPLICATE_VAT_INVOICE: 409, CREATE_FAILED: 500,
      };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    const created = result.data!.vatInvoice;
    onDataChange?.({ entity: 'finance.vat-invoices', action: 'create', ids: [created.id] });
    res.status(201).json(serializeFinanceValue({...created,financeCommand:result.data.financeCommand}));
  });

  // GET /api/v1/finance/vat-invoices/:id
  router.get('/vat-invoices/:id', requireVatRead, async (req: Request, res: Response) => {
    const result = await getVatInvoice(prisma, req.params.id, extractActorFromRequest(req));
    if (!result.ok) {
      res.status(lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    res.json(serializeFinanceValue(result.data.vatInvoice));
  });

  // PATCH /api/v1/finance/vat-invoices/:id — 票面修正（Declared/RedFlushed/Cancelled 不可改）
  router.patch('/vat-invoices/:id', requireVatWrite, async (req: Request, res: Response) => {
    const result = await updateVatInvoice({
      prisma,
      vatInvoiceId: req.params.id,
      patch: req.body ?? {},
      actorId: actorIdFromRequest(req),
      actor: extractActorFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        NOT_FOUND: 404, INVALID_STATUS: 409, INVALID_INPUT: 400, INVALID_AMOUNT: 400,
        INVALID_DATE: 400, AMOUNT_MISMATCH: 400, TAX_MISMATCH: 400, UPDATE_FAILED: 500,
      };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'finance.vat-invoices', action: 'update', ids: [req.params.id] });
    res.json(serializeFinanceValue({...result.data!.vatInvoice,financeCommand:result.data.financeCommand}));
  });

  // POST /api/v1/finance/vat-invoices/:id/transition — 状态机（认证/申报退税/红冲/作废）
  router.post('/vat-invoices/:id/transition', requireVatWrite, async (req: Request, res: Response) => {
    const result = await transitionVatInvoiceStatus({
      prisma,
      vatInvoiceId: req.params.id,
      input: req.body ?? {},
      actorId: actorIdFromRequest(req),
      actor: extractActorFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = {
        NOT_FOUND: 404, INVALID_STATUS: 400, INVALID_TRANSITION: 409, INVALID_DATE: 400,
        NOT_INPUT_SPECIAL: 400, TAX_REFUND_REQUIRED: 400, TAX_REFUND_NOT_FOUND: 404,
        TRANSITION_FAILED: 500,
      };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    onDataChange?.({ entity: 'finance.vat-invoices', action: 'transition', ids: [req.params.id] });
    res.json(serializeFinanceValue({...result.data!.vatInvoice,financeCommand:result.data.financeCommand}));
  });

  // DELETE /api/v1/finance/vat-invoices/:id — 软删（Declared 禁删，仅可红冲）
  router.delete('/vat-invoices/:id', requireVatWrite, async (req: Request, res: Response) => {
    const result = await deleteVatInvoice({
      prisma,
      vatInvoiceId: req.params.id,
      requestKey: req.body?.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt,
      actorId: actorIdFromRequest(req),
      actor: extractActorFromRequest(req),
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, DELETE_FORBIDDEN: 409, DELETE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
      return;
    }
    onDataChange?.({ entity: 'finance.vat-invoices', action: 'delete', ids: [req.params.id] });
    res.json(serializeFinanceValue({ok:true,...result.data}));
  });

  // task ERP-P1: POST /:id/cancel — Invoice 作废（调 voidDeleteService）
  router.post('/:id/cancel', requireInvoicesWrite, async (req: Request, res: Response) => {
    try {
      const result = await cancelInvoice({
        prisma, invoiceId: req.params.id,
        actorId: actorIdFromRequest(req), actor: (req as any).actor ?? null, reason: req.body?.reason,
        requestKey: req.body?.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt,
      });
      if (!result.ok) {
        const statusCodeMap: Record<string, number> = { INVOICE_NOT_FOUND: 404, VOUCHER_NOT_FOUND: 404, INVALID_STATUS: 400, HAS_ALLOCATIONS: 409, HANDOFF_CONFLICT: 409, CANCEL_FAILED: 500, DELETE_FAILED: 500 };
        res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
        return;
      }
      onDataChange?.({ entity: 'finance', action: 'cancel', ids: [req.params.id] });
      res.json(serializeFinanceValue({ok:true,...result.data}));
    } catch (err: any) {
      logger.error('[finance] POST /:id/cancel failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'CANCEL_FAILED', fallbackMessage: '该单据未能作废，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' });
      res.status(se.status).json({ ok: false, error: { code: se.code, message: se.message } });
    }
  });

  // task ERP-P1: DELETE /:id — Invoice 软删（调 voidDeleteService，allocation 阻断）
  router.delete('/:id', requireInvoicesWrite, async (req: Request, res: Response) => {
    try {
      const result = await deleteInvoice({
        prisma, invoiceId: req.params.id, actorId: actorIdFromRequest(req), actor: (req as any).actor ?? null,
        requestKey: req.body?.requestKey, expectedUpdatedAt: req.body?.expectedUpdatedAt,
      });
      if (!result.ok) {
        const statusCodeMap: Record<string, number> = { INVOICE_NOT_FOUND: 404, VOUCHER_NOT_FOUND: 404, INVALID_STATUS: 400, HAS_ALLOCATIONS: 409, CANCEL_FAILED: 500, DELETE_FAILED: 500 };
        res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ ok: false, error: result.error });
        return;
      }
      onDataChange?.({ entity: 'finance', action: 'delete', ids: [req.params.id] });
      res.json(serializeFinanceValue({ok:true,...result.data}));
    } catch (err: any) {
      logger.error('[finance] DELETE /:id failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'DELETE_FAILED', fallbackMessage: '该单据未能删除，仍然保留，请稍后重试；持续失败请联系管理员。' });
      res.status(se.status).json({ ok: false, error: { code: se.code, message: se.message } });
    }
  });

  // ────────────────────────────────────────────────────────────────
  // REQ2-08 催款函套件 — /api/v1/finance/dunning（DR-050）
  // 字面路由 /dunning 须在参数路由 /:id 之前注册。
  // ────────────────────────────────────────────────────────────────

  // POST /api/v1/finance/dunning/letter — 中英催款函生成（账龄明细注入，只读预览）
  // §10.7 复扫：函件含客户账龄/逾期明细——挂 invoices:read（对照同域 GET 门）
  router.post('/dunning/letter', requireInvoicesRead, async (req: Request, res: Response) => {
    const result = await dunningService.buildLetter((req.body ?? {}) as any);
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    return res.json({ ok: true, ...result.data });
  });

  // POST /api/v1/finance/dunning — 登记催款记录（快照留痕）
  router.post('/dunning', requireWrite, requireInvoicesWrite, async (req: Request, res: Response) => {
    const result = await dunningService.recordDunning((req.body ?? {}) as any);
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    return res.status(201).json({ ok: true, record: result.data.record });
  });

  // GET /api/v1/finance/dunning?customerRelationId=|customerName= — 催款历史
  router.get('/dunning', requireFinanceRead, async (req: Request, res: Response) => {
    const result = await dunningService.listDunning({
      customerRelationId: req.query.customerRelationId ? String(req.query.customerRelationId) : undefined,
      customerName: req.query.customerName ? String(req.query.customerName) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    if (!result.ok) {
      return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
    }
    return res.json({ ok: true, ...result.data });
  });

  // ────────────────────────────────────────────────────────────────
  // P0-2 催款分级状态机 — /api/v1/finance/dunning/stages
  // 字面路由须在参数路由 /:id 之前注册（同 /dunning 家族）。
  // ────────────────────────────────────────────────────────────────

  // GET /api/v1/finance/dunning/stages — 分级看板（账龄行×P0-1尾款喂入×生效分级，只读零副作用）
  router.get('/dunning/stages', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const result = await dunningStageService.listBoard({
        actor: extractActorFromRequest(req) ?? undefined,
        asOf: req.query.asOf ? String(req.query.asOf) : undefined,
      });
      if (!result.ok) {
        return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
      }
      return res.json({ ok: true, ...result.data });
    } catch (err: any) {
      logger.error('[finance] GET /dunning/stages failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'BOARD_FAILED', fallbackMessage: '催收看板加载失败，请稍后重试；持续失败请联系管理员核对催收数据。' });
      return res.status(se.status).json({ ok: false, error: { code: se.code, message: se.message } });
    }
  });

  // POST /api/v1/finance/dunning/stages/manual — 人工升降级（留痕 routeAudit；stage=none 解除钉住）
  router.post('/dunning/stages/manual', requireWrite, requireInvoicesWrite, async (req: Request, res: Response) => {
    try {
      const result = await dunningStageService.setStageManual({
        customerRelationId: req.body?.customerRelationId ?? null,
        customerName: req.body?.customerName,
        currency: req.body?.currency,
        stage: req.body?.stage,
        reason: req.body?.reason,
        ownerName: req.body?.ownerName ?? null,
        actorId: actorIdFromRequest(req),
        actor: extractActorFromRequest(req) ?? undefined,
      });
      if (!result.ok) {
        return res.status(result.error.status).json({ error: { code: result.error.code, message: result.error.message } });
      }
      return res.json({ ok: true, profile: result.data.profile });
    } catch (err: any) {
      logger.error('[finance] POST /dunning/stages/manual failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'SET_STAGE_FAILED', fallbackMessage: '催收阶段未能更新，本次未确认任何改动，请稍后重试；持续失败请联系管理员。' });
      return res.status(se.status).json({ ok: false, error: { code: se.code, message: se.message } });
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 财务报表（只读） — /api/v1/finance/reports
  // ⚠️ 字面路由 /reports 必须在参数路由 /:id 之前注册。
  // ────────────────────────────────────────────────────────────────

  // GET /api/v1/finance/reports/aging?type=Receivable|Payable&asOf=YYYY-MM-DD
  // 报表导出公用：format=xlsx → Excel 下载（2026-08-22 全系统文档体系——对内分析出 Excel）
  const sendXlsx = (res: Response, fileName: string, sheets: Array<Parameters<typeof buildXlsx>[0][number]>): void => {
    const buffer = buildXlsx(sheets);
    for (const [k, v] of Object.entries(xlsxDownloadHeaders(fileName))) res.setHeader(k, v);
    res.send(buffer);
  };

  router.get('/reports/aging', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const type = String(req.query.type ?? 'Receivable');
      if (type !== 'Receivable' && type !== 'Payable') {
        return res.status(400).json({ error: { code: 'INVALID_TYPE', message: 'type 必须为 Receivable 或 Payable' } });
      }
      const report = await getAgingReport(prisma, { actor: extractActorFromRequest(req) ?? undefined, type, asOf: req.query.asOf ? String(req.query.asOf) : undefined });
      if (req.query.format === 'xlsx') {
        return sendXlsx(res, `账龄分析_${report.type === 'Receivable' ? '应收' : '应付'}_${report.asOf}.xlsx`, agingToSheets(report));
      }
      res.json(report);
    } catch (err: any) {
      logger.error('[finance] GET /reports/aging failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'REPORT_FAILED', fallbackMessage: '应收账龄报表加载失败，请稍后重试；持续失败请联系管理员核对财务数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/reports/statement?customerRelationId=xx&from=YYYY-MM-DD&to=YYYY-MM-DD
  // B9：format=xlsx → Excel 下载（与供应商对账单同款多币种分节 sheet）
  router.get('/reports/statement', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const customerRelationId = String(req.query.customerRelationId ?? '');
      if (!customerRelationId) {
        return res.status(400).json({ error: { code: 'MISSING_CUSTOMER', message: 'customerRelationId is required' } });
      }
      const report = await getCustomerStatement(prisma, {
        actor: extractActorFromRequest(req) ?? undefined,
        customerRelationId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      if (req.query.format === 'xlsx') {
        return sendXlsx(res, statementExportFileName('客户对账单', report.customerName, report.customerCode, report.to), customerStatementToSheets(report));
      }
      res.json(report);
    } catch (err: any) {
      logger.error('[finance] GET /reports/statement failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'REPORT_FAILED', fallbackMessage: '客户对账单加载失败，请稍后重试；持续失败请联系管理员核对往来数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/reports/statement/preview.html — 客户对账单 A4 预览（B9：
  // STMT 服务端模板与 xlsx 同数据形状；与发票 preview.html 同模式，不登记 TradeDocument）
  router.get('/reports/statement/preview.html', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const customerRelationId = String(req.query.customerRelationId ?? '');
      if (!customerRelationId) {
        return res.status(400).json({ error: { code: 'MISSING_CUSTOMER', message: 'customerRelationId is required' } });
      }
      const report = await getCustomerStatement(prisma, {
        actor: extractActorFromRequest(req) ?? undefined,
        customerRelationId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      const html = await renderServerDocument(prisma, 'STMT', report, { screen: true });
      if (!html) return res.status(500).json({ error: { code: 'RENDER_FAILED', message: 'STMT 模板渲染失败' } });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err: any) {
      logger.error('[finance] GET /reports/statement/preview.html failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'REPORT_FAILED', fallbackMessage: '客户对账单预览未能生成，请稍后重试；如持续失败请联系管理员检查单据模板。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/reports/supplier-statement?supplierRelationId=xx&from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get('/reports/supplier-statement', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const supplierRelationId = String(req.query.supplierRelationId ?? '');
      if (!supplierRelationId) {
        return res.status(400).json({ error: { code: 'MISSING_SUPPLIER', message: 'supplierRelationId is required' } });
      }
      const report = await getSupplierStatement(prisma, {
        actor: extractActorFromRequest(req) ?? undefined,
        supplierRelationId,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      if (req.query.format === 'xlsx') {
        return sendXlsx(res, statementExportFileName('供应商对账单', report.supplierName, report.supplierCode, report.to), supplierStatementToSheets(report));
      }
      res.json(report);
    } catch (err: any) {
      logger.error('[finance] GET /reports/supplier-statement failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'REPORT_FAILED', fallbackMessage: '供应商对账单加载失败，请稍后重试；持续失败请联系管理员核对往来数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/reports/fx-gain-loss?from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get('/reports/fx-gain-loss', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const report = await getFxGainLoss(prisma, {
        actor: extractActorFromRequest(req) ?? undefined,
        from: req.query.from ? String(req.query.from) : undefined,
        to: req.query.to ? String(req.query.to) : undefined,
      });
      res.json(report);
    } catch (err: any) {
      logger.error('[finance] GET /reports/fx-gain-loss failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'REPORT_FAILED', fallbackMessage: '汇兑损益报表加载失败，请稍后重试；持续失败请联系管理员核对结汇与汇率数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/reports/cash-calendar?asOf=YYYY-MM-DD&days=30 — REQ2-02 资金日历
  router.get('/reports/cash-calendar', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const report = await getCashCalendar(prisma, {
        actor: extractActorFromRequest(req) ?? undefined,
        asOf: req.query.asOf ? String(req.query.asOf) : undefined,
        days: req.query.days ? Number(req.query.days) : undefined,
      });
      res.json(report);
    } catch (err: any) {
      logger.error('[finance] GET /reports/cash-calendar failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'REPORT_FAILED', fallbackMessage: '资金日历加载失败，请稍后重试；持续失败请联系管理员核对收付款计划数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/reports/consolidated-profit — DR-005/DR-033 公司合并视图（抵销内部交易）
  // 支持 ?from=&to= 按订单日期（Order.poDate）过滤报表范围，响应回显 from/to 元数据
  // P0-1（权限矩阵全组合审计最大敞口）：finance:read 全员持有→合并利润对 Sales/QC/Logistics
  // 明文裸露。出口统一走 maskConsolidatedProfitReport：无 sensitive:cost → 成本/抵销/部门成本
  // 遮罩 null；无 sensitive:profit → 利润/部门利润遮罩 null。JSON 与 xlsx 两路同遮（xlsx 由
  // consolidatedProfitToSheets 消费已遮罩对象）。
  router.get('/reports/consolidated-profit', requireFinanceRead, async (req: Request, res: Response) => {
    try {
      const from = typeof req.query.from === 'string' && req.query.from.trim() ? req.query.from.trim() : undefined;
      const to = typeof req.query.to === 'string' && req.query.to.trim() ? req.query.to.trim() : undefined;
      const report = await getConsolidatedProfitReport(prisma, { from, to, actor: extractActorFromRequest(req) ?? undefined });
      const masked = maskConsolidatedProfitReport(report, req);
      if (req.query.format === 'xlsx') {
        return sendXlsx(res, `合并利润_${to ?? '全部'}.xlsx`, consolidatedProfitToSheets(masked));
      }
      res.json(masked);
    } catch (err: any) {
      logger.error('[finance] GET /reports/consolidated-profit failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'REPORT_FAILED', fallbackMessage: '合并利润报表加载失败，请稍后重试；持续失败请联系管理员核对利润数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/:id — 必须放在 /vouchers 字面路由之后
  // GET /api/v1/finance/category-summary — 发票按派生品类（D8-Q3：由订单 businessLine 派生，不冗余存储）分组汇总
  // T2/H14 验收：面料单与成衣单的发票能按派生品类分别汇总。金额按币种分组（跨币种不裸加——矩阵 §三）。
  // ⚠️ 必须注册在 '/:id' 之前（否则被参数路由吞掉）。
  router.get('/category-summary', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const type = req.query.type ? String(req.query.type) : 'Receivable';
      const status = req.query.status ? String(req.query.status) : undefined;
      const visible = await visibleFinanceInvoiceWhere(prisma, (req as any).actor ?? null, { deletedAt: null, type, ...(status ? { status } : {}) });
      const invoices = await prisma.invoice.findMany({
        where: visible.where,
        orderBy: { createdAt: 'desc' },
      });
      const withDerived = await attachAllocationDerivedFields(prisma, invoices as any[], 'invoice');
      const withCategory = await attachInvoiceCategoryFields(prisma, withDerived);
      await visible.access.finish();
      const groups = new Map<string, { businessLine: string | null; currency: string; invoiceCount: number; totalAmount: number; openAmount: number }>();
      for (const inv of withCategory) {
        const key = `${inv.businessLine ?? 'unknown'}|${inv.currency ?? 'CNY'}`;
        const g = groups.get(key) ?? { businessLine: inv.businessLine ?? null, currency: inv.currency ?? 'CNY', invoiceCount: 0, totalAmount: 0, openAmount: 0 };
        g.invoiceCount += 1;
        g.totalAmount = round4(g.totalAmount + Number(inv.amount));
        g.openAmount = round4(g.openAmount + Number(inv.openAmount ?? inv.amount));
        groups.set(key, g);
      }
      res.json({ items: [...groups.values()].sort((a, b) => b.totalAmount - a.totalAmount), total: invoices.length });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'SUMMARY_FAILED', fallbackMessage: '费用分类汇总加载失败，请稍后重试；持续失败请联系管理员核对财务数据。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  router.get('/:id', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const { invoice: item, access } = await requireFinanceInvoiceAccess(prisma, (req as any).actor ?? null, req.params.id);
      // DR：发票 ↔ 订单 多对多——附带该发票的订单分配列表（含订单号/PO 快照）
      const orderAllocations = await (prisma as any).invoiceOrderAllocation.findMany({
        where: { invoiceId: item.id, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      const [withAmounts] = await attachAllocationDerivedFields(prisma, [item], 'invoice');
      const [withCategory] = await attachInvoiceCategoryFields(prisma, [withAmounts]);
      await access.finish();
      res.json({
        ...serializeFinanceValue(withCategory),
        businessLine: withCategory.businessLine ?? null,
        batchAnchors: withCategory.batchAnchors ?? [],
        orderAllocations: (orderAllocations ?? []).map((a: any) => ({
          id: a.id, orderId: a.orderId, orderNumber: a.orderNumber ?? null,
          poNumber: a.poNumber ?? null, allocatedAmount: a.allocatedAmount != null ? Number(a.allocatedAmount) : null,
          batchId: a.batchId ?? null, note: a.note ?? null,
        })),
      });
    } catch (err: any) {
      const se = safeRouteError(err, { fallbackCode: 'GET_FAILED', fallbackMessage: '该财务单据加载失败，请稍后重试；若反复出现请核对单据编号是否正确。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/:id/render.pdf — 导出发票 PDF（CI 级模板：买卖双方/货品明细/金额大写/收款银行）
  router.get('/:id/render.pdf', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const { invoice: actualInvoice, access } = await requireFinanceInvoiceAccess(prisma, (req as any).actor ?? null, req.params.id);
      if (actualInvoice.sourceType === DEVELOPMENT_CI_SOURCE) {
        const source = await readDevelopmentCiInvoiceSource(prisma, actualInvoice.id, (req as any).actor ?? null);
        const html = await renderFinanceInvoiceDocument(prisma, actualInvoice.id, { trustedActor: (req as any).actor ?? null });
        if (!html) throw businessError('CONFLICT', '原开发 CI 版本不可读取。');
        const pdf = await renderHtmlToPdf(html, { format: 'A4' });
        const final = await readDevelopmentCiInvoiceSource(prisma, actualInvoice.id, (req as any).actor ?? null);
        if (final.fingerprint !== source.fingerprint) throw businessError('CONFLICT', '原开发 CI 在出单期间变化。');
        await access.finish(); res.setHeader('Cache-Control', 'no-store'); res.type('pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${actualInvoice.invoiceNumber}.pdf"`);
        return res.send(pdf.pdf);
      }
      if (actualInvoice?.type === 'Receivable') {
        const trustedActor = (req as any).actor ?? extractActorFromRequest(req);
        const expectedSourceFingerprint = req.query.expectedSourceFingerprint;
        const shipmentId = req.query.shipmentId;
        if (expectedSourceFingerprint !== undefined && (typeof expectedSourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSourceFingerprint))
          || shipmentId !== undefined && (typeof shipmentId !== 'string' || !shipmentId)) throw businessError('VALIDATION_FAILED', '原发票来源参数无效。');
        const options = { trustedActor, sourceInvoiceId: actualInvoice.id, mode: 'render' as const,
          ...(expectedSourceFingerprint !== undefined ? { expectedSourceFingerprint } : {}), ...(shipmentId !== undefined ? { shipmentId } : {}) };
        const source = await readCiInvoiceSource(prisma, options);
        const html = await renderFinanceInvoiceDocument(prisma, actualInvoice.id, { ...options, expectedSourceFingerprint: source.fingerprint });
        if (!html) throw businessError('CONFLICT', '原发票没有可渲染内容。');
        const pdf = await renderHtmlToPdf(html, { format: 'A4' });
        await readCiInvoiceSource(prisma, { ...options, expectedSourceFingerprint: source.fingerprint });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${source.invoice.invoiceNumber}.pdf"`);
        return res.send(pdf.pdf);
      }
      const doc = await loadInvoiceDoc(prisma, req.params.id);
      if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '发票不存在' } });
      const pdf = await renderHtmlToPdf(invoicePdfHtml(doc), { format: 'A4' });
      await access.finish();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.invoice.invoiceNumber}.pdf"`);
      res.send(pdf.pdf);
    } catch (err: any) {
      logger.error('[finance] GET /:id/render.pdf failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'PDF_FAILED', fallbackMessage: '该单据的 PDF 未能生成，请稍后重试；如持续失败请联系管理员检查单据模板。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // GET /api/v1/finance/:id/preview.html — 发票预览（与 render.pdf 同源 HTML + screen 页边距，所见即所得）
  router.get('/:id/preview.html', requireInvoicesRead, async (req: Request, res: Response) => {
    try {
      const { invoice: actualInvoice, access } = await requireFinanceInvoiceAccess(prisma, (req as any).actor ?? null, req.params.id);
      if (actualInvoice?.type === 'Receivable') {
        const trustedActor = (req as any).actor ?? extractActorFromRequest(req);
        const expectedSourceFingerprint = req.query.expectedSourceFingerprint;
        const shipmentId = req.query.shipmentId;
        if (expectedSourceFingerprint !== undefined && (typeof expectedSourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSourceFingerprint))
          || shipmentId !== undefined && (typeof shipmentId !== 'string' || !shipmentId)) throw businessError('VALIDATION_FAILED', '原发票来源参数无效。');
        const html = await renderFinanceInvoiceDocument(prisma, actualInvoice.id, { trustedActor, screen: true,
          ...(expectedSourceFingerprint !== undefined ? { expectedSourceFingerprint } : {}), ...(shipmentId !== undefined ? { shipmentId } : {}) });
        if (!html) throw businessError('CONFLICT', '原发票没有可预览内容。');
        await access.finish();
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(html);
      }
      const doc = await loadInvoiceDoc(prisma, req.params.id);
      if (!doc) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '发票不存在' } });
      await access.finish();
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(invoicePdfHtml(doc, { screen: true }));
    } catch (err: any) {
      logger.error('[finance] GET /:id/preview.html failed', { error: err?.message || String(err) });
      const se = safeRouteError(err, { fallbackCode: 'PREVIEW_FAILED', fallbackMessage: '该单据的预览未能生成，请稍后重试；如持续失败请联系管理员检查单据模板。' });
      res.status(se.status).json({ error: { code: se.code, message: se.message } });
    }
  });

  // Files are private. Current authority is checked before multer creates bytes
  // and again inside the atomic registration service. Unknown storage shapes
  // never become public business errors.
  const attachmentFailure = (error: unknown) => {
    const refusal = InvoiceAttachmentError.readOriginal(error);
    return refusal ? {status:refusal.statusCode,code:refusal.code,message:refusal.message}
      : safeRouteError(new Error('INVOICE_ATTACHMENT_OPERATION_FAILED'), {fallbackCode:'UPLOAD_FAILED',fallbackMessage:'附件处理结果未确认，请核对本次归档；勿直接重复上传。'});
  };
  const invoiceAttachmentUpload = multer({
    storage: multer.diskStorage({
      destination: (_req,_file,cb) => { try { cb(null,invoiceAttachmentDirectory()); } catch(error) { cb(error as Error,''); } },
      filename: (_req,file,cb) => cb(null,crypto.randomUUID()+path.extname(file.originalname).toLowerCase()),
    }),
    limits: {fileSize:15*1024*1024},
    fileFilter: (_req,file,cb) => {if(/\.(pdf|png|jpe?g|webp|docx?|xlsx?)$/i.test(file.originalname))cb(null,true);else cb(new InvoiceAttachmentError('INVALID_FILE','文件格式不支持，请选择发票文件。',400));},
  });
  router.post('/:id/attachments',requireInvoicesWrite,async(req:any,res:Response)=>{
    try {
      await preflightInvoiceAttachment(prisma,req.params.id,req.actor??null);
      const key=invoiceAttachmentKey(req.headers['x-invoice-attachment-key']);
      let originalName:string|undefined;
      if(req.headers['x-invoice-attachment-name']!==undefined){
        try{originalName=decodeURIComponent(String(req.headers['x-invoice-attachment-name']));}catch{throw new InvoiceAttachmentError('INVALID_FILE','原文件名称无法核对。',400);}
        if(!originalName||originalName.length>255||/[\x00-\x1f\x7f]/.test(originalName)||path.basename(originalName)!==originalName)throw new InvoiceAttachmentError('INVALID_FILE','原文件名称无效。',400);
      }
      // Resolve the parser promise, so parser failures stay in this same safe
      // boundary rather than the broad application error-shape classifier.
      await new Promise<void>((resolve,reject)=>invoiceAttachmentUpload.single('file')(req,res,error=>error?reject(error):resolve()));
      if(!req.file)throw new InvoiceAttachmentError('INVALID_FILE','file 必填',400);
      if(originalName!==undefined)req.file.originalname=originalName;
      const result=await registerInvoiceAttachment({prisma,invoiceId:req.params.id,actor:req.actor??null,clientRequestId:key,file:req.file,ip:req.ip??null});
      onDataChange?.({entity:'finance',action:'update',ids:[req.params.id]});
      res.status(result.replayed?200:201).json(result);
    } catch(error) {
      try { logger.error('[finance] invoice attachment failed',{error}); } catch { /* Logging cannot replace the safe HTTP outcome. */ }
      const failure=error instanceof multer.MulterError?{status:400,code:'INVALID_FILE',message:'文件过大或上传内容无效，请重新选择文件。'}:attachmentFailure(error);
      res.status(failure.status).json({error:{code:failure.code,message:failure.message}});
    }
  });
  router.get('/:id/attachments/receipts/:clientRequestId',requireInvoicesRead,async(req:any,res:Response)=>{
    try { res.json(await readOwnInvoiceAttachmentReceipt(prisma,req.params.id,req.actor??null,req.params.clientRequestId)); }
    catch(error) { const failure=attachmentFailure(error);res.status(failure.status).json({error:{code:failure.code,message:failure.message}}); }
  });
  router.get('/:id/attachments/:fileId/download',requireInvoicesRead,async(req:any,res:Response)=>{
    try {
      const result=await readInvoiceAttachment({prisma,actor:req.actor??null,invoiceId:req.params.id,fileId:req.params.fileId});
      res.setHeader('Content-Type',result.attachment.mimeType);
      res.setHeader('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.fileName)}`);
      res.setHeader('Cache-Control','private, no-store');res.send(result.bytes);
    } catch(error) { const failure=attachmentFailure(error);res.status(failure.status).json({error:{code:failure.code,message:failure.message}}); }
  });

  // PATCH /api/v1/finance/:id
  router.patch('/:id', requireInvoicesWrite, async (req: Request, res: Response) => {
    const result = await updateInvoice({
      prisma,
      invoiceId: req.params.id,
      input: req.body as any,
      actorId: actorIdFromRequest(req),
      actor: (req as any).actor ?? null,
      ip: req.ip || null,
    });
    if (!result.ok) {
      const statusCodeMap: Record<string, number> = { NOT_FOUND: 404, INVALID_STATUS: 400, INVALID_TRANSITION: 400, INVALID_CURRENT_STATUS: 400, INVALID_AMOUNT: 400, INVALID_CURRENCY: 400, STATUS_NOT_MANUAL_SETTABLE: 400, INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH: 409, INVOICE_CUSTOMER_MISMATCH: 409, LINE_ALREADY_ALLOCATED: 409, AMOUNT_BELOW_ALLOCATED: 409, UPDATE_FAILED: 500 };
      res.status(statusCodeMap[result.error!.code] ?? lookupErrorCode(result.error!.code)?.status ?? 500).json({ error: result.error });
      return;
    }
    const updated = result.data!.invoice;
    onDataChange?.({ entity: 'finance', action: 'update', ids: [updated.id] });
    res.json(serializeFinanceValue(updated));
  });

  return router;
}
