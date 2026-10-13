/**
 * ERP-P1: OrderLine 可写字段共用 helper（route + Agent flow 共用，避免反向依赖 route 模块）。
 */

export const ORDER_LINE_WRITABLE_FIELDS = new Set([
  'lineNumber',
  'itemNo',
  'materialCode',
  'millQuality',
  'description',
  'width',
  'exMillDate',
  'agreedDeliveryDate',
  'deliveryAgreementBasis',
  'deliveryDate',
  'quantity',
  'unit',
  'unitPrice',
  'netValue',
  'via',
  'cloth',
  'weight',
  'category',
  'notes',
  'status',
  'productionBatch',
  'shippingDate',
  'shippingMethod',
  'invoiceNumber',
  'invoiceDate',
  'shipmentQuantity',
  'shipmentAmount',
  'tolerancePercent', // REQ2-03 溢短装条款 ±N%
  'toleranceSource', // Only an explicit manual override or unknown; derived sources are not client writable.
  'partialShipmentAllowed', // Explicit customer agreement; omission/null remains unknown.
  'actualPaymentDate',
  'actualPaymentAmount',
  'specialInstructions',
  // Garment extension fields
  'sizeBreakdown',
  'productionSteps',
  'styleNo',
  'colorName',
  'bomItems',
  'garmentSampleStages',
  'requiredSampleFamilies',
  'fulfillmentMode',
  'cmtIncludedItems',
  'fabricSupplyMode',
  'fabricCommissionRate',
  'fabricCommissionSupplierId',
  'manualSpecification', // Server producer creates the exact draft source; never stored as a scalar.
]);

export function stripLineWritable(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ORDER_LINE_WRITABLE_FIELDS.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}
