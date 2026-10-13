// @vitest-environment jsdom
// Local navigation shape controls. Dashboard parser remains its original twelve-target contract.
import { describe, it, expect } from 'vitest';
import { isBusinessNavigationTarget, workbenchTargetView } from './workbenchNavigation';
import { isWorkbenchTarget } from './dashboardTaskService';
import { parseNotificationLink } from './crossModuleNav';
import { View } from '../types';
describe('strict local PaymentVoucher notification target', () => {
    it('accepts only the native voucher local navigation shape and leaves Dashboard twelve kinds unchanged', () => { const target = { kind: 'payment-voucher', voucherId: 'PV-real', tab: 'vouchers' } as const; expect(isBusinessNavigationTarget(target)).toBe(true); expect(isWorkbenchTarget(target)).toBe(false); expect(workbenchTargetView(target)).toBe(View.PaymentVouchers); expect(parseNotificationLink('/finance?tab=vouchers&id=PV-real')).toEqual({ view: View.PaymentVouchers, tab: 'vouchers', id: 'PV-real', params: {} }); });
    it.each([{ kind: 'payment-voucher', tab: 'vouchers' }, { kind: 'payment-voucher', voucherId: '', tab: 'vouchers' }, { kind: 'payment-voucher', voucherId: '   ', tab: 'vouchers' }, { kind: 'payment-voucher', voucherId: ' PV-real', tab: 'vouchers' }, { kind: 'payment-voucher', voucherId: 'PV-real', tab: 'invoices' }, { kind: 'payment-voucher', voucherId: 'PV-real', tab: 'vouchers', invoiceId: 'spoof' }, { kind: 'payment-voucher', voucherId: 1, tab: 'vouchers' }])('rejects invalid or ambiguous local target %#', target => expect(isBusinessNavigationTarget(target)).toBe(false));
});
