/** In-process native transport for the private full-flow rehearsal. The actual
 * dev population uses its running HTTP server, never this app or a mocked actor. */
import express from 'express';
import type { PrismaClient } from '@prisma/client';
import { createAccountStatusGuard } from '../../src/auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from '../../src/auth/authorizationSnapshotGuard';
import { createAuthRouter } from '../../src/auth/route';
import { createOrdersRouter } from '../../src/orders/route';
import { createOrderBusinessWorkspaceRouter } from '../../src/orders/orderBusinessWorkspaceRoute';
import { createFabricCommissionBusinessRouter } from '../../src/finance/fabricCommissionRoute';
import { createOrdersV2Router } from '../../src/orders/routeV2';
import { createOrderLinesRouter } from '../../src/orders/orderLinesRoute';
import { createInternalFabricAllocationRouter } from '../../src/orders/internalFabricAllocationRoute';
import { createDevelopmentWorkspaceRouter } from '../../src/development/developmentWorkspaceRoute';
import { createDevelopmentBusinessCiRouter } from '../../src/development/developmentBusinessCiRoute';
import { createDevelopmentRouter } from '../../src/development/route';
import { createDevelopmentCiFinanceRouter } from '../../src/finance/developmentCiFinanceRoute';
import { createFinanceRouter } from '../../src/finance/route';
import { createFinanceV2Router } from '../../src/finance/routeV2';
import { createApprovalRouter } from '../../src/approvals/approvalRoute';
import { createSampleRouter } from '../../src/samples/sampleRoute';
import { createQcRouter } from '../../src/qc/qcRoute';
import { createProductionBatchRouter } from '../../src/production/productionBatchRoute';
import { createReleaseRouter } from '../../src/production/releaseRoute';
import { createProductionRouter } from '../../src/production/route';
import { createInventoryRouter } from '../../src/inventory/inventoryRoute';
import { createShippingRouter } from '../../src/shipping/route';
import { createCustomsRouter } from '../../src/customs/customsRoute';
import { createPaymentRequestRouter } from '../../src/paymentRequests/paymentRequestRoute';
import { createBillingItemRouter, createCostRecordRouter } from '../../src/finance/billingItemRoute';
import { createSystemConfigRouter } from '../../src/config/systemConfigRoute';
import { createMoqRouter } from '../../src/moq/moqRoute';
import { createProcurementRouter } from '../../src/procurement/procurementRoute';
import { registerPaymentRequestApprovalHook } from '../../src/paymentRequests/paymentRequestApprovalHook';

export function createScenarioRehearsalApp(prisma: PrismaClient, privateFilesDir: string) {
  const app = express(), options = { prisma, requireAuth: true, apiKeys: new Set<string>() };
  // Production index registers the same hook. Approval and actual cash remain
  // separate facts; omitting this hook would give the rehearsal another runtime.
  registerPaymentRequestApprovalHook({ prisma });
  app.set('json replacer', (_key: string, value: unknown) => typeof value === 'bigint' ? String(value) : value);
  app.use(express.json({ limit: '10mb' }));
  app.use(createAccountStatusGuard(prisma));
  app.use('/api', createAuthorizationSnapshotGuard(options));
  app.use('/api/auth', createAuthRouter({ prisma, loginRateLimit: false }));
  app.use('/api/v1/config', createSystemConfigRouter(options));
  app.use('/api/v1/moq', createMoqRouter(options));
  app.use('/api/v1', createInternalFabricAllocationRouter(options));
  app.use('/api/v1/orders', createFabricCommissionBusinessRouter(options));
  app.use('/api/v1/orders', createOrderBusinessWorkspaceRouter(options));
  app.use('/api/v1/orders', createOrdersRouter(options));
  app.use('/api/v2/orders', createOrdersV2Router(options));
  app.use('/api/v1/order-lines', createOrderLinesRouter(options));
  app.use('/api/v1/development', createDevelopmentWorkspaceRouter(options));
  app.use('/api/v1/development', createDevelopmentBusinessCiRouter(options));
  app.use('/api/v1/development', createDevelopmentRouter(options));
  app.use('/api/v1/finance', createDevelopmentCiFinanceRouter(options));
  app.use('/api/v1/finance', createFinanceRouter(options));
  app.use('/api/v2/finance', createFinanceV2Router(options));
  app.use('/api/v1/approvals', createApprovalRouter(options));
  app.use('/api/v1/samples', createSampleRouter({ ...options, privateFilesDir }));
  app.use('/api/v1/qc', createQcRouter({ ...options, privateFilesDir }));
  app.use('/api/v1/production-batches', createProductionBatchRouter(options));
  app.use('/api/v1/releases', createReleaseRouter(options));
  app.use('/api/v1/production', createProductionRouter(options));
  app.use('/api/v1/inventory', createInventoryRouter(options));
  app.use('/api/v1/shipping', createShippingRouter(options));
  app.use('/api/v1/customs', createCustomsRouter(options));
  app.use('/api/v1/payment-requests', createPaymentRequestRouter(options));
  app.use('/api/v1/procurement', createProcurementRouter(options));
  app.use('/api/v1/billing-items', createBillingItemRouter(options));
  app.use('/api/v1/cost-records', createCostRecordRouter(options));
  return app;
}
