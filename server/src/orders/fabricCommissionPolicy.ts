/** Fabric supplier-to-us commission. This is separate from pricing's
 * CommissionPayable (our liability to an intermediary). */
import { Prisma } from '@prisma/client';
import { businessError } from '../shared/errorCodes';
import { isValidLocalDateKey } from '../shared/localDate';

export const FABRIC_SUPPLY_FIELDS = ['fabricSupplyMode', 'fabricCommissionRate', 'fabricCommissionSupplierId'] as const;
export type FabricSupplyMode = 'finished_purchase' | 'raw_material_processing' | 'commission';
export type FabricSupplyTerms = { fabricSupplyMode: FabricSupplyMode | null; fabricCommissionRate: string | null; fabricCommissionSupplierId: string | null };
export type FabricFinancialLine = { id: string; orderId?: string | null; description?: string | null; materialCode?: string | null;
  quantity?: unknown; unit?: unknown; unitPrice?: unknown; confirmedSourceType?: unknown; confirmedSourceId?: unknown; specSnapshot?: unknown;
  fabricSupplyMode?: unknown; fabricCommissionRate?: unknown; fabricCommissionSupplierId?: unknown };
export type FabricCommissionBranch = { id: string; orderLineId: string; revision: number; actualQuantity: unknown; shippedQuantity: unknown; unit: string };
export type FabricCommissionShipment = { shipmentId: string; shipmentLineId: string; orderLineId: string; quantity: unknown; unit: string;
  atd: string | null; state: string };
export type FabricCommissionCalculatedLine = { orderLineId: string; description: string | null; actualQuantity: string; unit: string;
  unitPrice: string; actualGoodsAmount: string; rate: string; commissionAmount: string; shipmentLineIds: string[] };
export type FabricCommissionGroup = { supplierId: string; goodsAmount: string; commissionAmount: string; lines: FabricCommissionCalculatedLine[] };

const invalid = (message: string): never => { throw businessError('INVALID_INPUT', message); };
const conflict = (message: string): never => { throw businessError('HANDOFF_CONFLICT', message); };
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
function decimal(value: unknown, label: string, zero = false): Prisma.Decimal {
  const raw = value instanceof Prisma.Decimal ? value.toString() : value;
  if ((typeof raw !== 'string' && typeof raw !== 'number') || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/.test(String(raw)))
    return invalid(`${label}须为最多四位小数的明确十进制数。`);
  const parsed = new Prisma.Decimal(raw);
  if (!parsed.isFinite() || (zero ? parsed.lt(0) : parsed.lte(0))) return invalid(`${label}无效。`);
  return parsed;
}

export function normalizeFabricSupplyTerms(input: Pick<FabricFinancialLine, typeof FABRIC_SUPPLY_FIELDS[number]>): FabricSupplyTerms {
  const mode = input.fabricSupplyMode ?? null, rate = input.fabricCommissionRate ?? null, supplierId = input.fabricCommissionSupplierId ?? null;
  if (mode !== null && !['finished_purchase', 'raw_material_processing', 'commission'].includes(String(mode)))
    return invalid('请选择准确面料供给方式，历史未知不能推断。');
  if (mode !== 'commission') {
    if (rate !== null || supplierId !== null) return invalid('非佣金模式不能保存佣金率或佣金付款供应商。');
    return { fabricSupplyMode: mode as FabricSupplyMode | null, fabricCommissionRate: null, fabricCommissionSupplierId: null };
  }
  const actualRate = decimal(rate, '约定佣金率');
  if (actualRate.gt(100)) return invalid('约定佣金率须大于0且不超过100%，不能把小数比例或金额混作百分数。');
  if (!text(supplierId) || String(supplierId).length > 200) return invalid('佣金模式须明确真实供货付款供应商。');
  return { fabricSupplyMode: 'commission', fabricCommissionRate: actualRate.toString(), fabricCommissionSupplierId: text(supplierId) };
}

/** Only approved commercial/source facts enter the basis. Fulfillment
 * projections and later notes cannot silently alter the original agreement. */
export function fabricCommissionFinancialLine(line: FabricFinancialLine) {
  const number = (value: unknown): string | null => value == null ? null : decimal(value, '订单行金额或数量', true).toString();
  return { id: line.id, orderId: line.orderId ?? null, description: line.description ?? null, materialCode: line.materialCode ?? null,
    quantity: number(line.quantity), unit: text(line.unit), unitPrice: number(line.unitPrice), ...normalizeFabricSupplyTerms(line),
    confirmedSourceType: line.confirmedSourceType ?? null, confirmedSourceId: line.confirmedSourceId ?? null, specSnapshot: line.specSnapshot ?? null };
}

/** Callers supply canonical native physical facts, never a client total or
 * Order.status. Every current real branch must finish shipping before the one
 * order settlement, including ordinary rows in a mixed order. */
export function calculateFabricCommission(lines: FabricFinancialLine[], branches: FabricCommissionBranch[], shipments: FabricCommissionShipment[]) {
  if (!lines.length || new Set(lines.map(line => line.id)).size !== lines.length || !branches.length || !shipments.length)
    return conflict('准确订单行、实际完工或实际出运依据尚未齐备，不能结算佣金。');
  if (new Set(branches.map(row => row.id)).size !== branches.length || new Set(shipments.map(row => row.shipmentLineId)).size !== shipments.length)
    return conflict('实际批次或装运行重复，不能重复累计佣金依据。');
  const ids = new Set(lines.map(line => line.id));
  if ([...branches, ...shipments].some(row => !ids.has(row.orderLineId))) return conflict('结算来源混入其他订单条目。');
  const groups = new Map<string, FabricCommissionGroup>();
  for (const line of [...lines].sort((a, b) => a.id.localeCompare(b.id))) {
    const terms = normalizeFabricSupplyTerms(line), unit = text(line.unit), price = decimal(line.unitPrice, '已批准单价', true);
    const currentBranches = branches.filter(row => row.orderLineId === line.id), actualRows = shipments.filter(row => row.orderLineId === line.id);
    if (!unit || !currentBranches.length || !actualRows.length || currentBranches.some(row => row.unit !== unit || !Number.isSafeInteger(row.revision) || row.revision < 1)
      || actualRows.some(row => row.unit !== unit || row.state !== 'shipped' || !row.atd || !isValidLocalDateKey(row.atd)))
      return conflict('全订单仍有未知、未完工或未实际离港批次，不能按首批出运结算。');
    const actualQuantity = currentBranches.reduce((sum, row) => {
      const actual = decimal(row.actualQuantity, '实际完工量'), shipped = decimal(row.shippedQuantity, '实际出运量', true);
      if (!actual.eq(shipped)) return conflict('真实批次仍有未出运实物或数量不一致，须全部批次实际出运后一次结算。');
      return sum.plus(actual);
    }, new Prisma.Decimal(0));
    const shippedQuantity = actualRows.reduce((sum, row) => sum.plus(decimal(row.quantity, '真实装运行数量')), new Prisma.Decimal(0));
    if (!actualQuantity.eq(shippedQuantity)) return conflict('装运行与实际完工/物理出运数量不一致，不能结算。');
    if (terms.fabricSupplyMode !== 'commission') continue;
    if (price.lte(0)) return conflict('佣金行须有真实明确的正数货物单价，不能猜测实际出运金额。');
    const goods = actualRows.reduce((sum, row) => sum.plus(decimal(row.quantity, '真实装运行数量').mul(price).toDecimalPlaces(4)), new Prisma.Decimal(0));
    const commission = goods.mul(terms.fabricCommissionRate!).div(100).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    if (commission.lte(0)) return conflict('本次实际佣金按明确币值精度为零，不能生成虚假正数应收。');
    const supplierId = terms.fabricCommissionSupplierId!;
    const group = groups.get(supplierId) ?? { supplierId, goodsAmount: '0.0000', commissionAmount: '0.0000', lines: [] };
    group.lines.push({ orderLineId: line.id, description: line.description ?? null, actualQuantity: actualQuantity.toFixed(4), unit,
      unitPrice: price.toFixed(4), actualGoodsAmount: goods.toFixed(4), rate: terms.fabricCommissionRate!, commissionAmount: commission.toFixed(4),
      shipmentLineIds: actualRows.map(row => row.shipmentLineId).sort() });
    group.goodsAmount = new Prisma.Decimal(group.goodsAmount).plus(goods).toFixed(4);
    group.commissionAmount = new Prisma.Decimal(group.commissionAmount).plus(commission).toFixed(4);
    groups.set(supplierId, group);
  }
  if (!groups.size) return conflict('本订单没有经准确批准的面料佣金行，不能补造佣金结算。');
  return { groups: [...groups.values()].sort((a, b) => a.supplierId.localeCompare(b.supplierId)) };
}
