/**
 * moneyFormat.ts — 全应用金额展示的**单一真源**（B255 收口落点；与 `lib/dateFormat.ts` 同一条矩）
 *
 * 为什么现在要有这一份：`components/` 里已实测并存 **22 份**各自写的金额格式化函数
 * （`formatAmount` 12 份、`formatMoney` 5 份、`fmtMoney` 5 份），档位互不相同 ——
 * 有的两位、有的最多四位、有的 `null → 0`、有的没有币种参数。
 * ⇒ 台账 B255 当年因此**刻意不修**索赔页那三处裸值（理由："再抄第 9 份＝把 B249 那族的病复制一次"）。
 * 这一份就是那个"先有落点、再谈收口"的落点：**新写的走这里，别再抄第 23 份**。
 * ★ 其余 21 份本批不动（收口要先比每份的取值集合与默认档，半套合并比不动更糟）。
 *
 * 四条口径，全部可跑（用例：`lib/moneyFormat.test.ts`）：
 *   ① 千分位 + 两位小数；② 非零不足一分保留到四位（不把"有"显示成 `0.00`）；
 *   ③ 空值 → `—`，**不 → 0**；④ 认不出的字符串原样上屏 —— 不猜数、也不吞成 0。
 */

/** 空值与算不出时的显示：与全站的"没有数"口径一致 */
import { settlementAmountUnits } from './settlementMoney';

export const MONEY_EMPTY = '—';

/** Settlement balances must display the same exact maximum that the command
 * validator uses; e.g. 12.9999 must not invite a rounded 13.00 payment. */
export function formatSettlementMoneyText(value: number | string | null | undefined, currency?: string | null): string {
  const units = settlementAmountUnits(value);
  if (units == null) return value == null || String(value).trim() === '' ? MONEY_EMPTY : String(value);
  const integer = (units / 10000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (units % 10000n).toString().padStart(4, '0').replace(/0{1,2}$/, '');
  const amount = `${integer}.${fraction.padEnd(2, '0')}`;
  return currency ? `${currency} ${amount}` : amount;
}

/**
 * 金额 → 屏面文本。入参可以是 Prisma Decimal 串（`'1305.0000'`）、`number`、或空值。
 * @param currency 传了就加前缀（`USD 1,234.50`）；不传则只出数字（句子末尾自己带币种的场合用这个）
 *   ★ 币种档与另外两个出口对齐成同一条入参契约（`string | null`）：可空列直接传进来就行，
 *     不必在每个调用点补 `?? ''` —— 那种补丁写多了，迟早有人写成 `?? 'CNY'`。
 */
export function formatMoneyText(value: MoneyInput, currency?: string | null): string {
  const p = parseMoney(value);
  if (p.k === 'empty') return MONEY_EMPTY;
  // 认不出的一律原样上屏：宁可看见 `待核`，也不把它变成看着像数的 0.00（G3：算不出就不给数）
  if (p.k === 'raw') return p.t;
  return render(p.n, currency ?? '');
}

/**
 * 金额 → 屏面文本，**符号在前**（`¥1,041,444.50`）：这是全站另一族既有形状
 * （催款函、催款看板、收款申请三处原本各抄了一份，且都把"没值"兜成 `0.00`）。
 * 与 `formatMoneyText` 共用同一套解析与小数规则，只有前缀不同 ⇒ 这一族不再有第二份实现。
 * ★ 空值 / `NaN` → `—`，**不回落 0**：`¥0.00` 在钱的屏面上是"这笔没有欠"，不是"这笔没数"。
 * @param currency `CNY`/`USD`/`EUR` 转符号；其它币种码原样带空格前缀；不传则只出数字
 */
export function formatMoneySymbol(value: MoneyInput, currency?: string | null): string {
  const p = parseMoney(value);
  if (p.k === 'empty') return MONEY_EMPTY;
  if (p.k === 'raw') return p.t;          // 认不出的串不加符号：加了就把"待核"伪装成一笔钱
  return `${symbolPrefix(currency ?? '')}${moneyText(p.n)}`;
}

type MoneyInput = number | string | null | undefined;
type Parsed = { k: 'empty' } | { k: 'raw'; t: string } | { k: 'num'; n: number };

/**
 * 金额 → 屏面文本，**币种码在后**（`1,234.00 USD`）：第三出口，给原本各抄一份"码在后"的六个屏面
 * （佣金、远期结汇、采购、报价、供应商询价、CRM）。★ 这四份里有一个共同的失败形状：
 * 币种列在 schema 上是可空的（`currency String?`），而它们把 `${currency}` 直接拼进模板 ⇒
 * 空币种那行会渲染成 `1,234.00 null`。这一份把空币种收成"只出数字"，空值收成 `—`。
 * 小数与解析规则与前两个出口共用 `parseMoney` / `moneyText`，不另写一套。
 */
export function formatMoneyCodeAfter(value: MoneyInput, currency?: string | null): string {
  const p = parseMoney(value);
  if (p.k === 'empty') return MONEY_EMPTY;
  if (p.k === 'raw') return p.t;          // 认不出的串不加币种：加了就伪装成"某个币种下的数"
  const code = (currency ?? '').trim();
  const text = moneyText(p.n);
  return code ? `${text} ${code}` : text;
}

/** Display a recorded price basis without converting units or guessing a missing one.
 * This outlet deliberately preserves formatMoneyCodeAfter's numeric precision. */
export function formatUnitPriceCodeAfter(value: MoneyInput, currency?: string | null, unit?: string | null): string {
  const amount = formatMoneyCodeAfter(value, currency);
  if (parseMoney(value).k !== 'num') return amount;
  const recorded = (unit ?? '').trim();
  const aliases: Record<string, string> = {
    m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm', '米': 'm',
    yd: 'yd', yard: 'yd', yards: 'yd', '码': 'yd',
    pc: 'pc', pcs: 'pc', piece: 'pc', pieces: 'pc', '件': 'pc',
    kg: 'kg', kilogram: 'kg', kilograms: 'kg', '千克': 'kg',
    dozen: 'doz', doz: 'doz', '打': 'doz', roll: 'roll', rolls: 'roll',
    set: 'set', sets: 'set',
  };
  const key = recorded.toLowerCase();
  const basis = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : recorded;
  return basis ? `${amount}/${basis}` : amount;
}

function parseMoney(value: MoneyInput): Parsed {
  if (value === null || value === undefined || value === '') return { k: 'empty' };
  if (typeof value === 'number') return Number.isNaN(value) ? { k: 'empty' } : { k: 'num', n: value };
  const raw = value.trim();
  if (raw === '') return { k: 'empty' };
  const n = Number(raw);
  return Number.isFinite(n) ? { k: 'num', n } : { k: 'raw', t: raw };
}

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$', EUR: '€' };

function symbolPrefix(currency: string): string {
  if (currency === '') return '';
  return CURRENCY_SYMBOLS[currency] ?? `${currency} `;
}

function moneyText(n: number): string {
  // ★ 非零但不足一分：保留四位。纯两位会把 0.004 显示成 0.00 —— 那是"把有报成没有"，
  //   和把空值兜成 0 同族，只是这里发生在显示层。
  const subCent = n !== 0 && Math.abs(n) < 0.005;
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: subCent ? 4 : 2,
  });
}

function render(n: number, currency: string): string {
  const text = moneyText(n);
  return currency ? `${currency} ${text}` : text;
}
