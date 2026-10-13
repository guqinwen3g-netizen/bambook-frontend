import { assembleQuotationDocData, freezeQuotationDocumentImages } from '../templates/docTemplates/quotation';
import { createHash } from 'node:crypto';
import {factoryRelationIdentitySelect,isUsableFactoryRelation} from '../suppliers/factoryRelationIdentity';
import { commercialFields, quotationWriteFields, QUOTATION_COMMERCIAL_FIELDS, QUOTATION_LINE_COMMERCIAL_FIELDS, validateQuotationCatalog, resolveQuotationType } from './quotationCommercial';
import {summarizeConversionQuantities} from '../orders/orderConversionCommandContract';
import {normalizeOrderQuantityUnit} from '../shared/orderQuantitySummary';
/**
 * 报价管理服务 Quotation Service
 *
 * 职责：
 *   1. 报价单 CRUD（含行明细，事务内创建/更新）
 *   2. 状态流转：Draft → Sent → Accepted/Rejected/Expired
 *   3. 业务事件发布（QuotationIssued / QuotationAccepted）
 *   4. 行金额自动计算 + 报价总金额汇总
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），不物理删除
 *   - 事务内创建报价 + 行 + 审计日志
 *   - 状态转换有严格校验（非法转换抛 409）
 *   - 事件发布失败不阻断业务（通知系统是 fire-and-forget）
 */

import { PrismaClient, Prisma, Quotation, QuotationLine } from '@prisma/client';
import type { TokenPayload } from '../auth/service';
import { createPermissionService } from '../auth/permissionService';
import { createTeamShareService } from '../teams/teamShareService';
import { logger } from '../lib/logger';
import { businessEventBus, persistBusinessEventInTransaction, type BusinessEvent } from '../events/businessEventBus';
import { authorizeQuotationConversion, newQuotationConversionDelegation, type QuotationConversionContext } from './quotationConversionAuthority';
import { deactivateEntityLinks, syncOrderEntityReferences, syncQuotationReferences } from '../entities/sync';
import { calculatePriceDeviation, DeviationLevel } from '../pricing/trackAEstimator';
import { resolveActorUserAccountId } from '../agent/actorIdentity';
import { businessError } from '../shared/errorCodes';
import { nextBusinessNumber } from '../shared/businessNumberService';
import { allocateInternalOrderCode, normalizeExternalPoNumber } from '../orders/orderIdentity';
import { createMoqConfigService, type MoqSnapshot } from '../moq/moqConfigService';
import { createMoqResolutionService, isValidSnapshot } from '../moq/moqResolutionService';
import { createMoqValidationService } from '../moq/moqValidationService';
import { createApprovalRoutingService } from '../approvals/approvalRoutingService';
import { createApprovalCreateService } from '../approvals/approvalCreateService';
import { buildQuotationSnapshot, canonicalQuotationJson, lockQuotationSource, assertSameQuotationSource, assertQuotationApprovalConsumption } from './quotationApprovalSnapshot';
import { assertFabricAllowed } from '../products/fabricExclusivityService';
import { prepareOrderConversionCommercial, freezeOrderConversionCommercial, consumeOrderConversionCommercial } from '../orders/orderConversionCommercial';
import { createCreditService } from '../credit/creditService';
import { createCreditExceptionService, resolveCreditException, consumeCreditException } from '../credit/creditExceptionGate';
import type { ActiveExceptionSummary, ExceptionScopeMatch } from '../exceptions/exceptionGate';
import type { ExceptionService } from '../exceptions/exceptionService';
import {
  createPriceDeviationRuleService,
  PRICE_APPROVAL_POLICY_KEY,
  PRICE_RULE_CONDITION,
} from '../pricing/priceDeviationRuleService';
import { todayLocalKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface QuotationLineInput {
  productAssetId?: string; productType?: string; specification?: string; moq?: number; leadTimeDays?: number; leadTimeStart?: string; priceTiers?: {minQuantity:number;unitPrice:number}[];
  fabricCode?: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  notes?: string;
  /** REQ2-12 产品图片 URL（行级快照 DR-053-②：档案主图自动带出或手动上传） */
  imageUrl?: string;
}

export interface CreateQuotationInput {
  quotationType?: string; contactName?: string | null; contactPhone?: string | null; tradePlace?: string | null; internalCostBasis?: any;
  /** 报价号（可选，服务端自动生成 QT-YYYY-NNNN；传入时优先使用传入值并校验唯一性） */
  quotationNumber?: string;
  currency: string;
  customerRelationId?: string;
  customerName?: string;
  customerCode?: string;
  // G1-3 报价正向关联（报价=关联审批单，指向项目/订单/条目，多粒度）
  developmentCaseId?: string;
  orderId?: string;
  orderLineId?: string;
  issueDate?: string;
  validUntil?: string;
  deliveryTerms?: string;
  paymentTerms?: string;
  /**
   * 付款方式（结算工具）：T/T | L/C | O/A | D/P | D/A | Other（选项真源 `lib/orderSchema.ts:246`）。
   * ★ A19（§9 B51）：此前报价侧**没有这一列**，而 `convertToOrder` 也不拷它
   *   ⇒ 转出的订单恒 null ⇒ L/C 门禁对整条报价转单路径 100% 免检（fail-open）。
   * ★ `null` / `undefined` / `''` = **未录**（不知道），**不是**「非信用证」。
   */
  paymentInstrument?: string | null;
  salesperson?: string;
  inquiryRef?: string;
  exchangeRate?: number;
  baseCurrency?: string;
  notes?: string;
  lines: QuotationLineInput[];
  // ── 双轨定价快照（PRD 8.6；可选，A/B 双轨价齐备时创建即计算偏差分级并持久化）──
  trackAMedianUsd?: number; // 轨道 A 中位估算美元单价
  trackAUnit?: string; // PC（件） | M（米）
  trackBFinalUsd?: number; // 轨道 B 终价美元单价
}

export interface UpdateQuotationInput extends Partial<CreateQuotationInput> {
  status?: string;
}

export type QuotationStatus = 'Draft' | 'Sent' | 'Accepted' | 'Rejected' | 'Expired';

export interface QuotationDetail extends Quotation {
  lines: QuotationLine[];
}

// ────────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────────

const VALID_STATUSES: QuotationStatus[] = ['Draft', 'Sent', 'Accepted', 'Rejected', 'Expired'];

/** 报价单创建可写字段白名单（route / Agent Flow 共用真源；lines 元素字段见 QuotationLineInput） */
export const QUOTATION_CREATE_FIELDS: readonly string[] = [
  ...QUOTATION_COMMERCIAL_FIELDS,
  'quotationNumber', 'currency', 'customerRelationId', 'customerName', 'customerCode', 'issueDate',
  'validUntil', 'deliveryTerms', 'paymentTerms', 'paymentInstrument', 'salesperson', 'inquiryRef', 'exchangeRate',
  'baseCurrency', 'notes', 'lines', 'trackAMedianUsd', 'trackAUnit', 'trackBFinalUsd',
  'developmentCaseId', 'orderId', 'orderLineId',
];

/**
 * 报价单更新可 patch 字段白名单（仅 Draft 可编辑；双轨快照与 MOQ 快照为 writeOnce，不可 patch；
 * status 走状态机流转，不在 update 通道内）
 */
export const QUOTATION_UPDATE_PATCH_FIELDS: readonly string[] = [
  ...QUOTATION_COMMERCIAL_FIELDS,
  'quotationNumber', 'currency', 'customerRelationId', 'customerName', 'customerCode', 'issueDate',
  'validUntil', 'deliveryTerms', 'paymentTerms', 'paymentInstrument', 'salesperson', 'inquiryRef', 'exchangeRate',
  'baseCurrency', 'notes', 'lines', 'developmentCaseId', 'orderId', 'orderLineId',
];

// 状态转换矩阵：key → 允许的目标状态
const TRANSITIONS: Record<string, QuotationStatus[]> = {
  Draft: ['Sent', 'Expired'],
  Sent: ['Accepted', 'Rejected', 'Expired'],
  Accepted: [], // 终态
  Rejected: [], // 终态
  Expired: [], // 终态
};

// ── C15 报价单自动过期（查询时检查方案，不做定时任务）──
// 读取路径（listQuotations / getQuotation）发现 validUntil 已过的 Draft/Sent 报价单时，
// 当场落库标记 Expired 并在本次返回中反映终态；状态过滤视角下被翻转的行从本次结果剔除。
const AUTO_EXPIRABLE_STATUSES = new Set<string>(['Draft', 'Sent']);

function todayDateString(): string {
  return todayLocalKey();
}

function isPastValidUntil(validUntil: unknown, today: string): boolean {
  // validUntil 为 YYYY-MM-DD 字符串；「有效期至」含当日，次日零点起视为过期
  return typeof validUntil === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(validUntil) && validUntil < today;
}

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

function generateQuotationId(): string {
  return `QT_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateLineId(): string {
  return `QTL_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function calcLineAmount(quantity: number, unitPrice: number): number {
  return Math.round(quantity * unitPrice * 10000) / 10000; // 4 位小数
}

function calcTotalAmount(lines: QuotationLineInput[]): number {
  return lines.reduce((sum, l) => sum + calcLineAmount(l.quantity, l.unitPrice), 0);
}

function validateStatusTransition(from: string, to: QuotationStatus): void {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(`非法状态转换：${from} → ${to}（允许的目标：${allowed?.join(', ') || '无（终态）'}）`);
  }
}

// ────────────────────────────────────────────────────────────────
// REQ2-19（DR-060-①）：版本快照 helper（append-only，事务内调用）
// ────────────────────────────────────────────────────────────────
/** 将当前报价（含行）完整快照为 QuotationVersion（保存新版本前的旧内容留档） */
export async function snapshotQuotationVersion(tx: any, quotation: any, actorId: string, changeReason: string | null): Promise<void> {
  // An issued version already frozen at issuance must never be rebuilt on revision.
  if (tx.quotationVersion?.findFirst && await tx.quotationVersion.findFirst({where:{quotationId:quotation.id,version:quotation.version ?? 1}})) return;
  const sourceLines = Array.isArray(quotation.lines) ? quotation.lines : [];
  const frozenImages = ['Sent','Accepted','Rejected','Expired'].includes(quotation.status) ? freezeQuotationDocumentImages(assembleQuotationDocData({...quotation, lines:sourceLines})).lines : null;
  const lines = sourceLines.map((line: any,index: number) => ({...line, imageUrl: frozenImages ? frozenImages[index].imageUrl : line.imageUrl}));
  await tx.quotationVersion.create({
    data: {
      id: `QTV_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      quotationId: quotation.id,
      version: quotation.version ?? 1,
      totalAmount: quotation.totalAmount,
      currency: quotation.currency,
      headerSnapshot: {
        ...commercialFields(quotation, QUOTATION_COMMERCIAL_FIELDS, null),
        status: quotation.status,
        quotationNumber: quotation.quotationNumber,
        customerRelationId: quotation.customerRelationId,
        customerName: quotation.customerName,
        customerCode: quotation.customerCode ?? null,
        ownerId: quotation.ownerId ?? null,
        salesperson: quotation.salesperson ?? null,
        inquiryRef: quotation.inquiryRef ?? null,
        sentAt: quotation.sentAt == null ? null : String(quotation.sentAt),
        issueDate: quotation.issueDate,
        validUntil: quotation.validUntil,
        deliveryTerms: quotation.deliveryTerms,
        paymentTerms: quotation.paymentTerms,
        // ★ A19：版本快照要忠实 —— 付款方式是「这单按什么结算」的一部分，
        //   漏进快照会让历史版本读不出当时的结算方式（快照是 append-only 留档，不许少字段）。
        paymentInstrument: quotation.paymentInstrument ?? null,
        exchangeRate: quotation.exchangeRate != null ? Number(quotation.exchangeRate) : null,
        notes: quotation.notes,
      },
      linesSnapshot: lines.map((l: any) => ({
        ...commercialFields(l, QUOTATION_LINE_COMMERCIAL_FIELDS, null),
        imageUrl: l.imageUrl ?? null,
        notes: l.notes ?? null,
        lineNumber: l.lineNumber,
        fabricCode: l.fabricCode,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitPrice: Number(l.unitPrice),
        amount: Number(l.amount),
      })),
      changeReason,
      changedBy: actorId || null,
      createdAt: Date.now(),
    },
  });
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

/**
 * P2 审计补缺（2026-09-03）：quotations 列表行级数据范围，对齐 orders 列表口径
 * （orderService.buildOrderListScopeWhere，完全同一对底层服务——策略真源单一）。
 *   - resolver.rule.kind === 'all'（财务/QC/后勤/admin/超管）→ {} 不过滤（全公司可见）
 *   - sales/销售主管 → 宿主客户跟进人 ∪ 团队共享客户（resolveVisibleRelationIds）可见；
 *     无客户锚的遗留报价（customerRelationId=null）回退创建者（ownerId=me）可见
 *   - 无 actor（dev 模式 / API-Key 读）→ {} 放行（与 orders 列表同契约，moduleGuard 已把认证关）
 */
export async function buildQuotationListScopeWhere(
  prisma: PrismaClient,
  actor: TokenPayload | null | undefined,
): Promise<Record<string, unknown>> {
  if (!actor) return {};
  const resolver = await createPermissionService({ prisma }).getDataScopeResolver(actor, 'quotations');
  if (resolver.rule.kind === 'all') return {};
  const visibleRelationIds = await createTeamShareService(prisma).resolveVisibleRelationIds(actor);
  return {
    OR: [
      { customerRelationId: { in: visibleRelationIds } },
      { AND: [{ customerRelationId: null }, { ownerId: actor.userId }] },
    ],
  };
}

/**
 * 信用门禁阻断（convertToOrder fail-closed，安全修复）：
 * route 层据 statusCode=409 / code=CREDIT_BLOCKED 映射「拒绝转单」响应，
 * 与 V2 createOrder 的信用门禁错误族（CREDIT_*）同语义。
 */
class CreditBlockedError extends Error {
  readonly code = 'CREDIT_BLOCKED' as const;
  readonly statusCode = 409 as const;
}

export function createQuotationService(prisma: PrismaClient) {
  // MOQ 域服务（报价侧：create/update advisory 校验 + writeOnce 快照；send/convertToOrder fail-closed 门禁）
  // 豁免审批单统一经 approvalCreateService（DR-007 服务端解析 reviewerId，禁止前端/调用方传入）
  const moqConfigSvc = createMoqConfigService({ prisma });
  const moqResolutionSvc = createMoqResolutionService({ prisma, configService: moqConfigSvc });
  const approvalCreateService = createApprovalCreateService({
    prisma,
    routingService: createApprovalRoutingService({ prisma }),
  });
  const moqValidationSvc = createMoqValidationService({
    prisma,
    configService: moqConfigSvc,
    resolutionService: moqResolutionSvc,
    approvalCreateService,
  });
  // §9.2 价格审批规则 ①②④ 评估（折扣>10%/新客首单/低于成本价；⑤ 双轨偏差在 createQuotation 内联计算）
  const priceRuleSvc = createPriceDeviationRuleService(prisma);
  // 信用域统一服务（安全修复：报价转单与 V2 直接建单同口径的建单门禁）
  const creditSvc = createCreditService({ prisma });

  // ── MOQ 行级业务线推导：Quotation 无单据级 type/businessLine 字段，按行 unit 归族 ──
  // PC/PCS/SET（件/套）→ garment 成衣族；其余（M/YD/KG 等）→ fabric 面料族
  function deriveLineBusinessLine(unit?: string | null): 'garment' | 'fabric' {
    const u = (unit ?? '').trim().toUpperCase();
    return u === 'PC' || u === 'PCS' || u === 'SET' ? 'garment' : 'fabric';
  }

  // ── C16 转订单类型推导：按报价行单位归族（与前端 QuotationManager.deriveOrderTypeFromLines 同口径）──
  // PC/PCS/SET → 'Garment'；M/YD/KG/Roll 等面料族单位 → 'Fabric'；混合或未知单位 → 'Other'；
  // 无行保持旧默认 'Fabric'。overrides.type 显式传入时优先。
  // ── MOQ 校验输入组装（逐行推导 businessLine；口径 = 报价单 writeOnce 快照） ──
  function buildMoqLines(lines: Array<{ quantity: unknown; unit?: string | null; moqOverride?: number | null }>) {
    return lines.map((l) => ({
      quantity: String(l.quantity),
      unit: l.unit ?? undefined,
      businessLine: deriveLineBusinessLine(l.unit),
      moqOverride: l.moqOverride ?? null,
    }));
  }

  // ── MOQ 豁免审批单查询（approved 才算有效；查询异常按无豁免处理 → fail-closed 阻断） ──
  async function findApprovedMoqExemption(quotationId: string, db: any = prisma): Promise<string | null> {
    try {
      const approved = await db.approvalRequest.findFirst({
        where: {
          targetType: 'Quotation',
          targetId: quotationId,
          actionType: 'quotation:moq-exemption',
          status: 'approved',
        },
        select: { id: true },
      });
      return approved?.id ?? null;
    } catch (e: any) {
      logger.error('[QuotationService] MOQ 豁免审批单查询失败（fail-closed 按无豁免处理）', { quotationId, error: e?.message });
      return null;
    }
  }

  // ── 创建报价单（含行明细，事务） ──
  async function createQuotation(input: CreateQuotationInput, actorId: string): Promise<QuotationDetail> {
    input = {...input, issueDate: input.issueDate || todayDateString(), lines: await validateQuotationCatalog(prisma,input.quotationType,input.lines)};
    const totalAmount = calcTotalAmount(input.lines);
    const now = Date.now();
    const quotationId = generateQuotationId();

    // ── 双轨偏差快照（PRD 8.6）：A/B 双轨价齐备 → 计算偏差分级；warn/block 自动生成审批 ──
    const trackAOk = Number.isFinite(input.trackAMedianUsd) && (input.trackAMedianUsd as number) > 0;
    const trackBOk = Number.isFinite(input.trackBFinalUsd) && (input.trackBFinalUsd as number) > 0;
    let deviation: { deviationPercent: number; level: DeviationLevel } | null = null;
    if (trackAOk && trackBOk) {
      deviation = calculatePriceDeviation(input.trackBFinalUsd as number, input.trackAMedianUsd as number);
    }

    // ── §9.2 价格规则 ①②④ 评估（折扣>10% / 新客首单 / 低于成本价） ──
    const ruleEval = await priceRuleSvc.evaluateQuotationRules({
      customerRelationId: input.customerRelationId ?? null,
      currency: input.currency,
      exchangeRate: input.exchangeRate ?? null,
      lines: input.lines.map((l) => ({ fabricCode: l.fabricCode ?? null, unitPrice: l.unitPrice, unit: l.unit })),
    });

    // ── P1-3 客户专属面料校验（fail-closed：行面料命中他人独占面料 → 409，违规尝试留痕）──
    for (const line of input.lines) {
      const fabricCode = line.fabricCode?.trim();
      if (!fabricCode) continue;
      const exclusive = await assertFabricAllowed(prisma, {
        customer: { customerRelationId: input.customerRelationId ?? null, customerName: input.customerName ?? null },
        productKeys: {
          // fabricCode 语义宽泛（sku/厂号/品色号/客供品号皆可）：多键并集解析；
          // clientCode 侧仅认「本客户登记 + 无绑定通用码」，不做全局兜底（防异义碰撞误报）
          sku: fabricCode,
          articleNo: fabricCode,
          millQuality: fabricCode,
          clientCode: fabricCode,
          clientCodeCustomerHint: input.customerRelationId ?? null,
          clientCodeGlobalFallback: false,
        },
        context: 'quotation:create',
        actorId,
        documentRef: { quotationNumber: input.quotationNumber ?? 'auto', fabricCode, description: line.description },
      });
      if (!exclusive.ok) {
        throw Object.assign(new Error(exclusive.error.message), { statusCode: exclusive.error.status, code: exclusive.error.code });
      }
    }

    // ── 决策点 3-A 合并：多条件命中 → 单条 ApprovalRequest，hitConditions 数组标注全部命中编号 ──
    const hitConditions: string[] = [...ruleEval.hitConditions];
    if (deviation && deviation.level !== 'ok') hitConditions.push(PRICE_RULE_CONDITION.DUAL_TRACK_DEVIATION);
    // 合并分级：④ 或 ⑤>30% → block；①② 或 ⑤>15% → warn；仅 ⑤ok → ok；全无 → null（保持历史快照语义）
    const mergedLevel: DeviationLevel | null = ruleEval.level === 'block' || deviation?.level === 'block'
      ? 'block'
      : ruleEval.level === 'warn' || deviation?.level === 'warn'
        ? 'warn'
        : deviation
          ? 'ok'
          : null;

    // 任一价格规则命中 → 需要审批：先解析 requester（actor → UserAccount，fallback owner）
    // 无法解析时不阻断创建：快照照常落库，priceApprovalId 置空；发送门禁对 block 仍 fail-closed
    let approvalRequesterId: string | null = null;
    if (hitConditions.length > 0) {
      approvalRequesterId = await resolveActorUserAccountId(prisma, { userId: actorId }).catch(() => null);
      if (!approvalRequesterId) {
        const owner = await prisma.userAccount.findFirst({
          where: { id: 'usr_owner_default', deletedAt: null, status: 'active' },
          select: { id: true },
        }).catch(() => null);
        approvalRequesterId = owner?.id ?? null;
      }
      if (!approvalRequesterId) {
        logger.warn('[QuotationService] price approval skipped: no resolvable requester', {
          quotationNumber: input.quotationNumber, hitConditions, level: mergedLevel,
        });
      }
    }

    // ── MOQ 快照 writeOnce（§2.3 不追溯；创建时写入，此后不随系统配置变更） ──
    const moqSnapshot = await moqConfigSvc.buildSnapshot();

    const created = await prisma.$transaction(async (tx) => {
      // PRD 5.6：服务端自动生成报价号（QT-YYYY-NNNN），传入时优先使用传入值
      // REQ2-12 期间实测发现的第三例软删占位：序列落后于业务表（迁移导入直写/序列表重建）时
      // 生成号撞软删行唯一键 → occupied 回调查目标表（含软删）自动追平（businessNumberService 通用修复）
      const quotationNumber = input.quotationNumber || await nextBusinessNumber(tx, 'QT', undefined, {
        occupied: async (num) => {
          const dup = await tx.quotation.findFirst({ where: { quotationNumber: num }, select: { id: true } });
          return dup != null;
        },
      });
      const quotation = await tx.quotation.create({
        data: {
          id: quotationId,
          quotationNumber,
          status: 'Draft',
          ...quotationWriteFields(input, QUOTATION_COMMERCIAL_FIELDS, null),
          currency: input.currency,
          totalAmount,
          exchangeRate: input.exchangeRate ?? null,
          baseCurrency: input.baseCurrency ?? 'CNY',
          // ★ 走查修复（v1 体验走查·报价链）：建单即落 ownerId。
          //   读侧一直有"无客户锚的报价回退 ownerId=me 才可见"这条规则（本文件 buildQuotationListScopeWhere），
          //   但写侧从来没兑现 ⇒ 业务员建一张还没选客户的草稿，201 成功后在自己的列表里永久找不到（实测）。
          ownerId: actorId || null,
          customerRelationId: input.customerRelationId ?? null,
          customerName: input.customerName ?? null,
          customerCode: input.customerCode ?? null,
          // G1-3 报价正向关联（snapshot FK）：指向开发案/订单/条目（多粒度）
          developmentCaseId: input.developmentCaseId ?? null,
          orderId: input.orderId ?? null,
          orderLineId: input.orderLineId ?? null,
          issueDate: input.issueDate!,
          validUntil: input.validUntil ?? null,
          deliveryTerms: input.deliveryTerms ?? null,
          paymentTerms: input.paymentTerms ?? null,
          // ★ A19（§9 B51）：不加进这里，客户端传了也会被静默丢弃（= 恒 null ⇒ 门禁 fail-open）。
          paymentInstrument: input.paymentInstrument ?? null,
          salesperson: input.salesperson ?? null,
          inquiryRef: input.inquiryRef ?? null,
          notes: input.notes ?? null,
          // 双轨快照（此后为历史快照，不随编辑变更）
          trackAMedianUsd: trackAOk ? (input.trackAMedianUsd as number) : null,
          trackAUnit: trackAOk ? (input.trackAUnit ?? null) : null,
          trackBFinalUsd: trackBOk ? (input.trackBFinalUsd as number) : null,
          priceDeviationPercent: deviation?.deviationPercent ?? null,
          priceDeviationLevel: mergedLevel,
          // DR-007：审批单由事务外 approvalCreateService 通道创建（reviewerId 服务端解析）后回填
          priceApprovalId: null,
          // MOQ 快照（writeOnce）
          moqSnapshot: moqSnapshot as any,
          createdAt: now,
          updatedAt: now,
          lines: {
            create: input.lines.map((line, i) => ({
              id: generateLineId(),
              lineNumber: i + 1,
              ...quotationWriteFields(line, QUOTATION_LINE_COMMERCIAL_FIELDS, null),
              fabricCode: line.fabricCode ?? null,
              description: line.description,
              quantity: line.quantity,
              unit: line.unit,
              unitPrice: line.unitPrice,
              amount: calcLineAmount(line.quantity, line.unitPrice),
              notes: line.notes ?? null,
              imageUrl: line.imageUrl ?? null,
              createdAt: now,
            })),
          },
        },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      // 价格审批单不在本事务内直写（DR-007：reviewerId 必须经 approvalCreateService 路由解析，
      // 禁止 reviewerId=null 落库）；报价单提交后由事务外通道创建并回填 priceApprovalId

      // 审计日志
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'create_quotation',
          targetType: 'Quotation',
          targetId: quotationId,
          detail: { source: 'api:quotation', after: { quotationNumber, totalAmount, lineCount: input.lines.length, priceDeviationLevel: mergedLevel, priceHitConditions: hitConditions } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：quotedFor（customerRelationId → relation.organization）
      await syncQuotationReferences(prisma, quotation, { source: 'api:quotation' }, tx);

      return quotation;
    });

    // ── 价格审批单创建（DR-007：approvalCreateService 通道，reviewerId 由 routingService 解析） ──
    // 与 MOQ 豁免同范式：事务外创建；失败（含 NO_REVIEWER_RESOLVED）不阻断报价创建，
    // reviewerId=null 审批单绝不落库；block 门禁由 sendQuotation fail-closed 兜底
    if (hitConditions.length > 0 && approvalRequesterId) {
      try {
        const quotationSnapshot = buildQuotationSnapshot(created);
        const contentFingerprint = createHash('sha256').update(canonicalQuotationJson({
          actionType: 'quotation:price-deviation', targetType: 'Quotation', targetId: quotationId, quotationSnapshot,
        })).digest('hex');
        const approval = await approvalCreateService.createBusinessApproval({
          requesterId: approvalRequesterId,
          actionType: 'quotation:price-deviation',
          targetType: 'Quotation',
          targetId: quotationId,
          risk: mergedLevel === 'block' ? 'high' : 'medium',
          payload: {
            policyKey: PRICE_APPROVAL_POLICY_KEY,
            hitConditions,
            quotationId,
            quotationNumber: (created as any).quotationNumber ?? input.quotationNumber,
            quotationSnapshot,
            contentFingerprint,
            trackAMedianUsd: input.trackAMedianUsd,
            trackAUnit: input.trackAUnit ?? null,
            trackBFinalUsd: input.trackBFinalUsd,
            deviationPercent: deviation?.deviationPercent ?? null,
            level: mergedLevel,
            ruleFindings: ruleEval.findings as any,
            requestedAt: new Date(now).toISOString(),
            source: deviation && deviation.level !== 'ok' ? 'quotation-dual-track' : 'quotation-price-rules',
          },
        });
        // 回填报价单 ↔ 审批单互链（返回对象同步，保证调用方读到最终态）
        await prisma.quotation.update({ where: { id: quotationId }, data: { priceApprovalId: approval.id } });
        (created as any).priceApprovalId = approval.id;
      } catch (e: any) {
        logger.warn('[QuotationService] 价格审批单创建失败（报价单已落库，发送门禁 fail-closed 兜底）', {
          quotationId, hitConditions, level: mergedLevel, code: e?.code, error: e?.message,
        });
      }
    }

    // ── MOQ 创建校验（advisory：草稿保存不阻断；sendQuotation 门禁 fail-closed 兜底） ──
    let moqCheck: unknown = null;
    try {
      moqCheck = await moqValidationSvc.validateCreate({
        customerRelationId: input.customerRelationId ?? null,
        snapshot: moqSnapshot,
        lines: buildMoqLines(input.lines),
      }, { actor: actorId && actorId !== 'system' ? { userId: actorId } : null });
      if ((moqCheck as any).ok === false) {
        logger.warn('[QuotationService] MOQ 低于阈值（advisory，发送报价时需豁免审批）', {
          id: quotationId, blockedLineIndexes: (moqCheck as any).blockedLineIndexes,
        });
      }
    } catch (e: any) {
      logger.error('[QuotationService] MOQ 创建校验异常（不阻断创建）', { id: quotationId, error: e?.message });
      moqCheck = null;
    }

    logger.info('[QuotationService] quotation created', { id: quotationId, quotationNumber: input.quotationNumber, totalAmount, snapshotSource: moqSnapshot.source });
    return { ...(created as QuotationDetail), moqCheck } as QuotationDetail;
  }

  // ── 更新报价单（仅 Draft 状态可编辑） ──
  async function updateQuotation(id: string, input: UpdateQuotationInput, actorId: string): Promise<QuotationDetail> {
    const existing = await prisma.quotation.findUnique({ where: { id }, include: { lines: true } });
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`报价单 ${id} 状态为 ${existing.status}，仅 Draft 状态可编辑`);
    }

    const now = Date.now();
    if(input.lines) input = {...input,lines:await validateQuotationCatalog(prisma,input.quotationType??(existing as any).quotationType,input.lines)};
    else if(input.quotationType && input.quotationType!==(existing as any).quotationType) await validateQuotationCatalog(prisma,input.quotationType,existing.lines);
    const lines = input.lines;
    const totalAmount = lines ? calcTotalAmount(lines) : Number(existing.totalAmount);

    // ── P1-3 客户专属面料校验（行重建时逐行校验；fail-closed 409 + 违规尝试留痕）──
    if (lines && lines.length > 0) {
      const customer = {
        customerRelationId: input.customerRelationId ?? existing.customerRelationId ?? null,
        customerName: input.customerName ?? existing.customerName ?? null,
      };
      for (const line of lines) {
        const fabricCode = line.fabricCode?.trim();
        if (!fabricCode) continue;
        const exclusive = await assertFabricAllowed(prisma, {
          customer,
          productKeys: {
            sku: fabricCode,
            articleNo: fabricCode,
            millQuality: fabricCode,
            clientCode: fabricCode,
            clientCodeCustomerHint: customer.customerRelationId,
            clientCodeGlobalFallback: false,
          },
          context: 'quotation:update',
          actorId,
          documentRef: { quotationId: id, quotationNumber: existing.quotationNumber, fabricCode },
        });
        if (!exclusive.ok) {
          throw Object.assign(new Error(exclusive.error.message), { statusCode: exclusive.error.status, code: exclusive.error.code });
        }
      }
    }

    // REQ2-19（DR-060-①）：金额或行变化 → 自动快照旧版（append-only 版本链）
    const commercialChanged = [...QUOTATION_COMMERCIAL_FIELDS,'currency','exchangeRate','baseCurrency','deliveryTerms','paymentTerms','paymentInstrument','validUntil','notes'].some(key => Object.prototype.hasOwnProperty.call(input,key) && canonicalQuotationJson((input as any)[key]) !== canonicalQuotationJson((existing as any)[key]));
    const amountChanged = commercialChanged || Math.abs(Number(totalAmount) - Number(existing.totalAmount)) > 1e-9;
    const linesChanged = !!lines && lines.length > 0;

    const initial = existing;
    const updated = await prisma.$transaction(async (tx) => {
      const current = await lockQuotationSource(tx, id);
      assertSameQuotationSource(initial, current);
      const existing = current;
      if (existing.status !== 'Draft') throw new Error(`报价单 ${id} 状态为 ${existing.status}，仅 Draft 状态可编辑`);

      if (amountChanged || linesChanged) {
        await snapshotQuotationVersion(tx, existing, actorId, null);
      }
      // 若提供新行明细，先删后建
      if (lines && lines.length > 0) {
        await tx.quotationLine.deleteMany({ where: { quotationId: id } });
        await tx.quotationLine.createMany({
          data: lines.map((line, i) => ({
            id: generateLineId(),
            quotationId: id,
            lineNumber: i + 1,
            ...quotationWriteFields(line, QUOTATION_LINE_COMMERCIAL_FIELDS, null),
            fabricCode: line.fabricCode ?? null,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice,
            amount: calcLineAmount(line.quantity, line.unitPrice),
            notes: line.notes ?? null,
            imageUrl: line.imageUrl ?? null,
            createdAt: now,
          })),
        });
      }

      const quotation = await tx.quotation.update({
        where: { id },
        data: {
          ...quotationWriteFields(input, QUOTATION_COMMERCIAL_FIELDS),
          quotationNumber: input.quotationNumber ?? undefined,
          currency: input.currency ?? undefined,
          totalAmount,
          // REQ2-19：版本随快照递增（snapshotQuotationVersion 写旧版后 +1）
          version: (amountChanged || linesChanged) ? (existing.version ?? 1) + 1 : undefined,
          exchangeRate: input.exchangeRate ?? undefined,
          baseCurrency: input.baseCurrency ?? undefined,
          customerRelationId: input.customerRelationId ?? undefined,
          customerName: input.customerName ?? undefined,
          customerCode: input.customerCode ?? undefined,
          // §10.7 复扫修复：三关联列支持显式 null 解绑（此前 ?? undefined 吞掉 null，关联一旦建立无法清除）
          developmentCaseId: input.developmentCaseId !== undefined ? input.developmentCaseId : undefined,
          orderId: input.orderId !== undefined ? input.orderId : undefined,
          orderLineId: input.orderLineId !== undefined ? input.orderLineId : undefined,
          issueDate: input.issueDate ?? undefined,
          validUntil: input.validUntil ?? undefined,
          deliveryTerms: input.deliveryTerms ?? undefined,
          paymentTerms: input.paymentTerms ?? undefined,
          // ★ A19：与 `paymentTerms` 同形（`?? undefined`）—— 显式 null 在本通道**不清空**该列。
          //   要清回「未录」须另开通道（本轮不扩围，如实登记为未覆盖处）。
          paymentInstrument: input.paymentInstrument ?? undefined,
          salesperson: input.salesperson ?? undefined,
          inquiryRef: input.inquiryRef ?? undefined,
          notes: input.notes ?? undefined,
          updatedAt: now,
        },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'update_quotation',
          targetType: 'Quotation',
          targetId: id,
          detail: { source: 'api:quotation', before: { quotationNumber: existing.quotationNumber }, after: { quotationNumber: input.quotationNumber ?? existing.quotationNumber } } as any,
          ip: null,
          operationType: 'update',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：quotedFor 快照随 FK 更新
      await syncQuotationReferences(prisma, quotation, { source: 'api:quotation' }, tx);

      return quotation;
    });

    // ── MOQ 编辑校验（advisory：行变更时按 writeOnce 快照口径重算，不阻断保存；moqSnapshot 绝不改写） ──
    let moqCheck: unknown = null;
    if (lines && lines.length > 0) {
      try {
        moqCheck = await moqValidationSvc.validateCreate({
          customerRelationId: input.customerRelationId ?? existing.customerRelationId ?? null,
          snapshot: (existing as any).moqSnapshot ?? null,
          lines: buildMoqLines(lines),
        }, { actor: actorId && actorId !== 'system' ? { userId: actorId } : null });
        if ((moqCheck as any).ok === false) {
          logger.warn('[QuotationService] MOQ 低于阈值（advisory，发送报价时需豁免审批）', {
            id, blockedLineIndexes: (moqCheck as any).blockedLineIndexes,
          });
        }
      } catch (e: any) {
        logger.error('[QuotationService] MOQ 编辑校验异常（不阻断保存）', { id, error: e?.message });
        moqCheck = null;
      }
    }

    logger.info('[QuotationService] quotation updated', { id });
    return { ...(updated as QuotationDetail), moqCheck } as QuotationDetail;
  }

  // ── 软删除报价单（仅 Draft 状态可删除） ──
  async function deleteQuotation(id: string, actorId: string): Promise<void> {
    const existing = await prisma.quotation.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    if (existing.status !== 'Draft') {
      throw new Error(`报价单 ${id} 状态为 ${existing.status}，仅 Draft 状态可删除`);
    }

    const now = Date.now();
    await prisma.$transaction(async (tx) => {
      await tx.quotation.update({ where: { id }, data: { deletedAt: now, updatedAt: now } });
      // EntityLink 图谱：软删同步失效发出的关联
      await deactivateEntityLinks(tx, 'quotation', id, BigInt(now));
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'delete_quotation',
          targetType: 'Quotation',
          targetId: id,
          detail: { source: 'api:quotation', before: { quotationNumber: existing.quotationNumber, status: existing.status } } as any,
          ip: null,
          operationType: 'delete',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });
    });

    logger.info('[QuotationService] quotation deleted', { id });
  }

  // ── 查询报价单列表 ──
  async function listQuotations(params: {
    status?: string;
    customerRelationId?: string;
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    limit?: number;
    offset?: number;
    /** Excel 台账导出=true：忽略分页上限全量导出（route 层 format=xlsx 专用） */
    exportAll?: boolean;
    /** P2 行级数据范围（route 层 buildQuotationListScopeWhere 产物；空对象=不过滤） */
    scopeWhere?: Record<string, unknown>;
  }): Promise<{ items: Quotation[]; total: number }> {
    const where: any = { deletedAt: null };
    if (params.status) where.status = params.status;
    if (params.customerRelationId) where.customerRelationId = params.customerRelationId;
    if (params.dateFrom || params.dateTo) {
      where.issueDate = {};
      if (params.dateFrom) where.issueDate.gte = params.dateFrom;
      if (params.dateTo) where.issueDate.lte = params.dateTo;
    }
    if (params.search) {
      where.OR = [
        { quotationNumber: { contains: params.search } },
        { customerName: { contains: params.search } },
        { inquiryRef: { contains: params.search } },
      ];
    }
    // P2 行级：scopeWhere 并入 AND（避免与 search 的 OR 冲突；AND 语义 = 过滤叠加）
    if (params.scopeWhere && Object.keys(params.scopeWhere).length > 0) {
      where.AND = Array.isArray(where.AND) ? [...where.AND, params.scopeWhere] : [params.scopeWhere];
    }

    const limit = params.exportAll ? undefined : Math.min(params.limit ?? 50, 200);
    const offset = params.exportAll ? 0 : (params.offset ?? 0);

    const [items, total] = await Promise.all([
      prisma.quotation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...(limit != null ? { take: limit, skip: offset } : {}),
      }),
      prisma.quotation.count({ where }),
    ]);

    // ── C15 查询时自动过期：本页命中 validUntil 已过的 Draft/Sent 单 → 落库翻转 Expired ──
    const today = todayDateString();
    const expiredIds = items
      .filter((q) => AUTO_EXPIRABLE_STATUSES.has(q.status) && isPastValidUntil(q.validUntil, today))
      .map((q) => q.id);
    if (expiredIds.length > 0) {
      await prisma.quotation.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: 'Expired', updatedAt: Date.now() },
      });
      for (const q of items) {
        if (expiredIds.includes(q.id)) (q as any).status = 'Expired';
      }
      logger.info('[QuotationService] auto-expired quotations on read', { ids: expiredIds });
    }
    // 状态过滤视角一致性：翻转后与过滤条件不符的行从本次结果剔除（下次查询天然不再命中）
    const viewItems = params.status ? items.filter((q) => q.status === params.status) : items;
    const removed = items.length - viewItems.length;

    return { items: viewItems, total: Math.max(total - removed, 0) };
  }

  // ── 查询单个报价单（含行明细） ──
  async function getQuotation(id: string): Promise<QuotationDetail | null> {
    const quotation = await prisma.quotation.findUnique({
      where: { id },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    if (!quotation || quotation.deletedAt) return null;

    // ── C15 查询时自动过期：详情读取同样翻转（与列表同一口径） ──
    if (AUTO_EXPIRABLE_STATUSES.has(quotation.status) && isPastValidUntil(quotation.validUntil, todayDateString())) {
      await prisma.quotation.update({
        where: { id },
        data: { status: 'Expired', updatedAt: Date.now() },
      });
      (quotation as any).status = 'Expired';
      logger.info('[QuotationService] auto-expired quotation on read', { id });
    }

    return quotation as QuotationDetail;
  }

  // ── 状态转换：发送报价单 Draft → Sent ──
  async function sendQuotation(id: string, actorId: string): Promise<QuotationDetail> {
    const existing = await prisma.quotation.findUnique({ where: { id }, include: { lines: true } });
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    validateStatusTransition(existing.status, 'Sent');
    const confirmedType = await resolveQuotationType(prisma, existing);
    await validateQuotationCatalog(prisma, confirmedType, existing.lines);

    // ── 价格审批红标门禁（PRD 8.6 ⑤ + §9.2 ④ 合并分级）：block 未审批通过禁止发送（fail-closed）──
    if (existing.priceDeviationLevel === 'block') {
      let approved = false;
      let approval: any = null;
      if (existing.priceApprovalId) {
        approval = await prisma.approvalRequest.findUnique({ where: { id: existing.priceApprovalId } });
        approved = approval?.status === 'approved';
      }
      if (!approved) {
        // 命中条件取自审批单 payload.hitConditions（①②④⑤ 合并单条，决策点 3-A）；历史数据缺省时回退双轨口径
        const hitConditions: string[] = Array.isArray(approval?.payload?.hitConditions) ? approval.payload.hitConditions : [];
        const conditionText = hitConditions.length > 0
          ? `命中价格审批条件 [${hitConditions.join(' / ')}]`
          : `双轨偏差 ${existing.priceDeviationPercent ?? '?'}% 超过 30% 红标阈值`;
        // DE-6 统一透传：审批单 id 挂到错误对象，route 层回传 body 供前端跳转审批中心
        throw Object.assign(
          new Error(
            `报价单 ${existing.quotationNumber} ${conditionText}，`
            + `需审批通过后方可发送（门禁：price-deviation${existing.priceApprovalId ? '' : '，审批请求缺失'}）`,
          ),
          { code: 'PRICE_DEVIATION_BLOCKED', ...(existing.priceApprovalId ? { approvalRequestId: existing.priceApprovalId } : {}) },
        );
      }
    }

    // ── MOQ 门禁（§4.3 + §6 #2 fail-closed）：存在低于 MOQ 的行且无 approved 豁免审批单 → 阻断发送 ──
    // 口径：Quotation.moqSnapshot（writeOnce）；不合规时自动生成豁免审批单（§6 #2 动作③，DR-007 解析 reviewerId）
    try {
      const moqCheck = await moqValidationSvc.validateCreate({
        customerRelationId: existing.customerRelationId ?? null,
        snapshot: (existing as any).moqSnapshot ?? null,
        lines: buildMoqLines(existing.lines),
      }, {
        actor: actorId && actorId !== 'system' ? { userId: actorId } : null,
        autoCreateApproval: Boolean(actorId && actorId !== 'system'),
        targetType: 'Quotation',
        targetId: id,
      });
      if (!moqCheck.ok) {
        const approvedId = await findApprovedMoqExemption(id);
        if (!approvedId) {
          const worst = moqCheck.lines.find((l) => !l.compliant);
          // DE-6 统一透传：豁免审批单 id 挂到错误对象，route 层回传 body 供前端跳转审批中心
          throw Object.assign(
            new Error(
              `报价单 ${existing.quotationNumber} 存在低于 MOQ 的行（行 ${(worst?.lineIndex ?? 0) + 1} 数量 ${worst?.quantity} < MOQ ${worst?.effectiveMoq}，缺口 ${worst?.gapPct}%），`
              + `需 MOQ 豁免审批通过后方可发送（门禁：moq-exemption${moqCheck.approvalRequestId ? `，审批单 ${moqCheck.approvalRequestId} 待审批` : ''}${moqCheck.approvalError ? '，审批单创建失败请联系管理员' : ''}）`,
            ),
            { code: 'MOQ_VIOLATION', ...(moqCheck.approvalRequestId ? { approvalRequestId: moqCheck.approvalRequestId } : {}) },
          );
        }
      }
    } catch (e: any) {
      if (typeof e?.message === 'string' && e.message.includes('门禁：moq-exemption')) throw e;
      // fail-closed：门禁校验基础设施异常 → 阻断发送
      logger.error('[QuotationService] MOQ 发送门禁校验异常（fail-closed 阻断）', { id, error: e?.message });
      throw new Error(`报价单 ${existing.quotationNumber} MOQ 校验失败，请重试或联系管理员（门禁：moq-exemption）：${e?.message}`);
    }

    const now = Date.now();
    const initial = existing;
    const updated = await prisma.$transaction(async (tx) => {
      const current = await lockQuotationSource(tx, id);
      assertSameQuotationSource(initial, current);
      const existing = current;
      validateStatusTransition(existing.status, 'Sent');
      await assertQuotationApprovalConsumption(tx, existing);

      const quotation = await tx.quotation.update({
        where: { id },
        data: { status: 'Sent', updatedAt: now, sentAt: existing.sentAt ?? now }, // 重发场景保留首次发送时间
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      await snapshotQuotationVersion(tx, quotation, actorId, 'issued');

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'send_quotation',
          targetType: 'Quotation',
          targetId: id,
          detail: { source: 'api:quotation', before: { status: 'Draft' }, after: { status: 'Sent' } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: 'Draft',
          afterValue: 'Sent',
          transactionId: null,
        },
      });

      return quotation;
    });

    // 发布 QuotationIssued 业务事件（fire-and-forget，不阻断业务）
    try {
      businessEventBus.publish({
        id: `bev_qt_${now}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'QuotationIssued',
        sourceEntityType: 'Quotation',
        sourceEntityId: id,
        payload: {
          quotationId: id,
          quotationNumber: existing.quotationNumber,
          customerName: existing.customerName,
          customerRelationId: existing.customerRelationId,
          totalAmount: Number(existing.totalAmount),
          currency: existing.currency,
          lineCount: existing.lines.length,
        },
        occurredAt: now,
        actorId: actorId || 'system',
      });
    } catch (e: any) {
      logger.warn('[QuotationService] QuotationIssued event publish failed (non-blocking)', { error: e?.message });
    }

    logger.info('[QuotationService] quotation sent', { id, quotationNumber: existing.quotationNumber });
    return updated as QuotationDetail;
  }

  // ── 状态转换：接受报价单 Sent → Accepted ──
  async function acceptQuotation(id: string, actorId: string, note?: string, authority?: QuotationConversionContext): Promise<QuotationDetail> {
    if(authority?.mode!=='verified_actor') throw businessError('UNAUTHORIZED','Verified current actor required to accept quotation.');
    const {quotation:existing}=await authorizeQuotationConversion(prisma,actorId,authority,id);
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    validateStatusTransition(existing.status, 'Accepted');

    const now = Date.now();
    const eventId=`bev_qa_${now}_${Math.random().toString(36).slice(2,8)}`,auditId=`alog_qa_${now}_${Math.random().toString(36).slice(2,8)}`;
    let acceptedEvent:BusinessEvent|null=null;
    const updated = await prisma.$transaction(async (tx) => {
      const current=await lockQuotationSource(tx,id);
      assertSameQuotationSource(existing,current);
      await authorizeQuotationConversion(tx,actorId,authority,id);
      validateStatusTransition(current.status,'Accepted');
      const quotation = await tx.quotation.update({
        where: { id },
        data: { status: 'Accepted', updatedAt: now },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      const conversionDelegation=newQuotationConversionDelegation(authority.actor,quotation,eventId,auditId);
      await tx.auditLog.create({
        data: {
          id: auditId,
          createdAt:new Date(now),
          actorId: actorId || 'system',
          action: 'accept_quotation',
          targetType: 'Quotation',
          targetId: id,
          detail: { source: 'api:quotation', before: { status: 'Sent' }, after: { status: 'Accepted', note }, conversionDelegation, automaticConversionStatus:conversionDelegation?'authorized':'legacy_unverified' } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: 'Sent',
          afterValue: 'Accepted',
          transactionId: null,
        },
      });

      acceptedEvent={id:eventId,type:'QuotationAccepted',sourceEntityType:'Quotation',sourceEntityId:id,payload:{quotationId:id,quotationNumber:quotation.quotationNumber,customerName:quotation.customerName,totalAmount:String(quotation.totalAmount),currency:quotation.currency,lines:quotation.lines.map(line=>({description:line.description,quantity:String(line.quantity),unit:line.unit,unitPrice:String(line.unitPrice),amount:String(line.amount)})),conversionDelegation,automaticConversionStatus:conversionDelegation?'authorized':'legacy_unverified'},occurredAt:now,actorId};
      await persistBusinessEventInTransaction(tx,acceptedEvent);
      return quotation;
    });

    // 发布 QuotationAccepted 业务事件
    try {
      await businessEventBus.publish(acceptedEvent!);
    } catch (e: any) {
      logger.warn('[QuotationService] QuotationAccepted event publish failed (non-blocking)', { error: e?.message });
    }

    logger.info('[QuotationService] quotation accepted', { id, quotationNumber: existing.quotationNumber });
    return {...updated,automaticConversionStatus:(acceptedEvent as unknown as BusinessEvent).payload.automaticConversionStatus} as QuotationDetail;
  }

  // ── 状态转换：拒绝报价单 Sent → Rejected ──
  async function rejectQuotation(id: string, actorId: string, note?: string): Promise<QuotationDetail> {
    const existing = await prisma.quotation.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    validateStatusTransition(existing.status, 'Rejected');

    const now = Date.now();
    const updated = await prisma.$transaction(async (tx) => {
      const quotation = await tx.quotation.update({
        where: { id },
        data: { status: 'Rejected', updatedAt: now },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'reject_quotation',
          targetType: 'Quotation',
          targetId: id,
          detail: { source: 'api:quotation', before: { status: 'Sent' }, after: { status: 'Rejected', note } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'status',
          beforeValue: 'Sent',
          afterValue: 'Rejected',
          transactionId: null,
        },
      });

      return quotation;
    });

    logger.info('[QuotationService] quotation rejected', { id, quotationNumber: existing.quotationNumber });
    return updated as QuotationDetail;
  }

  // ── 标记过期（调度器或手动触发） ──
  async function expireQuotation(id: string, actorId: string): Promise<QuotationDetail> {
    const existing = await prisma.quotation.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    if (existing.status !== 'Draft' && existing.status !== 'Sent') {
      throw new Error(`报价单 ${id} 状态为 ${existing.status}，不可标记过期`);
    }

    const now = Date.now();
    const updated = await prisma.quotation.update({
      where: { id },
      data: { status: 'Expired', updatedAt: now },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });

    logger.info('[QuotationService] quotation expired', { id });
    return updated as QuotationDetail;
  }

  // ── 转为正式订单（Accepted → Order） ──
  // 将已接受的报价单转为生产订单，自动映射字段 + 创建订单行 + 标记 convertedOrderId
  async function convertToOrder(
    id: string,
    actorId: string,
    overrides?: { poNumber?: string; millName?: string; millRelationId?: string|null; type?: string; dueDate?: string; paymentInstrument?: string },
    authority?: QuotationConversionContext,
    commandExecution?: {tx: Prisma.TransactionClient; commercialPrepared: Awaited<ReturnType<typeof prepareOrderConversionCommercial>>; moqSnapshot: MoqSnapshot},
  ): Promise<{ orderId: string; quotation: QuotationDetail }> {
    const sourceDb=commandExecution?.tx??prisma;
    const {quotation:existing}=await authorizeQuotationConversion(sourceDb,actorId,authority,id);
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    if (existing.status !== 'Accepted') {
      throw new Error(`报价单 ${id} 状态为 ${existing.status}，仅 Accepted 可转为订单`);
    }
    if (existing.convertedOrderId) {
      throw new Error(`报价单 ${id} 已转为订单 ${existing.convertedOrderId}，不可重复转换`);
    }

    const orderType = await resolveQuotationType(sourceDb,existing);
    if(overrides?.type && overrides.type!==orderType) throw businessError('INVALID_INPUT','订单类型必须与报价类型一致。');
    await validateQuotationCatalog(sourceDb,orderType,existing.lines);

    // Preserve approval precedence before preparing credit or checking the
    // deployed quantity representation; transaction repeats the same guard.
    await assertQuotationApprovalConsumption(sourceDb,existing,'convert');
    // Preserve every exact line. The header is a same-unit summary only;
    // mixed-unit quotations intentionally leave it empty instead of adding unlike quantities.
    const quantitySummary=summarizeConversionQuantities(existing.lines.map(line=>{
      const unit=normalizeOrderQuantityUnit(line.unit);
      if(!unit)throw businessError('INVALID_INPUT','报价转单数量单位尚未核定，不能创建订单。');
      return {quantity:String(line.quantity),unit};
    }));
    const now = Date.now();
    const orderId = `ORD-QT-${String(now).slice(-8)}`;
    const poNumber = normalizeExternalPoNumber(overrides?.poNumber);
    const millName = overrides?.millName || '';
    // Business type is fixed by the quotation's catalog identity, never by quantity units.
    const dueDate = overrides?.dueDate || '';
    const totalAmount = Number(existing.totalAmount);

    // ── MOQ 转换门禁（§6 #3 fail-closed）：报价行低于 MOQ 时须持 approved 豁免审批单 ──
    // 有 approved → 复制审批引用至 Order 快照（fieldSources.moqExemptionApprovalId），不重复触发审批；
    // 无 approved / 已撤销 / 已拒绝 → 抛异常中止转换。
    let moqExemptionApprovalId: string | null = null;
    try {
      const moqCheck = await moqValidationSvc.validateCreate({
        customerRelationId: existing.customerRelationId ?? null,
        snapshot: (existing as any).moqSnapshot ?? null,
        lines: buildMoqLines(existing.lines),
      }, { actor: actorId && actorId !== 'system' ? { userId: actorId } : null });
      if (!moqCheck.ok) {
        moqExemptionApprovalId = await findApprovedMoqExemption(id,sourceDb);
        if (!moqExemptionApprovalId) {
          const worst = moqCheck.lines.find((l) => !l.compliant);
          const message = `报价单 ${existing.quotationNumber} 存在低于 MOQ 的行（行 ${(worst?.lineIndex ?? 0) + 1} 数量 ${worst?.quantity} < MOQ ${worst?.effectiveMoq}，缺口 ${worst?.gapPct}%）`
            + `且无有效 MOQ 豁免审批（门禁：moq-exemption），转换中止`;
          // Keep the existing DTO route's established 400 mapping; the command
          // entrance has an explicit typed business conflict contract.
          throw commandExecution ? businessError('CONFLICT',message) : new Error(message);
        }
      }
    } catch (e: any) {
      if (typeof e?.message === 'string' && e.message.includes('门禁：moq-exemption')) throw e;
      logger.error('[QuotationService] MOQ 转换门禁校验异常（fail-closed 阻断）', { id, error: e?.message });
      throw new Error(`报价单 ${existing.quotationNumber} MOQ 校验失败，转换中止（门禁：moq-exemption）：${e?.message}`);
    }

    // ── MOQ 快照口径继承：报价 writeOnce 快照合法 → 订单继承同一口径（报价→订单 MOQ 不跳变）；否则新建 ──
    const orderMoqSnapshot: MoqSnapshot = commandExecution?.moqSnapshot??(isValidSnapshot((existing as any).moqSnapshot)
      ? ((existing as any).moqSnapshot as MoqSnapshot)
      : await moqConfigSvc.buildSnapshot());

    // ── 信用门禁（信用控制规则 §6 #6，fail-closed；安全修复：转单旁路直接建单的门禁）──
    // 与 V2 createOrder 同口径：Frozen/Revoked/Net61+ 逾期未结清客户禁止转单；
    // 阻断后走 DR-013 信用例外闭环（生效例外与转单同事务核销，无例外自动发起申请）；
    // 门禁自身故障同样阻断（不放行）。action 复用 'order:create'（转单即建单，例外审批单互通）。
    const commercialPrepared=commandExecution?.commercialPrepared??await prepareOrderConversionCommercial(prisma,actorId,existing.customerRelationId??null,totalAmount);

    const initial = existing;
    const transactionBody = async (tx:Prisma.TransactionClient) => {
      const current = await lockQuotationSource(tx, id);
      await authorizeQuotationConversion(tx,actorId,authority,id);
      assertSameQuotationSource(initial, current);
      const existing = current;
      if (existing.convertedOrderId) throw new Error(`报价单 ${existing.quotationNumber} 已转为订单，不可重复转换`);
      if (existing.status !== 'Accepted') throw new Error(`报价单 ${existing.quotationNumber} 尚未接受，不可转为订单`);
      await assertQuotationApprovalConsumption(tx, existing, 'convert');

      const commercial=await freezeOrderConversionCommercial(tx,actorId,existing.customerRelationId??null,totalAmount,commercialPrepared,orderMoqSnapshot);

      // The order retains the quotation's actual responsibility and source.
      // Missing department is resolved only from that person's real account;
      // an ambiguous multi-department assignment stays unknown.
      const ownerId = existing.ownerId || (actorId && actorId !== 'system' ? actorId : null);
      if (!ownerId) throw businessError('ACTOR_REQUIRED', '报价缺少真实负责人，请先核对归属再转单。');
      const owner = await tx.userAccount.findFirst({
        where: { id: ownerId, deletedAt: null, status: 'active' },
        select: { id: true, primaryDeptId: true, roles: { select: { departmentId: true } } },
      });
      if (!owner || owner.id !== ownerId) throw businessError('SOURCE_CHANGED', '报价负责人不存在或已停用，请先核对归属再转单。');
      const departments = [...new Set(owner.roles.map(role => role.departmentId).filter((id): id is string => Boolean(id)))];
      const departmentId = existing.departmentId ?? owner.primaryDeptId ?? (departments.length === 1 ? departments[0] : null);
      const sourceCaseId = existing.developmentCaseId ?? null;
      if (sourceCaseId) {
        const source = await tx.developmentCase.findFirst({
          where: { id: sourceCaseId, deletedAt: null }, select: { id: true, customerRelationId: true },
        });
        if (!source || source.customerRelationId !== existing.customerRelationId)
          throw businessError('SOURCE_CHANGED', '关联开发案不存在或客户已变化，请核对来源后再转单。');
      }
      // 0. 原子认领 convertedOrderId（防 L9 联动与手动转单并发双建单）：
      //    事务前那句「已转为订单」校验是先读后写，两个并发 convert 都能读到 null
      //    （实测双单相差 17ms）。updateMany 谓词在行锁提交后重估，败者 count=0 → 抛错回滚，
      //    不会走到 order.create。错误文案含「已转为订单」供 L9 幂等 catch 与 route 409 映射识别。
      const claim = await tx.quotation.updateMany({
        where: { id, deletedAt: null, convertedOrderId: null },
        data: { convertedOrderId: orderId, updatedAt: now },
      });
      if (claim.count === 0) {
        throw new Error(`报价单 ${existing.quotationNumber} 已转为订单，不可重复转换`);
      }

      let actualMillName=millName;const actualMillId=overrides?.millRelationId??null;
      if(actualMillId){await tx.$queryRawUnsafe('SELECT "id" FROM "Relation" WHERE "id"=$1 AND "deletedAt" IS NULL FOR UPDATE',actualMillId);const factory=await tx.relation.findFirst({where:{id:actualMillId,deletedAt:null},select:factoryRelationIdentitySelect});if(!isUsableFactoryRelation(factory))throw businessError('SOURCE_CHANGED','所选工厂已不可用，请重新核对。');actualMillName=factory.name;}
      // 1. 创建订单
      const order = await tx.order.create({
        data: {
          id: orderId,
          code: await allocateInternalOrderCode(tx),
          customer: existing.customerName || existing.customerCode || '未知客户',
          product: existing.lines[0]?.description || '',
          type: orderType,
          quantity: quantitySummary.quantity,
          unit: quantitySummary.unit,
          status: 'Pending',
          dueDate,
          quoteAmount: totalAmount,
          poNumber,
          customerCode: existing.customerCode,
          currency: existing.currency,
          deliveryTerms: existing.deliveryTerms,
          paymentTerms: existing.paymentTerms,
          // ★ A19（§9 B51 / 拍板件 §2.2）：付款方式必须在跨层边界上活下来。
          //   此前只拷 `paymentTerms`（自由文本）**不拷本字段** ⇒ 转出的订单该列恒 null
          //   ⇒ `isLcInstrument(null)=false` ⇒ L/C 门禁对整条报价转单路径判 `not-applicable`
          //   放行 = **100% 免检**（fail-open，钱的风险）。
          // ★ 未录（null）时**显式写 null**，不靠"键缺席 ⇒ Prisma 默认值"：
          //   那会在将来给该列加 DB 默认值时把「不知道」静默伪造成一个合法值
          //   （拍板件 §2.2 硬条件 1：空 ≠ 合法值）。
          // ★ `??` 而非 `||`：`''`（空串）也是"未录"，但那是报价侧的脏值，
          //   由门禁第三分支统一处置，这里不做字符串层面的猜测。
          paymentInstrument: overrides?.paymentInstrument ?? existing.paymentInstrument ?? null,
          customerRelationId: existing.customerRelationId,
          sourceCaseId,
          ownerId,
          departmentId,
          millName:actualMillName,
          millRelationId:actualMillId,
          source: 'quotation-convert',
          salesCurrency: existing.currency,
          purchaseCurrency: existing.baseCurrency || 'CNY',
          fieldSources: {
            source: 'quotation-convert',
            // §6 #3：源报价行已 approved 的 MOQ 豁免审批引用（不重复触发审批）
            ...(moqExemptionApprovalId ? { moqExemptionApprovalId } : {}),
          } as any,
          moqSnapshot: commercial.moqSnapshot as any,
          updatedAt: BigInt(now),
          importedAt: BigInt(now),
          lines: {
            create: existing.lines.map((line, i) => ({
              id: `OL-${orderId}-${i + 1}`,
              lineNumber: i + 1,
              materialCode: line.fabricCode,
              description: line.description,
              quantity: line.quantity,
              unit: normalizeOrderQuantityUnit(line.unit)!,
              unitPrice: line.unitPrice,
              netValue: line.amount,
              status: 'Pending',
              // G1-2 补齐：报价行 notes/moqOverride 随转单带入订单行，避免静默丢弃
              // （imageUrl 因 OrderLine 无对应槽位，另行登记）
              notes: line.notes ?? null,
              moqOverride: line.moqOverride ?? null,
            })),
          },
        },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });

      // 2.5 成本三环咬合（2026-09-30）：报价的定价计算记录（成本估算环）跟随转单挂到新订单。
      //   不复制、不重算 —— 真源仍是这条 PricingCalculation，只是把归属从报价侧延伸到订单侧，
      //   让「报价估算成本/毛利」在订单的成本三环对比（GET /pricing/orders/:id/cost-rings）里可追溯。
      //   只挂未挂单的记录（orderId: null）：防重复转换时把别的订单关联改掉。
      await tx.pricingCalculation.updateMany({
        where: { quotationId: id, deletedAt: null, orderId: null },
        data: { orderId },
      });

      // 2. 读回报价单（convertedOrderId 已在认领步写入；认领刚成功，行必在）
      const quotation = (await tx.quotation.findUnique({
        where: { id },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      }))!;

      // 3. 审计日志 — 报价单转换
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'convert_quotation_to_order',
          targetType: 'Quotation',
          targetId: id,
          detail: { source: 'api:quotation', after: { orderId, poNumber } } as any,
          ip: null,
          operationType: 'transition',
          fieldPath: 'convertedOrderId',
          beforeValue: null as any,
          afterValue: orderId as any,
          transactionId: null,
        },
      });

      // 4. 审计日志 — 订单创建
      await tx.auditLog.create({
        data: {
          id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
          actorId: actorId || 'system',
          action: 'create_order_from_quotation',
          targetType: 'Order',
          targetId: orderId,
          detail: { source: 'quotation-convert', after: { quotationId: id, poNumber, totalAmount, sourceCaseId, ownerId, departmentId } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // 5. EntityLink 图谱：报价 convertedToOrder + quotedFor；新订单关系 FK 一并入图
      await syncQuotationReferences(prisma, quotation, { source: 'quotation-convert' }, tx);
      await syncOrderEntityReferences(prisma, order, { source: 'quotation-convert' }, tx);

      await consumeOrderConversionCommercial(tx,commercial,orderId);

      return { order, quotation };
    };
    const result=commandExecution?await transactionBody(commandExecution.tx):await prisma.$transaction(transactionBody);



    logger.info('[QuotationService] quotation converted to order', {
      id, orderId, poNumber, lineCount: existing.lines.length,
    });

    return { orderId: result.order.id, quotation: result.quotation as QuotationDetail };
  }

  // ── REQ2-19（DR-060-①）：显式修订（砍价重报通道）──
  // Draft/Sent 可修订：快照当前版 → version+1 → 状态回 Draft（编辑后重发）。
  // Accepted/Rejected/Expired 终态不可修订（新询价新建报价单）。
  async function reviseQuotation(id: string, changeReason: string | undefined, actorId: string): Promise<QuotationDetail> {
    const existing = await prisma.quotation.findUnique({ where: { id }, include: { lines: true } });
    if (!existing || existing.deletedAt) throw new Error(`报价单 ${id} 不存在`);
    if (existing.status !== 'Draft' && existing.status !== 'Sent') {
      throw new Error(`报价单 ${id} 状态为 ${existing.status}，仅 Draft/Sent 可修订（终态请新建报价单）`);
    }
    const now = Date.now();
    const initial = existing;
    const updated = await prisma.$transaction(async (tx) => {
      const current = await lockQuotationSource(tx, id);
      assertSameQuotationSource(initial, current);
      const existing = current;
      if (existing.status !== 'Draft' && existing.status !== 'Sent') throw new Error(`报价单 ${id} 状态为 ${existing.status}，仅 Draft/Sent 可修订（终态请新建报价单）`);

      await snapshotQuotationVersion(tx, existing, actorId, changeReason ?? null);
      const quotation = await tx.quotation.update({
        where: { id },
        data: { version: (existing.version ?? 1) + 1, status: 'Draft', updatedAt: now },
        include: { lines: { orderBy: { lineNumber: 'asc' } } },
      });
      await tx.auditLog.create({
      data: {
        id: `alog_${now}_${Math.random().toString(36).slice(2, 8)}`,
        actorId: actorId || 'system',
        action: 'revise_quotation',
        targetType: 'Quotation',
        targetId: id,
        detail: { source: 'api:quotation', before: { version: existing.version ?? 1, status: existing.status, totalAmount: Number(existing.totalAmount) }, after: { version: (existing.version ?? 1) + 1, status: 'Draft' }, changeReason: changeReason ?? null } as any,
        ip: null, operationType: 'update', fieldPath: 'version',
        beforeValue: null as any, afterValue: null as any, transactionId: null,
      },
    });
      return quotation;
    });
    logger.info('[QuotationService] quotation revised', { id, fromVersion: existing.version ?? 1 });
    return updated as QuotationDetail;
  }

  // ── REQ2-19（DR-060-②）：版本历史（append-only 正序） ──
  async function listQuotationVersions(id: string): Promise<any[]> {
    const versions = await (prisma as any).quotationVersion.findMany({
      where: { quotationId: id },
      orderBy: { version: 'asc' },
    });
    return versions;
  }

  // ── REQ2-19（DR-060-②）：客户砍价画像 ──
  // 客户维度：每报价单首报金额（版本链最早快照 ∨ v1）vs 当前金额降幅 × 轮次；成交单关联 Order.totalNet。
  async function getPriceProfile(relationId: string): Promise<any> {
    const quotations = await prisma.quotation.findMany({
      where: { customerRelationId: relationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, quotationNumber: true, status: true, currency: true, totalAmount: true,
        version: true, createdAt: true, issueDate: true, convertedOrderId: true, sentAt: true,
      },
    });
    if (quotations.length === 0) {
      return { relationId, items: [], summary: null };
    }
    // 首报金额：v1 有快照取最早快照；无快照（从未改价）= 当前金额
    const firstVersions = await (prisma as any).quotationVersion.findMany({
      where: { quotationId: { in: quotations.map(q => q.id) } },
      orderBy: { version: 'asc' },
    });
    const firstByQuotation = new Map<string, any>();
    for (const v of firstVersions) {
      if (!firstByQuotation.has(v.quotationId)) firstByQuotation.set(v.quotationId, v);
    }
    // 成交订单金额（转换关联；totalNet 优先，convert 路径未录 totalNet 时 fallback quoteAmount——报价转换继承额）
    const convertedIds = quotations.map(q => q.convertedOrderId).filter(Boolean) as string[];
    const orders = convertedIds.length
      ? await prisma.order.findMany({ where: { id: { in: convertedIds } }, select: { id: true, totalNet: true, quoteAmount: true, poNumber: true } })
      : [];
    for (const o of orders) {
      (o as any).dealAmount = o.totalNet != null ? Number(o.totalNet) : Number(o.quoteAmount);
    }
    const orderByQuotation = new Map<string, any>();
    for (const q of quotations) {
      if (q.convertedOrderId) {
        const o = orders.find(x => x.id === q.convertedOrderId);
        if (o) orderByQuotation.set(q.id, o);
      }
    }

    const items = quotations.map(q => {
      const first = firstByQuotation.get(q.id);
      const firstAmount = first ? Number(first.totalAmount) : Number(q.totalAmount);
      const currentAmount = Number(q.totalAmount);
      const cutPct = firstAmount !== 0 ? Math.round(((currentAmount - firstAmount) / firstAmount) * 10000) / 100 : null;
      const order = orderByQuotation.get(q.id);
      const dealDeviationPct = order && order.dealAmount != null && Number.isFinite(order.dealAmount) && firstAmount !== 0
        ? Math.round(((Number(order.dealAmount) - firstAmount) / firstAmount) * 10000) / 100
        : null;
      return {
        quotationId: q.id,
        quotationNumber: q.quotationNumber,
        status: q.status,
        currency: q.currency,
        version: q.version ?? 1,
        rounds: Math.max((q.version ?? 1) - 1, firstVersions.filter((v: any) => v.quotationId === q.id).length),
        firstAmount,
        currentAmount,
        cutPct,
        issueDate: q.issueDate,
        convertedOrderId: q.convertedOrderId ?? null,
        orderPo: order?.poNumber ?? null,
        orderDealAmount: order?.dealAmount ?? null,
        dealDeviationPct,
      };
    });

    const negotiated = items.filter(i => i.cutPct != null && i.cutPct !== 0);
    const dealt = items.filter(i => i.dealDeviationPct != null);
    const summary = {
      quotationCount: items.length,
      negotiatedCount: negotiated.length,
      avgCutPct: negotiated.length > 0
        ? Math.round((negotiated.reduce((s, i) => s + (i.cutPct ?? 0), 0) / negotiated.length) * 100) / 100
        : 0,
      maxCutPct: negotiated.length > 0 ? Math.min(...negotiated.map(i => i.cutPct ?? 0)) : 0,
      dealtCount: dealt.length,
      avgDealDeviationPct: dealt.length > 0
        ? Math.round((dealt.reduce((s, i) => s + (i.dealDeviationPct ?? 0), 0) / dealt.length) * 100) / 100
        : null,
    };
    return { relationId, items, summary };
  }

  // ── G1-3 报价反查：按开发案/订单/条目查询关联报价（product/order 维反向可见） ──
  async function listQuotationsByTarget(params: { developmentCaseId?: string; orderId?: string; orderLineId?: string }): Promise<{ items: any[] }> {
    const where: any = { deletedAt: null };
    if (params.developmentCaseId) where.developmentCaseId = params.developmentCaseId;
    if (params.orderId) where.orderId = params.orderId;
    if (params.orderLineId) where.orderLineId = params.orderLineId;
    // 无任何关联锚点 → 空
    if (!params.developmentCaseId && !params.orderId && !params.orderLineId) return { items: [] };
    const items = await prisma.quotation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    return { items };
  }

  return {
    createQuotation,
    updateQuotation,
    deleteQuotation,
    listQuotations,
    getQuotation,
    sendQuotation,
    acceptQuotation,
    rejectQuotation,
    expireQuotation,
    convertToOrder,
    reviseQuotation,
    listQuotationVersions,
    getPriceProfile,
    listQuotationsByTarget,
  };
}

export type QuotationService = ReturnType<typeof createQuotationService>;
