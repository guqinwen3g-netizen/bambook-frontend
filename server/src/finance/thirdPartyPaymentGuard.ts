/**
 * thirdPartyPaymentGuard.ts — 「第三方代付」判定（**纯函数，零依赖**）
 *
 * ── 为什么单独成文件 ──
 * 与 `allocationCustomerGuard.ts` 同一理由：这个判定要同时被三处消费 ——
 *   ① 服务端写入内核（finance/allocationService.ts 的 `applyAllocation`）
 *   ② 服务端门禁测试（finance/__tests__/thirdPartyPaymentGuard.test.ts）
 *   ③ 前端同口径展示（components/finance/ReceiptClaimsPanel.tsx、
 *      components/FinanceManager.tsx 手动核销面）+ **跨层对撞测试**
 * ③ 要 import 服务端真源做行为比对；若真源住在 allocationService 里，
 * 会把 @prisma/client / creditService 等重依赖拖进前端类型检查
 * （root tsconfig exclude 了 server，import 却能穿透 exclude）→ 前端门禁被
 * 服务端错误污染。所以判定逻辑落在本文件，**不 import 任何东西**，谁都能安全引。
 *
 * ── 业务口径（L2 高危 3 号；Kevin 2026-09-17 拍板：**允许 + 留痕**）──
 * 「第三方代付」= 实际打款人 ≠ 合同客户。真实业务里很常见，且**不能拦**：
 *   母公司替子公司付款、客户指定的货代/关联方代付、境外客户由香港公司付汇……
 *   硬拦会把业务卡死（此前 `receiptClaimService` 就是硬拒 `CUSTOMER_MISMATCH`，
 *   业务员认领时一旦跨客户直接失败，只能回头找财务手工绕）。
 * 但 **不拦 ≠ 不留痕**：A 公司替 B 公司付款，如果账上完全看不见，
 *   对账时「这笔钱到底是谁付的、为什么挂到 B 头上」无从追查 —— 这是静默错账。
 * 所以口径是：**放行 + 明确标注 + 落审计**，不是阻断。
 *
 * ── 数据来源（DR-016 四方交易方；无需改 schema）──
 *   · `PaymentVoucher.customerRelationId` 语义 = **实际打款人**（counterparty / billTo）
 *   · `Invoice.customerRelationId`        语义 = **合同客户**（这张票开给谁）
 *   两者都是既有字段。此前 `payerRelationId` 只在 Shipment 上、且写入时一律
 *   等于客户自己，**全仓零业务逻辑** —— 留痕面缺的就是「拿它做判定」这一步。
 *
 * ── 判定分支（顺序即优先级）──
 *   ① 双方都有客户档案 → 只比 relationId（强判据）
 *   ② 一侧缺档案       → 退化为比客户名称（弱判据，兼容旧数据）
 *   ③ 名称也缺         → **判不了 → 不判定**（宁可漏，不可误报）
 *
 * ── 不参与判定的情形（返回 null）──
 *   · 应收以外的票（`invoice.type` 存在且 ≠ `Receivable`）：Payable 的
 *     customerRelationId 存的是**供应商**，口径不同
 *   · 收款以外的凭证（`voucher.type` 存在且 ≠ `Receipt`）：Disbursement 的
 *     customerRelationId 存的是**收款方**，同样不是「谁付的钱」
 *
 * ── ⚠️ 一条刻意选择的宽松：`type` 字段**缺省时仍然判定** ──
 *   直觉写法是「type 缺省 → 判不了 → 不判定」，但那会造出**空过的验证器**：
 *   前端 `ClaimableReceipt`（services/receiptClaimService.ts 的返回类型）
 *   根本没有 `type` 字段（服务端已按 `type: 'Receipt'` 过滤过），
 *   若按「缺省即不判」处理，前端徽标**永远不会亮**，而测试还全绿。
 *   所以规则取「**给了 type 且不符才排除；没给就照判**」。
 *   代价是调用方若传了 Payable 票又不带 type 会误报 —— 本仓全部调用方
 *   （applyAllocation / 前端两个面）都会带或已过滤，风险可控。
 */

/** 判据来源：relationId（有客户档案，强）| name（旧数据兜底，弱） */
export type ThirdPartyPaymentBasis = 'relationId' | 'name';

/** 参与判定的凭证侧字段（实际付款方） */
export interface PayerVoucherRef {
  type?: string | null;
  /** 实际打款人（DR-016 counterparty 语义） */
  customerRelationId?: string | null;
  customerName?: string | null;
}

/** 参与判定的发票侧字段（合同客户） */
export interface InvoiceCustomerRef {
  type?: string | null;
  /** 合同客户（票开给谁） */
  customerRelationId?: string | null;
  customerName?: string | null;
}

export interface ThirdPartyPaymentDetection {
  /** 恒为 true —— 返回本对象即代表判定为第三方代付 */
  isThirdParty: true;
  /** 判据来源（审计留痕要记，弱判据需人工复核） */
  basis: ThirdPartyPaymentBasis;
  /** 实际付款方档案 id（可能为空 = 旧数据无档案） */
  payerRelationId: string | null;
  /** 实际付款方名称 */
  payerName: string | null;
  /** 发票（合同）客户档案 id */
  invoiceCustomerRelationId: string | null;
  /** 发票（合同）客户名称 */
  invoiceCustomerName: string | null;
  /** 面向人的一句话（可直接进审计 detail / 界面提示） */
  message: string;
}

const nonEmpty = (v?: string | null): string => (v || '').trim();

/**
 * 客户名归一化：去首尾空白 + 折叠内部连续空白 + 大写。
 * 只做「明显同一家」的等价折叠（`ABC  Co.,Ltd` ↔ `ABC CO.,LTD`），
 * **不**剥公司后缀 —— 那会把 `ABC Ltd` 与 `ABC Co.,Ltd` 判成同一家（漏报）。
 */
export function normalizePartyName(v?: string | null): string {
  return nonEmpty(v).replace(/\s+/g, ' ').toUpperCase();
}

/**
 * 判定该笔核销是否属于「第三方代付」。**非**第三方代付 / 判不了 → 返回 null。
 *
 * 纯函数：无 IO、无环境依赖、无 Date/随机数，可直接做跨层对撞。
 */
export function detectThirdPartyPayment(
  voucher: PayerVoucherRef | null | undefined,
  invoice: InvoiceCustomerRef | null | undefined,
): ThirdPartyPaymentDetection | null {
  if (!voucher || !invoice) return null;

  // 口径隔离：非应收票 / 非收款凭证不参与判定（type 缺省则照判，见文件头说明）
  if (invoice.type && invoice.type !== 'Receivable') return null;
  if (voucher.type && voucher.type !== 'Receipt') return null;

  const payerRelationId = nonEmpty(voucher.customerRelationId);
  const invoiceCustomerRelationId = nonEmpty(invoice.customerRelationId);
  const payerName = nonEmpty(voucher.customerName);
  const invoiceCustomerName = nonEmpty(invoice.customerName);

  // ① 双方都有客户档案 → 只比 relationId（强判据）
  if (payerRelationId && invoiceCustomerRelationId) {
    if (payerRelationId === invoiceCustomerRelationId) return null;
    const payerLabel = payerName || payerRelationId;
    const invoiceLabel = invoiceCustomerName || invoiceCustomerRelationId;
    return {
      isThirdParty: true,
      basis: 'relationId',
      payerRelationId,
      payerName: payerName || null,
      invoiceCustomerRelationId,
      invoiceCustomerName: invoiceCustomerName || null,
      message: `第三方代付：实际付款方「${payerLabel}」与发票客户「${invoiceLabel}」不是同一家。已按业务口径放行并留痕（请复核代付关系是否成立）。`,
    };
  }

  // ② 一侧缺档案 → 退化为比名称（弱判据）
  if (!payerName || !invoiceCustomerName) return null; // ③ 名称也缺 → 判不了，不误报
  if (normalizePartyName(payerName) === normalizePartyName(invoiceCustomerName)) return null;

  return {
    isThirdParty: true,
    basis: 'name',
    payerRelationId: payerRelationId || null,
    payerName,
    invoiceCustomerRelationId: invoiceCustomerRelationId || null,
    invoiceCustomerName,
    message: `第三方代付（按名称判定）：实际付款方「${payerName}」与发票客户「${invoiceCustomerName}」名称不一致。已放行并留痕；建议补全客户档案后复核。`,
  };
}

/** 审计留痕用：把判定结果摊平成可 JSON 序列化的扁平字段（避免调用方各写一份） */
export function toThirdPartyPaymentAuditFields(d: ThirdPartyPaymentDetection): Record<string, unknown> {
  return {
    thirdPartyPayment: true,
    thirdPartyPaymentBasis: d.basis,
    payerRelationId: d.payerRelationId,
    payerName: d.payerName,
    invoiceCustomerRelationId: d.invoiceCustomerRelationId,
    invoiceCustomerName: d.invoiceCustomerName,
    thirdPartyPaymentNote: d.message,
  };
}
