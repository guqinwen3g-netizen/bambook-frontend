/**
 * B274 证人用的假库（异常域创建流程）。
 *
 * ★ 设计要点：**事务外不许有任何库写**不是靠断言"日志里没有"，而是被做成硬前置 ——
 *   顶层 prisma 是一个 Proxy，任何 `<模型>.<方法>` 一旦被调用就直接抛错并点名。
 *   于是"取号/审批单被挪回事务外"这种退化**必然**让用例红，而不是靠我记住要数日志。
 *
 * 用法：`const h = makeExceptionHarness(); createExceptionService({ prisma: h.prisma, approvalCreateService: h.approvalCreateService })`
 */

export interface HarnessState {
  /** 形如 `top.$transaction` / `tx.sequenceRegister.update` / `tx.exc.create` 的调用顺序 */
  log: string[];
  /** 事务内建出来的主单（含 data，用来核对号） */
  excCreated: Array<Record<string, any>>;
  /** SequenceRegister 的内存态：id → 已分配到的序号 */
  seq: Record<string, number>;
  /** 传给 $transaction 回调的那个 tx 句柄（用来做"同一个对象"的同一性比对） */
  txHandle: any;
  /** 审批服务最后一次收到的入参 */
  approvalInput: any;
  approvalCalls: number;
}

export function makeExceptionHarness(opts: { approvalThrows?: unknown } = {}): {
  prisma: any;
  approvalCreateService: any;
  state: HarnessState;
} {
  const state: HarnessState = { log: [], excCreated: [], seq: {}, txHandle: null, approvalInput: null, approvalCalls: 0 };

  const modelWritesRejected = (scope: 'top') => (model: string, method: string) => async () => {
    state.log.push(`${scope}.${model}.${method}`);
    throw new Error(
      `B274 前提：${scope === 'top' ? '事务外' : scope}不许出现库写/查（被调用的正是 ${model}.${method}）`
      + ' —— 取号与审批单必须落在同一笔 $transaction 内，否则回滚会留下孤儿单',
    );
  };

  const topProxy = new Proxy(
    {
      $transaction: async (fn: any) => {
        state.log.push('top.$transaction');
        const tx = makeTxHandle(state);
        state.txHandle = tx;
        return fn(tx);
      },
    },
    {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        const model = String(prop);
        return new Proxy({}, {
          get(_t, method) {
            return modelWritesRejected('top')(model, String(method));
          },
        });
      },
    },
  );

  const approvalCreateService = {
    createBusinessApproval: async (input: any) => {
      state.approvalCalls += 1;
      state.approvalInput = input;
      state.log.push('approval.createBusinessApproval');
      if (opts.approvalThrows) throw opts.approvalThrows;
      return { id: 'apr_test_1', reviewerId: 'u_reviewer_test' };
    },
  };

  return { prisma: topProxy as any, approvalCreateService: approvalCreateService as any, state };
}

function makeTxHandle(state: HarnessState) {
  return {
    sequenceRegister: {
      upsert: async (a: any) => {
        state.log.push('tx.sequenceRegister.upsert');
        const id = a.where.id;
        if (state.seq[id] === undefined) state.seq[id] = 0;
        return { id };
      },
      update: async (a: any) => {
        state.log.push('tx.sequenceRegister.update');
        const id = a.where.id;
        state.seq[id] = (state.seq[id] ?? 0) + 1;
        // 只回 currentSeq：formatTemplate / padding / prefix 留空，走 SEQUENCE_TYPE_CONFIGS 的默认档
        return { currentSeq: state.seq[id] };
      },
      findUnique: async () => null,
    },
    voidedNumber: { findUnique: async () => null },
    dr013ExceptionRequest: {
      findFirst: async () => { state.log.push('tx.exc.findFirst'); return null; },
      create: async (a: any) => {
        state.log.push('tx.exc.create');
        state.excCreated.push(a.data);
        return { id: 'exc_test_1', ...a.data };
      },
    },
    approvalRequest: { update: async (a: any) => ({ id: a.where.id }) },
    auditLog: { create: async () => { state.log.push('tx.auditLog.create'); return { id: 'aud_test_1' }; } },
  };
}
