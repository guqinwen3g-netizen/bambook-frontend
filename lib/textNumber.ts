export type TextNumberResult =
  | { ok: true; value: number }
  | { ok: false; reason: 'blank' | 'not-a-number' };

/**
 * 把文本框里的值换算成**要发给服务端的数字**。
 *
 * ★ 这里真正要防的不是"算不出数"，而是**别让 NaN 出门**：
 * `JSON.stringify` 把 NaN 序列化成 `null`，而服务端把 `null` 读成"用户没填"
 * （`server/src/shared/moneyInput.ts` 的 `missing` 档）⇒ "填了垃圾"在服务端变成"没填"，
 * 于是调用方的兜底链条去取**默认金额**。收费事项侧实测：金额框输 `abc` 点保存，
 * 开出来是一张 120 元的单（不是 0 元，也不是报错）。
 *
 * ⚠️ `blank`（真正没输入）**不**映射成"不送这个键" —— 那正好落进上面那个 `missing` 档。
 * 调用方要显式决定送什么（本面板沿用既有口径：送 0）。
 * 只有空格的框算 `not-a-number`，与后端 `''`/`'   '` 归"非法"同一档（v3.15 复核 B-2 定的方向）。
 */
export function parseTextFieldNumber(raw: unknown): TextNumberResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'blank' };
  if (raw === '') return { ok: false, reason: 'blank' };
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-number' };
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'not-a-number' };
  const n = Number(text);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: 'not-a-number' };
}
