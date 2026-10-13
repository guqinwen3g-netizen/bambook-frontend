/**
 * REQ2-04 第三方测试管理回归测试（设计文档 §7 验收场景）
 *
 * 覆盖：
 *   1. 登记校验（orderId 必填/订单存在性/testItems 枚举非空/agency 枚举/日期格式）
 *   2. 订单全景（含附件+整改+summary 聚合——3 击数据源）
 *   3. 结论状态机（pending→pass/fail 单向、终态不可回退、终态禁改内容、重复登记拒）
 *   4. fail 门禁（failItems 必填/⊆ testItems/整改必传或已有 open——100% 跟踪闭环锚点）
 *   5. 整改闭环（追加校验 failItem ∈ failItems、仅 fail 单可加、open→closed、二次关闭拒）
 *   6. 附件登记（委托存在性、空文件拒）
 *   7. 软删（仅 pending；终态归档保留）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createTestRequestService } from '../testRequestService';

function makeRequest(overrides: any = {}) {
  return {
    id: 'TR__X1',
    trNo: 'TR-20260820-001',
    orderId: 'PO-1',
    testItems: ['color_fastness', 'shrinkage', 'ph'],
    agency: 'sgs',
    sentDate: '2026-08-18',
    expectedDate: '2026-08-25',
    notes: null,
    result: 'pending',
    reportNo: null,
    reportDate: null,
    failItems: [] as string[],
    createdAt: BigInt(1),
    updatedAt: BigInt(1),
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma(overrides: { requests?: any[]; orderExists?: boolean } = {}) {
  const requests = overrides.requests ?? [];
  const prisma: any = {
    order: {
      findFirst: vi.fn().mockImplementation(async (args: any) =>
        overrides.orderExists === false ? null : { id: args?.where?.id, deletedAt: null }),
    },
    testRequest: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...makeRequest(), ...data })),
      findFirst: vi.fn().mockImplementation(async (args: any) =>
        requests.find(r => r.id === args?.where?.id && (r.deletedAt === null || args?.where?.deletedAt === undefined)) ?? null),
      findMany: vi.fn().mockImplementation(async (args: any) => {
        // listTestRequests where: { orderId, deletedAt: null }
        return requests.filter(r => r.orderId === args?.where?.orderId && r.deletedAt === null);
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const target = requests.find(r => r.id === where.id);
        if (target) Object.assign(target, data);
        return { ...(target ?? makeRequest()), ...data };
      }),
    },
    testReportFile: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...data })),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    testCorrectiveAction: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'TCA__X1', status: 'open', ...data })),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) =>
        (overrides as any).actions?.find((a: any) => a.id === where.id) ?? null),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => ({ id: where.id, status: 'open', ...data })),
    },
  };
  return prisma;
}

/** 构造带 include 的 findFirst 返回（listTestRequests include files/actions 由 findMany 直接返回数组） */
function withChildren(requests: any[], files: any[] = [], actions: any[] = []) {
  return requests.map(r => ({ ...r, files: files.filter(f => f.testRequestId === r.id), correctiveActions: actions.filter(a => a.testRequestId === r.id) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createTestRequest 登记校验', () => {
  it('登记成功：枚举项目 + 机构 + 日期，trNo 按日序生成', async () => {
    const prisma = makePrisma();
    const svc = createTestRequestService(prisma as any);
    const r = await svc.createTestRequest({
      orderId: 'PO-1', testItems: ['color_fastness', 'ph'], agency: 'sgs',
      sentDate: '2026-08-18', expectedDate: '2026-08-25', notes: '客户要求加急',
    });
    expect(r.ok).toBe(true);
    expect(prisma.testRequest.create).toHaveBeenCalledOnce();
    const created = (r as any).data.request;
    expect(created.trNo).toMatch(/^TR-\d{8}-001$/);
    expect(created.result).toBe('pending');
  });

  it('orderId 缺失 → 400 ORDER_REQUIRED', async () => {
    const svc = createTestRequestService(makePrisma() as any);
    const r = await svc.createTestRequest({ orderId: '', testItems: ['ph'], agency: 'sgs' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('ORDER_REQUIRED');
  });

  it('订单不存在 → 404 ORDER_NOT_FOUND（fail-closed）', async () => {
    const svc = createTestRequestService(makePrisma({ orderExists: false }) as any);
    const r = await svc.createTestRequest({ orderId: 'PO-X', testItems: ['ph'], agency: 'sgs' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('ORDER_NOT_FOUND');
    expect((r as any).error.status).toBe(404);
  });

  it('testItems 空/非数组 → 400；非法枚举项 → 400', async () => {
    const svc = createTestRequestService(makePrisma() as any);
    expect(((await svc.createTestRequest({ orderId: 'PO-1', testItems: [], agency: 'sgs' })) as any).error.code).toBe('TEST_ITEMS_REQUIRED');
    expect(((await svc.createTestRequest({ orderId: 'PO-1', testItems: 'ph' as any, agency: 'sgs' })) as any).error.code).toBe('TEST_ITEMS_REQUIRED');
    expect(((await svc.createTestRequest({ orderId: 'PO-1', testItems: ['不是指标'], agency: 'sgs' })) as any).error.code).toBe('INVALID_TEST_ITEM');
  });

  it('agency 非法 / 日期格式非法 → 400', async () => {
    const svc = createTestRequestService(makePrisma() as any);
    expect(((await svc.createTestRequest({ orderId: 'PO-1', testItems: ['ph'], agency: 'tuv' })) as any).error.code).toBe('INVALID_AGENCY');
    expect(((await svc.createTestRequest({ orderId: 'PO-1', testItems: ['ph'], agency: 'sgs', sentDate: '2026/08/18' })) as any).error.code).toBe('INVALID_DATE');
  });
});

describe('listTestRequests 订单全景（3 击数据源）', () => {
  it('聚合 items + summary（pass/fail/pending/openCorrectiveActions）', async () => {
    const children = withChildren(
      [
        makeRequest({ id: 'TR__1', result: 'pass' }),
        makeRequest({ id: 'TR__2', result: 'fail', failItems: ['ph'] }),
        makeRequest({ id: 'TR__3', result: 'pending' }),
      ],
      [],
      [{ id: 'TCA__1', testRequestId: 'TR__2', status: 'open' }],
    );
    const prisma = makePrisma();
    prisma.testRequest.findMany.mockResolvedValue(children);
    const svc = createTestRequestService(prisma as any);
    const r = await svc.listTestRequests('PO-1');
    expect(r.ok).toBe(true);
    const summary = (r as any).data.summary;
    expect(summary).toEqual({ total: 3, pass: 1, fail: 1, pending: 1, openCorrectiveActions: 1 });
  });

  it('orderId 缺失 → 400', async () => {
    const svc = createTestRequestService(makePrisma() as any);
    expect(((await svc.listTestRequests('')) as any).error.code).toBe('ORDER_REQUIRED');
  });
});

describe('updateTestRequest 结论状态机 + fail 门禁', () => {
  it('pending → pass：清空 failItems', async () => {
    const prisma = makePrisma({ requests: [makeRequest()] });
    const svc = createTestRequestService(prisma as any);
    const r = await svc.updateTestRequest('TR__X1', { result: 'pass', reportNo: 'SGS-RPT-001', reportDate: '2026-08-22' });
    expect(r.ok).toBe(true);
    const updated = (r as any).data.request;
    expect(updated.result).toBe('pass');
    expect(updated.failItems).toEqual([]);
  });

  it('fail 无 failItems → 400 FAIL_ITEMS_REQUIRED（100% 跟踪闭环门禁）', async () => {
    const svc = createTestRequestService(makePrisma({ requests: [makeRequest()] }) as any);
    const r = await svc.updateTestRequest('TR__X1', { result: 'fail' });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('FAIL_ITEMS_REQUIRED');
  });

  it('failItems 含非委托项目 → 400 INVALID_FAIL_ITEM', async () => {
    const svc = createTestRequestService(makePrisma({ requests: [makeRequest()] }) as any);
    const r = await svc.updateTestRequest('TR__X1', { result: 'fail', failItems: ['azo'] });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('INVALID_FAIL_ITEM');
  });

  it('fail 无整改（传入且无既有 open）→ 400 CA_REQUIRED', async () => {
    const svc = createTestRequestService(makePrisma({ requests: [makeRequest()] }) as any);
    const r = await svc.updateTestRequest('TR__X1', { result: 'fail', failItems: ['ph'] });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('CA_REQUIRED');
  });

  it('fail 同步整改 → 落库 open 整改（验收锚点：失败项 100% 有跟踪记录）', async () => {
    const prisma = makePrisma({ requests: [makeRequest()] });
    const svc = createTestRequestService(prisma as any);
    const r = await svc.updateTestRequest('TR__X1', {
      result: 'fail',
      failItems: ['ph', 'color_fastness'],
      correctiveAction: { failItem: 'ph', action: '面料返工修整 pH 值后送 SGS 复测', owner: '跟单小王', dueDate: '2026-09-01' },
    });
    expect(r.ok).toBe(true);
    expect((r as any).data.request.result).toBe('fail');
    expect(prisma.testCorrectiveAction.create).toHaveBeenCalledOnce();
    const ca = prisma.testCorrectiveAction.create.mock.calls[0][0].data;
    expect(ca.failItem).toBe('ph');
    expect(ca.status).toBe('open');
  });

  it('fail 已有 open 整改（不传 correctiveAction）→ 放行', async () => {
    const prisma = makePrisma({ requests: [makeRequest()] });
    prisma.testCorrectiveAction.count.mockResolvedValue(1);
    const svc = createTestRequestService(prisma as any);
    const r = await svc.updateTestRequest('TR__X1', { result: 'fail', failItems: ['ph'] });
    expect(r.ok).toBe(true);
  });

  it('整改挂载项不在 failItems 内 → 400 INVALID_CA_FAIL_ITEM', async () => {
    const svc = createTestRequestService(makePrisma({ requests: [makeRequest()] }) as any);
    const r = await svc.updateTestRequest('TR__X1', {
      result: 'fail', failItems: ['ph'],
      correctiveAction: { failItem: 'shrinkage', action: '返工' },
    });
    expect(r.ok).toBe(false);
    expect((r as any).error.code).toBe('INVALID_CA_FAIL_ITEM');
  });

  it('终态回退（fail→pass / pass→fail）→ 409 RESULT_FINAL', async () => {
    const svc = createTestRequestService(makePrisma({ requests: [
      makeRequest({ id: 'TR__F', result: 'fail', failItems: ['ph'] }),
      makeRequest({ id: 'TR__P', result: 'pass' }),
    ] }) as any);
    expect(((await svc.updateTestRequest('TR__F', { result: 'pass' })) as any).error.code).toBe('RESULT_FINAL');
    expect(((await svc.updateTestRequest('TR__P', { result: 'fail', failItems: ['ph'] })) as any).error.code).toBe('RESULT_FINAL');
  });

  it('终态后修改委托内容 → 409；重复结论登记 → 400', async () => {
    const svc = createTestRequestService(makePrisma({ requests: [makeRequest({ result: 'pass' })] }) as any);
    expect(((await svc.updateTestRequest('TR__X1', { sentDate: '2026-08-19' })) as any).error.code).toBe('RESULT_FINAL');
    expect(((await svc.updateTestRequest('TR__X1', { result: 'pass' })) as any).error.code).toBe('RESULT_UNCHANGED');
  });

  it('pending 态可修正送样日/备注；终态可补登报告号', async () => {
    const prisma = makePrisma({ requests: [makeRequest()] });
    const svc = createTestRequestService(prisma as any);
    const r = await svc.updateTestRequest('TR__X1', { sentDate: '2026-08-19', notes: '改期送样' });
    expect(r.ok).toBe(true);
    expect((r as any).data.request.sentDate).toBe('2026-08-19');
  });

  it('不存在 → 404', async () => {
    const svc = createTestRequestService(makePrisma() as any);
    expect(((await svc.updateTestRequest('TR__NONE', { result: 'pass' })) as any).error.status).toBe(404);
  });
});

describe('correctiveActions 整改闭环', () => {
  it('fail 单追加整改：failItem ∈ failItems 校验通过', async () => {
    const prisma = makePrisma({ requests: [makeRequest({ result: 'fail', failItems: ['ph'] })] });
    const svc = createTestRequestService(prisma as any);
    const r = await svc.addCorrectiveAction('TR__X1', { failItem: 'ph', action: '复测', owner: 'QC 张三' });
    expect(r.ok).toBe(true);
  });

  it('非 fail 单追加 → 409 NOT_FAIL；failItem 不在 failItems → 400', async () => {
    const svc = createTestRequestService(makePrisma({ requests: [makeRequest({ result: 'pending' })] }) as any);
    expect(((await svc.addCorrectiveAction('TR__X1', { failItem: 'ph', action: 'x' })) as any).error.code).toBe('NOT_FAIL');

    const svc2 = createTestRequestService(makePrisma({ requests: [makeRequest({ result: 'fail', failItems: ['ph'] })] }) as any);
    expect(((await svc2.addCorrectiveAction('TR__X1', { failItem: 'azo', action: 'x' })) as any).error.code).toBe('INVALID_CA_FAIL_ITEM');
  });

  it('open → closed 闭环（closedAt + closeNote）；二次关闭 → 409', async () => {
    const prisma = makePrisma();
    (prisma as any).testCorrectiveAction.findUnique.mockResolvedValue({ id: 'TCA__1', status: 'open' });
    const svc = createTestRequestService(prisma as any);
    const r = await svc.closeCorrectiveAction('TCA__1', '复测通过 pH 6.8');
    expect(r.ok).toBe(true);
    const updated = (r as any).data.correctiveAction;
    expect(updated.status).toBe('closed');
    expect(updated.closedAt).toBeDefined();
    expect(updated.closeNote).toBe('复测通过 pH 6.8');

    (prisma as any).testCorrectiveAction.findUnique.mockResolvedValue({ id: 'TCA__1', status: 'closed' });
    expect(((await svc.closeCorrectiveAction('TCA__1')) as any).error.code).toBe('CA_CLOSED');
  });
});

describe('attachFiles 报告归档 + deleteTestRequest 软删', () => {
  it('附件登记成功（D4 挂订单归档锚点：文件行落库）', async () => {
    const prisma = makePrisma({ requests: [makeRequest()] });
    const svc = createTestRequestService(prisma as any);
    const r = await svc.attachFiles('TR__X1', [
      { filePath: 'test-reports/TR__X1/a.pdf', fileName: 'SGS报告.pdf', mimeType: 'application/pdf', fileSize: 1024 },
    ]);
    expect(r.ok).toBe(true);
    expect(prisma.testReportFile.create).toHaveBeenCalledOnce();
  });

  it('空文件 → 400；委托不存在 → 404', async () => {
    const prisma = makePrisma({ requests: [makeRequest()] });
    const svc = createTestRequestService(prisma as any);
    expect(((await svc.attachFiles('TR__X1', [])) as any).error.code).toBe('NO_FILES');
    expect(((await svc.attachFiles('TR__NONE', [{ filePath: 'x', fileName: 'x', mimeType: 'application/pdf', fileSize: 1 }])) as any).error.status).toBe(404);
  });

  it('软删：pending 可删；终态归档保留 → 409', async () => {
    const prisma = makePrisma({ requests: [
      makeRequest({ id: 'TR__PENDING', result: 'pending' }),
      makeRequest({ id: 'TR__PASS', result: 'pass' }),
    ] });
    const svc = createTestRequestService(prisma as any);
    expect((await svc.deleteTestRequest('TR__PENDING')).ok).toBe(true);
    expect(((await svc.deleteTestRequest('TR__PASS')) as any).error.code).toBe('RESULT_FINAL');
  });
});
