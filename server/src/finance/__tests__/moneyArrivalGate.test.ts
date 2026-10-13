/**
 * v3.21 原型（先只在 /tmp 副本里跑）：**到达集合**证人
 *
 * 要证的命题不是「Prisma 会不会拒 NaN」（离线证不了，见台账 B140 的 v3.21 更正），
 * 而是我们能证的那半句：**非法金额根本不该到达任何写调用**。
 * ⇒ 用 Proxy 替身记录"到达的 (模型.方法) 与 data 里的金额"，于是：
 *   · 反向：非法入参 ⇒ 到达集合必须**空**（连 $transaction 都没开 ⇒ 门禁在写之前）；
 *   · ★ 正面（防空断言）：合法入参 ⇒ 到达集合必须**非空**、且金额原样出现在 invoiceLine 的写入里。
 *     没有这条正面，"集合为空"与"替身压根没接上"长得一模一样（记忆里反复栽的那一坑）。
 */
/**
 * §2 G3「到达集合」证人（v3.21 落地；原型在 /tmp 副本里先跑通才搬进来）。
 *
 * ★ 为什么用"到达没到达"而不是"Prisma 拒不拒"：台账 B140 的 v3.21 更正实测到，本仓这版 Prisma **先连接后校验**
 *   （死连接探针下，连"对象冒充数字"这种必然非法的入参都报 `Can't reach database`）⇒ "客户端拒"这种阶段归属**离线证不了**，
 *   更做不出常驻证人。能证的只有我们自己那一层：**非法金额不该到达任何写调用**。
 *   ⇒ 这条判据不碰库（prisma 是注入的 Proxy 替身；`createInvoice` 的 client 本来就是入参，见 :381），
 *     所以它能在门禁里天天跑；B145/B147/B148 那一族的"替身全绿≠真库行为"在这里不构成问题——我们没在主张库的行为。
 * ★ 非空转：先跑**正面对照**（合法金额必须真的出现在 `invoiceLine` 写入载荷里）。
 *   没有它，"arrivals 为空"与"替身压根没接上"完全同形（本仓栽过多次）。
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { createInvoice } from '../invoiceMutationService';

function recorder() {
  const arrivals: string[] = [];
  const moneySeen: unknown[] = [];
  const modelProxy = (model: string): any => new Proxy({}, {
    get: (_t, rawFn) => {
      const fn = String(rawFn);
      if (fn === 'then' || fn.startsWith('_')) return undefined;
      return async (args: any) => {
        arrivals.push(`${model}.${fn}`);
        const raw = args?.data ?? args;
        // create/create/update 的载荷在 .data；createMany/deleteMany 的 .data **本身就是数组**（原来按对象取，行金额被漏掉）
        const rows: any[] = Array.isArray(raw) ? raw
          : Array.isArray(raw?.data) ? raw.data : (raw && typeof raw === 'object' ? [raw] : []);
        for (const r of rows) if (r && typeof r === 'object' && 'amount' in r) moneySeen.push(r.amount);
        if (fn === 'create' || fn === 'upsert' || fn === 'update') {
          // 票号序列（businessSequence）读 .seq、票头读 .id ⇒ 替身给一组够用的字段，别为了造替身再引一份真源
          return { id: `${model.toUpperCase()}-PROBE`, seq: 1, currentSeq: 1, counter: 1, amount: new Prisma.Decimal('0') };
        }
        if (fn === 'createMany') return { count: Array.isArray(args?.data) ? args.data.length : 1 };
        if (fn === 'count') return 0;
        if (fn === 'findMany') return [];
        if (fn === 'aggregate' || fn === 'groupBy') return fn === 'aggregate' ? { _sum: {} } : [];
        if (fn.startsWith('delete')) return { count: 0 };
        return null;
      };
    },
    set: () => true,
  });
  const tx = new Proxy({}, { get: (_t, m) => (String(m) === 'then' ? undefined : modelProxy(String(m))), set: () => true });
  const prisma: any = new Proxy({}, {
    get: (_t, rawM) => {
      const m = String(rawM);
      if (m === '$transaction') return async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg));
      if (m === '$connect' || m === '$disconnect' || m === '$use') return async () => {};
      if (m === 'then' || m.startsWith('_')) return undefined;
      return modelProxy(m);
    },
    set: () => true,
  });
  return { prisma, arrivals, moneySeen };
}

const base = { customerRelationId: 'CUST-PROBE', type: 'COMMERCIAL', currency: 'CNY', amount: '100', description: 'G3 到达集合证人' };
const line = (amount: unknown) => ({ sourceType: 'BILLING_ITEM', sourceId: 'BI-PROBE-1', amount, currency: 'CNY' });

describe('§2 G3 · 到达集合证人（B140 的门禁到底挡没挡住，用"有没有到达写调用"来判，不用真库）', () => {
  it('★ 正面对照（先跑它）：合法金额必须**真的到达** invoiceLine 写入 ⇒ 否则后面所有"到达集合为空"都不算证据', async () => {
    const { prisma, arrivals, moneySeen } = recorder();
    const rr = await createInvoice({ prisma, input: { ...base, invoiceLines: [line('12.5')] } as any, actorId: 'api' });
    expect(arrivals.length, '替身一次都没被调用 ⇒ 到达集合的"空"没有意义（先证明尺有视力）').toBeGreaterThan(0);
    expect(arrivals.filter((a) => a.startsWith('invoice.')), '票头写入没到达').not.toHaveLength(0);
    expect(moneySeen.map((m) => Number(m)), '行金额没原样到达写入载荷').toContain(12.5);
  });

  for (const [label, bad] of [
    ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ["'NaN' 字符串", 'NaN'], ["'12abc'", '12abc'], ['对象冒充数字', { nope: 1 }], ['true', true],
  ] as Array<[string, unknown]>) {
    it(`反向：行金额 ${label} ⇒ 被拒且**不抵达任何写调用**`, async () => {
      const { prisma, arrivals } = recorder();
      const r = await createInvoice({ prisma, input: { ...base, invoiceLines: [line(bad)] } as any, actorId: 'api' });
      expect(r.ok, '非法金额竟然被放行').toBe(false);
      expect((r as any).error?.code).toBe('INVALID_AMOUNT');
      expect(arrivals, `非法值抵达了写调用：${JSON.stringify(arrivals)}`).toEqual([]);
    });
  }
});
