/**
 * allocationCustomerGuard.ts — 发票 ↔ 订单「同客户」判定（**纯函数，零依赖**）
 *
 * 为什么单独成文件：这个判定同时被三处消费 ——
 *   ① 服务端写入路径（finance/invoiceMutationService.ts，create/update 都调）
 *   ② 服务端门禁测试（finance/__tests__/invoiceConsolidationCustomerGate.test.ts）
 *   ③ 前端同口径预筛（components/FinanceManager.tsx）+ **跨层对撞测试**
 * ③ 要 import 服务端真源做行为比对，若真源住在 invoiceMutationService 里，
 * 会把 @prisma/client / creditService 等重依赖拖进前端类型检查（root tsconfig
 * exclude 了 server，import 却能穿透 exclude）→ 前端门禁被服务端错误污染。
 * 所以判定逻辑落在本文件，**不 import 任何东西**，谁都能安全引。
 *
 * ── 业务口径（L2 高危 2 号，docs/v1全面验收方案-2026-09-17.md）──
 * 应收 / 账龄 / 催办 / 信用额度（usedAmount）**全部按客户记账**。
 * 一张发票挂上两个客户的订单 → 两边都算到票头客户头上，另一个客户凭空少债，
 * 而且**全程不报错**（静默错账，只有对账才发现）。
 * 出运合票早有同口径硬校验（shipping/allocationService.assertConsolidationAllowed：
 * 仅同客户允许合票），开票侧此前完全没校 —— 这是不对称的那一半。
 *
 * ── 判定分支（顺序即优先级，与前端 UI 一致）──
 *   ① 所选订单分属多个客户            → INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH
 *   ② 票头客户 ≠ 订单签约客户（应收） → INVOICE_CUSTOMER_MISMATCH
 *
 * ── 客户判据（relationId 优先、客户名兜底，兼容旧数据）──
 *   · 只要所选订单里有**任一**带 customerRelationId → 只比 relationId
 *     （避免「一单有档案一单只有名称」被误判成两个客户）
 *   · 一个都没有（旧数据）→ 退化为比 customer 名称
 *   · 数据不全时（票头无档案等）**不误报**，交给调用侧的存在性校验与业务判断
 *   · ② 仅对 Receivable 校（Payable 的 customerRelationId 存的是**供应商**，口径不同）
 */

/** 违规码（与 finance/invoiceMutationService.ts 的 InvoiceMutationErrorCode 同名字面量） */
export type AllocationCustomerViolationCode =
  | 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH'
  | 'INVOICE_CUSTOMER_MISMATCH';

/** 参与判定的订单字段（只取判据所需） */
export interface OrderCustomerRow {
  id: string;
  code?: string | null;
  customerRelationId?: string | null;
  customer?: string | null;
}

/** 参与判定的票头字段 */
export interface InvoiceCustomerRef {
  type?: string | null;
  customerRelationId?: string | null;
  customerName?: string | null;
}

export interface AllocationCustomerViolation {
  code: AllocationCustomerViolationCode;
  message: string;
}

/**
 * 判定发票↔订单是否「同客户」。无违规返回 null。
 * 纯函数：无 IO、无环境依赖，可直接做跨层对撞。
 */
export function findAllocationCustomerViolation(
  orders: OrderCustomerRow[],
  invoice: InvoiceCustomerRef,
): AllocationCustomerViolation | null {
  if (!orders || orders.length === 0) return null;

  const relationIds = [...new Set(orders.map((o) => o.customerRelationId).filter((v): v is string => !!v))];
  const names = [...new Set(orders.map((o) => o.customer).filter((v): v is string => !!v))];
  const customers = relationIds.length > 0 ? relationIds : names;

  if (customers.length > 1) {
    const detail = orders
      .map((o) => `${o.code ?? o.id}（${o.customer ?? o.customerRelationId ?? '未知客户'}）`)
      .join('、');
    return {
      code: 'INVOICE_CONSOLIDATION_CUSTOMER_MISMATCH',
      message: `合并开票校验失败：所选订单分属不同客户 —— ${detail}。应收/账龄/授信按客户记账，一张发票只能开给同一个客户（请拆成多张票，或取消勾选其他客户的订单）`,
    };
  }

  // 票头客户 vs 订单客户：票开给了 A，却挂上 B 的订单 → 同样是挂错人。
  // 仅 Receivable 校（Payable 的 customerRelationId 存的是**供应商**，口径不同）。
  if (
    invoice?.type === 'Receivable'
    && invoice.customerRelationId
    && relationIds.length === 1
    && relationIds[0] !== invoice.customerRelationId
  ) {
    const o = orders[0];
    return {
      code: 'INVOICE_CUSTOMER_MISMATCH',
      message: `发票客户与订单客户不一致：发票开给 ${invoice.customerName ?? invoice.customerRelationId}，但订单 ${o?.code ?? o?.id} 的签约客户是 ${o?.customer ?? relationIds[0]}。请改正客户，或改选该客户的订单`,
    };
  }

  return null;
}
