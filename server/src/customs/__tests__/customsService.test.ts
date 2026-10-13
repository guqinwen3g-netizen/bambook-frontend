/**
 * Customs 服务单元测试 — 外贸与报关模块
 *
 * 覆盖：
 *   - CustomsDeclaration：CRUD + 软删除 + 重复编号校验 + 状态机（Draft→Submitted→Declared→Inspecting→Released）
 *   - HsCode：CRUD + 重复编码校验 + deactivate
 *   - LetterOfCredit：CRUD + 状态机（Issued→Presented→Accepted→Settled）
 *   - TaxRefund：CRUD + 状态机 + 自动退税额计算 + 审核流程
 *   - TradeDocument：CRUD + 状态机（Draft→Issued→Submitted→Accepted）
 *   - 事件发布 fire-and-forget
 *   - 事务失败隔离
 *
 * 设计：
 *   - $transaction: (fn) => fn(tx) 透明穿透
 *   - 状态转换非法时 fail-closed
 *   - HsCode 用 findUnique（code 是 @unique），其他实体用 findFirst
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createCustomsService } from '../customsService';
import { businessEventBus } from '../../events/businessEventBus';
import { ciActor, createCiStorage, currentCiOptions } from './ciLegacyContractStorage';

// ── Mock businessEventBus.publish ──
const publishSpy = vi.spyOn(businessEventBus, 'publish').mockResolvedValue(undefined);

// ── Mock logger ──
vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── 工厂：构造 mock prisma + tx ──
function makePrisma(overrides: Record<string, any> = {}) {
  const auditLogCreate = vi.fn().mockResolvedValue({});

  const tx = {
    customsDeclaration: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null, lines: [] })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data, lines: [] })),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id })),
    },
    customsDeclarationLine: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    hsCode: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findUnique: overrides.hsFindUnique ?? vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id })),
    },
    letterOfCredit: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: overrides.lcFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id })),
    },
    lcEvent: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
      findMany: vi.fn().mockResolvedValue([]),
    },
    taxRefund: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: overrides.trFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id })),
    },
    tradeDocument: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data, deletedAt: null })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data })),
      findFirst: overrides.docFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockImplementation(async ({ where }: any) => ({ id: where.id })),
    },
    auditLog: { create: auditLogCreate, findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    // Wave A1 强制版本留痕：appendTradeDocumentVersion 走 tx 内 findFirst/create
    documentVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
    },
    // C4 关单闭环：backfillShipmentCustoms 探测运单（null → 静默跳过）
    shipment: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
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
    customsDeclaration: {
      ...tx.customsDeclaration,
      findFirst: overrides.declFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.customsDeclaration.update,
      count: overrides.declCount ?? vi.fn().mockResolvedValue(0),
    },
    customsDeclarationLine: { ...tx.customsDeclarationLine },
    hsCode: {
      ...tx.hsCode,
      findUnique: overrides.hsFindUnique ?? vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.hsCode.update,
      count: vi.fn().mockResolvedValue(0),
    },
    letterOfCredit: {
      ...tx.letterOfCredit,
      findFirst: overrides.lcFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.letterOfCredit.update,
      count: vi.fn().mockResolvedValue(0),
    },
    lcEvent: { ...tx.lcEvent },
    taxRefund: {
      ...tx.taxRefund,
      findFirst: overrides.trFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.taxRefund.update,
      count: vi.fn().mockResolvedValue(0),
      aggregate: overrides.trAggregate ?? vi.fn().mockResolvedValue({ _sum: { refundAmount: null } }),
    },
    tradeDocument: {
      ...tx.tradeDocument,
      findFirst: overrides.docFindFirst ?? vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: tx.tradeDocument.update,
      count: vi.fn().mockResolvedValue(0),
    },
  };

  return prisma as any;
}

describe('CustomsService', () => {
  let prisma: any;

  beforeEach(() => {
    prisma = makePrisma();
    publishSpy.mockClear();
  });

  // ══════════════════════════════════════════════════════════════
  // CustomsDeclaration（报关单）
  // ══════════════════════════════════════════════════════════════
  describe('CustomsDeclaration', () => {
    it('creates a declaration', async () => {
      // createDeclaration 流程：findFirst(重复检查,null) → tx.create → getDeclaration(findFirst,返回创建的记录)
      prisma.customsDeclaration.findFirst
        .mockResolvedValueOnce(null) // 重复检查
        .mockResolvedValueOnce({ id: 'cd_1', declarationNumber: 'CD-2026-001', type: 'Export', status: 'Draft', lines: [] });
      const service = createCustomsService(prisma);
      const decl = await service.createDeclaration({
        declarationNumber: 'CD-2026-001',
        type: 'Export',
        shipmentId: 'shp_1',
        totalValue: 50000,
        currency: 'USD',
      }, 'user_1');

      expect(decl.declarationNumber).toBe('CD-2026-001');
      expect(decl.type).toBe('Export');
      expect(decl.status).toBe('Draft');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws on duplicate declaration number', async () => {
      prisma.customsDeclaration.findFirst.mockResolvedValueOnce({ id: 'cd_existing' });
      const service = createCustomsService(prisma);
      await expect(
        service.createDeclaration({ declarationNumber: 'CD-DUP', type: 'Export' }, 'user_1'),
      ).rejects.toThrow('已存在');
    });

    it('throws on invalid customs type', async () => {
      const service = createCustomsService(prisma);
      await expect(
        service.createDeclaration({ declarationNumber: 'CD-X', type: 'Invalid' as any }, 'user_1'),
      ).rejects.toThrow('非法报关类型');
    });

    it('transitions declaration status Draft → Submitted', async () => {
      prisma.customsDeclaration.findFirst.mockResolvedValue({ id: 'cd_1', status: 'Draft', deletedAt: null });
      const service = createCustomsService(prisma);
      const result = await service.transitionDeclarationStatus('cd_1', 'Submitted', 'user_1');
      expect(result.status).toBe('Submitted');
      expect(publishSpy).toHaveBeenCalled();
    });

    it('transitions to Released publishes CustomsCleared event', async () => {
      prisma.customsDeclaration.findFirst.mockResolvedValue({ id: 'cd_1', status: 'Inspecting', declarationNumber: 'CD-001', deletedAt: null });
      const service = createCustomsService(prisma);
      await service.transitionDeclarationStatus('cd_1', 'Released', 'user_1');
      const types = publishSpy.mock.calls.map((c: any) => c[0]?.type);
      expect(types).toContain('CustomsCleared');
    });

    it('rejects illegal transition Released → Submitted', async () => {
      prisma.customsDeclaration.findFirst.mockResolvedValue({ id: 'cd_1', status: 'Released', deletedAt: null });
      const service = createCustomsService(prisma);
      await expect(
        service.transitionDeclarationStatus('cd_1', 'Submitted', 'user_1'),
      ).rejects.toThrow('非法报关单状态转换');
    });

    it('soft-deletes a declaration in Draft status', async () => {
      prisma.customsDeclaration.findFirst.mockResolvedValue({ id: 'cd_1', status: 'Draft', deletedAt: null });
      const service = createCustomsService(prisma);
      const result = await service.deleteDeclaration('cd_1', 'user_1');
      expect(result.deleted).toBe(true);
      expect(prisma.customsDeclaration.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cd_1' },
          data: expect.objectContaining({ deletedAt: expect.any(BigInt) }),
        }),
      );
    });

    it('rejects delete on non-Draft/Cancelled status', async () => {
      prisma.customsDeclaration.findFirst.mockResolvedValue({ id: 'cd_1', status: 'Submitted', deletedAt: null });
      const service = createCustomsService(prisma);
      await expect(
        service.deleteDeclaration('cd_1', 'user_1'),
      ).rejects.toThrow('不可删除');
    });

    it('lists declarations with filters', async () => {
      prisma.customsDeclaration.findMany.mockResolvedValue([{ id: 'cd_1', type: 'Export' }]);
      prisma.customsDeclaration.count.mockResolvedValue(1);
      const service = createCustomsService(prisma);
      const { items, total } = await service.listDeclarations({ type: 'Export', status: 'Draft' });
      expect(items).toHaveLength(1);
      expect(total).toBe(1);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // HsCode（HS 编码库）
  // ══════════════════════════════════════════════════════════════
  describe('HsCode', () => {
    it('creates an HS code', async () => {
      prisma.hsCode.findUnique.mockResolvedValue(null);
      const service = createCustomsService(prisma);
      const code = await service.createHsCode({
        code: '5208.52.00.00',
        description: '染色全棉机织物',
        category: 'Textile',
        exportTaxRebateRate: 13,
      }, 'user_1');

      expect(code.code).toBe('5208.52.00.00');
      expect(code.category).toBe('Textile');
    });

    it('throws on duplicate HS code', async () => {
      prisma.hsCode.findUnique.mockResolvedValue({ id: 'hs_existing', code: '5208.52' });
      const service = createCustomsService(prisma);
      await expect(
        service.createHsCode({ code: '5208.52', description: 'dup', category: 'Textile' }, 'user_1'),
      ).rejects.toThrow('已存在');
    });

    it('throws on invalid category', async () => {
      prisma.hsCode.findUnique.mockResolvedValue(null);
      const service = createCustomsService(prisma);
      await expect(
        service.createHsCode({ code: '5209', description: 'test', category: 'Invalid' as any }, 'user_1'),
      ).rejects.toThrow('非法 HS 编码类别');
    });

    it('updates an HS code', async () => {
      prisma.hsCode.findUnique.mockResolvedValue({ id: 'hs_1', code: '5208.52', deletedAt: null });
      const service = createCustomsService(prisma);
      const updated = await service.updateHsCode('hs_1', { description: 'updated desc' }, 'user_1');
      expect(updated.description).toBe('updated desc');
    });

    it('deactivates an HS code (not physical delete)', async () => {
      prisma.hsCode.findUnique.mockResolvedValue({ id: 'hs_1', code: '5208.52', isActive: true });
      const service = createCustomsService(prisma);
      const result = await service.deleteHsCode('hs_1', 'user_1');
      expect(result.id).toBe('hs_1');
      expect(prisma.hsCode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'hs_1' },
          data: expect.objectContaining({ isActive: false }),
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // LetterOfCredit（信用证）
  // ══════════════════════════════════════════════════════════════
  describe('LetterOfCredit', () => {
    it('creates a letter of credit', async () => {
      // createLetterOfCredit 也调用 getLetterOfCredit(findFirst)
      prisma.letterOfCredit.findFirst
        .mockResolvedValueOnce(null) // 重复检查
        .mockResolvedValueOnce({ id: 'lc_1', lcNumber: 'LC-2026-001', type: 'Irrevocable', status: 'Issued', deletedAt: null });
      const service = createCustomsService(prisma);
      const lc = await service.createLetterOfCredit({
        lcNumber: 'LC-2026-001',
        type: 'Irrevocable',
        amount: 100000,
        currency: 'USD',
        issueBank: 'Bank of China',
        expiryDate: '2026-12-31',
      }, 'user_1');

      expect(lc.lcNumber).toBe('LC-2026-001');
      expect(lc.type).toBe('Irrevocable');
      expect(lc.status).toBe('Issued');
    });

    it('throws on invalid LC type', async () => {
      const service = createCustomsService(prisma);
      await expect(
        service.createLetterOfCredit({ lcNumber: 'LC-X', type: 'Invalid' as any, amount: 1000 }, 'user_1'),
      ).rejects.toThrow('非法信用证类型');
    });

    it('transitions LC status Issued → Presented → Accepted → Settled', async () => {
      const service = createCustomsService(prisma);
      prisma.letterOfCredit.findFirst.mockResolvedValueOnce({ id: 'lc_1', status: 'Issued', deletedAt: null });
      let result = await service.transitionLcStatus('lc_1', 'Presented', 'user_1');
      expect(result.status).toBe('Presented');
      prisma.letterOfCredit.findFirst.mockResolvedValueOnce({ id: 'lc_1', status: 'Presented', deletedAt: null });
      result = await service.transitionLcStatus('lc_1', 'Accepted', 'user_1');
      expect(result.status).toBe('Accepted');
      prisma.letterOfCredit.findFirst.mockResolvedValueOnce({ id: 'lc_1', status: 'Accepted', deletedAt: null });
      result = await service.transitionLcStatus('lc_1', 'Settled', 'user_1');
      expect(result.status).toBe('Settled');
    });

    it('rejects illegal LC transition Settled → Issued', async () => {
      prisma.letterOfCredit.findFirst.mockResolvedValue({ id: 'lc_1', status: 'Settled', deletedAt: null });
      const service = createCustomsService(prisma);
      await expect(
        service.transitionLcStatus('lc_1', 'Issued', 'user_1'),
      ).rejects.toThrow('非法信用证状态转换');
    });

    // ── F1：LcEvent 节点跟踪 + 事件发布 ──

    it('appends first LcEvent (null → Issued) on create', async () => {
      prisma.letterOfCredit.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'lc_1', lcNumber: 'LC-2026-002', type: 'Irrevocable', status: 'Issued', deletedAt: null });
      const service = createCustomsService(prisma);
      await service.createLetterOfCredit({
        lcNumber: 'LC-2026-002', type: 'Irrevocable', amount: 5000, issueDate: '2026-08-01',
      }, 'user_1');
      expect(prisma.lcEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fromNode: null, toNode: 'Issued', eventDate: '2026-08-01', actorId: 'user_1' }),
        }),
      );
    });

    it('appends LcEvent with from/to nodes and publishes LcStatusChanged on transition', async () => {
      prisma.letterOfCredit.findFirst.mockResolvedValueOnce({ id: 'lc_1', lcNumber: 'LC-1', status: 'Issued', deletedAt: null });
      const service = createCustomsService(prisma);
      await service.transitionLcStatus('lc_1', 'Presented', 'user_1');
      expect(prisma.lcEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lcId: 'lc_1', fromNode: 'Issued', toNode: 'Presented', note: null }),
        }),
      );
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'LcStatusChanged',
          sourceEntityType: 'LetterOfCredit',
          sourceEntityId: 'lc_1',
          payload: expect.objectContaining({ from: 'Issued', to: 'Presented' }),
        }),
      );
    });

    it('records discrepancies into LcEvent note when transitioning to Discrepant', async () => {
      prisma.letterOfCredit.findFirst.mockResolvedValueOnce({ id: 'lc_1', lcNumber: 'LC-1', status: 'Presented', deletedAt: null });
      const service = createCustomsService(prisma);
      await service.transitionLcStatus('lc_1', 'Discrepant', 'user_1', '单证不符：提单日期晚于装运期');
      expect(prisma.lcEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ toNode: 'Discrepant', note: '单证不符：提单日期晚于装运期' }),
        }),
      );
    });

    it('listLcEvents returns events ordered and throws for missing LC', async () => {
      const service = createCustomsService(prisma);
      prisma.letterOfCredit.findFirst.mockResolvedValueOnce(null);
      await expect(service.listLcEvents('lc_x')).rejects.toThrow('不存在');
      prisma.letterOfCredit.findFirst.mockResolvedValueOnce({ id: 'lc_1' });
      prisma.lcEvent.findMany.mockResolvedValueOnce([
        { id: 'e1', lcId: 'lc_1', fromNode: null, toNode: 'Issued', eventDate: '2026-08-01' },
      ]);
      const result = await service.listLcEvents('lc_1');
      expect(result.total).toBe(1);
      expect(result.items[0].toNode).toBe('Issued');
      expect(prisma.lcEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { lcId: 'lc_1' },
          orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // TaxRefund（出口退税）
  // ══════════════════════════════════════════════════════════════
  describe('TaxRefund', () => {
    it('auto-calculates refundAmount from exportAmountCny × refundableRate(%) / 100', async () => {
      prisma.taxRefund.findFirst
        .mockResolvedValueOnce(null) // 重复检查
        .mockResolvedValueOnce({ id: 'tr_1', refundNumber: 'TR-2026-001', refundAmount: 13000, status: 'Draft', deletedAt: null });
      const service = createCustomsService(prisma);
      const tr = await service.createTaxRefund({
        refundNumber: 'TR-2026-001',
        exportAmountCny: 100000,
        refundableRate: 13,
      }, 'user_1');

      // 100000 × 13% = 13000（百分数口径，须 /100）
      expect(Number(tr.refundAmount)).toBe(13000);
    });

    it('uses provided refundAmount when explicitly set', async () => {
      prisma.taxRefund.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'tr_2', refundNumber: 'TR-2026-002', refundAmount: 9999, status: 'Draft', deletedAt: null });
      const service = createCustomsService(prisma);
      const tr = await service.createTaxRefund({
        refundNumber: 'TR-2026-002',
        exportAmountCny: 100000,
        refundableRate: 13,
        refundAmount: 9999,
      }, 'user_1');

      expect(Number(tr.refundAmount)).toBe(9999);
    });

    it('transitions tax refund Draft → Submitted → Reviewing → Approved → Refunded', async () => {
      const service = createCustomsService(prisma);
      prisma.taxRefund.findFirst.mockResolvedValueOnce({ id: 'tr_1', status: 'Draft', deletedAt: null });
      let result = await service.transitionTaxRefundStatus('tr_1', 'Submitted', 'user_1');
      expect(result.status).toBe('Submitted');
      prisma.taxRefund.findFirst.mockResolvedValueOnce({ id: 'tr_1', status: 'Submitted', deletedAt: null });
      result = await service.transitionTaxRefundStatus('tr_1', 'Reviewing', 'user_1');
      expect(result.status).toBe('Reviewing');
      prisma.taxRefund.findFirst.mockResolvedValueOnce({ id: 'tr_1', status: 'Reviewing', deletedAt: null });
      result = await service.transitionTaxRefundStatus('tr_1', 'Approved', 'user_1');
      expect(result.status).toBe('Approved');
      // Approved → Refunded publishes TaxRefundCompleted event
      prisma.taxRefund.findFirst.mockResolvedValueOnce({ id: 'tr_1', status: 'Approved', refundNumber: 'TR-001', deletedAt: null });
      result = await service.transitionTaxRefundStatus('tr_1', 'Refunded', 'user_1');
      expect(result.status).toBe('Refunded');
      const types = publishSpy.mock.calls.map((c: any) => c[0]?.type);
      expect(types).toContain('TaxRefundCompleted');
    });

    it('rejects illegal tax refund transition Refunded → Draft', async () => {
      prisma.taxRefund.findFirst.mockResolvedValue({ id: 'tr_1', status: 'Refunded', deletedAt: null });
      const service = createCustomsService(prisma);
      await expect(
        service.transitionTaxRefundStatus('tr_1', 'Draft', 'user_1'),
      ).rejects.toThrow('非法退税状态转换');
    });

    it('reviews tax refund (approve)', async () => {
      prisma.taxRefund.findFirst.mockResolvedValue({ id: 'tr_1', status: 'Reviewing', refundNumber: 'TR-001', deletedAt: null });
      const service = createCustomsService(prisma);
      const result = await service.reviewTaxRefund('tr_1', { decision: 'Approved', reviewedBy: 'admin_1' }, 'admin_1');
      expect(result.status).toBe('Approved');
    });

    it('reviews tax refund (reject)', async () => {
      prisma.taxRefund.findFirst.mockResolvedValue({ id: 'tr_1', status: 'Reviewing', refundNumber: 'TR-001', deletedAt: null });
      const service = createCustomsService(prisma);
      const result = await service.reviewTaxRefund('tr_1', { decision: 'Rejected', reviewedBy: 'admin_1' }, 'admin_1');
      expect(result.status).toBe('Rejected');
    });

    // G3：审核留痕取真实登录人（actorId 来自路由层认证身份），请求体 reviewedBy 不再受信
    it('takes reviewedBy from the authenticated actor, not the request body', async () => {
      prisma.taxRefund.findFirst.mockResolvedValue({ id: 'tr_1', status: 'Reviewing', refundNumber: 'TR-001', deletedAt: null });
      const service = createCustomsService(prisma);
      const result = await service.reviewTaxRefund('tr_1', { decision: 'Approved', reviewedBy: '当前用户' }, 'real_login_user_42');
      expect(result.status).toBe('Approved');
      expect(result.reviewedBy).toBe('real_login_user_42');
    });

    it('records reviewedBy in audit trail detail as the authenticated actor', async () => {
      prisma.taxRefund.findFirst.mockResolvedValue({ id: 'tr_1', status: 'Reviewing', refundNumber: 'TR-001', deletedAt: null });
      const service = createCustomsService(prisma);
      await service.reviewTaxRefund('tr_1', { decision: 'Approved' }, 'real_login_user_42');
      const auditCreate = (prisma.auditLog.create as any);
      const reviewCall = auditCreate.mock.calls.find((c: any) => c[0]?.data?.action === 'TAX_REFUND_REVIEW');
      expect(reviewCall).toBeTruthy();
      expect(reviewCall[0].data.detail.reviewedBy).toBe('real_login_user_42');
    });

    it('falls back to body reviewedBy only when actor is missing', async () => {
      prisma.taxRefund.findFirst.mockResolvedValue({ id: 'tr_1', status: 'Reviewing', refundNumber: 'TR-001', deletedAt: null });
      const service = createCustomsService(prisma);
      const result = await service.reviewTaxRefund('tr_1', { decision: 'Approved', reviewedBy: 'fallback_user' }, '');
      expect(result.reviewedBy).toBe('fallback_user');
    });
  });

  // ══════════════════════════════════════════════════════════════
  // TradeDocument（贸易单据）
  // ══════════════════════════════════════════════════════════════
  describe('TradeDocument', () => {
    it('creates a trade document', async () => {
      const native = createCiStorage();
      const sourceOptions = await currentCiOptions(native);
      const service = createCustomsService(native.db);
      const doc = await service.createTradeDocument({ type: 'CommercialInvoice', shipmentId: 'shp_1' }, ciActor.userId, sourceOptions);

      expect(doc.documentNumber).toBe(native.tables.invoice[0].invoiceNumber);
      expect(doc.sourceInvoiceId).toBe(native.tables.invoice[0].id);
      expect(native.tables.documentVersion[0].content.ciSourceSnapshot.invoice.id).toBe(native.tables.invoice[0].id);
      expect(native.tables.auditLog.map(row => row.action).sort()).toEqual(['DOCUMENT_VERSION_CREATE', 'TRADE_DOCUMENT_CREATE']);
      expect(doc.type).toBe('CommercialInvoice');
      expect(doc.status).toBe('Draft');
    });

    it('throws on invalid document type', async () => {
      const service = createCustomsService(prisma);
      await expect(
        service.createTradeDocument({ documentNumber: 'TD-X', type: 'Invalid' as any }, 'user_1'),
      ).rejects.toThrow('非法单据类型');
    });

    it('transitions document status Draft → Issued → Submitted → Accepted', async () => {
      const service = createCustomsService(prisma);
      prisma.tradeDocument.findFirst.mockResolvedValueOnce({ id: 'td_1', status: 'Draft', deletedAt: null });
      let result = await service.transitionTradeDocumentStatus('td_1', 'Issued', 'user_1');
      expect(result.status).toBe('Issued');
      prisma.tradeDocument.findFirst.mockResolvedValueOnce({ id: 'td_1', status: 'Issued', deletedAt: null });
      result = await service.transitionTradeDocumentStatus('td_1', 'Submitted', 'user_1');
      expect(result.status).toBe('Submitted');
      prisma.tradeDocument.findFirst.mockResolvedValueOnce({ id: 'td_1', status: 'Submitted', deletedAt: null });
      result = await service.transitionTradeDocumentStatus('td_1', 'Accepted', 'user_1');
      expect(result.status).toBe('Accepted');
    });

    it('rejects illegal document transition Accepted → Draft', async () => {
      prisma.tradeDocument.findFirst.mockResolvedValue({ id: 'td_1', status: 'Accepted', deletedAt: null });
      const service = createCustomsService(prisma);
      await expect(
        service.transitionTradeDocumentStatus('td_1', 'Draft', 'user_1'),
      ).rejects.toThrow('非法单据状态转换');
    });

    it('soft-deletes a trade document in Draft status', async () => {
      prisma.tradeDocument.findFirst.mockResolvedValue({ id: 'td_1', status: 'Draft', deletedAt: null });
      const service = createCustomsService(prisma);
      const result = await service.deleteTradeDocument('td_1', 'user_1');
      expect(result.deleted).toBe(true);
    });

    // ── B2/B4 域单据：手动入口守卫 + 域状态机 + domain 过滤 ──

    it('手动创建域类型（PurchaseOrder）→ fail-closed 拒绝（域单据由业务模块带 sourceRef 生成）', async () => {
      const service = createCustomsService(prisma);
      await expect(
        service.createTradeDocument({ documentNumber: 'PO-1', type: 'PurchaseOrder' as any }, 'user_1'),
      ).rejects.toMatchObject({ code: 'NATIVE_SUPPLIER_DOCUMENT_REQUIRED', statusCode: 409 });
    });

    it('qc 域状态机：Draft→Issued 合法；Draft→Submitted 拒绝（简化文档生命周期无交单流转）', async () => {
      const service = createCustomsService(prisma);
      prisma.tradeDocument.findFirst.mockResolvedValueOnce({ id: 'td_qc', status: 'Draft', domain: 'qc', deletedAt: null });
      const r = await service.transitionTradeDocumentStatus('td_qc', 'Issued', 'user_1');
      expect(r.status).toBe('Issued');

      prisma.tradeDocument.findFirst.mockResolvedValueOnce({ id: 'td_qc', status: 'Draft', domain: 'qc', deletedAt: null });
      await expect(service.transitionTradeDocumentStatus('td_qc', 'Submitted', 'user_1')).rejects.toThrow('非法单据状态转换');
    });

    it('未知域状态机查询 → fail-closed；customs 域保持交单状态机', async () => {
      const service = createCustomsService(prisma);
      // 未知 domain 的状态转换 → 拒绝
      prisma.tradeDocument.findFirst.mockResolvedValueOnce({ id: 'td_x', status: 'Draft', domain: 'unknown', deletedAt: null });
      await expect(service.transitionTradeDocumentStatus('td_x', 'Issued', 'user_1')).rejects.toThrow('非法单据业务域');
      // customs 域：Issued→Submitted 合法（交单状态机）
      prisma.tradeDocument.findFirst.mockResolvedValueOnce({ id: 'td_c', status: 'Issued', domain: 'customs', deletedAt: null });
      const r = await service.transitionTradeDocumentStatus('td_c', 'Submitted', 'user_1');
      expect(r.status).toBe('Submitted');
    });

    it('listTradeDocuments 按 domain 过滤（B4 域视图：where.domain 透传）', async () => {
      const service = createCustomsService(prisma);
      prisma.tradeDocument.findMany.mockResolvedValueOnce([{ id: 'td_1', domain: 'qc' }]);
      prisma.tradeDocument.count.mockResolvedValueOnce(1);
      const result = await service.listTradeDocuments({ domain: 'qc' });
      expect(result.total).toBe(1);
      expect(prisma.tradeDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ domain: 'qc' }) }),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════
  // Overview（总览）
  // ══════════════════════════════════════════════════════════════
  describe('getCustomsOverview', () => {
    it('returns overview counts', async () => {
      prisma.customsDeclaration.count = vi.fn().mockResolvedValue(10);
      prisma.letterOfCredit.count = vi.fn().mockResolvedValue(5);
      prisma.taxRefund.count = vi.fn().mockResolvedValue(3);
      prisma.tradeDocument.count = vi.fn().mockResolvedValue(20);
      prisma.taxRefund.aggregate = vi.fn().mockResolvedValue({ _sum: { refundAmount: 39000 } });
      const service = createCustomsService(prisma);
      const overview = await service.getCustomsOverview();
      expect(overview.declarations.total).toBe(10);
      expect(overview.lettersOfCredit).toBeDefined();
      expect(overview.taxRefunds).toBeDefined();
      expect(overview.tradeDocuments.total).toBe(20);
      expect(overview.taxRefunds.totalRefundedAmount).toBe(39000);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // 事务隔离
  // ══════════════════════════════════════════════════════════════
  describe('transaction isolation', () => {
    it('propagates transaction failure on create declaration', async () => {
      prisma = makePrisma({ transactionFail: true });
      prisma.customsDeclaration.findFirst.mockResolvedValueOnce(null);
      const service = createCustomsService(prisma);
      await expect(
        service.createDeclaration({ declarationNumber: 'CD-FAIL', type: 'Export' }, 'user_1'),
      ).rejects.toThrow('TX_BOOM');
    });
  });
});
