/**
 * REQ2-05 面料工序级委外链回归测试（设计文档 §7 验收场景）
 *
 * 覆盖：
 *   1. 创建校验（订单存在/seq 唯一/工序枚举/数量单价/供应商快照/预估金额口径）
 *   2. 订单工序链全景（按 seq 排序 + summary 累计损耗 + byType 分解 + 加工费合计）
 *   3. 状态机（start 仅 planned / 完工拒二次 / done 后计划字段锁定）
 *   4. 完工登记（损耗率自动计算 / 按产出计费金额 DR-047-③ / 产出超投入拒 / 实际单价覆盖）
 *   5. 软删（仅 planned；开工/完工留痕不可删）
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { createProcessChainService } from '../processChainService';

function makeNode(overrides: any = {}) {
  return {
    id: 'OPN__X1',
    orderId: 'PO-1',
    seq: 1,
    processType: 'gray_fabric',
    supplierId: 'REL-MILL-1',
    supplierName: '金华坯布厂',
    inputQty: 10500,
    outputQty: null as number | null,
    unit: 'M',
    unitPrice: 1.2,
    currency: 'CNY',
    amount: 12600,
    status: 'planned',
    completedAt: null,
    notes: null,
    outsourcingOrderId: null,
    createdAt: BigInt(1),
    updatedAt: BigInt(1),
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma(overrides: { nodes?: any[]; orderExists?: boolean; relation?: any; oso?: any } = {}) {
  const nodes = overrides.nodes ?? [];
  return {
    order: {
      findFirst: vi.fn().mockImplementation(async () =>
        overrides.orderExists === false ? null : { id: 'PO-1', deletedAt: null }),
    },
    relation: {
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        if (args?.where?.id === '__NONE__') return null;
        return overrides.relation ?? { id: args?.where?.id, name: '金华示范染厂', deletedAt: null };
      }),
    },
    outsourcingOrder: {
      findFirst: vi.fn().mockImplementation(async (args: any) =>
        args?.where?.id === '__NONE__' ? null : overrides.oso ?? { id: args?.where?.id, deletedAt: null }),
    },
    orderProcessNode: {
      findFirst: vi.fn().mockImplementation(async (args: any) => {
        if (args?.where?.id) return nodes.find(n => n.id === args.where.id && n.deletedAt === null) ?? null;
        // seq 查重
        return nodes.find(n => n.orderId === args?.where?.orderId && n.seq === args?.where?.seq && n.deletedAt === null) ?? null;
      }),
      findMany: vi.fn().mockImplementation(async (args: any) =>
        nodes.filter(n => n.orderId === args?.where?.orderId && n.deletedAt === null)
          .sort((a, b) => a.seq - b.seq)),
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ ...makeNode(), ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const target = nodes.find(n => n.id === where.id);
        if (target) Object.assign(target, data);
        return { ...(target ?? makeNode()), ...data };
      }),
    },
  } as any;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('createNode 创建校验', () => {
  it('创建成功：预估金额 = 投入量 × 单价（未完工 estimate 口径 DR-047-③）', async () => {
    const svc = createProcessChainService(makePrisma());
    const r = await svc.createNode({
      orderId: 'PO-1', seq: 1, processType: 'dyeing',
      supplierId: 'REL-MILL-1', inputQty: 10500, unit: 'M', unitPrice: 3.5,
    });
    expect(r.ok).toBe(true);
    expect((r as any).data.node.amount).toBe(36750);
    expect((r as any).data.node.status).toBe('planned');
  });

  it('订单不存在 → 404；seq 重复 → 409 SEQ_DUP', async () => {
    const svc1 = createProcessChainService(makePrisma({ orderExists: false }));
    expect(((await svc1.createNode({ orderId: 'PO-X', seq: 1, processType: 'dyeing', inputQty: 1, unitPrice: 1 })) as any).error.status).toBe(404);

    const svc2 = createProcessChainService(makePrisma({ nodes: [makeNode({ seq: 1 })] }));
    expect(((await svc2.createNode({ orderId: 'PO-1', seq: 1, processType: 'dyeing', inputQty: 1, unitPrice: 1 })) as any).error.code).toBe('SEQ_DUP');
  });

  it('工序类型/单位枚举 → 400；数量/单价非法 → 400', async () => {
    const svc = createProcessChainService(makePrisma());
    expect(((await svc.createNode({ orderId: 'PO-1', seq: 2, processType: 'sewing', inputQty: 1, unitPrice: 1 })) as any).error.code).toBe('INVALID_PROCESS_TYPE');
    expect(((await svc.createNode({ orderId: 'PO-1', seq: 2, processType: 'dyeing', inputQty: 1, unitPrice: 1, unit: 'PCS' })) as any).error.code).toBe('INVALID_UNIT');
    expect(((await svc.createNode({ orderId: 'PO-1', seq: 2, processType: 'dyeing', inputQty: 0, unitPrice: 1 })) as any).error.code).toBe('INVALID_QTY');
    expect(((await svc.createNode({ orderId: 'PO-1', seq: 2, processType: 'dyeing', inputQty: 1, unitPrice: -1 })) as any).error.code).toBe('INVALID_PRICE');
  });

  it('供应商不存在 → 400 SUPPLIER_NOT_FOUND（fail-closed 快照）', async () => {
    const svc = createProcessChainService(makePrisma());
    expect(((await svc.createNode({ orderId: 'PO-1', seq: 2, processType: 'dyeing', supplierId: '__NONE__', inputQty: 1, unitPrice: 1 })) as any).error.code).toBe('SUPPLIER_NOT_FOUND');
  });
});

describe('completeNode 完工登记（验收锚点）', () => {
  it('产出量 → 损耗率 + 按产出计费金额（10500 投入 10290 产出 → 2% 损耗，金额=产出×单价）', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode({ inputQty: 10500, unitPrice: 3.5, amount: 36750 })] }));
    const r = await svc.completeNode('OPN__X1', { outputQty: 10290 });
    expect(r.ok).toBe(true);
    const { node, lossPct } = (r as any).data;
    expect(lossPct).toBe(2);
    expect(Number(node.outputQty)).toBe(10290);
    expect(Number(node.amount)).toBeCloseTo(10290 * 3.5, 2);
    expect(node.status).toBe('done');
    expect(node.completedAt).toBeDefined();
  });

  it('产出超投入 → 400 OUTPUT_EXCEEDS_INPUT', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode({ inputQty: 100 })] }));
    expect(((await svc.completeNode('OPN__X1', { outputQty: 101 })) as any).error.code).toBe('OUTPUT_EXCEEDS_INPUT');
  });

  it('实际单价覆盖 → 金额按实际单价重算', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode({ inputQty: 1000, unitPrice: 2 })] }));
    const r = await svc.completeNode('OPN__X1', { outputQty: 980, actualUnitPrice: 2.5 });
    expect(Number((r as any).data.node.amount)).toBeCloseTo(980 * 2.5, 2);
  });

  it('二次完工 → 409 NODE_DONE', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode({ status: 'done', outputQty: 500 })] }));
    expect(((await svc.completeNode('OPN__X1', { outputQty: 400 })) as any).error.code).toBe('NODE_DONE');
  });
});

describe('listChain 订单工序链全景（验收锚点）', () => {
  it('按 seq 排序 + summary 累计损耗（首道投入→末道产出）+ byType 分解 + 加工费合计', async () => {
    const nodes = [
      makeNode({ id: 'OPN__1', seq: 1, processType: 'gray_fabric', inputQty: 10500, outputQty: 10400, unitPrice: 1.2, amount: 12480, status: 'done' }),
      makeNode({ id: 'OPN__2', seq: 2, processType: 'dyeing', inputQty: 10400, outputQty: 10200, unitPrice: 3.5, amount: 35700, status: 'done' }),
      makeNode({ id: 'OPN__3', seq: 3, processType: 'finishing', inputQty: 10200, unitPrice: 0.8, amount: 8160, status: 'planned' }), // 未完工预估
    ];
    const svc = createProcessChainService(makePrisma({ nodes }));
    const r = await svc.listChain('PO-1');
    expect(r.ok).toBe(true);
    const { nodes: sorted, summary } = (r as any).data;
    expect(sorted.map((n: any) => n.seq)).toEqual([1, 2, 3]);
    // 累计损耗：(10500 − 10200) / 10500 = 2.857%
    expect(summary.cumulativeLossPct).toBeCloseTo(2.857, 2);
    expect(summary.total).toBe(3);
    expect(summary.done).toBe(2);
    expect(summary.firstInputQty).toBe(10500);
    expect(summary.lastOutputQty).toBe(10200);
    expect(summary.totalAmount).toBeCloseTo(12480 + 35700 + 8160, 2);
    // byType 分解（BOM/利润表消费口径）
    const dyeing = summary.byType.find((x: any) => x.type === 'dyeing');
    expect(dyeing.amount).toBe(35700);
  });

  it('无完工节点 → cumulativeLossPct null（预估态）；orderId 缺失 → 400', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode({ status: 'planned' })] }));
    const r = await svc.listChain('PO-1');
    expect((r as any).data.summary.cumulativeLossPct).toBeNull();
    expect(((await svc.listChain('')) as any).error.code).toBe('ORDER_REQUIRED');
  });
});

describe('状态机 + 软删', () => {
  it('start：planned → in_progress；非 planned → 409', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode()] }));
    expect((await svc.startNode('OPN__X1')).ok).toBe(true);
    const svc2 = createProcessChainService(makePrisma({ nodes: [makeNode({ status: 'done' })] }));
    expect(((await svc2.startNode('OPN__X1')) as any).error.code).toBe('INVALID_TRANSITION');
  });

  it('done 后改计划字段 → 409 NODE_DONE；仅备注可改', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode({ status: 'done', outputQty: 500 })] }));
    expect(((await svc.updateNode('OPN__X1', { inputQty: 999 })) as any).error.code).toBe('NODE_DONE');
    expect((await svc.updateNode('OPN__X1', { notes: '补充说明' })).ok).toBe(true);
  });

  it('未完工改量/价 → 预估金额重算', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode({ inputQty: 1000, unitPrice: 2, amount: 2000 })] }));
    const r = await svc.updateNode('OPN__X1', { inputQty: 1200 });
    expect(Number((r as any).data.node.amount)).toBeCloseTo(1200 * 2, 2);
  });

  it('软删：planned 可删；in_progress/done → 409 NOT_PLANNED（核算留痕）', async () => {
    const svc = createProcessChainService(makePrisma({ nodes: [makeNode()] }));
    expect((await svc.deleteNode('OPN__X1')).ok).toBe(true);
    const svc2 = createProcessChainService(makePrisma({ nodes: [makeNode({ status: 'in_progress' })] }));
    expect(((await svc2.deleteNode('OPN__X1')) as any).error.code).toBe('NOT_PLANNED');
  });
});
