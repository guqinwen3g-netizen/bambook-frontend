import { describe, expect, it } from 'vitest';
import { parseTextFieldNumber } from './textNumber';

/**
 * B142 · "填了垃圾"不能被送出成"没填"。
 * 这组用例的核心不是换算对不对，而是**第 4 格那条序列化事实**：
 * 一旦有人把 `not-a-number` 又折算成 0 / NaN 发出去，服务端的 `missing` 档就会把它读成"用户没填"，
 * 收费事项侧的后果是**凭空开出一张默认金额的单**（实测 120）。
 */
/** 旧写法的原样复刻：`Number(文本框里的值 || 0)`。用形参而不是字面量，是因为 TS 会把
 * `Number('abc' || 0)` 判成「这个表达式恒真」而拒绝编译 —— 这条编译期报错本身就是这个病能活下来的原因之一。 */
function oldNumber(text: string): number {
  return Number(text || 0);
}

describe('parseTextFieldNumber（lib/textNumber）', () => {
  it('① 真没输入 ⇒ blank（三种空值同一个答案）', () => {
    for (const v of [null, undefined, '']) {
      expect(parseTextFieldNumber(v)).toEqual({ ok: false, reason: 'blank' });
    }
  });

  it('② 合法数字文本照常换算（含前后空格）', () => {
    expect(parseTextFieldNumber('120.5')).toEqual({ ok: true, value: 120.5 });
    expect(parseTextFieldNumber(' 12 ')).toEqual({ ok: true, value: 12 });
    expect(parseTextFieldNumber('0')).toEqual({ ok: true, value: 0 });
  });

  it('③ 非法文本一律 not-a-number，且**不产出 value**（这条决定了 ④ 有没有意义）', () => {
    for (const v of ['abc', '12abc', '1,200', '   ', '12 34', 'NaN', 'Infinity', {}, [], true, 5]) {
      const r = parseTextFieldNumber(v);
      expect(r.ok, `${JSON.stringify(v)} 不该被当成一个可发送的数字`).toBe(false);
      expect((r as any).value, `${JSON.stringify(v)} 不许带 value 出门`).toBeUndefined();
    }
  });

  it('④ 机理钉子：NaN 经 JSON 会变成 null ⇒ 服务端读成"没填"（本批整条论证建立在这句话上）', () => {
    const old = JSON.parse(JSON.stringify({ amount: oldNumber('abc') }));
    expect(old.amount).toBeNull();
    expect(Number.isFinite(Number('abc'))).toBe(false);
    // ★ 复核 v3.16 MINOR：原来这条写成"取不到 value 就兜 0 再断言不是 null"——那是恒真（兜底分支根本产不出 null），
    //   换成**可被违反的不变量**：换算口说 ok 的那些值，序列化后必须还在（NaN/Infinity 都会从 JSON 里消失）。
    for (const v of ['120', '120.5000', ' 12 ', '+5', '-5', '0', '.5', '1e3', 'Infinity', '-Infinity', true, {}, [], 'abc', '   ', null, undefined]) {
      const r = parseTextFieldNumber(v);
      if (!r.ok) continue;
      const wire = JSON.parse(JSON.stringify({ amount: r.value }));
      expect(wire.amount, `${JSON.stringify(v)} 被判 ok，但它的值经 JSON 会丢失/变形`).toBe(r.value);
      expect(Number.isFinite(r.value), `${JSON.stringify(v)} 不该带着非有限值出门`).toBe(true);
    }
  });

  it('⑤ 刻意不判符号：负数是"合法数字"，拒不拒由服务端口径定（本批未动这条）', () => {
    expect(parseTextFieldNumber('-5')).toEqual({ ok: true, value: -5 });
  });
});
