import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 批次 L（L10）— emailAutoSync 调度任务：ERP 邮件自动同步（每 5 分钟）。
 * 凭据读 SystemConfig（email.autoSync.*），未启用/未配置跳过；失败不抛出（调度器不变量）。
 */

const syncMocks = vi.hoisted(() => ({
  syncEmailsFromImap: vi.fn(),
}));
vi.mock('../../email/emailSyncService', () => ({
  syncEmailsFromImap: (...args: any[]) => syncMocks.syncEmailsFromImap(...args),
}));

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(), error: vi.fn(), warn: vi.fn(),
}));
vi.mock('../../lib/logger', () => ({ logger: loggerMocks }));

const configMocks = vi.hoisted(() => ({
  getBoolean: vi.fn(),
  getString: vi.fn(),
  getNumber: vi.fn(),
}));
vi.mock('../../config/systemConfigService', () => ({
  getSystemConfigService: () => ({
    getBoolean: configMocks.getBoolean,
    getString: configMocks.getString,
    getNumber: configMocks.getNumber,
  }),
}));

import { runEmailAutoSync, createEmailAutoSyncTask } from '../tasks/emailAutoSync';

function configEnabled({ user = 'sales@bambook.com', pass = 'secret', host = 'imap.qiye.aliyun.com', port = 993 } = {}) {
  configMocks.getBoolean.mockImplementation(async (key: string, fallback?: boolean) =>
    key === 'email.autoSync.enabled' ? true : (fallback ?? false));
  configMocks.getString.mockImplementation(async (key: string) => {
    if (key === 'email.autoSync.user') return user;
    if (key === 'email.autoSync.password') return pass;
    if (key === 'email.autoSync.host') return host;
    return '';
  });
  configMocks.getNumber.mockImplementation(async (key: string, fallback: number) =>
    key === 'email.autoSync.port' ? port : fallback);
}

describe('emailAutoSync（L10：ERP 邮件自动同步）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('未启用（email.autoSync.enabled=false）→ 跳过，不调 IMAP 同步', async () => {
    configMocks.getBoolean.mockResolvedValue(false);
    const outcome = await runEmailAutoSync({} as any);
    expect(outcome).toEqual({ ran: false, reason: 'disabled' });
    expect(syncMocks.syncEmailsFromImap).not.toHaveBeenCalled();
  });

  it('已启用但缺凭据 → 跳过 missing_credentials，不调 IMAP 同步', async () => {
    configEnabled({ user: '', pass: '' });
    const outcome = await runEmailAutoSync({} as any);
    expect(outcome).toEqual({ ran: false, reason: 'missing_credentials' });
    expect(syncMocks.syncEmailsFromImap).not.toHaveBeenCalled();
  });

  it('已启用且凭据齐备 → 调 syncEmailsFromImap（INBOX/limit=100/system actor）', async () => {
    configEnabled();
    syncMocks.syncEmailsFromImap.mockResolvedValue({
      ok: true,
      data: { synced: 3, skipped: 2, errors: 0, accountMasked: 'sa***@bambook.com', auditIds: ['a1'] },
    });
    const prisma = {} as any;
    const outcome = await runEmailAutoSync(prisma);
    expect(syncMocks.syncEmailsFromImap).toHaveBeenCalledTimes(1);
    const call = syncMocks.syncEmailsFromImap.mock.calls[0][0];
    expect(call.prisma).toBe(prisma);
    expect(call.credentials).toEqual({ user: 'sales@bambook.com', pass: 'secret', host: 'imap.qiye.aliyun.com', port: 993 });
    expect(call.box).toBe('INBOX');
    expect(call.limit).toBe(100);
    expect(call.actorId).toBe('system:email_auto_sync');
    expect(outcome).toMatchObject({ ran: true, synced: 3, skipped: 2, errors: 0 });
  });

  it('同步失败（ok:false）→ 记录 error 日志，不抛出', async () => {
    configEnabled();
    syncMocks.syncEmailsFromImap.mockResolvedValue({
      ok: false, error: { code: 'IMAP_CONNECT_FAILED', message: 'sanitized' },
    });
    const outcome = await runEmailAutoSync({} as any);
    expect(outcome).toEqual({ ran: true, errors: 1 });
    expect(loggerMocks.error).toHaveBeenCalled();
  });

  it('shouldRun：5 分钟节拍（首次可跑，5 分钟内不重跑，超过 5 分钟再跑）', () => {
    const task = createEmailAutoSyncTask();
    expect(task.id).toBe('email_auto_sync');
    const t0 = new Date('2026-08-28T10:00:00Z');
    expect(task.shouldRun(t0)).toBe(true);
    expect(task.shouldRun(new Date(t0.getTime() + 60_000))).toBe(false);
    expect(task.shouldRun(new Date(t0.getTime() + 4 * 60_000))).toBe(false);
    expect(task.shouldRun(new Date(t0.getTime() + 5 * 60_000))).toBe(true);
  });

  it('run：内部异常被吞掉（调度器不变量：任务失败不抛出）', async () => {
    configMocks.getBoolean.mockRejectedValue(new Error('config table gone'));
    const task = createEmailAutoSyncTask();
    await expect(task.run({} as any)).resolves.toBeUndefined();
    expect(loggerMocks.error).toHaveBeenCalled();
  });
});
