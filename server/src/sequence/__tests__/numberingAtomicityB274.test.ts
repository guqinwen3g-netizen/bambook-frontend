/**
 * B274 · 例外处置单（EXC-）取号与审批单的**原子性**行为测试（2026-09-28）
 *
 * 这份是照着同族先例 `paymentRequests/__tests__/paymentRequestNumberAtomicity.test.ts` 写的，
 * 但把那块假库补强到能回答**那一族没回答的一格**：
 *   PAYR 那份把 `sequenceRegister` 的 increment **立即**落到 committed（所以它证不了"回滚退号"）；
 *   真实 PostgreSQL 里那一次 increment 是**事务内的行 UPDATE** —— 拿到行锁直到提交，
 *   回滚时这个号**要退回**。本件按这个语义建模（staged seq + 提交期合并 + 全局互斥串行），
 *   所以这里能测 PAYR 那份测不了的两件事：
 *     ① 主单落库失败 ⇒ 已写的审批单**一起没有**（不留孤儿）；
 *     ② 那一格号**退回**（下一笔拿到同一个号），而不是"跳号消费掉"。
 *
 * ★ 判据有牙的证据在最后一格「守卫自检」：拿旧写法（事务外 count+1）在同一块假库上复跑，
 *   会**真的**出现重号并被提交期唯一约束拒（P2002）—— 上一格"5 路并发全部成功"才不是恒真。
 *
 * ⚠️ 覆盖面：这里仍是**假库**（真库那侧的可重跑件见台账 §9 B274 的"真库活路"段，读数不可重跑是它的短板）；
 *   串行化建模把真库的"行锁等待"简化成"整笔排队"，所以本件证的是**语义**（回滚退号、不留孤儿），
 *   不证 PostgreSQL 的锁等待时间与吞吐。
 */
import { describe, expect, it } from 'vitest';
import { createExceptionService } from '../../exceptions/exceptionService';
import { createApprovalCreateService } from '../../approvals/approvalCreateService';
import { todayLocalKey } from '../../shared/localDate';

const DAY = todayLocalKey().replace(/-/g, '');
const expectNumber = (seq: number) => `EXC-${DAY}-${String(seq).padStart(3, '0')}`;

function p2002(): any {
  return Object.assign(new Error('Unique constraint failed on the fields: (`exceptionNumber`)'), { code: 'P2002' });
}

interface Store {
  committed: { exc: any[]; appr: any[]; seq: Record<string, number> };
  log: { tx: number; rolledBack: number; outsideTxNumberingTouched: number };
}

function makeFakeDb(opts: { allowTopLevelCount?: boolean } = {}): Store & { prisma: any } {
  const committed = { exc: [] as any[], appr: [] as any[], seq: {} as Record<string, number> };
  const log = { tx: 0, rolledBack: 0, outsideTxNumberingTouched: 0, approvalStaged: 0 };
  /** 注入开关：下一次主单 create 在"审批单已写进同一笔事务之后"抛错 */
  const control = { failNextExcCreate: false };

  // ★ 真实语义：register 行的 increment 持锁到提交 ⇒ 同一枚号不会被两笔同时拿到 ⇒ 建模成整笔排队
  let mutex: Promise<any> = Promise.resolve();

  function makeTx() {
    const staged = { exc: [] as any[], appr: [] as any[], seq: {} as Record<string, number> };
    const tx: any = {
      sequenceRegister: {
        upsert: async ({ where, create }: any) => {
          if (committed.seq[where.id] === undefined && staged.seq[where.id] === undefined) staged.seq[where.id] = 0;
          return { ...create };
        },
        // 单步原子读改写：读 committed（已提交）或本事务已 staged 的值，写回 staged —— 提交才落地
        update: async ({ where }: any) => {
          const cur = (staged.seq[where.id] ?? committed.seq[where.id] ?? 0) + 1;
          staged.seq[where.id] = cur;
          return { currentSeq: cur };
        },
        findUnique: async () => null,
      },
      voidedNumber: { findUnique: async () => null },
      dr013ExceptionRequest: {
        findFirst: async ({ where }: any) => {
          const n = where.exceptionNumber;
          return [...committed.exc, ...staged.exc].some((r) => r.exceptionNumber === n) ? { id: 'occupied' } : null;
        },
        count: async ({ where }: any) => {
          log.outsideTxNumberingTouched += 1;
          const prefix = where.exceptionNumber.startsWith;
          return committed.exc.filter((r) => String(r.exceptionNumber).startsWith(prefix)).length;
        },
        create: async ({ data }: any) => {
          if (control.failNextExcCreate) {
            control.failNextExcCreate = false;
            // ★ 在**审批单已写进同一笔事务之后**才失败 —— 这正是旧写法留孤儿的那一步
            throw Object.assign(new Error('注入：主单落库阶段故障'), { code: 'INJECTED_TX_FAILURE' });
          }
          staged.exc.push({ ...data }); return { ...data };
        },
      },
      approvalRequest: {
        findFirst: async () => null,
        findMany: async () => [],
        update: async ({ where }: any) => ({ id: where.id }),
        create: async ({ data }: any) => { log.approvalStaged += 1; staged.appr.push({ ...data }); return { ...data }; },
      },
      auditLog: { create: async ({ data }: any) => ({ ...data }) },
    };
    return { tx, staged };
  }

  const topRefused = (what: string) => async () => {
    log.outsideTxNumberingTouched += 1;
    throw new Error(`NUMBERING_OUTSIDE_TX: ${what} 必须在 $transaction 内（回滚才不会留孤儿/不留跳号）`);
  };

  const prisma: any = {
    dr013ExceptionRequest: opts.allowTopLevelCount
      ? { count: async ({ where }: any) => { log.outsideTxNumberingTouched += 1; const p = where.exceptionNumber.startsWith; return committed.exc.filter((r) => String(r.exceptionNumber).startsWith(p)).length; } }
      : { count: topRefused('事务外数行数'), findFirst: topRefused('事务外查占位') },
    sequenceRegister: opts.allowTopLevelCount
      ? {}
      : { upsert: topRefused('事务外碰发号表'), update: topRefused('事务外碰发号表') },
    $transaction: async (fn: any) => {
      const run = async () => {
        log.tx += 1;
        const { tx, staged } = makeTx();
        try {
          const out = await fn(tx);
          // 提交期唯一约束（模拟 DB 的 @unique）：撞号则整笔回滚
          for (const row of staged.exc) {
            if (committed.exc.some((r) => r.exceptionNumber === row.exceptionNumber)) throw p2002();
          }
          committed.exc.push(...staged.exc);
          committed.appr.push(...staged.appr);
          Object.assign(committed.seq, staged.seq);   // ★ 号在这一步才真正落地
          return out;
        } catch (e) {
          log.rolledBack += 1;                        // staged 全部丢弃 = 回滚（号也一起退回）
          throw e;
        }
      };
      const p = mutex.then(run, run);
      mutex = p.catch(() => {});
      return p;
    },
  };
  return { prisma, committed, log, control };
}

function makeApprovalService(prisma: any) {
  const routingService = {
    resolveReviewerByDepartment: async () => ({ reviewerId: 'u_head', route: 'DEPT_HEAD', departmentSnapshotId: 'ds_1' }),
  } as any;
  return createApprovalCreateService({ prisma, routingService } as any);
}

const baseInput = (tag: string) => ({
  exceptionCategory: 'price_deviation', subCategory: 'atomic_drill', bypassedApprovalIds: [],
  exceptionReason: `取号原子性演练 ${tag}：客户临时改价导致毛利低于成本线，需要走例外放行以避免交付延误与违约索赔。`,
  customerCommitment: '客户书面确认维持原价',
  riskMitigationPlan: '限定本单一次性放行，同步登记偏差金额与责任人复核',
  targetType: 'Order', targetId: 'o_atomic', action: 'shipment:release',
  validUntil: new Date(Date.now() + 86400000).toISOString(), maxUses: 1,
  responsibleOwnerId: 'u_owner', requesterId: 'u_req', notes: '', attachments: [],
  clientSuppliedReviewerId: null,
} as any);

describe('B274：EXC 取号 + 审批单的原子性（假库按真库语义建模：持锁排队、回滚退号）', () => {
  it('① 成功一笔：主单与审批单各 1 张、号是 EXC-YYYYMMDD-001，审批 payload 的号 === 落库的号', async () => {
    const db = makeFakeDb();
    const svc = createExceptionService({ prisma: db.prisma, approvalCreateService: makeApprovalService(db.prisma) } as any);
    const res: any = await svc.createExceptionRequest(baseInput('ok'));
    expect(res.ok, `应成功，实际 ${JSON.stringify(res.error ?? res)}`).toBe(true);
    expect(db.committed.exc).toHaveLength(1);
    expect(db.committed.appr).toHaveLength(1);
    expect(db.committed.exc[0].exceptionNumber).toBe(expectNumber(1));
    expect(db.committed.appr[0].payload.exceptionNumber, '审批单上写的号必须就是这张单的真号').toBe(expectNumber(1));
  });

  it('② ★ 回滚不留孤儿、号一并退回：主单落库失败 ⇒ 审批单 0 张、下一笔拿到**同一个号**', async () => {
    const db = makeFakeDb();
    const svc = createExceptionService({ prisma: db.prisma, approvalCreateService: makeApprovalService(db.prisma) } as any);
    db.control.failNextExcCreate = true;   // 在**审批单已写进同一笔事务之后**注入失败

    const bad: any = await svc.createExceptionRequest(baseInput('rollback'));
    expect(bad.ok, '这一笔必须失败').toBe(false);
    expect(String(bad.error?.code), '失败点必须在主单落库那一支（不是审批解析那支）').toBe('EXCEPTION_CREATE_FAILED');
    expect(bad.error?.statusCode, '数据层故障走 500，不许伪装成用户错').toBe(500);
    expect(db.log.approvalStaged, '前提：审批单确实已经写进这一笔事务 —— 没写过就谈不上"回滚救了我们"').toBe(1);
    expect(db.committed.exc, '回滚后主单不许存在').toHaveLength(0);
    expect(db.committed.appr, '★ 回滚后审批单也不许存在（旧写法在事务外先建，这里就会留下孤儿单）').toHaveLength(0);
    expect(db.log.rolledBack).toBe(1);

    const ok2: any = await svc.createExceptionRequest(baseInput('after-rollback'));
    expect(ok2.ok, `第二笔应成功：${JSON.stringify(ok2.error ?? ok2)}`).toBe(true);
    expect(db.committed.exc[0].exceptionNumber, '回滚掉的那一笔必须把号退回去（事务内 increment 的语义），而不是跳号').toBe(expectNumber(1));
    expect(db.committed.appr[0].payload.exceptionNumber).toBe(expectNumber(1));
  });

  it('③ 并发 5 笔全部成功、号互不相同、零回滚（原子发号 ⇒ 不存在撞号）', async () => {
    const db = makeFakeDb();
    const svc = createExceptionService({ prisma: db.prisma, approvalCreateService: makeApprovalService(db.prisma) } as any);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => svc.createExceptionRequest(baseInput(`c${i}`))));
    expect(results.every((r) => r.ok), `并发 5 笔都应成功：${JSON.stringify(results.filter((r) => !r.ok).map((r: any) => r.error))}`).toBe(true);
    expect(db.committed.exc.map((r) => r.exceptionNumber).sort()).toEqual([1, 2, 3, 4, 5].map(expectNumber));
    expect(db.log.rolledBack, '原子发号下一次回滚都不该有').toBe(0);
    expect(db.committed.appr).toHaveLength(5);
    for (const ar of db.committed.appr) {
      expect(db.committed.exc.some((e) => e.id === ar.targetId), `孤儿审批单 targetId=${ar.targetId}`).toBe(true);
    }
  });

  it('④ 取号面在事务外不可用：外层客户端一被碰就抛（证明取号确实在事务内）', async () => {
    const db = makeFakeDb();   // allowTopLevelCount=false ⇒ 外层 count/findFirst/upsert/update 全抛
    const svc = createExceptionService({ prisma: db.prisma, approvalCreateService: makeApprovalService(db.prisma) } as any);
    const res: any = await svc.createExceptionRequest(baseInput('inside-tx'));
    expect(res.ok, `取号若在事务外，这一笔会撞 NUMBERING_OUTSIDE_TX：${JSON.stringify(res.error ?? res)}`).toBe(true);
    expect(db.log.outsideTxNumberingTouched, '一次都不许碰事务外的取号面').toBe(0);
  });

  it('⑤ ★ 守卫自检（证明③不是恒真）：把旧形状"事务外 count+1"放回同一块假库 ⇒ 真撞号 P2002', async () => {
    const db = makeFakeDb({ allowTopLevelCount: true });
    // 旧写法：先在外层数一遍，再各自 +1 —— 五笔并发读到同一个 count
    const taken = await Promise.all(Array.from({ length: 5 }, async () => {
      const count = await db.prisma.dr013ExceptionRequest.count({ where: { exceptionNumber: { startsWith: `EXC-${DAY}-` } } });
      return expectNumber(count + 1);
    }));
    expect(new Set(taken).size, `旧写法本该撞号，却没撞 ⇒ 这块假库拦不住退化（③就成了恒真）`).toBe(1);
    // 把这些同号的单据硬塞进提交路径：只有一张能活，其余必须被提交期唯一约束拒
    let rejected = 0;
    for (const num of taken) {
      try {
        await db.prisma.$transaction(async (tx: any) => { await tx.dr013ExceptionRequest.create({ data: { id: `e_${num}_${Math.random()}`, exceptionNumber: num } }); });
      } catch (e: any) { if (e?.code === 'P2002') rejected += 1; else throw e; }
    }
    expect(rejected, '旧写法必须有 N-1 笔被 P2002 拒掉').toBe(4);
    expect(db.committed.exc).toHaveLength(1);
  });
});
