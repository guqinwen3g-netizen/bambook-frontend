// @vitest-environment jsdom
/**
 * crossModuleNav 导航协议行为测试
 *
 * 协议三段式：prime（写）→ consume（读+一次性清）→ 优雅降级。
 * 这里验证协议本体契约，目标 Manager 的接入面由
 * components/crossModuleNavWiring.test.ts 源码契约测试兜底。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  primeCrossModuleNav,
  consumeCrossModuleNav,
  peekCrossModuleNav,
  matchesRelationFilter,
  navFilterDisplay,
  parseNotificationLink,
  type CrossModuleNavContext,
} from './crossModuleNav';
import { View } from '../types';

const KEY = 'bambook_cross_module_nav';

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('primeCrossModuleNav → consumeCrossModuleNav round-trip', () => {
  it('preserves view / tab / filter and consumes exactly once', () => {
    primeCrossModuleNav({
      view: View.Customs,
      tab: 'taxRefunds',
      filter: { relationId: 'REL-1', relationName: 'Atlas Outfitters', relationRole: 'customer' },
    });

    const ctx = consumeCrossModuleNav();
    expect(ctx).not.toBeNull();
    expect(ctx!.view).toBe(View.Customs);
    expect(ctx!.tab).toBe('taxRefunds');
    expect(ctx!.filter).toEqual({
      anchor: 'relation',
      relationId: 'REL-1',
      relationName: 'Atlas Outfitters',
      relationRole: 'customer',
    });
    expect(typeof ctx!.primedAt).toBe('number');

    // 一次性消费：再次 consume 回到 null（刷新/再次进入回到默认视图）
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(consumeCrossModuleNav()).toBeNull();
  });

  it('returns null when nothing was primed', () => {
    expect(consumeCrossModuleNav()).toBeNull();
  });

  it('tolerates malformed stored JSON without throwing', () => {
    sessionStorage.setItem(KEY, '{not-json');
    expect(consumeCrossModuleNav()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('normalizes context: empty tab dropped, relationRole defaults to customer, invalid filter dropped', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: View.Orders, tab: '', filter: { relationId: '' }, primedAt: 1 }),
    );
    const ctx = consumeCrossModuleNav() as CrossModuleNavContext;
    expect(ctx.view).toBe(View.Orders);
    expect(ctx.tab).toBeUndefined();
    expect(ctx.filter).toBeUndefined();
    expect(ctx.primedAt).toBe(1);
  });

  it('keeps supplier role and treats non-string view as invalid context', () => {
    primeCrossModuleNav({
      view: View.Procurement,
      filter: { relationId: 'REL-2', relationRole: 'supplier' },
    });
    const ctx = consumeCrossModuleNav()!;
    expect(ctx.filter?.relationRole).toBe('supplier');

    sessionStorage.setItem(KEY, JSON.stringify({ view: 123 }));
    expect(consumeCrossModuleNav()).toBeNull();
  });

  it('silently degrades when sessionStorage.setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() =>
      primeCrossModuleNav({ view: View.Orders, filter: { relationId: 'REL-3' } }),
    ).not.toThrow();
  });

  it('peek inspects without consuming', () => {
    primeCrossModuleNav({ view: View.Invoices, tab: 'vatInvoices' });
    expect(peekCrossModuleNav()?.tab).toBe('vatInvoices');
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    expect(consumeCrossModuleNav()?.view).toBe(View.Invoices);
  });
});

describe('development relationship anchor', () => {
  it('preserves the actual Case anchor and display metadata without a Sample focus', () => {
    primeCrossModuleNav({ view: View.Samples, filter: { anchor: 'development', developmentCaseId: 'CASE-1',
      developmentCaseName: '春季试样', developmentCaseCode: 'DEV-1', developmentCaseType: 'garment' } });
    const context = consumeCrossModuleNav()!;
    expect(context.filter).toEqual({ anchor: 'development', developmentCaseId: 'CASE-1',
      developmentCaseName: '春季试样', developmentCaseCode: 'DEV-1', developmentCaseType: 'garment' });
    expect(context.focusEntityId).toBeUndefined();
    expect(navFilterDisplay(context.filter!)).toEqual({ name: 'DEV-1', suffix: '（开发案）' });
    expect(consumeCrossModuleNav()).toBeNull();
  });
  it('does not reinterpret an invalid development anchor as a Sample or relation focus', () => {
    sessionStorage.setItem(KEY, JSON.stringify({ view: View.Samples, focusEntityId: 'CASE-1',
      filter: { anchor: 'development', developmentCaseId: '', relationId: 'REL-1' } }));
    const context = consumeCrossModuleNav()!;
    expect(context.filter).toBeUndefined(); expect(context.focusEntityId).toBeUndefined();
  });
  it('matches only actual Case foreign keys, not the record ID or material relationship', () => {
    const filter = { anchor: 'development' as const, developmentCaseId: 'CASE-1' };
    expect(matchesRelationFilter({ sourceCaseId: 'CASE-1' }, filter)).toBe(true);
    expect(matchesRelationFilter({ developmentCaseId: 'CASE-1' }, filter)).toBe(true);
    expect(matchesRelationFilter({ productAssetId: 'CASE-1' }, filter)).toBe(false);
    expect(matchesRelationFilter({}, filter)).toBe(false);
  });
});

describe('matchesRelationFilter', () => {
  it('passes everything when filter is null', () => {
    expect(matchesRelationFilter({ customerRelationId: 'X' }, null)).toBe(true);
    expect(matchesRelationFilter({}, null)).toBe(true);
  });

  it('customer role matches customerRelationId or relationId', () => {
    const filter = { relationId: 'REL-1', relationRole: 'customer' as const };
    expect(matchesRelationFilter({ customerRelationId: 'REL-1' }, filter)).toBe(true);
    expect(matchesRelationFilter({ relationId: 'REL-1' }, filter)).toBe(true);
    expect(matchesRelationFilter({ customerRelationId: 'REL-2', supplierRelationId: 'REL-1' }, filter)).toBe(false);
  });

  it('supplier role matches supplierRelationId or relationId', () => {
    const filter = { relationId: 'REL-1', relationRole: 'supplier' as const };
    expect(matchesRelationFilter({ supplierRelationId: 'REL-1' }, filter)).toBe(true);
    expect(matchesRelationFilter({ relationId: 'REL-1' }, filter)).toBe(true);
    expect(matchesRelationFilter({ customerRelationId: 'REL-1' }, filter)).toBe(false);
  });

  it('product anchor matches by productAssetId, top-level codes, or line codes', () => {
    const filter = {
      anchor: 'product' as const,
      productId: 'PDT-1',
      productName: 'Navy Wool Twill',
      productCodes: ['ART-001', 'MQ-001'],
    };
    expect(matchesRelationFilter({ productAssetId: 'PDT-1' }, filter)).toBe(true);
    // 顶层编码命中
    expect(matchesRelationFilter({ itemNo: 'ART-001' }, filter)).toBe(true);
    // 子行编码命中（订单行 itemNo）
    expect(matchesRelationFilter({ lines: [{ itemNo: 'MQ-001' }] }, filter)).toBe(true);
    // 无关编码不命中
    expect(matchesRelationFilter({ lines: [{ itemNo: 'ZZ-999' }] }, filter)).toBe(false);
    // 无编码集合时不匹配顶层产品外记录
    expect(matchesRelationFilter({ itemNo: 'ART-001' }, { anchor: 'product' as const, productId: 'PDT-2' })).toBe(false);
  });
});

describe('product anchor round-trip', () => {
  it('preserves productId / productName / productCodes through prime→consume', () => {
    primeCrossModuleNav({
      view: View.Orders,
      filter: {
        anchor: 'product',
        productId: 'PDT-9',
        productName: 'Cashmere Blend',
        productCodes: ['SKU-9', 'ART-009', 'CL-009'],
      },
    });
    const ctx = consumeCrossModuleNav()!;
    expect(ctx.view).toBe(View.Orders);
    expect(ctx.filter).toEqual({
      anchor: 'product',
      productId: 'PDT-9',
      productName: 'Cashmere Blend',
      productCodes: ['SKU-9', 'ART-009', 'CL-009'],
    });
  });
});

describe('focusEntityId 直达锚 round-trip', () => {
  it('preserves focusEntityId alongside filter through prime→consume', () => {
    // 样品间跳产品档案：product 锚做列表过滤 + focusEntityId 精准打开详情
    primeCrossModuleNav({
      view: View.Products,
      filter: { anchor: 'product', productId: 'PDT-7', productName: 'Wool Twill' },
      focusEntityId: 'PDT-7',
    });
    const ctx = consumeCrossModuleNav()!;
    expect(ctx.view).toBe(View.Products);
    expect(ctx.focusEntityId).toBe('PDT-7');
    expect(ctx.filter?.anchor).toBe('product');
    expect(ctx.filter?.productId).toBe('PDT-7');
  });

  it('preserves focusEntityId alone (e.g. 样品间→开发单直达)', () => {
    primeCrossModuleNav({
      view: View.Development,
      focusEntityId: 'DEV-26003',
    });
    const ctx = consumeCrossModuleNav()!;
    expect(ctx.view).toBe(View.Development);
    expect(ctx.focusEntityId).toBe('DEV-26003');
    expect(ctx.filter).toBeUndefined();
  });

  it('drops empty / non-string focusEntityId during parseContext normalization', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: View.Development, focusEntityId: '', primedAt: 1 }),
    );
    const ctx = consumeCrossModuleNav() as CrossModuleNavContext;
    expect(ctx.focusEntityId).toBeUndefined();

    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: View.Development, focusEntityId: 123, primedAt: 1 }),
    );
    const ctx2 = consumeCrossModuleNav() as CrossModuleNavContext;
    expect(ctx2.focusEntityId).toBeUndefined();
  });

  it('clears focusEntityId together with filter when consume clears sessionStorage', () => {
    primeCrossModuleNav({
      view: View.Products,
      focusEntityId: 'PDT-99',
      filter: { anchor: 'product', productId: 'PDT-99' },
    });
    expect(consumeCrossModuleNav()?.focusEntityId).toBe('PDT-99');
    // 一次性消费后再次读取应为 null
    expect(consumeCrossModuleNav()).toBeNull();
  });
});

describe('params 深链参数通道 round-trip（完备度 fix.target 直达建档/挂档案）', () => {
  it('preserves params through prime→consume（create=1&sku 深链）', () => {
    primeCrossModuleNav({
      view: View.Products,
      params: { create: '1', sku: 'FB-902' },
    });
    const ctx = consumeCrossModuleNav()!;
    expect(ctx.view).toBe(View.Products);
    expect(ctx.params).toEqual({ create: '1', sku: 'FB-902' });
    // peek 不消费；consume 一次性读取
    expect(peekCrossModuleNav()).toBeNull();
  });

  it('preserves focus/action params for development-case 挂档案深链', () => {
    primeCrossModuleNav({
      view: View.Development,
      params: { focus: 'DEV-26001', action: 'link-product' },
    });
    const ctx = consumeCrossModuleNav()!;
    expect(ctx.view).toBe(View.Development);
    expect(ctx.params).toEqual({ focus: 'DEV-26001', action: 'link-product' });
  });

  it('drops empty / non-string param entries during parseContext normalization', () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: View.Products, params: { create: '1', sku: '', bad: 123 }, primedAt: 1 }),
    );
    const ctx = consumeCrossModuleNav() as CrossModuleNavContext;
    expect(ctx.params).toEqual({ create: '1' });

    sessionStorage.setItem(
      KEY,
      JSON.stringify({ view: View.Products, params: 'not-an-object', primedAt: 1 }),
    );
    const ctx2 = consumeCrossModuleNav() as CrossModuleNavContext;
    expect(ctx2.params).toBeUndefined();
  });
});

describe('parseNotificationLink（通知 link → 结构化导航目标）', () => {
  it('解析订单通知：view + id（App 侧走 handleOpenOrderById 直达详情）', () => {
    const r = parseNotificationLink('/orders?id=ORD-123&tab=production');
    expect(r).toEqual({ view: View.Orders, tab: 'production', id: 'ORD-123', params: {} });
  });

  it('解析发票通知：finance?tab=invoices → Invoices 视图 + tab 定位', () => {
    const r = parseNotificationLink('/finance?tab=invoices&id=INV-9');
    expect(r!.view).toBe(View.Invoices);
    expect(r!.tab).toBe('invoices');
    expect(r!.id).toBe('INV-9');
  });

  it('finance?tab=vouchers 细分为 PaymentVouchers 视图（App 双 View 挂同一 FinanceManager）', () => {
    const r = parseNotificationLink('/finance?tab=vouchers&id=PV-1');
    expect(r!.view).toBe(View.PaymentVouchers);
    expect(r!.tab).toBe('vouchers');
  });

  it('解析 CRM 通知：relationId 等其余参数收入 params', () => {
    const r = parseNotificationLink('/crm?relationId=REL-7&tab=credit');
    expect(r!.view).toBe(View.CRM);
    expect(r!.tab).toBe('credit');
    expect(r!.params).toEqual({ relationId: 'REL-7' });
  });

  it('解析关务通知（tab=lettersOfCredit）与无 query 的路径', () => {
    expect(parseNotificationLink('/customs?tab=lettersOfCredit&id=LC-2')!.view).toBe(View.Customs);
    const bare = parseNotificationLink('/shipments');
    expect(bare).toEqual({ view: View.Shipments, tab: undefined, id: undefined, params: {} });
  });

  it('兼容 # 前缀与未映射路径段/空值降级为 null（调用方不执行导航）', () => {
    expect(parseNotificationLink('#/orders?id=O-1')!.id).toBe('O-1');
    expect(parseNotificationLink('/unknown-module?id=1')).toBeNull();
    expect(parseNotificationLink(null)).toBeNull();
    expect(parseNotificationLink('')).toBeNull();
  });
});
