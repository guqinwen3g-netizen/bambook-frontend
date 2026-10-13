/**
 * Phase 1 Sprint 3 + Phase 2 跨模块联动 — 联动执行器注册入口
 *
 * 在 server 启动时调用 registerAllLinkages()，
 * 把核心业务联动挂到 businessEventBus。
 *
 * 调用时序：
 *   1. initializeNotificationBindings(prisma)  — 注入 prisma + 通知订阅
 *   2. registerAllLinkages()                    — 注册联动执行器
 *
 * 联动清单：
 *   L1: OrderConfirmed        → initProductionStages   （初始化生产管线）
 *   L2: ProductionCompleted    → createShipmentDraft   （创建发货单草稿）
 *   L3: ShipmentCompleted     → no financial write      （CI 由单证签发，财务再登记）
 *   L5: PaymentVoucherCreated → autoAllocate          （自动核销到关联发票）
 *   L6: OrderConfirmed        → createBOMDraft         （从模板复制 BOM 草稿）
 *   L7: BOMConfirmed          → createProcurement     （生成采购需求草稿）
 *   L8: MaterialReceived      → autoStockIn           （采购来料自动入库）
 *   L9: QuotationAccepted     → convertToOrderDraft   （报价接受自动转订单草稿）
 *   L10: CustomsCleared       → createTaxRefundDraft  （报关放行自动核算退税草稿）
 *   L11: ProductionCompleted  → finishedGoodsStockIn  （生产完成成品按订单行自动入库）
 *
 * L4 (InvoiceIssued → payment todo) 由通知系统覆盖，无需独立联动。
 *
 * 不变量：
 *   - 联动执行失败不阻断业务（businessEventBus 保证 fire-and-forget）
 *   - 失败时 idempotencyKey 从 processedKeys 移除，允许后续重试
 *   - 联动不得替代业务/财务依据；L3 不因出运事件生成应收
 */

import { logger } from '../../lib/logger';
import { registerL1InitProduction } from './L1InitProduction';
import { registerL2CreateShipment } from './L2CreateShipment';
import { registerL3IssueInvoice } from './L3IssueInvoice';
import { registerL5AutoAllocate } from './L5AutoAllocate';
import { registerL6CreateBOMDraft } from './L6CreateBOMDraft';
import { registerL7CreateProcurement } from './L7CreateProcurement';
import { registerL8AutoStockIn } from './L8AutoStockIn';
import { registerL9ConvertQuotationToOrder } from './L9ConvertQuotationToOrder';
import { registerL10CreateTaxRefundDraft } from './L10CreateTaxRefundDraft';
import { registerL11FinishedGoodsStockIn } from './L11FinishedGoodsStockIn';

export function registerAllLinkages(): void {
  // registerLinkage 内部通过 linkageHandlers.has(key) 去重，
  // 重复调用安全（reset 后可重新注册，用于测试）
  registerL1InitProduction();
  registerL2CreateShipment();
  registerL3IssueInvoice();
  registerL5AutoAllocate();
  registerL6CreateBOMDraft();
  registerL7CreateProcurement();
  registerL8AutoStockIn();
  registerL9ConvertQuotationToOrder();
  registerL10CreateTaxRefundDraft();
  registerL11FinishedGoodsStockIn();

  logger.info('[Linkages] linkage handlers registration attempted', {
    linkages: [
      'L1_init_production', 'L2_create_shipment', 'L3_issue_invoice', 'L5_auto_allocate',
      'L6_create_bom_draft', 'L7_create_procurement', 'L8_auto_stock_in', 'L9_convert_quotation_to_order',
      'L10_create_tax_refund_draft', 'L11_finished_goods_stock_in',
    ],
  });
}
