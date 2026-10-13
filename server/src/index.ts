// Load env BEFORE Prisma is initialized.
// Local dev overrides come from .env.local (gitignored); .env is the fallback (e.g. cloud creds).
import dotenv from 'dotenv';
import path from 'path';
const SERVER_ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(SERVER_ROOT, '.env.local'), override: true });
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
import { safeRouteError } from './shared/routeError';
import { assertBusinessClockConfiguration } from './shared/businessClock';
import { InvoiceAttachmentError, readLegacyInvoiceAttachment } from './finance/invoiceAttachmentService';

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { buildXlsx, type XlsxSheet } from './templates/xlsxExport';
// ★ 2026-09-25 下线：PDF 导入订单功能不再对外提供 ⇒ 不再引入该 router（模块本体保留）。
//   恢复方式见下方 /api/v1/import 挂载点原位注释。原写法：
//   import { createImportRouter } from './import/route';
import { createOrdersRouter } from './orders/route';
import { createOrderBusinessWorkspaceRouter } from './orders/orderBusinessWorkspaceRoute';
import { createFabricCommissionBusinessRouter } from './finance/fabricCommissionRoute';
import { createInternalFabricAllocationRouter } from './orders/internalFabricAllocationRoute';
import { createOrdersV2Router } from './orders/routeV2';
import { createOrderLinesRouter } from './orders/orderLinesRoute';
import { createRelationsRouter } from './relations/route';
import { createRelationsV2Router } from './relations/routeV2';
import { createHandoverRouter } from './handover/route';
import { createFabricCalculatorRouter } from './tools/fabricCalculatorRoute';
import { createAccountStatusGuard } from './auth/accountStatusGuard';
import { createAuthorizationSnapshotGuard } from './auth/authorizationSnapshotGuard';
import { createUploadsGuard } from './lib/uploadsGuard';
import { assertPublicUrl, safeFetch, SsrfBlockedError } from './lib/ssrfGuard';
import { createProductsRouter } from './products/route';
import { createFabricUseAuthorizationCustomerConfirmationAdapter } from './products/fabricUseAuthorizationService';
import { createSystemAssetsRouter } from './system-assets/route';
import { createPdmlRouter } from './pdml/route';
import { startPdmlSyncScheduler } from './pdml/scheduler';
import { createEntitiesRouter } from './entities/route';
import { createBusinessProfilesRouter } from './business-profiles/route';
import { createGarmentTrimRouter } from './development/garmentTrimRoute';
import { createDevelopmentRouter } from './development/route';
import { createDevelopmentWorkspaceRouter } from './development/developmentWorkspaceRoute';
import { createDevelopmentBusinessCiRouter } from './development/developmentBusinessCiRoute';
import { createFinanceRouter } from './finance/route';
import { createDevelopmentCiFinanceRouter } from './finance/developmentCiFinanceRoute';
import { createFinanceV2Router } from './finance/routeV2';
import { createReconciliationRouter } from './finance/reconciliationRoute';
import { createBillingItemRouter, createCostRecordRouter } from './finance/billingItemRoute';
import { createSceneInvoiceRouter } from './finance/sceneInvoiceRoute';
import { createCompletenessRouter } from './completeness/route';
import { createReportingRouter } from './reporting/route';
import { createShippingRouter } from './shipping/route';
import { createDashboardRouter } from './dashboard/route';
import { createQuotationRouter } from './quotations/quotationRoute';
import { createMoqRouter } from './moq/moqRoute';
import { createToleranceStandardRouter } from './orders/toleranceStandardRoute';
import { createOrderChangeRouter } from './orderChanges/orderChangeRoute';
import { createSampleRouter } from './samples/sampleRoute';
import { createExceptionRouter } from './exceptions/exceptionRoute';
import { createExceptionService } from './exceptions/exceptionService';
import { createReceiptMatchProposalRouter } from './finance/receiptMatchProposalRoute';
import { createCreditRouter } from './credit/creditRoute';
import { createInternalTradeRouter } from './internalTrade/internalTradeRoute';
import { createPaymentRequestRouter } from './paymentRequests/paymentRequestRoute';
import { createClaimRouter } from './claims/claimRoute';
import { createClaimCashRefundRouter } from './claims/claimCashRefundRoute';
import { createClaimCashRefundReturnRouter } from './claims/claimCashRefundReturnRoute';
import { assertClaimCreditNoteVisibility } from './claims/claimVisibility';
import { registerPaymentRequestApprovalHook } from './paymentRequests/paymentRequestApprovalHook';
import { createProcurementRouter } from './procurement/procurementRoute';
import { createInventoryRouter } from './inventory/inventoryRoute';
import { createBOMRouter } from './bom/bomRoute';
import { createCrmRouter } from './crm/crmRoute';
import { createCrmV2Router } from './crm/crmRouteV2';
import { createSupplierRouter } from './suppliers/factoryRoute';
import { createSuppliersV2Router } from './suppliers/factoryRouteV2';
import { createDataMigrationRouter } from './migration/dataMigrationRoute';
import { createSeasonRouter } from './seasons/seasonRoute';
import { createSeasonsV2Router } from './seasons/seasonRouteV2';
import { createMarketingV2Router } from './marketing/marketingRouteV2';
import { createRiskRouter } from './risk/riskRoute';
import { createBusinessLineRouter } from './businessLines/businessLineRoute';
import { ensureBusinessLineSeed } from './businessLines/businessLineService';
import { createQcRouter } from './qc/qcRoute';
import { createPricingRouter } from './pricing/pricingRoute';
import { createOrderCostReviewRouter } from './pricing/orderCostReviewRoute';
import { createLookbookRouter } from './products/lookbookRoute';
import { createFabricRecommendationRouter } from './products/fabricRecommendationRoute';
import { createMesRouter } from './mes/mesRoute';
import { createCustomsRouter } from './customs/customsRoute';
import { createCustomsV2Router } from './customs/customsRouteV2';
import { createDocumentTemplateRouter } from './customs/documentTemplateRoute';
import { createProductionRouter } from './production/route';
import { createReleaseRouter } from './production/releaseRoute';
import { createProductionBatchRouter } from './production/productionBatchRoute';
import { createProductionV2Router } from './production/routeV2';
import { createTraceabilityRouter } from './traceability/traceabilityRoute';
import { createTemplatesRouter } from './templates/route';
import { logger } from './lib/logger';
import { loadAgentApiKeyActors, setDefaultAgentApiKeyActors } from './auth/agentPrincipal';
import { attachPrismaSlowQueryLogger, createRequestTimingMiddleware } from './lib/requestTiming';
import { globalErrorHandler, registerUnhandledRejectionGuard } from './lib/asyncHandler';
import { PRIVATE_FILES_DIR, isInsideDir } from './lib/privateFiles';
import { createEmailRouter } from './email/route';
import { createEmailTemplateRouter, seedStandardEmailTemplates } from './email/templateRoute';
import { createEmailSignatureRouter } from './email/signatureRoute';
import { createSealRouter } from './seal/sealRoute';
import { addRealtimeClient, publishDataChange } from './realtime';
import { createAiRuntime } from './ai/runtime';
import { createAiRouter } from './ai/route';
import { createMacMiniChatRunner } from './ai/runner';
import { prewarmMeloTts, getMeloPrewarmStatus } from './ai/tts';
import { createKnowledgeDocumentsRouter } from './ai/knowledgeDocumentsRoute';
import { createKnowledgeRouter } from './knowledge/knowledgeRoute';
import { ensureSopTemplateSeed } from './knowledge/sopTemplateService';
import { createAgentRouter } from './agent/route';
import { ensureDefaultAgentTools } from './agent/tools';
import { createAuthRouter } from './auth/route';
import { createCustomerPortalRouter } from './customer/route';
import { createDevPanelRouter } from './devPanel/route';
import { DEV_COMPANIES } from './devPanel/companies';
import { dbUrlFor, getActiveDb, isDualMode } from './devPanel/activeDb';
import { createAdminRouter } from './admin/route';
import { createApprovalRouter } from './approvals/approvalRoute';
import { createApprovalKernelRouter } from './approvals/approvalKernelRoute';
import type { OnApprovalDecided } from './approvals/approvalDecisionService';
import { createApprovalRoutingService } from './approvals/approvalRoutingService';
import { createApprovalCreateService } from './approvals/approvalCreateService';
import { createOrderChangeRequestService } from './orderChanges/orderChangeRequestService';
import { createOrderChangeCustomerConfirmationAdapter } from './orderChanges/orderChangeCustomerConfirmationAdapter';
import { createCustomerConfirmationRouter } from './customerConfirmations/customerConfirmationRoute';
import { createCustomerConfirmationTargetRegistry } from './customerConfirmations/customerConfirmationService';
import { createAuditRouter } from './audit/route';
import { createHRRouter } from './hr/route';
import { initializeNotificationBindings } from './notifications/eventBindings';
import { createNotificationsRouter } from './notifications/route';
import { createAutomationRouter } from './config/automationRoute';
import { createSystemConfigRouter } from './config/systemConfigRoute';
import { registerAllLinkages } from './events/linkages';
import { startScheduler } from './scheduler';
import { createWorkflowRouter } from './workflow/workflowRoute';
import { WorkflowEngine, seedDefaultWorkflowDefinitions } from './workflow/workflowEngine';
import { registerWorkflowEventTriggers } from './workflow/workflowEventTriggers';
import { extractActorFromRequest } from './auth/middleware';
import { requireJwtForWrite } from './auth/moduleGuard';
import { requirePermission } from './auth/permissionGuard';
import type { PermissionScope } from './_shared/rolePermissionMatrix';
import { TokenPayload } from './auth/service';
import { partitionApiKeys, redactKey } from './auth/apiKeySafety';
import { AgentRole } from './agent/types';
import { createEmailService } from './auth/email';
import { createVerificationStore } from './auth/verification';
import { createDbVerificationStore } from './auth/verificationDb';
import { describeRuntimeDataSource } from './dataSource';
// ★ 业务日唯一真源（本地时区）。禁止 `toISOString().slice(0,10)`：那取的是 UTC 日，
//   本地 00:00–08:00 会比中国日早一天（守卫 server/src/shared/__tests__/localDateKey.test.ts）
import { todayLocalKey } from './shared/localDate';
import { orderAmountOrNull } from './shared/orderAmount';
// ★★ 删实体时统一清引用（修 2026-09-18 发现的根因：`server/src` 里引用表只 upsert 不 delete ✗）
import { installEntityRefPurge } from './entities/entityRefPurgeMiddleware';
// 行情唯一真源（棉花实时 / 羊毛·亚麻人工录入；拿不到就返回 null，绝不编造）
import { fetchCommodityQuotes } from './market/marketQuoteService';
// 汇率唯一真源（读财务 ExchangeRate 表，与单据换算同源；不再直连 exchangerate-api.com）
import { fetchForexQuotes, toForexPayload } from './market/forexQuoteService';
import { createMarketQuoteRouter } from './market/marketQuoteRoute';
import { getSystemConfigService } from './config/systemConfigService';

// Prisma (Bambook 数据) — 开启 query 事件以支撑慢查询日志（Phase 1 · 任务 1.2）
// DEV 双库模式：启动期即建立两个演示库的连接池，用 Proxy 把每次 prisma.xxx 调用
// 动态委托给「当前激活库」的客户端，实现切库零重启（翻转 activeDb 指针即可）。
// 非双库模式（生产 / 未开 BAMBOOK_DEV_PANEL）维持原单例行为，零改动。
assertBusinessClockConfiguration();
let prisma: PrismaClient;
if (isDualMode()) {
  const baseUrl = process.env.DATABASE_URL || '';
  const clients = new Map<string, PrismaClient>();
  for (const c of DEV_COMPANIES) {
    const url = dbUrlFor(c.dbName, baseUrl);
    const client = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
    // ★★ 每个库客户端都装「删实体清引用」中间件（2026-09-18 · 根因修复 ✓）
    installEntityRefPurge(client as unknown as Parameters<typeof installEntityRefPurge>[0]);
    clients.set(c.dbName, client);
  }
  const dualFallback = clients.get(getActiveDb()) ?? clients.values().next().value!;
  prisma = new Proxy(dualFallback, {
    get(_target, prop) {
      const client = clients.get(getActiveDb()) ?? dualFallback;
      // 动态委托到当前激活库客户端（@ts-ignore：属性在运行期才解析到具体子对象）
      return (client as any)[prop];
    },
  }) as unknown as PrismaClient;
} else {
  prisma = new PrismaClient({
    log: [{ emit: 'event', level: 'query' }],
  });
  // ★★ 装「删实体清引用」中间件（2026-09-18 · 根因修复 ✓）
  installEntityRefPurge(prisma as unknown as Parameters<typeof installEntityRefPurge>[0]);
}
attachPrismaSlowQueryLogger(prisma as unknown as Parameters<typeof attachPrismaSlowQueryLogger>[0]);
const runtimeDataSource = describeRuntimeDataSource();
if (runtimeDataSource.warning) {
    logger.warn(`[data-source] ${runtimeDataSource.warning}`);
}
logger.info(`[data-source] kind=${runtimeDataSource.kind} host=${runtimeDataSource.host} database=${runtimeDataSource.name} businessTruth=${runtimeDataSource.isBusinessTruth}`);
ensureDefaultAgentTools(prisma).catch(error => {
    logger.error('[agent-tools] failed to ensure default tools', { error: error?.message || String(error) });
});
// F5 邮件智能化：启动时幂等播种标准业务邮件模板库（报价/催款/交期/验货/问候），保证 Compose 模板库开箱有数
seedStandardEmailTemplates(prisma).catch(error => {
    logger.error('[email-templates] boot seed failed', { error: error?.message || String(error) });
});
// C7 知识库深化：启动时幂等播种纺织外贸核心 SOP 模板（大货跟单/验货/出运/报关），仅当表为空时写入
ensureSopTemplateSeed(prisma)
    .then(seeded => { if (seeded) logger.info('[knowledge] SOP template seed applied'); })
    .catch(error => {
        logger.error('[knowledge] SOP template seed failed', { error: error?.message || String(error) });
    });
// PRD 6.2 业务线注册表：启动时幂等播种三大默认业务线（fabric/garment/capsule），
// 保证订单业务线标记（Capsule 子视图等）开箱可用，不再依赖手工注册
ensureBusinessLineSeed(prisma).catch(error => {
    logger.error('[business-lines] boot seed failed', { error: error?.message || String(error) });
});
// Phase 0 Sprint 1: 初始化业务事件总线 + 通知系统
// 注入 prisma 到 businessEventBus，订阅所有业务事件 → notificationService
initializeNotificationBindings(prisma);
// Phase 1 Sprint 3: 注册业务联动执行器（订单→生产→发货→发票→收款 自动联动）
registerAllLinkages();
// Phase 0 Sprint 2: 启动调度器（崩溃恢复 + 每日 briefing + 卡滞检测 + AgentJob 清理）
// ★ v3.87：**默认行为不变**；置 BAMBOOK_NO_SCHEDULER=1 时不启动。
//   用途：另起一个"走查用"后端实例（把主线分支的成果接给走查环境）时，避免它
//   ① 往共享库写（市场价同步会无条件写一条 SystemConfigHistory）；
//   ② 给用户发通知 —— 后者会让 M3 演练的"删账号必先删通知"判据变红，污染验收读数。
if (process.env.BAMBOOK_NO_SCHEDULER === '1') {
    logger.warn('[scheduler] BAMBOOK_NO_SCHEDULER=1 ⇒ 本实例不启动调度器（走查/只读实例）');
} else {
    startScheduler(prisma);
}
// Phase 0 Sprint 2: 工作流引擎 — seed 默认定义 + 事件总线自动触发集成
// Keep startup ordered: a first boot must not subscribe against an empty
// definition table or expose workflow APIs before their registration finishes.
const workflowReady = seedDefaultWorkflowDefinitions(prisma)
    .then(() => registerWorkflowEventTriggers(prisma))
    .then(() => ({ ok: true as const }))
    .catch(error => ({ ok: false as const, error }));
startPdmlSyncScheduler({ prisma, onDataChange: publishDataChange });
const macMiniChatRunner = createMacMiniChatRunner({
    prisma,
    runSearch: task => aiRuntime.runSearch(task),
});
const aiRuntime = createAiRuntime({
    modelConcurrency: Number(process.env.BAMBOOK_AI_MODEL_CONCURRENCY || 3),
    searchConcurrency: Number(process.env.BAMBOOK_AI_SEARCH_CONCURRENCY || 6),
    heavyConcurrency: Number(process.env.BAMBOOK_AI_HEAVY_CONCURRENCY || 1),
    chatRunner: macMiniChatRunner,
});

// ── API Key 卫生自检（完整论证见 auth/apiKeySafety.ts 顶部）────────────────
// VITE_ 前缀变量按 Vite 契约会内联进客户端产物，因此**不再**作为服务端密钥来源。
// 另做一次交叉自检：若某个待接受的密钥同时出现在任意 VITE_* 变量中，说明它已经
// （或即将）被打进前端产物 → 剔除并告警（fail-closed）。
// 这里选择「剔除密钥」而非「进程退出」：一把配错的 key 不该拖垮整个服务，
// 员工 JWT 登录不受影响，仅 API-Key 通道对该 key 立即失效。
const SDK_KEY_PARTITION = partitionApiKeys([
    process.env.BAMBOOK_SDK_KEY,
    process.env.BAMBOOK_API_KEY,
]);
if (SDK_KEY_PARTITION.rejected.length > 0) {
    logger.error(
        `[SECURITY] 已拒绝 ${SDK_KEY_PARTITION.rejected.length} 个「同时出现在 VITE_* 变量中」的 API Key`
        + `（VITE_ 变量会被 Vite 内联进前端产物，等同于公开）：`
        + SDK_KEY_PARTITION.rejected.map(redactKey).join('、')
        + `。请将 BAMBOOK_SDK_KEY / BAMBOOK_API_KEY 轮换为未出现在任何 VITE_ 变量中的新值；`
        + `员工 JWT 登录不受影响，仅 API-Key 通道对该 key 失效。`,
    );
}

const SDK_CONFIG = {
    apiKeys: new Set(SDK_KEY_PARTITION.accepted),
    requireAuth: process.env.BAMBOOK_REQUIRE_AUTH === 'true' || process.env.NODE_ENV === 'production',
};

/**
 * §10.4.1（2026-09-12 定案）：**把 AI 当员工看**——AI 与员工只是入口不同（UI vs MCP/API），
 * 权限一律取决于它自己的账号与身份。因此 API Key 必须绑定到真实 UserAccount，
 * 角色/权限/部门全部从 DB 该账号读取（见 auth/agentPrincipal.ts），不再由环境变量写死。
 *
 * 配置（二选一，均未配 = 不启用 Agent 主体，API-Key 请求 403 AGENT_PRINCIPAL_REQUIRED）：
 * - BAMBOOK_AGENT_API_KEY_MAP="key1=userId1,key2=userId2"  多主体（多个 AI 各自身份）
 * - BAMBOOK_AGENT_API_KEY_ACTOR_ID=userId                  单主体（全部 SDK key 共用）
 *
 * 容器在启动后异步填充（守卫按请求时查表，持有同一 Map 引用即可，无需重启）。
 */
const AGENT_API_KEY_ACTORS: Map<string, TokenPayload> = new Map();

function splitConfigList(value: string | undefined, fallback: string[] = []): string[] {
    const values = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    return values.length ? Array.from(new Set(values)) : fallback;
}

const sdkAuth = (req: Request, res: Response, next: () => void) => {
    // 身份解析无条件执行（P0-001 修复）：有凭证就解析注入 req.actor，
    // 与鉴权开关解耦——requireAuth 只控制「无凭证是否拒绝」，不控制「是否解析」。
    // 否则开发模式（requireAuth=false）下 req.actor 恒空，通知等要求用户身份的路由全 401。
    const actor = extractActorFromRequest(req);
    if (actor) {
        (req as any).actor = actor;
    }
    if (!SDK_CONFIG.requireAuth) return next();

    if (actor) {
        return next();
    }

    // Priority 2: API key header
    const apiKey = (req.headers['x-bambook-api-key'] || req.query.apiKey) as string | undefined;
    if (!apiKey) {
        return res.status(401).json({
            error: 'UNAUTHORIZED',
            message: 'API Key is required. Please provide X-Bambook-API-Key header.',
        });
    }

    if (!SDK_CONFIG.apiKeys.has(apiKey)) {
        return res.status(403).json({
            error: 'FORBIDDEN',
            message: 'Invalid API Key.',
        });
    }

    next();
};

const app = express();
const PORT = process.env.PORT || 8081;

// 进程级 unhandledRejection 兜底（Express 4 async 错误三件套之一）：
// Express 4 不捕获 async handler 的 rejection，任何未包装的 async 路由 reject
// 都会打崩进程（Node 15+ 默认 throw）。此处只记日志不退出——路由层应优先经
// asyncHandler → globalErrorHandler 管道处理，走到这里的是漏网调用点。
registerUnhandledRejectionGuard();

// 确保输出目录存在
const OUTPUT_DIR = path.join(__dirname, '../../output');
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// 确保上传目录存在
const UPLOAD_DIR = process.env.BAMBOOK_UPLOAD_DIR || path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 私有文件根（安全收口）：邮件附件 / QC 测试报告等敏感文件落盘于此，
// 不经 /api/uploads 静态服务，只走带权限门的下载路由（emails:read / qc:read）。
// 防呆校验：私有根一旦位于静态服务根之内（env 误配），敏感文件会被无鉴权直读——拒绝启动。
if (isInsideDir(UPLOAD_DIR, PRIVATE_FILES_DIR)) {
    throw new Error(
        `[private-files] 私有文件根 (${PRIVATE_FILES_DIR}) 不可位于 /api/uploads 静态服务根 (${UPLOAD_DIR}) 之内，` +
        '请检查 BAMBOOK_PRIVATE_FILES_DIR / BAMBOOK_UPLOAD_DIR 配置。',
    );
}

// Middlewares
// CORS 显式白名单（P2 安全收紧）：不再反射任意 Origin——携带凭证请求若来自未知站点
// 会被浏览器拦截（服务端不返回 Allow-Origin）。无 Origin 的请求（curl / Electron
// 原生 fetch / 同源隧道）一律放行，避免误伤非浏览器调用方。
const ALLOWED_ORIGINS = new Set<string>([
    'http://localhost:3000', // 本地 dev 前端（vite）
    'http://127.0.0.1:3000',
    'http://localhost:3001', // 历史 mobile dev 端口（已退役，保留兼容）
    'http://localhost:4173', // vite preview
    'https://jiangsupanda.com', // 生产（Cloudflare Tunnel 同域，含 /bambook/api/app webapp）
    'https://bambook.jiangsupanda.com', // 生产子域名入口
    'http://localhost:3005', // 客户门户 dev（customer-portal）
    'http://localhost:8081', // dev 后端自身
]);
const corsWithCredentials = cors({
    origin(origin, cb) {
        if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        cb(null, false);
    },
    credentials: true,
});
app.use(corsWithCredentials);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
// REQ2-13（DR-056-③）：停用账号即时失效——JWT 只验签不查库的根因缺口在组合根拦截
//（30s TTL 缓存；停用/交接路径调用 invalidateAccountStatusCache 同进程即时失效）
app.use(createAccountStatusGuard(prisma));
// 先归一化隧道前缀，再匹配 /api 的当前授权刷新守卫。
// Cloudflare Tunnel routes /bambook/api/* to this 8081 service (without prefix rewrite).
// Strip the /bambook prefix so existing /api/* handlers stay intact for the Electron
// desktop client, which calls https://jiangsupanda.com/bambook/api/... via the tunnel.
// (Web APP project已下线 — 不再有 /api/app 静态托管，仅保留 API 路由。)
app.use((req, _res, next) => {
    if (req.url === '/bambook/api' || req.url.startsWith('/bambook/api/')) {
        req.url = req.url.slice('/bambook'.length);
    }
    next();
});

app.use('/api', createAuthorizationSnapshotGuard({ prisma, apiKeys: SDK_CONFIG.apiKeys, apiKeyActors: AGENT_API_KEY_ACTORS }));
// 请求耗时日志：5xx→error / 慢请求→warn / 其余→debug（Phase 1 · 任务 1.2）
app.use(createRequestTimingMiddleware());
app.use((req, res, next) => {
    // 与 corsWithCredentials 同口径：仅白名单 Origin 回显（不反射任意 Origin，
    // 否则带凭证请求可被任意站点读取——P2 双保险，该手写中间件与 cors 包并存）。
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
        res.header('Access-Control-Allow-Credentials', 'true');
    }
    next();
});

// 敏感文件子树拒绝直读（fail-closed）：邮件附件 / QC 测试报告 / 贸易单据归档 / 报价行图片 /
// 知识库文档只允许经带权限门的下载路由读取。前两者新代码已落盘私有根（此拦截兜底迁移前存量）；
// trade-documents 仍写 uploads 静态根（customs/procurement/quotation/orders/qc 五域共用
// 归档通道），商业发票/箱单/提单等 PDF 含客户与价格数据，禁止无鉴权直读——
// 下载统一走 /api/v1/customs/trade-documents/:id/download（customs:read 门）。
// quotations/（报价行图片）→ /api/v1/quotations/line-image/:filename（quotations:read 门）；
// knowledge-documents/（知识库文档）→ /api/v1/knowledge-documents/:docId/download（knowledge:read 门）。
// 注意：这里**不再**用 `app.use('/api/uploads/trade-documents', 404)` 这类字面量挂载。
// 实测证明它挡得住常规路径，挡不住 `//`、%2D、%2F 三种写法——
// app.use 按原始 URL 前缀匹配，而 express.static 会先解码再折叠重复斜杠，
// 二者视角不一致就形成了绕过（匿名拿到 248KB 商业发票 PDF）。
// 现改为归一化后判定，与 static 站在同一视角；细节见 lib/uploadsGuard.ts。
app.get('/api/uploads/invoices/:filename', async (req, res) => {
    try {
        // Legacy aliases have no anonymous/static fallback. Only a native
        // immutable receipt can locate a blob, then current full L2 applies.
        const result = await readLegacyInvoiceAttachment(prisma, (req as any).actor ?? null, req.params.filename);
        res.setHeader('Content-Type', result.attachment.mimeType);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.fileName)}`);
        res.setHeader('Cache-Control', 'private, no-store');res.send(result.bytes);
    } catch (error) {
        const refusal = InvoiceAttachmentError.readOriginal(error);
        if (refusal) res.status(refusal.code === 'UNAUTHORIZED' ? 404 : refusal.statusCode).json({ error: { code: refusal.code, message: refusal.message } });
        else { const failure = safeRouteError(new Error('INVOICE_ATTACHMENT_DOWNLOAD_FAILED'), {fallbackCode:'DOWNLOAD_FAILED',fallbackMessage:'附件暂时无法核对，请稍后重试。'});res.status(failure.status).json({error:{code:failure.code,message:failure.message}}); }
    }
});
app.use('/api/uploads', createUploadsGuard());

// Serve uploaded images at /api/uploads/*
app.use('/api/uploads', express.static(UPLOAD_DIR));

// Serve webapp (frontend SPA) at /api/app/ — Cloudflare Tunnel routes /bambook/api/app/* here.
// The /bambook prefix is stripped by the middleware above, so Express sees /api/app/*.
const WEBAPP_DIR = path.join(__dirname, '..', 'webapp');
if (fs.existsSync(WEBAPP_DIR)) {
  app.use('/api/app', express.static(WEBAPP_DIR));
  // SPA fallback: non-asset requests return index.html so client-side routing works
  app.get('/api/app', (_req, res) => res.sendFile(path.join(WEBAPP_DIR, 'index.html')));
  app.get('/api/app/*', (req, res, next) => {
    if (req.path.includes('.')) return next(); // asset request → 404
    res.sendFile(path.join(WEBAPP_DIR, 'index.html'));
  });
}

// Serialization helper for BigInt
// @ts-ignore
BigInt.prototype.toJSON = function () {
    return Number(this);
};

// Serialization helper for Prisma.Decimal — ensures JSON output is number, not string
import { Prisma } from '@prisma/client';
// @ts-ignore
if (Prisma.Decimal.prototype.toJSON === undefined || Prisma.Decimal.prototype.toJSON.name !== 'decimalToNumberJSON') {
    const _origToJSON = Prisma.Decimal.prototype.toJSON;
    // @ts-ignore
    Prisma.Decimal.prototype.toJSON = function decimalToNumberJSON() {
        return Number(this);
    };
}

// Health Check
/**
 * 构建标识 —— 回答「生产跑的到底是哪个提交」。
 *
 * 为什么需要（2026-09-19 实测缺口）：`version` 取的是 `package.json` 的版本号（写死 `1.0.0`），
 * **从外部无法判断生产部署的是哪一版**。当天实测：公开仓停在 09-01、本地 HEAD 是 09-19、
 * 生产健康检查只回 `1.0.0` ⇒ 只能靠**探测某个路由是否存在**来猜版本下界（脆弱且间接）。
 *
 * 优先级：`BUILD_SHA` 环境变量（打包/部署时注入，生产推荐）> 本地 `git rev-parse` > `'unknown'`。
 * ⚠️ 生产是**打包上传**、可能没有 git 仓库 ⇒ 必须 try/catch，
 *    绝不能因为取不到构建号而让 health 变成 500（健康检查比构建号重要）。
 */
function resolveBuildSha(): string {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return sha || 'unknown';
  } catch {
    return 'unknown';
  }
}
const BUILD_SHA = resolveBuildSha();

app.get('/api/health', async (_req, res) => {
    const ttsPrewarm = getMeloPrewarmStatus();
    const health = {
        status: "ok",
        node: "PandaAI-Sovereign-Node-Prisma",
        timestamp: Date.now(),
        version: process.env.npm_package_version || '1.0.0',
        build: BUILD_SHA,
        authRequired: SDK_CONFIG.requireAuth,
        realtime: 'sse-in-process',
        database: 'ok',
        tts: ttsPrewarm
            ? {
                provider: ttsPrewarm.provider,
                prewarmOk: ttsPrewarm.ok,
                prewarmSkipped: ttsPrewarm.skipped,
                prewarmElapsedMs: ttsPrewarm.elapsedMs,
                prewarmAt: ttsPrewarm.at,
                prewarmError: ttsPrewarm.error,
            }
            : { provider: process.env.BAMBOOK_TTS_PROVIDER || 'melo', prewarmOk: null },
    };
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json(health);
    } catch (error: any) {
        res.status(503).json({
            ...health,
            status: 'error',
            database: 'unavailable',
            error: error?.message || 'Database unavailable',
        });
    }
});

// Sync Handler
const handleSync = async (model: any, req: express.Request, res: express.Response, entity?: string) => {
    try {
        if (req.method === 'GET') {
            const data = await model.findMany({ where: { deletedAt: null } });
            return res.json(data);
        }

        if (req.method === 'POST') {
            const incoming = req.body;
            const items = Array.isArray(incoming) ? incoming : [incoming];

            const ops = items.map((item: any) => {
                const payload = { ...item };
                if (payload.timestamp) payload.timestamp = BigInt(payload.timestamp);
                if (payload.updatedAt) payload.updatedAt = BigInt(payload.updatedAt);
                if (payload.deletedAt) payload.deletedAt = BigInt(payload.deletedAt);
                if (payload.lastInteraction) payload.lastInteraction = BigInt(payload.lastInteraction);

                return model.upsert({
                    where: { id: item.id },
                    update: payload,
                    create: payload
                });
            });

            await prisma.$transaction(ops);
            if (entity) {
                publishDataChange({
                    entity,
                    action: 'legacy-sync',
                    ids: items.map((item: any) => String(item.id)).filter(Boolean),
                });
            }
            return res.json({ status: "success", count: items.length });
        }
        // B72③：原先 PUT/PATCH/DELETE 走到这里**既不响应也不 next()** ⇒ 请求一直挂到超时
        //（v2.47 复核 minor-4 更正数字：这句写下时是 7 条 `app.all`，v2.44 把 `/api/dev-memory` 收成只读后是 **6 条**
        //  —— 守卫 `legacySyncSurfaceB72.test.ts` 现在把 6 这条**钉成断言**，注释再漂会先红不再静默）。
        //  凡 `handleSync` 不认识的动词都会进到这个函数（面挂在 `app.all` 上 ⇒ 进来的**动词集合不受限**，
        //  所以这里**不写"几类"**——v2.47 复核抓到本行先前那句"两类方法"又是手写一个数、当场就漂了）。
        //  现在给明确出口：不认识的动词一律 405，不再挂到超时。
        res.status(405).json({ error: 'UNSUPPORTED_METHOD', message: `This legacy sync endpoint supports GET/POST only (got ${req.method}).` });
    } catch (e: any) {
        logger.error("Sync Error", { error: e?.message || String(e) });
        res.status(500).json({ status: "error", error: e.message });
    }
};

// Legacy broad sync routes. They remain for older screens during the Mac mini
// cutover, but are no longer an unauthenticated public write surface.
// ★ v2.47 复核 minor-4：这里原先重复了一遍"写方法叠加 requireJwtForWrite + **对应域 write scope**"的说法 ——
//   那句正是 v2.43 立账 B72 时抓到的**注释假陈述**（当时 7 条里有 2 条根本不查 scope）。
//   修代码时把改对的说明写在了下面的 `legacyWriteGuard` 文档块里，这一份没删 ⇒ 同一条契约两处各说一遍，
//   其中一处还是错的。现在只留指向真源那一份的指针。
// 口径以 `legacyWriteGuard` 的注释与守卫 `src/__tests__/legacySyncSurfaceB72.test.ts` 为准。
const LEGACY_SYNC_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * B72（v2.44）：`scope` 改成**必填**。
 * 原先签名是 `(scope?: PermissionScope)` 且写分支里有一句 `if (!scope) return next();`
 * ⇒ 少传一个参数就**静默放行任意登录账号的写**（实测 7 条遗留写面里有 2 条就这么裸着）。
 * 现在缺 scope 直接编译不过，判据侧再钉一条"源码里每条 app.all 都必须点名 scope"。
 */
const legacyWriteGuard = (scope: PermissionScope) => (req: Request, res: Response, next: NextFunction) => {
    if (!LEGACY_SYNC_WRITE_METHODS.has(req.method)) {
        return sdkAuth(req, res, next);
    }
    return requireJwtForWrite({ requireAuth: SDK_CONFIG.requireAuth, apiKeys: SDK_CONFIG.apiKeys })(req, res, () => {
        // 无 actor（dev / 纯 API-Key 通道）维持旧口径放行——认证已由上游把关
        const actor = (req as any).actor;
        if (!actor?.userId) return next();
        return requirePermission(scope)(req, res, next);
    });
};

/**
 * 安全收口（P1-1 · B72 更正本注释）：读方法维持 `sdkAuth` 登录门；写方法（POST/PUT/PATCH/DELETE）
 * 叠加 requireJwtForWrite（API-Key 不足，必须 JWT 会话）+ **该面点名的 write scope**
 * ——防共享 API-Key 或越权角色直写业务表（实测原 POST /api/orders 带 API-Key 即 200 直写）。
 * ⚠️ 本注释此前写"叠加对应域 write scope"，而下面 7 条里有 2 条根本没传 scope ⇒ 假陈述，已随 B72 修掉。
 */
app.all('/api/orders', legacyWriteGuard('orders:write'), (req, res) => handleSync(prisma.order, req, res, 'orders'));
app.all('/api/knowledge', legacyWriteGuard('knowledge:write'), (req, res) => handleSync(prisma.knowledgeItem, req, res, 'knowledge'));
app.all('/api/relations', legacyWriteGuard('relations:write'), (req, res) => handleSync(prisma.relation, req, res, 'relations'));
app.all('/api/products', legacyWriteGuard('products:write'), (req, res) => handleSync(prisma.productAsset, req, res, 'products'));
app.all('/api/product-categories', legacyWriteGuard('products:write'), (req, res) => handleSync(prisma.productSubCategory, req, res, 'product-categories'));
/**
 * B72②：`/api/insights` 原先**不传 scope** ⇒ 生产态下任何已登录低权账号都能整行 upsert `Insight`。
 * 挂 `knowledge:write` 的出处：`lib/rolePermissionMatrix.ts` 里 `[View.DataCenter]` 的 write 就是它，
 * 且 `'knowledge:read'` 的描述原文是「知识库/**数据中心看板**查看」——Insight 正是那块的看板数据。
 */
app.all('/api/insights', legacyWriteGuard('knowledge:write'), (req, res) => handleSync(prisma.insight, req, res, 'insights'));
/**
 * B72①：`/api/dev-memory` 写面**收成只读**。
 * 依据（三条都可复核，不是设想）：全仓（本 worktree + 主 checkout 的 `App.tsx`/`services`/`server/src`）
 * 里字符串 `dev-memory` **只出现在这一条注册行本身**，前后端消费者 0；`ProjectMemory` 在服务端也没有
 * 任何 service/路由在用；且生产尚未部署 ⇒ 不存在"看站点日志"这条证据可取。
 * 没有可引用的 write scope 出处（不像 insights 有 DataCenter 那条），而"给谁写"属政策 ⇒ **不自裁**，
 * 选择"先不开放写"：GET 维持 `sdkAuth` 原口径，写方法不再注册（Express 默认 404，不再是"任意登录账号可写"）。
 */
app.get('/api/dev-memory', sdkAuth, (req, res) => handleSync(prisma.projectMemory, req, res, 'dev-memory'));

app.get('/api/v1/events', sdkAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 带上 userId：通知类事件需按 recipientIds 投递（2026-09-15 收口，
    // 此前是全员广播，发给 A 的通知会送到所有在线用户的浏览器）。
    const removeClient = addRealtimeClient(res, (req as any).actor?.userId ?? null);
    req.on('close', removeClient);
});

app.use('/api/ai', createAiRouter({
    runtime: aiRuntime,
    prisma,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
    apiKeyActors: AGENT_API_KEY_ACTORS,
}));

app.use('/api/v1/knowledge-documents', createKnowledgeDocumentsRouter({
    uploadDir: UPLOAD_DIR,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
    prisma,
    onDataChange: publishDataChange,
}));

// C7 知识库深化：SOP 模板 + 知识关联（图谱）只读
app.use('/api/v1/knowledge', createKnowledgeRouter({
    prisma,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
    onDataChange: publishDataChange,
}));

const emailService = createEmailService();
// B5-1：验证码持久化——落库版（重启不丢/多实例可用）；测试环境（无 DB 依赖的用例）回退内存版
const verificationStore = process.env.NODE_ENV === 'test'
  ? createVerificationStore()
  : createDbVerificationStore({ prisma });
const requireEmailVerification = process.env.AUTH_REQUIRE_EMAIL_VERIFY
  ? !/^(0|false|no)$/i.test(process.env.AUTH_REQUIRE_EMAIL_VERIFY.trim())
  : true;
logger.info(`[auth] email transport: ${emailService.describe()}; verification ${requireEmailVerification ? 'required' : 'optional'}`);

app.use('/api/auth', createAuthRouter({
  prisma,
  email: emailService,
  verification: verificationStore,
  requireEmailVerification,
}));

// 客户门户（外部客户只读：订单/出运/发票，按 relationId 数据作用域隔离）
app.use('/api/v2/customer', createCustomerPortalRouter({ prisma }));

// 开发调试面板（公司切换 / 账号一键登录 / 环境信息）。仅当 BAMBOOK_DEV_PANEL=1 且非 production 时生效，否则路由返回 404。
app.use('/api/dev', createDevPanelRouter({ prisma }));

// 业务审批中心（PRD 19.21）：双轨偏差等第九章业务审批的待办/已办/决策；
// Agent 工具审批（tool:*）走 Assistant resolve，不在此暴露
// P0-003 修复：审批决策后同步业务单据状态（OrderChangeRequest 等）
const orderChangeApprovalSyncService = createOrderChangeRequestService({
    prisma,
    approvalCreateService: createApprovalCreateService({
        prisma,
        routingService: createApprovalRoutingService({ prisma }),
    }),
});
const customerConfirmationTargets = createCustomerConfirmationTargetRegistry([
    createOrderChangeCustomerConfirmationAdapter({ prisma, service: orderChangeApprovalSyncService }),
    createFabricUseAuthorizationCustomerConfirmationAdapter({ prisma }),
]);
app.use('/api/v1/customer-confirmations', createCustomerConfirmationRouter({
    prisma, targetAdapters: customerConfirmationTargets,
}));
const onApprovalDecided: OnApprovalDecided = async (approval) => {
        const result = approval.targetType === 'Dr013ExceptionRequest'
          ? await createExceptionService({ prisma, approvalCreateService: createApprovalCreateService({
              prisma, routingService: createApprovalRoutingService({ prisma }),
            }) }).syncFromApprovalDecision({ approvalRequestId: approval.id })
          : approval.targetType === 'OrderChangeRequest'
          ? await orderChangeApprovalSyncService.syncFromApprovalDecision({
            approvalRequestId: approval.id,
            decision: approval.status,
            decisionNote: approval.decisionNote,
            actorId: approval.actualDecisionActor,
        }) : null;
        if (result && !result.ok) {
            // The decision is already committed; all entry points expose a
            // retryable sync failure through the same decision service.
            throw new Error(result.error.message);
        }
};
app.use('/api/admin', createAdminRouter({ prisma, email: emailService,
    requireAuth: SDK_CONFIG.requireAuth, apiKeys: SDK_CONFIG.apiKeys, onDecided: onApprovalDecided }));
app.use('/api/v1/approvals', createApprovalRouter({
    prisma, requireAuth: SDK_CONFIG.requireAuth, onDecided: onApprovalDecided,
}));

// Phase 1 共享内核（DR-007）：审批委派 / BOSS 最终兜底 / 解析路径只读审计
app.use('/api/v1/approvals-kernel', createApprovalKernelRouter({ prisma,
    requireAuth: SDK_CONFIG.requireAuth, onDecided: onApprovalDecided }));

app.use('/api/hr', createHRRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth, apiKeys: SDK_CONFIG.apiKeys }));

app.use('/api/agent', createAgentRouter({
    prisma,
    dataSource: runtimeDataSource,
    getRuntimeMetrics: aiRuntime.getMetrics,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
    // /mcp/run Agent 工具执行面照 /api/ai strict principal 模式收口：
    // API-Key 必须绑定 AGENT_API_KEY_ACTORS 服务主体，请求 body 身份注入通道关闭
    apiKeyActors: AGENT_API_KEY_ACTORS,
    onDecided: onApprovalDecided,
}));

// ------------------------------------------------------------------
// /api/v1/import — ★ 2026-09-25 下线（Kevin 拍板）：PDF 导入订单功能不再对外提供。
//
// 状态：**未挂载** ⇒ POST /api/v1/import/order 现在返回 404。
// 为什么下线：该链是"为一个客户（peerless）硬编码的解析器"被接进产品主干
//   （ParsedOrder.customerId 类型写死字面量、registry 只有一条注册、客户主数据里无该客户），
//   且这条链此前从未在权威文档里登记过 ⇒ 先下线，等"通用化 + 登记"方案定了再接回。
// 代码**全部保留未删**（server/src/import/**、components/import/**、services/importService.ts），
//   它们的单测仍在跑（如 import/__tests__/route.test.ts 自建 app 直接测 router）。
// 恢复方式：把下面这段 app.use(...) 的注释取消即可（同时恢复 index.ts 顶部的 import）。
// 防回挂守卫：server/src/__tests__/erpCrossModuleSmoke.test.ts 里那条 Import 断言
//   方向已改为"不得再挂载"，谁把它接回来会当场咬红。
// ------------------------------------------------------------------
// app.use(
//     '/api/v1/import',
//     (req, res, next) => createImportRouter({
//         requireAuth: SDK_CONFIG.requireAuth,
//         apiKeys: SDK_CONFIG.apiKeys,
//     })(req, res, next),
// );

// ------------------------------------------------------------------
// /api/v1/orders — persistent Order resource (Postgres via Prisma)
app.use('/api/v1', createInternalFabricAllocationRouter({
    prisma, requireAuth: SDK_CONFIG.requireAuth, apiKeys: SDK_CONFIG.apiKeys,
}));
app.use('/api/v1/orders', createFabricCommissionBusinessRouter({ prisma }));
app.use('/api/v1/orders', createOrderBusinessWorkspaceRouter({ prisma, apiKeys: SDK_CONFIG.apiKeys }));
//   POST /import   { orders: ParsedOrder[] }   → privileged legacy migration (data:import + users:admin JWT; not PO upload/order entry)
// Auth shares BAMBOOK_SDK_KEY / BAMBOOK_REQUIRE_AUTH with the rest of /api/v1.
// ------------------------------------------------------------------
app.use(
    '/api/v1/orders',
    (req, res, next) => createOrdersRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/orders',
    (req, res, next) => createOrdersV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/order-lines',
    (req, res, next) => createOrderLinesRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/relations',
    (req, res, next) => createRelationsRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/relations',
    (req, res, next) => createRelationsV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

// REQ2-13（DR-056）：业务员离职一键交接——五类归属字段批量移交 + 停用留痕
app.use(
    '/api/v2/handover',
    (req, res, next) => createHandoverRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

// REQ2-22（DR-062）：面料计算器——六类行业换算/估算纯函数（零写路径，登录即可用）
app.use(
    '/api/v1/tools/fabric-calculator',
    (req, res, next) => createFabricCalculatorRouter({
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/products',
    (req, res, next) => createProductsRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        uploadDir: UPLOAD_DIR,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// 阶段 P2：电子画册（PRD 6.2 P2 LookbookCatalog）
app.use(
    '/api/v1/lookbooks',
    (req, res, next) => createLookbookRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// 阶段 P2：面料推荐引擎（PRD 6.2 P2 FabricRecommendation，确定性打分）
app.use(
    '/api/v1/fabric-recommendations',
    (req, res, next) => createFabricRecommendationRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use('/api/v1/development', createGarmentTrimRouter({ prisma }));
app.use('/api/v1/dev', createDevelopmentWorkspaceRouter({ prisma, apiKeys: SDK_CONFIG.apiKeys }));
app.use('/api/v1/development', createDevelopmentWorkspaceRouter({ prisma, apiKeys: SDK_CONFIG.apiKeys }));
app.use('/api/v1/development', createDevelopmentBusinessCiRouter({
    prisma, requireAuth: SDK_CONFIG.requireAuth, apiKeys: SDK_CONFIG.apiKeys,
    onDataChange: publishDataChange,
}));
app.use(
    '/api/v1/development',
    (req, res, next) => createDevelopmentRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use('/api/v1/finance', createDevelopmentCiFinanceRouter({
    prisma, requireAuth: SDK_CONFIG.requireAuth, apiKeys: SDK_CONFIG.apiKeys,
    onDataChange: publishDataChange,
}));
app.use('/api/v1/finance/receipt-match-proposals', createReceiptMatchProposalRouter({
    prisma, requireAuth: SDK_CONFIG.requireAuth, apiKeys: SDK_CONFIG.apiKeys,
    onDataChange: publishDataChange,
}));

app.use(
    '/api/v1/finance',
    (req, res, next) => createFinanceRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/finance',
    (req, res, next) => createFinanceV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

// W-B P2-6：客户四单对账工作台（订单↔出运↔开票↔收款，只读引擎）
app.use(
    '/api/v1/reconciliation',
    (req, res, next) => createReconciliationRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

// DR-053 阶段 3：收费事项（收费决定层）+ 成本记录（费用发生层）
app.use(
    '/api/v1/billing-items',
    (req, res, next) => createBillingItemRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);
app.use(
    '/api/v1/cost-records',
    (req, res, next) => createCostRecordRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);
// DR-054 阶段 F：场景化开票统一入口（财务域；样品/开发域不再出现开票动作）
app.use(
    '/api/v1/finance/scene-invoice',
    (req, res, next) => createSceneInvoiceRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

// 资料完备度规则引擎 v1（七规则三接口，纯实时只读，不落表）
app.use(
    '/api/completeness',
    (req, res, next) => createCompletenessRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

// 阶段 A5：报表引擎（数据集白名单 + 定义/运行/导出）
app.use(
    '/api/v1/reports',
    (req, res, next) => createReportingRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/shipping',
    (req, res, next) => createShippingRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/dashboard',
    (req, res, next) => createDashboardRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/production',
    (req, res, next) => createProductionRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// DR-053 阶段 2：生产放行范围化（§14）——独立子域
app.use(
    '/api/v1/releases',
    (req, res, next) => createReleaseRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// Neutral physical batch identity; does not create production/QC/stock facts.
app.use(
    '/api/v1/production-batches',
    (req, res, next) => createProductionBatchRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/production',
    (req, res, next) => createProductionV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v2/trace',
    (req, res, next) => createTraceabilityRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/quotations',
    (req, res, next) => createQuotationRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        uploadDir: UPLOAD_DIR,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// MOQ 域：阈值配置（settings:moq:write）+ 变更历史 + dry-run 预检（fail-closed，仅 JWT）
app.use(
    '/api/v1/moq',
    (req, res, next) => createMoqRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
    })(req, res, next),
);

// ★ 2026-09-29 公差标准域：**内部公差标准**读写 + 变更历史（settings:tolerance:write，fail-closed，仅 JWT）
//   使用方：「没有客户标准，就按内部标准，内部标准会需要在系统里填好的」
//   ★ 不填的后果：出运门禁按「未判定」处理 ⇒ 按 0 卡、不放溢装 ⇒ 这条通道是业务能溢装的前提。
app.use(
    '/api/v1/tolerance',
    (req, res, next) => createToleranceStandardRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
    })(req, res, next),
);

// Phase 2 Wave 2.1：订单变更域（DR-010 变更/取消/暂停审批链）+ 样品域（DR-008/011/012/026/028/039）
app.use('/api/v1/order-changes', createOrderChangeRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth }));
app.use('/api/v1/samples', createSampleRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth }));

// Phase 2 Wave 2.2：受控例外（DR-013）+ 信用控制（冻结/解冻/额度占用）+ 内部交易（DR-005/033）+ 付款申请
app.use('/api/v1/exceptions', createExceptionRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth }));
app.use('/api/v1/credit', createCreditRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth }));
app.use('/api/v1/internal-trade', createInternalTradeRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth }));
app.use('/api/v1/payment-requests', createPaymentRequestRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth }));
// ★ A 组售后索赔模型（口径 A1–A6）：案件 / 处置 / 退款单
app.use('/api/v1', createClaimRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth }));
app.use('/api/v1', createClaimCashRefundRouter({ prisma,
    uploadDir: UPLOAD_DIR,
    privateFilesDir: path.resolve(path.dirname(UPLOAD_DIR), 'private-credit-note-refunds'),
    assertCreditNoteVisible: assertClaimCreditNoteVisibility,
}));
app.use('/api/v1', createClaimCashRefundReturnRouter({ prisma,
    uploadDir: UPLOAD_DIR,
    privateFilesDir: path.resolve(path.dirname(UPLOAD_DIR), 'private-credit-note-refunds'),
    assertCreditNoteVisible: assertClaimCreditNoteVisibility,
}));
// DR-017 审批决议钩子（DE-3）：审批通过自动生成付款凭证（进程内总线 best-effort，issue-voucher 端点手动兜底）
registerPaymentRequestApprovalHook({ prisma });

// 阶段 D / D6：实体级审计查询（普通用户按 targetType+targetId，模块读权限门禁）
app.use(
    '/api/v1/audit',
    (req, res, next) => createAuditRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/procurement',
    (req, res, next) => createProcurementRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/inventory',
    (req, res, next) => createInventoryRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/bom',
    (req, res, next) => createBOMRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/crm',
    (req, res, next) => createCrmRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/crm',
    (req, res, next) => createCrmV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/mes',
    (req, res, next) => createMesRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/suppliers',
    (req, res, next) => createSupplierRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// REQ2-07 历史数据批量迁移（跨 relations/orders/invoices 独立域，DR-049-③）
app.use(
    '/api/v1/data-migration',
    (req, res, next) => createDataMigrationRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/suppliers',
    (req, res, next) => createSuppliersV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/seasons',
    (req, res, next) => createSeasonRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/seasons',
    (req, res, next) => createSeasonsV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v2/marketing',
    (req, res, next) => createMarketingV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/risk',
    (req, res, next) => createRiskRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// 阶段 P0 回补：业务线注册与订单 MOQ 软校验（PRD 6.2）
app.use(
    '/api/v1/business-lines',
    (req, res, next) => createBusinessLineRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// 阶段 P0 回补：QC 驻地 / 验货任务 / QC 工作台（PRD 6.2 / 4.2）
// REQ2-04：privateFilesDir 供第三方测试报告 PDF 落盘（安全收口：私有根而非
// /api/uploads 静态根；uploadDir 仅作迁移前存量文件的回读兜底传入）
app.use(
    '/api/v1/qc',
    (req, res, next) => createQcRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        privateFilesDir: PRIVATE_FILES_DIR,
        uploadDir: UPLOAD_DIR,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// 阶段 P1：退税率表 / 退税美元定价（轨道 B）/ 订单利润表 / 原材料价格（PRD 8 / 6.2 P1）
app.use(
    '/api/v1/pricing/order-cost-reviews',
    (req, res, next) => createOrderCostReviewRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/pricing',
    (req, res, next) => createPricingRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/customs',
    (req, res, next) => createCustomsRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v2/customs',
    (req, res, next) => createCustomsV2Router({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

// 阶段 P3a：单据模板（PRD 11.3 DocumentTemplate）
app.use(
    '/api/v1/document-templates',
    (req, res, next) => createDocumentTemplateRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/templates',
    (req, res, next) => createTemplatesRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/system-assets',
    (req, res, next) => createSystemAssetsRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        uploadDir: UPLOAD_DIR,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/pdml',
    (req, res, next) => createPdmlRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

app.use(
    '/api/v1/entities',
    (req, res, next) => createEntitiesRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
    })(req, res, next),
);

app.use(
    '/api/v1/business-profiles',
    (req, res, next) => createBusinessProfilesRouter({
        prisma,
        requireAuth: SDK_CONFIG.requireAuth,
        apiKeys: SDK_CONFIG.apiKeys,
        onDataChange: publishDataChange,
    })(req, res, next),
);

// Phase 0 Sprint 1: 通知系统路由（鉴权后挂载，要求 actor.userId）
app.use(
    '/api/v1/notifications',
    (req, res, next) => {
        // 共用 sdkAuth 中间件链
        sdkAuth(req, res, () => {
            createNotificationsRouter()(req, res, next);
        });
    },
);

// ── 自动化规则 API ──
app.use(
    '/api/v1/automation',
    (req, res, next) => {
        sdkAuth(req, res, () => {
            createAutomationRouter(prisma)(req, res, next);
        });
    },
);

// ── 系统配置 API（W7 设置域：company.exporterProfile 服务端化，唯一写入口）──
app.use(
    '/api/v1/config',
    (req, res, next) => {
        sdkAuth(req, res, () => {
            createSystemConfigRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth })(req, res, next);
        });
    },
);

// ── 市场行情人工录入 API（羊毛 / 亚麻；市场上无实时价 ⇒ 业务方自助维护）──
app.use(
    '/api/v1/market',
    (req, res, next) => {
        sdkAuth(req, res, () => {
            createMarketQuoteRouter({ prisma, requireAuth: SDK_CONFIG.requireAuth })(req, res, next);
        });
    },
);

// ── 工作流引擎 API（Phase 0 Sprint 2）──
app.use(
    '/api/v1/workflow',
    (req, res, next) => {
        sdkAuth(req, res, () => {
            createWorkflowRouter(prisma)(req, res, next);
        });
    },
);

// ------------------------------------------------------------------
// Universal Web Tools - 联网搜索与阅读代理
// ------------------------------------------------------------------

// P0-1 SSRF 防护（2026-09-15 重写，详见 server/src/lib/ssrfGuard.ts）。
// 原实现只校「初始 URL 字符串」，实测两个绕过：
//   ① 外网 302 → http://127.0.0.1:9999/，读到内网标记服务响应；
//   ② http://[::ffff:127.0.0.1]:8081/ 未被拦截且请求到达本机服务。
// 现收口为：地址字面量判定 + DNS 解析判定 + 逐跳重定向校验。

// 搜索代理 - 使用 DuckDuckGo HTML 版 (稳定且无 Key)
// 我们解析 HTML 版而不是使用 API，因为 HTML 版包含更丰富的实时结果 (天气、新闻)
// P0-2 安全收紧：外联代理此前无鉴权即可调用（可被滥用为开放代理）——挂 sdkAuth 登录门。
app.get('/api/search', sdkAuth, async (req, res) => {
    const query = req.query.q as string;
    if (!query) return res.status(400).json({ error: "Missing query parameter 'q'" });

    logger.info(`🔍 [Search Proxy] Query: "${query}"`);
    try {
        const params = new URLSearchParams({
            q: query,
            kl: 'cn-zh', // 地区：中国 (关键！否则很多中文结果出不来)
            df: 'w',     // 时间范围：本周 (可选，默认不限)
        });

        // 模拟真实浏览器 Header，避免被判定为机器人
        const response = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
            throw new Error(`DuckDuckGo returned ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);
        const results: any[] = [];

        // 解析搜索结果
        $('.result').each((i, el) => {
            if (i >= 8) return; // 限制返回数量

            const title = $(el).find('.result__title .result__a').text().trim();
            let url = $(el).find('.result__title .result__a').attr('href');
            let content = $(el).find('.result__snippet').text().trim();

            if (url && url.startsWith('//')) {
                url = 'https:' + url;
            }

            if (title && url) {
                results.push({
                    title,
                    url,
                    content
                });
            }
        });

        logger.info(`[Search Proxy] Found ${results.length} results via scraping.`);

        if (results.length === 0) {
            // Check for zero-click abstract (sometimes distinct structure)
            // But for now, just return empty
        }

        if (results.length === 0) {
            return res.json({
                query,
                source: 'ddg-empty',
                results: [{ title: 'No results found', url: '', content: 'DuckDuckGo did not return any results. This might be due to network blocking or no info found.' }]
            });
        }

        res.json({
            query,
            source: 'duckduckgo-html',
            results
        });

    } catch (error: any) {
        logger.error('[Search Proxy] Error', { error: error?.message || String(error) });
        res.status(500).json({ error: `Search failed: ${error.message}` });
    }
});

// URL 内容代理 - 绕过 CORS 获取任意网页内容
// P0-1 安全收紧：此前无鉴权 + 无 SSRF 防护（可抓内网/回读本机端点）——挂 sdkAuth 登录门
// + URL 白名单校验（仅 http/https，拒绝回环/内网网段）。
// 2026-09-15 再收紧：改用 assertPublicUrl（含 DNS 判定）+ safeFetch（重定向逐跳校验）。
app.get('/api/fetch-url', sdkAuth, async (req, res) => {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: "Missing 'url' parameter" });

    const blocked = await assertPublicUrl(url);
    if (blocked) return res.status(400).json({ error: blocked });

    logger.info(`📖 [URL Proxy] Fetching: ${url}`);

    try {
        const response = await safeFetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
            },
            signal: AbortSignal.timeout(15000)
        }, { maxRedirects: 3 });

        if (!response.ok) {
            throw new Error(`Target returned ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') || '';
        const html = await response.text();

        res.json({
            url,
            contentType,
            content: html,
            length: html.length
        });

    } catch (error: any) {
        logger.error('[URL Proxy] Error', { error: error?.message || String(error) });
        // 按错误类型分诊（勿再踩 #11：错误分类靠类型不靠文案）：
        // 重定向后的目标落在内网 → 仍是「请求方的问题」，回 400 而不是 500。
        if (error instanceof SsrfBlockedError) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: `Fetch failed: ${error.message}` });
    }
});


// ------------------------------------------------------------------
// Email Service — extracted to server/src/email/route.ts (Phase 4a)
// ------------------------------------------------------------------
app.use('/api/v1/email', createEmailRouter({
    prisma,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
}));
// F5 邮件智能化：业务场景模板库（PRD 12.1）
app.use('/api/v1/email-templates', createEmailTemplateRouter({
    prisma,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
}));
// 阶段 P3b：邮件签名管理（PRD 12.1 EmailSignature）
app.use('/api/v1/email-signatures', createEmailSignatureRouter({
    prisma,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
    onDataChange: publishDataChange,
}));
// §10.3-9 电子签·印章库（Seal）：印章含公司公章图，敏感，强制 JWT-only（空 apiKeys）
app.use('/api/v1/seals', createSealRouter({
    prisma,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: new Set(),
    onDataChange: publishDataChange,
}));
// Legacy IMAP proxy routes remain under /api/email for frontend compat
app.use('/api/email', createEmailRouter({
    prisma,
    requireAuth: SDK_CONFIG.requireAuth,
    apiKeys: SDK_CONFIG.apiKeys,
}));

// ------------------------------------------------------------------
// Market Data API - 真实大宗商品价格
// ------------------------------------------------------------------

// 棉花期货 API (ICE Futures)
// P1-7 安全收紧：行情端点此前无鉴权即可调用——挂 sdkAuth 登录门（行情低敏，登录即可）。
app.get('/api/market/cotton', sdkAuth, async (req, res) => {
    try {
        // 使用 Yahoo Finance API 获取棉花期货
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CT=F?interval=1d&range=1d', {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        if (!response.ok) throw new Error('Failed to fetch cotton data');
        
        const data = await response.json();
        const quote = data?.chart?.result?.[0]?.meta;
        
        if (quote) {
            // CT=F 是棉花期货合约，价格单位是美分/磅
            res.json({
                status: 'success',
                symbol: 'CT=F',
                price: quote.regularMarketPrice,
                previousClose: quote.previousClose || quote.chartPreviousClose,
                currency: 'US cents/lb',
                timestamp: quote.regularMarketTime
            });
        } else {
            throw new Error('No quote data');
        }
    } catch (e: any) {
        logger.error('Cotton API error', { error: e?.message || String(e) });
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// 羊毛期货 API (Australian Wool)
// P1-7 安全收紧：行情端点此前无鉴权即可调用——挂 sdkAuth 登录门（行情低敏，登录即可）。
app.get('/api/market/wool', sdkAuth, async (req, res) => {
    try {
        // 使用 Yahoo Finance 获取羊毛相关 ETF 或指标
        // EMI (Eastern Market Indicator) 是澳大利亚羊毛价格指数
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/WOLLF?interval=1d&range=1d', {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const data = await response.json();
        const quote = data?.chart?.result?.[0]?.meta;
        
        if (quote && quote.regularMarketPrice > 0) {
            res.json({
                status: 'success',
                symbol: 'EMI (Wool)',
                price: quote.regularMarketPrice,
                currency: 'AUD/kg',
                timestamp: quote.regularMarketTime
            });
        } else {
            // 如果找不到羊毛 ETF，返回估算值
            res.json({
                status: 'estimated',
                symbol: 'EMI (Est.)',
                price: 14.50, // 基于历史的估算值 (AUD/kg)
                currency: 'AUD/kg',
                note: 'Real-time wool prices require specialized commodity terminals'
            });
        }
    } catch (e: any) {
        logger.error('Wool API error', { error: e?.message || String(e) });
        res.json({
            status: 'estimated',
            symbol: 'EMI (Est.)',
            price: 14.50,
            currency: 'AUD/kg'
        });
    }
});


// ------------------------------------------------------------------
// [DELETED] /api/po/* routes — data migrated to Postgres (/api/v1/orders).
// ------------------------------------------------------------------

interface ShippingNoticeOptions {
    contractNo?: string;
    supplier?: string;
    payerName?: string;
    payerAddress?: string;
    paymentTerms?: string;
    departurePort?: string;
    destinationPort?: string;
    shippingMethod?: string;
    shipmentDate?: string;
    consigneeName?: string;
    consigneeAddress?: string;
    notifyPartyName?: string;
    notifyPartyAddress?: string;
    forwarder?: string;
    customsDocs?: string;
    blRequirement?: string;
    packaging?: string;
    remarks?: string;
    itemRemarks?: string;
}

const DEFAULT_SUPPLIER = process.env.BAMBOOK_COMPANY_NAME_EN || 'JIANGSU PANDA CLOTHING CO.,LTD.';
const DEFAULT_DEPARTURE_PORT = 'SHANGHAI';
const DEFAULT_SHIPPING_METHOD = 'SEA';
const DEFAULT_BL_REQUIREMENT = '电放或正本提单按客户通知';
const DEFAULT_PACKAGING = 'ROLL PACKING';

const getPaymentTerms = (customerName?: string | null): string => {
    const customer = (customerName || '').toLowerCase();
    if (customer.includes('peerless')) return 'TT 60DAYS';
    return 'TT 30DAYS';
};

const createShippingNoticeExcel = (shippingData: any, filename: string): string => {
    // B11 收编：发货通知改走 xlsxExport 通用基建（双 sheet——通知头键值表 + 明细表），
    // 消除直接 XLSX 库调用的孤点；落盘路径与下载 URL 契约不变。
    const headerSheet: XlsxSheet = {
        name: 'Shipping Notice',
        columnLabels: ['项目 Item', '内容 Content'],
        columns: ['item', 'content'],
        rows: [
            { item: 'Contract No.', content: shippingData.contractNo || '' },
            { item: 'PO Numbers', content: (shippingData.poNumbers || []).join(', ') },
            { item: 'Supplier', content: shippingData.supplier || '' },
            { item: 'Payer', content: shippingData.payer?.name || '' },
            { item: 'Payment Terms', content: shippingData.paymentTerms || '' },
            { item: 'Departure Port', content: shippingData.departurePort || '' },
            { item: 'Destination Port', content: shippingData.destinationPort || '' },
            { item: 'Shipping Method', content: shippingData.shippingMethod || '' },
            { item: 'Shipment Date', content: shippingData.shipmentDate || '' },
            { item: 'Forwarder', content: shippingData.forwarder || '' },
            { item: 'Customs Docs', content: shippingData.customsDocs || '' },
            { item: 'B/L Requirement', content: shippingData.blRequirement || '' },
            { item: 'Packaging', content: shippingData.packaging || '' },
            { item: 'Remarks', content: shippingData.remarks || '' },
        ],
    };
    const lineSheet: XlsxSheet = {
        name: 'Lines 明细',
        columnLabels: ['PO', 'ZROH', 'Fabric Code', 'Quantity', 'Composition', 'Weight', 'Unit Price', 'Marks', 'Category', 'Purchase Price', 'Supplier'],
        columns: ['po', 'zroh', 'fabricCode', 'quantity', 'composition', 'weight', 'unitPrice', 'marks', 'category', 'purchasePrice', 'supplier'],
        rows: ((shippingData.items || []) as any[]).map(item => ({
            po: item.poNumber || '',
            zroh: item.zroh || '',
            fabricCode: item.fabricCode || '',
            quantity: item.quantity || '',
            composition: item.composition || '',
            weight: item.weight || '',
            unitPrice: item.unitPrice || '',
            marks: item.marks || '',
            category: item.category || '',
            purchasePrice: item.purchasePrice || '',
            supplier: item.supplier || '',
        })),
    };
    const buffer = buildXlsx([headerSheet, lineSheet]);
    const outputPath = path.join(OUTPUT_DIR, path.basename(filename));
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
};

// 发货通知生成 API
app.post('/api/shipping-notice/generate', sdkAuth, async (req, res) => {
    try {
        const { poNumbers, options } = req.body as { poNumbers?: string[]; options?: ShippingNoticeOptions };

        if (!poNumbers || !Array.isArray(poNumbers) || poNumbers.length === 0) {
            return res.status(400).json({ success: false, error: '请提供至少一个 PO 号码' });
        }

        // 从 Prisma (Postgres) 获取订单和明细
        const dbOrders = await prisma.order.findMany({
            where: {
                poNumber: {
                    in: poNumbers
                }
            },
            include: {
                lines: true
            }
        });

        if (dbOrders.length === 0) {
            return res.status(400).json({ success: false, error: '未找到订单' });
        }

        // 将 Prisma Order 转换为 legacy Excel 构建器需要的结构
        const orders = dbOrders.map(o => ({
            po_number: o.poNumber || '',
            supplier_name: o.millName || '',
            customer_name: o.customer || '',
            payment_terms: o.paymentTerms || '',
            supplier_address: o.millAddress || '',
            consignee: o.consigneeName || '',
            currency: o.currency || '',
            order_date: o.poDate || '',
            // 真源：这个 legacy 结构里 `total_amount` 与前端孪生件
            // components/tools/ShippingNoticeGenerator.tsx:150 是同一个字段名（那边早已收敛到
            // orderAmountOf）；这里原先直抄 quoteAmount —— 键名说"总额"、值是报价额。
            total_amount: orderAmountOrNull(o),
            season: o.season || '',
            contact_person: o.contactPerson || '',
            contact_telephone: o.contactPhone || '',
        }));

        // 按 PO 分组明细
        const itemsByPO: Record<string, any[]> = {};
        dbOrders.forEach(o => {
            const poNum = o.poNumber || '';
            itemsByPO[poNum] = o.lines.map(line => {
                const legacyItem = {
                    po_number: poNum,
                    zroh_number: line.materialCode || '',
                    fabric_code: line.millQuality || '',
                    fabric_content: line.cloth || '',
                    gsm: line.weight || '',
                    quantity: line.quantity,
                    unit_price: line.unitPrice || 0,
                    net_value: line.netValue || 0,
                    category: line.category || ''
                };
                return {
                    poNumber: poNum,
                    zroh: legacyItem.zroh_number,
                    fabricCode: legacyItem.fabric_code,
                    quantity: legacyItem.quantity,
                    composition: legacyItem.fabric_content,
                    weight: legacyItem.gsm,
                    unitPrice: legacyItem.unit_price,
                    marks: generatePOMarks(legacyItem),
                    category: legacyItem.category,
                    purchasePrice: legacyItem.net_value,
                    supplier: o.millName || ''
                };
            });
        });

        // 构建发货通知 data
        const shippingData = buildShippingNoticeDataFromPO(orders, itemsByPO, options);

        // 生成文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const poList = poNumbers.slice(0, 3).join('_');
        const filename = `ShippingNotice_${poList}_${timestamp}.xlsx`;

        // 生成 Excel 文件
        const outputPath = createShippingNoticeExcel(shippingData, filename);

        logger.info(`[Shipping Notice] Generated: ${outputPath}`);

        res.json({
            success: true,
            filename,
            downloadUrl: `/api/shipping-notice/download?file=${encodeURIComponent(filename)}`,
            data: shippingData
        });

    } catch (error: any) {
        logger.error('[Shipping Notice Error]', { error: error?.message || String(error) });
        res.status(500).json({ success: false, error: error.message });
    }
});

// 从 PO 数据库构建发货通知数据
function buildShippingNoticeDataFromPO(orders: any[], itemsByPO: Record<string, any[]>, options: ShippingNoticeOptions = {}): any {
    const firstOrder = orders[0];
    if (!firstOrder) {
        throw new Error('No orders provided');
    }

    const allItems = Object.values(itemsByPO).flat();

    return {
        contractNo: options.contractNo || orders.map(o => o.po_number).join('/'),
        poNumbers: orders.map(o => o.po_number),
        supplier: options.supplier || firstOrder.supplier_name || DEFAULT_SUPPLIER,

        payer: {
            name: options.payerName || firstOrder.customer_name,
            address: options.payerAddress || '',
            phone: '',
        },

        paymentTerms: options.paymentTerms || firstOrder.payment_terms || getPaymentTerms(firstOrder.customer_name),
        departurePort: options.departurePort || DEFAULT_DEPARTURE_PORT,
        destinationPort: options.destinationPort || '',
        shippingMethod: options.shippingMethod || DEFAULT_SHIPPING_METHOD,
        shipmentDate: options.shipmentDate || '',

        consignee: {
            name: options.consigneeName || firstOrder.customer_name,
            address: options.consigneeAddress || '',
        },
        notifyParty: {
            name: options.notifyPartyName || firstOrder.customer_name,
            address: options.notifyPartyAddress || '',
        },

        forwarder: options.forwarder || '指定货代，等通知',
        customsDocs: options.customsDocs || '发票 装箱单 提单',
        blRequirement: options.blRequirement || DEFAULT_BL_REQUIREMENT,
        packaging: options.packaging || DEFAULT_PACKAGING,

        remarks: options.remarks || '',
        itemRemarks: options.itemRemarks || '',

        items: allItems,
    };
}

// 生成 PO 唛头
function generatePOMarks(item: any): string {
    return `PO.NO.: ${item.po_number || ''}
ZROH: ${item.zroh_number || ''}
ART NO.: ${item.fabric_code || ''}
COLOR:
CONTENT: ${item.fabric_content || ''}
PIECE NO.:
NET LENGTH:
MADE IN CHINA`;
}

// 下载发货通知文件
app.get('/api/shipping-notice/download', sdkAuth, (req, res) => {
    const { file } = req.query;

    if (!file || typeof file !== 'string') {
        return res.status(400).json({ error: 'Missing file parameter' });
    }

    // 安全检查：只允许文件名，不允许路径
    const safeFilename = path.basename(file);
    const filePath = path.join(OUTPUT_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, safeFilename);
});

// 搜索订单 API
app.post('/api/orders/search', sdkAuth, async (req, res) => {
    try {
        const { keyword } = req.body;

        if (!keyword) {
            return res.json({ orders: [] });
        }

        // 使用 Prisma 搜索订单
        const orders = await prisma.order.findMany({
            where: {
                OR: [
                    { id: { contains: keyword, mode: 'insensitive' } },
                    { customer: { contains: keyword, mode: 'insensitive' } },
                    { millName: { contains: keyword, mode: 'insensitive' } },
                ],
                deletedAt: null
            },
            take: 50,
            orderBy: { updatedAt: 'desc' }
        });

        res.json({ orders });

    } catch (error: any) {
        logger.error('[Order Search Error]', { error: error?.message || String(error) });
        res.status(500).json({ error: error.message });
    }
});

// 综合市场数据 (汇率 + 大宗商品)
// P1-7 安全收紧：行情端点此前无鉴权即可调用——挂 sdkAuth 登录门（行情低敏，登录即可）。
app.get('/api/market/all', sdkAuth, async (_req: Request, res: Response) => {
    try {
        const results: any = {
            status: 'success',
            timestamp: new Date().toISOString(),
            forex: {},
            commodities: {}
        };
        
        // 1. 汇率 —— 唯一真源 `market/forexQuoteService`（读财务 `ExchangeRate` 表）。
        //    此前这里直连 exchangerate-api.com，与财务侧 `fxRateSync` 是两个源；
        //    生产实测同日数值不同（USD 6.72 vs 6.721785）⇒ 已收口，消除「跨页数字一致」隐患。
        //    ★ 表里没有就 `null`，**不回落硬编码、也不去抓第二个源**。
        try {
            // ⚠️ 必须用「业务日」（本地时区）：`ExchangeRate.effectiveDate` 是本地日，
            //    用 UTC 日会在本地 00:00–08:00 把隔夜汇率误判成"当天的"。（见 shared/localDate）
            const todayIso = todayLocalKey();
            const forexQuotes = await fetchForexQuotes(prisma as any);
            results.forex = toForexPayload(forexQuotes, todayIso);
            const missing = forexQuotes.filter((q) => q.rate === null).map((q) => q.currency);
            if (missing.length) logger.warn('Forex quote missing in ExchangeRate table', { missing });
        } catch (e: any) {
            logger.error('Forex quote failed', { error: e?.message || String(e) });
        }

        // 2. 大宗商品 —— 走唯一真源 `market/marketQuoteService`：
        //    棉花 = 新浪财经郑棉 nf_CF0 / 美棉 hf_CT（两个市场都有连续交易 ⇒ 真实时）；
        //    羊毛 / 亚麻 = **外部源自动同步**（`market/autoQuoteSources`：羊毛=IMF 月度，
        //    亚麻=欧洲亚麻联盟季度）⇒ freshness='auto'，前端标出数据所属月份。
        //    ★ 拿不到就 `price=null`，**绝不回落到硬编码**（旧的 15839/97500/87500 会让业务员
        //      把写死的数字当成行情。前端显示「暂无数据」。）
        try {
            const quotes = await fetchCommodityQuotes(getSystemConfigService(prisma));
            for (const q of quotes) {
                const key = q.label.includes('(US)') ? 'cottonUs' : q.key;
                results.commodities[key] = {
                    price: q.price,
                    currency: q.currency,
                    unit: q.unit,
                    asOf: q.asOf,
                    freshness: q.freshness,
                    source: q.source,
                    isEstimate: !q.isReal,
                    // 自动同步源的发布节奏（前端角标「月/季 + 数据月份」，不冒充实时）
                    cadence: q.cadence ?? null,
                    // ★ 数据源自带的环比：前端首次加载拿不到上一期，自算会恒为 0
                    changePct: q.changePct ?? null,
                    ...(q.error ? { unavailableReason: q.error } : {})
                };
            }
        } catch (e: any) {
            logger.error('Commodity quotes failed', { error: e?.message || String(e) });
        }

        res.json(results);
    } catch (e: any) {
        logger.error('Market API error', { error: e?.message || String(e) });
        res.status(500).json({ status: 'error', error: e.message });
    }
});

// =============================================================================
// [DELETED] /api/sdk/* routes — dead code, no frontend callers.
// The real API surface is /api/v1/* (orders, relations, products, import).
// =============================================================================

// 子域名入口 webapp-root（https://bambook.jiangsupanda.com/）：根路径直挂 SPA。
// 与老入口 webapp/（base=/bambook/api/app/，挂 /api/app）双目录并存——两份构建 base 不同不可共用。
// 注意：SPA fallback 的 app.get('*') 必须在全部 API 路由之后注册（本位置即文件末尾 listen 前），
// 否则会劫持 API 路由；/api、/bambook、含扩展名的请求一律放行不进 fallback。
const WEBAPP_ROOT_DIR = path.join(__dirname, '..', 'webapp-root');
if (fs.existsSync(WEBAPP_ROOT_DIR)) {
    app.use(express.static(WEBAPP_ROOT_DIR));
    app.get('/', (_req: Request, res: Response) => {
        res.sendFile(path.join(WEBAPP_ROOT_DIR, 'index.html'));
    });
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
        const p = req.path || '/';
        if (p.startsWith('/api/') || p.startsWith('/bambook/') || p.includes('.')) return next();
        res.sendFile(path.join(WEBAPP_ROOT_DIR, 'index.html'));
    });
}

// ── 全局 4 参错误中间件（Express 4 async 错误三件套之二）────────────
// 挂在全部路由之后（含 SPA fallback）：asyncHandler 包装的路由 reject → next(err)
// 统一在此落日志并映射响应（body-parser 4xx 透传 / P2025 404 / 其余 500 不外泄细节）。
// 注意必须在 listen 之前注册，且任何后续新增路由都要插在本中间件之前。
app.use(globalErrorHandler);

// ── Agent 服务主体装载（§10.4.1：AI = 员工账号）────────────────────
// 先解析完主体再开端口，避免启动瞬间 API-Key 请求被误判为未绑定主体。
loadAgentApiKeyActors(prisma, SDK_CONFIG.apiKeys)
    .then((actors) => {
        for (const [key, actor] of actors) AGENT_API_KEY_ACTORS.set(key, actor as any);
        // 同时注入进程级默认：25+ 个模块路由不接 apiKeyActors 入参，统一从这里取主体
        setDefaultAgentApiKeyActors(actors);
        if (actors.size > 0) {
            logger.info(`[agentPrincipal] 已装载 ${actors.size} 个 Agent 主体（API Key → 员工账号）`);
        } else {
            logger.warn('[agentPrincipal] 未配置 Agent 主体（BAMBOOK_AGENT_API_KEY_MAP / ACTOR_ID），API-Key 调用将被 403');
        }
    })
    .catch((error) => {
        logger.warn(`[agentPrincipal] 装载失败：${error?.message || error}（API-Key 调用将被 403）`);
    })
    .finally(async () => {
        const workflowStartup = await workflowReady;
        if (!workflowStartup.ok) {
            logger.error('[workflow] initialization failed; API startup aborted', { error: workflowStartup.error });
            process.exit(1);
        }
        app.listen({ port: Number(PORT), ...(process.env.BAMBOOK_ACCEPTANCE_SANDBOX ? { host: '127.0.0.1' } : {}) }, () => {
    logger.info(`Sovereign Neural Core Online on port ${PORT}`);
    logger.info('Database Connection: Postgres via Prisma');
    logger.info(`SDK API: ${SDK_CONFIG.requireAuth ? 'Protected (API Key Required)' : 'Open (Local Access)'}`);
    // ★ 2026-09-25 下线：PDF 导入接口未挂载，故不再打印该行（否则启动日志会继续宣称它可用）。
    //   原写法：logger.info(`Import API: POST /api/v1/import/order (auth: ${SDK_CONFIG.requireAuth ? 'required' : 'open'})`);
    logger.info(`Orders API: POST /api/v1/orders/import (controlled migration; data:import + users:admin JWT required)`);
        if (process.env.BAMBOOK_MELO_PREWARM_ON_START === 'true') {
            prewarmMeloTts()
                .then(result => {
                    if (!result.skipped) {
                        logger.info(`[tts] Melo prewarmed in ${result.elapsedMs}ms`);
                    }
                })
                .catch(error => {
                    logger.warn(`[tts] Melo prewarm failed: ${error?.message || error}`);
                });
        }
    });
    });
