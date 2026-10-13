/**
 * 业务变体矩阵 #38 / #40 / #41 / #42（T/T · D/P · D/A · O/A 四格）—— §11 第 4 条「每格有结论」。
 *
 * ★ 为什么这四格此前是「未测」而不是「不适用」：结算方式在系统里**唯一有行为差别的地方**就是这道 L/C 门禁
 *   （其余是登记与展示）。所以这四格的正确结论不是"没有测试对象"，而是"它们必须被门禁判成同一档，
 *   且谁都不许被误判成信用证" —— 这个可以测，而且必须带能红的对照。
 * ★ 每格三件一起断，缺一件就是假覆盖：
 *   ① 放行（`eligible`）且**不带**「未录」提示（已录四枚值与 null 必须分得开）；
 *   ② 同格内的反面：把这一枚换成 `L/C` 且库里 0 张证 ⇒ **必须阻断** ⇒ 证明 ① 不是"门禁恒放行"读出来的；
 *   ③ 混合结算里把这枚值与 `L/C` 拼在一起 ⇒ 仍算含信用证成分（不许被稀释成非信用证，D106 那一档）。
 *   三个 stage 全跑：门禁在确认/发运/开票三处各调一次，只测一个 stage 就等于另外两处没结论。
 */
import { describe, expect, it } from 'vitest';
import {
  decideLcGate,
  evaluateLcEligibility,
  LC_ORDER_CONFIRM_ACTION,
  type LcGateStage,
} from '../lcGate';

const AT = new Date('2026-09-20T12:00:00');
const STAGES: LcGateStage[] = ['order:confirm', 'shipment:release', 'invoice:issue'];
// KB-1.4 的四枚非信用证结算工具（枚举真源 `lib/orderSchema.ts`）
const NON_LC = ['T/T', 'D/P', 'D/A', 'O/A'] as const;

const stubPrisma = (paymentInstrument: string | null, lcs: any[] = []) => ({
  order: { findUnique: async () => ({ paymentInstrument }) },
  letterOfCredit: { findMany: async () => lcs },
  dr013ExceptionRequest: { findMany: async () => [] },
});

describe('矩阵 #38/#40/#41/#42：四枚非信用证结算方式在 L/C 门禁里同档、且与「未录」分得开', () => {
  for (const raw of NON_LC) {
    describe(`结算方式「${raw}」`, () => {
      it('① 三个 stage 都放行，且不产生「未录」噪音', () => {
        for (const stage of STAGES) {
          const el = evaluateLcEligibility({ stage, orderInstrument: raw, lc: null, at: AT });
          expect(el.eligible, `${stage} 不该拦非信用证结算`).toBe(true);
          expect(el.blockingReasons, `${stage} 放行却不干净＝判据漂移`).toEqual([]);
          expect(el.notices, `「${raw}」是已录的值，不许报未录（那会把这个码变成人人无视的噪音）`).toEqual([]);
        }
      });

      it('② 能红的反面：同一格换成 L/C 且 0 张证 ⇒ 必须阻断（证明 ① 不是恒放行）', async () => {
        for (const stage of STAGES) {
          const el = evaluateLcEligibility({ stage, orderInstrument: 'L/C', lc: null, at: AT });
          expect(el.eligible, `${stage}：信用证单没有证却放行＝门禁形同虚设`).toBe(false);
          expect(el.blockingReasons).toContain('LC_NOT_REGISTERED');
        }
        // 反面也要走一次活路径（判定函数对了不等于接线对了）
        const d = await decideLcGate({
          prisma: stubPrisma('L/C') as any,
          orderId: 'O-LC',
          stage: 'order:confirm',
          exceptionAction: LC_ORDER_CONFIRM_ACTION,
          at: AT,
        });
        expect(d.allowed, 'decideLcGate 这一层也必须拦住').toBe(false);
      });

      it('③ 与 L/C 混写时不许被稀释成"非信用证"', () => {
        for (const mixed of [`${raw} + L/C`, `L/C + ${raw}`, `30% ${raw}, 70% L/C`]) {
          const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: mixed, lc: null, at: AT });
          expect(el.blockingReasons, `混合结算「${mixed}」含信用证成分，必须走证链判定`).toContain('LC_NOT_REGISTERED');
        }
      });
    });
  }

  it('★ 四枚值都不许长出"信用证"形状（全角/大小写/带空格各试一遍都仍非信用证）', () => {
    for (const raw of NON_LC) {
      for (const shape of [raw, raw.toLowerCase(), ` ${raw} `, raw.replace('/', '／')]) {
        const el = evaluateLcEligibility({ stage: 'shipment:release', orderInstrument: shape, lc: null, at: AT });
        expect(el.blockingReasons, `「${shape}」被误判成信用证＝正常结算被卡（误卡侧）`).toEqual([]);
      }
    }
  });

  it('★ 对照组：这四枚与"未录"确实是两档（四枚无提示、null/空白必带提示）', () => {
    for (const raw of NON_LC) {
      const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: raw, lc: null, at: AT });
      expect(el.notices).toEqual([]);
    }
    for (const blank of [null, '', '   ']) {
      const el = evaluateLcEligibility({ stage: 'order:confirm', orderInstrument: blank, lc: null, at: AT });
      expect(el.notices, `${JSON.stringify(blank)} 属"不知道"，不许长得像"录了 ${NON_LC[0]}"`).toContain('LC_INSTRUMENT_NOT_RECORDED');
    }
  });
});
