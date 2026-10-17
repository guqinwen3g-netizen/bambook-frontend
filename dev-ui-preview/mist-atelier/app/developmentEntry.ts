import type { RouteTarget } from './nav';

/**
 * 「开发与寻样」入口：成衣开发、面料开发、面料寻样是三种并列业务，各自独立。
 * 寻样只在现有面料档案与供应商范围内查找，不与开发案互相转换或预填。
 * 当前页签保存在路由 section，刷新、返回、⌘K 与侧栏入口都按它落到同一页签。
 */
export type DevelopmentListTab = 'garment' | 'fabric' | 'sourcing';
export const DEVELOPMENT_LIST_TABS: ReadonlyArray<{ value: DevelopmentListTab; label: string; create: string }> = [
  { value: 'garment', label: '成衣开发', create: '新建成衣开发案' },
  { value: 'fabric', label: '面料开发', create: '新建面料开发案' },
  { value: 'sourcing', label: '面料寻样', create: '新建面料寻样' },
];
/** 未指定或无法识别的页签回到第一个页签「成衣开发」。 */
export function developmentListTab(section?: string): DevelopmentListTab {
  return section === 'fabric' || section === 'sourcing' ? section : 'garment';
}
/** 面料寻样的新建流程：列表页 id=new 打开寻样表单。 */
export const SOURCING_CREATE_ID = 'new';
export type DevelopmentNavTarget = { view: string; id?: string; target: RouteTarget };
export function developmentListTarget(tab: DevelopmentListTab): DevelopmentNavTarget {
  return { view: 'development', target: { section: tab } };
}
export function developmentCreateTarget(tab: DevelopmentListTab): DevelopmentNavTarget {
  return tab === 'sourcing'
    ? { view: 'development', id: SOURCING_CREATE_ID, target: { section: 'sourcing' } }
    : { view: 'development/new', target: { section: tab } };
}
