/**
 * §2 G4.4 缺口②：`deleteOrder` 的依赖守卫原先只查**五路**，**不含 `OrderShipmentBatch`（批次计划）**
 * ⇒ 「未触发 ≠ 不存在」那句在这里不是保守措辞，而是**当场可构造**的输入（本文件就是把 §2 那句
 * 「待构造」变成"有反例 + 有守卫"的那一步）。
 *
 * 为什么"批次"算依赖（不是我自己发明的口径，两处仓内事实）：
 *   · 删单路径**不清理批次**：`rg orderShipmentBatch`（非测试）只有创建 / 回写 / 查询，没有任何删除联动
 *     ⇒ 单子软删后批次行仍活着并指向它；
 *   · 这些活批次行是**被消费**的：`events/linkages/L3IssueInvoice.ts:76` 按 `{ orderId, deletedAt: null }` 数批次来决定开票，
 *     `finance/dunningStageService.ts:100/142` 读批次做催款分级
 *     ⇒ 「已删订单的残留批次」会继续进开票和催款的判定，属于 G4.4「删除语义」要防的那类静默错。
 *
 * ★★ 第二半（v2.49 复核 I-3 连带，缺了就是一条把 94% 的单锁死的守卫）：
 *   **不是所有批次都算依赖。** 只读现量（库 `panda_hub_local`）：活单 69 张，其中 **65 张带活批次**
 *   （`shipped` 49 行 / 48 单，`planned` 17 行 / 17 单）。若"有活批次就 409"，等于把删除功能对
 *   **94% 的活单**关掉 —— 而 `planned` 行是订单自己的计划，不是已发生业务事实。
 *   ⇒ 口径拆成两半：**已出运/已取消 ⇒ 拦**（取值集合出处 `prisma/schema.prisma:3235` 注释），
 *     **planned ⇒ 同事务级联软删**（删完 `L3IssueInvoice` / 催款读的都是 `deletedAt: null` ⇒ 孤儿消失）。
 *   ⚠️ `cancelled` 保守算依赖（它也是留痕事实），今天库里活批次只有 planned/shipped 两态 ⇒ 该分支
 *      由用例 3 钉形状，不声称"真库出现过"。
 *
 * ⚠️ 对外可见变更（比第一版窄得多）：只有**带已出运/已取消批次**的单从"可删"变 409 拒删；
 *    带 planned 批次的单仍可删，且批次随单一起软删（以前会留孤儿）。
 */
import { describe, expect, it } from 'vitest';
import { deleteOrder } from '../orderLifecycleService';
import { stripComments } from '../../../scripts/lib/errorDebtScanners.mjs';

const ORDER_ID = 'ORD_G44_1';

/** 守卫查的六路（第六路 = 本批补的 orderShipmentBatch） */
type GuardModel =
  | 'invoice' | 'invoiceOrderAllocation' | 'shipment' | 'shipmentOrderAllocation'
  | 'paymentVoucher' | 'orderShipmentBatch';

interface BatchRow { id: string; status: string; deletedAt: bigint | null }

interface Init {
  /** 批次这一路要按 `status` 分口径 + 要被级联写 ⇒ 必须是多行模型，不能压成一个数字 */
  batches?: BatchRow[];
  counts?: Partial<Record<GuardModel, number>>;
}

/**
 * 会提交 / 会回滚的最小替身（语义与 `deleteOrderDependencyGuardFailClosed.test.ts` 那份同源，
 * 这里只重写批次那一路，因为要多行 + 按 where 过滤 + 级联写）。
 */
function makePrisma(init: Init = {}) {
  const batches = (init.batches ?? []).map((b) => ({ ...b }));
  const counts = init.counts ?? {};
  const committed = {
    order: { id: ORDER_ID, status: 'Pending', deletedAt: null as bigint | null, createdAt: BigInt(0), updatedAt: BigInt(0) },
    audit: [] as any[],
    links: [] as string[],
    batches: batches.map((b) => ({ ...b })),
  };
  let draft = {
    order: { ...committed.order },
    audit: [...committed.audit],
    links: [...committed.links],
    batches: committed.batches.map((b) => ({ ...b })),
  };
  const calls: Array<{ model: GuardModel; where: any }> = [];

  const live = (b: BatchRow) => b.deletedAt === null;
  const tx: any = {
    order: {
      findUnique: async () => draft.order,
      update: async ({ data }: any) => { draft.order = { ...draft.order, ...data }; return { ...draft.order, lines: [] }; },
    },
    entityLink: {
      findMany: async () => [{ id: 'LINK_1', fromType: 'order', fromId: ORDER_ID, status: 'active' }],
      update: async ({ where }: any) => { draft.links.push(String(where.id)); return {}; },
    },
    entityReference: { findMany: async () => [], update: async () => ({}) },
    quotation: { updateMany: async () => ({ count: 0 }) },
    auditLog: { create: async ({ data }: any) => { draft.audit.push(data); return data; } },
    orderShipmentBatch: {
      count: async ({ where }: any = {}) => {
        calls.push({ model: 'orderShipmentBatch', where });
        /**
         * ★ 口径反查（这一句就是"少写一个条件当场红"的那道牙）：
         *   只有 where 同时要求 `deletedAt: null` 且 `status.not === 'planned'` 才按"已发生事实"计数；
         *   任一条件被去掉（例如退化成"有批次就拦"）⇒ 这里返回的数就会变 ⇒ 断言红。
         */
        const onlyLive = where?.deletedAt === null;
        const onlyExecuted = where?.status?.not === 'planned'
          ? batches.filter(live).filter((b) => b.status !== 'planned').length
          : batches.filter(live).length;                     // 漏了状态条件 ⇒ 连 planned 也算依赖
        return onlyLive ? onlyExecuted : batches.length;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = draft.batches.filter((b) => b.deletedAt === null && b.status === where?.status && where?.deletedAt === null);
        hit.forEach((b) => { b.deletedAt = data.deletedAt; b.updatedAt = data.updatedAt; });
        return { count: hit.length };
      },
    },
  };
  for (const m of ['invoice', 'invoiceOrderAllocation', 'shipment', 'shipmentOrderAllocation', 'paymentVoucher'] as GuardModel[]) {
    tx[m] = { count: async ({ where }: any = {}) => { calls.push({ model: m, where }); return (counts[m] ?? 0) as number; } };
  }

  const prisma: any = {
    $transaction: async (fn: any) => {
      const before = {
        order: { ...committed.order }, audit: [...committed.audit], links: [...committed.links],
        batches: committed.batches.map((b) => ({ ...b })),
      };
      draft = {
        order: { ...before.order }, audit: [...before.audit], links: [...before.links],
        batches: before.batches.map((b) => ({ ...b })),
      };
      try {
        const r = await fn(tx);
        committed.order = draft.order; committed.audit = draft.audit; committed.links = draft.links;
        committed.batches = draft.batches.map((b) => ({ ...b }));
        return r;
      } catch (e) {
        committed.order = before.order; committed.audit = before.audit; committed.links = before.links;
        committed.batches = before.batches.map((b) => ({ ...b }));   // ROLLBACK
        throw e;
      }
    },
  };
  return {
    prisma, committed, calls,
    deleteAudit: () => committed.audit.filter((a: any) => a.action === 'delete_order'),
    cascadeAudit: () => committed.audit.filter((a: any) => a.action === 'cascade_delete_shipment_batches'),
    batchCall: () => calls.filter((c) => c.model === 'orderShipmentBatch'),
    liveBatches: () => committed.batches.filter((b) => b.deletedAt === null),
  };
}
const B = (id: string, status: string, deletedAt: bigint | null = null): BatchRow => ({ id, status, deletedAt });

describe('★ G4.4②：批次分两种口径 —— 已出运要拦、planned 要级联（缺一半都是错的守卫）', () => {
  it('① 只挂 1 行**已出运**批次 ⇒ 拒删 HAS_DEPENDENTS，订单未软删、无删除审计', async () => {
    const s = makePrisma({ batches: [B('OSB_1', 'shipped')] });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID, actorId: 'u1' });

    expect(res.ok, '挂着已出运批次的订单被删掉了 ⇒ 它的批次行会指向一个已软删的单').toBe(false);
    expect(res.error?.code).toBe('HAS_DEPENDENTS');
    expect(s.committed.order.deletedAt, '守卫放行后事务已提交（批次成孤儿）').toBeNull();
    expect(s.deleteAudit(), '删除已提交并留了审计 ⇒ 事务没回滚').toEqual([]);
    expect(s.committed.links, '依赖未清却已改了 EntityLink').toEqual([]);
    expect(s.liveBatches().map((b) => b.id), '被拒的删除不许顺手把批次也删了').toEqual(['OSB_1']);
  });

  it('② 只挂 1 行**planned**批次 ⇒ 照常删成功，且批次**同事务**一起软删 + 留级联审计', async () => {
    const s = makePrisma({ batches: [B('OSB_P1', 'planned'), B('OSB_P2', 'planned')] });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID, actorId: 'u1' });

    expect(res.ok, 'planned 批次不是已发生事实 ⇒ 拦下来就是把删除功能锁死（现量 65/69 张活单带批次）').toBe(true);
    expect(typeof s.committed.order.deletedAt).toBe('bigint');
    expect(s.liveBatches(), '订单删了但 planned 批次还活着 ⇒ 就是本条要修的孤儿').toEqual([]);
    expect(s.cascadeAudit().length, '级联软删必须留审计（它是对业务行的写）').toBe(1);
    /** `writeRouteAuditLog` 会把 before/after 压进自己的列名 ⇒ 不断字段名，只断"级联了几行"这件事真进了审计 */
    expect(JSON.stringify(s.cascadeAudit()[0]), '级联审计没带条数').toContain('"cascadedCount":2');
    expect(s.deleteAudit().length).toBe(1);
  });

  it('③ 混合（1 planned + 1 shipped）⇒ 拦，且 planned 也不许被级联写走（回滚要回干净）', async () => {
    const s = makePrisma({ batches: [B('OSB_P', 'planned'), B('OSB_S', 'shipped')] });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('HAS_DEPENDENTS');
    expect(s.liveBatches().map((b) => b.id).sort(), '守卫没过却已改了批次 ⇒ 事务没回滚').toEqual(['OSB_P', 'OSB_S']);
    expect(s.cascadeAudit()).toEqual([]);
  });

  it('★ ④ 第六路必须**真的被查**，且口径是 `{ deletedAt: null, status: { not: planned } }`', async () => {
    const s = makePrisma({ batches: [B('OSB_1', 'shipped')] });
    await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    const bc = s.batchCall();
    expect(bc.length, 'orderShipmentBatch 一次都没被 count ⇒ 守卫根本没有这一路').toBeGreaterThan(0);
    expect(bc[0].where).toMatchObject({ orderId: ORDER_ID, deletedAt: null, status: { not: 'planned' } });
  });

  it('★ ⑤ 阳性对照：批次已软删 ⇒ 既不算依赖也不该被级联写', async () => {
    const s = makePrisma({ batches: [B('OSB_1', 'shipped', BigInt(1))] });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    expect(res.ok, '已软删的批次被当成活依赖 ⇒ 守卫过宽').toBe(true);
    expect(s.cascadeAudit()).toEqual([]);
  });

  it('★ ⑥ 六路全 0 ⇒ 照旧删成功（本批没把守卫变成"什么都不许删"）', async () => {
    const s = makePrisma({});
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    expect(res.ok).toBe(true);
    expect(s.deleteAudit().length).toBe(1);
  });

  it('★ ⑦ 其余五路的旧行为不回退：挂 1 张活发票仍按 HAS_DEPENDENTS 拒删', async () => {
    const s = makePrisma({ counts: { invoice: 1 } });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('HAS_DEPENDENTS');
    expect(s.committed.order.deletedAt).toBeNull();
  });
});

/**
 * ★ 拒删文案必须是**真挡着的那几类**（G7.5「异常可行动」的下一层：不仅要能行动，还得指对地方）。
 * 补第六路时 V2 里那份手抄清单（`发票/出运/凭证/核销分摊`）不会自己长大 ⇒ 挂批次的用户会被告知
 * 四个不相干的选项。这里钉两件事：① 文案由六路计数派生（只挂批次就只提批次）；② 全仓只有一处实现。
 */
describe('★ G4.4②：HAS_DEPENDENTS 的文案从判定派生，且全仓只有一份', () => {
  it('只挂 1 行已出运批次 ⇒ 文案点名批次、不出现四个旧类目', async () => {
    const s = makePrisma({ batches: [B('OSB_1', 'shipped')] });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    const msg = res.error?.message ?? '';
    expect(msg).toContain('批次计划（已出运/已取消）×1');
    expect(msg).not.toContain('发票');
    expect(msg).not.toContain('出运单');
    expect(msg).not.toContain('凭证');
    expect(msg).toContain('不可删除');                       // G7.5：结果
    expect(msg).toMatch(/请先处理.*后再重试/);                 // G7.5：下一步
  });

  it('多类同时挡 ⇒ 逐个列出（旧实现靠一句固定枚举，永远说不出是哪一类）', async () => {
    const s = makePrisma({
      batches: [B('OSB_1', 'shipped'), B('OSB_2', 'cancelled')],
      counts: { invoice: 3, paymentVoucher: 1 },
    });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    const msg = res.error?.message ?? '';
    expect(msg).toContain('发票×3');
    expect(msg).toContain('付款凭证×1');
    expect(msg).toContain('批次计划（已出运/已取消）×2');
    expect(msg).not.toContain('出运单');                      // 没查出来的类目不许出现在文案里
  });

  it('★ 反并行真源普查：这句文案在整个 src 下只许有一处实现（V2 不得再抄一份）', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    /** 扫描根 = 整个 `src`（不是"我挑的两个文件"）：从本文件位置反推，不依赖 cwd，也不写死域名目录 */
    const srcDir = fileURLToPath(new URL('../../', import.meta.url));
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = `${dir}/${name}`;
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__') walk(p, acc);
        } else if (name.endsWith('.ts')) acc.push(p);
      }
      return acc;
    };
    const hits = walk(srcDir)
      .filter((p) => stripComments(readFileSync(p, 'utf8')).includes('订单存在关联单据'))
      .map((p) => p.slice(srcDir.length + 1));
    expect(hits.sort(), '文案有第二处字面量 = 改一处忘另一处').toEqual(['orders/orderLifecycleService.ts']);
  });
});
