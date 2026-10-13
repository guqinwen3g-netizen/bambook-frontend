/**
 * G-4 批：L/C 信用证门禁（`customs/lcGate.ts`）的判定守卫。
 *
 * ★ 这批最容易做出的错有两种，用例就照着这两条钉：
 *  ① **假门禁**：矩阵原文写 `paymentMethod='LC'`，但 `Order` 没这列（真库 information_schema 实测），
 *     照抄会做出一个**永不触发**的门禁（读 undefined ⇒ 恒不阻断 = 静默 fail-open）。
 *     ⇒ 有用例专门喂「paymentMethod='LC' 但 paymentInstrument='T/T'」，断言**不阻断**；
 *       另有正向对照喂 `paymentInstrument='L/C'`，断言**阻断**。两者缺一，判据都不成立。
 *  ② **fail-open 的"读不出来"**：期限是 String，解析失败若当"没问题"就等于给无证/过期证放行。
 *     ⇒ 断言 UNREADABLE 一定产 reason。
 */
import { describe, expect, it } from 'vitest';
import {
  decideLcGate, evaluateLcEligibility, isLcInstrument,
  LC_INVOICE_ISSUE_ACTION, LC_ORDER_CONFIRM_ACTION,
} from '../lcGate';

const AT = new Date('2026-09-21T00:00:00Z');
const lc = (over: Record<string, any> = {}) => ({
  id: 'LC_1', lcNumber: 'LC2026001', status: 'Issued', amount: 100000, currency: 'USD',
  expiryDate: '2026-12-31', shipmentDeadline: '2026-11-30', deletedAt: null, ...over,
});

describe('L/C 门禁 · 归一判定（付款方式认得对不对）', () => {
  it('★ 正向：`L/C`/`LC`/大小写空格差异都算信用证；T/T、D/P、O/A、null 都不算', () => {
    for (const v of ['L/C', 'LC', 'l/c', ' L - C ']) expect(isLcInstrument(v), `${v} 应判为信用证`).toBe(true);
    for (const v of ['T/T', 'TT', 'D/P', 'O/A', '', null, undefined]) expect(isLcInstrument(v), `${v} 不该被当信用证`).toBe(false);
  });

  it('★ 假门禁防护：判据源取 Order.paymentInstrument —— 订单列写 T/T 时，凭证侧写 LC 也不阻断（钉的是"读哪一列"）', () => {
    // 为什么钉这一条：矩阵原文写 `paymentMethod='LC'`，而 `Order` 上**没有这一列**（真库 information_schema 实测），
    // 照抄会做出条件恒 false 的永不触发门禁。
    // ⚠️ 但这条钉的是"读哪一列"，**不是**"订单列没写就等于不该卡"：
    //   `PaymentVoucher.paymentMethod='LC'` 而订单 `paymentInstrument` 为空的形态是当前最大的漏卡面
    //   （且正常录单路径产不出 instrument 值 —— 见 §9 B50 与 §12.1 混合结算那一条），
    //   收紧它要改的是判据源与录入侧，届时要连这条一起改，别当成"已证明的正确行为"。
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'T/T', lc: null, at: AT });
    expect(el.eligible).toBe(true);
    expect(el.blockingReasons).toEqual([]);
  });
});

describe('L/C 门禁 · 非信用证订单一律放行（不许误伤 69 张 T/T 单）', () => {
  it('T/T 订单即使一张证都没登记也放行', () => {
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: 'T/T', lc: null, at: AT }).eligible).toBe(true);
  });
});

describe('★ D106（v3.90 自裁 · 收紧）：混合结算也归本门禁 —— 按"词元"认，不按子串猜', () => {
  it('★ 正向：`T/T + L/C`、`30% T/T, 70% L/C`、`L/C + D/P` 这类混合结构都算"含 L/C 成分"', () => {
    for (const v of ['T/T + L/C', 'T/T+L/C', 'T/T;L/C', '30% T/T, 70% L/C', 'L/C + D/P', '70% L/C，其余 T/T']) {
      expect(isLcInstrument(v), `${v} 含 L/C 成分 ⇒ 必须进门禁（改前这条是 false）`).toBe(true);
    }
  });

  it('★ 精度对照（防"按子串猜"）：`LCL`／`ALC`／`TT+LCX` 这些**不是** L/C 词元，不许被认成信用证', () => {
    for (const v of ['LCL', 'ALC', 'TT+LCX', 'LCLX']) {
      expect(isLcInstrument(v), `${v} 只是含子串 LC，不是 L/C 成分`).toBe(false);
    }
    // 子串口径的对照：同一个串用 includes('LC') 会判 true ⇒ 证明上面那四条测的不是空气
    expect('LCL'.includes('LC'), '子串口径确实会误判 ⇒ 必须词元/边界口径').toBe(true);
  });

  it('★ 后果对照（这是 D106 真正要堵的洞）：混合单改前**完全不设防**，改后必须进门禁并按证的状态给结论', () => {
    const mixed = evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: '30% T/T, 70% L/C', lc: null, at: AT });
    expect(mixed.eligible, '含 L/C 却没登记证 ⇒ 必须阻断（改前这里放行）').toBe(false);
    expect(mixed.blockingReasons).toContain('LC_NOT_REGISTERED');
    // 反面一：真的没有 L/C 成分的单子，一张证都没有也必须照旧放行（不许把门禁开成"谁都卡"）
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: 'T/T', lc: null, at: AT }).eligible).toBe(true);
    // 反面二：混合单登记了可用证 ⇒ 放行（不许恒阻断）
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: '30% T/T, 70% L/C', lc: lc(), at: AT }).eligible).toBe(true);
    // 反面三：混合单登记了**已过期**的证 ⇒ 仍阻断（收紧不能只紧"有没有登记"这一层）
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: 'T/T + L/C', lc: lc({ expiryDate: '2026-01-01' }), at: AT }).blockingReasons).toContain('LC_EXPIRED');
  });
});

describe('L/C 门禁 · 信用证订单的阻断原因', () => {
  it('未登记 ⇒ LC_NOT_REGISTERED', () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: null, at: AT });
    expect(el.eligible).toBe(false);
    expect(el.blockingReasons).toEqual(['LC_NOT_REGISTERED']);
    expect(el.message).toContain('未登记信用证');
  });

  it('期限齐备且未过期 ⇒ 放行（正向对照，防判据恒阻断）', () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: lc(), at: AT });
    expect(el.blockingReasons, `不该有阻断原因：${el.blockingReasons?.join(',')}`).toEqual([]);
    expect(el.eligible).toBe(true);
  });

  it('已过期 ⇒ LC_EXPIRED（且消息带出证号，能定位到是哪张证）', () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: lc({ expiryDate: '2026-01-01' }), at: AT });
    expect(el.blockingReasons).toContain('LC_EXPIRED');
    expect(el.message).toContain('LC2026001');
  });

  it('★ 有效期字段读不出来 ⇒ 阻断（LC_EXPIRY_UNREADABLE），**不许把"解析失败"当合规**', () => {
    for (const bad of [null, '', '有效期另议', '31/12/2026']) {
      const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: lc({ expiryDate: bad }), at: AT });
      expect(el.blockingReasons, `expiryDate=${JSON.stringify(bad)} 应产出不可判定原因`).toContain('LC_EXPIRY_UNREADABLE');
    }
  });

  it('已注销的证 = 没有可用的证（fail-closed，不许因"登记过"就放行）', () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: lc({ status: 'Cancelled' }), at: AT });
    expect(el.blockingReasons).toContain('LC_CANCELLED');
  });
});

describe('L/C 门禁 · 分阶段差异（矩阵只在发运侧要求装运期与不符点）', () => {
  it('最迟装运期已过：发运阻断、确认不受影响（同一张证两个阶段结论必须不同）', () => {
    const late = lc({ shipmentDeadline: '2026-09-01' });
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: 'L/C', lc: late, at: AT }).blockingReasons).toContain('LC_SHIPMENT_DEADLINE_PASSED');
    expect(evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: late, at: AT }).eligible).toBe(true);
  });

  it('不符点（Discrepant）阻断发运（矩阵 :141），开票侧不由本模块加码', () => {
    const disc = lc({ status: 'Discrepant' });
    expect(evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: 'L/C', lc: disc, at: AT }).blockingReasons).toContain('LC_DISCREPANT');
    expect(evaluateLcEligibility({ stage: 'invoice:issue', orderInstrument: 'L/C', lc: disc, at: AT }).blockingReasons ?? []).not.toContain('LC_DISCREPANT');
  });
});

describe('L/C 门禁 · 查库层（decideLcGate 自取订单：手里只有 orderId 的调用点）', () => {
  /**
   * ★ mock 必须**校验 where**，不能无条件返回预置数据。
   *   初版正是 `findMany: async () => lcs` 忽略了入参 ⇒ 传错 id（把发票 id 当 orderId）、
   *   按 relationId 查证、或漏掉 `deletedAt: null`（软删的证被当成有效证）这三种错法**全部照绿**。
   *   本仓最贵的就是这种"断言永远不会失败"的守卫（R4-T4 复核抓到，2026-09-21）。
   */
  const mockPrisma = (order: any, lcs: any[], opts: { exceptions?: any[]; lcThrows?: boolean } = {}) => {
    const seen: any[] = [];
    const prisma: any = {
      order: { findUnique: async (a: any) => { seen.push({ delegate: 'order', ...a }); return order; } },
      letterOfCredit: {
        findMany: async (a: any) => {
          seen.push({ delegate: 'lc', ...a });
          if (opts.lcThrows) throw new Error('PrismaClientKnownRequestError: connection terminated');
          return lcs;
        },
      },
      dr013ExceptionRequest: { findMany: async () => opts.exceptions ?? [] },
    };
    return { prisma, seen };
  };
  /** 生效例外 fixture（scope 精确到 Order+action，与 creditExceptionGate 的同一形状） */
  const activeException = (action: string, over: any = {}) => ({
    id: 'EXC__1', exceptionNumber: 'EXC-20260921-001', status: 'ReviewerApproved',
    deletedAt: null, attachments: { files: [], scope: {
      targetType: 'Order', targetId: 'O1', action,
      responsibleOwnerId: 'explicit-exception-followup-owner',
      validUntil: new Date(AT.getTime() + 86400000).toISOString(), maxUses: 3, usedCount: 0, consumptions: [],
    } }, ...over,
  });

  it('信用证订单 + 库里 0 张证 ⇒ 阻断 LC_NOT_REGISTERED（真库现状：69 单全 T/T、LC 表 0 行 ⇒ 此路径为新数据才有影响）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: 'L/C' }, []);
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reasons).toContain('LC_NOT_REGISTERED');
  });

  it('★ 绑定关系可失败：查证的 where 必须按 orderId 且排除软删（漏一条就是"别人的证/已注销的证"替本单背书）', async () => {
    const { prisma, seen } = mockPrisma({ paymentInstrument: 'L/C' }, []);
    await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    const lcQuery = seen.find((s) => s.delegate === 'lc');
    expect(lcQuery, '没查 letterOfCredit = 门禁根本没落地').toBeTruthy();
    expect(lcQuery.where.orderId).toBe('O1');
    expect(lcQuery.where.deletedAt).toBeNull();
  });

  it('★ 一单两证、其中一张过期 ⇒ 仍阻断（不许用另一张把这张挑掉）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: 'L/C' }, [lc(), lc({ id: 'LC_2', lcNumber: 'LC2026002', expiryDate: '2026-02-01' })]);
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reasons).toContain('LC_EXPIRED');
  });

  it('订单查不到 ⇒ 本模块不下 LC 结论（交给调用方按"对象不存在"处理，避免把 404 报成信用证问题）', async () => {
    const { prisma } = mockPrisma(null, []);
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'X', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.via).toBe('not-applicable');
  });

  it('★ 矩阵第③条：条款不满足但有生效 DR-013 例外 ⇒ via=exception 放行并带回例外号（留痕在例外侧）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: 'L/C' }, [], { exceptions: [activeException(LC_ORDER_CONFIRM_ACTION)] });
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed, '已批例外必须能开这扇门，否则"豁免留痕"只是文档里的话').toBe(true);
    if (d.allowed) {
      expect(d.via).toBe('exception');
      expect(d.exceptionNumber).toBe('EXC-20260921-001');
      expect(d.reasons, '放行也要把被豁免的原因带出来，屏面上才说得清豁免了什么').toContain('LC_NOT_REGISTERED');
    }
  });

  it('★ 双向对照：同一张例外，action 写成信用门禁的 order:confirm ⇒ 不许开 LC 的门（防跨门禁越权）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: 'L/C' }, [], { exceptions: [activeException('order:confirm')] });
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed, '信用豁免顺带把信用证门禁开了 = 一次审批开两道门').toBe(false);
  });

  it('批准标记不能替代完整例外范围：缺责任人仍不能放行', async () => {
    const exception = activeException(LC_ORDER_CONFIRM_ACTION);
    delete exception.attachments.scope.responsibleOwnerId;
    const { prisma } = mockPrisma({ paymentInstrument: 'L/C' }, [], { exceptions: [exception] });
    const result = await decideLcGate({ prisma, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe('LC_GATE_BLOCKED');
  });

  it('★ 例外状态查不出来（审批服务/例外表故障）⇒ LC_EXCEPTION_CHECK_FAILED，且不许塌成 LC_GATE_BLOCKED', async () => {
    const prisma: any = {
      order: { findUnique: async () => ({ paymentInstrument: 'L/C' }) },
      letterOfCredit: { findMany: async () => [] },
      dr013ExceptionRequest: { findMany: async () => { throw new Error('approval service unreachable'); } },
    };
    const d = await decideLcGate({ prisma, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe('LC_EXCEPTION_CHECK_FAILED');
  });

  it('★ LC 表查询故障 ⇒ fail-closed 阻断且**不把原始异常抛给调用方**（发运侧直调本模块，抛出=原文进响应体）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: 'L/C' }, [], { lcThrows: true });
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'invoice:issue', exceptionAction: LC_INVOICE_ISSUE_ACTION, at: AT });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reasons).toEqual(['LC_QUERY_FAILED']);
      expect(JSON.stringify(d), '对外结构里不许出现原始异常文本').not.toContain('connection terminated');
    }
    // 阳性对照：非信用证订单即使表坏了也不该被牵连（门禁不适用 ⇒ 连查都不查）
    const tt = mockPrisma({ paymentInstrument: 'T/T' }, [], { lcThrows: true });
    const d2 = await decideLcGate({ prisma: tt.prisma as any, orderId: 'O1', stage: 'invoice:issue', exceptionAction: LC_INVOICE_ISSUE_ACTION, at: AT });
    expect(d2.allowed).toBe(true);
    expect(tt.seen.find((s: any) => s.delegate === 'lc'), 'T/T 订单不该查信用证表').toBeUndefined();
  });

  it('★ 有效期是"当天到日终"：at 落在有效期最后一天仍算有效（UTC 零点解析会早 8 小时误卡）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: 'L/C' }, [lc({ expiryDate: '2026-09-21' })]);
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed, JSON.stringify(d)).toBe(true);
  });

  it('★ 斜杠日期（12/05/2026）判"不可读"而不是猜月日序：外贸单据两种写法都常见，猜错=把已过期读成未过期', async () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: lc({ expiryDate: '12/05/2026' }), at: AT });
    expect(el.blockingReasons).toContain('LC_EXPIRY_UNREADABLE');
  });

  it('全角斜杠 `L／C` 与全角字母 `ＬＣ` 都算信用证（中文输入法默认产物；NFKC 前只去 ASCII 会静默失效）', () => {
    expect(isLcInstrument('L／C')).toBe(true);
    expect(isLcInstrument('ＬＣ')).toBe(true);
    expect(isLcInstrument('ｌ／ｃ')).toBe(true);
  });

  it('★ 状态是自由文本：不认识的 status 不许原样拼进对外文案（LC_STATUS_UNRECOGNIZED 而不是任意字符串）', () => {
    const el = evaluateLcEligibility({
      stage: 'order:confirm', orderInstrument: 'L/C',
      lc: lc({ status: 'Cancelled; drop table' }), at: AT,
    });
    expect(el.blockingReasons).toEqual(['LC_STATUS_UNRECOGNIZED']);
  });
});

// ════════════════════════════════════════════════════════════════════
// A19（拍板件 §2.2）：可空列的「空」≠ 合法值 —— 门禁必须有第三分支
// ════════════════════════════════════════════════════════════════════
// 病根：`Order.paymentInstrument` 是**无约束可空自由文本**（§9 B51），
//   而 `isLcInstrument(null) === false` ⇒「未录」与「录了 T/T」在门禁里**长得一模一样**，
//   两者都被判 `via='not-applicable'` 静默放行。
// 拍板口径：**空 = 「不知道」，不是「非信用证」** ⇒ 不阻断，但**必须可见**。
// ★ 本组用例改前必须红（`notices` 字段尚不存在 ⇒ 读到 undefined）。
describe('★ A19：付款方式「未录」是独立一档（不阻断，但必须可见）', () => {
  // 本 describe 自带 mock（上面那份 `mockPrisma` 是另一个 describe 的局部量，作用域不到这里）
  const mockPrisma = (order: any, lcs: any[] = []) => ({
    prisma: {
      order: { findUnique: async () => order },
      letterOfCredit: { findMany: async () => lcs },
      dr013ExceptionRequest: { findMany: async () => [] },
    },
  });

  it('★ 未录（null）⇒ 放行 + notices 含 LC_INSTRUMENT_NOT_RECORDED', () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: null, lc: null, at: AT });
    expect(el.eligible, '未录**不许**阻断（拍板：不阻断）').toBe(true);
    expect(el.blockingReasons).toEqual([]);
    expect(el.notices, '未录必须可见 —— 静默放行正是本族缺陷').toContain('LC_INSTRUMENT_NOT_RECORDED');
  });

  it('★ 反向对照：录了 T/T ⇒ 放行且**没有**未录提示（两档必须分得开）', () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'T/T', lc: null, at: AT });
    expect(el.eligible).toBe(true);
    expect(el.notices).toEqual([]);
  });

  it('★ 空白串 / 全角空格也算「未录」（trim 后为空 ≠ 已录）', () => {
    for (const v of ['', '   ', '\u3000', null, undefined]) {
      const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: v as any, lc: null, at: AT });
      expect(el.notices, '空串族应算未录').toContain('LC_INSTRUMENT_NOT_RECORDED');
    }
  });

  it('★ 真信用证路径**不许**带未录提示（否则这个码会变成人人无视的噪音）', () => {
    const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: 'L/C', lc: lc(), at: AT });
    expect(el.eligible).toBe(true);
    expect(el.notices).toEqual([]);
  });

  it('★ decideLcGate 放行分支必须把 notices 带出来（结构化回传，不是拼好的 message）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: null }, []);
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.via).toBe('not-applicable');
      expect(d.notices).toContain('LC_INSTRUMENT_NOT_RECORDED');
    }
    // ★ 不许把拼好的中文塞进结构化回传（本仓 rawErrorLeakRatchet 计过这一类新站点）
    expect(d).not.toHaveProperty('message');
  });

  it('★ 已录 T/T 的放行分支 notices 为空（防"一律挂提示"的假可见）', async () => {
    const { prisma } = mockPrisma({ paymentInstrument: 'T/T' }, []);
    const d = await decideLcGate({ prisma: prisma as any, orderId: 'O1', stage: 'order:confirm', exceptionAction: LC_ORDER_CONFIRM_ACTION, at: AT });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.notices).toEqual([]);
  });
});
