import { describe, it, expect } from 'vitest';
import { parseNotificationLink } from './crossModuleNav';
import { View } from '../types';
describe('Existing production notification URL source contract', () => {
 it('keeps original Order production tab and exact ID', () => expect(parseNotificationLink('/orders?id=ORDER-NATIVE&tab=production')).toEqual({view:View.Orders,id:'ORDER-NATIVE',tab:'production',params:{}}));
 it('maps the actual legacy production rejection URL to the same Order production target while preserving source query parameters', () => expect(parseNotificationLink('/production?orderId=ORDER-NATIVE&reportId=REPORT-NATIVE')).toEqual({view:View.Orders,id:'ORDER-NATIVE',tab:'production',params:{orderId:'ORDER-NATIVE',reportId:'REPORT-NATIVE'}}));
 it('rejects a conflicting id rather than choosing another Order', () => expect(parseNotificationLink('/production?orderId=ORDER-NATIVE&id=OTHER-ORDER')).toBeNull());
 it('rejects a legacy production link without its actual orderId', () => expect(parseNotificationLink('/production?id=ORDER-NATIVE')).toBeNull());
 it('rejects another subview for the finite production-only legacy alias', () => expect(parseNotificationLink('/production?orderId=ORDER-NATIVE&tab=finance')).toBeNull());
});
