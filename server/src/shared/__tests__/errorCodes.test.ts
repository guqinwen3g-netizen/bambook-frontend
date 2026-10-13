/**
 * resolveError 语义钉子（S0-A Task 2）
 * 三条不可让的语义：
 *   1. 业务错误（自带 code+statusCode）→ 原文透传，用自己的状态码
 *   2. 未预期异常 → 注册表文案；注册表没这个词 → 通用文案。**原始 message 一个字都不许出现。**
 *   3. details / gateDetails 必须随附（出运门禁 409 的前端契约）
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES, GENERIC_ROUTE_ERROR_MESSAGE, lookupErrorCode, resolveError,
} from '../errorCodes';

describe('resolveError', () => {
  it('业务错误：透传 code/message，且用它自己的 statusCode', () => {
    const e = Object.assign(new Error('币种不一致'), { code: 'CURRENCY_MISMATCH', statusCode: 400 });
    expect(resolveError(e, 'CREATE_FAILED')).toEqual({
      status: 400, code: 'CURRENCY_MISMATCH', message: '币种不一致',
    });
  });

  it('业务错误带 gateDetails → details 必须随附', () => {
    const details = [{ orderId: 'o1', missing: ['船样确认'] }];
    const e = Object.assign(new Error('出运门禁未通过'), {
      code: 'GATE_BLOCKED', statusCode: 409, gateDetails: details,
    });
    const r = resolveError(e, 'SHIP_FAILED');
    expect(r.status).toBe(409);
    expect(r.code).toBe('GATE_BLOCKED');
    expect(r.details).toEqual(details);
  });

  it('未预期异常：Prisma 原文一个字都不许进响应', () => {
    const raw = 'PrismaClientKnownRequestError: Invalid `prisma.riskAlert.findMany()` invocation in /Users/panda1/bambook-main-api/server/src/risk/riskService.ts:244: Unknown argument `deletedAts`';
    const r = resolveError(new Error(raw), 'ALERT_LIST_FAILED');
    expect(JSON.stringify(r)).not.toContain('Prisma');
    expect(JSON.stringify(r)).not.toContain('bambook-main-api');
    expect(JSON.stringify(r)).not.toContain('deletedAts');
    expect(r.status).toBe(500);
    expect(r.code).toBe('ALERT_LIST_FAILED');
  });

  it('注册表里有的 fallback code → 用注册表文案（不是通用文案）', () => {
    const r = resolveError(new Error('内部细节'), 'OVERVIEW_FAILED');
    expect(r.message).toBe(ERROR_CODES.OVERVIEW_FAILED.message);
    expect(r.message).not.toContain('内部细节');
  });

  it('注册表里没有的 fallback code → 通用文案 + 500', () => {
    const r = resolveError(new Error('内部细节'), 'NOT_A_REAL_CODE');
    expect(r.status).toBe(500);
    expect(r.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
  });

  it('非 Error 值（null / undefined / string / 数字 / 对象 / 数组）不炸', () => {
    for (const e of [null, undefined, 'boom', 42, {}, [], Symbol('s')]) {
      const r = resolveError(e, 'X_FAILED_NOT_IN_TABLE');
      expect(r.status).toBe(500);
      expect(r.message).toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    }
  });

  it('只有 code 没有 statusCode → 不透传（防 P2002 之类内部码带原文外泄）', () => {
    const r = resolveError(Object.assign(new Error('内部细节'), { code: 'P2002' }), 'CREATE_FAILED');
    expect(r.message).not.toContain('内部细节');
    expect(r.code).toBe('CREATE_FAILED');
  });
});

describe('注册表自身完整性（★ 恒真守卫 = 没有守卫）', () => {
  it('每条 status 必须是 4xx/5xx；message 必须非空且是中文业务文案', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      expect(spec.status, code).toBeGreaterThanOrEqual(400);
      expect(spec.status, code).toBeLessThan(600);
      expect(spec.message.length, code).toBeGreaterThan(0);
      expect(/[一-龥]/.test(spec.message), `${code} 文案必须是给用户看的中文`).toBe(true);
    }
  });

  it('lookupErrorCode 对非字符串入参返回 undefined（不抛）', () => {
    expect(lookupErrorCode(undefined)).toBeUndefined();
    expect(lookupErrorCode(123)).toBeUndefined();
    expect(lookupErrorCode('P2002')).toBeUndefined();
  });
});

/**
 * ★ Task 6 加固（R5 复审 25 条里落到注册表这一层的五条钉子）。
 *
 * 上面那批用例有一个共同盲区：`resolveError` 的查表支长这样 ——
 *   status: spec?.status ?? 500,  message: spec?.message ?? GENERIC_ROUTE_ERROR_MESSAGE
 * 于是**把 `spec?.status` / `spec?.message` 整段删掉，只留 `?? 500` 和通用文案**，
 * 旧用例照样全绿：5xx 码的状态本来就撞在 500 上，而用例里比的是 `ERROR_CODES.X.message`（抄现值）。
 * ⇒ 「查表生效了」这件事从来没被证明过。下面每条都配了可证伪点，并在报告里附了实跑的证伪记录。
 */
describe('注册表真的被读到（Task 6 加固）', () => {
  it('加固①：表内 4xx/5xx 兜底码的 status 来自表，不是 `?? 500` 兜住的', () => {
    // 期望值是**HTTP 语义的规格**（404 不存在 / 409 业务规则冲突 / 503 依赖校验不可用），
    // 不是从表里抄的现值；关键判据是那条 `not.toBe(500)` —— 它专门杀「查表支退化成 ?? 兜底」。
    const spec: Array<[string, number]> = [
      ['NOT_FOUND', 404],
      ['VALIDATION_FAILED', 400],
      ['GATE_BLOCKED', 409],
      ['APPROVAL_ALREADY_RESOLVED', 409],
      ['INVOICE_LINKED', 409],
      ['ORDER_TERMINAL', 409],
      ['STOCK_INSUFFICIENT', 409],
      ['EXCEPTION_ALREADY_CONSUMED', 409],
      ['EXCEPTION_CONSUME_CONFLICT', 409],
      ['EXCEPTION_NOT_FOR_THIS_ENTITY', 400],
      ['EXCEPTION_CONSUME_FAILED', 500],
      ['DEPENDENCY_CHECK_FAILED', 503],
      ['OVERVIEW_FAILED', 500],
    ];
    for (const [code, want] of spec) {
      const r = resolveError(new Error('内部细节'), code);
      expect(r.status, `${code} 的 status 不是表内值`).toBe(want);
      if (want !== 500) {
        expect(r.status, `${code} 掉进了 ?? 500 兜底 = 查表支失效`).not.toBe(500);
      }
      expect(r.code).toBe(code);
    }
  });

  it('加固②：命中注册表时文案确实来自表（先证明表里没有一条等于通用文案）', () => {
    // 这一条是上一条的前置：若表里某码的文案恰好抄成通用文案，
    // 那么「`resolveError` 返回了该码的文案」就会在**查表支已失效**时照样绿 —— 恒真。
    expect(ERROR_CODES.INTERNAL_ERROR).toEqual({ status: 500, message: GENERIC_ROUTE_ERROR_MESSAGE });
    // INTERNAL_ERROR intentionally names the generic 500 boundary. All other
    // codes must still prove distinct registry copy, retaining the anti-tautology control.
    for (const [code, spec] of Object.entries(ERROR_CODES).filter(([code]) => code !== 'INTERNAL_ERROR')) {
      expect(spec.message, `${code} 的文案与通用文案相同，查表用例对它恒真`).not.toBe(GENERIC_ROUTE_ERROR_MESSAGE);
    }
    const r = resolveError(new Error('内部细节'), 'OVERVIEW_FAILED');
    expect(r.message).toBe(ERROR_CODES.OVERVIEW_FAILED.message);
    expect(r.message).not.toBe(GENERIC_ROUTE_ERROR_MESSAGE);
  });

  it('加固③：响应形状用 toStrictEqual 钉死（多一个键也红）', () => {
    expect(resolveError(new Error('x'), 'NOT_FOUND')).toStrictEqual({
      status: 404, code: 'NOT_FOUND', message: ERROR_CODES.NOT_FOUND.message,
    });
    // 业务错误无明细时**不得**出现 `details: undefined` 这个键（toStrictEqual 能区分，toEqual 不能）
    expect(
      resolveError(Object.assign(new Error('币种不一致'), { code: 'CURRENCY_MISMATCH', statusCode: 400 }), 'CREATE_FAILED'),
    ).toStrictEqual({ status: 400, code: 'CURRENCY_MISMATCH', message: '币种不一致' });
  });

  it('加固④：details 与 gateDetails 并存时取 details，且两者都不得丢', () => {
    // 判据 `e.details ?? e.gateDetails` 只有一条用例覆盖过「单独存在」的两种情况；
    // 并存时的优先级从来没定过 —— 而 shipping 域正在往这个方向走（见 spec §3.3 硬前置）。
    const e = Object.assign(new Error('出运门禁未通过'), {
      code: 'GATE_BLOCKED', statusCode: 409,
      details: [{ orderId: 'new' }], gateDetails: [{ orderId: 'old' }],
    });
    const r = resolveError(e, 'SHIP_FAILED');
    expect(r.details).toStrictEqual([{ orderId: 'new' }]);
    expect(r).not.toHaveProperty('gateDetails'); // 旧键不得同时出现在解析结果里
  });
});
