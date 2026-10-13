/**
 * shared/moneyInput.ts —— 「金额 / 数量 / 计数」这类业务量在**入口**的读法（只此一份）
 *
 * ★ 为什么要有它（§2 G3 判据 L-A「写路径 / 守卫路径零容忍」的第一刀，v3.14）
 *   理赔域此前普遍是这个形状：
 *     `const amount = new Prisma.Decimal(input.amount ?? 0);` → 后面才 `if (amount.lte(0)) return fail(...)`
 *   行为上它其实是拒绝的（0 与负数都进不来），但**"缺失"与"真的是 0"被合并成同一个值**，
 *   于是"拒绝对不对"完全取决于下游那一句有没有写、写在多远的位置：
 *     · `claimSettlement.ts` 把 `d.amount ?? 0` 交给 `createCreditNote` ⇒ 靠**被调方**的校验兜着；
 *     · `claimRoute.ts` 的 `appliedAmount ?? 0` 同理 ⇒ 靠 `applyCreditNote` 的 `lte(0)` 兜着。
 *   跨一次函数边界就把"拒绝"变成"别人的责任"，这正是 §2 G3 里 L-A 长期停在 191 的成因形状
 *   （v3.14 收掉理赔域这 13 处 ⇒ 现量 178；尺与判据本身一个字没改）。
 *
 * ★ 本文件的口径（不是新业务口径，是把已有契约写成一处）
 *   - 缺失（`null` / `undefined` / 空串 / 纯空白）⇒ 拒，理由是"未填"，**不**当 0；
 *   - 非数（`NaN` / `Infinity` / 混进字母的串 / 数组）⇒ 拒。
 *     ★ 改动前这两件事各有各的坏法（实测，不是推测）：
 *       · 直连 API 送 `'12abc'` ⇒ `new Prisma.Decimal('12abc')` **抛** `[DecimalError] Invalid argument`
 *         ⇒ 撞到路由的 `catch` ⇒ 用户拿到 **500 +「核销退款单失败」**（一个他看不出所以然的错）；
 *       · 而 `NaN` 更坏：`new Prisma.Decimal(NaN).lte(0)` 是 **false** ⇒ **根本不拒**，会当合法值继续写。
 *         经 UI 走不到这一支，是因为 JSON 带不了 NaN（前端 `Number('垃圾')` 得 NaN，`JSON.stringify` 后是 `null`
 *         ⇒ 落到上面"缺失"那一支变成"当前 0"）。所以这条不是"提示不好听"，是**少了一类拒绝**。
 *   - `<= 0` ⇒ 拒（与既有 `lte(0)` 契约一致；已有测试钉着 `amount: 0` / `amount: -5` 都返回 `VALIDATION_FAILED`）；
 *   合法值原样返回**十进制字符串**（不引入新的数值语义；调用方仍自己 `new Prisma.Decimal(...)`）。
 *
 * ⚠️ 不做的事：不猜精度、不做四舍五入、不管币种与上限（那些是各域已有的校验），
 *    也不提供"允许为 0"的开关 —— 真需要业务性零值的调用方，请自己写明理由并加 `// fallback:display` 注记（§2 G3 配套要求）。
 */

/** 十进制字符串（调用方拿去构造 Decimal；这里不 import Prisma，保持本文件零依赖、可在任何域复用）
 *  ⚠️ 刻意**不**返回"换算后的 number"：钱上过 `Number` 就会在 2^53 之外静默丢精度，
 *    而一个看起来人畜无害的 `normalized` 字段迟早会有人拿去算账 ⇒ 判定用得到数值时调用方自己 `new Prisma.Decimal(value)`。 */
export type PositiveDecimalOk = { ok: true; value: string };
export type PositiveDecimalErr = { ok: false; field: string; reason: 'missing' | 'not-a-number' | 'not-positive'; message: string };
export type PositiveDecimalResult = PositiveDecimalOk | PositiveDecimalErr;

/**
 * 允许科学计数法 —— 这条是**被自己的测试逼出来的**：`new Prisma.Decimal('0.0000001').toString()` 给出的是
 * `'1e-7'`（decimal.js 在极小数上切成指数形式）。只认定点写法就会把**数据库里读回来的合法小值**
 * （汇率/比率这一类）判成"不是数字"，那是拿判据去误伤真数据。原样把串交给调用方去构造 Decimal ⇒ 精度不丢。
 */
/**
 * ★ D108（v3.96 自裁 · 收紧）：**字符串形态的金额只认一种写法** —— 可选负号 + 数字 + 可选小数。
 *   改前是 `^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$`（宽口径：认 `1e3` / `.5` / `1.` / `+5`），
 *   于是 `1e3` · `.5` · `1.` · `+5` 在**理赔/收费侧**被收下、在**发票/付款凭证侧**被 400 ⇒ 六份实现各认一套。
 *   现在往窄收：**拒**科学计数法、前导/末尾小数点、加号；两端空格仍按 trim 后校验。
 *   ⚠️ 两条**刻意保留**：① `-` 号保留 ⇒ 负数仍报"不能为负"，不被降级成"格式错"；
 *     ② 本正则**只对字符串形态**生效（数字/大整数/Decimal 走数值校验）—— 否则 `String(1e-7) === '1e-7'`
 *        会把一个**合法的 number** 当成非法写法拒掉。
 */
const DECIMAL_STRING_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * 档位**只有两种**，且各自点名 —— 刻意不做"带默认档的 wrapper"（那种东西等于替调用方选语义）：
 *   `parsePositiveDecimal`    ⇒ 必须 > 0（理赔/退款族：口径 A6「0 元处置无意义」）
 *   `parseNonNegativeDecimal` ⇒ 允许 0，但**负数与非数必须拒**（收费/金额登记族：文案一直写的是"必须是非负数值"）
 * 两者共用同一份"读一个十进制串"的实现（`readDecimal`）⇒ 想改解析只有一处可改。
 */
type ReadFail = { ok: false; reason: 'missing' | 'not-a-number' };
type ReadOk = { ok: true; text: string; n: number };

/**
 * ★ 文案只从 `reason` 造，且**不回显用户给的原值**（B22/B30 两把棘轮都盯着这个形状）：
 *   ① 一个内部对象的 `.message` 被 `message: x.message` 转发出去，正是 B22 数的那种"原文直上响应体"；
 *   ② 把输入值回显进对外文案，等于给探测者一个回声。
 *   ⇒ 内部一律返回机器码 `reason`，对外句子在这里组装。
 * ★★ 档位差异必须留到最后一步才分岔（v3.15 复核 I-4 抓出来的回归）：
 *   "要写 0 请填写 0" 这句在**正数档**里是自相矛盾的（那里 0 就是不合法），会把用户推向一个必然被拒的填法 ——
 *   正是 v3.14 点名要消灭的"让用户去改一个不存在的地方"换了个样子回来。故 `not-positive` 一句自带"0 不合法"。
 */
function failMessage(reason: 'missing' | 'not-a-number' | 'not-positive' | 'negative', field: string): string {
  if (reason === 'missing') return `${field}未填写`;
  if (reason === 'not-a-number') return `${field}不是合法数字 ⇒ 不接受静默换算`;
  if (reason === 'not-positive') return `${field}须为正数（0 不合法）`;
  return `${field}不能为负`;
}

/**
 * ★★ `missing` 只认 `null` / `undefined`（复核 B-2 实测逼出来的更正）：
 *   空串与纯空白**不是**"没填"。它们在 JS 里 `Number('') === 0`，而调用方的兜底链条用的是 `??`
 *   —— `0 ?? 默认` 取的是 **0**，不吞。所以一旦把 `''` 归进 `missing`，调用方就会去取**默认金额**，
 *   于是"以前开一张 0 元单"变成"现在开一张 120 元单" ⇒ 方向是**凭空多出钱**，比原来的毛病更坏。
 *   ⇒ `''` / `'   '` 归 `not-a-number`（当场拒），行为与"拒非法"同族，且不会把某个默认值抬进账单。
 */
function readDecimal(raw: unknown): ReadFail | ReadOk {
  if (raw === null || raw === undefined) return { ok: false, reason: 'missing' };
  let text: string;
  let fromString = false;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'not-a-number' };
    text = String(raw);
  } else if (typeof raw === 'bigint') {
    text = raw.toString();
  } else if (typeof raw === 'object' && raw !== null
    && typeof (raw as any).toNumber === 'function' && typeof (raw as any).toString === 'function') {
    // Prisma.Decimal / Decimal.js：走它自己的 toString，避免 JSON 化后丢精度
    text = String((raw as any).toString());
  } else if (typeof raw === 'string') {
    text = raw.trim();
    fromString = true;
    if (text === '') return { ok: false, reason: 'not-a-number' }; // ← 见上：空白串 ≠ 没填
  } else {
    // ★ 只认 number / 数字字符串 / bigint / Decimal 形状四种。`String([5]) === '5'` 这种 JS 隐式换算**不接受** ——
    //   本文件的存在理由就是"看不懂就不假装看懂"（实测：改前 `[5]` 会被当成 5 收下来）。
    return { ok: false, reason: 'not-a-number' };
  }
  // ★ D108：写法约束只对**字符串**形态生效（数字/大整数/Decimal 已是解析好的值，见上面注释两条保留）
  if (fromString && !DECIMAL_STRING_RE.test(text)) return { ok: false, reason: 'not-a-number' };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, reason: 'not-a-number' };
  return { ok: true, text, n };
}

/**
 * @param raw   调用方传来的原始值（允许 number / 数字字符串 / Decimal 形状（有 toNumber）/ bigint）
 * @param field 出错提示里用的业务名（"金额"、"退货数量"…），**不**在这里写死字段语义
 */
export function parsePositiveDecimal(raw: unknown, field: string): PositiveDecimalResult {
  const r = readDecimal(raw);
  if (!r.ok) return { ok: false, field, reason: r.reason, message: failMessage(r.reason, field) };
  if (r.n <= 0) return { ok: false, field, reason: 'not-positive', message: failMessage('not-positive', field) };
  return { ok: true, value: r.text };
}

/**
 * ★ B137（v3.15）新增：**必须把"没填"与"填了但非法"分开返回**，否则调用方又会写成
 *   `读() ?? 兜底 ?? 0` 那种链条 —— 那正是 `billingItemService.ts:417` 把"负数"静默换成默认金额、
 *   并让紧跟其后的 `INVALID_AMOUNT` 守卫永不可达的形状。
 *   ⇒ `reason: 'missing'` 才是"可以走默认值"的唯一信号；`'not-a-number' | 'negative'` 一律必须当场拒。
 */
export type NonNegativeResult =
  | { ok: true; value: string }
  | { ok: false; field: string; reason: 'missing' | 'not-a-number' | 'negative'; message: string };

export function parseNonNegativeDecimal(raw: unknown, field: string): NonNegativeResult {
  const r = readDecimal(raw);
  if (!r.ok) return { ok: false, field, reason: r.reason, message: failMessage(r.reason, field) };
  if (r.n < 0) return { ok: false, field, reason: 'negative', message: failMessage('negative', field) };
  return { ok: true, value: r.text };
}
