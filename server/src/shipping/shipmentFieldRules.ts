/**
 * shipmentFieldRules.ts — 运输方式（+装载方式）驱动必填字段规则（D1 拍板接线，2026-09-30）
 *
 * 拍板原文（`docs/业务变体矩阵-2026-09-16.md` D1，Kevin 2026-09-16）：
 *   2. **运输方式驱动必填字段**：
 *      - `Sea`     → 必填船名航次（vesselOrFlight / voyageNumber）；整柜另需集装箱号/封条号
 *      - `Air`     → 必填航班号；**不需要**集装箱号/封条号
 *      - `Courier` → 必填跟踪号（trackingNumber）；**不需要**港口字段
 *      - `Land`/`Rail` → 必填承运方与车牌/车号（与 D4 拍板 3 的工厂侧承运信息同组字段）
 *      现状：**全部可选、无按方式校验**（shippingMethod 仅出现在报表/统计/打印用途）。
 *
 * 设计纪律：
 *   · 本文件**只产出"缺什么"**，不抛错、不改写 —— 由调用方决定 400 还是别的行为（门禁/提示）；
 *   · **不做隐式归一**：shippingMethod 大小写/空白差异只做 trim，不猜缩写（"SEA"/"海运" 归不进枚举就是 OTHER）；
 *   · **装载方式正交**：FCL/LCL 是 loadType，不塞进 shippingMethod（矩阵点名 manifest.ts:537 的写法是错的）；
 *   · **未录不等于违规**：空值只在"该方式要求它"时才算缺；方式本身无法识别 ⇒ 不做校验（不自造规则）。
 */

export type ShipMethod = 'Sea' | 'Air' | 'Land' | 'Rail' | 'Courier';
export type LoadType = 'FCL' | 'LCL';

export interface ShipmentFieldSubject {
  shippingMethod?: string | null;
  loadType?: string | null;
  vesselOrFlight?: string | null;
  voyageNumber?: string | null;
  containerNumber?: string | null;
  sealNumber?: string | null;
  trackingNumber?: string | null;
  carrierName?: string | null;
  portOfLoading?: string | null;
  portOfDischarge?: string | null;
  vehicleNo?: string | null;
}

const METHODS: ShipMethod[] = ['Sea', 'Air', 'Land', 'Rail', 'Courier'];

/** 归一：只 trim + 首字母大写匹配；识别不出返回 null（不猜）。 */
export function normalizeShipMethod(raw: string | null | undefined): ShipMethod | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const hit = METHODS.find((m) => m.toLowerCase() === s.toLowerCase());
  return hit ?? null;
}

/** 归一装载方式：FCL/LCL（含常见写法 fcl/lcl）；其余返回 null（未录/无法识别 ⇒ 不做整柜校验）。 */
export function normalizeLoadType(raw: string | null | undefined): LoadType | null {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'FCL') return 'FCL';
  if (s === 'LCL') return 'LCL';
  return null;
}

const blank = (v: string | null | undefined): boolean => String(v ?? '').trim().length === 0;

/**
 * 纯函数：按运输方式（+装载方式）算出**缺哪些必填字段**。
 * 返回 label 数组（供界面直接提示）；无缺失返回空数组。
 * 方式无法识别 ⇒ 返回空数组（不做校验，绝不自造规则）。
 */
export function missingRequiredShipmentFields(s: ShipmentFieldSubject): string[] {
  const method = normalizeShipMethod(s.shippingMethod);
  if (!method) return [];
  const miss: string[] = [];

  if (method === 'Sea') {
    if (blank(s.vesselOrFlight)) miss.push('船名/航次(vesselOrFlight)');
    if (blank(s.voyageNumber)) miss.push('航次号(voyageNumber)');
    // 整柜才要求箱号/封条；拼柜由柜聚合体承载，单票不强制
    if (normalizeLoadType(s.loadType) === 'FCL') {
      if (blank(s.containerNumber)) miss.push('集装箱号(containerNumber)');
      if (blank(s.sealNumber)) miss.push('封条号(sealNumber)');
    }
    if (blank(s.portOfLoading)) miss.push('起运港(portOfLoading)');
    if (blank(s.portOfDischarge)) miss.push('目的港(portOfDischarge)');
    return miss;
  }

  if (method === 'Air') {
    if (blank(s.vesselOrFlight)) miss.push('航班号(vesselOrFlight)');
    if (blank(s.portOfLoading)) miss.push('起运机场(portOfLoading)');
    if (blank(s.portOfDischarge)) miss.push('目的机场(portOfDischarge)');
    // ★ Air 不需要集装箱号/封条号 —— 明确不校验（矩阵口径）
    return miss;
  }

  if (method === 'Courier') {
    if (blank(s.trackingNumber)) miss.push('快递跟踪号(trackingNumber)');
    // ★ Courier 不需要港口字段 —— 明确不校验
    return miss;
  }

  // Land / Rail
  if (blank(s.carrierName)) miss.push('承运方(carrierName)');
  if (blank(s.vehicleNo)) miss.push('车牌/车号(vehicleNo)');
  return miss;
}
