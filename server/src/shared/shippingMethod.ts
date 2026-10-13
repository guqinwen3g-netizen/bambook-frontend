/**
 * shippingMethod.ts — 运输方式枚举的**唯一真源**（**零依赖纯函数**，前后端共用）
 *
 * ── 为什么要有这一处（零基础障碍清单 C2 · 2026-09-18 真库实测）──
 * `Shipment.shippingMethod` 一直是**自由文本**（前端 text 输入框、服务端零校验），真库实测：
 *   `Sea` 67 · `Air` 7 · **`Sea Freight` 1（脏值）** —— 同一含义三种写法已经出现。
 * 后果：按运输方式分组统计会**多出第三种方式**、单据/台账中文标签只能靠 `?? 原值` 兜底，
 * 而且业务员想填「客户自提」时**不知道有没有这个选项**（没有，只能自己编一个词）。
 *
 * ── 两档口径（**必须分开**，否则要么脏值顶红、要么校验形同虚设）──
 *   · `isValidShippingMethod(v)`：**写入校验**（严格，只认枚举）。仅用于 create/patch 的**新值**。
 *   · `normalizeShippingMethod(v)`：**展示/统计归一**（宽容，认中文与常见别名）。
 *     历史脏值（`Sea Freight` / `海运`）归一到枚举后再分组，**不改库**。
 *
 * ⚠️ 为什么写入校验不回溯历史值：真库已有 `Sea Freight`。若校验挂在「读取/更新任意字段」上，
 *   改一条老票的备注都会被拒 ⇒ 把正常业务卡死。所以**只校验本次写入的 shippingMethod 字段**。
 */

/** 运输方式枚举（新增值必须同时补 LABEL，见结构守卫） */
export const SHIPPING_METHODS = ['Sea', 'Air', 'Land', 'Rail', 'Courier', 'Pickup'] as const;

/** MVP 出运只提供海运和空运；其余值仅供读取历史记录兼容。 */
export const MVP_SHIPPING_METHODS = ['Sea', 'Air'] as const;
export type MvpShippingMethod = (typeof MVP_SHIPPING_METHODS)[number];

export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

/** 中文标签（台账/单据展示用；`Pickup` = 客户自提） */
export const SHIPPING_METHOD_LABELS: Record<ShippingMethod, string> = {
  Sea: '海运',
  Air: '空运',
  Land: '陆运',
  Rail: '铁运',
  Courier: '快递',
  Pickup: '客户自提',
};

const VALID = new Set<string>(SHIPPING_METHODS);

/** 展示用标签：枚举内给中文；脏值原样返回（不猜，避免把 'Sea Freight' 说成别的） */
export function shippingMethodLabel(v?: string | null): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  const norm = normalizeShippingMethod(s);
  return norm ? SHIPPING_METHOD_LABELS[norm] : s;
}

/**
 * 写入校验：严格只认枚举。null/undefined/空串 → 视为「未填」，由调用方决定是否必填。
 * 返回归一后的枚举值，或 null（不合法）。
 */
export function coerceShippingMethodForWrite(v: unknown): { ok: true; value: string | null } | { ok: false; message: string } {
  if (v === null || v === undefined) return { ok: true, value: null };
  const s = String(v).trim();
  if (!s) return { ok: true, value: null };
  if (VALID.has(s)) return { ok: true, value: s };
  // 容错：中文/别名/大小写 → 归一到枚举（业务员从别处粘「海运」也应能存下）
  const norm = normalizeShippingMethod(s);
  if (norm) return { ok: true, value: norm };
  return {
    ok: false,
    message: `运输方式「${s}」不在允许值内。允许：${SHIPPING_METHODS.join(' / ')}（中文：${SHIPPING_METHODS.map(m => SHIPPING_METHOD_LABELS[m]).join(' / ')}）；客户自提请用 Pickup`,
  };
}

/** Strict write contract for the current MVP shipment workflow. The broader
 * normalizer remains available for legacy records and claim-specific flows. */
export function coerceMvpShippingMethodForWrite(v: unknown): { ok: true; value: MvpShippingMethod | null } | { ok: false; message: string } {
  const normalized = coerceShippingMethodForWrite(v);
  if (!normalized.ok) return normalized;
  if (normalized.value == null) return { ok: true, value: null };
  if ((MVP_SHIPPING_METHODS as readonly string[]).includes(normalized.value))
    return { ok: true, value: normalized.value as MvpShippingMethod };
  return { ok: false, message: `当前 MVP 出运只支持海运或空运；收到的「${String(v).trim()}」不能作为运输方式保存。` };
}

/** 是否为合法枚举值（不做别名归一） */
export function isValidShippingMethod(v?: string | null): boolean {
  return !!v && VALID.has(String(v).trim());
}

/**
 * 展示/统计归一：认枚举、中文标签、以及真库已出现的常见别名。
 * 认不出来 → **null**（调用方保留原值，别硬塞一个错的枚举）。
 */
export function normalizeShippingMethod(v?: string | null): ShippingMethod | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  if (VALID.has(s)) return s as ShippingMethod;

  const lower = s.toLowerCase().replace(/[\s_\-/]+/g, '');
  const ALIASES: Record<string, ShippingMethod> = {
    // 英文常见写法
    ocean: 'Sea', seafreight: 'Sea', seatransport: 'Sea', vessel: 'Sea', bysea: 'Sea', marine: 'Sea',
    // 装载方式常被业务员当运输方式填（本仓既有测试 fixture 里就是 'FCL'）——
    // 整箱/拼箱都属于海运，归一到 Sea 比拒绝更贴近业务意图
    fcl: 'Sea', lcl: 'Sea', container: 'Sea',
    airfreight: 'Air', airtransport: 'Air', byair: 'Air', flight: 'Air',
    truck: 'Land', trucking: 'Land', road: 'Land', landtransport: 'Land', byland: 'Land', motor: 'Land',
    railway: 'Rail', train: 'Rail', railtransport: 'Rail', byrail: 'Rail',
    express: 'Courier', dhl: 'Courier', fedex: 'Courier', ups: 'Courier', tnt: 'Courier', ems: 'Courier',
    // 中文
    '海运': 'Sea', '海路': 'Sea', '船运': 'Sea', '水运': 'Sea',
    '空运': 'Air', '航空': 'Air', '空运快件': 'Air',
    '陆运': 'Land', '公路': 'Land', '卡车': 'Land', '汽运': 'Land',
    '铁运': 'Rail', '铁路': 'Rail', '中欧班列': 'Rail',
    '快递': 'Courier', '国际快递': 'Courier', '快件': 'Courier',
    // 自提（C2 新增）
    pickup: 'Pickup', selfpickup: 'Pickup', customerpickup: 'Pickup', exwork: 'Pickup', exw: 'Pickup',
    '自提': 'Pickup', '客户自提': 'Pickup', '自行提货': 'Pickup', '上门提货': 'Pickup', '工厂交货': 'Pickup',
  };
  return ALIASES[lower] ?? null;
}
