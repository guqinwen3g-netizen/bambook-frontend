/**
 * orderLineShippedQty 单测 —— ★ C3：出运分配 → 订单行已出运量的归属真源
 *
 * 为什么要有这个测试：`OrderLine.shipmentQuantity` 是订单详情「溢短装条款」面板的
 * **唯一数据源**，而它此前**从不被出运模块写入** ⇒ 面板永远显示「未发货」、
 * 短装/溢装判定从不触发（一块永远绿的假面板）。本真源把它接上。
 *
 * 纯函数部分在这里钉死口径；「接线是否真的落到库」由真库演练
 * （`orderLineShippedQtyDrill.test.ts`）钉。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { attributeShippedQtyToLines, lineShares } from '../orderLineShippedQty';

const L = (id: string, quantity: number, unit: string | null = 'M') => ({ id, quantity, unit });
const A = (orderLineId: string | null, actualQty: number, unit: string | null = 'M', shipmentId = 'S1') =>
  ({ orderLineId, shipmentId, actualQty, unit });

describe('lineShares（行量比例分摊）', () => {
  it('按行量比例', () => {
    const m = lineShares([L('a', 10000), L('b', 5000)]);
    expect(m.get('a')).toBeCloseTo(2 / 3, 8);
    expect(m.get('b')).toBeCloseTo(1 / 3, 8);
  });

  it('行量全非法/为 0 → 退化为均分（不除零）', () => {
    const m = lineShares([L('a', 0), L('b', 0)]);
    expect(m.get('a')).toBe(0.5);
    expect(m.get('b')).toBe(0.5);
  });

  it('负数量不计入分母（脏数据不制造负份额）', () => {
    const m = lineShares([L('a', -100), L('b', 100)]);
    expect(m.get('a')).toBe(0);
    expect(m.get('b')).toBe(1);
  });
});

describe('attributeShippedQtyToLines', () => {
  it('① 行级分配：全额归该行', () => {
    const r = attributeShippedQtyToLines({
      lines: [L('a', 10000), L('b', 5000)],
      allocations: [A('a', 6000)],
    });
    expect(r.byLine.get('a')).toBe(6000);
    expect(r.byLine.get('b')).toBe(0);
    expect(r.incomparable).toEqual([]);
  });

  it('② 整单分配（orderLineId=null）：按行量比例分摊', () => {
    const r = attributeShippedQtyToLines({
      lines: [L('a', 10000), L('b', 5000)],
      allocations: [A(null, 9000)],
    });
    expect(r.byLine.get('a')).toBe(6000); // 9000 × 2/3
    expect(r.byLine.get('b')).toBe(3000); // 9000 × 1/3
  });

  it('③ 行级 + 整单混合：各自累加', () => {
    const r = attributeShippedQtyToLines({
      lines: [L('a', 10000), L('b', 10000)],
      allocations: [A('a', 1000), A(null, 4000)],
    });
    expect(r.byLine.get('a')).toBe(3000); // 1000 + 2000
    expect(r.byLine.get('b')).toBe(2000);
  });

  it('④ 跨单位换算：分配 YD → 行 M 按公共库换算（1 yd = 0.9144 m）', () => {
    const r = attributeShippedQtyToLines({
      lines: [L('a', 1000, 'M')],
      allocations: [A('a', 100, 'YD')],
    });
    expect(r.byLine.get('a')).toBeCloseTo(91.44, 4);
  });

  it('⑤ ★ 单位不可互算（行 M vs 分配 PCS）→ 不计入 + 显式上报（不猜）', () => {
    const r = attributeShippedQtyToLines({
      lines: [L('a', 1000, 'M')],
      allocations: [A('a', 100, 'PCS')],
    });
    expect(r.byLine.get('a')).toBe(0);
    expect(r.incomparable).toHaveLength(1);
    expect(r.incomparable[0]).toMatchObject({ orderLineId: 'a', unit: 'PCS' });
  });

  it('⑥ 订单没有行 → 分配全部 unallocatable（不凭空造行）', () => {
    const r = attributeShippedQtyToLines({ lines: [], allocations: [A(null, 500)] });
    expect(r.byLine.size).toBe(0);
    expect(r.unallocatable).toEqual(['S1']);
  });

  it('⑦ actualQty 为 0/null/负/NaN → 跳过（不制造负数出运量）', () => {
    const r = attributeShippedQtyToLines({
      lines: [L('a', 1000)],
      allocations: [A('a', 0), A('a', null as any), A('a', -5), A('a', Number.NaN)],
    });
    expect(r.byLine.get('a')).toBe(0);
    expect(r.incomparable).toEqual([]);
  });

  it('⑧ 分配指向**别的订单的行**（脏数据）→ 按整单处理（分摊到本单行），不静默丢弃', () => {
    const r = attributeShippedQtyToLines({
      lines: [L('a', 1000)],
      allocations: [A('NOT_MY_LINE', 800)],
    });
    expect(r.byLine.get('a')).toBe(800);
  });
});

/**
 * ★ 结构守卫：快照同步的**收口点计数对撞**
 *
 * 判据不是「文件里提到过函数名」，而是**调用次数精确等于设计值** ——
 * 这样「新增一条出运写路径却忘了同步」会立刻红，而「删掉一处调用」也会红。
 * （本仓已多次踩「覆盖面 < 写法面」的坑，故用计数而不是 toContain。）
 */
describe('★ 结构守卫：syncOrderLineShipmentQuantity 的收口点', () => {
  const src = (rel: string) => readFileSync(path.resolve(process.cwd(), 'src', rel), 'utf8');
  const countCalls = (text: string) => (text.match(/syncOrderLineShipmentQuantity\(/g) ?? []).length;

  it('allocationService：新增/更新/删除分配三条路径都要同步（= 3）', () => {
    const s = src('shipping/allocationService.ts');
    expect(s).toMatch(/from '\.\.\/shared\/orderLineShippedQty'/);
    expect(countCalls(s)).toBe(3);
  });

  it('shipmentMutationService：取消票 + 软删票两条路径都要同步（= 2）', () => {
    const s = src('shipping/shipmentMutationService.ts');
    expect(s).toMatch(/from '\.\.\/shared\/orderLineShippedQty'/);
    expect(countCalls(s)).toBe(2);
  });

  it('lineShares 不得再各自实现（allocationService 必须 import 真源）', () => {
    const s = src('shipping/allocationService.ts');
    expect(s).toMatch(/lineShares/);
    expect(s).toMatch(/import \{ lineShares/);
    // 反向：不得再出现本地函数定义
    expect(s).not.toMatch(/function lineShares\(/);
  });

  it('记录在案：内部交易（internalTransferService）是**另一个**合法写入方（双轨未合并）', () => {
    const s = src('internalTrade/internalTransferService.ts');
    // Native deliveries now aggregate only the stable garment line, rather
    // than assigning a material-wide cumulative quantity to every line.
    expect(s).toMatch(/where:\s*\{ id: next\.garmentOrderLineId!/);
    expect(s).toMatch(/shipmentQuantity:\s*totals\.shipped\.toNumber\(\)/);
  });
});
