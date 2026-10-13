import {serializeValue} from '../lib/serializeValue';
import {parseOrderQuantity,normalizeOrderQuantityUnit,OrderQuantityError} from '../shared/orderQuantitySummary';
import {guardOrderHeaderQuantity,orderQuantityDto} from '../shared/orderQuantityWriteGuard';
import { assertOrderHeaderEditable } from './orderHeaderMutationPolicy';
import { orderTradeTermsError, orderLineDeliveryError, normalizeOrderTradePatch } from '../shared/orderTradeTerms';
import { normalizeExternalPoNumber } from './orderIdentity';
import { authorizeOrderLineWrite, currentOrderLineWriteActor, freshOrderLineScope, orderLineWriteFailure } from './orderLineWriteAccess';
import { isInternalOrderPurpose, normalizeInternalOrderInput } from './internalOrderFacts';
import { isBusinessError, businessError } from '../shared/errorCodes';
/**
 * orderServiceV2.ts — Phase 1-02 订单/履约域服务
 *
 * 在现有 route.ts / orderLifecycleService.ts 基础上，接入 Phase 0 平台域 4 大能力：
 *   1. 行级权限 Scope（permissionService.getDataScopeResolver → Prisma where 过滤）
 *   2. 编号发号器（sequenceService.nextNumber → SO-202608-001）
 *   3. 数据字典校验（dataDictionaryService → order_status / order_type 合法性）
 *   4. 系统配置默认值（systemConfigService → 默认币种/付款条款/Incoterms）
 *
 * 状态机复用现有 orderLifecycleService.ts 的 6 状态矩阵：
 *   Pending → Confirmed → Production → Shipping → Delivered（终态）
 *   任意阶段 → Alert（异常旁路）→ 恢复到非终态
 *
 * 与 V1 路由的关系：V1 保持不变（向后兼容），V2 面向新前端页面
 */
import type { PrismaClient } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { createSequenceService } from '../sequence/sequenceService';
import { getDataDictionaryService } from '../dictionaries/dataDictionaryService';
import { getSystemConfigService } from '../config/systemConfigService';
import {
  VALID_ORDER_STATUSES,
  ORDER_TRANSITIONS,
  transitionOrderStatus,
  deleteOrder as deleteOrderV1,
} from './orderLifecycleService';
import { logger } from '../lib/logger';
import { safeRouteError } from '../shared/routeError';
import { createCreditService } from '../credit/creditService';
import { createMoqConfigService } from '../moq/moqConfigService';
import { createMoqResolutionService } from '../moq/moqResolutionService';
import { createMoqValidationService, isCapsuleEligible } from '../moq/moqValidationService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { writeFieldAuditDiff, SYSTEM_AUDIT_ACTOR } from '../audit/routeAudit';
import { createTeamShareService } from '../teams/teamShareService';
import { createCreditExceptionService, resolveCreditException, consumeCreditException, CreditExceptionConsumptionError, isCreditExceptionConsumptionErrorCode, type CreditExceptionConsumptionErrorCode } from '../credit/creditExceptionGate';
import type { ActiveExceptionSummary, ExceptionScopeMatch } from '../exceptions/exceptionGate';
import type { ExceptionService } from '../exceptions/exceptionService';

/**
 * Order 模型可选业务字段白名单（创建/更新共用）。
 * 根因修复：此前 createOrder 全量透传客户端字段，任何 Prisma 不认识的字段
 * （如 unitPrice）都会导致 order.create 抛 Unknown argument → 500。
 */
const ORDER_OPTIONAL_FIELDS = [
  'orderPurpose', 'internalPurpose', 'internalDemandTeamId', 'internalReceiverId',
  'customer', 'product', 'type', 'quantity', 'unit', 'dueDate', 'quoteAmount',
  'currency', 'paymentTerms', 'deliveryTerms', 'customerRelationId',
  'deliveryPlace', 'contractDeliveryDate', 'expectedArrivalDate', 'agreedArrivalDate',
  // ★ A19（拍板件 §2.2 硬条件「B51 三条路径要一起收口」）：此前白名单**没有**
  //   `paymentInstrument` ⇒ 客户端传了会被静默丢弃、该列恒 null
  //   ⇒ L/C 门禁永远判 `not-applicable` 放行（与报价转单丢字段是同一族）。
  //   本白名单 create（:500）与 update（:616）**共用** ⇒ 加这一处两条路径一起收口。
  'paymentInstrument',
  // ★ D3 定金（2026-09-30）：与 paymentInstrument 同一族 —— 不在白名单里就会被**静默丢弃**，
  //   定金列恒空 ⇒ 定金门禁永远判 `not-applicable`（看着像通过，实际风控没生效）。
  'depositRatio', 'depositCurrency',
  'businessLine', 'ownerId', 'departmentId', 'salesPerson', 'merchandiser',
  'supervisor', 'productionBatch', 'productionDate', 'clientDate',
  'specialInstructions', 'poNumber', 'season', 'contactPerson', 'contactPhone',
  'shipToName', 'shipToAddress1', 'shipToAddress2', 'shipToCountry', 'shipToPhone',
  'deliverTo', 'salesContractNumber', 'finalContractNumber',
  'capsuleExemption', 'capsuleExemptionBy', 'capsuleExemptionAt',
  'salesPrice', 'contractAmount', 'salesCurrency', 'purchaseCurrency',
  'millName', 'millRelationId', 'millContact', 'millPhone', 'millAddress',
  'consigneeName', 'consigneeAddress', 'consigneeContact', 'consigneeRelationId',
  'billToName', 'billToAddress', 'billToContact', 'billToRelationId',
  'salesPersonRelationId', 'merchandiserRelationId', 'supervisorRelationId',
  'customerCode',
] as const;

// ────────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────────
export interface OrderListFilter {
  status?: string;
  type?: string;            // Fabric / Apparel / HomeText / Accessory / Other
  ownerId?: string;
  departmentId?: string;
  customerCode?: string;
  customerRelationId?: string;
  businessLine?: string;
  search?: string;          // customer / product / code / poNumber / millName(供应商) / invoiceNumber / supplierInvoiceNumber / salesContractNumber / finalContractNumber(合同号) 模糊搜索
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
  sort?: string;            // createdAt / dueDate / status / quoteAmount
  /** Excel 台账导出=true：忽略分页上限全量导出（route 层 format=xlsx 专用） */
  exportAll?: boolean;
}

export interface OrderListResult {
  items: any[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface OrderKanbanResult {
  statuses: Array<{
    status: string;
    label: string;
    count: number;
    color?: string;
  }>;
  total: number;
}

export interface CreateOrderInput {
  customer: string;
  product: string;
  type: string;
  quantity: number | string;
  unit?: string | null;
  status?: string;
  dueDate: string;
  quoteAmount: number;
  ownerId?: string;
  departmentId?: string;
  customerRelationId?: string;
  currency?: string;
  paymentTerms?: string;
  /** ★ A19：结算方式（`T/T | L/C | O/A | D/P | D/A | Other`，枚举真源见 `lib/orderSchema.ts`）。 */
  paymentInstrument?: string;
  deliveryTerms?: string;
  businessLine?: string;
  [key: string]: unknown;
}

export type OrderV2Error =
  | 'CONFLICT'
  | 'ACCOUNT_DISABLED'
  | 'AUTHORIZATION_UNAVAILABLE'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_LINE_NOT_FOUND'
  | 'ORDER_MAIN_APPROVAL_REQUIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'SEQUENCE_FAILED'
  | 'HAS_DEPENDENTS'
  | 'MOQ_VIOLATION'
  | 'CREDIT_FROZEN_60_DAYS'
  | 'CREDIT_REVOKED'
  | 'OVERDUE_60_DAYS'
  | 'CREDIT_CHECK_FAILED'
  // B14（refs G3-LA）：V1 删除守卫的依赖计数查不出来 ⇒ 拒删并回滚（503，可重试）
  | 'DEPENDENCY_CHECK_FAILED'
  // G-4：L/C 确认门禁两码 —— 没有这两枚时 `codeMap[code] ?? 'INTERNAL_ERROR'` 会把
  // 「被信用证挡住」销毁成内部错误（机器可读码没了、HTTP 也变 500），是 V2 路由上
  // MOQ_VIOLATION 踩过的同一个坑（见 routeV2.ts 该处注释）第二次落地。
  | 'LC_GATE_BLOCKED'
  | 'LC_EXCEPTION_CHECK_FAILED'
  | 'ALREADY_SETTLED'
  | CreditExceptionConsumptionErrorCode
  | 'INTERNAL_ERROR';

export interface OrderV2Result<T = any> {
  ok: boolean;
  data?: T;
  error?: { code: OrderV2Error; message: string; approvalRequestId?: string };
}

// ────────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────────
export function createOrderServiceV2(prisma: PrismaClient) {
  const permSvc = createPermissionService({ prisma });
  const seqSvc = createSequenceService(prisma);
  const dictSvc = getDataDictionaryService(prisma);
  const configSvc = getSystemConfigService(prisma);
  // v2.2（DR-042 §5.1 L2）：订单可见性锚 = 跟进客户 ∪ 团队共享（teamShareSvc 解析）
  const teamShareSvc = createTeamShareService(prisma);
  // MOQ 域服务（配置 → 取数 → 校验；豁免审批单统一经 approvalCreateService，DR-007 服务端解析 reviewerId）
  const moqConfigSvc = createMoqConfigService({ prisma });
  const moqResolutionSvc = createMoqResolutionService({ prisma, configService: moqConfigSvc });
  const moqValidationSvc = createMoqValidationService({
    prisma,
    configService: moqConfigSvc,
    resolutionService: moqResolutionSvc,
    approvalCreateService: createApprovalCreateService({
      prisma,
      routingService: createApprovalRoutingService({ prisma }),
    }),
  });
  // 信用域统一服务（Track F）：建单门禁 fail-closed 接线（W-A 走查 DE-1 修复）
  const creditSvc = createCreditService({ prisma });

  // ── 行级权限 where 构造（v2.2 DR-042 §5.1 L2 换锚）──
  // 订单可见性锚 = 宿主客户的跟进人（followedBy）∪ 团队共享客户 ∪ 真全权角色；
  // 客户转让（ownerId/salesRepIds 变更）后历史订单视野自动继承（T-38）。
  // 无客户锚的遗留订单（customerRelationId=null）回退创建者可见。
  async function buildScopeWhere(actor: TokenPayload | null | undefined): Promise<Record<string, unknown>> {
    if (!actor) return { ownerId: '__NOBODY__' };
    const resolver = await permSvc.getDataScopeResolver(actor, 'orders');
    if (resolver.rule.kind === 'all') return {};
    const visibleRelationIds = await teamShareSvc.resolveVisibleRelationIds(actor);
    return {
      OR: [
        { customerRelationId: { in: visibleRelationIds } },
        { AND: [{ customerRelationId: null }, { ownerId: actor.userId }] },
      ],
    };
  }

  // ── 订单写 scope（v2.2 DR-042 §5.3）：创建者 ∪ 宿主客户跟进人 ∪ 真全权角色 ──
  async function buildOrderWriteScopeWhere(actor: TokenPayload | null | undefined): Promise<Record<string, unknown>> {
    if (!actor) return { ownerId: '__NOBODY__' };
    const resolver = await permSvc.getDataScopeResolver(actor, 'orders');
    if (resolver.rule.kind === 'all') return {};
    const followedIds = await (prisma as any).relation.findMany({
      where: {
        deletedAt: null,
        OR: [{ ownerId: actor.userId }, { salesRepIds: { has: actor.userId } }],
      },
      select: { id: true },
    });
    return {
      OR: [
        { ownerId: actor.userId },
        { customerRelationId: { in: followedIds.map((r: any) => r.id) } },
      ],
    };
  }

  // ── 字典校验 ──
  async function validateDictField(dictCode: string, value: string | undefined): Promise<string | null> {
    if (!value) return null;
    const entries = await dictSvc.getEntries(dictCode, { enabledOnly: false });
    if (entries.length === 0) return null;
    const found = entries.find((e) => e.key === value);
    if (!found) return `值 "${value}" 不在字典 ${dictCode} 的合法枚举中`;
    if (found.disabled) return `值 "${value}" 已被禁用`;
    return null;
  }

  // ── 编号生成 ──
  async function generateOrderCode(): Promise<string> {
    try {
      const number = await seqSvc.nextNumber(prisma as any, 'order');
      return number;
    } catch (e: any) {
      logger.error('[OrderV2] 编号生成失败', { error: e?.message });
      throw e;
    }
  }

  // ── 配置默认值 ──
  async function applyConfigDefaults(input: CreateOrderInput): Promise<CreateOrderInput> {
    const merged = { ...input };
    if (!merged.currency) {
      merged.currency = await configSvc.getString('finance.defaultTradeCurrency', 'USD');
    }
    if (!merged.paymentTerms) {
      merged.paymentTerms = await configSvc.getString('finance.defaultPaymentTerms', 'TT_30_PRE');
    }
    // 未填写贸易条款就是未确认，不能由配置伪造成 FOB。
    // ★ A19：**刻意不给 `paymentInstrument` 兜默认值**（上面三条都有，唯独它不许有）。
    //   理由：本列的「空」在业务上 = 「不知道」，不是「没填所以要补个合理的」。
    //   补默认值 = 把「不知道」伪造成一个具体结算方式 ⇒ 正是 §9 B51 / 拍板件 §2.2
    //   明令的「可空列的空 ≠ 合法值」。空就让它空着，由 L/C 门禁按
    //   `LC_INSTRUMENT_NOT_RECORDED` 放行并提示补录（不阻断、但可见）。
    return merged;
  }

  // ── BigInt 序列化 ──
  function serializeOrder(row: any): any {
    const out: any = orderQuantityDto(row);
    for (const k of Object.keys(out)) {
      if (typeof out[k] === 'bigint') out[k] = Number(out[k]);
    }
    if (out.quoteAmount && typeof out.quoteAmount === 'object' && out.quoteAmount.toString) {
      out.quoteAmount = Number(out.quoteAmount.toString());
    }
    // Decimal fields
    for (const k of ['totalNet', 'totalActual', 'salesPrice', 'contractAmount', 'actualPaymentAmount',
      'shipmentAmount', 'purchasePrice', 'supplierInvoiceAmount']) {
      if (out[k] && typeof out[k] === 'object' && out[k].toString) {
        out[k] = Number(out[k].toString());
      }
    }
    return serializeValue(out);
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. 列表查询（带行级权限 + 筛选 + 分页）
  // ══════════════════════════════════════════════════════════════════
  async function listOrders(
    actor: TokenPayload | null | undefined,
    filter: OrderListFilter = {},
  ): Promise<OrderV2Result<OrderListResult>> {
    try {
      const scopeWhere = await buildScopeWhere(actor);
      const where: Record<string, unknown> = {
        deletedAt: null,
        ...scopeWhere,
      };
      if (filter.status) where.status = filter.status;
      if (filter.type) where.type = filter.type;
      if (filter.ownerId) where.ownerId = filter.ownerId;
      if (filter.departmentId) where.departmentId = filter.departmentId;
      if (filter.customerCode) where.customerCode = filter.customerCode;
      if (filter.customerRelationId) where.customerRelationId = filter.customerRelationId;
      if (filter.businessLine) where.businessLine = filter.businessLine;
      if (filter.search) {
        const s = filter.search.trim();
        if (s) {
          // 安全修复（行级越权）：搜索条件必须 AND 嵌套在行级 scope 之内——
          // 此前 scope.OR（来自 buildScopeWhere）与搜索条件平级 OR 合并，
          // 搜索命中任一字段即可绕过数据范围（受限角色带 search 可见/导出他人订单）。
          // 修复后 scope.OR 保持顶层（与其他筛选同层 AND 语义），搜索独立成组。
          (where as any).AND = [
            ...((where as any).AND ?? []),
            {
              OR: [
                { customer: { contains: s, mode: 'insensitive' } },
                { product: { contains: s, mode: 'insensitive' } },
                { code: { contains: s, mode: 'insensitive' } },
                { poNumber: { contains: s, mode: 'insensitive' } },
                // E4：供应商（工厂）/ 发票号（我方发票 + 供应商发票）/ 合同号（销售合同 + 最终合同）
                { millName: { contains: s, mode: 'insensitive' } },
                { invoiceNumber: { contains: s, mode: 'insensitive' } },
                { supplierInvoiceNumber: { contains: s, mode: 'insensitive' } },
                { salesContractNumber: { contains: s, mode: 'insensitive' } },
                { finalContractNumber: { contains: s, mode: 'insensitive' } },
              ],
            },
          ];
        }
      }

      const limit = filter.exportAll ? undefined : Math.min(Math.max(filter.limit ?? 50, 1), 500);
      const offset = filter.exportAll ? 0 : Math.max(filter.offset ?? 0, 0);
      const orderBy: any[] = [];
      const sortMap: Record<string, string> = {
        createdAt: 'createdAt',
        dueDate: 'dueDate',
        status: 'status',
        quoteAmount: 'quoteAmount',
      };
      if (filter.sort && sortMap[filter.sort]) {
        orderBy.push({ [sortMap[filter.sort]]: 'desc' });
      } else {
        orderBy.push({ createdAt: 'desc' });
      }

      const [items, total] = await Promise.all([
        (prisma as any).order.findMany({
          where,
          orderBy,
          ...(limit != null ? { take: limit, skip: offset } : {}),
          include: { lines: true },
        }),
        (prisma as any).order.count({ where }),
      ]);

      return {
        ok: true,
        data: {
          items: items.map(serializeOrder),
          total,
          limit: limit ?? items.length,
          offset,
          hasMore: limit != null ? offset + items.length < total : false,
        },
      };
    } catch (e: any) {
      logger.error('[OrderV2] list failed', { error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '订单服务内部错误' } };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 2. 详情（带行级权限校验）
  // ══════════════════════════════════════════════════════════════════
  async function getOrder(
    actor: TokenPayload | null | undefined,
    id: string,
  ): Promise<OrderV2Result<any>> {
    try {
      const scopeWhere = await buildScopeWhere(actor);
      const row = await (prisma as any).order.findFirst({
        where: { id, deletedAt: null, ...scopeWhere },
        include: { lines: true },
      });
      if (!row) return { ok: false, error: { code: 'NOT_FOUND', message: '订单不存在或无权限查看' } };
      return { ok: true, data: serializeOrder(row) };
    } catch (e: any) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '订单服务内部错误' } };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. 创建（编号生成 + 字典校验 + 配置默认值 + ownerId 自动填充）
  // ══════════════════════════════════════════════════════════════════
  async function createOrder(
    actor: TokenPayload | null | undefined,
    input: CreateOrderInput,
  ): Promise<OrderV2Result<any>> {
    // DE-5：信用例外放行上下文（生效例外命中时记录，建单事务内核销）
    let creditExceptionPass: { service: ExceptionService; exception: ActiveExceptionSummary; scope: ExceptionScopeMatch } | null = null;
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '创建订单需登录' } };
      if (!input.customer?.trim() && !isInternalOrderPurpose(input.orderPurpose)) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'customer 必填' } };
      if (!input.product?.trim()) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'product 必填' } };
      input = normalizeOrderTradePatch(input) as CreateOrderInput;
      const tradeError = orderTradeTermsError(input);
      if (tradeError) return { ok: false, error: { code: 'VALIDATION_FAILED', message: tradeError } };
      input = normalizeOrderTradePatch(input) as CreateOrderInput;
      input={...input,quantity:parseOrderQuantity(input.quantity)};

      // 字典校验 type
      if (input.type) {
        const err = await validateDictField('order_type', input.type);
        if (err) return { ok: false, error: { code: 'VALIDATION_FAILED', message: `type ${err}` } };
      }
      // status 校验（复用现有状态枚举 + 字典）
      const status = input.status || 'Pending';
      if (!VALID_ORDER_STATUSES.includes(status as any)) {
        return { ok: false, error: { code: 'VALIDATION_FAILED', message: `status 必须是: ${VALID_ORDER_STATUSES.join(', ')}` } };
      }
      if (status !== 'Pending') {
        return { ok: false, error: { code: 'CONFLICT', message: '新订单必须先以草稿状态保存，再由业务负责人审批后确认。' } };
      }

      // 配置默认值
      const withDefaults = await applyConfigDefaults(input);
      Object.assign(withDefaults, await normalizeInternalOrderInput(prisma, await currentOrderLineWriteActor(prisma, actor, 'create'), withDefaults));

      // v2.2（DR-042 §6.2 T-21）：以客户名义新建订单需为「宿主客户跟进人」（ownerId ∨ salesRepIds）
      // 或真全权角色；小组共享（read / read+followup）不开放下单——防越权（此前 createOrder
      // 未校验 customerRelationId 归属，组员可对共享客户直接下单）。
      if (withDefaults.customerRelationId) {
        const canCreateForCustomer = await teamShareSvc.hasRelationWriteAccess(actor, withDefaults.customerRelationId);
        if (!canCreateForCustomer) {
          return { ok: false, error: { code: 'FORBIDDEN', message: '仅跟进人可对该客户创建订单（DR-042 §6.2 T-21）' } };
        }

        // ── 信用门禁（信用控制规则 §6 #6，fail-closed；W-A 走查 DE-1 修复）──
        // Frozen/Revoked/Net61+ 逾期未结清客户禁止建新单；门禁自身故障同样阻断（不放行）
        try {
          const credit = await creditSvc.checkCreditAvailable({
            relationId: withDefaults.customerRelationId,
            amount: Number(withDefaults.quoteAmount ?? 0) || undefined,
          });
          if (!credit.ok) {
            logger.error('[OrderV2] 信用门禁校验失败（fail-closed 阻断建单）', { relationId: withDefaults.customerRelationId, error: credit.error.message });
            return { ok: false, error: { code: 'CREDIT_CHECK_FAILED', message: `信用门禁校验失败：${credit.error.message}` } };
          }
          const creditData = credit.data as { blocked: boolean; blockCode: string | null; blockReason: string | null };
          if (creditData.blocked) {
            logger.warn('[OrderV2] 信用门禁阻断建单', { relationId: withDefaults.customerRelationId, blockCode: creditData.blockCode, actorId: actor.userId });
            // DE-5：DR-013 信用例外闭环 — 生效例外放行；无例外自动发起 credit_exemption 申请
            // （审批单 id 透传 DE-6 契约）；审批中不重复发起；发起失败保持阻断并提示手工入口
            const exceptionSvc = createCreditExceptionService(prisma);
            const scope: ExceptionScopeMatch = { targetType: 'Relation', targetId: withDefaults.customerRelationId, action: 'order:create' };
            const exemption = await resolveCreditException({
              exceptionService: exceptionSvc,
              scope,
              actorId: actor.userId,
              blockReason: creditData.blockReason ?? '客户信用门禁阻断',
            });
            if (exemption.passed) {
              creditExceptionPass = { service: exceptionSvc, exception: exemption.exception, scope };
            } else {
              return {
                ok: false,
                error: {
                  code: (creditData.blockCode ?? 'CREDIT_FROZEN_60_DAYS') as OrderV2Error,
                  message: `${creditData.blockReason ?? '客户信用门禁阻断，禁止新建订单'}（${exemption.hint}）`,
                  ...(exemption.approvalRequestId ? { approvalRequestId: exemption.approvalRequestId } : {}),
                },
              };
            }
          }
        } catch (e: any) {
          logger.error('[OrderV2] 信用门禁校验异常（fail-closed 阻断建单）', { relationId: withDefaults.customerRelationId, error: e?.message });
          return { ok: false, error: { code: 'CREDIT_CHECK_FAILED', message: `信用门禁校验失败，请重试或联系管理员：${e?.message}` } };
        }
      }

      // 编号生成
      const code = await generateOrderCode();

      // ownerId / departmentId 自动填充
      const ownerId = input.ownerId || actor.userId;
      const departmentId = input.departmentId || actor.departmentIds?.[0] || null;

      const id = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // ── MOQ 快照 writeOnce（不追溯；创建时写入，后续绝不改写） ──
      const moqSnapshot = await moqConfigSvc.buildSnapshot();

      // ── Capsule 豁免（DR-003）：仅成衣订单可勾选，记录操作者/时间（§6 #0） ──
      const capsuleRequested = withDefaults.capsuleExemption === true;
      if (capsuleRequested && !isCapsuleEligible({ type: withDefaults.type, businessLine: withDefaults.businessLine })) {
        return { ok: false, error: { code: 'FORBIDDEN', message: 'CAPSULE_NOT_ALLOWED：Capsule 豁免仅适用于服装订单' } };
      }
      const capsuleFields: Record<string, unknown> = capsuleRequested
        ? { capsuleExemption: true, capsuleExemptionBy: actor.userId, capsuleExemptionAt: new Date() }
        : { capsuleExemption: false, capsuleExemptionBy: null, capsuleExemptionAt: null };

      const payload: Record<string, unknown> = {
        id,
        code,
        customer: withDefaults.customer,
        product: withDefaults.product,
        type: withDefaults.type || 'Other',
        quantity: parseOrderQuantity(withDefaults.quantity),
        unit: normalizeOrderQuantityUnit(withDefaults.unit),
        status,
        dueDate: withDefaults.dueDate || '',
        quoteAmount: withDefaults.quoteAmount || 0,
        ownerId,
        departmentId,
        currency: withDefaults.currency,
        paymentTerms: withDefaults.paymentTerms,
        deliveryTerms: withDefaults.deliveryTerms,
        customerRelationId: withDefaults.customerRelationId || null,
        businessLine: withDefaults.businessLine || null,
        updatedAt: BigInt(Date.now()),
        fieldSources: { _origin: 'manual-v2' },
        moqSnapshot,
        ...capsuleFields,
      };
      // 透传白名单内的可选字段（ORDER_OPTIONAL_FIELDS；非法字段（如 unitPrice）不再透传，
      // moqSnapshot/capsuleExemption* 已在上方显式赋值，客户端注入不会覆盖）
      for (const k of ORDER_OPTIONAL_FIELDS) {
        const v = (withDefaults as Record<string, unknown>)[k];
        if (payload[k] === undefined && v != null) payload[k] = v;
      }
      payload.poNumber = normalizeExternalPoNumber(withDefaults.poNumber);

      // A used Relation/order:create exception and its new order commit together.
      // Ordinary creation remains a single insert; no unused exception is spent.
      const pass = creditExceptionPass;
      const order = await prisma.$transaction(async tx => {
          const freshActor = await currentOrderLineWriteActor(tx, actor, 'create');
          Object.assign(payload, await normalizeInternalOrderInput(tx, freshActor, withDefaults));
          const created = await (tx as any).order.create({ data: payload, include: { lines: true } });
          if (pass) await consumeCreditException({
            exceptionService: pass.service,
            exceptionId: pass.exception.id,
            scope: pass.scope,
            actorId: actor.userId,
            tx,
            note: `订单 ${created.id} 创建经信用例外 ${pass.exception.exceptionNumber} 放行`,
          });
          return created;
        });

      // ── MOQ 创建校验（advisory：草稿保存不阻断；Confirmed 门禁/变更门禁 fail-closed 兜底） ──
      let moqCheck: unknown = null;
      try {
        moqCheck = await moqValidationSvc.validateCreate({
          type: payload.type as string,
          businessLine: payload.businessLine as string | null,
          capsuleExemption: payload.capsuleExemption === true,
          customerRelationId: payload.customerRelationId as string | null,
          snapshot: moqSnapshot,
          lines: [{ quantity: Number(withDefaults.quantity) }],
        }, { actor: { userId: actor.userId, roles: actor.roles, roleIds: actor.roleIds, permissions: actor.permissions } });
        if ((moqCheck as any).ok === false) {
          logger.warn('[OrderV2] MOQ 低于阈值（advisory，推进 Confirmed 时需豁免审批）', {
            id, blockedLineIndexes: (moqCheck as any).blockedLineIndexes,
          });
        }
      } catch (e: any) {
        logger.error('[OrderV2] MOQ 创建校验异常（不阻断创建）', { id, error: e?.message });
        moqCheck = null;
      }

      logger.info('[OrderV2] created', { id, code, status, ownerId, snapshotSource: moqSnapshot.source });
      return { ok: true, data: { ...serializeOrder(order), moqCheck } };
    } catch (e: any) {
      if(e instanceof OrderQuantityError)return {ok:false,error:{code:'VALIDATION_FAILED',message:e.message}};
      const denied = orderLineWriteFailure(e); if (denied) return {ok:false,error:denied};
      if (isBusinessError(e)) return {ok:false,error:{code:e.code as OrderV2Error,message:typeof e.message === 'string' ? e.message : '订单输入不完整。'}};
      logger.error('[OrderV2] create failed', { error: e?.message });
      if (e instanceof CreditExceptionConsumptionError) {
        const safe = safeRouteError(e, { fallbackCode: 'INTERNAL_ERROR' });
        return { ok: false, error: { code: e.code, message: safe.message } };
      }
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '订单服务内部错误' } };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. 更新（权限校验 + 字典校验）
  // ══════════════════════════════════════════════════════════════════
  async function updateOrder(
    actor: TokenPayload | null | undefined,
    id: string,
    input: Record<string, unknown>,
  ): Promise<OrderV2Result<any>> {
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '更新订单需登录' } };
      if (Object.prototype.hasOwnProperty.call(input,'ownerId') || Object.prototype.hasOwnProperty.call(input,'departmentId')) {
        return {ok:false,error:{code:'CONFLICT',message:'责任归属请使用订单 responsibility 接口，核对原更新时间后明确保存。'}};
      }
      // v2.2（DR-042 §5.3）：订单写 = 创建者 ∪ 宿主客户跟进人
      const currentActor = await currentOrderLineWriteActor(prisma, actor, 'update');
      const scopeWhere = await freshOrderLineScope(prisma, currentActor);
      const existing = await (prisma as any).order.findFirst({
        where: { id, deletedAt: null, AND: [scopeWhere] },
      });
      if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: '订单不存在或无权限操作' } };
      if (await (prisma as any).approvalRequest.findFirst({ where: { actionType: 'order:main_approval', targetType: 'Order', targetId: id, status: 'pending' }, select: { id: true } })) {
        return { ok: false, error: { code: 'CONFLICT', message: '订单主单审批处理中，订单内容已冻结；请等待审批结果。' } };
      }
      input = normalizeOrderTradePatch(input, existing as unknown as Record<string, unknown>);
      const editableInput: Record<string, unknown> = Object.fromEntries(ORDER_OPTIONAL_FIELDS.filter(field => input[field] !== undefined).map(field => [field, input[field]]));
      if (['deliveryTerms', 'deliveryPlace', 'contractDeliveryDate', 'expectedArrivalDate', 'agreedArrivalDate', 'clientDate'].some(field => input[field] !== undefined)) {
        const tradeError = orderTradeTermsError({ ...existing, ...editableInput });
        if (tradeError) return { ok: false, error: { code: 'VALIDATION_FAILED', message: tradeError } };
      }
      if (input.status !== undefined) editableInput.status = input.status;
      assertOrderHeaderEditable(existing, editableInput);

      // 字典校验 type（如果传入）
      if (input.type) {
        const err = await validateDictField('order_type', input.type as string);
        if (err) return { ok: false, error: { code: 'VALIDATION_FAILED', message: `type ${err}` } };
      }

      // ── MOQ 变更门禁（§X fail-closed）：Confirmed+ 订单数量变更须重算 MOQ（取 Order.moqSnapshot 口径） ──
      if (input.quantity !== undefined && (await prisma.orderLine.count({where:{orderId:id}}))===0 && parseOrderQuantity(input.quantity)!==existing.quantity?.toString()) {
        try {
          const moqPatch = await moqValidationSvc.validatePatch({
            orderId: id,
            beforeQty: Number(existing.quantity),
            afterQty: Number(input.quantity),
            actorId: actor.userId,
          });
          if (moqPatch.blocked) {
            return {
              ok: false,
              error: {
                code: 'MOQ_VIOLATION',
                message: `变更后数量 ${input.quantity} 低于 MOQ ${moqPatch.effectiveMoq}（快照口径），需 MOQ 豁免审批`,
                approvalRequestId: moqPatch.approvalRequestId,
              },
            };
          }
          if ((moqPatch.cancelledCount ?? 0) > 0) {
            logger.info('[OrderV2] 数量回升合规，已自动取消挂起 MOQ 豁免单', { id, cancelledCount: moqPatch.cancelledCount });
          }
        } catch (e: any) {
          if (e?.code !== 'MOQ_ORDER_NOT_FOUND') {
            // fail-closed：校验基础设施异常时阻断数量写入（§6 #1 异常分支）
            logger.error('[OrderV2] MOQ 变更校验异常（fail-closed 阻断数量写入）', { id, error: e?.message });
            return { ok: false, error: { code: 'MOQ_VIOLATION', message: `MOQ 校验失败，请重试或联系管理员：${e?.message}` } };
          }
        }
      }

      // ── Capsule 豁免切换（DR-003）：仅成衣订单；勾选/取消均重记操作者与时间 ──
      if (input.capsuleExemption !== undefined) {
        const wantCapsule = input.capsuleExemption === true;
        if (wantCapsule && !isCapsuleEligible({
          type: (input.type as string) ?? existing.type,
          businessLine: (input.businessLine as string) ?? existing.businessLine,
        })) {
          return { ok: false, error: { code: 'FORBIDDEN', message: 'CAPSULE_NOT_ALLOWED：Capsule 豁免仅适用于服装订单' } };
        }
        input.capsuleExemptionBy = actor.userId;
        input.capsuleExemptionAt = new Date();
      }

      // 构建 update payload（只更新白名单内传入的字段；moqSnapshot 为 writeOnce，绝不在更新路径出现）
      const payload: Record<string, unknown> = {};
      for (const f of ORDER_OPTIONAL_FIELDS) {
        if ((input as Record<string, unknown>)[f] !== undefined) payload[f] = (input as Record<string, unknown>)[f];
      }
      payload.updatedAt = BigInt(Date.now());

      // ── B285：改单必须留痕（此前 v2 的更新路径一条审计都不写，而 v1 的 `PUT /:id` 在事务里写）──
      //   ★ 与 v1 同一处语义：**审计写入与业务更新在同一个事务里** ⇒ 不留"改了但查不到"的中间态，
      //     也不开"审计失败就吞掉"的那个口子（本仓有 `fail-open-gate` 那把尺专门盯这类静默 catch）。
      //   复用共享助手 `writeFieldAuditDiff`（逐字段一行），不自己再写一份 diff。
      const tracked = Object.keys(payload).filter((k) => k !== 'updatedAt');
      const plain = (row: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const k of tracked) {
          const v = row?.[k];
          out[k] = typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() : v;
        }
        return out;
      };

      const updated = await (prisma as any).$transaction(async (tx: any) => {
        const authorized = await authorizeOrderLineWrite(tx, id, actor, 'update');
        const fresh = authorized.order;
        Object.assign(payload, await normalizeInternalOrderInput(tx, authorized.actor, payload, fresh));
        assertOrderHeaderEditable(fresh, payload);
        if (['deliveryTerms', 'contractDeliveryDate', 'agreedArrivalDate'].some(key => key in payload)) {
          const lines = await tx.orderLine.findMany({ where: { orderId: id } });
          for (const line of lines) {
            const error = orderLineDeliveryError({ ...fresh, ...payload }, line);
            if (error) throw businessError('INVALID_INPUT', `条目 ${line.itemNo || line.lineNumber}：${error}`);
          }
        }
        await guardOrderHeaderQuantity(tx,fresh,payload,input.expectedUpdatedAt??input.updatedAt);
        const u = await tx.order.update({ where: { id }, data: payload, include: { lines: true } });
        if (tracked.length > 0) {
          await writeFieldAuditDiff({
            prisma: tx,
            actorId: authorized.actor.userId,
            source: 'service:orders:update-v2',
            operation: 'update_order',
            targetType: 'Order',
            targetId: id,
            before: plain(fresh as Record<string, unknown>),
            after: plain(u as Record<string, unknown>),
            trackedFields: tracked,
            operationType: 'update',
          });
        }
        return u;
      });
      logger.info('[OrderV2] updated', { id, fields: Object.keys(payload) });
      return { ok: true, data: serializeOrder(updated) };
    } catch (e: any) {
      if(e instanceof OrderQuantityError)return {ok:false,error:{code:'VALIDATION_FAILED',message:e.message}};
      const authority = orderLineWriteFailure(e);
      if (authority) return { ok:false,error:authority };
      if(e?.code==='CONFLICT')return {ok:false,error:{code:'CONFLICT',message:e.message}};
      logger.error('[OrderV2] update failed', { id, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '订单服务内部错误' } };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. 状态流转（复用现有状态机矩阵）
  // ══════════════════════════════════════════════════════════════════
  async function transitionStatus(
    actor: TokenPayload | null | undefined,
    id: string,
    newStatus: string,
    reason?: string,
  ): Promise<OrderV2Result<any>> {
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '状态流转需登录' } };
      if (!VALID_ORDER_STATUSES.includes(newStatus as any)) {
        return { ok: false, error: { code: 'VALIDATION_FAILED', message: `status 必须是: ${VALID_ORDER_STATUSES.join(', ')}` } };
      }

      // v2.2（DR-042 §5.3）：状态流转写 = 创建者 ∪ 宿主客户跟进人
      const scopeWhere = await buildOrderWriteScopeWhere(actor);
      const existing = await (prisma as any).order.findFirst({
        where: { id, deletedAt: null, ...scopeWhere },
        select: {
          id: true, status: true, code: true, type: true, businessLine: true,
          quantity: true, capsuleExemption: true, moqSnapshot: true, customerRelationId: true,
        },
      });
      if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: '订单不存在或无权限操作' } };

      // 状态机校验
      const currentStatus = existing.status;
      if (currentStatus === newStatus) {
        return { ok: false, error: { code: 'INVALID_TRANSITION', message: `订单已是 ${currentStatus} 状态，无需变更` } };
      }
      const allowedTargets = ORDER_TRANSITIONS[currentStatus];
      if (!allowedTargets || !allowedTargets.has(newStatus)) {
        return { ok: false, error: { code: 'INVALID_TRANSITION', message: `不允许从 ${currentStatus} → ${newStatus}（合法目标: ${allowedTargets ? [...allowedTargets].join(', ') : '无'}）` } };
      }

      // ── 统一确认引擎（W-A 走查 DE-2/DE-4 修复，方案 a：消除 V1/V2 双轨）──
      // 状态机校验 / DR-010 守卫 / 信用+MOQ 确认门禁 / OrderStatusTransition 留痕 /
      // EntityLink 同步 / 审计 / OrderStatusChanged+OrderConfirmed 事件发布（L1 生产管线、L6 BOM 联动）
      // 全部收敛到 V1 orderLifecycleService.transitionOrderStatus 单引擎，V2 仅保留行级 scope 前置校验。
      const transition = await transitionOrderStatus({
        prisma,
        orderId: id,
        toStatus: newStatus,
        note: reason,
        operator: actor.userId,
        actorId: actor.userId,
      });
      if (!transition.ok) {
        const codeMap: Record<string, OrderV2Error> = {
          ORDER_NOT_FOUND: 'NOT_FOUND',
          INVALID_STATUS: 'VALIDATION_FAILED',
          INVALID_TRANSITION: 'INVALID_TRANSITION',
          NO_CHANGE: 'INVALID_TRANSITION',
          ORDER_LIFECYCLE_GUARDED: 'INVALID_TRANSITION',
          ORDER_MAIN_APPROVAL_REQUIRED: 'ORDER_MAIN_APPROVAL_REQUIRED',
          ORDER_ALREADY_CLOSED: 'INVALID_TRANSITION',
          MOQ_VIOLATION: 'MOQ_VIOLATION',
          CREDIT_FROZEN_60_DAYS: 'CREDIT_FROZEN_60_DAYS',
          CREDIT_REVOKED: 'CREDIT_REVOKED',
          OVERDUE_60_DAYS: 'OVERDUE_60_DAYS',
          CREDIT_CHECK_FAILED: 'CREDIT_CHECK_FAILED',
          // G-4：漏这两枚 = 「被信用证挡住」在这条路由上变成 INTERNAL_ERROR + 500（见类型定义处注释）
          LC_GATE_BLOCKED: 'LC_GATE_BLOCKED',
          LC_EXCEPTION_CHECK_FAILED: 'LC_EXCEPTION_CHECK_FAILED',
        };
        return {
          ok: false,
          error: {
            code: codeMap[transition.error!.code]
              ?? (isCreditExceptionConsumptionErrorCode(transition.error!.code) ? transition.error!.code : 'INTERNAL_ERROR'),
            message: transition.error!.message,
            approvalRequestId: transition.error!.approvalRequestId,
          },
        };
      }

      logger.info('[OrderV2] status transition', { id, from: transition.data!.fromStatus, to: newStatus, reason });
      return { ok: true, data: serializeOrder(transition.data!.order) };
    } catch (e: any) {
      logger.error('[OrderV2] transition failed', { id, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '订单服务内部错误' } };
    }
  }

  // ── G3-4 订单结案（绿）：业务员手动"确认结清"（复用现有核销；UI 侧回款进度满才可点） ──
  async function settleOrder(
    actor: TokenPayload | null | undefined,
    id: string,
    note?: string,
  ): Promise<OrderV2Result<any>> {
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '确认结清需登录' } };

      const scopeWhere = await buildOrderWriteScopeWhere(actor);
      const existing = await (prisma as any).order.findFirst({
        where: { id, deletedAt: null, ...scopeWhere },
        select: { id: true, code: true, status: true, settledAt: true },
      });
      if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: '订单不存在或无权限操作' } };
      if (existing.settledAt) return { ok: false, error: { code: 'ALREADY_SETTLED', message: '订单已结清，无需重复确认' } };

      const now = BigInt(Date.now());
      const updated = await (prisma as any).order.update({
        where: { id },
        data: { settledAt: now, settledBy: actor.userId, updatedAt: now },
        include: { lines: true },
      });

      // 结清留痕审计
      try {
        await (prisma as any).auditLog.create({
          data: {
            id: `alog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            actorId: actor.userId,
            action: 'order_settled',
            targetType: 'Order',
            targetId: id,
            detail: { note: note || null, settledBy: actor.userId },
            operationType: 'update',
            fieldPath: 'settledAt',
            beforeValue: null,
            afterValue: String(now),
            transactionId: null,
          },
        });
      } catch { /* 审计失败不阻断结清 */ }

      logger.info('[OrderV2] settled', { id, code: existing.code, settledBy: actor.userId });
      return { ok: true, data: serializeOrder(updated) };
    } catch (e: any) {
      logger.error('[OrderV2] settle failed', { id, error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '结清失败，请重试或联系管理员' } };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 6. 软删除（权限校验）
  // ══════════════════════════════════════════════════════════════════
  async function deleteOrder(
    actor: TokenPayload | null | undefined,
    id: string,
  ): Promise<OrderV2Result<any>> {
    try {
      if (!actor) return { ok: false, error: { code: 'UNAUTHORIZED', message: '删除订单需登录' } };
      // v2.2（DR-042 §5.3）：删除写 = 创建者 ∪ 宿主客户跟进人
      const scopeWhere = await buildOrderWriteScopeWhere(actor);
      const existing = await (prisma as any).order.findFirst({
        where: { id, deletedAt: null, ...scopeWhere },
        select: { id: true, code: true, customer: true },
      });
      if (!existing) return { ok: false, error: { code: 'NOT_FOUND', message: '订单不存在或无权限操作' } };

      // 统一删除引擎（对齐 transitionStatus 的 DE-2/DE-4 单引擎收敛）：V1
      // orderLifecycleService.deleteOrder 在同事务内完成依赖守卫（发票/发票分摊/出运单/
      // 出运分摊/付款凭证/批次计划 六路 → HAS_DEPENDENTS 409）+ 软删 + EntityLink inactive
      // + 报价 convertedOrderId 解除（防删单后报价永久卡死）+ 审计留痕。V2 仅保留行级
      // scope 前置校验，不再旁路直写 deletedAt（旁路会让分摊链/报价链断链且无审计）。
      const del = await deleteOrderV1({
        prisma,
        orderId: id,
        actorId: actor.userId,
      });
      if (!del.ok) {
        const codeMap: Record<string, OrderV2Error> = {
          ORDER_NOT_FOUND: 'NOT_FOUND',
          ORDER_ALREADY_DELETED: 'NOT_FOUND',
          HAS_DEPENDENTS: 'HAS_DEPENDENTS',
          // B14：码原名透出（不塌成 INTERNAL_ERROR）—— 否则「校验没结论」在 V2 看起来
          // 和「删除真的失败」是同一个码，用户/前端无从知道该重试（文案已由 V1 带来，G7.5）。
          DEPENDENCY_CHECK_FAILED: 'DEPENDENCY_CHECK_FAILED',
          DELETE_FAILED: 'INTERNAL_ERROR',
        };
        // 文案直接取 V1 的：这里曾自己抄了一份 messageMap（`HAS_DEPENDENTS: '订单存在关联单据
        // （发票/出运/凭证/核销分摊）…'`）。那是**第二份依赖清单**，而且它把 V1 已经算出来的
        // "具体是哪几类挡着"抹成了固定枚举 —— 补第六路（批次计划）时它不会自己长大，
        // 用户挂一张批次计划被拒时会看到"发票/出运/凭证/核销分摊"四个不相干的选项。
        // 现在只映射码、不映射文案：V1 是判定方，也是文案方（同一份 blockers 数组）。
        return {
          ok: false,
          error: {
            code: codeMap[del.error!.code] ?? 'INTERNAL_ERROR',
            message: del.error!.message,
          },
        };
      }
      logger.info('[OrderV2] soft-deleted', { id, code: existing.code });
      return { ok: true, data: serializeOrder(del.data!.order) };
    } catch (e: any) {
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '订单服务内部错误' } };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 7. 看板聚合（按 status 分组 count → 前端 Kanban 渲染）
  // ══════════════════════════════════════════════════════════════════
  async function getKanban(
    actor: TokenPayload | null | undefined,
    filter: { type?: string; businessLine?: string } = {},
  ): Promise<OrderV2Result<OrderKanbanResult>> {
    try {
      const scopeWhere = await buildScopeWhere(actor);
      const where: Record<string, unknown> = {
        deletedAt: null,
        ...scopeWhere,
      };
      if (filter.type) where.type = filter.type;
      if (filter.businessLine) where.businessLine = filter.businessLine;

      const rows = await (prisma as any).order.findMany({
        where,
        select: { status: true },
      });
      const statusCounts = new Map<string, number>();
      let total = 0;
      for (const r of rows) {
        const s = r.status || 'Pending';
        statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
        total++;
      }

      // 从 DataDictionary 获取 status 的 label/color/order
      const entries = await dictSvc.getEntries('order_status', { enabledOnly: false });
      const metaMap = new Map(entries.map((e) => [e.key, e]));
      const allStatuses = entries.length > 0
        ? entries.map((e) => e.key)
        : [...VALID_ORDER_STATUSES];

      const statuses = allStatuses
        .map((key) => {
          const meta = metaMap.get(key);
          return {
            status: key,
            label: meta?.label || key,
            count: statusCounts.get(key) || 0,
            color: meta?.color,
          };
        })
        .sort((a, b) => {
          const oa = metaMap.get(a.status)?.order ?? 99;
          const ob = metaMap.get(b.status)?.order ?? 99;
          return oa - ob;
        });

      return { ok: true, data: { statuses, total } };
    } catch (e: any) {
      logger.error('[OrderV2] kanban failed', { error: e?.message });
      return { ok: false, error: { code: 'INTERNAL_ERROR', message: '订单服务内部错误' } };
    }
  }

  return {
    listOrders,
    getOrder,
    createOrder,
    updateOrder,
    transitionStatus,
    deleteOrder,
    getKanban,
    buildScopeWhere,
    settleOrder,
  };
}

// ────────────────────────────────────────────────────────────────────
// 单例
// ────────────────────────────────────────────────────────────────────
let _defaultService: ReturnType<typeof createOrderServiceV2> | null = null;
export function getOrderServiceV2(prisma: PrismaClient): ReturnType<typeof createOrderServiceV2> {
  if (!_defaultService) _defaultService = createOrderServiceV2(prisma);
  return _defaultService;
}
