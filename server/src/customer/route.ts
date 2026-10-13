/**
 * route.ts — 客户门户只读 API
 *
 * 挂载点：/api/v2/customer
 *
 * 安全模型：
 *   - 所有业务查询强制 `customerRelationId = req.customer.relationId`（数据作用域真源），
 *     客户永远无法看到其他公司数据——跨公司隔离在 where 层兜死。
 *     ⚠️ 唯一例外：CI/PL 走**运单维度**，`shipmentBelongsToCustomer` 用 findFirst
 *     （运单内任一订单属我就放行），而后续 `assembleDocumentSetData` 取的是整张运单
 *     的 shipmentLine —— 拼柜（一票运单含多客户订单）时可能带出他客户订单行。
 *     见 docs/handoff 6k，**业务口径待拍板**，拍板前勿以此注释为"绝对隔离"的依据。
 *   - 原为**纯只读**；H16-②（2026-09-16）新增**唯一写端点** `POST /reconciliation/acks`
 *     （客户对账回执：确认无异议 / 提异议）。写端点仍强制 `customerRelationId = req.customer.relationId`，
 *     客户只能提交自己的回执；回执是 append-only 的客户凭证，不触发任何单据状态变更。
 *   - MVP 范围：订单 + 出运 + 发票（+ 回款对账 + 对账回执）。
 *   - 响应 DTO 只暴露客户可见字段，剔除内部经营字段（工厂/采购价/内部分工/审计）。
 *   - 登录成功签发 kind='customer' 的 JWT，用同一 JWT_SECRET 签名。
 */
import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { asyncHandler } from '../lib/asyncHandler';
import { createCustomerAuthService } from './authService';
import { createRequireCustomer, extractCustomerToken } from './auth';

import { buildCustomerTimeline } from './timelineService';
import { isCustomerDocumentKind, renderCustomerDocumentPdf } from './documentService';
import { createCustomerReconciliationAckService } from './reconciliationAckService';
import { buildOrderSchedule } from './orderScheduleService';
import { createLoginRateLimiter, type LoginRateLimiter } from '../auth/loginRateLimiter';
// ★ 「未结清应收」判据唯一真源（含 amount>0 守卫）—— 0 元/负额票不该计入「未结清张数」
import { openReceivableWhere } from '../shared/openReceivable';
import { orderAmountOrNull } from '../shared/orderAmount';
const customerAuth = createCustomerAuthService();

export interface CustomerPortalRouterOptions {
  prisma: PrismaClient;
  /** 注入登录限流器（测试用假时钟）；不传则使用默认 15 分钟 / 5 次失败。 */
  loginRateLimiter?: LoginRateLimiter;
}

/** 订单状态英文标签（供客户门户直接展示到 UI） */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  Pending: 'Pending Confirmation',
  Confirmed: 'Confirmed',
  Production: 'In Production',
  Shipping: 'Shipping',
  Delivered: 'Delivered',
  Alert: 'Needs Attention',
};

export const SHIPMENT_STATUS_LABEL: Record<string, string> = {
  Draft: 'Draft',
  Booked: 'Booked',
  Loading: 'Loading',
  Shipped: 'Shipped',
  Arrived: 'Arrived',
  Cleared: 'Cleared',
  Delivered: 'Delivered',
  Cancelled: 'Cancelled',
};

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  Draft: 'Draft',
  Issued: 'Issued',
  PartiallyPaid: 'Partially Paid',
  Paid: 'Paid',
  Cancelled: 'Cancelled',
};

function toOrderDTO(order: any) {
  return {
    id: order.id,
    poNumber: order.poNumber,
    code: order.code,
    customer: order.customer,
    product: order.product,
    type: order.type,
    businessLine: order.businessLine,
    quantity: order.quantity,
    status: order.status,
    statusLabel: ORDER_STATUS_LABEL[order.status] || order.status,
    currency: order.currency,
    // ★ E 批 2026-09-26：客户看到的金额走**真源**（① 明细行 → ② totalNet → ③ 报价额）。
    //   原字段 `quoteAmount` 是主档报价额直传，而门户同页的行表渲染的是 `netValue`
    //   ⇒ 一张 totalNet ≠ quoteAmount 的单，客户会在**同一页**看到两个对不上的数
    //   （OrderDetail.tsx 的 "Order Value" 卡片 vs 下面的 Amount 列）。
    //   判据：server/src/__tests__/orderAmountTruth.test.ts ⑤（E-1）+ 本文件的行为用例。
    orderAmount: orderAmountOrNull(order),
    dueDate: order.dueDate,
    productionDate: order.productionDate,
    clientDate: order.clientDate,
    createdAt: order.createdAt,
    deliveryTerms: order.deliveryTerms,
    paymentTerms: order.paymentTerms,
    paymentInstrument: order.paymentInstrument,
    billToName: order.billToName,
    // 仅暴露与客户相关的单据进度
    invoiceNumber: order.invoiceNumber,
    invoiceDate: order.invoiceDate,
    shipmentDate: order.shipmentDate,
    shipmentMethod: order.shipmentMethod,
    shipmentQuantity: order.shipmentQuantity,
    shipmentAmount: order.shipmentAmount,
  };
}

export function createCustomerPortalRouter(opts: CustomerPortalRouterOptions): Router {
  const router = Router();
  const prisma = opts.prisma;
  const requireCustomer = createRequireCustomer(prisma);
  // 防爆破：与主站登录同口径（15 分钟窗口 / 5 次失败，按 IP+邮箱 建键）。
  // 门户是**对外**入口且按定义无法鉴权，2026-09-15 前这里完全没有限流
  // （主站 login 有限流，门户漏了），补上。
  const loginRateLimiter = opts.loginRateLimiter ?? createLoginRateLimiter();

  // ── 登录（公开） ──
  router.post('/auth/login', asyncHandler(async (req: Request, res: Response) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Email and password are required.' });
    }

    const rateLimitKey = `${req.ip || 'unknown'}|${email}`;
    const verdict = loginRateLimiter.check(rateLimitKey);
    if (verdict.blocked) {
      return res.status(429).json({
        error: 'RATE_LIMITED',
        message: 'Too many failed attempts. Please try again later.',
        retryAfterMs: verdict.retryAfterMs,
      });
    }

    const user = await prisma.customerUser.findFirst({
      where: { email, deletedAt: null },
    });
    const hash = user?.passwordHash;
    const ok = hash ? await customerAuth.verifyPassword(password, hash) : false;
    if (!user || !ok) {
      loginRateLimiter.recordFailure(rateLimitKey);
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'ACCOUNT_DISABLED', message: 'This account has been disabled.' });
    }
    const token = customerAuth.signToken({
      kind: 'customer',
      customerUserId: user.id,
      relationId: user.relationId,
      displayName: user.displayName,
      relationName: user.relationName || undefined,
    });
    // 登录成功：清除该 IP+邮箱 的失败计数
    loginRateLimiter.reset(rateLimitKey);

    await prisma.customerUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: (req.ip || '').toString() },
    });
    return res.json({
      token,
      customer: { id: user.id, email: user.email, displayName: user.displayName, relationId: user.relationId, relationName: user.relationName },
    });
  }));

  // ── 以下全部需要客户登录 ──
  router.use(requireCustomer);

  // ── 当前客户 / 公司信息 ──
  router.get('/me', asyncHandler(async (req: Request, res: Response) => {
    const c = req.customer!;
    const relation = await prisma.relation.findFirst({ where: { id: c.relationId, deletedAt: null } });
    return res.json({
      customerUserId: c.customerUserId,
      displayName: c.displayName,
      relationId: c.relationId,
      relationName: relation?.englishName || c.relationName || relation?.name || c.relationName,
    });
  }));

  // ── 门户概览统计（卡片数字） ──
  router.get('/summary', asyncHandler(async (req: Request, res: Response) => {
    const relationId = req.customer!.relationId;
    const [orders, activeOrders, shipments, openInvoices] = await Promise.all([
      prisma.order.count({ where: { customerRelationId: relationId, deletedAt: null } }),
      prisma.order.count({ where: { customerRelationId: relationId, deletedAt: null, status: { in: ['Pending', 'Confirmed', 'Production', 'Shipping', 'Alert'] } } }),
      prisma.shipment.count({ where: { customerRelationId: relationId, deletedAt: null } }),
      prisma.invoice.count({ where: openReceivableWhere({ customerRelationId: relationId }) }),
    ]);
    return res.json({ totalOrders: orders, activeOrders, shipments, openInvoices });
  }));

  // ── 订单列表（含 出运/发票 数 + 应收余额） ──
  router.get('/orders', asyncHandler(async (req: Request, res: Response) => {
    const relationId = req.customer!.relationId;
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const take = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    const skip = Number(req.query.offset ?? 0) || 0;

    const where: any = { customerRelationId: relationId, deletedAt: null };
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { poNumber: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { product: { contains: search, mode: 'insensitive' } },
        { customer: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, poNumber: true, code: true, customer: true, product: true, type: true,
          businessLine: true, quantity: true, status: true, currency: true, quoteAmount: true,
          // ★ 真源三步要**真的取得到**：只 select `quoteAmount` 时把 DTO 换成 orderAmountOrNull
          //   会静默落到 0（①明细行没带 netValue、②totalNet 没选 ⇒ ③之后无兜底可回）。
          //   这一列与下面 lines.netValue 是**同一次改动**，漏一个就是"改了但没生效"。
          totalNet: true,
          dueDate: true, productionDate: true, clientDate: true, createdAt: true,
          deliveryTerms: true, paymentTerms: true, paymentInstrument: true, billToName: true,
          invoiceNumber: true, invoiceDate: true, shipmentDate: true, shipmentMethod: true,
          shipmentQuantity: true, shipmentAmount: true,
          lines: { select: { unit: true, netValue: true } },
        },
      }),
    ]);

    const orderIds = items.map(o => o.id);
    const [shipmentCounts, invoiceCounts] = await Promise.all([
      prisma.shipment.groupBy({ by: ['orderId'], where: { orderId: { in: orderIds }, deletedAt: null }, _count: { _all: true } }),
      prisma.invoice.groupBy({ by: ['orderId'], where: { orderId: { in: orderIds }, type: 'Receivable', deletedAt: null }, _count: { _all: true } }),
    ]);
    const shipmentMap = new Map(shipmentCounts.map(s => [s.orderId, s._count._all]));
    const invoiceMap = new Map(invoiceCounts.map(i => [i.orderId, i._count._all]));

    return res.json({
      total,
      items: items.map(o => ({ ...toOrderDTO(o), shipments: shipmentMap.get(o.id) ?? 0, invoices: invoiceMap.get(o.id) ?? 0 })),
    });
  }));

  // ── 订单详情（行明细 + 出运 + 发票 + 回款） ──
  router.get('/orders/:id', asyncHandler(async (req: Request, res: Response) => {
    const relationId = req.customer!.relationId;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerRelationId: relationId, deletedAt: null },
      include: { lines: true },
    });
    if (!order) return res.status(404).json({ error: 'NOT_FOUND', message: 'Order not found.' });

    // 出运：经分配表 + 直接 orderId 双路，均限定本客户关系
    const [allocs, directShipments] = await Promise.all([
      prisma.shipmentOrderAllocation.findMany({ where: { orderId: order.id } }),
      prisma.shipment.findMany({ where: { orderId: order.id, customerRelationId: relationId, deletedAt: null } }),
    ]);
    const allocShipmentIds = allocs.map(a => a.shipmentId);
    const allocShipments = allocShipmentIds.length
      ? await prisma.shipment.findMany({ where: { id: { in: allocShipmentIds }, customerRelationId: relationId, deletedAt: null } })
      : [];
    const shipmentById = new Map<string, any>();
    for (const s of [...directShipments, ...allocShipments]) shipmentById.set(s.id, s);
    const shipments = Array.from(shipmentById.values());

    // 发票 + 回款
    const invoices = await prisma.invoice.findMany({
      where: { orderId: order.id, customerRelationId: relationId, type: 'Receivable', deletedAt: null },
      orderBy: { issueDate: 'desc' },
    });
    const invIds = invoices.map(i => i.id);
    const paymentMap = new Map<string, number>();
    if (invIds.length) {
      const vouchers = await prisma.paymentVoucher.findMany({ where: { invoiceId: { in: invIds }, type: 'Receipt', deletedAt: null } });
      for (const v of vouchers) {
        if (v.invoiceId != null) paymentMap.set(v.invoiceId, (paymentMap.get(v.invoiceId) ?? 0) + Number(v.appliedAmount ?? v.amount));
      }
    }

    return res.json({
      // 不再抽掉 `lines`：`toOrderDTO` 只挑具名字段、本来就不外发 lines，
      // 而 orderAmountOrNull 的 ①（Σ明细行）需要它 —— 上面 :245 是 `include: { lines: true }`，
      // 与本页下方外发的 `lines[].netValue` 同源，卡片金额与行表合计必然一致。
      order: toOrderDTO(order),
      lines: order.lines.map(l => ({
        id: l.id, lineNumber: l.lineNumber, itemNo: l.itemNo, materialCode: l.materialCode,
        description: l.description, width: l.width, deliveryDate: l.deliveryDate,
        quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, netValue: l.netValue,
        cloth: l.cloth, weight: l.weight, category: l.category, status: l.status,
        colorName: l.colorName, styleNo: l.styleNo, sizeBreakdown: l.sizeBreakdown,
      })),
      shipments: shipments.map(s => ({
        id: s.id, shipmentNumber: s.shipmentNumber, type: s.type, status: s.status,
        statusLabel: SHIPMENT_STATUS_LABEL[s.status] || s.status, shippingMethod: s.shippingMethod,
        bookingDate: s.bookingDate, etd: s.etd, atd: s.atd, eta: s.eta, ata: s.ata,
        vesselOrFlight: s.vesselOrFlight, voyageNumber: s.voyageNumber,
        portOfLoading: s.portOfLoading, portOfDischarge: s.portOfDischarge,
        containerNumber: s.containerNumber, sealNumber: s.sealNumber,
        trackingNumber: s.trackingNumber, carrierTrackingUrl: s.carrierTrackingUrl,
        totalPackages: s.totalPackages, customsDeclarationNumber: s.customsDeclarationNumber,
        notes: s.notes,
      })),
      invoices: invoices.map(i => ({
        id: i.id, invoiceNumber: i.invoiceNumber, status: i.status,
        statusLabel: INVOICE_STATUS_LABEL[i.status] || i.status, amount: i.amount,
        currency: i.currency, issueDate: i.issueDate, dueDate: i.dueDate, settlementDate: i.settlementDate,
        receivedAmount: paymentMap.get(i.id) ?? 0,
      })),
    });
  }));

  // ── 订单全时间线（§10.3-8）──
  // 口径：只给对外节点（订单状态 / 打样轮次 / 生产里程碑 / 验货结论 / 出运节点 / 发票）；
  // 内部细节（成本利润、工厂供应商、内部备注与审批、QC 疵点明细、运费）不进 DTO ——
  // 白名单构造见 timelineService。作用域与 :id 端点一致（customerRelationId 兜死）。
  router.get('/orders/:id/timeline', asyncHandler(async (req: Request, res: Response) => {
    const relationId = req.customer!.relationId;
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, customerRelationId: relationId, deletedAt: null },
      select: { id: true },
    });
    if (!order) return res.status(404).json({ error: 'NOT_FOUND', message: 'Order not found.' });

    // H16-③：时间线 + **进度对照**（交期达成判定）并行取数 —— 客户最关心「有没有延误」
    const [{ items }, schedule] = await Promise.all([
      buildCustomerTimeline(prisma, order.id),
      buildOrderSchedule(prisma, order.id),
    ]);
    return res.json({ ok: true, orderId: order.id, timeline: items, schedule });
  }));

  // ── 单据下载（§10.3-8）：PI / CI / 装箱单 / 发票 ──
  // 归属过滤与状态门禁在 documentService（草稿不下发；不属于本客户一律 404，
  // 不区分"不存在"与"没权限"，避免探测他人单据）。渲染复用服务端既有单据链。
  router.get('/documents/:kind/:id.pdf', asyncHandler(async (req: Request, res: Response) => {
    const kind = String(req.params.kind || '').toLowerCase();
    if (!isCustomerDocumentKind(kind)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Document not found.' });
    }
    const result = await renderCustomerDocumentPdf(prisma, req.customer!.relationId, kind, req.params.id);
    if (!result.ok) {
      const status = result.error?.code === 'RENDER_FAILED' ? 500 : 404;
      return res.status(status).json({ error: result.error?.code ?? 'NOT_FOUND', message: result.error?.message ?? 'Document not found.' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    return res.end(result.pdf);
  }));

  // ── 出运列表 ──
  router.get('/shipments', asyncHandler(async (req: Request, res: Response) => {
    const relationId = req.customer!.relationId;
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
    const where: any = { customerRelationId: relationId, deletedAt: null };
    if (status) where.status = status;
    const items = await prisma.shipment.findMany({
      where,
      orderBy: { updatedAt: 'desc' as any },
      take: 300,
      select: {
        id: true, shipmentNumber: true, type: true, status: true, shippingMethod: true,
        bookingDate: true, etd: true, atd: true, eta: true, ata: true,
        vesselOrFlight: true, voyageNumber: true, portOfLoading: true, portOfDischarge: true,
        containerNumber: true, sealNumber: true, trackingNumber: true, carrierTrackingUrl: true,
        totalPackages: true, orderId: true, customerName: true, customsDeclarationNumber: true,
        // H16 发货通知（Shipping Advice）必备项：三单号 + 毛净重体积 + 订舱号
        bookingNo: true, soNumber: true,
        billOfLadingNo: true, masterBillNo: true, houseBillNo: true,
        grossWeight: true, netWeight: true, volume: true,
        notes: true,
      },
    });
    // 补充订单 PO 号（让出运列表可跳回订单）
    const orderIds = Array.from(new Set(items.map(s => s.orderId).filter(Boolean) as string[]));
    const orderMap = new Map<string, string>();
    if (orderIds.length) {
      const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, poNumber: true, product: true } });
      for (const o of orders) orderMap.set(o.id, o.poNumber || '');
    }
    return res.json({
      items: items.map(s => ({
        id: s.id, shipmentNumber: s.shipmentNumber, type: s.type, status: s.status,
        statusLabel: SHIPMENT_STATUS_LABEL[s.status] || s.status, shippingMethod: s.shippingMethod,
        bookingDate: s.bookingDate, etd: s.etd, atd: s.atd, eta: s.eta, ata: s.ata,
        vesselOrFlight: s.vesselOrFlight, voyageNumber: s.voyageNumber,
        portOfLoading: s.portOfLoading, portOfDischarge: s.portOfDischarge,
        containerNumber: s.containerNumber, sealNumber: s.sealNumber,
        trackingNumber: s.trackingNumber, carrierTrackingUrl: s.carrierTrackingUrl,
        totalPackages: s.totalPackages, orderId: s.orderId, orderPO: orderMap.get(s.orderId as string),
        customsDeclarationNumber: s.customsDeclarationNumber,
        // H16 发货通知必备项（Decimal 转 number，避免 BigInt/Decimal 序列化歧义）
        bookingNo: s.bookingNo, soNumber: s.soNumber,
        billOfLadingNo: s.billOfLadingNo, masterBillNo: s.masterBillNo, houseBillNo: s.houseBillNo,
        grossWeight: s.grossWeight != null ? Number(s.grossWeight) : null,
        netWeight: s.netWeight != null ? Number(s.netWeight) : null,
        volume: s.volume != null ? Number(s.volume) : null,
        notes: s.notes,
      })),
    });
  }));

  // ── 发票列表（含回款 + 余额） ──
  router.get('/invoices', asyncHandler(async (req: Request, res: Response) => {
    const relationId = req.customer!.relationId;
    const where: any = { customerRelationId: relationId, type: 'Receivable', deletedAt: null };
    const items = await prisma.invoice.findMany({ where, orderBy: { issueDate: 'desc' }, take: 300 });
    const invIds = items.map(i => i.id);

    const paidByInvoice = new Map<string, number>();
    if (invIds.length) {
      const [vouchers, allocs] = await Promise.all([
        prisma.paymentVoucher.findMany({ where: { invoiceId: { in: invIds }, type: 'Receipt', deletedAt: null } }),
        prisma.invoiceAllocation.findMany({ where: { invoiceId: { in: invIds } } }),
      ]);
      const voucherById = new Map(vouchers.map(v => [v.id, v]));
      // 已通过分配表核销的（DR-053 真源）
      for (const a of allocs) {
        const v = voucherById.get(a.voucherId);
        if (v && v.type === 'Receipt' && !v.deletedAt) {
          paidByInvoice.set(a.invoiceId, (paidByInvoice.get(a.invoiceId) ?? 0) + Number(a.appliedAmount));
        }
      }
      // 未走分配表的 legacy 1:1 主核销快照（避免与分配表重复计数）
      const allocatedVoucherIds = new Set(allocs.map(a => a.voucherId));
      for (const v of vouchers) {
        if (v.invoiceId && !allocatedVoucherIds.has(v.id)) {
          paidByInvoice.set(v.invoiceId, (paidByInvoice.get(v.invoiceId) ?? 0) + Number(v.appliedAmount ?? v.amount));
        }
      }
    }

    // 发票关联订单 PO
    const orderIds = Array.from(new Set(items.map(i => i.orderId).filter(Boolean) as string[]));
    const poByOrderId = new Map<string, string>();
    if (orderIds.length) {
      const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, poNumber: true } });
      for (const o of orders) poByOrderId.set(o.id, o.poNumber || '');
    }

    return res.json({
      items: items.map(i => {
        const received = paidByInvoice.get(i.id) ?? 0;
        return {
          id: i.id, invoiceNumber: i.invoiceNumber, status: i.status,
          statusLabel: INVOICE_STATUS_LABEL[i.status] || i.status, amount: i.amount,
          currency: i.currency, issueDate: i.issueDate, dueDate: i.dueDate, settlementDate: i.settlementDate,
          exchangeRate: i.exchangeRate, orderId: i.orderId, orderPO: poByOrderId.get(i.orderId as string),
          receivedAmount: received, balance: Math.max(0, Number(i.amount) - received),
        };
      }),
    });
  }));

  // ── 发票详情 ──
  router.get('/invoices/:id', asyncHandler(async (req: Request, res: Response) => {
    const relationId = req.customer!.relationId;
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, customerRelationId: relationId, type: 'Receivable', deletedAt: null },
    });
    if (!invoice) return res.status(404).json({ error: 'NOT_FOUND', message: 'Invoice not found.' });

    const [invoiceLines, vouchers, allocs] = await Promise.all([
      prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } }),
      prisma.paymentVoucher.findMany({ where: { invoiceId: invoice.id, type: 'Receipt', deletedAt: null } }),
      prisma.invoiceAllocation.findMany({ where: { invoiceId: invoice.id } }),
    ]);
    const received = allocs.reduce((sum, a) => sum + Number(a.appliedAmount), 0)
      + vouchers.filter(v => !allocs.some(a => a.voucherId === v.id)).reduce((sum, v) => sum + Number(v.appliedAmount ?? v.amount), 0);

    // 订单 PO
    let orderPO: string | null = null;
    if (invoice.orderId) {
      const order = await prisma.order.findFirst({ where: { id: invoice.orderId }, select: { poNumber: true } });
      orderPO = order?.poNumber || null;
    }

    return res.json({
      invoice: {
        id: invoice.id, invoiceNumber: invoice.invoiceNumber, type: invoice.type, status: invoice.status,
        statusLabel: INVOICE_STATUS_LABEL[invoice.status] || invoice.status, amount: invoice.amount,
        currency: invoice.currency, issueDate: invoice.issueDate, dueDate: invoice.dueDate,
        settlementDate: invoice.settlementDate, exchangeRate: invoice.exchangeRate,
        baseCurrency: invoice.baseCurrency, customerName: invoice.customerName,
        orderId: invoice.orderId, orderPO, notes: invoice.notes,
        receivedAmount: received, balance: Math.max(0, Number(invoice.amount) - received),
      },
      lines: invoiceLines.map(l => ({
        id: l.id, sourceType: l.sourceType, sourceId: l.sourceId,
        description: l.description, amount: l.amount, currency: l.currency,
      })),
      payments: vouchers.map(v => ({
        id: v.id, voucherNumber: v.voucherNumber, amount: v.amount, currency: v.currency,
        paymentDate: v.paymentDate, paymentMethod: v.paymentMethod,
        appliedAmount: allocs.some(a => a.voucherId === v.id)
          ? allocs.filter(a => a.voucherId === v.id).reduce((s, a) => s + Number(a.appliedAmount), 0)
          : Number(v.appliedAmount ?? v.amount),
      })),
    });
  }));

  // ════════════════════════════════════════════════════════════════
  // H16-② 对账确认回执（2026-09-16）—— 对账函回签的电子化
  // 口径：按期间（月度对账函）；确认后记录+通知内部但**不锁定数据**；不做回执 PDF。
  // ⚠️ 本组含**客户门户唯一的写端点**（POST /acks），归属强制走 req.customer.relationId。
  // ════════════════════════════════════════════════════════════════
  const ackService = createCustomerReconciliationAckService(prisma);

  /** 对账单（指定期间）：期初余额 / 本期开票 / 本期收款 / 期末余额，**按币种分组** */
  router.get('/reconciliation/statement', asyncHandler(async (req: Request, res: Response) => {
    const periodStart = String(req.query.periodStart ?? '');
    const periodEnd = String(req.query.periodEnd ?? '');
    const r = await ackService.computePeriodStatement(req.customer!.relationId, periodStart, periodEnd);
    if (!r.ok) return res.status(r.error.status).json({ error: r.error.code, message: r.error.message });
    return res.json(r.data);
  }));

  /** 我的历史回执（倒序） */
  router.get('/reconciliation/acks', asyncHandler(async (req: Request, res: Response) => {
    const r = await ackService.listAcks(req.customer!.relationId);
    if (!r.ok) return res.status(r.error.status).json({ error: r.error.code, message: r.error.message });
    return res.json(r.data);
  }));

  /** 提交回执（确认无异议 / 有异议）—— 客户门户唯一写端点 */
  router.post('/reconciliation/acks', asyncHandler(async (req: Request, res: Response) => {
    const b = req.body || {};
    const r = await ackService.submitAck({
      relationId: req.customer!.relationId,
      customerUserId: req.customer!.customerUserId,
      customerUserName: req.customer!.displayName,
      periodStart: String(b.periodStart ?? ''),
      periodEnd: String(b.periodEnd ?? ''),
      decision: b.decision,
      disputeNote: b.disputeNote ?? null,
      ip: req.ip || null,
    });
    if (!r.ok) return res.status(r.error.status).json({ error: r.error.code, message: r.error.message });
    return res.status(201).json({ ack: r.data.ack });
  }));

  return router;
}