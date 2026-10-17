import type { MistState } from '../../mistWorkspace';
/**
 * 开发工厂按供应商 ID 引用：测试夹具里的工厂名（A厂、测试面料厂…）预先登记为供应商档案，
 * 并让供应商 ID 与名称相同，便于断言版本号与提示文案。
 */
export const TEST_FACTORY_NAMES = ['A厂', 'B厂', 'C厂', 'D厂', 'E厂', '合成面料甲厂', '合成面料乙厂', '测试面料厂', '实际测试面料厂'];
export function withTestFactories<T extends MistState>(state: T, names: string[] = TEST_FACTORY_NAMES): T {
  names.forEach((name, index) => {
    if (state.market.suppliers.some(s => s.id === name)) return;
    const fabric = /面料/.test(name);
    state.market.suppliers.push({ id: name, code: `TF-${index + 1}`, name, type: fabric ? '面料工厂' : '成衣加工', country: 'CN', address: '测试地址', capabilities: fabric ? '织造、染整、面料试样' : '缝制、样衣制作', capacity: 1000, capacityUnit: fabric ? '米' : '件', leadDays: 7, status: 'active', blockReason: '', contacts: [], fileIds: [], note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as MistState['market']['suppliers'][number]);
  });
  return state;
}
