import { describe, expect, it, vi } from 'vitest';
import { createQuotationImportService, HistoricalQuotationRow } from '../quotationImportService';

/**
 * 阶段 P3c — 历史报价导入服务测试（PRD 16.1 / 16.2）
 *
 * 覆盖：
 *   - preview 两阶段契约：只校验不写库，错误明细到行/字段
 *   - 字段校验：报价号 / 客户匹配 / 日期格式 / 金额非负 / 状态封闭集
 *   - 幂等：DB 已存在报价号 + 同批重复报价号 → skipped
 *   - commit：合法行落库（字段映射）、P2002 归 skipped、汇总审计
 *   - 边界：空数组 / 非数组 / 超 MAX_ROWS
 */

function makePrisma(opts: {
  relations?: Array<{ id: string; name: string }>;
  existingNumbers?: string[];
  createImpl?: (args: any) => Promise<any>;
} = {}) {
  const quotationCreate = vi.fn().mockImplementation(
    opts.createImpl ?? (async ({ data }: any) => ({ id: 'QT_mock', ...data })),
  );
  const auditCreate = vi.fn().mockResolvedValue({});
  const prisma = {
    relation: { findMany: vi.fn().mockResolvedValue(opts.relations ?? []) },
    quotation: {
      findMany: vi.fn().mockResolvedValue((opts.existingNumbers ?? []).map(n => ({ quotationNumber: n }))),
      create: quotationCreate,
    },
    auditLog: { create: auditCreate },
  } as any;
  return { prisma, quotationCreate, auditCreate };
}

const RELATIONS = [
  { id: 'REL_A', name: 'Client A' },
  { id: 'REL_B', name: 'Client B' },
];

const VALID_ROW: HistoricalQuotationRow = {
  quotationNumber: 'Q-2025-001',
  customerName: 'Client A',
  amount: 1234.5,
  currency: 'USD',
  issueDate: '2025-01-15',
};

describe('quotationImportService: 边界入参', () => {
  it('非数组 → 抛错', async () => {
    const { prisma } = makePrisma();
    const svc = createQuotationImportService(prisma);
    await expect(svc.importHistoricalQuotations(null as any, 'preview', 'u1')).rejects.toThrow('rows 须为数组');
  });

  it('空数组 → 抛错', async () => {
    const { prisma } = makePrisma();
    const svc = createQuotationImportService(prisma);
    await expect(svc.importHistoricalQuotations([], 'preview', 'u1')).rejects.toThrow('导入数据为空');
  });

  it('超过 2000 行 → 抛错', async () => {
    const { prisma } = makePrisma();
    const svc = createQuotationImportService(prisma);
    const rows = Array.from({ length: 2001 }, (_, i) => ({ ...VALID_ROW, quotationNumber: `Q-${i}` }));
    await expect(svc.importHistoricalQuotations(rows, 'preview', 'u1')).rejects.toThrow('不可超过');
  });
});

describe('quotationImportService: preview 校验', () => {
  it('合法行 + 错误行混合：不写库，错误明细到行/字段', async () => {
    const { prisma, quotationCreate, auditCreate } = makePrisma({ relations: RELATIONS });
    const svc = createQuotationImportService(prisma);
    const rows: HistoricalQuotationRow[] = [
      VALID_ROW, // 合法
      { customerName: 'Client A', issueDate: '2025-01-01' }, // 缺报价号
      { quotationNumber: 'Q-002', customerName: 'Unknown Corp', issueDate: '2025-01-01' }, // 客户不匹配
      { quotationNumber: 'Q-003', customerName: 'Client A' }, // 缺日期
      { quotationNumber: 'Q-004', customerName: 'Client A', issueDate: '2025/01/01' }, // 日期格式错
      { quotationNumber: 'Q-005', customerName: 'Client A', issueDate: '2025-01-01', amount: -5 }, // 负金额
      { quotationNumber: 'Q-006', customerName: 'Client A', issueDate: '2025-01-01', status: 'Weird' }, // 非法状态
    ];
    const r = await svc.importHistoricalQuotations(rows, 'preview', 'u1');
    expect(r.mode).toBe('preview');
    expect(r.total).toBe(7);
    expect(r.valid).toBe(1);
    expect(r.created).toBe(0);
    // 行2: quotationNumber；行3: customerName；行4: issueDate 必填；行5: issueDate 格式；行6: amount；行7: status
    expect(r.errors).toHaveLength(6);
    expect(r.errors.map(e => [e.row, e.field])).toEqual([
      [2, 'quotationNumber'],
      [3, 'customerName'],
      [4, 'issueDate'],
      [5, 'issueDate'],
      [6, 'amount'],
      [7, 'status'],
    ]);
    // preview 不写库
    expect(quotationCreate).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('validUntil 格式非法 → 行错误', async () => {
    const { prisma } = makePrisma({ relations: RELATIONS });
    const svc = createQuotationImportService(prisma);
    const r = await svc.importHistoricalQuotations(
      [{ ...VALID_ROW, validUntil: '2025/12/31' }],
      'preview',
      'u1',
    );
    expect(r.valid).toBe(0);
    expect(r.errors[0]).toMatchObject({ row: 1, field: 'validUntil' });
  });
});

describe('quotationImportService: 幂等', () => {
  it('DB 已存在报价号（含软删占位）→ skipped，不算错误', async () => {
    const { prisma, quotationCreate } = makePrisma({ relations: RELATIONS, existingNumbers: ['Q-2025-001'] });
    const svc = createQuotationImportService(prisma);
    const r = await svc.importHistoricalQuotations([VALID_ROW], 'commit', 'u1');
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(0);
    expect(r.errors).toHaveLength(0);
    expect(quotationCreate).not.toHaveBeenCalled();
  });

  it('同批重复报价号 → 取首行，后续 skipped', async () => {
    const { prisma, quotationCreate } = makePrisma({ relations: RELATIONS });
    const svc = createQuotationImportService(prisma);
    const dup = { ...VALID_ROW, amount: 9999 };
    const r = await svc.importHistoricalQuotations([VALID_ROW, dup], 'commit', 'u1');
    expect(r.skipped).toBe(1);
    expect(r.created).toBe(1);
    expect(quotationCreate).toHaveBeenCalledTimes(1);
    // 落库的是首行金额
    expect(Number(quotationCreate.mock.calls[0][0].data.totalAmount)).toBe(1234.5);
  });
});

describe('quotationImportService: commit 落库', () => {
  it('合法行字段映射正确 + 汇总审计', async () => {
    const { prisma, quotationCreate, auditCreate } = makePrisma({ relations: RELATIONS });
    const svc = createQuotationImportService(prisma);
    const r = await svc.importHistoricalQuotations(
      [
        VALID_ROW,
        { quotationNumber: 'Q-2025-002', customerName: 'Client B', issueDate: '2025-02-01' }, // 缺省值路径
      ],
      'commit',
      'u1',
    );
    expect(r.created).toBe(2);
    expect(r.valid).toBe(2);

    const d1 = quotationCreate.mock.calls[0][0].data;
    expect(d1.quotationNumber).toBe('Q-2025-001');
    expect(d1.customerRelationId).toBe('REL_A');
    expect(d1.customerName).toBe('Client A');
    expect(Number(d1.totalAmount)).toBe(1234.5);
    expect(d1.currency).toBe('USD');
    expect(d1.status).toBe('Sent'); // 历史数据缺省 Sent
    expect(d1.baseCurrency).toBe('CNY');
    expect(typeof d1.id).toBe('string');

    const d2 = quotationCreate.mock.calls[1][0].data;
    expect(d2.customerRelationId).toBe('REL_B');
    expect(Number(d2.totalAmount)).toBe(0); // 金额缺省 0
    expect(d2.validUntil).toBeNull();

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit.action).toBe('QUOTATION_IMPORT');
    expect(audit.actorId).toBe('u1');
    expect(audit.detail).toMatchObject({ total: 2, created: 2, skipped: 0, errorCount: 0 });
  });

  it('P2002 并发抢占 → 归 skipped；其他异常 → 行错误，不中断批次', async () => {
    let call = 0;
    const { prisma } = makePrisma({
      relations: RELATIONS,
      createImpl: async () => {
        call++;
        if (call === 1) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        if (call === 2) throw new Error('DB_BOOM');
        return { id: 'QT_ok' };
      },
    });
    const svc = createQuotationImportService(prisma);
    const rows = [1, 2, 3].map(i => ({ ...VALID_ROW, quotationNumber: `Q-${i}` }));
    const r = await svc.importHistoricalQuotations(rows, 'commit', 'u1');
    expect(r.skipped).toBe(1); // P2002
    expect(r.created).toBe(1); // 第三行成功
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 2, field: '_row' });
  });
});
