/**
 * B14（refs G3-LA · G4.4 缺口③ · T2）：`deleteOrder` 的五路依赖计数**失败时必须拒绝删除**。
 *
 * 缺陷本体（已构造验证，见 `docs/B14-fail-open删除守卫-构造验证-2026-09-20.md`）：
 * `orderLifecycleService.ts` 的 5 个 `.catch(() => 0)` 把「这单还有没有下游依赖」的
 * 查询失败**变成 0**，而 0 在守卫的 `if` 里是**判定值不是显示值** ⇒ 守卫的失败方向是「放行」。
 * 实测：订单挂 1 张活发票、`tx.invoice.count` 抛客户端侧校验错 ⇒ `ok = true` 且**事务提交**，
 * 发票成孤儿。
 *
 * ★ 判据出处不是现值（G6.4 / T1）：
 *   · 「算不出来必须不给数，绝不给错数」= `docs/交付目标与验收标准-2026-09-20.md` §2 G3 判据；
 *     写路径/守卫路径上的 fail-open 属 **L-A 零容忍** ⇒ 期望行为只有「拒绝」一种。
 *   · 503 取自 HTTP 语义：服务端**无法完成前置条件校验**（Service Unavailable，可重试），
 *     既不是客户端写错了（4xx），也不是删除动作本身失败（DELETE_FAILED 500）。
 *   · 码名 `DEPENDENCY_CHECK_FAILED` 是 Task 2 注册表登记的码（本文件末条直接核对注册表）。
 *
 * ★ 为什么这里的 `$transaction` 必须「 Honor 回滚」：`.workbuddy/memory/REFERENCE.md` 记着本仓
 * 踩过一次 —— `mock $transaction` 直通（`fn => fn(tx)`）时，「整体回滚」的断言恒真、等于没断言。
 * 本文件的 store 把事务内写入**暂存**，只有回调正常返回才落进 `committed`（提交），
 * 抛出即丢弃（回滚）⇒ 下面「订单未被软删」「无删除审计」两条断言钉的是真回滚。
 */
import { describe, expect, it } from 'vitest';
import { deleteOrder } from '../orderLifecycleService';
import { lookupErrorCode } from '../../shared/errorCodes';

const ORDER_ID = 'ORD_B14_1';

/** 参与删除守卫的六路计数（与 orderLifecycleService 里的六路同口径；v2.49 起含批次计划） */
const GUARD_MODELS = [
  'invoice',
  'invoiceOrderAllocation',
  'shipment',
  'shipmentOrderAllocation',
  'paymentVoucher',
  // ★ v2.49（G4.4 缺口②）加的第六路：批次计划。列在这里 = 下面那组逐路注入的 it.each 会自动覆盖它；
  //   删掉这行就等于「少查一路」没人抓 —— 正是 B14 那个老病的另一种形状。
  'orderShipmentBatch',
] as const;
type GuardModel = (typeof GUARD_MODELS)[number];

/** 一次计数查询的结果：正常返回条数，或抛错（`from` 标明是哪一路） */
type CountSpec = number | { throws: Error };

interface StoreInit {
  order?: Record<string, any> | null;
  counts?: Partial<Record<GuardModel, CountSpec>>;
  /** 指向本单的 Quotation.convertedOrderId 条数（删单联动的输入） */
  quotationsPointingHere?: number;
  /** ★ v2.49：级联软删 planned 批次的返回值（默认 0） */
  cascadedBatches?: number;
}

/**
 * 一个**会提交 / 会回滚**的最小 Postgres 替身。
 * 语义照真库：事务内读看到暂存值，未提交的写入在回滚后必须消失。
 */
function makeCommitAwarePrisma(init: StoreInit) {
  const baseOrder = init.order === undefined
    ? { id: ORDER_ID, status: 'Pending', deletedAt: null, createdAt: BigInt(0), updatedAt: BigInt(0) }
    : init.order;

  /** 已提交态 —— 只有事务回调正常返回才会被写入 */
  const committed = {
    order: baseOrder ? { ...baseOrder } : null,
    audit: [] as any[],
    entityLinksInactivated: [] as string[],
  };
  /** 事务内暂存（回滚即整份丢弃） */
  let draft = {
    order: committed.order ? { ...committed.order } : null,
    audit: [] as any[],
    links: [] as string[],
  };

  const counts = init.counts ?? {};
  const countCalls: Record<GuardModel, number> = {
    invoice: 0, invoiceOrderAllocation: 0, shipment: 0, shipmentOrderAllocation: 0, paymentVoucher: 0,
    // ★ 这个初始化对象**必须跟着 GUARD_MODELS 长**：少一个键 ⇒ 那一路的计数变成 NaN，断言才红。
    //   注意 `tsc --noEmit` 不看测试树（§9 B38 记的就是这件事），所以漏键只能靠这条断言抓，不能靠类型检查。
    orderShipmentBatch: 0,
  };

  const tx: any = {
    order: {
      findUnique: async () => draft.order,
      update: async ({ data }: any) => {
        if (!draft.order) throw new Error('no row to update');
        draft.order = { ...draft.order, ...data };
        return { ...draft.order, lines: [] };
      },
    },
    entityLink: {
      findMany: async () => (draft.order ? [{ id: 'LINK_1', fromType: 'order', fromId: draft.order.id, status: 'active' }] : []),
      update: async ({ where }: any) => {
        draft.links.push(String(where.id));
        return {};
      },
    },
    // deactivateEntityLinks 同一 helper 还会走 entityReference（本单没有关联引用即可，
    // 但缺了这个 delegate 会在**构造数组时**同步抛 TypeError —— 那会假演一次「意外 fail-closed」）
    entityReference: {
      findMany: async () => [],
      update: async () => ({}),
    },
    quotation: {
      updateMany: async () => ({ count: init.quotationsPointingHere ?? 0 }),
    },
    auditLog: {
      create: async ({ data }: any) => {
        draft.audit.push(data);
        return data;
      },
    },
  };
  /** ★ v2.49：deleteOrder 现在还会**级联软删 planned 批次**（同事务的写）⇒ 替身必须有 updateMany，
   *    否则缺方法会以 DELETE_FAILED 的形式冒出来（又是 B38：`tsc` 不看测试树，只能靠跑）。 */
  const EXTRA_WRITERS: Record<string, () => Promise<{ count: number }>> = {
    orderShipmentBatch: async () => ({ count: init.cascadedBatches ?? 0 }),
  };
  for (const model of GUARD_MODELS) {
    tx[model] = {
      updateMany: EXTRA_WRITERS[model] ?? (async () => { throw new Error(`不该由 ${model} 承接级联写`); }),
      count: async () => {
        countCalls[model] += 1;
        const spec = counts[model];
        if (spec && typeof spec === 'object' && spec.throws) throw spec.throws;
        return typeof spec === 'number' ? spec : 0;
      },
    };
  }

  const prisma: any = {
    /** ★ 不是 `fn => fn(tx)` 那种直通假事务：提交/回滚按真库语义来 */
    $transaction: async (fn: any) => {
      const before = { order: committed.order, audit: committed.audit, links: committed.entityLinksInactivated };
      draft = {
        order: before.order ? { ...before.order } : null,
        audit: [...before.audit],
        links: [...before.links],
      };
      let result: any;
      try {
        result = await fn(tx);
      } catch (e) {
        // ROLLBACK：draft 整份丢弃，committed 保持事务开始前的样子
        throw e;
      }
      committed.order = draft.order;
      committed.audit = draft.audit;
      committed.entityLinksInactivated = draft.links;
      return result;
    },
  };

  return {
    prisma,
    committed,
    countCalls,
    /** 已提交的「删除本单」审计行（守卫必须在它之前失败） */
    deleteAudit: () => committed.audit.filter((a: any) => a.action === 'delete_order'),
  };
}

/** 一条被吞掉就会放行、但真库会抛的错（Prisma 客户端侧校验错的形状：无 statusCode） */
function clientSideDriftError(model: string) {
  return new Error(
    `Invalid \`prisma.${model}.count()\` invocation: Unknown argument \`deletedAt\` in \`where\`. Did you mean \`id\`?`,
  );
}

describe('★ B14：deleteOrder 的依赖守卫必须 fail-closed（查询失败 ⇒ 拒删并回滚）', () => {
  it('★ 订单挂着活发票、invoice.count 抛错 ⇒ 拒绝删除（DEPENDENCY_CHECK_FAILED），未软删、无删除审计', async () => {
    // 现场：invoice 这一路抛错，其余四路正常返回 0。
    // 现状（修复前）的行为是「抛错 → 0 → 守卫放行 → 删除提交 → 发票成孤儿」。
    const s = makeCommitAwarePrisma({
      counts: { invoice: { throws: clientSideDriftError('invoice') } },
    });

    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID, actorId: 'u1' });

    // ① 服务层**不得**返回 ok:true —— 这是 B14 的机器化复现点
    expect(res.ok, '依赖检查失败却报告删除成功 = fail-open').toBe(false);
    expect(res.error?.code).toBe('DEPENDENCY_CHECK_FAILED');
    // ② 订单行不得被写入 deletedAt（事务必须回滚，而不是「删了再说」）
    expect(s.committed.order?.deletedAt, '有依赖的订单被软删了（发票成孤儿）').toBeNull();
    // ③ 不得留下删除审计（审计与写入同事务，回滚了就不该有）
    expect(s.deleteAudit(), '删除已提交并留了审计 ⇒ 事务并未回滚').toEqual([]);
    // ④ 反向自检：错误确实是从那一路计数查询里抛出来的（不是没打到守卫就绿了）
    expect(s.countCalls.invoice, '注入没生效：invoice.count 一次都没被调用').toBe(1);
    // ⑤ 守卫失败时不得继续写后面的副作用（EntityLink inactive 也属删除事务的一部分）
    expect(s.committed.entityLinksInactivated, '依赖检查未通过却已改了 EntityLink').toEqual([]);
  });

  it.each(GUARD_MODELS)(
    '★ 六路中任意一路（%s）抛错都不得被当成「没有依赖」',
    async (model) => {
      const s = makeCommitAwarePrisma({ counts: { [model]: { throws: clientSideDriftError(model) } as CountSpec } });
      const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID, actorId: 'u1' });

      expect(res.ok, `${model}.count 抛错被吞 ⇒ 守卫放行`).toBe(false);
      expect(res.error?.code, `${model} 一路的失败码`).toBe('DEPENDENCY_CHECK_FAILED');
      expect(s.committed.order?.deletedAt, `${model} 一路失败后订单被软删`).toBeNull();
      expect(s.deleteAudit()).toEqual([]);
      expect(s.countCalls[model]).toBe(1);
    },
  );

  it('★ 阳性对照 1：六路全 0 且无人抛错 ⇒ 删除照常提交（修复没把守卫变成「什么都不许删」）', async () => {
    const s = makeCommitAwarePrisma({ counts: {} });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID, actorId: 'u1' });

    expect(res.ok).toBe(true);
    expect(typeof s.committed.order?.deletedAt).toBe('bigint');
    expect(s.deleteAudit().length).toBe(1);
    expect(s.committed.entityLinksInactivated.length).toBe(1);
  });

  it('★ 阳性对照 2：计数正常返回「有依赖」⇒ 仍按 HAS_DEPENDENTS 拒绝（409 语义没变）', async () => {
    const s = makeCommitAwarePrisma({ counts: { invoice: 2, shipment: 1 } });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID, actorId: 'u1' });

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('HAS_DEPENDENTS');
    expect(s.committed.order?.deletedAt).toBeNull();
    expect(s.deleteAudit()).toEqual([]);
  });

  it('★ 计数失败不得伪装成 DELETE_FAILED / Prisma 原始码（P2010 之类）甩给前端', async () => {
    const s = makeCommitAwarePrisma({ counts: { paymentVoucher: { throws: Object.assign(clientSideDriftError('paymentVoucher'), { code: 'P2010' }) } } });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });

    // 守卫失败必须在**事务内**换成显式业务码：原始 Prisma 码经 `if (e.code)` 直达 UI 就是天书码
    expect(res.error?.code).toBe('DEPENDENCY_CHECK_FAILED');
    expect(res.error?.message).not.toMatch(/Prisma|invocation|P2010/);
  });
});

describe('★ B14：DEPENDENCY_CHECK_FAILED 的注册表条目（503 + 可行动文案）', () => {
  /**
   * 期望值来源，两条独立判据，都不是「实现现在返回什么」：
   *   · HTTP 语义：服务端无法完成本次请求所依赖的前置校验 ⇒ 5xx，且是可重试的
   *     （503 Service Unavailable），而不是「删除动作本身失败」（那已是 DELETE_FAILED 500）；
   *   · 本批 Step 2 要求把它登记进 `shared/errorCodes.ts`（Task 2 的注册表 = 码的唯一真源）。
   */
  it('注册表里登记为 503', () => {
    const spec = lookupErrorCode('DEPENDENCY_CHECK_FAILED');
    expect(spec, '码必须先登记进注册表（Task 2 的契约）').toBeTruthy();
    expect(spec!.status).toBe(503);
  });

  /** G7.5「异常可行动」：文案必须说清「为什么」+「下一步做什么」，且标点与注册表其余条目一致 */
  it('文案说清「为什么 + 结果 + 下一步」，以全角句号结尾（G7.5）', () => {
    const spec = lookupErrorCode('DEPENDENCY_CHECK_FAILED')!;
    expect(/[一-龥]/.test(spec.message), '文案必须是给用户看的中文').toBe(true);
    expect(spec.message, '少了「为什么」——用户不知道该等什么').toContain('校验未能完成');
    expect(spec.message, '少了「结果」——必须明说删除被拒，不许让人以为已删').toContain('删除已阻止');
    expect(spec.message, '少了「下一步做什么」').toMatch(/稍后重试|联系管理员/);
    expect(spec.message).toMatch(/。$/);
  });

  it('服务层映射表也把它给 503（路由不再各自抄一份）', async () => {
    const { ORDER_LIFECYCLE_ERROR_HTTP_STATUS } = await import('../orderLifecycleService');
    expect(ORDER_LIFECYCLE_ERROR_HTTP_STATUS.DEPENDENCY_CHECK_FAILED).toBe(503);
  });

  /**
   * ★ 反漂移钉子：`deleteOrder` 外发的文案必须逐字等于注册表那句。
   * 现状是**两份字面量**（服务层 throw 自带 message，注册表是 Task 2 立的文案真源），
   * 本条不新增真源、只把「改一处忘另一处」变成红的。
   * 等 orders 域做「中文文案 → 码」收敛（S0-A 后续批次）时，服务层改为直接读注册表，本条自然成立。
   */
  it('服务层抛出的文案 = 注册表文案（两份字面量不许漂移）', async () => {
    const s = makeCommitAwarePrisma({ counts: { shipment: { throws: clientSideDriftError('shipment') } } });
    const res = await deleteOrder({ prisma: s.prisma, orderId: ORDER_ID });
    expect(res.error?.message).toBe(lookupErrorCode('DEPENDENCY_CHECK_FAILED')!.message);
  });
});
