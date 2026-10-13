/**
 * §2 G3 判据 L-A 第一刀（v3.14）· 理赔域的「钱/货没填」必须在入口就拒，不许静默按 0 落库
 *
 * 病（不是设想，是普查尺量的：`node scripts/check-fail-open-inventory.mjs` 在**改动前的 HEAD 树上**跑一遍，
 *   L-A 里 `E3*` 一族共 44 处，其中**理赔域 13 处**（`claimCaseService` 4 · `claimSettlement` 4 ·
 *   `creditNoteService` 3 · `claimRoute` 1 · `repairWorkOrderService` 1，全是 `E3-inline nullish` 一种形状）。
 *   同一把尺当场读数 L-A 191 → 本批后 178，服务器侧 141 → 128 ⇒ 掉的 13 处正是上面那 13 行，一处不多一处不少。
 *   形状一律是
 *     `const amount = new Prisma.Decimal(input.amount ?? 0);` → 之后某处 `if (amount.lte(0)) return fail(...)`
 *   两件事同时坏了：
 *   ① "没填"与"填了 0"被合并成同一个值 ⇒ 用户收到的提示是"须为正数（当前 0）"（**误导**：他没填 0）；
 *   ② 更坏的是 `claimSettlement` / `claimRoute` 把 `?? 0` **跨函数边界**传下去 ⇒
 *      "到底拒不拒"取决于被调方那一句校验有没有写、写在第几行 —— 那就是 L-A 说的 fail-open 形状。
 *
 * ★ 本文件的四条纪律（都是前几批复核教出来的）：
 *   ① 断言"没落库"要数**写动词调用次数**，只看返回码不算证伪（返回 400 但先写了库，是最坏的组合）；
 *   ② ~~每个拒绝用例都配一条合法值对照~~ —— **复核 I-3 抓出这句写大了**（实际只有 ⑥ 配了）。
 *      改法不是补五条假对照，而是让那一条同时负更重的责：⑥ 里钉 `writes.length > 0`
 *      ⇒ 一旦替身的写通道接不上，这一条红，其余五处 `toEqual([])` 的"零写库"就当场失去意义（可被看见）。
 *   ③ 路由那一格**不 mock 服务层** ⇒ 400 必须由真的解析器给（mock 掉服务，测的就只是我的桩）；
 *   ④ 「没填」与「填 0」的提示必须不同 ⇒ 这条区分本身就是本批的产品改进，得钉住。
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { parsePositiveDecimal, parseNonNegativeDecimal } from '../../shared/moneyInput';

vi.mock('../../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
/** 路由格只要过身份与 scope；服务层**不 mock**（见纪律③） */
let actor: any = null;
vi.mock('../../auth/middleware', () => ({ extractActorFromRequest: () => actor }));
vi.mock('../../auth/permissionGuard', () => ({
  hasScopeOnRequest: (req: any, scope: string) => ((req as any).actor?.permissions ?? []).includes(scope),
}));
vi.mock('../../audit/routeAudit', () => ({ writeRouteAuditLog: vi.fn(async () => 'alog_1') }));
vi.mock('../../approvals/approvalRoutingService', () => ({ createApprovalRoutingService: () => ({ resolveReviewerByDepartment: vi.fn() }) }));
vi.mock('../../approvals/approvalCreateService', () => ({ createApprovalCreateService: () => ({ createBusinessApproval: vi.fn() }) }));

import { createClaimRouter } from '../claimRoute';
import { addDisposition } from '../claimCaseService';
import { applyCreditNote, createCreditNote } from '../creditNoteService';
import { createRepairWorkOrder } from '../repairWorkOrderService';
import { executeDisposition } from '../claimSettlement';

/** 记账型替身：任何写动词都被数着 ⇒ "拒了但还是写了"这类错当场红（纪律①） */
function makePrisma(rows: Record<string, any> = {}) {
  const writes: string[] = [];
  const delegate = (name: string) => new Proxy({}, {
    get: (_t, op: any) => {
      if (['create', 'update', 'upsert', 'delete', 'deleteMany', 'updateMany', 'createMany'].includes(String(op))) {
        return async () => { writes.push(`${String(name)}.${String(op)}`); return {}; };
      }
      if (String(op) === 'findUnique' || String(op) === 'findFirst') return async () => rows[name] ?? null;
      if (String(op) === 'findMany') return async () => rows[name] ? [rows[name]] : [];
      if (String(op) === 'count') return async () => 0;
      return async () => null;
    },
  });
  const prisma: any = new Proxy({}, {
    get: (_t, name: any) => {
      if (String(name) === '$transaction') return async (fn: any) => fn(new Proxy({}, { get: (_2, m: any) => delegate(String(m)) }));
      if (String(name) === '$disconnect' || String(name) === '$connect') return async () => undefined;
      return delegate(String(name));
    },
  });
  return { prisma, writes };
}

describe('A · 入口读法：「没填 / 不是数 / 填了 0」是三种不同的事（此前都被压成 0）', () => {
  it('① 没填 ⇒ reason=missing，且提示里出现"未填写"（此前是"须为正数（当前 0）"，用户不知道自己漏填）', () => {
    for (const v of [undefined, null]) {
      const r = parsePositiveDecimal(v, '退款金额');
      expect(r.ok, `值 ${JSON.stringify(v)} 不该被接受`).toBe(false);
      expect((r as any).reason, `值 ${JSON.stringify(v)} 的归类`).toBe('missing');
      expect((r as any).message).toContain('未填写');
    }
    // ★ v3.15 复核 B-2 逼出来的一格：**空白串不是"没填"**。JS 的 `Number('') === 0`，而调用方兜底用 `??`
    //   ⇒ `0 ?? 默认` 取 0 不吞。若把 `''` 算成 missing，调用方就会去抬**默认金额**（实测：从"开 0 元单"变成"开 120 元单"）
    //   ⇒ 方向是凭空多出钱。所以 `''` / `'   '` 归 not-a-number（照样拒，但绝不触发兜底）。
    for (const v of ['', '   ', '\t']) {
      const r = parsePositiveDecimal(v, '退款金额');
      expect(r.ok, `空白串 ${JSON.stringify(v)} 不该被接受`).toBe(false);
      expect((r as any).reason, `空白串 ${JSON.stringify(v)} 必须归 not-a-number，不能被当成"没填"去走默认值`)
        .toBe('not-a-number');
    }
    // ★ 复核 I-4：正数档的提示不许说"要写 0 请填写 0"（这里 0 就是不合法，那样说等于把用户推向必然被拒的填法）
    expect((parsePositiveDecimal(0, '退款金额') as any).message).toContain('0 不合法');
  });

  it('② 填 0 / 负数 ⇒ not-positive（口径 A6 早已拒绝 0 元，本条钉住"没放宽判据"）', () => {
    for (const v of [0, '0', -5, '-0.01']) {
      const r = parsePositiveDecimal(v, '核销金额');
      expect(r.ok, `值 ${JSON.stringify(v)} 不该被接受`).toBe(false);
      expect((r as any).reason).toBe('not-positive');
    }
  });

  it('③ 混进字母 / NaN / Infinity / 数组 ⇒ not-a-number（★ 复核 I-2 之后按实测改写：改动前 "12abc" 是**抛** [DecimalError] ⇒ 路由 catch 答 500，而 Decimal(NaN).lte(0) 是 false ⇒ **根本不拒**）', () => {
    // `[5]` 这一格是本批自己探出来的：`String([5]) === '5'` ⇒ JS 的隐式换算会把一个数组当成 5 收下来。
    // 它不在原病清单里（原判据只处理"缺失/0"），但一个"入口读数口"若还收数组，就是把病换个地方放。
    for (const v of ['12abc', NaN, Infinity, {}, [], [5], ['5'], true]) {
      expect(parsePositiveDecimal(v, '返修数量').ok, `值 ${JSON.stringify(v)} 不该被接受`).toBe(false);
      expect((parsePositiveDecimal(v, '返修数量') as any).reason, `值 ${JSON.stringify(v)} 的归类`).toBe('not-a-number');
    }
  });

  it('④ ★ 恒真对照：合法值必须过，且**十进制串原样保留**（不四舍五入、不转科学计数 ⇒ 精度不许在这一步丢）', () => {
    expect(parsePositiveDecimal('10.50', '金额')).toMatchObject({ ok: true, value: '10.50' });
    expect(parsePositiveDecimal(1234.5678, '金额')).toMatchObject({ ok: true, value: '1234.5678' });
    // Decimal 进得来（对象形状走它自己的 toString），且值不丢：比较用 Decimal，不用字符串字面量猜
    const fromDecimal = parsePositiveDecimal(new Prisma.Decimal('0.0000001'), '金额') as any;
    expect(fromDecimal.ok).toBe(true);
    expect(new Prisma.Decimal(fromDecimal.value).eq('0.0000001'), `实得 ${fromDecimal.value}`).toBe(true);
    expect(parsePositiveDecimal(9007199254740993n, '数量')).toMatchObject({ ok: true, value: '9007199254740993' });
  });
});

describe('B · 服务层：拒了就必须一行都没写', () => {
  let db: ReturnType<typeof makePrisma>;
  beforeEach(() => { db = makePrisma(); });

  it('⑤ 处置（金额类）没填金额 ⇒ VALIDATION_FAILED + 提示含"未填写" + 零写库', async () => {
    const r = await addDisposition(db.prisma, 'CLM_1', { kind: 'Allowance', currency: 'USD' } as any, 'u1');
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('VALIDATION_FAILED');
    expect(r.error?.message).toContain('未填写');
    expect(db.writes, `被拒的请求却写了这些：${JSON.stringify(db.writes)}`).toEqual([]);
  });

  it('⑥ 退款单没填金额 ⇒ 同上；合法金额仍成功（纪律②）', async () => {
    const bad = await createCreditNote(db.prisma, { currency: 'USD' } as any, 'u1');
    expect(bad.error?.code).toBe('VALIDATION_FAILED');
    expect(bad.error?.message).toContain('未填写');
    expect(db.writes).toEqual([]);
    const good = await createCreditNote(db.prisma, { amount: 500, currency: 'USD', customerName: 'ACME' } as any, 'u1');
    expect(good.ok, JSON.stringify(good.error)).toBe(true);
    // ★ 反恒真对照（复核 I-3 逼出来的更要紧的一条）：合法值必须**真的写了库** ——
    //   如果替身的写动词永远数不到东西，那本文件那五处 `toEqual([])` 全是空的，"拒了就没落库"一句都不成立。
    expect(db.writes.length, '成功用例一行都没写 ⇒ 写替身没接上，"零写库"那些断言就都是恒真').toBeGreaterThan(0);
    expect(db.writes.filter((w) => /\.create$/.test(w)).length).toBeGreaterThan(0);
  });

  it('⑦ 核销没填金额 ⇒ 在**碰数据库之前**就被拒（此前是带着 0 往下走，靠被调方兜）', async () => {
    const r = await applyCreditNote(db.prisma, 'CN_1', { appliedAmount: undefined } as any, 'u1');
    expect(r.error?.code).toBe('VALIDATION_FAILED');
    expect(r.error?.message).toContain('未填写');
    expect(db.writes, `核销被拒却不该有任何写：${JSON.stringify(db.writes)}`).toEqual([]);
  });

  it('⑧ 返修工单数量没填 ⇒ VALIDATION_FAILED；填了 0 也拒（口径不变）', async () => {
    const missing = await createRepairWorkOrder(db.prisma, { claimCaseId: 'C1', workStationId: 'WS1' } as any, 'u1');
    expect(missing.error?.message).toContain('未填写');
    const zero = await createRepairWorkOrder(db.prisma, { claimCaseId: 'C1', workStationId: 'WS1', quantity: 0 } as any, 'u1');
    expect(zero.error?.message).toContain('须为正数');
    expect(db.writes).toEqual([]);
  });

  it('⑨ ★ 处置行金额为空（数据不一致）⇒ 执行阶段拒绝，且不许按 0 出退款单/加汇总', async () => {
    const { prisma, writes } = makePrisma({
      claimDisposition: { id: 'CLMDISP_1', kind: 'Allowance', status: 'Approved', claimCaseId: 'CLM_1', amount: null, quantity: null },
      claimCase: { id: 'CLM_1', status: 'Open', deletedAt: null, customerRelationId: 'R1', creditCurrency: 'USD' },
    });
    const r = await executeDisposition(prisma, 'CLMDISP_1', 'u1');
    expect(r.ok, '金额为空的处置被"成功执行"了 ⇒ 0 元退款单已生成').toBe(false);
    expect(r.error?.code).toBe('INVALID_STATE');
    expect(r.error?.message, '要说是数据不一致，不是让用户去改输入').toMatch(/数据不一致|未填写/);
    expect(writes, `执行被拒却不该有任何写：${JSON.stringify(writes)}`).toEqual([]);
  });

  /**
   * ★ 复核 B-2 补的一格：`claimSettlement` 里我加了**两支**守卫（钱 `:95` / 货 `:104`），而 ⑨ 用的是
   *   `Allowance`（只走钱腿）⇒ 把货那一支整段删掉，本文件 10 例与理赔域既有测试**全绿**（复核实测）。
   *   也就是"新守卫的一半没人守"。这一格用动货种类（`Replace`）把另一半钉住。
   */
  it('⑩b ★ 动货处置（Replace）数量为空 ⇒ 同样拒绝，且提示点名的是**数量**不是金额', async () => {
    const { prisma, writes } = makePrisma({
      claimDisposition: { id: 'CLMDISP_2', kind: 'Replace', status: 'Approved', claimCaseId: 'CLM_1', amount: null, quantity: null, unit: 'pcs' },
      claimCase: { id: 'CLM_1', status: 'Open', deletedAt: null, caseNumber: 'CLM-X', customerRelationId: 'R1' },
    });
    const r = await executeDisposition(prisma, 'CLMDISP_2', 'u1');
    expect(r.ok, '数量为空的补发处置被"成功执行"了 ⇒ 会凭空出一张补发出运单').toBe(false);
    expect(r.error?.code).toBe('INVALID_STATE');
    expect(String(r.error?.message)).toContain('数量');
    expect(String(r.error?.message)).not.toContain('金额'); // 别把货的问题报成钱的问题
    expect(writes, `执行被拒却不该有任何写：${JSON.stringify(writes)}`).toEqual([]);
  });
});

describe('C · 路由层（服务层不 mock，400 由真解析器给）', () => {
  it('⑩ POST /credit-notes/:id/apply 空 body ⇒ 400 + 码 VALIDATION_FAILED + 零写库', async () => {
    // Updated financial gate and its real current identity/parent read prerequisites.
    // The money parser and all zero-write assertions below remain unchanged.
    actor = { userId: 'u1', roles: ['owner'], permissions: ['invoices:reconcile'] };
    const { prisma, writes } = makePrisma({
      userAccount: { id: 'u1', status: 'active', deletedAt: null, roles: [{ roleId: 'role-finance', role: { permissions: [] } }] },
      userPermissionOverrides: { scope: 'invoices:reconcile' },
      creditNote: { id: 'CN_1', deletedAt: null, claimCaseId: null, logicalClaimCaseId: null, customerRelationId: null },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/claims', createClaimRouter({ prisma } as any));
    const res = await request(app).post('/api/claims/credit-notes/CN_1/apply').send({});
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(String(res.body.message)).toContain('未填写');
    expect(writes, `入口拒掉的请求不该有任何写：${JSON.stringify(writes)}`).toEqual([]);
    actor = null;
  });
});

/**
 * ★ D108（v3.96 自裁 · 收紧）：**金额写法只认一种** —— 科学计数法 / 前导小数点 / 末尾小数点 / 加号一律拒。
 *
 * 病（§9 B141 实测）：`1e3` · `.5` · `1.` · 带前后空格的数 · `+5` 这五个字面量在**发票/付款凭证**侧被 400 拒，
 *   在**理赔/收费事项**侧被**接受并换算成具体数字** ⇒ 六份实现各认一套"什么叫合法金额"。
 * 处置：六处共用同一份读数口（`shared/moneyInput` 的 `readDecimal`）**往窄收**：只认"可选负号 + 数字 + 可选小数"。
 * ⚠️ 三条边界写在用例里，免得下一刀误伤：① 两端空格 trim 后仍有效；② **负数仍要报"不能为负"**（不许降级成格式错）；
 *   ③ **数字类型不受影响**（`String(1e-7)` 长成 `"1e-7"`，但那是 number 的 toString，不是用户写的串）。
 */
describe('★ D108 · 金额写法往窄收（六个曾各认一套的字面量，现在一律拒）', () => {
  const P = (v: unknown) => parsePositiveDecimal(v, '金额') as any;
  const N = (v: unknown) => parseNonNegativeDecimal(v, '金额') as any;

  it('★ 五个"宽口径"写法一律拒，且理由必须是"不是合法数字"（改前它们会被换算成 1000 / 0.5 / 1 / 5 …收下）', () => {
    for (const v of ['1e3', '.5', '1.', '+5', '1E+2']) {
      expect(P(v).ok, `字符串 '${v}' 不许再被接受`).toBe(false);
      expect(N(v).ok, `字符串 '${v}' 不许再被接受`).toBe(false);
      expect(P(v).reason, `'${v}' 要按"不是合法数字"拒`).toBe('not-a-number');
    }
  });

  it('反面对照三格：常规写法照旧 / 两端空格 trim 后有效 / 负数仍走"不能为负"（不许降级成格式错）', () => {
    expect(P('0.5').ok, '常规小数照旧').toBe(true);
    expect(P(' 42 ').ok, 'D108 明说"前后空格按 trim 后再校验"⇒ 有效').toBe(true);
    expect(N('0').ok, '0 在非负档仍合法（B137 ⑥）').toBe(true);
    const neg = N('-5');
    expect(neg.ok).toBe(false);
    expect(neg.reason, '负数要被认成"负"，不许因为收紧写法而变成"不是合法数字"').toBe('negative');
    expect(neg.message).toContain('不能为负');
  });

  it('★ 反"顺手误伤"：**数字类型**不受字符串写法收紧影响（大数/极小数会 toString 成 1e+21 / 1e-7）', () => {
    expect(P(1e-7).ok, 'number 走数值校验，不许拿它的 toString 去过字符串正则').toBe(true);
    expect(N(0.0000001).ok).toBe(true);
    expect(P(1e21).ok).toBe(true);
    expect(P(Number.NaN).ok).toBe(false);
    expect(P(Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});
