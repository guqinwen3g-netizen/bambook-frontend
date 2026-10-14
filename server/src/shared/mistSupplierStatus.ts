/** 供应商合作状态的生效判断：暂停 / 停用自生效日（上海业务日）起阻止新增业务，生效前仍可正常使用。 */
export type SupplierStatusFields = { status: 'active' | 'paused' | 'blocked'; statusFrom?: string; blockReason?: string };
export function supplierBusinessDay(instant: string | Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
export function supplierStatusOn(s: SupplierStatusFields, day: string): SupplierStatusFields['status'] {
  return s.status !== 'active' && (s.statusFrom || '') <= day ? s.status : 'active';
}
/** 生效中的暂停 / 停用原因；可以继续使用时返回空字符串。 */
export function supplierUnavailableReason(s: SupplierStatusFields, day: string): string {
  const now = supplierStatusOn(s, day);
  return now === 'active' ? '' : `供应商${now === 'paused' ? '已暂停合作' : '已停用'}${s.blockReason ? '：' + s.blockReason : ''}`;
}
