/**
 * bomPluginEngine.ts — Phase 0-06 BOM 成本模型插件化引擎骨架
 *
 * 设计动机（系统思维）：
 *   现有的 bomService.ts aggregateCosts 是"单模型"（物料+人工+费用+利润），
 *   但真实业务需要：面料采购报价单（只算面料+损耗）、服装 FOB（整单FOB=物料+人工+费用+利润加成%）、
 *   服装 CM（代加工=仅人工+制造费用，不含面料）、后期：外贸 LDP、DDP、国内含税报价模型…
 *   每个模型有不同字段、不同公式。为避免 aggregateCosts 越写越胖（n 个 if-else），抽象成插件引擎。
 *
 * 三层架构：
 *   1. BOMCostModelPlugin 接口 — 每个成本模型实现一个 plugin（id/name/version/inputSchema/compute/validate）
 *   2. BOMPluginRegistry — 注册中心（register/unregister/list/compute）
 *   3. 3 个内置 plugin（本文件末尾），在 registry 默认 auto-register
 *
 * 与现有 bomService 的关系：
 *   - 非破坏性改造：bomService 继续使用 aggregateCosts（老代码兼容）
 *   - 新引擎的 aggregate* 函数复用 calcEffectiveQty/calcLineAmount/aggregateCosts 核心公式（单真源）
 *   - 未来 Phase 1/2 新报价页、新报价单生成可直接调用 registry.compute('FOB', input)
 */
import type { BOMLineInput, CostEstimateInput } from './bomService';
import {
  aggregateCosts as baseAggregateCosts,
  calcEffectiveQty as baseCalcEffectiveQty,
  calcLineAmount as baseCalcLineAmount,
} from './bomService';

export {
  // 把基础计算函数再导出，插件直接复用（避免重复造轮子）
  baseAggregateCosts,
  baseCalcEffectiveQty,
  baseCalcLineAmount,
};

// ────────────────────────────────────────────────────────────────────
// 通用类型
// ────────────────────────────────────────────────────────────────────
export type Currency = 'CNY' | 'USD' | 'EUR' | 'HKD' | string;

/** 所有成本模型的通用输入：BOM line + 成本估算 + 上下文（数量/汇率/币种/利润%）*/
export interface CommonBOMComputeInput {
  lines: BOMLineInput[];
  costEstimates?: CostEstimateInput[];
  /** 单款/单订单生产件数（分摊成本用，默认 1）*/
  productionQty?: number;
  /** 币种（默认 CNY）*/
  currency?: Currency;
  /** 汇率 CNY→目标币种：1 USD = 7.3 CNY → exchangeRate = 7.3（转 USD 时 ÷7.3）*/
  exchangeRate?: number;
  /** 利润率（%）：FOB 模型用；CM 模型忽略；默认 undefined（表示不加成）*/
  profitMarginPercent?: number;
  /** 利润金额加总 CNY（二选一：percent 或 金额，两者冲突时 金额优先）*/
  profitAmountCny?: number;
  /** 自定义上下文（插件各自扩展读取，不类型约束）*/
  extra?: Record<string, unknown>;
}

export interface BOMComputeBreakdownItem {
  key: string;
  label: string;
  amountCny: number;
  /** 可选：金额折算目标币种 */
  amountConverted?: number;
  note?: string;
}

export interface BOMComputeResult {
  /** 插件 id：确认模型来源（排错用）*/
  modelId: string;
  /** 模型输出的主指标（如 FOB=FOB单价，CM=CM单价，Fabric=面料单耗金额） */
  headlineCny: number;
  /** 折算 headlineConverted（exchangeRate 存在时算） */
  headlineConverted?: number;
  /** 单位：'piece' / 'yard' / 'set' / 'order' */
  unit: 'piece' | 'yard' | 'meter' | 'set' | 'order';
  /** 明细分解项（前端展示 / 审计快照）*/
  breakdown: BOMComputeBreakdownItem[];
  /** 币种 */
  currency: Currency;
  exchangeRateUsed?: number;
  productionQtyUsed: number;
  /** 聚合后的基础成本（所有模型都用，对齐 bomService aggregateCosts）*/
  baseCosts: {
    totalMaterialCost: number;
    totalLaborCost: number;
    totalOverheadCost: number;
    totalCost: number;
  };
  /** 利润（可能 null）*/
  profit: { amountCny: number | null; marginPercent: number | null };
  /** 插件运行时间 ms */
  computeMs?: number;
}

/**
 * 插件接口（所有成本模型实现此接口）
 */
export interface BOMCostModelPlugin<TExtra extends Record<string, unknown> = Record<string, unknown>> {
  id: string;            // 如 'fabric' / 'apparel-fob' / 'apparel-cm'
  name: string;          // 中文名：'面料成本模型'
  description: string;   // 一段解释（前端展示）
  version: string;       // '1.0.0'（日后升级不破坏老插件）
  /** 插件适用 BOM 类型范围（信息提示，不做强制校验）*/
  applicableProductCategories?: string[];
  /**
   * 可选：自定义输入校验（插件可要求 extra.xxx 必填）；throw 代表不合法
   * 默认实现：不校验（通过即合规）
   */
  validate?: (input: CommonBOMComputeInput & TExtra) => void | Promise<void>;
  /**
   * 核心：compute
   *   - 入参：CommonBOMComputeInput + TExtra
   *   - 出参：BOMComputeResult（统一结构，前端直接渲染）
   *   - 失败 throw；否则返回结果
   */
  compute: (input: CommonBOMComputeInput & TExtra) => BOMComputeResult | Promise<BOMComputeResult>;
}

// ────────────────────────────────────────────────────────────────────
// PluginRegistry — 注册 & 调度中心（线程安全：单进程内存对象）
// ────────────────────────────────────────────────────────────────────
export class BOMPluginRegistry {
  private plugins = new Map<string, BOMCostModelPlugin<any>>();

  /** 注册插件；若同 id 存在，抛错（防止两个模型互相覆盖）*/
  register<TExtra extends Record<string, unknown> = Record<string, unknown>>(plugin: BOMCostModelPlugin<TExtra>): this {
    if (!plugin || typeof plugin.id !== 'string' || !plugin.id.trim()) {
      throw new Error('BOMCostModelPlugin.register: plugin.id 必须是 non-empty string');
    }
    if (!plugin.compute || typeof plugin.compute !== 'function') {
      throw new Error(`BOMCostModelPlugin[${plugin.id}].compute 必须是函数`);
    }
    if (this.plugins.has(plugin.id)) {
      throw new Error(`BOMCostModelPlugin id 冲突：${plugin.id} 已注册，请先 unregister 再覆盖`);
    }
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  unregister(modelId: string): boolean {
    return this.plugins.delete(modelId);
  }

  list(): Array<{ id: string; name: string; description: string; version: string; applicableProductCategories?: string[] }> {
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      version: p.version,
      applicableProductCategories: p.applicableProductCategories,
    }));
  }

  get(modelId: string): BOMCostModelPlugin<any> | undefined {
    return this.plugins.get(modelId);
  }

  has(modelId: string): boolean {
    return this.plugins.has(modelId);
  }

  async compute(modelId: string, input: CommonBOMComputeInput): Promise<BOMComputeResult> {
    const plugin = this.plugins.get(modelId);
    if (!plugin) {
      throw new Error(`BOMCostModelPlugin[${modelId}] 未注册；已注册模型：${Array.from(this.plugins.keys()).join(',') || '(空)'}`);
    }
    const t0 = Date.now();
    if (plugin.validate) {
      await Promise.resolve(plugin.validate(input));
    }
    const result = await Promise.resolve(plugin.compute(input));
    const computeMs = Date.now() - t0;
    return { ...result, computeMs };
  }
}

// ────────────────────────────────────────────────────────────────────
// 辅助：把 CommonBOMComputeInput 规范化（缺省值填好），插件不用各自判断
// ────────────────────────────────────────────────────────────────────
export function normalizeInput(input: CommonBOMComputeInput): Required<Pick<CommonBOMComputeInput, 'lines' | 'productionQty' | 'currency'>> & CommonBOMComputeInput {
  return {
    ...input,
    lines: input.lines || [],
    costEstimates: input.costEstimates || [],
    productionQty: input.productionQty ?? 1,
    currency: input.currency || 'CNY',
  };
}

function maybeConvert(cny: number, exchangeRate?: number): number | undefined {
  if (!exchangeRate || exchangeRate <= 0) return undefined;
  return Math.round((cny / exchangeRate) * 10000) / 10000;
}

function addBreakdown(
  arr: BOMComputeBreakdownItem[],
  key: string, label: string, amountCny: number,
  exchangeRate?: number, note?: string,
) {
  arr.push({
    key, label, amountCny,
    amountConverted: maybeConvert(amountCny, exchangeRate),
    note,
  });
}

// ────────────────────────────────────────────────────────────────────
// 内置插件 1：面料成本模型 FabricCostModelPlugin
//   适用：BOM 以面料行为主（面料报价单、单耗核算、采购面料预算）
//   输出：headline=单面料单耗金额 CNY（按 1 件/1 set 分摊）
//         仅算 Fabric/Lining/Pocketing/Trimmings(如里辅料) + wastage，
//         不统计 Labor/Overhead（CM 插件算那些）
// ────────────────────────────────────────────────────────────────────
export const FabricCostModelPlugin: BOMCostModelPlugin<{
  /** 只统计这些 materialType；默认 Fabric/Lining/Pocketing/Contrast */
  includeMaterialTypes?: string[];
}> = {
  id: 'fabric',
  name: '面料成本模型',
  description: '仅统计 BOM 面料类行（主布/里布/袋布/配色布）金额，含损耗；不含人工、制造费用。适合面料报价单、单耗预算。',
  version: '1.0.0',
  applicableProductCategories: ['Fabric', 'Apparel', 'Accessory'],

  compute(rawInput) {
    const input = normalizeInput(rawInput);
    // 兼容两种传法：TExtra 平级（符合接口签名）或 rawInput.extra.*（用户习惯）
    const includeTypesParam =
      (rawInput as any).includeMaterialTypes ??
      (rawInput as any).extra?.includeMaterialTypes;
    const includeTypes = new Set(includeTypesParam ?? ['Main', 'Contrast', 'Lining', 'Pocketing']);
    const productionQty = input.productionQty;

    const filteredLines: BOMLineInput[] = input.lines.filter(l => includeTypes.has(l.materialType || l.category || ''));
    const estimates = input.costEstimates || [];
    // 只保留 Material 类型 estimates（其他类型不参与面料模型）
    const onlyMaterialEstimates = estimates.filter(e => e.costType === 'Material');

    const { totalMaterialCost, totalLaborCost, totalOverheadCost, totalCost } = baseAggregateCosts(filteredLines, onlyMaterialEstimates);

    const perPieceMaterial = Math.round((totalMaterialCost / Math.max(1, productionQty)) * 10000) / 10000;

    const breakdown: BOMComputeBreakdownItem[] = [];
    addBreakdown(breakdown, 'material_total', '面料类物料总计（含损耗）', totalMaterialCost, input.exchangeRate,
      `${filteredLines.length} 行，按 includeMaterialTypes 过滤`);

    let i = 0;
    for (const l of filteredLines) {
      i++;
      const qty = baseCalcEffectiveQty(l.quantity, l.wastagePercent ?? 0);
      const amt = baseCalcLineAmount(qty, l.unitCost);
      // BOMLineInput.description 是官方字段；测试里传的 name/color 以 (l as any) 读取，存在则展示
      const anyL = l as any;
      const lineLabel = [anyL.name, anyL.description].filter(Boolean).join(' — ') || l.materialType || '面料行';
      const tail = anyL.color ? ` / ${anyL.color}` : '';
      addBreakdown(breakdown, `line_${i}`, `${lineLabel}${tail}`, amt, input.exchangeRate,
        `单耗 ${l.quantity} + 损耗${l.wastagePercent ?? 0}% = ${qty} × 单价${l.unitCost}`);
    }

    const profitCny = input.profitAmountCny ?? (
      input.profitMarginPercent != null ? Math.round(perPieceMaterial * input.profitMarginPercent / 100 * 10000) / 10000 : 0
    );
    const headlineCny = Math.round((perPieceMaterial + profitCny) * 10000) / 10000;

    return {
      modelId: 'fabric',
      headlineCny,
      headlineConverted: maybeConvert(headlineCny, input.exchangeRate),
      unit: 'piece',
      breakdown,
      currency: input.currency,
      exchangeRateUsed: input.exchangeRate,
      productionQtyUsed: productionQty,
      baseCosts: { totalMaterialCost, totalLaborCost, totalOverheadCost, totalCost },
      profit: {
        amountCny: profitCny || null,
        marginPercent: input.profitMarginPercent ?? (profitCny ? Math.round(profitCny / perPieceMaterial * 10000) / 100 : null),
      },
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// 内置插件 2：服装 FOB（Free On Board）成本模型 ApparelFOBModelPlugin
//   含义：物料成本 + 人工成本 + 制造费用 + 利润 → 每单位 FOB 单价（Cny 或换算）
//   公式：FOB(pc) = (totalMaterial + totalLabor + totalOverhead) / qty + profit_per_pc
//   Track B 对齐用户指定公式：
//     FOB(USD) = [采购含税RMB − 采购含税RMB÷1.13×退税率 + 利润RMB] ÷ 汇率
//     —— 若 input.extra.taxRefundRate 存在（0~1，如 0.13=13%退税），则按此公式覆盖 Material；
//        否则走"标准加成利润率 FOB"
// ────────────────────────────────────────────────────────────────────
export const ApparelFOBModelPlugin: BOMCostModelPlugin<{
  /** 退税抵扣（Track B 语义：采购含税RMB − 含税RMB÷1.13×退税率 + 利润RMB ÷ 汇率）*/
  taxRefundRate?: number;
}> = {
  id: 'apparel-fob',
  name: '服装FOB报价模型',
  description: 'FOB（离岸价）= (面料+辅料+人工+制造费用)/件数 + 利润；可选 Track B 退税公式：[采购RMB − RMB÷1.13×退税率 + 利润] ÷ 汇率',
  version: '1.0.0',
  applicableProductCategories: ['Apparel', 'Garment'],

  validate(input) {
    if (input.profitMarginPercent != null && (input.profitMarginPercent < -50 || input.profitMarginPercent > 300)) {
      throw new Error(`FOB 利润百分比 profitMarginPercent=${input.profitMarginPercent} 异常（允许 -50~300）`);
    }
    const refundRate = (input as any).taxRefundRate ?? input.extra?.taxRefundRate;
    if (refundRate != null && (Number(refundRate) < 0 || Number(refundRate) > 0.2)) {
      throw new Error(`taxRefundRate 异常：${refundRate}（允许 0~0.20）`);
    }
  },

  compute(rawInput) {
    const input = normalizeInput(rawInput);
    const productionQty = Math.max(1, input.productionQty);
    const estimates = input.costEstimates || [];
    const base = baseAggregateCosts(input.lines, estimates);

    // Track B 退税公式（如指定了 taxRefundRate）
    const refundRate = (rawInput as any).taxRefundRate ?? rawInput.extra?.taxRefundRate as number | undefined;
    let totalCostCny: number;
    let note = '';
    const breakdown: BOMComputeBreakdownItem[] = [];

    if (refundRate != null) {
      // [采购含税RMB − 采购含税RMB÷1.13×退税率 + 利润RMB]
      const purchaseCny = base.totalMaterialCost;
      const refundCny = Math.round(purchaseCny / 1.13 * refundRate * 10000) / 10000;
      const netMaterial = Math.round((purchaseCny - refundCny) * 10000) / 10000;
      totalCostCny = Math.round((netMaterial + base.totalLaborCost + base.totalOverheadCost) * 10000) / 10000;
      note = `Track B 退税公式 applied：退税率 ${(refundRate * 100).toFixed(2)}%，退税抵减 -${refundCny}`;

      addBreakdown(breakdown, 'material_purchase', '采购含税RMB 物料成本（退税前）', purchaseCny, input.exchangeRate);
      addBreakdown(breakdown, 'tax_refund_deduction', `退税抵减（÷1.13 × ${(refundRate * 100).toFixed(2)}%）`, -refundCny, input.exchangeRate, `refundCny = ${purchaseCny}/1.13 × ${refundRate}`);
      addBreakdown(breakdown, 'material_net', '+ 退税后净物料成本', netMaterial, input.exchangeRate);
      addBreakdown(breakdown, 'labor', '+ 人工成本 totalLaborCost', base.totalLaborCost, input.exchangeRate);
      addBreakdown(breakdown, 'overhead', '+ 制造费用 totalOverheadCost', base.totalOverheadCost, input.exchangeRate);
      addBreakdown(breakdown, 'cost_total', '= 总成本 TotalCostCny', totalCostCny, input.exchangeRate);
    } else {
      totalCostCny = base.totalCost;
      addBreakdown(breakdown, 'material_total', '物料成本（含损耗 + Material类Estimate）', base.totalMaterialCost, input.exchangeRate);
      addBreakdown(breakdown, 'labor_total', '人工成本 LaborEstimates', base.totalLaborCost, input.exchangeRate);
      addBreakdown(breakdown, 'overhead_total', '制造费用 Overhead+Other 类Estimates', base.totalOverheadCost, input.exchangeRate);
      addBreakdown(breakdown, 'cost_total', '= 总成本 TotalCostCny', totalCostCny, input.exchangeRate);
    }

    const perPieceCost = Math.round((totalCostCny / productionQty) * 10000) / 10000;

    // 利润：profitAmountCny 优先；否则 profitMarginPercent%（按总成本加成）
    const qty = productionQty;
    let profitPerPiece: number;
    let totalProfit: number;
    let marginPercent: number | null = input.profitMarginPercent ?? null;

    if (input.profitAmountCny != null) {
      totalProfit = input.profitAmountCny;
      profitPerPiece = Math.round((totalProfit / qty) * 10000) / 10000;
      marginPercent = totalCostCny > 0 ? Math.round(totalProfit / totalCostCny * 10000) / 100 : null;
    } else if (input.profitMarginPercent != null) {
      // 加成按总成本（非单价）× 利润率
      totalProfit = Math.round(totalCostCny * input.profitMarginPercent / 100 * 10000) / 10000;
      profitPerPiece = Math.round((totalProfit / qty) * 10000) / 10000;
    } else {
      totalProfit = 0;
      profitPerPiece = 0;
    }

    addBreakdown(breakdown, 'cost_per_piece', '单位成本（总成本 ÷ 件数）', perPieceCost, input.exchangeRate,
      `总成本${totalCostCny} / ${qty}件`);
    addBreakdown(breakdown, 'profit_per_piece', '+ 单位利润 profit/pc', profitPerPiece, input.exchangeRate,
      `利润总计 ${totalProfit} / ${qty}件${marginPercent != null ? `，利润率${marginPercent}%` : ''}`);

    const headlineCny = Math.round((perPieceCost + profitPerPiece) * 10000) / 10000;

    if (note) {
      breakdown[breakdown.length - 1] = { ...breakdown[breakdown.length - 1], note: (breakdown[breakdown.length - 1].note || '') + ' | ' + note };
    }

    return {
      modelId: 'apparel-fob',
      headlineCny,
      headlineConverted: maybeConvert(headlineCny, input.exchangeRate),
      unit: 'piece',
      breakdown,
      currency: input.currency,
      exchangeRateUsed: input.exchangeRate,
      productionQtyUsed: qty,
      baseCosts: base,
      profit: {
        amountCny: totalProfit || null,
        marginPercent: marginPercent,
      },
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// 内置插件 3：服装 CM（Cut & Make）代工成本模型 ApparelCMModelPlugin
//   含义：来料加工（不含面料）= 人工 + 制造费用；常用于纯代工订单核算
//   公式：CM(pc) = (Labor + Overhead) / productionQty + profit_per_pc（可选）
// ────────────────────────────────────────────────────────────────────
export const ApparelCMModelPlugin: BOMCostModelPlugin = {
  id: 'apparel-cm',
  name: '服装CM代工模型',
  description: '来料加工（Cut & Make）仅核算人工成本 + 制造费用，不含物料；常用于"客户供料"纯代工订单报价。',
  version: '1.0.0',
  applicableProductCategories: ['Apparel', 'Garment', 'CMT'],

  compute(rawInput) {
    const input = normalizeInput(rawInput);
    const qty = Math.max(1, input.productionQty);
    const estimates = input.costEstimates || [];
    // 与 baseAggregateCosts 保持一致的口径：人工取 Labor 估算；制造费用取 Overhead + Other 估算
    const laborOnlyEstimates = estimates.filter(e => e.costType === 'Labor' || e.costType === 'Overhead' || e.costType === 'Other');
    const base = baseAggregateCosts([], laborOnlyEstimates); // 空 lines → 物料=0
    const cmTotal = Math.round((base.totalLaborCost + base.totalOverheadCost) * 10000) / 10000;

    const breakdown: BOMComputeBreakdownItem[] = [];
    addBreakdown(breakdown, 'labor_total', '人工成本 Labor', base.totalLaborCost, input.exchangeRate,
      `${laborOnlyEstimates.filter(e => e.costType === 'Labor').length} 项 Estimate`);
    addBreakdown(breakdown, 'overhead_total', '制造费用 Overhead+Other', base.totalOverheadCost, input.exchangeRate,
      `${laborOnlyEstimates.filter(e => e.costType !== 'Labor').length} 项 Estimate`);
    addBreakdown(breakdown, 'cm_total', '= CM 代工总成本 TotalCMCny', cmTotal, input.exchangeRate);

    const cmPerPieceCost = Math.round((cmTotal / qty) * 10000) / 10000;

    let totalProfit: number;
    let profitPerPiece: number;
    let marginPercent: number | null = input.profitMarginPercent ?? null;
    if (input.profitAmountCny != null) {
      totalProfit = input.profitAmountCny;
      profitPerPiece = Math.round((totalProfit / qty) * 10000) / 10000;
      marginPercent = cmTotal > 0 ? Math.round(totalProfit / cmTotal * 10000) / 100 : null;
    } else if (input.profitMarginPercent != null) {
      totalProfit = Math.round(cmTotal * input.profitMarginPercent / 100 * 10000) / 10000;
      profitPerPiece = Math.round((totalProfit / qty) * 10000) / 10000;
    } else {
      totalProfit = 0;
      profitPerPiece = 0;
    }

    addBreakdown(breakdown, 'cm_per_piece', 'CM 单位成本（总成本÷件数）', cmPerPieceCost, input.exchangeRate,
      `CMCny ${cmTotal} / ${qty}件`);
    if (profitPerPiece > 0 || input.profitMarginPercent != null || input.profitAmountCny != null) {
      addBreakdown(breakdown, 'cm_profit', '+ 单位利润 CM_profit/pc', profitPerPiece, input.exchangeRate,
        `利润总计 ${totalProfit} / ${qty}件`);
    }

    const headlineCny = Math.round((cmPerPieceCost + profitPerPiece) * 10000) / 10000;

    return {
      modelId: 'apparel-cm',
      headlineCny,
      headlineConverted: maybeConvert(headlineCny, input.exchangeRate),
      unit: 'piece',
      breakdown,
      currency: input.currency,
      exchangeRateUsed: input.exchangeRate,
      productionQtyUsed: qty,
      baseCosts: base,
      profit: { amountCny: totalProfit || null, marginPercent },
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// 默认 Global Registry：3 个内置插件 auto-register
//   业务调用：getDefaultBOMRegistry().compute('apparel-fob', input) → Promise<BOMComputeResult>
// ────────────────────────────────────────────────────────────────────
let _defaultRegistry: BOMPluginRegistry | null = null;
export function getDefaultBOMRegistry(): BOMPluginRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new BOMPluginRegistry()
      .register(FabricCostModelPlugin)
      .register(ApparelFOBModelPlugin)
      .register(ApparelCMModelPlugin);
  }
  return _defaultRegistry;
}
