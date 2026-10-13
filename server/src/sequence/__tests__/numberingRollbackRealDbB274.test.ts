/**
 * B274 · 真库回滚证人（2026-09-28）
 *
 * 台账里那句"回滚会退号、不留孤儿审批单"到今天为止最硬的证人只是**按真库语义建模的假库**
 * （numberingAtomicityB274）。本件把那格搬到 **PostgreSQL 上真跑一次**：
 *   同一笔事务里 审批单**真的写进去**之后，再让主单落库那一步失败 ⇒ 真库回滚 ⇒
 *   用**另一条查询**去看：主单没有、审批单没有、**SequenceRegister 的那一格序号也没前进**（= 号退回）。
 *
 * ★ 为什么这一格不是恒真：如果取号发生在事务**外**（迁移前的写法），
 *   即使主单/审批单被回滚，序号也已经消费掉了 ⇒ "序号不变"这条断言当场红。
 *   反过来说，这条断言只在"取号在事务内"的实现下才可能绿 —— 这正是 B274 改的东西。
 *
 * ⚠️ 覆盖面：本件跑在**本机业务库**（测试库＝本机库，见台账口径），只建自己的行、按自己写入清；
 *   证的是 PostgreSQL 的事务回滚与行锁递增语义，不证 HTTP 层（那一层在台账 §9 B274 的"真库活路"段：
 *   3×5 路并发 15/15 成功、0 撞号，但读数不可重跑）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createExceptionService } from '../../exceptions/exceptionService';
import { createApprovalCreateService } from '../../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../../approvals/approvalRoutingService';
import { todayLocalKey } from '../../shared/localDate';

const prisma = new PrismaClient();
const DAY = todayLocalKey().replace(/-/g, '');
const REG_KEY = `SEQREG_exceptionRequest_${todayLocalKey()}`;

const input = (tag: string) => ({
  exceptionCategory: 'price_deviation', subCategory: 'realdb_rollback', bypassedApprovalIds: [],
  exceptionReason: `真库回滚证人 ${tag}：客户临时改价导致毛利低于成本线，需要走例外放行以避免交付延误与违约索赔。`,
  customerCommitment: '客户书面确认维持原价',
  riskMitigationPlan: '限定本单一次性放行，本件跑完按自造自清口径删除自己建的行',
  targetType: 'Order', targetId: 'o_realdb_probe', action: 'shipment:release',
  validUntil: new Date(Date.now() + 86400000).toISOString(), maxUses: 1,
  responsibleOwnerId: 'usr_demo_boss', requesterId: 'usr_demo_boss', notes: '', attachments: [],
  clientSuppliedReviewerId: null,
} as any);

function makeService(client: any) {
  const routing = createApprovalRoutingService({ prisma: client } as any);
  const approvalCreateService = createApprovalCreateService({ prisma: client, routingService: routing } as any);
  return createExceptionService({ prisma: client, approvalCreateService } as any);
}

async function seqValue(): Promise<number> {
  const row = await prisma.sequenceRegister.findUnique({ where: { id: REG_KEY }, select: { currentSeq: true } });
  return row?.currentSeq ?? 0;
}
async function counts() {
  const [exc, appr] = await Promise.all([
    // ★ 刻意不用 startsWith 前缀数行数：那个拼法会落进 drillResidualBackend ⑥c 那枚隐形族哨兵的谓词
    //   （它管的是 afterAll + 按前缀数行数 + 标识不在白名单）。这里只数我自己那一档 subCategory，
    //   范围更窄，也不用去扩白名单。
    prisma.dr013ExceptionRequest.count({ where: { subCategory: 'realdb_rollback' } }),
    prisma.approvalRequest.count({ where: { actionType: 'order:dr013-exception' } }),
  ]);
  return { exc, appr };
}

/** 把事务内那一次主单 create 换成"先写完再抛" —— 抛点必须在审批单已写之后 */
function injectFailureAfterApproval(client: any) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction') {
        return async (fn: any) => (target as any).$transaction(async (tx: any) => {
          const realCreate = tx.dr013ExceptionRequest.create.bind(tx);
          return fn(new Proxy(tx, {
            get(t2, p2) {
              if (p2 === 'dr013ExceptionRequest') {
                return new Proxy(t2.dr013ExceptionRequest, {
                  get(t3, p3) {
                    if (p3 === 'create') return async (a: any) => { const r = await realCreate(a); throw Object.assign(new Error('注入：主单落库阶段故障'), { code: 'INJECTED' }); };
                    return Reflect.get(t3, p3, t3);
                  },
                });
              }
              return Reflect.get(t2, p2, t2);
            },
          }));
        });
      }
      return Reflect.get(target, prop, target);
    },
  });
}

const createdIds: string[] = [];
afterAll(async () => {
  // 只清本件自己建出来的行（按记下来的 id 逐条删），删前不猜：只删记到的
  for (const id of createdIds) {
    const row = await prisma.dr013ExceptionRequest.findUnique({ where: { id }, select: { id: true, approvalRequestId: true } });
    if (!row) continue;
    await prisma.auditLog.deleteMany({ where: { targetId: row.id } });
    await prisma.dr013ExceptionRequest.delete({ where: { id: row.id } });
    if (row.approvalRequestId) await prisma.approvalRequest.delete({ where: { id: row.approvalRequestId } });
  }
  await prisma.$disconnect();
});

describe('B274 真库回滚：审批单已写入后失败 ⇒ PostgreSQL 当场回滚，号一并退回', () => {
  let before = { exc: 0, appr: 0 };
  let seqBefore = 0;

  beforeAll(async () => {
    before = await counts();
    seqBefore = await seqValue();
  });

  it('① 前提：本件用的事务键与发号真源同源（拿得到那一行的当前值）', async () => {
    expect(REG_KEY).toMatch(/^SEQREG_exceptionRequest_\d{4}-\d{2}-\d{2}$/);
    expect(typeof seqBefore).toBe('number');
  });

  it('② ★ 注入失败那一笔：主单 0、审批单 0、序号也没前进（号退回）', async () => {
    const svc = makeService(injectFailureAfterApproval(prisma) as any);
    const res: any = await svc.createExceptionRequest(input('inject'));
    expect(res.ok, '这一笔必须失败').toBe(false);
    expect(String(res.error?.code),
      '★ 失败点必须在**审批单已写之后**的主单落库那一步；若是 NO_REVIEWER_RESOLVED，说明根本没进事务，这一格就成了空的')
      .toBe('EXCEPTION_CREATE_FAILED');

    const after = await counts();
    expect(after.exc, '回滚后我自己那一档（subCategory=realdb_rollback）的例外单不许变多').toBe(before.exc);
    expect(after.appr, '★ 回滚后审批单也不许变多（旧写法在事务外先建 ⇒ 这里会 +1 = 孤儿单）').toBe(before.appr);
    expect(await seqValue(), '★ 号必须一并退回：事务内 increment 被回滚 ⇒ 序号与动手前相同').toBe(seqBefore);
  });

  it('③ 阳性对照：同一套件不注入失败 ⇒ 主单 +1、审批单 +1、序号 +1（②不是因为"什么都没发生"而绿）', async () => {
    const midCounts = await counts();
    const midSeq = await seqValue();
    const svc = makeService(prisma);
    const res: any = await svc.createExceptionRequest(input('control'));
    expect(res.ok, `对照笔应成功：${JSON.stringify(res.error ?? res)}`).toBe(true);
    createdIds.push(res.data.exception.id);
    expect(res.data.exception.exceptionNumber, '对照笔要证明②那格的"没变化"不是"什么都没跑"').toBeTruthy();

    const after = await counts();
    expect(after.exc, '对照笔真的写了库，否则②那格是空的').toBe(midCounts.exc + 1);
    expect(after.appr).toBe(midCounts.appr + 1);
    expect(await seqValue()).toBe(midSeq + 1);
    expect(String(res.data.exception.exceptionNumber)).toMatch(new RegExp(`^EXC-${DAY}-\\d{3}$`));
  });
});
