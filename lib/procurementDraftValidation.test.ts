import { describe, expect, it } from 'vitest';
import { validatePurchaseDraftLines as validate } from './procurementDraftValidation';
const line = { description: '面料', quantity: '100', unit: 'M', unitPrice: '12' };
describe('采购草稿明细完整性', () => {
  it('不把未填完整的第二行静默丢掉', () => {
    expect(validate([line, { ...line, description: '' }])).toContain('第 2 行');
    expect(validate([line, { ...line, unitPrice: '' }])).toContain('第 2 行');
  });
  it('允许明确填写的零价，不把空白当零价', () => {
    expect(validate([{ ...line, unitPrice: '0' }])).toBeNull();
    expect(validate([{ ...line, unitPrice: ' ' }])).not.toBeNull();
  });
  it.each(['0', '-1', 'NaN', 'Infinity', ''])('阻止无效采购数量 %s', quantity => {
    expect(validate([{ ...line, quantity }])).not.toBeNull();
  });
  it('阻止负单价和缺少单位', () => {
    expect(validate([{ ...line, unitPrice: '-1' }])).not.toBeNull();
    expect(validate([{ ...line, unit: '' }])).not.toBeNull();
  });
});
