# ERP OS 横向闭环验证矩阵

> 刷新任务：ERP-P1-current-state-matrix-refresh-after-email-knowledge-closure（task_mr3hj3d1）
> 基线：main HEAD=ad794e6（2026-07-02）
> 数据来源：代码静态扫描 + 测试文件事实（每条结论有证据路径）

## 四条线定义

| 线 | 含义 | 代码位置 |
|---|---|---|
| **L1 ERP 核心业务** | REST API 独立可用（不依赖 Agent） | `server/src/<module>/route.ts` + `index.ts app.use` |
| **L2 流程级 API/service** | route 与 Agent flow 共用 service，事务/审计同源 | `server/src/<module>/*Service.ts` |
| **L3 Agent 能力** | Agent 智能执行内核复用 L2 service | `server/src/agent/*Flow.ts` + `toolRuntime.ts` |
| **L4 前端操作体验** | 客户端调用层 + UI 操作反馈 | `services/*.ts` + `components/*.tsx` |

## 模块矩阵（10 个核心模块）

| # | 模块 | L1 ERP | L2 service | L3 Agent | L4 前端 | 状态 |
|---|---|---|---|---|---|---|
| 1 | **Relations** | `/api/v1/relations` ✅ | relationMutationService ✅ | relationMutationFlow + relationOnboardFlow ✅ | dataHub 聚合 ✅ | ✅ ERP-Ready |
| 2 | **Products** | `/api/v1/products` ✅ | productAssetMutationService ✅ | productAssetMutationFlow ✅ | dataHub 聚合 ✅ | ✅ ERP-Ready |
| 3 | **Orders** | `/api/v1/orders` + `/api/v1/order-lines` ✅ | orderLifecycleService + orderLineMutationService ✅ | orderLifecycleFlow + orderLineUpdateFlow + orderShipFlow ✅ | orderLineService.ts ✅ | ✅ ERP-Ready |
| 4 | **Finance** | `/api/v1/finance` ✅ | invoiceMutationService + paymentVoucherMutationService + allocationService + voidDeleteService ✅ | invoiceIssueFlow + invoiceCancelFlow + invoiceMutationFlow + paymentVoucherMutationFlow + financeSoftDeleteFlow + reconcileFlow ✅ | invoiceService + paymentVoucherService + allocationService ✅；FinanceManager 已消费 deletePaymentVoucher ✅ | ✅ ERP-Ready |
| 5 | **Shipping** | `/api/v1/shipping` ✅ | shipmentMutationService（deleteShipment 含 deactivateEntityLinks）+ orderLinkService ✅ | orderShipFlow ✅ | shipmentService.ts ✅ | ✅ ERP-Ready |
| 6 | **Development** | `/api/v1/development` ✅ | convertService（convertDevCaseToOrder）+ developmentCaseMutationService ✅ | developmentConvertFlow ✅ | developmentService.ts ✅ | ✅ ERP-Ready |
| 7 | **Import** | `/api/v1/import` ✅ | persistOrders + parseOrderPdf ✅ | — （设计如此） | importService.ts ✅ | ✅ ERP-Ready |
| 8 | **Email** | `/api/v1/email` ✅ | outboxSend(SMTP) + emailOutboxMutationService(compose/reply shared) + **emailSyncService** ✅ | emailReplySendFlow + emailSendOutboxFlow + **emailSyncFlow** ✅ | emailOutboxService + emailSyncService.syncToErp→`/v1/email/sync`(x-bambook-api-key, INBOX映射, password不入localStorage) ✅；emailSyncRuntimeQa + emailSyncUiRealRouteWiring + emailOutboxComposeUiRuntimeQa（compose/reply UI 闭环）✅ | ✅ ERP-Ready |
| 9 | **Entities/PDML** | `/api/v1/entities` + `/api/v1/pdml` + `/api/v1/system-assets` ✅ | registry + sync（deactivateEntityLinks 多模块复用）✅ | — （设计如此） | entityLinksService.ts ✅ | ✅ ERP-Ready |
| 10 | **Knowledge** | `/api/v1/knowledge-documents` + `/bambook/kb/*`（8091）+ **/ingest-text** ✅ | knowledgeApiService + **knowledgeIngestService**（Document+Chunk+Acl+Audit 同事务）✅ | knowledge.search 全链路 ✅ + **knowledgeIngestFlow** ✅ | knowledgeApiService.ts ✅；knowledgeIngestRuntimeQa ✅ | ✅ ERP-Ready |

## 结论

**10/10 核心模块 L1 ERP 独立可用**，L3 Agent 能力线全部闭环（email.sync + knowledge.ingest 的 draft→approval→commit 链路已实现）。ERP OS 不依赖 Agent 即可跑通全部核心业务。

## 缺口 backlog

### ✅ 已闭环（本轮刷新确认）

| 项 | 证据 |
|---|---|
| ~~knowledge.ingest fail-closed~~ | toolRuntime.ts:1792 已实现 draft→approval→commit；knowledgeIngestService.ts（task_mr3g474f）+ knowledgeIngestFlow.ts |
| ~~email.sync fail-closed~~ | toolRuntime.ts:1817 draft→approval→commit；emailSyncService + emailSyncFlow + EmailManager.syncToErp→/v1/email/sync (task_mr3hm7uf) |
| ~~email outbox compose/reply UI 缺失~~ | emailOutboxMutationService (compose/reply shared) + emailOutboxComposeUiRuntimeQa 29/29 闭环 (task_mr3hypc0) |
| ~~knowledge.search 效果评估不足~~ | knowledgeSearchGoldEval.test.ts 8/8 passed（3 gold query × 3 层覆盖） |

### L3 Agent 能力（仍存在但有明确边界）

| 缺口 | 精确状态 | 证据路径 | 建议 owner |
|---|---|---|---|
| 无阻塞 ERP 的 Agent 缺口 | knowledge.ingest/email.sync 已闭环；knowledge.search 有 gold/eval baseline | 见已闭环表 + knowledgeSearchGoldEval.test.ts | — |

### L4 前端体验（设计如此，非缺口）

| 项 | 说明 |
|---|---|
| Relations/Products 经 dataHub 聚合 | 非独立 service 模式，是架构选择 |

## 测试覆盖清单

| 测试 | 覆盖范围 | 证据 |
|---|---|---|
| `erpCrossModuleSmoke.test.ts` | 10 模块 L1 route 真实挂载 + 5 模块 L2 audit/事务边界 + entities sync 多模块复用 | 20/20 passed |
| `knowledgeSearchGoldEval.test.ts` | knowledge.search manifest 注册 + planner 规划 + toolRuntime 执行（3 gold query × 3 来源类型） | 8/8 passed |
| `knowledgeIngestService.test.ts` | ingest service：create success/chunk split/duplicate checksum/invalid input/audit rollback/route 契约/scopes→KnowledgeAcl/Volc 不回退 | 15/15 passed |
| `knowledgeIngestFlow.test.ts` | Agent flow：draft→approval→commit 全链路契约 | 13 tests |
| `emailSyncFlow.test.ts` | Agent flow：draft→approval→commit 全链路契约 | 11 tests |
| `emailOutboxMutationService.test.ts` | compose/reply shared service：draft/send/audit 事务闭环 | 16/16 passed |
| `emailOutboxRoute.test.ts` | compose/reply route→service 契约 | 9/9 passed |
| `emailOutboxComposeUiRuntimeQa.test.ts` | 前端 compose/reply UI wiring runtime QA | 29/29 passed |
| `outboxSend.test.ts` + `outboxSendRoute.test.ts` | 显式 SMTP send 路径（区别于 compose/reply） | passed |
| `knowledgeIngestEmailSyncGapClosure.test.ts` | gap closure 端到端：两个工具不再 fail-closed | 9 tests |
| `knowledgeIngestRuntimeQa.test.ts` | 前端 runtime QA：knowledgeIngest 操作路径与契约对齐 | 40 tests |
| `emailSyncRuntimeQa.test.ts` | 前端 runtime QA：emailSync 操作路径与契约对齐 | 35 tests |
| `emailSyncUiRealRouteWiring.test.ts` | EmailManager→emailSyncService.syncToErp→/v1/email/sync 真实路由 + INBOX映射 + password不写localStorage | 24 tests |
| `demo-seed-safety.smoke.mjs` | demo seed route-backed 安全契约（dry-run/unsafe flag/api-apply） | 8/8 passed |
| Finance soft delete runtime QA | invoice/voucher delete 路径 + FinanceManager 消费 deletePaymentVoucher | passed（financeSoftDeleteRuntimeQa + financeVoidDeleteRuntimeQa） |
| Shipping routeAudit | deleteShipment + deactivateEntityLinks 同事务 | passed（shipping/__tests__/routeAudit.test.ts） |

## 验证命令

```bash
cd server
npx vitest run src/__tests__/erpCrossModuleSmoke.test.ts --no-file-parallelism            # 20/20
npx vitest run src/agent/__tests__/knowledgeSearchGoldEval.test.ts --no-file-parallelism   # 8/8
npx vitest run src/ai/__tests__/knowledgeIngestService.test.ts --no-file-parallelism       # 15/15
node scripts/demo-seed-safety.smoke.mjs                                                    # 8/8
```

## 旧审计文档状态（已 superseded）

以下两个文档是历史审计快照，顶部已加 STALE/SUPERSEDED banner，**不作为当前 backlog 依据**：

| 文档 | 历史基线 | 已推翻的结论 |
|---|---|---|
| `docs/ERP-CORE-READINESS-AUDIT.md` | task_mqxv9b5q | Invoices/Payments Agent-only、死代码、Shipments 404、无审计 |
| `docs/ERP-FRONTEND-MANUAL-PATH-AUDIT.md` | task_mqxv9jb2 (HEAD=42e1ba5) | 完全只读 0 写入、API 路由 404、无审计 |

**当前事实源以本文件（ERP-OS-CROSS-MODULE-SMOKE-MATRIX.md）为准。**
