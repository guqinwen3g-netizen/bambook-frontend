import { businessNowDate } from '../shared/businessClock';
/**
 * Phase 3 C1 CRM 深化服务
 *
 * 职责：
 *   1. 联系人管理（Contact）：多联系人/主联系人/决策人标记
 *   2. 信用额度（CreditLimit）：额度管理/用量跟踪/超额检测
 *   3. 跟进记录（FollowUpRecord）：销售跟进日志/下次跟进/逾期检测
 *   4. 商机管线（Opportunity）：销售管线阶段流转/成交/流失
 *   5. 客户分层（CustomerTier）：分层评定/权益管理
 *
 * 设计原则：
 *   - 软删除（deletedAt BigInt），不物理删除
 *   - 事务内创建/更新 + 审计日志
 *   - 业务事件发布（信用超额/商机阶段变更/分层评定）
 *   - 事件发布失败不阻断业务（fire-and-forget）
 */

import { PrismaClient, Contact, CreditLimit, FollowUpRecord, Opportunity, CustomerTier } from '@prisma/client';
import { logger } from '../lib/logger';
import { clampLimit } from '../lib/paging';
import { publishBusinessEvent } from '../events/businessEventBus';
import { deactivateEntityLinks, syncOpportunityReferences } from '../entities/sync';
import { syncOrganizationPrimaryContact } from '../relations/contactSync';
import { computeNetOpenReceivables, appendCreditLimitHistory } from '../credit/creditService';
import { writeFieldAuditDiff, writeRouteAuditLog, resolveAuditActorId } from '../audit/routeAudit';
import { todayLocalKey, localDateKey } from '../shared/localDate';


// ────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────

export interface ContactInput {
  name: string;
  title?: string;
  department?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  wechat?: string;
  whatsapp?: string;
  isPrimary?: boolean;
  isDecisionMaker?: boolean;
  birthday?: string;
  personalNote?: string;
  status?: string; // Active | Inactive | Left（2026-08-31：离职/恢复在职直达 Contact 真源）
  tags?: string[];
}

export interface CreditLimitInput {
  totalLimit: number;
  currency?: string;
  validFrom: string;
  validTo?: string;
  approvedBy?: string;
  notes?: string;
}

export interface FollowUpInput {
  contactId?: string;
  type: string; // Visit | Call | Email | WeChat | Meeting | Other
  content: string;
  followUpAt: string;
  nextFollowUpAt?: string;
  nextFollowUpTopic?: string;
  opportunityId?: string;
  orderId?: string;
  salesRepId?: string;
  salesRepName?: string;
  attachments?: Record<string, unknown>;
  notes?: string;
}

export interface OpportunityInput {
  title: string;
  description?: string;
  amount: number;
  currency?: string;
  stage?: string;
  probability?: number;
  expectedCloseDate?: string;
  source?: string;
  salesRepId?: string;
  salesRepName?: string;
  /** 关联订单（商机成交闭环：ClosedWon 后挂接成交订单，EntityLink convertedToOrder 入图） */
  orderId?: string;
  tags?: string[];
  notes?: string;
}

export interface CustomerTierInput {
  level: string; // Bronze | Silver | Gold | Platinum | VIP
  criteria?: string;
  discountRate?: number;
  paymentTermsDays?: number;
  creditPriority?: string; // High | Normal | Low
  evaluatedAt: string;
  validUntil?: string;
  evaluatedBy?: string;
  notes?: string;
}

// 商机阶段流转矩阵
const OPPORTUNITY_TRANSITIONS: Record<string, string[]> = {
  Prospecting: ['Qualification', 'ClosedLost'],
  Qualification: ['Proposal', 'ClosedLost'],
  Proposal: ['Negotiation', 'ClosedLost'],
  Negotiation: ['ClosedWon', 'ClosedLost'],
  ClosedWon: [],   // 终态
  ClosedLost: [], // 终态
};

// 阶段 → 默认成交概率
const STAGE_DEFAULT_PROBABILITY: Record<string, number> = {
  Prospecting: 10,
  Qualification: 25,
  Proposal: 50,
  Negotiation: 75,
  ClosedWon: 100,
  ClosedLost: 0,
};

// 合法商机阶段枚举（与流转矩阵同源）：创建入口校验用，
// 防止落库矩阵外的 stage（该商机将永远无法流转——矩阵查不到按终态处理）
export const VALID_OPPORTUNITY_STAGES = Object.keys(OPPORTUNITY_TRANSITIONS);

// CRM 输入合约违规（路由层映射 400 VALIDATION_FAILED，区别于内部错误的 500）
// S0-A Task 4 核定：补 `code` + `statusCode` 透传契约 —— 本类的文案（「body.totalLimit 必填且须为
// 正数（信用额度）」）就是给业务员看的，此前只靠 `instanceof` 被 crmRouteV2:33 认，任何走
// `safeRouteError` / `globalErrorHandler` 的路径都会把它兜成通用 500。
// ★ 实测本域**当前无活路径**：crmRoute / crmRouteV2 都有自己的 catch（v1 那 27 处
//   `message: e?.message` 的**外泄**问题是另一件事，由 routeError 棘轮基线记着，不在本任务）；
//   `relationServiceV2` 复用 `setCreditLimit` 的那条联动也在 `syncCreditLimitEntity` 里自行吞掉。
//   ⇒ 这一条是**为收敛准备的潜在修复**，不是已发生的用户可见故障（不要当成 bug 记账）。
// 参数带默认值 ⇒ 既有 `new CrmValidationError('文案')` 抛出点一行都不用改。
export class CrmValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code = 'CRM_VALIDATION_FAILED', statusCode = 400) {
    super(message);
    this.name = 'CrmValidationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ────────────────────────────────────────────────────────────────
// 辅助函数
// ────────────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function validateOpportunityTransition(from: string, to: string): void {
  const allowed = OPPORTUNITY_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new CrmValidationError(`非法商机阶段转换：${from} → ${to}（允许的目标：${allowed?.join(', ') || '无（终态）'}）`);
  }
}

// ────────────────────────────────────────────────────────────────
// 服务工厂
// ────────────────────────────────────────────────────────────────

/** 联系人审计追踪的字段（B216）：只追业务字段，不追 id / deletedAt / 时间戳 */
const CONTACT_AUDIT_FIELDS = [
  'relationId', 'name', 'title', 'department', 'email', 'phone', 'mobile',
  'wechat', 'whatsapp', 'isPrimary', 'isDecisionMaker', 'birthday', 'personalNote', 'tags', 'status',
];

/** 审计身份被降级时写进 detail 的那句话（不静默：变更史里看得见"它声称是谁"）。 */
function actorDowngradeNote(unknownClaim: string | null): string | null {
  return unknownClaim
    ? `审计身份降级：token 声称的操作人 ${unknownClaim} 不在 UserAccount（账号已删或遗留 token）`
    : null;
}

/**
 * ★ v3.110（复核 #27）：设主联系人时，同组织下**别人**的 isPrimary true→false 此前一句 `updateMany`
 * 带走、一行审计都不写 ⇒ 变更史只看得到"谁升了"，看不到接手人真正要问的"这个人是什么时候被谁顶掉的"。
 * create / update 两条路都有这个动作（各自一份 `updateMany`），收成一个函数、连带把痕写在一起。
 * 顺带把"改哪些行"收成**刚读到的那批 id**：读到的集合＝写下去的集合＝留下痕的集合。
 */
async function demoteOtherPrimaries(
  tx: any,
  args: { relationId: string; exceptId: string; ts: bigint; actorId: string; note: string | null },
): Promise<void> {
  const demoted = await tx.contact.findMany({
    where: { relationId: args.relationId, isPrimary: true, id: { not: args.exceptId }, deletedAt: null },
    select: { id: true },
  });
  if (demoted.length === 0) return;
  await tx.contact.updateMany({
    where: { id: { in: demoted.map((d: { id: string }) => d.id) }, deletedAt: null },
    data: { isPrimary: false, updatedAt: args.ts },
  });
  for (const d of demoted) {
    await writeFieldAuditDiff({
      prisma: tx,
      actorId: args.actorId,
      source: 'api:crm',
      operation: 'update_contact',
      targetType: 'Contact',
      targetId: d.id,
      before: { isPrimary: true },
      after: { isPrimary: false },
      trackedFields: ['isPrimary'],
      note: args.note ?? undefined,
    });
  }
}

/**
 * 整行快照 → JSON 可写值。只处理 **BigInt**：`Contact` 的 createdAt/updatedAt/deletedAt 是 BigInt 列
 * （schema.prisma `model Contact`），Prisma 写 `Json` 列时 `JSON.stringify(BigInt)` 直接抛 TypeError，
 * 而 delete 审计的 before 是**整行**、绕不过去。
 * ⓘ 其余被追踪字段全是 String / Boolean / String[]，不需要折；本函数不承担别的类型（v3.110 复核 #27
 *   指出旧注释把 Date 也算进来 —— `Contact` 里一个 DateTime 列都没有，那一支是死码，已删）。
 */
function auditScalar(row: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}

export function createCrmService(prisma: PrismaClient) {
  const now = () => Date.now();

  // ══════════════════════════════════════════════════════════════
  // 1. 联系人管理（Contact）—— Contact 表写真源
  //
  // 联系人统一（写路径收敛）：Contact 表是组织联系人的唯一写真源，与关系智库
  // 通讯录端点（/api/v1/relations/:id/contacts）同源同表。旧 Relation
  // (isOrganization=false) 人物子行仅为历史数据读兜底，本节不再写入。
  // 返回的 id 即 Contact id（CTC_ 前缀），新跟进/沟通记录的 contactId 随之
  // 指向 Contact；历史记录仍引用 Relation 人物 id——attachFollowUpContacts
  // 与 brandLineService 的 contactId 校验保持双源兼容。
  // ══════════════════════════════════════════════════════════════

  function serializeContactRow(row: any): Contact {
    // BigInt（createdAt/updatedAt/deletedAt）归一为 number，保持 Contact 合约形状
    // （路由层另有全局 BigInt.prototype.toJSON 兜底，此处保证 service 契约即 number）
    return {
      ...row,
      createdAt: Number(row.createdAt ?? 0),
      updatedAt: Number(row.updatedAt ?? 0),
      deletedAt: row.deletedAt != null ? Number(row.deletedAt) : null,
    } as unknown as Contact;
  }

  async function createContact(relationId: string, input: ContactInput, actorId: string): Promise<Contact> {
    const tsNum = now();
    const ts = BigInt(tsNum);
    if (!input?.name?.trim()) {
      throw new CrmValidationError('body.name 必填（联系人姓名）');
    }

    const created = await prisma.$transaction(async (tx) => {
      // 父组织必须存在且未删（挂靠校验，与 /api/v1/relations/:id/contacts 同规约）
      const org = await tx.relation.findFirst({
        where: { id: relationId, isOrganization: true, deletedAt: null },
        select: { id: true },
      });
      if (!org) throw new CrmValidationError(`组织 ${relationId} 不存在或已删除，无法挂靠联系人`);

      // ★ B218：审计身份先过存在性闸门（详见 resolveAuditActorId 注释）
      const { actorId: auditActorId, unknownClaim } = await resolveAuditActorId(tx, actorId);
      const auditNote = actorDowngradeNote(unknownClaim);

      // 若新联系人为 primary，先清除该组织下其他 primary（Contact 表内独占）
      // ★ v3.110：降级动作连同**被顶掉那几位**的审计一起写（此前只 updateMany、一行痕不留）
      if (input.isPrimary) {
        await demoteOtherPrimaries(tx, {
          relationId, exceptId: '', ts, actorId: auditActorId, note: auditNote,
        });
      }

      const row = await tx.contact.create({
        data: {
          id: `CTC_${tsNum.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          relationId,
          name: input.name,
          title: input.title ?? null,
          department: input.department ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          mobile: input.mobile ?? null,
          wechat: input.wechat ?? null,
          whatsapp: input.whatsapp ?? null,
          isPrimary: input.isPrimary ?? false,
          isDecisionMaker: input.isDecisionMaker ?? false,
          birthday: input.birthday ?? null,
          personalNote: input.personalNote ?? null,
          tags: input.tags ?? [],
          status: 'Active',
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: generateId('alog'),
          actorId: auditActorId,
          action: 'create_contact',
          targetType: 'Contact',
          targetId: row.id,
          detail: {
            source: 'api:crm',
            after: { relationId, name: input.name, isPrimary: row.isPrimary },
            ...(auditNote ? { note: auditNote } : {}),
          } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // 联系人真源回写：组织主联系人冗余字段（primaryContact*/contactInfo）同事务刷新，
      // 邮箱匹配/单据模板/订单预填/搜索回填等旧轨消费点即时获得新鲜数据
      await syncOrganizationPrimaryContact(tx, relationId);

      return row;
    });

    logger.info('[CrmService] contact created (Contact table)', { id: created.id, relationId, name: input.name });
    return serializeContactRow(created);
  }

  async function listContacts(relationId: string): Promise<Contact[]> {
    const rows = await prisma.contact.findMany({
      where: { relationId, deletedAt: null },
      orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }],
    });
    return rows.map(serializeContactRow);
  }

  async function getContact(id: string): Promise<Contact | null> {
    const row = await prisma.contact.findFirst({
      where: { id, deletedAt: null },
    });
    return row ? serializeContactRow(row) : null;
  }

  async function updateContact(id: string, input: Partial<ContactInput>, actorId: string): Promise<Contact> {
    const ts = BigInt(now());

    const updated = await prisma.$transaction(async (tx) => {
      // ★ v3.111（复核 #27 第 1③ 条）：前值快照**读在事务内**。
      //   v3.108 我补字段级审计时把 `existing` 读在了事务外 —— 并发改同一联系人时，后提交那笔的
      //   `before` 拿到的是"上一版之前的值"，于是变更史把 X→Z 记成 X→Y（业务侧的 lost-update 早就存在，
      //   但我这份审计让同一件事多了一层后果：**留痕本身可能是错的**）。读进事务里，"读—写—痕"同源。
      const existing = await tx.contact.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new Error(`联系人 ${id} 不存在`);

      // ★ v3.110（B218）：审计身份先过存在性闸门 —— actorId 直接来自 token，而账号状态守卫对
      //   "验签有效但库里没这个人"是 fail-open 放行 ⇒ 拿它进 AuditLog.actorId（外键 → UserAccount）
      //   会把整笔业务写入一起 P2003 回滚。降级不静默：原值留在 detail 里看得见。
      const { actorId: auditActorId, unknownClaim } = await resolveAuditActorId(tx, actorId);
      const auditNote = actorDowngradeNote(unknownClaim);

      // 若设为 primary，先清除同组织下其他 primary
      // ★ v3.110（复核 #27）：被顶掉的那几位此前**一行审计都不写** —— 主联系人只有一个，
      //   升一个必然降一个，而接手人真正要问的恰是"这个人的主联系人是什么时候被顶掉的"。
      if (input.isPrimary) {
        await demoteOtherPrimaries(tx, {
          relationId: existing.relationId, exceptId: id, ts, actorId: auditActorId, note: auditNote,
        });
      }

      // 离职/停用（status 变为非 Active）自动让出主联系人标记——在岗者才可担任 primary
      const losingPrimary = input.status !== undefined && input.status !== 'Active' && existing.isPrimary;

      const row = await tx.contact.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.department !== undefined && { department: input.department }),
          ...(input.email !== undefined && { email: input.email }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.mobile !== undefined && { mobile: input.mobile }),
          ...(input.wechat !== undefined && { wechat: input.wechat }),
          ...(input.whatsapp !== undefined && { whatsapp: input.whatsapp }),
          ...(input.isPrimary !== undefined && { isPrimary: input.isPrimary }),
          ...(losingPrimary && { isPrimary: false }),
          ...(input.isDecisionMaker !== undefined && { isDecisionMaker: input.isDecisionMaker }),
          ...(input.birthday !== undefined && { birthday: input.birthday }),
          ...(input.personalNote !== undefined && { personalNote: input.personalNote }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.tags !== undefined && { tags: input.tags }),
          updatedAt: ts,
        },
      });

      // 联系人真源回写：主联系人变更/离职/资料修正后同事务刷新组织冗余字段
      await syncOrganizationPrimaryContact(tx, existing.relationId);

      // ★ v3.108（B216）：联系人**修改**此前在 CRM 这条路上行审计都不写（只有 create 写过 `create_contact`）
      //   ⇒ 变更史里永远只有"创建"那一笔，界面上与"确实没改过"长得一模一样。这里按**字段级** before/after
      //   补上（复用共享 `writeFieldAuditDiff`，不再自造一份 diff 逻辑）。
      //   ⓘ `auditScalar` 折叠的是**整行**快照里的 BigInt 列（createdAt/updatedAt）—— 这条字段级路径上
      //   trackedFields 已先把它们滤掉，真正非折不可的是下面 `delete_contact` 那条整行 before（Json 列
      //   吃不下 BigInt，v3.110 复核 #27 把这个区别问清楚了，此前注释写成"两个类型都会抛"是不实的）。
      await writeFieldAuditDiff({
        prisma: tx as any,
        actorId: auditActorId,
        source: 'api:crm',
        operation: 'update_contact',
        targetType: 'Contact',
        targetId: id,
        before: auditScalar(existing) as Record<string, unknown>,
        after: auditScalar(row) as Record<string, unknown>,
        trackedFields: CONTACT_AUDIT_FIELDS,
        note: auditNote ?? undefined,
      });

      return row;
    });

    logger.info('[CrmService] contact updated (Contact table)', { id, actorId });
    return serializeContactRow(updated);
  }

  async function deleteContact(id: string, actorId: string): Promise<void> {
    const ts = BigInt(now());
    await prisma.$transaction(async (tx) => {
      const existing = await tx.contact.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new Error(`联系人 ${id} 不存在`);
      await tx.contact.update({
        where: { id },
        data: { deletedAt: ts, updatedAt: ts, isPrimary: false },
      });
      // 联系人真源回写：删除后组织主联系人可能易主/清空，同事务刷新冗余字段
      await syncOrganizationPrimaryContact(tx, existing.relationId);

      // ★ v3.108（B216）：删除也要留痕（此前 CRM 这条路同样一行不写）。用整行 before 快照写一条 delete 审计。
      //   ⓘ 整行里有 BigInt 列 ⇒ `auditScalar` 必须折，否则 Json 列直接抛。
      //   ⓘ "此前不写"只对**这条路**成立：组织侧 `relations/route.ts` 自 2026-08-30 起就会写一条
      //     `update_relation_contact`（整行 1 条、before 只带部分字段）—— 同一事实两份实现，见 B216 追记。
      const { actorId: auditActorId, unknownClaim } = await resolveAuditActorId(tx, actorId);
      await writeRouteAuditLog({
        prisma: tx as any,
        actorId: auditActorId,
        source: 'api:crm',
        operation: 'delete_contact',
        targetType: 'Contact',
        targetId: id,
        before: auditScalar(existing) as Record<string, unknown>,
        operationType: 'delete',
        note: actorDowngradeNote(unknownClaim),
      });
    });
    logger.info('[CrmService] contact soft-deleted (Contact table)', { id, actorId });
  }

  // ══════════════════════════════════════════════════════════════
  // 2. 信用额度（CreditLimit）
  // ══════════════════════════════════════════════════════════════

  async function setCreditLimit(relationId: string, input: CreditLimitInput, actorId: string): Promise<CreditLimit> {
    const ts = now();
    const clId = generateId('CL');
    if (!Number.isFinite(Number(input?.totalLimit)) || Number(input?.totalLimit) <= 0) {
      throw new CrmValidationError('body.totalLimit 必填且须为正数（信用额度）');
    }
    if (!input?.validFrom?.trim()) {
      throw new CrmValidationError('body.validFrom 必填（生效日期 YYYY-MM-DD）');
    }

    const created = await prisma.$transaction(async (tx) => {
      // 将同 relation 下已有的 Active 信用额度标记为 Expired
      await tx.creditLimit.updateMany({
        where: { relationId, status: 'Active', deletedAt: null },
        data: { status: 'Expired', updatedAt: ts },
      });

      // 查询当前已用额度（净额口径：未结清应收净额，见 calculateUsedCredit）
      const usedAmount = await calculateUsedCredit(tx, relationId);

      const cl = await tx.creditLimit.create({
        data: {
          id: clId,
          relationId,
          totalLimit: input.totalLimit,
          usedAmount,
          currency: input.currency ?? 'CNY',
          validFrom: input.validFrom,
          validTo: input.validTo ?? null,
          status: 'Active',
          approvedBy: input.approvedBy ?? null,
          approvedAt: input.approvedBy ? ts : null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      // 铁律 #2（信用控制规则 §2.2.1）：usedAmount 的一切写操作必须同步 append
      // CreditLimitHistory（同一事务）——新额度行的初始已用额度快照同样留痕，
      // 修复「setCreditLimit 直写 usedAmount 绕过 append-only 账本」缺口
      await appendCreditLimitHistory(tx, {
        creditLimitId: clId,
        relationId,
        beforeUsedAmount: 0,
        afterUsedAmount: usedAmount,
        triggerType: 'credit_limit_set',
        triggerBy: actorId || 'system',
        remark: `新额度行初始已用额度快照（净额口径）：${usedAmount}`,
      });

      // 信用额度单一真源联动：CreditLimit 实体是生效额度的真源，
      // 同步回写档案冗余字段 relation.creditLimit——否则详情页「财务信息」
      // （读档案字段）与「信用额度」模块（读实体）呈现互相矛盾的数字
      await tx.relation.update({
        where: { id: relationId },
        data: { creditLimit: input.totalLimit },
      }).catch(() => undefined);

      await tx.auditLog.create({
        data: {
          id: generateId('alog'),
          actorId: actorId || 'system',
          action: 'set_credit_limit',
          targetType: 'CreditLimit',
          targetId: clId,
          detail: { source: 'api:crm', after: { relationId, totalLimit: input.totalLimit, usedAmount } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return cl;
    });

    // 事务提交后检查超额并发布事件
    if (created.usedAmount > created.totalLimit) {
      await publishBusinessEvent({
        type: 'CreditLimitExceeded',
        sourceEntityType: 'CreditLimit',
        sourceEntityId: clId,
        payload: {
          relationId,
          totalLimit: Number(created.totalLimit),
          usedAmount: Number(created.usedAmount),
          currency: created.currency,
          exceedAmount: Number(created.usedAmount) - Number(created.totalLimit),
        },
        actorId: actorId || 'system',
      }).catch((e) => logger.error('[CrmService] publish CreditLimitExceeded failed', { error: e?.message }));
    }

    logger.info('[CrmService] credit limit set', { id: clId, relationId, totalLimit: input.totalLimit });
    return created;
  }

  async function getActiveCreditLimit(relationId: string): Promise<CreditLimit | null> {
    return prisma.creditLimit.findFirst({
      where: { relationId, status: 'Active', deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function listCreditLimitHistory(relationId: string): Promise<CreditLimit[]> {
    return prisma.creditLimit.findMany({
      where: { relationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async function updateCreditLimitStatus(id: string, status: string, actorId: string): Promise<CreditLimit> {
    const ts = now();
    const updated = await prisma.creditLimit.update({
      where: { id },
      data: { status, updatedAt: ts },
    });
    logger.info('[CrmService] credit limit status updated', { id, status, actorId });
    return updated;
  }

  // ══════════════════════════════════════════════════════════════
  // 3. 跟进记录（FollowUpRecord）
  // ══════════════════════════════════════════════════════════════

  async function createFollowUp(relationId: string, input: FollowUpInput, actorId: string): Promise<FollowUpRecord> {
    const ts = now();
    const fuId = generateId('FU');

    const created = await prisma.$transaction(async (tx) => {
      const fu = await tx.followUpRecord.create({
        data: {
          id: fuId,
          relationId,
          contactId: input.contactId ?? null,
          type: input.type,
          content: input.content,
          followUpAt: input.followUpAt,
          nextFollowUpAt: input.nextFollowUpAt ?? null,
          nextFollowUpTopic: input.nextFollowUpTopic ?? null,
          opportunityId: input.opportunityId ?? null,
          orderId: input.orderId ?? null,
          salesRepId: input.salesRepId ?? null,
          salesRepName: input.salesRepName ?? null,
          attachments: (input.attachments as any) ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: generateId('alog'),
          actorId: actorId || 'system',
          action: 'create_follow_up',
          targetType: 'FollowUpRecord',
          targetId: fuId,
          detail: { source: 'api:crm', after: { relationId, type: input.type, followUpAt: input.followUpAt } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return fu;
    });

    logger.info('[CrmService] follow-up created', { id: fuId, relationId, type: input.type });
    return created;
  }

  // 联系人统一：FollowUpRecord.contactId 为裸引用——新数据指向 Contact 表 id
  // （CRM 联系人写路径已收敛至 Contact 表），历史数据仍指向 Relation 人物 id。
  // 展示拼装双源兼容：Contact 表优先（写真源），未命中回退 Relation 人物轨（历史数据）。
  async function attachFollowUpContacts<T extends { contactId: string | null }>(rows: T[]): Promise<(T & { contact: { name: string; title: string | null } | null })[]> {
    const contactIds = [...new Set(rows.map(r => r.contactId).filter((id): id is string => !!id))];
    if (contactIds.length === 0) return rows as any;
    const [contactRows, people] = await Promise.all([
      prisma.contact.findMany({
        where: { id: { in: contactIds }, deletedAt: null },
        select: { id: true, name: true, title: true },
      }),
      prisma.relation.findMany({
        where: { id: { in: contactIds }, isOrganization: false },
        select: { id: true, name: true, role: true },
      }),
    ]);
    const byId = new Map<string, { name: string; title: string | null }>();
    for (const c of contactRows) byId.set(c.id, { name: c.name, title: c.title ?? null });
    for (const p of people) if (!byId.has(p.id)) byId.set(p.id, { name: p.name, title: p.role ?? null });
    return rows.map(row => ({
      ...row,
      contact: row.contactId ? (byId.get(row.contactId) ?? null) : null,
    })) as any;
  }

  async function listFollowUps(relationId: string, opts: { limit?: number; includeCompleted?: boolean } = {}): Promise<FollowUpRecord[]> {
    const where: Record<string, unknown> = { relationId, deletedAt: null };
    if (!opts.includeCompleted) {
      // 默认只返回待跟进（nextFollowUpAt 不为 null 且 >= 今天 或 followUpAt >= 今天-30天）
      const today = todayLocalKey();
      where.OR = [
        { nextFollowUpAt: { gte: today } },
        { nextFollowUpAt: null, followUpAt: { gte: today } },
      ];
    }
    const rows = await prisma.followUpRecord.findMany({
      where: where as any,
      orderBy: [{ nextFollowUpAt: 'asc' }, { followUpAt: 'desc' }],
      take: clampLimit(opts.limit, 100, 500),
    });
    return attachFollowUpContacts(rows);
  }

  async function getFollowUp(id: string): Promise<FollowUpRecord | null> {
    const row = await prisma.followUpRecord.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) return null;
    const [withContact] = await attachFollowUpContacts([row]);
    return withContact;
  }

  async function updateFollowUp(id: string, input: Partial<FollowUpInput>, actorId: string): Promise<FollowUpRecord> {
    const ts = now();
    const updated = await prisma.followUpRecord.update({
      where: { id },
      data: {
        ...(input.contactId !== undefined && { contactId: input.contactId }),
        ...(input.type !== undefined && { type: input.type }),
        ...(input.content !== undefined && { content: input.content }),
        ...(input.followUpAt !== undefined && { followUpAt: input.followUpAt }),
        ...(input.nextFollowUpAt !== undefined && { nextFollowUpAt: input.nextFollowUpAt }),
        ...(input.nextFollowUpTopic !== undefined && { nextFollowUpTopic: input.nextFollowUpTopic }),
        ...(input.opportunityId !== undefined && { opportunityId: input.opportunityId }),
        ...(input.orderId !== undefined && { orderId: input.orderId }),
        ...(input.salesRepId !== undefined && { salesRepId: input.salesRepId }),
        ...(input.salesRepName !== undefined && { salesRepName: input.salesRepName }),
        ...(input.attachments !== undefined && { attachments: input.attachments as any }),
        ...(input.notes !== undefined && { notes: input.notes }),
        updatedAt: ts,
      },
    });
    logger.info('[CrmService] follow-up updated', { id, actorId });
    return updated;
  }

  async function deleteFollowUp(id: string, actorId: string): Promise<void> {
    const ts = now();
    await prisma.followUpRecord.update({
      where: { id },
      data: { deletedAt: ts, updatedAt: ts },
    });
    logger.info('[CrmService] follow-up soft-deleted', { id, actorId });
  }

  /** 查询逾期跟进（nextFollowUpAt < 今天 且未完成） */
  async function listOverdueFollowUps(daysAhead = 0): Promise<FollowUpRecord[]> {
    const today = businessNowDate();
    today.setDate(today.getDate() - daysAhead);
    const cutoff = localDateKey(today);
    return prisma.followUpRecord.findMany({
      where: {
        deletedAt: null,
        nextFollowUpAt: { lt: cutoff, not: null },
      },
      orderBy: { nextFollowUpAt: 'asc' },
      take: 200,
      include: { relation: { select: { name: true, category: true } } },
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 4. 商机管线（Opportunity）
  // ══════════════════════════════════════════════════════════════

  async function createOpportunity(relationId: string, input: OpportunityInput, actorId: string): Promise<Opportunity> {
    const ts = now();
    const oppId = generateId('OPP');
    if (!input?.title?.trim()) {
      throw new CrmValidationError('body.title 必填（商机标题）');
    }
    if (!Number.isFinite(Number(input?.amount)) || Number(input?.amount) <= 0) {
      throw new CrmValidationError('body.amount 必填且须为正数');
    }
    const stage = input.stage ?? 'Prospecting';
    // stage 枚举校验：矩阵外的 stage 落库后无法流转（矩阵按终态处理）
    if (!VALID_OPPORTUNITY_STAGES.includes(stage)) {
      throw new CrmValidationError(`body.stage "${stage}" 非法，合法值：${VALID_OPPORTUNITY_STAGES.join(', ')}`);
    }
    const probability = input.probability ?? STAGE_DEFAULT_PROBABILITY[stage] ?? 10;
    // 关联订单存在性校验（商机→订单闭环，防悬空 orderId）
    if (input.orderId != null && input.orderId !== '') {
      const order = await prisma.order.findFirst({ where: { id: input.orderId, deletedAt: null }, select: { id: true } });
      if (!order) throw new CrmValidationError(`body.orderId "${input.orderId}" 对应订单不存在或已删除`);
    }

    const created = await prisma.$transaction(async (tx) => {
      const opp = await tx.opportunity.create({
        data: {
          id: oppId,
          relationId,
          title: input.title,
          description: input.description ?? null,
          amount: input.amount,
          currency: input.currency ?? 'CNY',
          stage,
          probability,
          expectedCloseDate: input.expectedCloseDate ?? null,
          source: input.source ?? null,
          salesRepId: input.salesRepId ?? null,
          salesRepName: input.salesRepName ?? null,
          orderId: input.orderId || null,
          tags: input.tags ?? [],
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: generateId('alog'),
          actorId: actorId || 'system',
          action: 'create_opportunity',
          targetType: 'Opportunity',
          targetId: oppId,
          detail: { source: 'api:crm', after: { relationId, title: input.title, amount: input.amount, stage } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：opportunityFor（/ convertedToOrder）
      await syncOpportunityReferences(prisma, opp, { source: 'api:crm' }, tx);

      return opp;
    });

    logger.info('[CrmService] opportunity created', { id: oppId, relationId, title: input.title });
    return created;
  }

  async function listOpportunities(opts: { relationId?: string; stage?: string; salesRepId?: string } = {}): Promise<Opportunity[]> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (opts.relationId) where.relationId = opts.relationId;
    if (opts.stage) where.stage = opts.stage;
    if (opts.salesRepId) where.salesRepId = opts.salesRepId;
    return prisma.opportunity.findMany({
      where: where as any,
      orderBy: [{ expectedCloseDate: 'asc' }, { createdAt: 'desc' }],
      include: { relation: { select: { name: true, category: true } } },
    });
  }

  async function getOpportunity(id: string): Promise<Opportunity | null> {
    return prisma.opportunity.findFirst({
      where: { id, deletedAt: null },
      include: { relation: { select: { name: true, category: true } } },
    });
  }

  async function updateOpportunity(id: string, input: Partial<OpportunityInput>, actorId: string): Promise<Opportunity> {
    const ts = now();
    const existing = await prisma.opportunity.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`商机 ${id} 不存在`);

    // 关联订单存在性校验（商机→订单闭环，防悬空 orderId）
    if (input.orderId !== undefined && input.orderId !== null && input.orderId !== '') {
      const order = await prisma.order.findFirst({ where: { id: input.orderId, deletedAt: null }, select: { id: true } });
      if (!order) throw new CrmValidationError(`body.orderId "${input.orderId}" 对应订单不存在或已删除`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const opp = await tx.opportunity.update({
        where: { id },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.amount !== undefined && { amount: input.amount }),
          ...(input.currency !== undefined && { currency: input.currency }),
          ...(input.probability !== undefined && { probability: input.probability }),
          ...(input.expectedCloseDate !== undefined && { expectedCloseDate: input.expectedCloseDate }),
          ...(input.source !== undefined && { source: input.source }),
          ...(input.salesRepId !== undefined && { salesRepId: input.salesRepId }),
          ...(input.salesRepName !== undefined && { salesRepName: input.salesRepName }),
          ...(input.orderId !== undefined && { orderId: input.orderId || null }),
          ...(input.tags !== undefined && { tags: input.tags }),
          ...(input.notes !== undefined && { notes: input.notes }),
          updatedAt: ts,
        },
      });

      // EntityLink 图谱：标题/阶段快照随 update 同步
      await syncOpportunityReferences(prisma, { ...existing, ...opp }, { source: 'api:crm' }, tx);

      return opp;
    });

    logger.info('[CrmService] opportunity updated', { id, actorId });
    return updated;
  }

  /** 商机阶段流转（状态机） */
  async function transitionOpportunityStage(id: string, toStage: string, actorId: string): Promise<Opportunity> {
    const ts = now();
    const existing = await prisma.opportunity.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new Error(`商机 ${id} 不存在`);

    const fromStage = existing.stage;
    validateOpportunityTransition(fromStage, toStage);

    const updated = await prisma.$transaction(async (tx) => {
      const opp = await tx.opportunity.update({
        where: { id },
        data: {
          stage: toStage,
          probability: STAGE_DEFAULT_PROBABILITY[toStage] ?? existing.probability,
          ...(toStage === 'ClosedWon' || toStage === 'ClosedLost' ? { closedAt: ts } : {}),
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: generateId('alog'),
          actorId: actorId || 'system',
          action: 'transition_opportunity_stage',
          targetType: 'Opportunity',
          targetId: id,
          detail: { source: 'api:crm', before: { stage: fromStage }, after: { stage: toStage } } as any,
          ip: null,
          operationType: 'update',
          fieldPath: 'stage',
          beforeValue: fromStage as any,
          afterValue: toStage as any,
          transactionId: null,
        },
      });

      // EntityLink 图谱：stage 快照随流转同步
      await syncOpportunityReferences(prisma, opp, { source: 'api:crm' }, tx);

      return opp;
    });

    // 事务提交后发布事件
    const eventType = toStage === 'ClosedWon' ? 'OpportunityClosedWon'
      : toStage === 'ClosedLost' ? 'OpportunityClosedLost'
      : 'OpportunityStageChanged';

    await publishBusinessEvent({
      type: eventType,
      sourceEntityType: 'Opportunity',
      sourceEntityId: id,
      payload: {
        relationId: existing.relationId,
        title: existing.title,
        amount: Number(existing.amount),
        currency: existing.currency,
        fromStage,
        toStage,
        orderId: existing.orderId ?? undefined,
      },
      actorId: actorId || 'system',
    }).catch((e) => logger.error('[CrmService] publish opportunity event failed', { error: e?.message }));

    logger.info('[CrmService] opportunity stage transitioned', { id, fromStage, toStage, actorId });
    return updated;
  }

  async function deleteOpportunity(id: string, actorId: string): Promise<void> {
    const ts = now();
    await prisma.$transaction(async (tx) => {
      await tx.opportunity.update({
        where: { id },
        data: { deletedAt: ts, updatedAt: ts },
      });
      // EntityLink 图谱：软删同步失效发出的关联
      await deactivateEntityLinks(tx, 'opportunity', id, BigInt(ts));
    });
    logger.info('[CrmService] opportunity soft-deleted', { id, actorId });
  }

  /** 商机管线汇总（按阶段统计数量和金额） */
  async function getOpportunityPipelineSummary(opts: { salesRepId?: string } = {}): Promise<Record<string, { count: number; totalAmount: number }>> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (opts.salesRepId) where.salesRepId = opts.salesRepId;
    const opportunities = await prisma.opportunity.findMany({ where: where as any, select: { stage: true, amount: true } });
    const summary: Record<string, { count: number; totalAmount: number }> = {};
    for (const opp of opportunities) {
      if (!summary[opp.stage]) summary[opp.stage] = { count: 0, totalAmount: 0 };
      summary[opp.stage].count += 1;
      summary[opp.stage].totalAmount += Number(opp.amount);
    }
    return summary;
  }

  // ══════════════════════════════════════════════════════════════
  // 5. 客户分层（CustomerTier）
  // ══════════════════════════════════════════════════════════════

  async function assignCustomerTier(relationId: string, input: CustomerTierInput, actorId: string): Promise<CustomerTier> {
    const ts = now();
    const tierId = generateId('TIER');
    if (!input?.level?.trim()) {
      throw new CrmValidationError('body.level 必填（分层等级）');
    }
    if (!input?.evaluatedAt?.trim()) {
      throw new CrmValidationError('body.evaluatedAt 必填（评定日期 YYYY-MM-DD）');
    }

    const created = await prisma.$transaction(async (tx) => {
      // 将同 relation 下已有 active tier 标记为过期
      await tx.customerTier.updateMany({
        where: { relationId, deletedAt: null, validUntil: null },
        data: { validUntil: input.evaluatedAt, updatedAt: ts },
      });
      // 同时把 validUntil 不为 null 但未过期的也标记过期
      await tx.customerTier.updateMany({
        where: {
          relationId,
          deletedAt: null,
          validUntil: { not: null, gte: input.evaluatedAt },
        },
        data: { validUntil: input.evaluatedAt, updatedAt: ts },
      });

      const tier = await tx.customerTier.create({
        data: {
          id: tierId,
          relationId,
          level: input.level,
          criteria: input.criteria ?? null,
          discountRate: input.discountRate ?? null,
          paymentTermsDays: input.paymentTermsDays ?? null,
          creditPriority: input.creditPriority ?? 'Normal',
          evaluatedAt: input.evaluatedAt,
          validUntil: input.validUntil ?? null,
          evaluatedBy: input.evaluatedBy ?? null,
          notes: input.notes ?? null,
          createdAt: ts,
          updatedAt: ts,
        },
      });

      await tx.auditLog.create({
        data: {
          id: generateId('alog'),
          actorId: actorId || 'system',
          action: 'assign_customer_tier',
          targetType: 'CustomerTier',
          targetId: tierId,
          detail: { source: 'api:crm', after: { relationId, level: input.level } } as any,
          ip: null,
          operationType: 'create',
          fieldPath: null,
          beforeValue: null as any,
          afterValue: null as any,
          transactionId: null,
        },
      });

      return tier;
    });

    // 事务提交后发布事件
    await publishBusinessEvent({
      type: 'CustomerTierAssigned',
      sourceEntityType: 'CustomerTier',
      sourceEntityId: tierId,
      payload: {
        relationId,
        level: input.level,
        discountRate: input.discountRate,
        creditPriority: input.creditPriority ?? 'Normal',
      },
      actorId: actorId || 'system',
    }).catch((e) => logger.error('[CrmService] publish CustomerTierAssigned failed', { error: e?.message }));

    logger.info('[CrmService] customer tier assigned', { id: tierId, relationId, level: input.level });
    return created;
  }

  async function getActiveCustomerTier(relationId: string): Promise<CustomerTier | null> {
    const today = todayLocalKey();
    return prisma.customerTier.findFirst({
      where: {
        relationId,
        deletedAt: null,
        OR: [
          { validUntil: null },
          { validUntil: { gte: today } },
        ],
      },
      orderBy: { evaluatedAt: 'desc' },
    });
  }

  async function listCustomerTierHistory(relationId: string): Promise<CustomerTier[]> {
    return prisma.customerTier.findMany({
      where: { relationId, deletedAt: null },
      orderBy: { evaluatedAt: 'desc' },
    });
  }

  async function deleteCustomerTier(id: string, actorId: string): Promise<void> {
    const ts = now();
    await prisma.customerTier.update({
      where: { id },
      data: { deletedAt: ts, updatedAt: ts },
    });
    logger.info('[CrmService] customer tier soft-deleted', { id, actorId });
  }

  // ══════════════════════════════════════════════════════════════
  // 内部辅助：计算已用信用额度
  // ══════════════════════════════════════════════════════════════

  async function calculateUsedCredit(tx: any, relationId: string): Promise<number> {
    // 已用信用额度 = 该 relation 未结清应收净额（Σ发票 amount − Σ核销 applied，
    // status∉Cancelled/Void，按原币不折算）——与 creditService.recalculateCustomerCredit
    // 事件驱动重算共用 computeNetOpenReceivables 单一真源，杜绝毛额/净额两套口径跳变
    // （历史缺陷：原毛额口径 Σ amount 不减已核销，改额度触发重算会与账龄/KPI 净额展示漂移）
    const net = await computeNetOpenReceivables(tx, relationId);
    return net.toNumber();
  }

  // ══════════════════════════════════════════════════════════════
  // CRM 总览（按 relation 聚合）
  // ══════════════════════════════════════════════════════════════

  async function getRelationCrmOverview(relationId: string): Promise<{
    contacts: Contact[];
    activeCreditLimit: CreditLimit | null;
    creditLimitHistory: CreditLimit[];
    pendingFollowUps: FollowUpRecord[];
    opportunities: Opportunity[];
    activeTier: CustomerTier | null;
    tierHistory: CustomerTier[];
  }> {
    const [contacts, activeCreditLimit, creditLimitHistory, pendingFollowUps, opportunities, activeTier, tierHistory] = await Promise.all([
      listContacts(relationId),
      getActiveCreditLimit(relationId),
      listCreditLimitHistory(relationId),
      listFollowUps(relationId, { limit: 10 }),
      listOpportunities({ relationId }),
      getActiveCustomerTier(relationId),
      listCustomerTierHistory(relationId),
    ]);

    return {
      contacts,
      activeCreditLimit,
      creditLimitHistory,
      pendingFollowUps,
      opportunities,
      activeTier,
      tierHistory,
    };
  }

  return {
    // Contact
    createContact,
    listContacts,
    getContact,
    updateContact,
    deleteContact,
    // CreditLimit
    setCreditLimit,
    getActiveCreditLimit,
    listCreditLimitHistory,
    updateCreditLimitStatus,
    // FollowUpRecord
    createFollowUp,
    listFollowUps,
    getFollowUp,
    updateFollowUp,
    deleteFollowUp,
    listOverdueFollowUps,
    // Opportunity
    createOpportunity,
    listOpportunities,
    getOpportunity,
    updateOpportunity,
    transitionOpportunityStage,
    deleteOpportunity,
    getOpportunityPipelineSummary,
    // CustomerTier
    assignCustomerTier,
    getActiveCustomerTier,
    listCustomerTierHistory,
    deleteCustomerTier,
    // Overview
    getRelationCrmOverview,
  };
}
