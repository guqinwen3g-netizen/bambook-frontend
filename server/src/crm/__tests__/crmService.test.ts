/**
 * Phase 3 C1 CRM 服务单元测试
 *
 * 覆盖：
 *   - Contact：CRUD + 主联系人唯一性 + 软删除
 *   - CreditLimit：设置 + 旧记录过期 + 超额事件发布
 *   - FollowUpRecord：CRUD + 逾期查询
 *   - Opportunity：CRUD + 阶段流转（合法/非法）+ 成交/流失事件
 *   - CustomerTier：评定 + 旧分层过期 + 事件发布
 *
 * 设计：
 *   - $transaction: (fn) => fn(tx) 透明穿透
 *   - audit reject → 事务回滚（fail-closed）
 *   - 事件发布在事务提交后（fire-and-forget）
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createCrmService, CrmValidationError, VALID_OPPORTUNITY_STAGES } from '../crmService';
import { businessEventBus } from '../../events/businessEventBus';

// ── Mock businessEventBus.publish ──
const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

// ── Mock logger ──
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── 工厂：构造 mock prisma + tx ──
function makePrisma(overrides: Record<string, any> = {}) {
  const auditLogCreate = overrides.auditFail
    ? vi.fn().mockRejectedValue(new Error('AUDIT_BOOM'))
    : vi.fn().mockResolvedValue({});

  // ★ v3.110：读"被顶掉的那几位"（事务内）与 listContacts（事务外）默认共用同一把桩，
  //   否则测试里 mock 了 prisma.contact.findMany、服务在 tx 里读的却是另一把桩（静默空转）。
  const contactFindMany = overrides.contactFindMany ?? vi.fn().mockResolvedValue([]);
  const contactFindFirst = overrides.contactFindFirst ?? vi.fn().mockResolvedValue(null);

  const tx = {
    contact: {
      create: overrides.contactCreateFail
        ? vi.fn().mockRejectedValue(new Error('DB_BOOM'))
        : vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: contactFindFirst,
      // ★ v3.110（B216 补漏）：设主联系人时会先读"被顶掉的那几位"再逐条留痕
      findMany: overrides.contactDemoteFindMany ?? contactFindMany,
    },
    // ★ v3.110（B218）：resolveAuditActorId 写审计前先查身份是否存在。
    //   默认"存在"（＝沿用被断言的既有行为：actorId 原样落库、不降级）；
    //   降级分支由 contactAuditWrites.test.ts 用 count→0 的桩单独打。
    userAccount: {
      count: overrides.userAccountCount ?? vi.fn().mockResolvedValue(1),
    },
    creditLimit: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    // 修复1：setCreditLimit 初始 usedAmount 快照 append CreditLimitHistory（铁律 #2）
    creditLimitHistory: {
      create: vi.fn().mockResolvedValue({}),
    },
    followUpRecord: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    opportunity: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: overrides.oppFindFirst ?? vi.fn().mockResolvedValue(null),
    },
    customerTier: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    invoice: {
      // 修复1：calculateUsedCredit 净额口径（Σ amount − Σ核销，经 computeNetOpenReceivables）
      findMany: vi.fn().mockResolvedValue([]),
    },
    invoiceAllocation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // 信用额度单一真源联动（relation.update 回写）+ 联系人统一（Contact CRUD 代理 Relation 人物轨）
    relation: {
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, isOrganization: false, parentId: 'rel_1', ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      // 默认形状：父组织（createContact 前置校验用）；具体测试按需覆盖
      findFirst: vi.fn().mockResolvedValue({ id: 'rel_1', isOrganization: true, category: 'Customer', parentId: null }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: { create: auditLogCreate },
    // EntityLink 图谱（D1.1a）：sync/deactivate 走 tx 内 upsert/findMany/update
    entityReference: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    entityLink: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  };

  const prisma = {
    ...tx,
    $transaction: overrides.transactionFail
      ? vi.fn().mockRejectedValue(new Error('TX_BOOM'))
      : vi.fn(async (fn: any) => fn(tx)),
    contact: {
      ...tx.contact,
      findMany: contactFindMany,
      findFirst: contactFindFirst,
      update: tx.contact.update,
    },
    creditLimit: {
      ...tx.creditLimit,
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.creditLimit.update,
    },
    followUpRecord: {
      ...tx.followUpRecord,
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: tx.followUpRecord.findFirst,
      update: tx.followUpRecord.update,
    },
    opportunity: {
      ...tx.opportunity,
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: overrides.oppFindFirst ?? vi.fn().mockResolvedValue(null),
      update: tx.opportunity.update,
    },
    customerTier: {
      ...tx.customerTier,
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.customerTier.update,
    },
  };

  return prisma as any;
}

describe('CrmService', () => {
  let prisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
  });

  // ══════════════════════════════════════════════════════════════
  // Contact
  // ══════════════════════════════════════════════════════════════

  describe('Contact（Contact 表写真源——联系人统一）', () => {
    it('creates a contact successfully (落到 Contact 表)', async () => {
      const service = createCrmService(prisma);
      const contact = await service.createContact('rel_1', {
        name: '张三',
        title: '采购经理',
        email: 'zhangsan@example.com',
        isPrimary: true,
      }, 'user_1');

      expect(contact.name).toBe('张三');
      expect(contact.isPrimary).toBe(true);
      expect(contact.title).toBe('采购经理');
      expect(contact.relationId).toBe('rel_1');
      expect(contact.id).toMatch(/^CTC_/);
      expect(prisma.contact.create).toHaveBeenCalledTimes(1);
      // 写路径收敛：不再创建 Relation 人物子行
      expect(prisma.relation.create).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('rejects when parent organization missing', async () => {
      prisma.relation.findFirst.mockResolvedValue(null);
      const service = createCrmService(prisma);
      await expect(
        service.createContact('ghost_org', { name: '孤儿' }, 'user_1'),
      ).rejects.toThrow(CrmValidationError);
      prisma.relation.findFirst.mockResolvedValue({ id: 'rel_1', isOrganization: true, category: 'Customer', parentId: null });
    });

    it('clears other primary contacts when creating a new primary（★ v3.110：且被顶掉的每一位都留下一条 isPrimary 痕）', async () => {
      const service = createCrmService(prisma);
      const peers = [{ id: 'CTC-A' }, { id: 'CTC-B' }];
      prisma.contact.findMany.mockResolvedValue(peers);
      prisma.auditLog.create.mockClear();

      await service.createContact('rel_1', { name: '李四', isPrimary: true }, 'user_1');

      // ★ 断的是**行为**（那几位确实被降级了），不是某一句 where 的字面形状：
      //   写下去的 id 集合＝刚读到的那批＝留下痕的那批，三者必须同源（旧写法钉 where 字面，
      //   一旦"读—写—痕"不同源它就看不见）。
      expect(prisma.contact.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ['CTC-A', 'CTC-B'] } }),
          data: expect.objectContaining({ isPrimary: false }),
        }),
      );
      const demoteTraces = prisma.auditLog.create.mock.calls
        .map((c: any[]) => c[0].data)
        .filter((d: any) => d.fieldPath === 'isPrimary' && d.targetType === 'Contact');
      expect(demoteTraces.map((d: any) => d.targetId).sort()).toEqual(['CTC-A', 'CTC-B']);
      for (const d of demoteTraces) {
        expect(d).toMatchObject({ beforeValue: true, afterValue: false, actorId: 'user_1' });
      }
    });

    it('does not clear primary when new contact is not primary', async () => {
      const service = createCrmService(prisma);
      await service.createContact('rel_1', { name: '王五', isPrimary: false }, 'user_1');

      expect(prisma.contact.updateMany).not.toHaveBeenCalled();
    });

    it('throws when audit fails (fail-closed)', async () => {
      prisma = makePrisma({ auditFail: true });
      const service = createCrmService(prisma);

      await expect(
        service.createContact('rel_1', { name: '赵六' }, 'user_1'),
      ).rejects.toThrow('AUDIT_BOOM');
    });

    it('lists contacts for a relation (Contact 表真源)', async () => {
      prisma.contact.findMany.mockResolvedValue([
        { id: 'CTC_1', relationId: 'rel_1', name: '张三', title: '采购经理', isPrimary: true, isDecisionMaker: false, status: 'Active', tags: [], deletedAt: null, createdAt: 100, updatedAt: 100 },
        { id: 'CTC_2', relationId: 'rel_1', name: '李四', title: null, isPrimary: false, isDecisionMaker: false, status: 'Active', tags: [], deletedAt: null, createdAt: 200, updatedAt: 200 },
      ]);
      const service = createCrmService(prisma);
      const contacts = await service.listContacts('rel_1');

      expect(contacts).toHaveLength(2);
      expect(contacts[0].isPrimary).toBe(true);
      expect(contacts[0].title).toBe('采购经理');
      expect(contacts[0].status).toBe('Active');
      expect(prisma.contact.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { relationId: 'rel_1', deletedAt: null },
        }),
      );
    });

    it('updates a contact (Contact 表)', async () => {
      prisma.contact.findFirst.mockResolvedValue({ id: 'CTC_1', relationId: 'rel_1', name: '张三', isPrimary: false, deletedAt: null });
      const service = createCrmService(prisma);
      const updated = await service.updateContact('CTC_1', { name: '张三丰' }, 'user_1');

      expect(prisma.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'CTC_1' } }),
      );
      expect(updated.name).toBe('张三丰');
    });

    it('throws when contact not found on update', async () => {
      prisma.contact.findFirst.mockResolvedValue(null);
      const service = createCrmService(prisma);

      await expect(
        service.updateContact('missing', { name: 'X' }, 'user_1'),
      ).rejects.toThrow('不存在');
    });

    it('soft-deletes a contact and clears primary (Contact 表)', async () => {
      // 2026-08-31 真源回写：删除在事务内先查行（存在性校验）+ 回写组织冗余字段
      const svcPrisma = makePrisma({
        contactFindFirst: vi.fn().mockResolvedValue({ id: 'CTC_1', relationId: 'rel_1', name: '张三', isPrimary: true, deletedAt: null }),
      });
      const service = createCrmService(svcPrisma);
      await service.deleteContact('CTC_1', 'user_1');

      expect(svcPrisma.contact.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'CTC_1' },
          data: expect.objectContaining({ isPrimary: false, deletedAt: expect.anything() }),
        }),
      );
      // 主联系人删除后同事务刷新组织冗余字段（旧轨消费点保鲜）
      expect(svcPrisma.relation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'rel_1' } }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // CreditLimit
  // ══════════════════════════════════════════════════════════════

  describe('CreditLimit', () => {
    it('sets a new credit limit and expires old active ones', async () => {
      const service = createCrmService(prisma);
      const cl = await service.setCreditLimit('rel_1', {
        totalLimit: 100000,
        currency: 'CNY',
        validFrom: '2026-08-07',
        approvedBy: 'manager_1',
      }, 'user_1');

      expect(cl.totalLimit).toBe(100000);
      expect(cl.status).toBe('Active');
      // 旧的 Active 信用额度标记为 Expired
      expect(prisma.creditLimit.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { relationId: 'rel_1', status: 'Active', deletedAt: null },
          data: expect.objectContaining({ status: 'Expired' }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('calculates used amount from outstanding receivable invoices (net of allocations)', async () => {
      // 净额口径：Σ发票 amount 60000 − Σ核销 applied 10000 = 50000
      prisma.invoice.findMany.mockResolvedValue([
        { id: 'I1', amount: new Prisma.Decimal('40000') },
        { id: 'I2', amount: new Prisma.Decimal('20000') },
      ]);
      prisma.invoiceAllocation.findMany.mockResolvedValue([
        { invoiceId: 'I1', appliedAmount: new Prisma.Decimal('10000') },
      ]);
      const service = createCrmService(prisma);
      const cl = await service.setCreditLimit('rel_1', {
        totalLimit: 100000,
        validFrom: '2026-08-07',
      }, 'user_1');

      expect(cl.usedAmount).toBe(50000);
      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { notIn: ['Cancelled', 'Void'] },
            type: 'Receivable',
            customerRelationId: 'rel_1',
          }),
        }),
      );
      // 铁律 #2：初始 usedAmount 快照同步 append CreditLimitHistory（同事务）
      expect(prisma.creditLimitHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            triggerType: 'credit_limit_set',
            beforeUsedAmount: 0,
            afterUsedAmount: 50000,
          }),
        }),
      );
    });

    it('publishes CreditLimitExceeded event when used > limit', async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: 'I1', amount: new Prisma.Decimal('150000') },
      ]);
      prisma.invoiceAllocation.findMany.mockResolvedValue([]);
      const service = createCrmService(prisma);
      await service.setCreditLimit('rel_1', {
        totalLimit: 100000,
        validFrom: '2026-08-07',
      }, 'user_1');

      await new Promise((r) => setTimeout(r, 10));
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CreditLimitExceeded',
          sourceEntityType: 'CreditLimit',
        }),
      );
    });

    it('does not publish CreditLimitExceeded when within limit', async () => {
      prisma.invoice.findMany.mockResolvedValue([
        { id: 'I1', amount: new Prisma.Decimal('50000') },
      ]);
      prisma.invoiceAllocation.findMany.mockResolvedValue([]);
      const service = createCrmService(prisma);
      await service.setCreditLimit('rel_1', {
        totalLimit: 100000,
        validFrom: '2026-08-07',
      }, 'user_1');

      await new Promise((r) => setTimeout(r, 10));
      const exceededCalls = publishSpy.mock.calls.filter((c) => c[0].type === 'CreditLimitExceeded');
      expect(exceededCalls).toHaveLength(0);
    });

    it('updates credit limit status', async () => {
      const service = createCrmService(prisma);
      await service.updateCreditLimitStatus('cl_1', 'Frozen', 'user_1');
      expect(prisma.creditLimit.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'cl_1' }, data: expect.objectContaining({ status: 'Frozen' }) }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // FollowUpRecord
  // ══════════════════════════════════════════════════════════════

  describe('FollowUpRecord', () => {
    it('creates a follow-up record with audit', async () => {
      const service = createCrmService(prisma);
      const fu = await service.createFollowUp('rel_1', {
        type: 'Visit',
        content: '拜访客户讨论春季订单',
        followUpAt: '2026-08-07',
        nextFollowUpAt: '2026-08-15',
        nextFollowUpTopic: '确认价格',
      }, 'user_1');

      expect(fu.type).toBe('Visit');
      expect(fu.nextFollowUpAt).toBe('2026-08-15');
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('lists follow-ups with default filter', async () => {
      prisma.followUpRecord.findMany.mockResolvedValue([
        { id: 'fu_1', type: 'Call', content: '电话跟进' },
      ]);
      const service = createCrmService(prisma);
      const result = await service.listFollowUps('rel_1');

      expect(result).toHaveLength(1);
      expect(prisma.followUpRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ nextFollowUpAt: 'asc' }, { followUpAt: 'desc' }],
        }),
      );
    });

    it('updates a follow-up', async () => {
      const service = createCrmService(prisma);
      await service.updateFollowUp('fu_1', { content: '更新内容' }, 'user_1');
      expect(prisma.followUpRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'fu_1' } }),
      );
    });

    it('soft-deletes a follow-up', async () => {
      const service = createCrmService(prisma);
      await service.deleteFollowUp('fu_1', 'user_1');
      expect(prisma.followUpRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'fu_1' },
          data: expect.objectContaining({ deletedAt: expect.any(Number) }),
        }),
      );
    });

    it('queries overdue follow-ups', async () => {
      const today = new Date().toISOString().slice(0, 10);
      prisma.followUpRecord.findMany.mockResolvedValue([
        { id: 'fu_1', nextFollowUpAt: '2026-01-01', relation: { name: 'ACME' } },
      ]);
      const service = createCrmService(prisma);
      const overdue = await service.listOverdueFollowUps(0);

      expect(overdue).toHaveLength(1);
      expect(prisma.followUpRecord.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            nextFollowUpAt: { lt: today, not: null },
          }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Opportunity
  // ══════════════════════════════════════════════════════════════

  describe('Opportunity', () => {
    it('creates an opportunity with default stage and probability', async () => {
      const service = createCrmService(prisma);
      const opp = await service.createOpportunity('rel_1', {
        title: '2026 春季西装订单',
        amount: 500000,
      }, 'user_1');

      expect(opp.title).toBe('2026 春季西装订单');
      expect(opp.stage).toBe('Prospecting');
      expect(opp.probability).toBe(10);
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('creates opportunity with custom stage', async () => {
      const service = createCrmService(prisma);
      const opp = await service.createOpportunity('rel_1', {
        title: '商机X',
        amount: 100000,
        stage: 'Negotiation',
      }, 'user_1');

      expect(opp.stage).toBe('Negotiation');
      expect(opp.probability).toBe(75);
    });

    // ── 商机→订单关联闭环（Opportunity.orderId 断链修复）──
    it('creates opportunity with linked order (orderId persisted after existence check)', async () => {
      prisma.order = { findFirst: vi.fn().mockResolvedValue({ id: 'ord_1' }) };
      const service = createCrmService(prisma);
      const opp = await service.createOpportunity('rel_1', {
        title: '成交商机', amount: 100000, orderId: 'ord_1',
      }, 'user_1');

      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ord_1', deletedAt: null } }),
      );
      expect(prisma.opportunity.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ orderId: 'ord_1' }) }),
      );
      expect(opp.orderId).toBe('ord_1');
    });

    it('rejects opportunity with nonexistent orderId (防悬空挂接)', async () => {
      prisma.order = { findFirst: vi.fn().mockResolvedValue(null) };
      const service = createCrmService(prisma);
      await expect(service.createOpportunity('rel_1', {
        title: '悬空商机', amount: 100, orderId: 'ord_ghost',
      }, 'user_1')).rejects.toThrow(CrmValidationError);
      expect(prisma.opportunity.create).not.toHaveBeenCalled();
    });

    it('updates opportunity orderId (validated) and can clear it', async () => {
      prisma.order = { findFirst: vi.fn().mockResolvedValue({ id: 'ord_2' }) };
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1', stage: 'Negotiation', relationId: 'rel_1', title: '商机X',
        amount: 100000, currency: 'CNY', orderId: null,
      });
      const service = createCrmService(prisma);
      await service.updateOpportunity('opp_1', { orderId: 'ord_2' }, 'user_1');

      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ord_2', deletedAt: null } }),
      );
      expect(prisma.opportunity.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ orderId: 'ord_2' }) }),
      );

      // 清空挂接：orderId='' → null（清空不触发存在性校验）
      await service.updateOpportunity('opp_1', { orderId: '' }, 'user_1');
      expect(prisma.opportunity.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ orderId: null }) }),
      );
    });

    it('rejects update with nonexistent orderId', async () => {
      prisma.order = { findFirst: vi.fn().mockResolvedValue(null) };
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1', stage: 'Negotiation', relationId: 'rel_1', title: '商机X',
        amount: 100000, currency: 'CNY', orderId: null,
      });
      const service = createCrmService(prisma);
      await expect(service.updateOpportunity('opp_1', { orderId: 'ord_ghost' }, 'user_1'))
        .rejects.toThrow(CrmValidationError);
      expect(prisma.opportunity.update).not.toHaveBeenCalled();
    });

    // ── 输入合约校验（验收 E3 修复）：矩阵外 stage 落库后永远无法流转 ──
    it('rejects opportunity stage outside transition matrix (CrmValidationError)', async () => {
      const service = createCrmService(prisma);
      await expect(service.createOpportunity('rel_1', {
        title: '僵尸商机', amount: 100, stage: 'Lead',
      }, 'user_1')).rejects.toThrow(CrmValidationError);
      expect(prisma.opportunity.create).not.toHaveBeenCalled();
    });

    it('rejects opportunity without title or with non-positive amount', async () => {
      const service = createCrmService(prisma);
      await expect(service.createOpportunity('rel_1', { amount: 100 } as any, 'user_1'))
        .rejects.toThrow(CrmValidationError);
      await expect(service.createOpportunity('rel_1', { title: 'x', amount: -5 } as any, 'user_1'))
        .rejects.toThrow(CrmValidationError);
    });

    it('exposes VALID_OPPORTUNITY_STAGES from the transition matrix', () => {
      expect(VALID_OPPORTUNITY_STAGES).toEqual(
        ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'ClosedWon', 'ClosedLost'],
      );
    });

    it('transitions opportunity stage forward (Prospecting → Qualification)', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1',
        stage: 'Prospecting',
        probability: 10,
        relationId: 'rel_1',
        title: '商机X',
        amount: 100000,
        currency: 'CNY',
      });
      const service = createCrmService(prisma);
      const result = await service.transitionOpportunityStage('opp_1', 'Qualification', 'user_1');

      expect(result.stage).toBe('Qualification');
      expect(result.probability).toBe(25);
      expect(prisma.opportunity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'opp_1' },
          data: expect.objectContaining({ stage: 'Qualification', probability: 25 }),
        }),
      );
    });

    it('publishes OpportunityStageChanged event on transition', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1',
        stage: 'Qualification',
        relationId: 'rel_1',
        title: '商机X',
        amount: 100000,
        currency: 'CNY',
      });
      const service = createCrmService(prisma);
      await service.transitionOpportunityStage('opp_1', 'Proposal', 'user_1');

      await new Promise((r) => setTimeout(r, 10));
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'OpportunityStageChanged',
          sourceEntityType: 'Opportunity',
          payload: expect.objectContaining({
            fromStage: 'Qualification',
            toStage: 'Proposal',
          }),
        }),
      );
    });

    it('publishes OpportunityClosedWon event when closing won', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1',
        stage: 'Negotiation',
        relationId: 'rel_1',
        title: '商机X',
        amount: 100000,
        currency: 'CNY',
      });
      const service = createCrmService(prisma);
      await service.transitionOpportunityStage('opp_1', 'ClosedWon', 'user_1');

      await new Promise((r) => setTimeout(r, 10));
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'OpportunityClosedWon',
          payload: expect.objectContaining({ toStage: 'ClosedWon' }),
        }),
      );
    });

    it('sets closedAt when closing won', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1',
        stage: 'Negotiation',
        relationId: 'rel_1',
        title: '商机X',
        amount: 100000,
        currency: 'CNY',
      });
      const service = createCrmService(prisma);
      await service.transitionOpportunityStage('opp_1', 'ClosedWon', 'user_1');

      expect(prisma.opportunity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ closedAt: expect.any(Number) }),
        }),
      );
    });

    it('throws on invalid stage transition (ClosedWon → Prospecting)', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1',
        stage: 'ClosedWon',
        relationId: 'rel_1',
        title: '已成交',
        amount: 100000,
        currency: 'CNY',
      });
      const service = createCrmService(prisma);

      await expect(
        service.transitionOpportunityStage('opp_1', 'Prospecting', 'user_1'),
      ).rejects.toThrow('非法');
    });

    it('throws on invalid forward transition (Prospecting → ClosedWon)', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1',
        stage: 'Prospecting',
        relationId: 'rel_1',
        title: '商机X',
        amount: 100000,
        currency: 'CNY',
      });
      const service = createCrmService(prisma);

      await expect(
        service.transitionOpportunityStage('opp_1', 'ClosedWon', 'user_1'),
      ).rejects.toThrow('非法');
    });

    it('throws when opportunity not found on transition', async () => {
      prisma.opportunity.findFirst.mockResolvedValue(null);
      const service = createCrmService(prisma);

      await expect(
        service.transitionOpportunityStage('missing', 'Qualification', 'user_1'),
      ).rejects.toThrow('不存在');
    });

    it('updates opportunity fields', async () => {
      prisma.opportunity.findFirst.mockResolvedValue({
        id: 'opp_1',
        stage: 'Prospecting',
        relationId: 'rel_1',
        title: '商机X',
        amount: 100000,
        currency: 'CNY',
      });
      const service = createCrmService(prisma);
      await service.updateOpportunity('opp_1', { amount: 200000, notes: '加价' }, 'user_1');
      expect(prisma.opportunity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'opp_1' },
          data: expect.objectContaining({ amount: 200000, notes: '加价' }),
        }),
      );
    });

    it('gets pipeline summary grouped by stage', async () => {
      prisma.opportunity.findMany.mockResolvedValue([
        { stage: 'Prospecting', amount: '100000' },
        { stage: 'Prospecting', amount: '50000' },
        { stage: 'ClosedWon', amount: '200000' },
      ]);
      const service = createCrmService(prisma);
      const summary = await service.getOpportunityPipelineSummary();

      expect(summary.Prospecting).toEqual({ count: 2, totalAmount: 150000 });
      expect(summary.ClosedWon).toEqual({ count: 1, totalAmount: 200000 });
    });

    it('soft-deletes an opportunity', async () => {
      const service = createCrmService(prisma);
      await service.deleteOpportunity('opp_1', 'user_1');
      expect(prisma.opportunity.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'opp_1' },
          data: expect.objectContaining({ deletedAt: expect.any(Number) }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // CustomerTier
  // ══════════════════════════════════════════════════════════════

  describe('CustomerTier', () => {
    it('assigns a new tier and expires old ones', async () => {
      const service = createCrmService(prisma);
      const tier = await service.assignCustomerTier('rel_1', {
        level: 'Gold',
        discountRate: 5,
        paymentTermsDays: 60,
        creditPriority: 'High',
        evaluatedAt: '2026-08-07',
        evaluatedBy: 'manager_1',
      }, 'user_1');

      expect(tier.level).toBe('Gold');
      expect(tier.discountRate).toBe(5);
      // 旧分层应该被标记为过期
      expect(prisma.customerTier.updateMany).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('publishes CustomerTierAssigned event', async () => {
      const service = createCrmService(prisma);
      await service.assignCustomerTier('rel_1', {
        level: 'Platinum',
        evaluatedAt: '2026-08-07',
      }, 'user_1');

      await new Promise((r) => setTimeout(r, 10));
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CustomerTierAssigned',
          sourceEntityType: 'CustomerTier',
          payload: expect.objectContaining({
            relationId: 'rel_1',
            level: 'Platinum',
          }),
        }),
      );
    });

    it('gets active customer tier', async () => {
      prisma.customerTier.findFirst.mockResolvedValue({
        id: 'tier_1',
        level: 'Gold',
        evaluatedAt: '2026-08-07',
      });
      const service = createCrmService(prisma);
      const tier = await service.getActiveCustomerTier('rel_1');

      expect(tier).not.toBeNull();
      expect(tier!.level).toBe('Gold');
    });

    it('lists tier history', async () => {
      prisma.customerTier.findMany.mockResolvedValue([
        { id: 'tier_1', level: 'Silver', evaluatedAt: '2026-01-01' },
        { id: 'tier_2', level: 'Gold', evaluatedAt: '2026-08-07' },
      ]);
      const service = createCrmService(prisma);
      const history = await service.listCustomerTierHistory('rel_1');

      expect(history).toHaveLength(2);
    });

    it('soft-deletes a tier', async () => {
      const service = createCrmService(prisma);
      await service.deleteCustomerTier('tier_1', 'user_1');
      expect(prisma.customerTier.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tier_1' },
          data: expect.objectContaining({ deletedAt: expect.any(Number) }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Overview
  // ══════════════════════════════════════════════════════════════

  describe('getRelationCrmOverview', () => {
    it('aggregates all CRM entities for a relation', async () => {
      // 联系人统一：overview.contacts 经 listContacts 读 Contact 表写真源
      prisma.contact.findMany.mockResolvedValue([
        { id: 'CTC_1', relationId: 'rel_1', name: '张三', title: null, isPrimary: false, isDecisionMaker: false, status: 'Active', tags: [], deletedAt: null, createdAt: 1, updatedAt: 1 },
      ]);
      prisma.creditLimit.findFirst.mockResolvedValue({ id: 'cl_1', totalLimit: 100000 });
      prisma.creditLimit.findMany.mockResolvedValue([{ id: 'cl_1' }]);
      prisma.followUpRecord.findMany.mockResolvedValue([{ id: 'fu_1', type: 'Call' }]);
      prisma.opportunity.findMany.mockResolvedValue([{ id: 'opp_1', stage: 'Prospecting' }]);
      prisma.customerTier.findFirst.mockResolvedValue({ id: 'tier_1', level: 'Gold' });
      prisma.customerTier.findMany.mockResolvedValue([{ id: 'tier_1' }]);

      const service = createCrmService(prisma);
      const overview = await service.getRelationCrmOverview('rel_1');

      expect(overview.contacts).toHaveLength(1);
      expect(overview.contacts[0].name).toBe('张三');
      expect(overview.activeCreditLimit).not.toBeNull();
      expect(overview.pendingFollowUps).toHaveLength(1);
      expect(overview.opportunities).toHaveLength(1);
      expect(overview.activeTier).not.toBeNull();
    });
  });
});
