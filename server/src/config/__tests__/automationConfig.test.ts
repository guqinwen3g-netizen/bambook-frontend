/**
 * 自动化规则配置服务单元测试
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error('ENOENT'); // 文件不存在，使用默认值
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('../../lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  isLinkageEnabled,
  listAutomationRules,
  setRuleEnabled,
  AUTOMATION_RULES,
} from '../automationConfig';

describe('AutomationConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置模块级缓存 — 通过重新 require 实现
    vi.resetModules();
  });

  describe('listAutomationRules', () => {
    it('returns all 10 automation rules', () => {
      // 10 条 = L1–L11（无 L4）。L11 是 T3（H8 成品入库）新增的 ProductionCompleted 联动，
      // 与 L1–L10 同结构同开关语义。**新增联动必须同步改这里**——清单钉住的是"配置页能开关哪些联动"。
      const rules = listAutomationRules();
      expect(rules).toHaveLength(10);
      expect(rules.map(r => r.id)).toEqual([
        'L1_init_production',
        'L2_create_shipment',
        'L3_issue_invoice',
        'L5_auto_allocate',
        'L6_create_bom_draft',
        'L7_create_procurement',
        'L8_auto_stock_in',
        'L9_convert_quotation_to_order',
        'L10_create_tax_refund_draft',
        'L11_finished_goods_stock_in',
      ]);
    });

    it('all rules are enabled by default', () => {
      const rules = listAutomationRules();
      for (const rule of rules) {
        expect(rule.enabled).toBe(true);
      }
    });

    it('each rule has name, description, and eventType', () => {
      const rules = listAutomationRules();
      for (const rule of rules) {
        expect(rule.name).toBeTruthy();
        expect(rule.description).toBeTruthy();
        expect(rule.eventType).toBeTruthy();
      }
    });
  });

  describe('isLinkageEnabled', () => {
    it('returns true for all known rules by default', () => {
      for (const rule of AUTOMATION_RULES) {
        expect(isLinkageEnabled(rule.id)).toBe(true);
      }
    });

    it('returns true for unknown rule IDs (fail-open)', () => {
      expect(isLinkageEnabled('unknown_rule')).toBe(true);
    });
  });

  describe('setRuleEnabled', () => {
    it('disables a rule and returns updated rule', () => {
      const updated = setRuleEnabled('L1_init_production', false);
      expect(updated).not.toBeNull();
      expect(updated?.enabled).toBe(false);
    });

    it('after disabling, isLinkageEnabled returns false', () => {
      setRuleEnabled('L2_create_shipment', false);
      expect(isLinkageEnabled('L2_create_shipment')).toBe(false);
    });

    it('after re-enabling, isLinkageEnabled returns true', () => {
      setRuleEnabled('L3_issue_invoice', false);
      expect(isLinkageEnabled('L3_issue_invoice')).toBe(false);
      setRuleEnabled('L3_issue_invoice', true);
      expect(isLinkageEnabled('L3_issue_invoice')).toBe(true);
    });

    it('returns null for unknown rule ID', () => {
      const result = setRuleEnabled('nonexistent', true);
      expect(result).toBeNull();
    });

    it('listAutomationRules reflects updated state', () => {
      setRuleEnabled('L5_auto_allocate', false);
      const rules = listAutomationRules();
      const l5 = rules.find(r => r.id === 'L5_auto_allocate');
      expect(l5?.enabled).toBe(false);
    });
  });
});
