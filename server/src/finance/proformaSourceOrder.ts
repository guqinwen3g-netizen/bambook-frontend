/** Quotation source orders describe provenance; its converted order is the
 * financial destination. Producer and workflow verification use this contract. */
export function proformaSourceOrderId(quotation: {
  convertedOrderId?: string | null; orderId?: string | null;
}, orderLineParentId?: string | null): string | null {
  return quotation.convertedOrderId ?? quotation.orderId ?? orderLineParentId ?? null;
}
