import { describe, expect, it } from 'vitest';
import type { Order } from '../types';
import { displayItemNo, getNextItemNo, flattenOrderLines, manualInitialLineNetValue, linkOrderAgreementAmounts, manualOrderDueDate } from './orderLineItems';
import { orderAmountOf } from '../server/src/shared/orderAmount';

describe('manual initial line sales agreement', () => {
  it('persists the entered 5000 agreement even when the untouched legacy quote field is zero', () => {
    const draft = { quantity: 1000, salesPrice: 5, contractAmount: 5000, quoteAmount: 0 };
    const netValue = manualInitialLineNetValue(draft);
    expect(netValue).toBe(5000);
    expect(orderAmountOf({ quoteAmount: 0, lines: [{ netValue }] })).toBe(5000);
  });
  it('keeps an explicitly entered zero distinct from an absent or cleared amount', () => {
    expect(manualInitialLineNetValue({ contractAmount: 0, quoteAmount: 123 })).toBe(0);
    expect(manualInitialLineNetValue({ quoteAmount: 123 })).toBeUndefined();
    expect(manualInitialLineNetValue({ contractAmount: null } as any)).toBeUndefined();
    expect(manualInitialLineNetValue({ contractAmount: '' } as any)).toBeUndefined();
  });
  it('does not reintroduce a header-contract fallback when reading a saved legacy order', () => {
    expect(orderAmountOf({ contractAmount: 5000, quoteAmount: 123 })).toBe(123);
    expect(orderAmountOf({ contractAmount: 5000, quoteAmount: 123, lines: [{ netValue: 456 }] })).toBe(456);
  });
  it.each([-1, NaN, Infinity])('rejects invalid amount %s before the parent order can be created', amount => {
    expect(() => manualInitialLineNetValue({ contractAmount: amount })).toThrow('销售合同金额须为非负有限数值');
  });
});

describe('visible manual delivery agreement', () => {
  it('the entered ex-mill date governs the parent and is not replaced by creation day', () => {
    expect(manualOrderDueDate({ clientDate: '2026-11-15', productionDate: '2026-11-10', dueDate: '2026-10-01' })).toBe('2026-11-15');
  });
  it('a recorded production deadline remains usable before an ex-mill date is agreed', () => {
    expect(manualOrderDueDate({ productionDate: '2026-11-10' })).toBe('2026-11-10');
  });
  it('no recorded deadline stays absent and clearing both dates cannot imply today', () => {
    expect(manualOrderDueDate({ dueDate: '2026-10-01' })).toBe('');
    expect(manualOrderDueDate({ clientDate: '', productionDate: '' })).toBe('');
  });
});

describe('entered order agreement values', () => {
  it('quantity entry alone keeps an unpriced agreement unknown', () => {
    const draft = linkOrderAgreementAmounts({}, { quantity: 1000 });
    expect(draft.salesPrice).toBeUndefined(); expect(draft.contractAmount).toBeUndefined();
    expect(manualInitialLineNetValue(draft)).toBeUndefined();
  });
  it('entered price and amount drive each other while explicit zero remains entered', () => {
    expect(linkOrderAgreementAmounts({ quantity: 1000 }, { salesPrice: 5 })).toMatchObject({ salesPrice: 5, contractAmount: 5000 });
    expect(linkOrderAgreementAmounts({ quantity: 1000 }, { contractAmount: 5000 })).toMatchObject({ salesPrice: 5, contractAmount: 5000 });
    expect(linkOrderAgreementAmounts({ quantity: 1000 }, { salesPrice: 0 })).toMatchObject({ salesPrice: 0, contractAmount: 0 });
    expect(linkOrderAgreementAmounts({ quantity: 1000 }, { contractAmount: 0 })).toMatchObject({ salesPrice: 0, contractAmount: 0 });
  });
  it('clearing the entered price or amount does not invent a zero agreement', () => {
    const original = { quantity: 1000, salesPrice: 5, contractAmount: 5000 };
    expect(linkOrderAgreementAmounts(original, { salesPrice: undefined }).contractAmount).toBeUndefined();
    expect(linkOrderAgreementAmounts(original, { contractAmount: undefined }).salesPrice).toBeUndefined();
    expect(linkOrderAgreementAmounts(original, { salesPrice: '' } as any).contractAmount).toBeUndefined();
    expect(linkOrderAgreementAmounts(original, { contractAmount: '' } as any).salesPrice).toBeUndefined();
  });
  it('a quantity change uses the entered price and cannot infer unknown or invalid price', () => {
    expect(linkOrderAgreementAmounts({ salesPrice: 5 }, { quantity: 2000 }).contractAmount).toBe(10000);
    for (const salesPrice of [undefined, null, NaN, Infinity, -1]) {
      expect(linkOrderAgreementAmounts({ salesPrice } as any, { quantity: 2000 }).contractAmount).toBeUndefined();
    }
  });
});

describe('order line item numbering', () => {
  it('displays imported five-digit SAP item numbers as four-digit business numbers', () => {
    expect(displayItemNo('00010')).toBe('0010');
    expect(displayItemNo('00020')).toBe('0020');
    expect(displayItemNo('0011')).toBe('0011');
    expect(displayItemNo('ABC')).toBe('ABC');
  });

  it('generates ten-step default item numbers and ignores revision variants', () => {
    expect(getNextItemNo([])).toBe('0010');
    expect(getNextItemNo(['0010'])).toBe('0020');
    expect(getNextItemNo(['0010', '0011'])).toBe('0020');
    expect(getNextItemNo(['00010', '00020'])).toBe('0030');
  });

  it('skips blank item numbers when generating the next number', () => {
    expect(getNextItemNo([null])).toBe('0010');
    expect(getNextItemNo([null, null])).toBe('0010');
    expect(getNextItemNo(['', undefined, '0010'])).toBe('0020');
  });

  it('skips nonnumeric item numbers when generating the next number', () => {
    expect(getNextItemNo(['ABC'])).toBe('0010');
    expect(getNextItemNo(['ABC', '0010'])).toBe('0020');
  });
});

describe('flattenOrderLines', () => {
  it('creates one line-first item per order line', () => {
    const order: Order = {
      id: 'PO-4500159423',
      customer: 'Peerless',
      product: 'Imported PO',
      type: 'Fabric',
      quantity: 300,
      status: 'Pending',
      dueDate: '2026/07/01',
      quoteAmount: 900,
      poNumber: '4500159423',
      poDate: '2026/03/31',
      salesCurrency: 'USD',
      lines: [
        {
          id: 'L1',
          lineNumber: 1,
          itemNo: '00010',
          materialCode: '144749',
          millQuality: 'RD7302',
          description: 'CHARCOAL SOLID',
          width: '147 CM',
          exMillDate: '2026/07/01',
          deliveryDate: '2026/08/15',
          quantity: 300,
          unit: 'Meter',
          unitPrice: 3,
          netValue: 900,
          cloth: '70% Wool',
          weight: '186GSM',
          status: 'Production',
        },
      ],
    };

    expect(flattenOrderLines([order])).toEqual([
      expect.objectContaining({
        id: 'L1',
        orderId: 'PO-4500159423',
        poNumber: '4500159423',
        displayItemNo: '0010',
        displayId: 'PO 4500159423 / 0010',
        status: 'Production',
        customer: 'Peerless',
        amount: 900,
      }),
    ]);
  });
});

describe('Decimal DTO display values',()=>{
  it('derives the item amount from Decimal-string quantity and price while retaining the stored price',()=>{
    const order={id:'O-DECIMAL',status:'Pending',lines:[{id:'L1',lineNumber:1,quantity:'2600.0000',unitPrice:'12.0000',netValue:null}]} as unknown as Order;
    expect(flattenOrderLines([order])[0]).toMatchObject({quantity:2600,amount:31200,unitPrice:'12.0000'});
  });
  it('keeps an explicitly recorded zero amount instead of replacing it with a calculated charge',()=>{
    const order={id:'O-ZERO',status:'Pending',lines:[{id:'L1',lineNumber:1,quantity:'2.0000',unitPrice:'12.0000',netValue:'0.0000'}]} as unknown as Order;
    expect(flattenOrderLines([order])[0].amount).toBe(0);
  });
});
