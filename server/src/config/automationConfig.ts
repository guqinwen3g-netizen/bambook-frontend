/**
 * 自动化规则配置服务
 *
 * 设计：
 *   - 内存缓存 + 文件持久化（server/data/automation-config.json）
 *   - 启动时加载，API 修改时同步写盘
 *   - 单租户桌面 ERP 场景，无需数据库迁移
 *
 * 规则清单：
 *   L1_init_production: 订单确认→初始化生产管线
 *   L2_create_shipment: 生产完成→创建发货单草稿
 *   L3_issue_invoice: 发货完成→创建发票草稿
 *   L5_auto_allocate: 收款登记→匹配建议（财务确认后核销）
 *   L6_create_bom_draft: 订单确认→生成 BOM 草稿（从模板复制）
 *   L7_create_procurement: BOM 确认→生成采购需求草稿
 *   L8_auto_stock_in: 采购来料→自动入库
 *   L9_convert_quotation_to_order: 报价接受→自动转订单草稿
 *
 * 不变量：
 *   - 配置读取永不抛错（失败时返回默认值，所有规则默认 enabled）
 *   - 配置写入失败仅日志，不阻断 API 响应
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../lib/logger';

export interface AutomationRule {
  id: string;
  name: string;
  description: string;
  eventType: string;
  enabled: boolean;
}

export const AUTOMATION_RULES: readonly AutomationRule[] = [
  {
    id: 'L1_init_production',
    name: '订单确认 → 初始化生产',
    description: '订单确认后自动初始化 10 阶段生产管线',
    eventType: 'OrderConfirmed',
    enabled: true,
  },
  {
    id: 'L2_create_shipment',
    name: '生产完成 → 创建发货单',
    description: '生产完成后自动创建发货单草稿（Draft 状态，需人工审核）',
    eventType: 'ProductionCompleted',
    enabled: true,
  },
  {
    id: 'L3_issue_invoice',
    name: '发货完成 → 创建发票',
    description: '发货交付后自动创建应收发票草稿（Draft 状态，需人工审核）',
    eventType: 'ShipmentCompleted',
    enabled: true,
  },
  {
    id: 'L5_auto_allocate',
    name: '收款登记 → 核销匹配建议',
    description: '收款登记后计算匹配建议；不改变余额，须由有核销权限的财务人员确认执行',
    eventType: 'PaymentVoucherCreated',
    enabled: true,
  },
  {
    id: 'L6_create_bom_draft',
    name: '订单确认 → 生成 BOM 草稿',
    description: '订单确认后从产品 BOM 模板复制生成 Draft BOM（需有已确认/归档的模板 BOM）',
    eventType: 'OrderConfirmed',
    enabled: true,
  },
  {
    id: 'L7_create_procurement',
    name: 'BOM 确认 → 生成采购需求',
    description: 'BOM 确认后自动生成 Draft 采购单（含物料行，由业务组经办人补齐，并按适用流程审批后发送）',
    eventType: 'BOMConfirmed',
    enabled: true,
  },
  {
    id: 'L8_auto_stock_in',
    name: '采购来料 → 自动入库',
    description: '采购来料接收后自动创建入库流水（需有 active 仓库，默认入主仓）',
    eventType: 'MaterialReceived',
    enabled: true,
  },
  {
    id: 'L9_convert_quotation_to_order',
    name: '报价接受 → 转订单草稿',
    description: '报价被接受后自动创建 Draft 订单（含行明细、条款带出，需人工审核后确认）',
    eventType: 'QuotationAccepted',
    enabled: true,
  },
  {
    id: 'L10_create_tax_refund_draft',
    name: '报关放行 → 退税申报草稿',
    description: '报关放行后自动核算生成退税申报草稿（FOB×汇率×HS退税率加权，需人工提交审核）',
    eventType: 'CustomsCleared',
    enabled: true,
  },
  {
    id: 'L11_finished_goods_stock_in',
    name: '生产完成 → 成品自动入库',
    description: '生产第 10 阶段完成后按订单行自动创建成品入库流水（默认入主仓，referenceType=Order）',
    eventType: 'ProductionCompleted',
    enabled: true,
  },
];

const CONFIG_DIR = join(process.cwd(), 'data');
const CONFIG_FILE = join(CONFIG_DIR, 'automation-config.json');

// 内存缓存
let configCache: Record<string, boolean> | null = null;

function loadConfig(): Record<string, boolean> {
  if (configCache) return configCache;

  // 默认值：所有规则 enabled
  const defaults: Record<string, boolean> = {};
  for (const rule of AUTOMATION_RULES) {
    defaults[rule.id] = rule.enabled;
  }

  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      // 合并：文件值覆盖默认值，新规则用默认值
      for (const rule of AUTOMATION_RULES) {
        if (typeof parsed[rule.id] === 'boolean') {
          defaults[rule.id] = parsed[rule.id];
        }
      }
    }
  } catch (e: any) {
    logger.warn('[AutomationConfig] failed to load config, using defaults', { error: e?.message });
  }

  configCache = defaults;
  return configCache;
}

function saveConfig(config: Record<string, boolean>): void {
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e: any) {
    logger.error('[AutomationConfig] failed to save config', { error: e?.message });
  }
}

/**
 * 检查指定联动规则是否启用。
 * 永不抛错 — 失败时返回 true（默认启用，避免意外阻断业务流程）。
 */
export function isLinkageEnabled(linkageId: string): boolean {
  try {
    const config = loadConfig();
    return config[linkageId] ?? true; // 未知规则默认启用
  } catch {
    return true;
  }
}

/**
 * 获取所有自动化规则（含当前启用状态）
 */
export function listAutomationRules(): AutomationRule[] {
  const config = loadConfig();
  return AUTOMATION_RULES.map(rule => ({
    ...rule,
    enabled: config[rule.id] ?? rule.enabled,
  }));
}

/**
 * 设置单个规则的启用状态
 */
export function setRuleEnabled(ruleId: string, enabled: boolean): AutomationRule | null {
  const rule = AUTOMATION_RULES.find(r => r.id === ruleId);
  if (!rule) return null;

  const config = loadConfig();
  config[ruleId] = enabled;
  configCache = config;
  saveConfig(config);

  logger.info('[AutomationConfig] rule updated', { ruleId, enabled });
  return { ...rule, enabled };
}
