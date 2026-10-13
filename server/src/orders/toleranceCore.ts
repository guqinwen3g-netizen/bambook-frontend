/**
 * toleranceCore.ts — 溢短装公差的**纯计算内核**（单一真源）
 *
 * 为什么单独一个文件：`toleranceService`（订单视图）要用 `toleranceStandardService`
 * （取数链 + 双重判定），而后者又要用 `checkTolerance` ⇒ **直接互相 import 会成环**。
 * ⇒ 把纯函数与类型抽到这里：`toleranceStandardService` → `toleranceCore`；
 *   `toleranceService` → `toleranceCore` + `toleranceStandardService`。**单向，无环**。
 *
 * ★ 对外兼容：`toleranceService` **转发导出**本文件的全部符号 ⇒
 *   既有 5 个调用方的 import 路径**一行都不用改**。
 *
 * 设计真源：需求池 REQ2-03 ·「发货/开票数量按条款校验超限预警」
 *
 * 口径（对称条款 ±N%）：
 *   - 发货量允许在 [qty×(1−N%), qty×(1+N%)] 区间内按实际量结算
 *   - 超限（>N% 溢装 / 短装）→ 预警（WARN 不阻断——溢短装是条款不是硬门禁），
 *     并给出条款上限口径的建议结算量/额（协商基准）
 *   - tolerancePercent = 0 → 不允许溢短装（足量交付，任何偏差即预警）
 *
 * ★★ 2026-09-29 起：**「N 是多少」不再由本文件决定** —— 本文件只负责"给定 N 怎么算"。
 *   N 从哪来由 `toleranceStandardService` 的取数链决定
 *   （① 行级覆盖 → ② 客户标准 P0 → ③ 内部标准辅助 → ④ 未判定）。
 */
import { round4 } from '../lib/unitConversion';

export type ToleranceVerdict = 'ok' | 'over_limit' | 'under_limit';

/**
 * 写入口径校验（REQ2-03）：tolerancePercent 允许 number 或数字字符串，
 * 合法区间 [0, 100]（含边界；0 = 足量交付不允许溢短装）；null/undefined 放行
 * （清空条款回退默认 5）。越界/非数值 → 中文错误消息（写路径 400）。
 * 单一真源：orderLineMutationService（route + Agent flow 共用）消费。
 */
export function validateTolerancePercentInput(value: unknown): { ok: true; value: number | null } | { ok: false; message: string } {
  if (value === null || value === undefined || value === '') return { ok: true, value: null };
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(num)) {
    return { ok: false, message: `溢短装公差 tolerancePercent 必须是数字（收到：${String(value)}）` };
  }
  if (num < 0 || num > 100) {
    return { ok: false, message: `溢短装公差 tolerancePercent 必须在 0-100 之间（含边界），当前值：${num}` };
  }
  return { ok: true, value: num };
}

export interface ToleranceCheckInput {
  contractQty: number;      // 合同数量
  actualQty: number;        // 实际发货/开票数量
  tolerancePercent: number; // ±N%（0 = 足量交付）
  unitPrice?: number | null;
}

export interface ToleranceCheckResult {
  verdict: ToleranceVerdict;
  deviationPct: number;        // 偏差百分比（正=溢装，负=短装）
  allowedMin: number;          // 条款下限 qty×(1−N%)
  allowedMax: number;          // 条款上限 qty×(1+N%)
  settlementQty: number;       // 实际量（结算依据）
  settlementAmount: number | null;   // unitPrice × actualQty
  maxLimitAmount: number | null;     // 按上限量的金额（超限协商参考）
  minLimitAmount: number | null;     // 按下限量的金额（超限协商参考）
  warning: string | null;     // 超限预警文案（null = 限额内）
}

/** 纯函数：单行容差校验（验收锚点：±5% 条款发货 5.2% → over_limit 预警） */
export function checkTolerance(input: ToleranceCheckInput): ToleranceCheckResult {
  const { contractQty, actualQty } = input;
  const tolPct = Math.max(0, Number(input.tolerancePercent) || 0);
  const price = input.unitPrice != null ? Number(input.unitPrice) : null;

  if (!Number.isFinite(contractQty) || contractQty <= 0) {
    throw Object.assign(new Error('合同数量必须为正数'), { code: 'INVALID_QTY' });
  }
  if (!Number.isFinite(actualQty) || actualQty < 0) {
    throw Object.assign(new Error('实际数量必须为非负数'), { code: 'INVALID_QTY' });
  }

  const allowedMin = round4(contractQty * (1 - tolPct / 100));
  const allowedMax = round4(contractQty * (1 + tolPct / 100));
  const deviationPct = round4(((actualQty - contractQty) / contractQty) * 100);

  let verdict: ToleranceVerdict = 'ok';
  let warning: string | null = null;
  if (actualQty > allowedMax) {
    verdict = 'over_limit';
    warning = `溢装超限：实际 ${actualQty}（+${deviationPct}%）超出条款上限 ${allowedMax}（+${tolPct}%），结算量需与客户协商`;
  } else if (actualQty < allowedMin) {
    verdict = 'under_limit';
    warning = `短装超限：实际 ${actualQty}（${deviationPct}%）低于条款下限 ${allowedMin}（−${tolPct}%），结算量需与客户协商`;
  }

  return {
    verdict,
    deviationPct,
    allowedMin,
    allowedMax,
    settlementQty: actualQty,
    settlementAmount: price != null ? round4(price * actualQty) : null,
    maxLimitAmount: price != null ? round4(price * allowedMax) : null,
    minLimitAmount: price != null ? round4(price * allowedMin) : null,
    warning,
  };
}
