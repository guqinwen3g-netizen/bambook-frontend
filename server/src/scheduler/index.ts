/**
 * Phase 0 Sprint 2 — 调度器初始化入口
 *
 * 在 server 启动时调用 initializeScheduler(prisma)：
 *   1. 创建 SchedulerService 实例
 *   2. 注册所有调度任务
 *   3. 启动定时循环
 *
 * 调用时序：
 *   1. initializeNotificationBindings(prisma)  — 注入 prisma + 通知订阅
 *   2. registerAllLinkages()                    — 注册联动执行器
 *   3. initializeScheduler(prisma)              — 启动调度器
 */

import { PrismaClient } from '@prisma/client';
import { initializeScheduler } from './schedulerService';
import { createCrashRecoveryTask, createCleanupTask } from './tasks/retryLinkages';
import { createDailyBriefingTask } from './tasks/dailyBriefing';
import { createWeeklyBriefingTask } from './tasks/weeklyBriefing';
import { createStuckProcessDetectorTask } from './tasks/stuckProcessDetector';
import { createExpiryWatchdogTask } from './tasks/expiryWatchdog';
import { createShipmentDelayDetectorTask } from './tasks/shipmentDelayDetector';
import { createReceivableOverdueDetectorTask } from './tasks/receivableOverdueDetector';
import { createInventoryWatchdogTask } from './tasks/inventoryWatchdog';
import { createProductionDeadlineWatchdogTask } from './tasks/productionDeadlineWatchdog';
import { createFactoryCertificationWatchdogTask } from './tasks/factoryCertificationWatchdog';
import { createSeasonReviewWatchdogTask } from './tasks/seasonReviewWatchdog';
import { createCreditRiskWatchdogTask, createQualityRepeatWatchdogTask } from './tasks/riskWatchdog';
import { createSampleDeadlineWatchdogTask } from './tasks/sampleDeadlineWatchdog';
import { createScheduledReportRunnerTask } from './tasks/scheduledReportRunner';
import { createHrLifecycleWatchdogTask } from './tasks/hrLifecycleWatchdog';
import { createCrmFollowUpWatchdogTask } from './tasks/crmFollowUpWatchdog';
import { createLcMaturityWatchdogTask } from './tasks/lcMaturityWatchdog';
// ★ D6：远期结汇合约到期预警（到期日没人管 = 该障碍的一半）
import { createForwardFxMaturityWatchdogTask } from './tasks/forwardFxMaturityWatchdog';
import { createTaxRefundStallWatchdogTask } from './tasks/taxRefundStallWatchdog';
import { createQuotationFollowUpWatchdogTask } from './tasks/quotationFollowUpWatchdog';
import { createPpSampleConfirmationWatchdogTask } from './tasks/ppSampleConfirmationWatchdog';
import { createFactoryVisitWatchdogTask } from './tasks/factoryVisitWatchdog';
import { createDunningStageWatchdogTask } from './tasks/dunningStageWatchdog';
import { createEmailAutoSyncTask } from './tasks/emailAutoSync';
import { createFxRateSyncTask } from './tasks/fxRateSync';
import { createMarketQuoteSyncTask } from './tasks/marketQuoteSync';
import { createCreditRatingReevaluationTask } from './tasks/creditRatingReevaluation';
import { createCustomsComplianceWatchdogTask } from './tasks/customsComplianceWatchdog';
import { logger } from '../lib/logger';

export function startScheduler(prisma: PrismaClient): void {
  const scheduler = initializeScheduler(prisma);

  // 注册调度任务
  scheduler.register(createCrashRecoveryTask());
  scheduler.register(createCleanupTask());
  scheduler.register(createDailyBriefingTask());
  scheduler.register(createStuckProcessDetectorTask());
  scheduler.register(createExpiryWatchdogTask());
  scheduler.register(createShipmentDelayDetectorTask());
  // 阶段 E / E1：主动提醒引擎扩展（应收逾期 / 库存预警 / 生产超期）
  scheduler.register(createReceivableOverdueDetectorTask());
  scheduler.register(createInventoryWatchdogTask());
  scheduler.register(createProductionDeadlineWatchdogTask());
  // 阶段 E / E2：每周经营 briefing（日报已升级为 C1 聚合口径）
  scheduler.register(createWeeklyBriefingTask());
  // 阶段 H / H1c：工厂认证到期 30 天预警（每日）
  scheduler.register(createFactoryCertificationWatchdogTask());
  // 阶段 H / H2：季度结束后自动生成季度回顾（每日）
  scheduler.register(createSeasonReviewWatchdogTask());
  // 阶段 H / H3：信用风险扫描（每日 10:00）+ 重复疵点扫描（每日 10:30）
  scheduler.register(createCreditRiskWatchdogTask());
  scheduler.register(createQualityRepeatWatchdogTask());
  // 阶段 P0 回补：船样 / 匹头样确认追踪预警（每日 11:00，PRD 5.2）
  scheduler.register(createSampleDeadlineWatchdogTask());
  // 阶段 A5：定时报表运行器（每小时扫描，按周期键幂等）
  scheduler.register(createScheduledReportRunnerTask());
  // 阶段 C3：HR 生命周期预警 — 试用转正（前 7 天）/ 合同到期（前 30 天），每日 09:00
  scheduler.register(createHrLifecycleWatchdogTask());
  // 阶段 C1：CRM 跟进逾期预警 — 下次跟进日逾期（7 天升 critical），每日 09:30
  scheduler.register(createCrmFollowUpWatchdogTask());
  // 阶段 C6：信用证三期预警 — 最迟装运/交单/有效期（临近 7 天 warning，逾期 critical），每日 10:00
  scheduler.register(createLcMaturityWatchdogTask());
  // ★ D6：远期结汇合约到期预警（未交割且临近/已逾期 → warning/critical）
  scheduler.register(createForwardFxMaturityWatchdogTask());
  // 阶段 C6：退税滞留预警 — 审核滞留 30/60 天、已批未到账 60/90 天分级，每日 10:30
  scheduler.register(createTaxRefundStallWatchdogTask());
  // PRD 7.1：报价发出 ≥7 天未回复跟进提醒（14 天升 critical），每日 11:30
  scheduler.register(createQuotationFollowUpWatchdogTask());
  // PRD 7.1：厂前样寄出 ≥3 天未确认提醒（开裁前置条件），每日 11:30
  scheduler.register(createPpSampleConfirmationWatchdogTask());
  // PRD 7.1：客户实地验厂到期提醒（前 7 天 warning，前 1 天升 critical），每日 11:30
  scheduler.register(createFactoryVisitWatchdogTask());
  // P0-2：催款分级自动升级（账龄+尾款 → reminder/firm/urgent/legal；升级告警责任人），每日 09:45
  scheduler.register(createDunningStageWatchdogTask());
  // 批次二 L10：ERP 邮件自动同步（每 5 分钟，SystemConfig email.autoSync.* 配置凭据，未启用 fail-silent）
  scheduler.register(createEmailAutoSyncTask());
  // 批次二 M4：汇率外部行情同步（内网离线自动兜底，保留手工录入）
  scheduler.register(createFxRateSyncTask());
  // 2026-09-19：大宗原料行情自动同步（羊毛=IMF 月度 / 亚麻=欧洲亚麻联盟季度）
  // 09:10 起跑 —— 排在汇率同步（08:30）之后，折算用的汇率已落库
  scheduler.register(createMarketQuoteSyncTask());
  // 批次二 M4：信用评级定时重估（每日 09:45，先于 10:00 信用风险扫描）
  scheduler.register(createCreditRatingReevaluationTask());
  // 批次二 M4：新报关单合规检查轮询（每 15 分钟，ComplianceCheck 存在性幂等，停机自愈）
  scheduler.register(createCustomsComplianceWatchdogTask());

  // 启动调度器
  scheduler.start();

  logger.info('[Scheduler] initialized with 28 tasks', {
    tasks: ['crash_recovery', 'cleanup_queued_jobs', 'daily_briefing', 'weekly_briefing', 'stuck_process_detector', 'expiry_watchdog', 'shipment_delay_detector', 'receivable_overdue_detector', 'inventory_watchdog', 'production_deadline_watchdog', 'factory_certification_watchdog', 'season_review_watchdog', 'credit_risk_watchdog', 'quality_repeat_watchdog', 'sample_deadline_watchdog', 'scheduled_report_runner', 'hr_lifecycle_watchdog', 'crm_follow_up_watchdog', 'lc_maturity_watchdog', 'tax_refund_stall_watchdog', 'quotation_follow_up_watchdog', 'pp_sample_confirmation_watchdog', 'factory_visit_watchdog', 'dunning_stage_watchdog', 'email_auto_sync', 'fx_rate_sync', 'credit_rating_reevaluation', 'customs_compliance_watchdog'],
  });
}

export { initializeScheduler, getScheduler } from './schedulerService';
