/**
 * B274（评审 I-19）剩半场：异常处置单的**取号与审批单必须落在同一笔事务里**。
 *
 * 迁移前的两处真缺陷（都在**活路径**上）：
 *   1. 取号 = `count(前缀)+1` 的**先读后写**，而且发生在 `$transaction` **之外**
 *      ⇒ 两个并发请求数到同一个 count ⇒ 后落库那次撞 `@unique`（同族 PAYR 的守卫注释把这条写成事实，
 *      并且真库 5 路并发实测过"有界重试治标不治本"）。
 *   2. 审批单也在事务外先建 ⇒ 主单落库失败回滚后，**审批单已经存在**（孤儿单：审批中心会出现一张
 *      点不开任何主单的审批）。
 *
 * ★ 本文件的证人手法：顶层 prisma 用 Proxy 把「事务外的任何模型调用」变成**当场抛错**
 *   （见 utils/exceptionTxHarness.ts）。所以"挪回事务外"这种退化不是"日志里少了一行"，
 *   而是必然红 —— 判据不依赖我记住要数什么。
 *
 * ⚠️ 覆盖面（不许放大）：
 *   · 这里跑的是**假库**：证的是"调用发生在哪一层、号从哪来、回滚前主单没建"这三件事；
 *     **不**证 PostgreSQL 的原子 increment（那条真库并发证据在 `paymentRequests/__tests__/nextRequestNumberGuard.test.ts`，
 *     同一个 `sequenceService` 实现，EXC/OCR 只是新住进来的两个类型）。
 *   · 改单申请（OCR）那一站**没有**端到端用例，只有源码级守卫（numberingFailLoudB274.test.ts）
 *     ⇒ OCR 的"同一笔事务"这条**没有屏面/行为证人**，台账 §9 B274 因此不写"已闭"而写"半闭"。
 */
import { describe, expect, it } from 'vitest';
import { createExceptionService } from '../../exceptions/exceptionService';
import { makeExceptionHarness } from './utils/exceptionTxHarness';

const VALID_INPUT = {
  exceptionCategory: 'price_deviation', subCategory: 'manual_adjust', bypassedApprovalIds: [],
  exceptionReason: '客户临时改价导致毛利低于成本线，需要走例外放行以避免交付延误与违约索赔。',
  customerCommitment: '客户书面确认维持原价并追加下季订单',
  riskMitigationPlan: '限定本单一次性放行，同步登记偏差金额与责任人复核',
  targetType: 'Order', targetId: 'o_1', action: 'ship',
  validUntil: new Date(Date.now() + 86400000).toISOString(), maxUses: 1,
  responsibleOwnerId: 'u_owner', requesterId: 'u_req', notes: '', attachments: [],
  clientSuppliedReviewerId: null,
} as any;

function svc(h: ReturnType<typeof makeExceptionHarness>) {
  return createExceptionService({ prisma: h.prisma, approvalCreateService: h.approvalCreateService });
}

describe('B274：EXC 取号与审批单收进同一笔 $transaction（假库，硬前置版）', () => {
  it('① 取号发生在事务打开之后：SequenceRegister 的调用点全部带 tx 前缀', async () => {
    const h = makeExceptionHarness();
    const res: any = await svc(h).createExceptionRequest(VALID_INPUT);
    expect(res.ok, `入口没走到被改的那一段：${JSON.stringify(res.error ?? res)}`).toBe(true);

    const opened = h.state.log.indexOf('top.$transaction');
    const numbered = h.state.log.indexOf('tx.sequenceRegister.update');
    expect(opened, '事务没打开 ⇒ 本用例什么都没测').toBeGreaterThanOrEqual(0);
    expect(numbered, 'SequenceRegister 一次都没被调用 ⇒ 取号没走发号真源').toBeGreaterThanOrEqual(0);
    expect(numbered, '取号必须发生在 $transaction **打开之后**（先读后写的旧写法在这里会红）').toBeGreaterThan(opened);
  });

  it('② 号的面格式逐字不变（EXC-YYYYMMDD-NNN），且审批单与主单拿到的是同一个号', async () => {
    const h = makeExceptionHarness();
    const res: any = await svc(h).createExceptionRequest(VALID_INPUT);
    expect(res.ok).toBe(true);

    const created = h.state.excCreated[0];
    expect(String(created.exceptionNumber)).toMatch(/^EXC-\d{8}-\d{3}$/);
    expect(h.state.approvalInput.payload.exceptionNumber, '审批单里的号必须与主单一致（不一致⇒审批卡片显示的是别的单）')
      .toBe(created.exceptionNumber);
    expect(h.state.approvalInput.client, '审批服务必须收到事务句柄').toBe(h.state.txHandle);
  });

  it('③ 号由 SequenceRegister 递增给出，不再靠数行数：同一天两次创建 ⇒ 001 然后 002', async () => {
    const h = makeExceptionHarness();
    const first: any = await svc(h).createExceptionRequest(VALID_INPUT);
    const second: any = await svc(h).createExceptionRequest(VALID_INPUT);
    expect(first.ok && second.ok).toBe(true);

    const nums = h.state.excCreated.map((d: any) => String(d.exceptionNumber));
    expect(new Set(nums).size, `两次拿到同一个号（${nums.join(', ')}）⇒ 又回到先读后写`).toBe(2);
    expect(nums[0].slice(-3)).toBe('001');
    expect(nums[1].slice(-3)).toBe('002');
  });

  it('④ 审批单创建失败 ⇒ 主单一次都没建，档位仍原样透传（409 不许被抹成 500）', async () => {
    const err = Object.assign(new Error('解析不到审批人'), { code: 'NO_REVIEWER_RESOLVED' });
    const h = makeExceptionHarness({ approvalThrows: err });
    const res: any = await svc(h).createExceptionRequest(VALID_INPUT);

    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('NO_REVIEWER_RESOLVED');
    expect(res.error.statusCode, '这一档经 exceptionRoute 直接上屏，迁移前后必须同档').toBe(409);
    expect(h.state.excCreated.length, '审批失败后主单不许已经建出来（旧写法在事务外先建审批单⇒孤儿单）').toBe(0);
    expect(h.state.log.filter((l) => l.startsWith('tx.exc.create')).length).toBe(0);
  });

  it('⑤ 反面对照（证明本文件的硬前置真的会咬人）：绕开服务直接按旧形状取号 ⇒ 顶层 Proxy 当场抛', async () => {
    const h = makeExceptionHarness();
    let caught: any = null;
    try {
      // 旧写法的第一步：在事务**外**数今天的单量
      await (h.prisma as any).dr013ExceptionRequest.count({ where: {} });
    } catch (e: any) { caught = e; }
    expect(caught, '顶层模型调用没被拦 ⇒ "不许在事务外读写"这条判据是空的，本文件①④全是假绿').toBeInstanceOf(Error);
    expect(String(caught.message)).toContain('dr013ExceptionRequest.count');
  });
});
