import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  matchesOrderAnchor,
  navFilterDisplay,
  type CrossModuleNavFilter,
} from '../services/crossModuleNav';

/**
 * B1-③ 订单上下文贯通契约。
 *
 * 背景：订单详情「全链路」区块的 8 个下游阶段卡片此前只切 view、不带 orderId
 * → 采购/出运/财务/报价全部落地**全量列表**，业务员每次都要「跳过去再把这张单找回来」。
 *
 * 本契约锁定：订单锚（filter.anchor === 'order'）协议 + 订单详情 prime + 目标模块消费。
 */
const navSrc = readFileSync(new URL('./crossModuleNav.ts', import.meta.url), 'utf8');
const sectionSrc = readFileSync(new URL('../components/order/OrderContextSection.tsx', import.meta.url), 'utf8');
const procurementSrc = readFileSync(new URL('../components/ProcurementManager.tsx', import.meta.url), 'utf8');
const shipmentSrc = readFileSync(new URL('../components/ShipmentManager.tsx', import.meta.url), 'utf8');
const financeSrc = readFileSync(new URL('../components/FinanceManager.tsx', import.meta.url), 'utf8');
const quotationSrc = readFileSync(new URL('../components/QuotationManager.tsx', import.meta.url), 'utf8');
const bomSrc = readFileSync(new URL('../components/BomManager.tsx', import.meta.url), 'utf8');
const mesSrc = readFileSync(new URL('../components/MesManager.tsx', import.meta.url), 'utf8');
const devSrc = readFileSync(new URL('../components/DevelopmentManager.tsx', import.meta.url), 'utf8');

describe('订单锚匹配语义', () => {
  const filter: CrossModuleNavFilter = { anchor: 'order', orderId: 'SIM-ORD-001' };

  it('命中直接挂该订单的记录', () => {
    expect(matchesOrderAnchor({ orderId: 'SIM-ORD-001' }, filter)).toBe(true);
  });

  it('命中由该订单转化而来的记录（报价/开发案 convertedOrderId）', () => {
    expect(matchesOrderAnchor({ convertedOrderId: 'SIM-ORD-001' }, filter)).toBe(true);
  });

  it('不命中别的订单，且无 orderId 的记录被排除', () => {
    expect(matchesOrderAnchor({ orderId: 'SIM-ORD-002' }, filter)).toBe(false);
    expect(matchesOrderAnchor({}, filter)).toBe(false);
  });

  it('订单锚缺 orderId 时不过滤（防御：不误清空列表）', () => {
    expect(matchesOrderAnchor({ orderId: 'SIM-ORD-002' }, { anchor: 'order' })).toBe(true);
  });

  it('筛选提示条按锚点出文案（订单显示 orderNumber + （订单））', () => {
    expect(navFilterDisplay({ anchor: 'order', orderId: 'SIM-ORD-001', orderNumber: 'SIM-ORD-001' }))
      .toEqual({ name: 'SIM-ORD-001', suffix: '（订单）' });
    expect(navFilterDisplay({ anchor: 'order', orderId: 'SIM-ORD-001' }))
      .toEqual({ name: 'SIM-ORD-001', suffix: '（订单）' });
  });
});

describe('订单详情 prime + 目标模块消费', () => {
  it('协议支持 order 锚（类型 + 解析）', () => {
    expect(navSrc).toContain("export type NavAnchorKind = 'relation' | 'product' | 'order';");
    expect(navSrc).toContain("anchor === 'order' && typeof parsed.filter.orderId === 'string'");
  });

  it('订单详情阶段卡片 prime 订单锚后再导航', () => {
    expect(sectionSrc).toContain("import { primeCrossModuleNav } from '../../services/crossModuleNav';");
    expect(sectionSrc).toContain('primeCrossModuleNav({');
    expect(sectionSrc).toContain("filter: { anchor: 'order', orderId, orderNumber: orderId }");
    expect(sectionSrc).toContain('onNavigate?.(stage.view);');
  });

  it('采购 / 出运 / 财务 / 报价 四模块按订单锚筛选', () => {
    for (const [name, src] of [
      ['ProcurementManager', procurementSrc],
      ['ShipmentManager', shipmentSrc],
      ['FinanceManager', financeSrc],
      ['QuotationManager', quotationSrc],
    ] as const) {
      expect(src, `${name} 应消费订单锚`).toContain('matchesOrderAnchor');
      expect(src, `${name} 应判断 anchor === 'order'`).toContain("anchor === 'order'");
    }
  });

  it('财务页同时覆盖发票与凭证两条列表', () => {
    const hits = financeSrc.split("navRelationFilter?.anchor === 'order'").length - 1;
    expect(hits).toBeGreaterThanOrEqual(2);
  });

  it('BOM / 外协(MES) / 开发 三模块也消费订单锚', () => {
    // BOM：订单锚需要把 orderId 一起传进 matchesRelationFilter（此前只传产品锚）
    expect(bomSrc).toContain('orderId: (b as any).orderId ?? null');
    // MES：外协订单 + 排产两条列表都按订单锚过滤
    expect(mesSrc).toContain('import { consumeCrossModuleNav, matchesRelationFilter, matchesOrderAnchor }');
    expect(mesSrc).toContain('orderId: oso.orderId ?? null');
    expect(mesSrc).toContain("if (navRelationFilter?.anchor === 'order'");
    // 开发：统一走 matchesRelationFilter，开发案与订单的关系字段是 linkedOrderId
    expect(devSrc).toContain('matchesRelationFilter } from');
    expect(devSrc).toContain('convertedOrderId: item.linkedOrderId ?? null,');
  });
});
