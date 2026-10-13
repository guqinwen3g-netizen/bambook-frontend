/**
 * thirdPartyPaymentGuard 纯函数真源 — 单元测试。
 *
 * L2 高危 3 号（第三方代付；Kevin 2026-09-17 口径：**允许 + 留痕**）。
 *
 * 这个文件只测**判定本身**（无 IO、无 mock）；留痕落库的接线断言在
 * thirdPartyPaymentLedger.test.ts。
 *
 * ⚠️ 本套的重点不是「能不能判出来」，而是**别误报**：
 *   代付被放行后，误报的代价是财务被无意义地打扰 + 审计噪声；
 *   漏报的代价是静默错账。所以两侧都有断言（正例 + 反例成对写）。
 */
import { describe, expect, it } from 'vitest';
import {
  detectThirdPartyPayment,
  normalizePartyName,
  toThirdPartyPaymentAuditFields,
} from '../thirdPartyPaymentGuard';

const voucher = (o: Record<string, unknown> = {}) => ({
  type: 'Receipt', customerRelationId: 'REL_PAYER', customerName: 'PARENT CO', ...o,
});
const invoice = (o: Record<string, unknown> = {}) => ({
  type: 'Receivable', customerRelationId: 'REL_CUST', customerName: 'ACME', ...o,
});

describe('detectThirdPartyPayment：判定', () => {
  it('★ 双方都有档案且不同 → 判定为第三方代付（basis=relationId）', () => {
    const d = detectThirdPartyPayment(voucher(), invoice());
    expect(d).not.toBeNull();
    expect(d!.isThirdParty).toBe(true);
    expect(d!.basis).toBe('relationId');
    expect(d!.payerRelationId).toBe('REL_PAYER');
    expect(d!.invoiceCustomerRelationId).toBe('REL_CUST');
    expect(d!.message).toContain('PARENT CO');
    expect(d!.message).toContain('ACME');
  });

  it('★ 双方都有档案且相同 → 不是代付（null）', () => {
    expect(detectThirdPartyPayment(voucher({ customerRelationId: 'REL_1' }), invoice({ customerRelationId: 'REL_1' }))).toBeNull();
  });

  it('一侧缺档案 + 名称不同 → 退化为按名称判定（basis=name）', () => {
    const d = detectThirdPartyPayment(
      voucher({ customerRelationId: null, customerName: 'PARENT CO' }),
      invoice({ customerRelationId: 'REL_CUST', customerName: 'ACME' }),
    );
    expect(d?.basis).toBe('name');
    expect(d!.payerRelationId).toBeNull();
    expect(d!.invoiceCustomerRelationId).toBe('REL_CUST');
  });

  it('一侧缺档案 + 名称仅大小写/空白差异 → 不是代付（归一化后相同）', () => {
    expect(detectThirdPartyPayment(
      voucher({ customerRelationId: null, customerName: '  acme   co.,ltd ' }),
      invoice({ customerRelationId: null, customerName: 'ACME CO.,LTD' }),
    )).toBeNull();
  });

  it('★ 名称也缺 → 判不了就不判（宁可漏，不可误报）', () => {
    expect(detectThirdPartyPayment(
      voucher({ customerRelationId: null, customerName: null }),
      invoice({ customerRelationId: null, customerName: null }),
    )).toBeNull();
    // 只有一侧有名称 → 同样判不了
    expect(detectThirdPartyPayment(
      voucher({ customerRelationId: null, customerName: 'PARENT CO' }),
      invoice({ customerRelationId: null, customerName: null }),
    )).toBeNull();
  });

  it('★ relationId 优先：双方都有档案时不因名称不同而多判（名称只是显示）', () => {
    // 同一家，只是票头名称写法不同 → 按 relationId 判为同一家
    expect(detectThirdPartyPayment(
      voucher({ customerRelationId: 'REL_1', customerName: 'ACME CO.,LTD' }),
      invoice({ customerRelationId: 'REL_1', customerName: 'ACME' }),
    )).toBeNull();
  });
});

describe('detectThirdPartyPayment：口径隔离（不参与判定的情形）', () => {
  it('Payable 票不判定（其 customerRelationId 存的是供应商，口径不同）', () => {
    expect(detectThirdPartyPayment(voucher(), invoice({ type: 'Payable' }))).toBeNull();
  });

  it('Disbursement 凭证不判定（其 customerRelationId 存的是收款方，不是「谁付的钱」）', () => {
    expect(detectThirdPartyPayment(voucher({ type: 'Disbursement' }), invoice())).toBeNull();
  });

  it('入参为 null / undefined → 不判定（不抛错）', () => {
    expect(detectThirdPartyPayment(null, invoice())).toBeNull();
    expect(detectThirdPartyPayment(voucher(), null)).toBeNull();
    expect(detectThirdPartyPayment(undefined, undefined)).toBeNull();
  });

  it('★ type 缺省时**仍然判定**（防「空过的验证器」：前端 ClaimableReceipt 没有 type 字段）', () => {
    // 服务端 listClaimableReceipts 已按 type:'Receipt' 过滤，返回体不含 type。
    // 若「缺省即不判」，前端徽标永远不亮而测试全绿 —— 这正是要防的空过。
    const d = detectThirdPartyPayment(
      { customerRelationId: 'REL_PAYER', customerName: 'PARENT CO' },
      { customerRelationId: 'REL_CUST', customerName: 'ACME' },
    );
    expect(d).not.toBeNull();
    expect(d!.basis).toBe('relationId');
  });
});

describe('normalizePartyName / toThirdPartyPaymentAuditFields', () => {
  it('归一化：去首尾空白 + 折叠内部连续空白 + 大写', () => {
    expect(normalizePartyName('  acme   co.,ltd ')).toBe('ACME CO.,LTD');
    expect(normalizePartyName(null)).toBe('');
    expect(normalizePartyName(undefined)).toBe('');
  });

  it('归一化**不**剥公司后缀（剥了会把 ABC Ltd 与 ABC Co.,Ltd 误判成同一家 → 漏报）', () => {
    expect(normalizePartyName('ABC Ltd')).not.toBe(normalizePartyName('ABC Co.,Ltd'));
  });

  it('审计字段扁平化：可直接进 AuditLog.detail.after', () => {
    const d = detectThirdPartyPayment(voucher(), invoice())!;
    const f = toThirdPartyPaymentAuditFields(d);
    expect(f.thirdPartyPayment).toBe(true);
    expect(f.thirdPartyPaymentBasis).toBe('relationId');
    expect(f.payerRelationId).toBe('REL_PAYER');
    expect(f.invoiceCustomerRelationId).toBe('REL_CUST');
    expect(String(f.thirdPartyPaymentNote)).toContain('第三方代付');
    // JSON 可序列化（AuditLog.detail 是 Json 字段）
    expect(() => JSON.stringify(f)).not.toThrow();
  });
});
