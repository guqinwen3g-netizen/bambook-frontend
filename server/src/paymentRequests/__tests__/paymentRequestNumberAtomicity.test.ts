/**
 * 付款申请「取号 → 建审批 → 落库」原子性 —— 行为测试（2026-09-19 定稿）
 *
 * ── 本批修了什么 ─────────────────────────────────────────
 * 旧写法三件事分散在事务内外：`事务外 count+1 取号` → `事务外建审批单（payload 含号）`
 * → `事务内落库 PaymentRequest`。两个洞：
 *   ① 取号是**先读后写**，并发读到同一 count → 同号 → 撞 `requestNumber` 唯一键（P2002）；
 *   ② 落库回滚时**审批单已提交** → 留下**孤儿审批单**（审批台有单、业务单不存在）。
 *
 * ── 修法（两版，第二版才是正解）───────────────────────────
 *   v1「取号进事务 + 撞号换新号整体重试」→ 单测绿，但**真库 5 路并发实测仍失败 2 笔**
 *      （重试者又读到同一 count ⇒ 3 次重试耗尽）⇒ 有界重试**治标不治本**，已废弃。
 *   v2（现行）「**改用发号真源**」：`SequenceRegister` 行 + 数据库级原子 `increment`
 *      （`SEQUENCE_TYPE_CONFIGS.paymentRequest`：period='day'、padding=3）
 *      ⇒ 并发下号必然不同，**根本不存在竞态**，无需靠重试兜。
 *      号格式仍是 `PAYR-YYYYMMDD-NNN`，用户看到的号一个字符都不变。
 *
 * ── 为什么这里能用行为测试（而不只是源码守卫）─────────────
 * 本文件用一个**会模拟事务回滚、提交期唯一约束、原子 increment** 的假库：
 *   · 事务内写入先进暂存区（staged），抛错即丢弃 = 回滚；
 *   · 提交时校验 `requestNumber` 唯一，重复则抛 P2002 = 真实 DB 行为；
 *   · `sequenceRegister.update` 是**单步原子**读改写（模拟 `SET seq = seq + 1 RETURNING`）；
 *   · `paymentRequest.count` 故意是**非原子**的（已提交 + 本事务暂存），
 *     且**外层 prisma 不提供它** ⇒ 若有人退回「事务外取号」或「事务内 count+1」，
 *     本文件会**真的红**（见末尾「守卫自检」用 count+1 复现竞态）。
 */

import { describe, expect, it } from 'vitest';
import { createPaymentRequestService, PAYMENT_REQUEST_ERRORS } from '../paymentRequestService';
import { createApprovalCreateService } from '../../approvals/approvalCreateService';
import { todayLocalKey } from '../../shared/localDate';

const DAY = todayLocalKey().replace(/-/g, '');
/** 与 SEQUENCE_TYPE_CONFIGS.paymentRequest.defaultFormatTemplate 同口径的期望格式 */
const expectNumber = (seq: number) => `PAYR-${DAY}-${String(seq).padStart(3, '0')}`;

interface FakeDb {
  prisma: any;
  committed: { paymentRequest: any[]; approvalRequest: any[]; auditLog: any[]; sequenceRegister: Record<string, number> };
  log: { txCount: number; rolledBack: number; prCreateAttempts: number; approvalCreateAttempts: number; seqUpdateCalls: number };
}

/**
 * 假库：事务语义 + 提交期唯一约束 + 原子发号。
 * 注意**外层 prisma 故意不提供可用取号面**（`paymentRequest.count` / `sequenceRegister` 都抛）
 * —— 若取号退回事务外，会抛 `NUMBERING_OUTSIDE_TX` 而不是静默通过。
 */
function makeFakeDb(): FakeDb {
  const committed = {
    paymentRequest: [] as any[], approvalRequest: [] as any[], auditLog: [] as any[],
    /** periodKey → currentSeq（模拟 SequenceRegister 行） */
    sequenceRegister: {} as Record<string, number>,
  };
  const log = { txCount: 0, rolledBack: 0, prCreateAttempts: 0, approvalCreateAttempts: 0, seqUpdateCalls: 0 };

  function makeTx() {
    const staged = { paymentRequest: [] as any[], approvalRequest: [] as any[], auditLog: [] as any[] };
    const tx: any = {
      sequenceRegister: {
        upsert: async ({ where, create }: any) => {
          // 行已存在（已提交或本事务新建）→ 只回读，不改值
          if (committed.sequenceRegister[where.id] !== undefined) return { ...create, currentSeq: committed.sequenceRegister[where.id] };
          return create;
        },
        // ★ 单步原子读改写：与真实 DB 的 `UPDATE ... SET seq = seq + 1 RETURNING seq` 同语义
        update: async ({ where }: any) => {
          log.seqUpdateCalls += 1;
          const cur = (committed.sequenceRegister[where.id] ?? 0) + 1;
          committed.sequenceRegister[where.id] = cur;
          return { currentSeq: cur, formatTemplate: '{prefix}-{year}{month}{day}-{seq:03}', padding: 3, prefix: 'PAYR' };
        },
      },
      paymentRequest: {
        findFirst: async () => null, // 占用追平：演练环境无历史占位
        // 事务内读：已提交 + 本事务暂存（READ COMMITTED 语义）。
        // ⚠️ 故意**非原子** —— 若有人退回 `count+1`，竞态会被真实复现（见守卫自检）。
        count: async ({ where }: any) => {
          const prefix = where.requestNumber.startsWith;
          return [...committed.paymentRequest, ...staged.paymentRequest]
            .filter((r) => String(r.requestNumber).startsWith(prefix)).length;
        },
        create: async ({ data }: any) => {
          log.prCreateAttempts += 1;
          const row = { ...data };
          staged.paymentRequest.push(row);
          return row;
        },
      },
      approvalRequest: {
        findFirst: async () => null,
        create: async ({ data }: any) => {
          log.approvalCreateAttempts += 1;
          const row = { ...data };
          staged.approvalRequest.push(row);
          return row;
        },
      },
      auditLog: { create: async ({ data }: any) => ({ ...data }) },
    };
    return { tx, staged };
  }

  function p2002(): any {
    return Object.assign(new Error('Unique constraint failed on the fields: (`requestNumber`)'), { code: 'P2002' });
  }

  const prisma: any = {
    // ★ 取号若在事务外发生就会撞上这两个（证明取号确实在事务内）
    paymentRequest: {
      count: async () => { throw new Error('NUMBERING_OUTSIDE_TX: 取号必须在事务内'); },
      findFirst: async () => { throw new Error('NUMBERING_OUTSIDE_TX: 取号必须在事务内'); },
    },
    sequenceRegister: {
      upsert: async () => { throw new Error('NUMBERING_OUTSIDE_TX: 取号必须在事务内'); },
      update: async () => { throw new Error('NUMBERING_OUTSIDE_TX: 取号必须在事务内'); },
    },
    $transaction: async (fn: any) => {
      log.txCount += 1;
      const { tx, staged } = makeTx();
      try {
        const out = await fn(tx);
        // 提交期唯一约束（模拟 DB）：撞号则整个事务回滚
        for (const row of staged.paymentRequest) {
          if (committed.paymentRequest.some((r) => r.requestNumber === row.requestNumber)) throw p2002();
        }
        committed.paymentRequest.push(...staged.paymentRequest);
        committed.approvalRequest.push(...staged.approvalRequest);
        committed.auditLog.push(...staged.auditLog);
        return out;
      } catch (e) {
        log.rolledBack += 1;
        throw e; // staged 丢弃 = 回滚
      }
    },
    notification: { create: async ({ data }: any) => ({ ...data }) },
    notificationPreference: { findMany: async () => [] },
  };
  return { prisma, committed, log };
}

function makeApprovalService(prisma: any, opts: { failTimes?: number; throwCode?: string } = {}) {
  let calls = 0;
  const routingService = {
    resolveReviewerByDepartment: async () => ({ reviewerId: 'u_head', route: 'DEPT_HEAD', departmentSnapshotId: 'ds_1' }),
  } as any;
  const real = createApprovalCreateService({ prisma, routingService });
  return {
    createBusinessApproval: async (input: any) => {
      calls += 1;
      if (opts.failTimes && calls <= opts.failTimes) {
        if (opts.throwCode) throw Object.assign(new Error('no reviewer'), { code: opts.throwCode });
        throw p2002Like();
      }
      // 用真实服务，验证 client=tx 的接线（审批单必须与主单同事务）
      return real.createBusinessApproval(input);
    },
  } as any;
}

function p2002Like(): any {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

const validInput = {
  supplierId: 'REL_SUP1',
  supplierName: '供应商A',
  totalAmount: '1000.0000',
  currency: 'CNY',
  applicantId: 'u_sales',
};

function build(opts: { failTimes?: number; throwCode?: string } = {}) {
  const { prisma, committed, log } = makeFakeDb();
  const approvalCreateService = makeApprovalService(prisma, opts);
  const svc = createPaymentRequestService({ prisma, approvalCreateService });
  return { svc, committed, log };
}

describe('★ 付款申请取号原子性（P4-1 P2-#1）', () => {
  it('取号在事务内进行：外层客户端取号面不可用也不受影响（旧写法会抛 NUMBERING_OUTSIDE_TX）', async () => {
    const { svc, committed } = build();
    const res = await svc.createPaymentRequest(validInput);
    expect(res.ok, `创建应成功，实际：${JSON.stringify(res)}`).toBe(true);
    expect(committed.paymentRequest).toHaveLength(1);
    expect(committed.paymentRequest[0].requestNumber).toBe(expectNumber(1));
  });

  it('★ 并发 5 笔 → 全部成功、号互不相同，且**零回滚**（原子发号 ⇒ 根本不存在竞态）', async () => {
    const { prisma, committed, log } = makeFakeDb();
    const approvalCreateService = makeApprovalService(prisma);
    const svc = createPaymentRequestService({ prisma, approvalCreateService });

    const results = await Promise.all(Array.from({ length: 5 }, () => svc.createPaymentRequest(validInput)));

    expect(results.every((r) => r.ok), `并发 5 笔都应成功：${JSON.stringify(results.filter((r) => !r.ok))}`).toBe(true);
    const numbers = committed.paymentRequest.map((r) => r.requestNumber).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5].map(expectNumber));
    // ★ 与 v1（count+1 + 重试）的关键区别：那时必然出现回滚；原子发号下**一次回滚都不该有**
    expect(log.rolledBack, '原子发号不应产生任何回滚').toBe(0);
  });

  it('★ 不留孤儿审批单：审批单与付款申请一一对应，且 payload 的号 === 落库的号', async () => {
    const { prisma, committed } = makeFakeDb();
    const approvalCreateService = makeApprovalService(prisma);
    const svc = createPaymentRequestService({ prisma, approvalCreateService });

    await Promise.all(Array.from({ length: 5 }, () => svc.createPaymentRequest(validInput)));

    // 旧写法下：审批单在事务外先建且失败不回滚 ⇒ 审批单数 > 付款申请数
    expect(committed.approvalRequest).toHaveLength(committed.paymentRequest.length);
    expect(committed.approvalRequest).toHaveLength(5);
    for (const ar of committed.approvalRequest) {
      expect(committed.paymentRequest.some((pr) => pr.id === ar.targetId), `孤儿审批单：targetId=${ar.targetId}`).toBe(true);
    }
    // 审批 payload 里的号与落库的号一致（旧写法重试时二者会脱节）
    for (const ar of committed.approvalRequest) {
      const pr = committed.paymentRequest.find((p) => p.id === ar.targetId);
      expect(ar.payload.requestNumber).toBe(pr.requestNumber);
    }
  });

  it('★ 审批单创建失败 → 整体回滚，不留下无主审批单、也不产生付款申请', async () => {
    const { svc, committed } = build({ failTimes: 1, throwCode: 'APPROVAL_CREATE_FAILED' });
    const res = await svc.createPaymentRequest(validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('APPROVAL_CREATE_FAILED');
      expect(res.error.statusCode).toBe(500);
    }
    expect(committed.paymentRequest).toHaveLength(0);
    expect(committed.approvalRequest).toHaveLength(0);
  });

  it('NO_REVIEWER_RESOLVED → 409 透传且不重试（fail-closed 语义不变）', async () => {
    const { svc, committed, log } = build({ failTimes: 9, throwCode: 'NO_REVIEWER_RESOLVED' });
    const res = await svc.createPaymentRequest(validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe(PAYMENT_REQUEST_ERRORS.NO_REVIEWER_RESOLVED);
      expect(res.error.statusCode).toBe(409);
    }
    expect(log.txCount, 'NO_REVIEWER_RESOLVED 不该触发重试').toBe(1);
    expect(committed.paymentRequest).toHaveLength(0);
    expect(committed.approvalRequest).toHaveLength(0);
  });

  it('交付口径不变：号格式仍是 PAYR-YYYYMMDD-NNN（3 位补零），未换成年序', async () => {
    const { svc, committed } = build();
    await svc.createPaymentRequest(validInput);
    expect(committed.paymentRequest[0].requestNumber).toMatch(/^PAYR-\d{8}-\d{3}$/);
  });

  it('★ 守卫自检：本假库确实能复现「非原子取号」的竞态（否则本文件在空过）', async () => {
    // 用**故意非原子**的 count+1 走一遍并发：应当出现「撞号 → 回滚」，
    // 证明假库具备捕获回归的能力（若这条恒绿，说明假库已失去判别力）。
    const { prisma, log } = makeFakeDb();
    const racy = async () => prisma.$transaction(async (tx: any) => {
      const prefix = `PAYR-${DAY}-`;
      const n = await tx.paymentRequest.count({ where: { requestNumber: { startsWith: prefix } } });
      return tx.paymentRequest.create({ data: { id: `racy_${Math.random()}`, requestNumber: `${prefix}${String(n + 1).padStart(3, '0')}` } });
    });
    const settled = await Promise.allSettled([racy(), racy()]);
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(rejected.length, '非原子取号应至少撞号一次 ⇒ 假库具备判别力').toBeGreaterThanOrEqual(1);
    expect(log.rolledBack).toBeGreaterThanOrEqual(1);
  });
});
