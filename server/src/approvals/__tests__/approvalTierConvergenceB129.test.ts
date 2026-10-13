/**
 * B129 收口（v3.12）：「解析不到审批人 ⇒ 409」这条规则从此**只有一处实现**（注册表）。
 *
 * 业务后果：这条规则原先在 6 处各写一遍（有的按 `e.code` 猜、有的按异常**文本**猜）。
 * 多写一份不等于答错一次，但等于"改一处漏五处"——同一枚码在五个域可能给出五个档，
 * 前端就没法按码分支（§12 D33 / G6.3 立的正是这一条）。
 *
 * ★ 本文件只测**活路径**上的一件事：收口之后，档位仍然是 409，且**故障仍然是 500**。
 *   错误对象来自真的 `approvalRoutingService`（喂一个查不到人的 stub），期望档位来自真的注册表
 *   ⇒ 两处都不是我在测试里重抄的字面（v3.06 同族做法）。
 *
 * ⚠️ 覆盖面要说清：六站里本文件**端到端只跑异常域那一站**（`exceptionService` → 结果体 →
 *   `exceptionRoute.ts:68` 的 `res.status(error.statusCode)`），另外三站（内部结算价、订单变更、
 *   付款申请）是**同一个形状**（`fail(code, msg, 档位)` 再由路由透传 statusCode），
 *   理赔站与订单站是路由级 `res.status(statusFromError(e, 500))`。
 *   ⇒ 所以"另五站也答 409"这句话的证据是：① 档位来源已统一到真尺（下面第 3 组是源码级断言），
 *   ② 真尺对这一枚码答 409（第 1 组），而不是"我为六站各写了一遍 mock"。
 *   要逐站端到端的话属于下一批的活（且要先补 B123，否则文案那半仍然裸奔）。
 */
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { NO_REVIEWER_RESOLVED, createApprovalRoutingService } from '../approvalRoutingService';
import { lookupErrorCode } from '../../shared/errorCodes';
import { statusFromError } from '../../shared/bizStatus';
import { stripComments } from '../../shared/__tests__/utils/sourceScan';
import { createExceptionService } from '../../exceptions/exceptionService';
import { makeExceptionHarness } from '../../sequence/__tests__/utils/exceptionTxHarness';

const SERVER = path.resolve(__dirname, '..', '..', '..');   // server/

/** 真的路由解析服务 + 查不到人的 stub ⇒ 抛出**真实形状**的 NO_REVIEWER_RESOLVED */
async function realReviewerError(): Promise<any> {
  const routing = createApprovalRoutingService({
    prisma: { userAccount: { findFirst: async () => null } } as any,
  });
  try {
    await routing.resolveReviewerByDepartment('u_nobody');
    throw new Error('前提坏了：本该解析不到审批人');
  } catch (e: any) {
    expect(e?.code, '这一枚错误的 code 必须真的是 NO_REVIEWER_RESOLVED（否则下面全部断言都是空的）').toBe(NO_REVIEWER_RESOLVED);
    return e;
  }
}

describe('B129 · 收口后档位仍由注册表单点给出', () => {
  it('① 前提：注册表就是 409，且真尺对这一枚码也答 409（两句话都得成）', async () => {
    const e = await realReviewerError();
    expect(lookupErrorCode(NO_REVIEWER_RESOLVED)?.status, '注册表档位').toBe(409);
    expect(statusFromError(e, 500), '真尺吃同一个错误对象必须给同一个档（这就是收口的定义）').toBe(409);
  });

/** 一份**能过完入口校验**的申请：`exceptionReason` 有 ≥30 字下限（DR013-C3），类别要在典内。
 *  ★ 为什么非要写全：第一版我给了 5 个字的理由，结果请求被入口校验挡在 400，
 *    我差点把"档位答 400"读成产品缺陷 —— 它其实是**我的 fixture 根本没走到被改的那条 catch**。
 *    所以下面每一格都先断"这一站的失败确实是审批那一支"。 */
const VALID_INPUT = {
  exceptionCategory: 'price_deviation', subCategory: 'manual_adjust',
  exceptionReason: '客户临时改价导致毛利低于成本线，需要走例外放行以避免交付延误与违约索赔。',
  customerCommitment: '客户书面确认维持原价并追加下季订单',
  riskMitigationPlan: '限定本单一次性放行，同步登记偏差金额与责任人复核',
  targetType: 'Order', targetId: 'o_1', action: 'ship',
  validUntil: new Date(Date.now() + 86400000).toISOString(), maxUses: 1,
  responsibleOwnerId: 'u_owner', requesterId: 'u_req', notes: '', attachments: [],
  clientSuppliedReviewerId: null,
} as any;

function svcThatThrows(err: unknown) {
  // ★ B274 后：取号与审批单都在同一笔 $transaction 内，所以 stub 不能再只给一个 `count`——
  //   那会让服务在第一行就撞 TypeError，档位被测成 500（我在 2026-09-28 实测到这一格确实红了）。
  //   现在复用 B274 的假库证人：顶层任何模型调用**当场抛错**，所以"档位来自审批那一支"这句话是硬的。
  const h = makeExceptionHarness({ approvalThrows: err });
  return createExceptionService({ prisma: h.prisma, approvalCreateService: h.approvalCreateService });
}

/** 断言"确实走到了审批那一支"（而不是被入口校验/别的分支提前挡掉） */
function assertReachedApprovalBranch(res: any) {
  expect(res.ok, '这一站应当失败在审批创建那一步').toBe(false);
  expect(String(res.error?.code),
    `失败落在了别的分支（code=${res.error?.code}）⇒ 本格什么都没测到，先修 fixture 再谈档位`).toMatch(
    new RegExp(`^(${NO_REVIEWER_RESOLVED}|P\\d{3,4}|.*_FAILED)$`));
}

  it('① 前提：注册表就是 409，且真尺对这一枚码也答 409（两句话都得成）', async () => {
    const e = await realReviewerError();
    expect(lookupErrorCode(NO_REVIEWER_RESOLVED)?.status, '注册表档位').toBe(409);
    expect(statusFromError(e, 500), '真尺吃同一个错误对象必须给同一个档（这就是收口的定义）').toBe(409);
  });

  it('② 活路径：exceptionService 的结果体里 statusCode 仍是 409（经 exceptionRoute:68 直接上屏）', async () => {
    const reviewerErr = await realReviewerError();
    const res: any = await svcThatThrows(reviewerErr).createExceptionRequest(VALID_INPUT);
    expect(res.error.code, '必须先证明走的是审批那一支').toBe(NO_REVIEWER_RESOLVED);
    expect(res.error.statusCode, '收口前这里是 `e?.code === ... ? 409 : 500`，收口后必须仍是 409').toBe(409);
    expect(res.error.code, '响应体里的 code 是对外契约，本批一行未动').toBe(NO_REVIEWER_RESOLVED);
  });

  it('③ 反面对照（同一条 catch）：数据层故障与认不出的故障都不许被抬成"用户错"，也不许被 409 吃掉', async () => {
    const r1: any = await svcThatThrows(
      Object.assign(new Error('Unique constraint failed on the fields'), { code: 'P2002' }),
    ).createExceptionRequest(VALID_INPUT);
    assertReachedApprovalBranch(r1);
    expect(r1.error.statusCode, '唯一键冲突这类数据层故障走真尺的数据层档 ⇒ 500（不是 409、也不是默认 400）').toBe(500);

    const r2: any = await svcThatThrows(new Error('totally unexpected')).createExceptionRequest(VALID_INPUT);
    assertReachedApprovalBranch(r2);
    expect(r2.error.statusCode, '认不出的错误显式兜底 500 ⇒ 这正是每站都要写第二个参数的理由（默认档是 400）').toBe(500);
  });

  it('④ 源码级断言：六站都不再自带"码→档"手写表（判据自己也要证明它认得出旧形状）', () => {
    const files = [
      'src/claims/claimRoute.ts', 'src/orders/routeV2.ts', 'src/exceptions/exceptionService.ts',
      'src/internalTrade/internalTransferService.ts', 'src/orderChanges/orderChangeRequestService.ts',
      'src/paymentRequests/paymentRequestService.ts',
    ];
    const OLD = /NO_REVIEWER_RESOLVED['"]?\s*\?\s*4\d\d|includes\('NO_REVIEWER_RESOLVED'\)/;
    // 正面对照：detector 对"改前的形状"必须真的认（否则这一组是恒绿的）
    expect(OLD.test("const status = e?.code === 'NO_REVIEWER_RESOLVED' ? 409 : 500;"),
      'detector 认不出改前的写法 ⇒ 下面那圈"六站都干净"是空的').toBe(true);
    for (const f of files) {
      // ★ 必须先剥注释再判（B76 那一课：注释里的旧写法会把守卫刷成一堵墙）——
      //   本批我在 routeV2 的注释里引用了改前写法做说明，不剥注释就会自我打脸。
      const src = stripComments(readFileSync(path.join(SERVER, f), 'utf8'));
      expect(OLD.test(src), `${f} 里还留着本地"码→档"表 ⇒ 收口没做完`).toBe(false);
    }
  });
});
