/**
 * L10 — 调度任务：ERP 邮件自动同步（每 5 分钟）
 *
 * 背景：ERP 邮件同步此前全靠手动点「同步到 ERP」。本任务按 5 分钟节拍自动执行
 * IMAP→DB 同步（复用 syncEmailsFromImap shared service，含审计/去重/自动归档）。
 *
 * 凭据来源（不改 schema）：SystemConfig（scope=global）
 *   - email.autoSync.enabled  (boolean, 默认 false) — 总开关
 *   - email.autoSync.user     (string) — IMAP 账号
 *   - email.autoSync.password (string, encrypted=true) — IMAP 密码（AES-GCM 加密存储，
 *     经 systemConfigService.getString 透明解密；OPS Panel 可维护）
 *   - email.autoSync.host     (string, 可选，默认 imap.qiye.aliyun.com)
 *   - email.autoSync.port     (number, 可选，默认 993)
 * 未启用或未配置凭据时本轮跳过（fail silent + info 日志），不报错、不通知。
 */

import { PrismaClient } from '@prisma/client';
import { ScheduledTask } from '../schedulerService';
import { syncEmailsFromImap } from '../../email/emailSyncService';
import { getSystemConfigService } from '../../config/systemConfigService';
import { logger } from '../../lib/logger';

const RUN_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const SYNC_LIMIT = 100;

export interface EmailAutoSyncDeps {
  syncFn?: typeof syncEmailsFromImap;
  configSvc?: {
    getBoolean: (key: string, fallback?: boolean) => Promise<boolean>;
    getString: (key: string, fallback?: string) => Promise<string>;
    getNumber: (key: string, fallback: number) => Promise<number>;
  };
  now?: () => number;
}

export interface EmailAutoSyncOutcome {
  ran: boolean;
  reason?: 'disabled' | 'missing_credentials';
  synced?: number;
  skipped?: number;
  errors?: number;
  accountMasked?: string;
}

/** 扫描主流程（导出供测试直接驱动） */
export async function runEmailAutoSync(prisma: PrismaClient, deps: EmailAutoSyncDeps = {}): Promise<EmailAutoSyncOutcome> {
  const syncFn = deps.syncFn || syncEmailsFromImap;
  const configSvc = deps.configSvc || getSystemConfigService(prisma);

  const enabled = await configSvc.getBoolean('email.autoSync.enabled', false);
  if (!enabled) {
    logger.info('[EmailAutoSync] skipped: email.autoSync.enabled is off');
    return { ran: false, reason: 'disabled' };
  }

  const user = await configSvc.getString('email.autoSync.user');
  const pass = await configSvc.getString('email.autoSync.password');
  if (!user || !pass) {
    logger.info('[EmailAutoSync] skipped: IMAP credentials not configured in SystemConfig');
    return { ran: false, reason: 'missing_credentials' };
  }

  const host = await configSvc.getString('email.autoSync.host');
  const port = await configSvc.getNumber('email.autoSync.port', 993);

  const result = await syncFn({
    prisma,
    credentials: { user, pass, host: host || undefined, port },
    box: 'INBOX',
    limit: SYNC_LIMIT,
    actorId: 'system:email_auto_sync',
  });

  if (!result.ok) {
    // 同步失败不升级为告警（手动同步仍可用）；错误信息已被 service 层脱敏
    logger.error('[EmailAutoSync] sync failed', { code: result.error?.code, message: result.error?.message });
    return { ran: true, errors: 1 };
  }

  logger.info('[EmailAutoSync] sync done', {
    synced: result.data!.synced, skipped: result.data!.skipped, errors: result.data!.errors,
    account: result.data!.accountMasked,
  });
  return {
    ran: true,
    synced: result.data!.synced,
    skipped: result.data!.skipped,
    errors: result.data!.errors,
    accountMasked: result.data!.accountMasked,
  };
}

export function createEmailAutoSyncTask(): ScheduledTask {
  let lastRunAt = 0;
  return {
    id: 'email_auto_sync',
    timeDomain: 'wall',
    shouldRun: (now: Date) => {
      if (now.getTime() - lastRunAt >= RUN_INTERVAL_MS) {
        lastRunAt = now.getTime();
        return true;
      }
      return false;
    },
    run: async (prisma: PrismaClient) => {
      try {
        await runEmailAutoSync(prisma);
      } catch (e: any) {
        logger.error('[EmailAutoSync] failed', { error: e?.message });
      }
    },
  };
}
