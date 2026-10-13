/**
 * B274 · 真库回滚证人 —— **改单申请（OCR-）那一站**（2026-09-28）
 *
 * 台账 §9 B274 在补 11 之后只剩一条真证人缺口：号与回滚的那次真库注入**只做在异常处置单（EXC-）上**，
 * 改单申请（OCR-）当时是"假库行为 + 源码断言 + 真库号段实测"。本件把**同一刀**搬到 OCR 上：
 *   同一笔事务里审批单**真的写进去**之后，让变更单落库那一步抛错 ⇒ 真库回滚 ⇒
 *   变更单 0 张、该订单名下的 `order:change` 审批单 0 张、**SequenceRegister 的 OCR 序号也没前进**。
 *
 * ★ 与 EXC 那件（numberingRollbackRealDbB274）同构，因此也带同一条防空转断言：错误码必须是变更域
 *   自己的落库失败码（ORDER_STATUS_CONFLICT）。若是入口校验或 NO_REVIEWER_RESOLVED，说明根本没进事务
 *   ⇒ 后面那一格数"没变化"就是空的。③ 的阳性对照（不注入 ⇒ 真写库 +1）负责否证"什么都没发生"。
 *
 * ★ 与 EXC 那件的一处**口径差别**（不是抄漏）：EXC 数的是全表 `actionType=order:dr013-exception` 的张数，
 *   本件数的是**我自己挑那张订单名下**的 `order:change` 张数。原因是 OCR 的审批单按
 *   `requesterId + actionType + targetId` 幂等复用（B276）——如果挑到一张已有 pending 审批单的订单，
 *   ②那格会因"根本没新建审批单"而恒绿。所以挑单条件里硬性排掉"名下已有 order:change 审批单"的订单。
 *
 * ⚠️ 覆盖面：跑在本机业务库（测试库＝本机库口径），只建自己的行、按记下的 id 自清；
 *   证的是 PostgreSQL 事务回滚 + 事务内发号语义，不证 HTTP 层（那层读数的件已落盘、可重跑：server/scripts/b274-numbering-concurrency-drill.mjs）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createOrderChangeRequestService } from '../orderChangeRequestService';
import { createApprovalCreateService } from '../../approvals/approvalCreateService';
import { createApprovalRoutingService } from '../../approvals/approvalRoutingService';
import { todayLocalKey } from '../../shared/localDate';

const prisma = new PrismaClient();
const DAY = todayLocalKey().replace(/-/g, '');
const REG_KEY = `SEQREG_orderChangeRequest_${todayLocalKey()}`;
const REQUESTER = 'usr_demo_boss';
/** 本件造出来的变更单都用这一句理由标记 —— 精确等值，好数、好清，且不碰前缀计数（哨兵 ⑥c 的谓词） */
const MINE = '真库回滚证人 OCR：客户要求把交货期顺延两周，需走改单申请留痕（本件跑完按自造自清删掉）。';
const IMPACT = '影响交期与后续出运排期，需与客户确认新港船期；本合同项下暂无不可逆承诺，未收款未出运。';

async function seqValue(): Promise<number> {
  const row = await prisma.sequenceRegister.findUnique({ where: { id: REG_KEY }, select: { currentSeq: true } });
  return row?.currentSeq ?? 0;
}

/**
 * 挑一张"本件专用"的订单：已批准（Confirmed）、名下没有待批变更、
 * 且名下**从未有过** order:change 审批单（否则审批会被幂等复用 ⇒ ②那格恒绿）。
 */
async function pickUsableOrder(): Promise<string | null> {
  const orders = await prisma.order.findMany({
    where: { deletedAt: null, status: 'Confirmed' },
    select: { id: true }, take: 12, orderBy: { updatedAt: 'desc' },
  });
  for (const o of orders) {
    const [pendingCr, anyApproval] = await Promise.all([
      prisma.orderChangeRequest.findFirst({
        where: { orderId: o.id, status: 'Pending', deletedAt: null }, select: { id: true },
      }),
      prisma.approvalRequest.findFirst({
        where: { actionType: 'order:change', targetId: o.id }, select: { id: true },
      }),
    ]);
    if (!pendingCr && !anyApproval) return o.id;
  }
  return null;
}

async function counts(orderId: string) {
  const [cr, appr] = await Promise.all([
    prisma.orderChangeRequest.count({ where: { changeReason: MINE } }),
    prisma.approvalRequest.count({ where: { actionType: 'order:change', targetId: orderId } }),
  ]);
  return { cr, appr };
}

function makeService(client: any) {
  const routing = createApprovalRoutingService({ prisma: client } as any);
  const approvalCreateService = createApprovalCreateService({ prisma: client, routingService: routing } as any);
  return createOrderChangeRequestService({ prisma: client, approvalCreateService } as any);
}

/** 在事务内那一次变更单 create 上注入失败（先真写完、再抛）——抛点必须在审批单已写之后 */
function injectFailureAfterApproval(client: any) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction') {
        return async (fn: any) => (target as any).$transaction(async (tx: any) => {
          const realCreate = tx.orderChangeRequest.create.bind(tx);
          return fn(new Proxy(tx, {
            get(t2, p2) {
              if (p2 === 'orderChangeRequest') {
                return new Proxy(t2.orderChangeRequest, {
                  get(t3, p3) {
                    if (p3 === 'create') {
                      return async (a: any) => {
                        const r = await realCreate(a);
                        throw Object.assign(new Error('注入：变更单落库阶段故障'), { code: 'INJECTED' });
                      };
                    }
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
  // 只清本件记下的 id，删前不猜
  for (const id of createdIds) {
    const row = await prisma.orderChangeRequest.findUnique({ where: { id }, select: { id: true, approvalRequestId: true } });
    if (!row) continue;
    await prisma.auditLog.deleteMany({ where: { targetId: row.id } });
    await prisma.orderChangeRequest.delete({ where: { id: row.id } });
    if (row.approvalRequestId) await prisma.approvalRequest.delete({ where: { id: row.approvalRequestId } });
  }
  await prisma.$disconnect();
});

let orderId = '';
let before = { cr: 0, appr: 0 };
let seqBefore = 0;

describe('B274 真库回滚（OCR 那一站）：审批单已写入后失败 ⇒ 变更单没落库、审批单没留下、序号退回', () => {
  beforeAll(async () => {
    const picked = await pickUsableOrder();
    // ★ 跑不动就如实红，不许放宽挑单条件（放宽＝把恒绿的幂等复用当成回滚证人）
    expect(picked, '库里没有"无待批变更且名下无 order:change 审批单"的 Confirmed 订单 ⇒ 本件跑不动').toBeTruthy();
    orderId = picked!;
    before = await counts(orderId);
    seqBefore = await seqValue();
  });

  it('① 前提：事务键与发号真源同源、且起点是干净的（0 张变更单 / 0 张审批单）', async () => {
    expect(REG_KEY).toMatch(/^SEQREG_orderChangeRequest_\d{4}-\d{2}-\d{2}$/);
    expect(typeof seqBefore).toBe('number');
    expect(before.cr, '我自己那一档理由的存量应为 0（非 0 说明上一批没清干净，本件的 +1 读数就不可信）').toBe(0);
    expect(before.appr, '该订单名下的 order:change 审批单应为 0，否则审批会被幂等复用').toBe(0);
  });

  it('② ★ 注入失败那一笔：变更单 0、审批单 0、OCR 序号也没前进（号退回）', async () => {
    const svc = makeService(injectFailureAfterApproval(prisma) as any);
    const res: any = await svc.createChangeRequest({
      orderId, changeType: 'delivery',
      beforeSnapshot: { deliveryDate: '2026-10-15' }, afterDelta: { deliveryDate: '2026-11-30' },
      changeReason: MINE, requesterId: REQUESTER, impactSummary: IMPACT,
    });
    expect(res.ok, '这一笔必须失败').toBe(false);
    expect(String(res.error?.code),
      '★ 失败点必须在变更单落库那一步；若是入口校验或审批人解析，说明没进事务，这一格是空的')
      .toBe('ORDER_STATUS_CONFLICT');

    const after = await counts(orderId);
    expect(after.cr, '回滚后我自己那一档变更单不许变多').toBe(before.cr);
    expect(after.appr, '★ 回滚后该订单名下的审批单也不许变多（旧写法在事务外先建 ⇒ 这里会 +1 = 孤儿单）').toBe(before.appr);
    expect(await seqValue(), '★ 号必须一并退回：事务内 increment 被回滚 ⇒ 序号与动手前相同').toBe(seqBefore);
  });

  it('③ 阳性对照：同一形状不注入 ⇒ 变更单 +1、审批单 +1、序号 +1，号仍是 OCR-YYYYMMDD-NNN', async () => {
    const mid = await counts(orderId);
    const midSeq = await seqValue();
    const svc = makeService(prisma);
    const res: any = await svc.createChangeRequest({
      orderId, changeType: 'delivery',
      beforeSnapshot: { deliveryDate: '2026-10-15' }, afterDelta: { deliveryDate: '2026-12-05' },
      changeReason: MINE, requesterId: REQUESTER, impactSummary: IMPACT,
    });
    expect(res.ok, `对照笔应成功，否则②那格可能是"什么都没发生"：${JSON.stringify(res.error ?? res)}`).toBe(true);
    createdIds.push(res.data.changeRequest.id);

    const after = await counts(orderId);
    expect(after.cr, '对照笔真的写了库，否则②那格是空的').toBe(mid.cr + 1);
    expect(after.appr).toBe(mid.appr + 1);
    expect(await seqValue()).toBe(midSeq + 1);
    expect(String(res.data.changeRequest.requestNumber)).toMatch(new RegExp(`^OCR-${DAY}-\\d{3}$`));
  });
});
