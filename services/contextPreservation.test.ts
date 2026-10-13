import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * B2-④⑤⑥ 上下文不丢契约（源码文本断言）。
 *
 *   ④ 全局搜索 focusEntityId：Relations / Shipment / Finance 三模块此前只消费 filter，
 *      丢掉 focusEntityId → 跳客户/运单/发票落到列表而非该记录。
 *   ⑤ 「去补齐」把当前订单踢回列表：CompletenessIndicators 会 prime 订单锚，但
 *      App.handleViewChange 对 View.Orders 无条件 setSelectedOrder(null) → 选中被清掉。
 *   ⑥ 日历点事件只到列表：CalendarEvent 只有 targetView 无 targetId。
 */
const appSrc = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const relationsSrc = readFileSync(new URL('../components/RelationsManager.tsx', import.meta.url), 'utf8');
const shipmentSrc = readFileSync(new URL('../components/ShipmentManager.tsx', import.meta.url), 'utf8');
const financeSrc = readFileSync(new URL('../components/FinanceManager.tsx', import.meta.url), 'utf8');
const calendarSrc = readFileSync(new URL('../components/CalendarManager.tsx', import.meta.url), 'utf8');
const calendarEventsSrc = readFileSync(new URL('../utils/calendarEvents.ts', import.meta.url), 'utf8');

describe('B2-④ 全局搜索 focusEntityId 三模块消费', () => {
  it('RelationsManager：按 focusEntityId 打开档案详情（分类由其 category 派生）', () => {
    expect(relationsSrc).toContain("import { consumeCrossModuleNav } from '../services/crossModuleNav';");
    expect(relationsSrc).toContain("const navFocusRelationId = useState(() => consumeCrossModuleNav()?.focusEntityId ?? null)[0];");
    expect(relationsSrc).toContain('setSelectedCategory(isRelationCategory(hit.category) ? hit.category : null);');
    expect(relationsSrc).toContain("setNavLevel('detail');");
  });

  it('ShipmentManager：保留完整 navContext 并按 focusEntityId 选中运单', () => {
    expect(shipmentSrc).toContain('const [navContext] = useState(() => consumeCrossModuleNav());');
    expect(shipmentSrc).toContain('const navFocusId = navContext?.focusEntityId ?? null;');
    expect(shipmentSrc).toContain('setSelectedId(hit.id);');
  });

  it('FinanceManager：按 focusEntityId 切发票 tab 并选中（先切 tab 再落选中）', () => {
    expect(financeSrc).toContain('const navFocusInvoiceId = navContext?.focusEntityId ?? null;');
    expect(financeSrc).toContain("if (activeTab !== 'invoices') { setActiveTab('invoices'); return; }");
    expect(financeSrc).toContain('setSelectedId(navFocusInvoiceId);');
  });
});

describe('B2-⑤ 「去补齐」不再把当前订单踢回列表', () => {
  it('App.handleViewChange 读 pending 订单锚并选中，而不是无条件清空', () => {
    expect(appSrc).toContain("import { parseNotificationLink, peekCrossModuleNav } from './services/crossModuleNav';");
    expect(appSrc).toContain('const pending = peekCrossModuleNav();');
    expect(appSrc).toContain('const focusOrderId = pending?.view === View.Orders ? pending.focusEntityId : undefined;');
    expect(appSrc).toContain('setSelectedOrder(hit ?? null);');
    expect(appSrc).not.toContain('if (view === View.Orders) setSelectedOrder(null);');
  });
});

describe('B2-⑥ 日历事件带 targetId 直达记录', () => {
  it('CalendarEvent 有 targetId，且 9 个构造点全部填充', () => {
    expect(calendarEventsSrc).toContain('targetId?: string;');
    const targetIdHits = calendarEventsSrc.split('targetId: ').length - 1;
    // targetView 出现 10 次 = 接口声明 1 处 + 事件构造点 9 处；targetId 只在构造点出现
    const targetViewHits = calendarEventsSrc.split('targetView: View.').length - 1;
    expect(targetViewHits).toBe(10);
    expect(targetIdHits).toBe(9);
  });

  it('CalendarManager 点击事件 prime targetId 后再导航', () => {
    expect(calendarSrc).toContain("import { primeCrossModuleNav } from '../services/crossModuleNav';");
    expect(calendarSrc).toContain('primeCrossModuleNav({ view: event.targetView, focusEntityId: event.targetId });');
  });
});
