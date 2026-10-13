/**
 * Phase C · 任务 C3 — error 级 webhook 告警外发测试
 *
 * 覆盖：
 *   1. 默认无 BAMBOOK_ALERT_WEBHOOK_URL → 不挂载 WebhookAlertTransport（默认关闭）
 *   2. 配置 URL 后 error 日志 → POST JSON 到 webhook（fire-and-forget）
 *   3. 同源消息节流：throttle 窗口内重复 error 只外发一次
 *   4. webhook 故障（reject/abort）→ 不反噬日志管线（logger.error 正常返回）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function importFreshLogger(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of ['BAMBOOK_ALERT_WEBHOOK_URL', 'BAMBOOK_ALERT_THROTTLE_MS', 'BAMBOOK_ALERT_MIN_LEVEL']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return import('../logger');
}

describe('alertWebhook · error 级告警外发', () => {
  it('默认无 BAMBOOK_ALERT_WEBHOOK_URL → 不挂载 webhook transport', async () => {
    const { logger } = await importFreshLogger({ BAMBOOK_ALERT_WEBHOOK_URL: undefined });
    const hasWebhook = logger.transports.some(t => t.constructor.name === 'WebhookAlertTransport');
    expect(hasWebhook).toBe(false);
  });

  it('配置 URL 后 error 日志 → POST JSON 到 webhook', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { logger } = await importFreshLogger({ BAMBOOK_ALERT_WEBHOOK_URL: 'https://hooks.example.com/alert' });

    logger.error('unit-test alert payload', { component: 'TEST', traceId: 't-1' });
    // fire-and-forget：等待 microtask + sendAlert 内的 fetch 调用
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/alert');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      source: 'bambook-main-api',
      level: 'error',
      component: 'TEST',
      traceId: 't-1',
      message: 'unit-test alert payload',
    });
    expect(typeof body.timestamp).toBe('string');
  });

  it('同源消息节流：窗口内重复 error 只外发一次，不同消息各自外发', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { logger } = await importFreshLogger({
      BAMBOOK_ALERT_WEBHOOK_URL: 'https://hooks.example.com/alert',
      BAMBOOK_ALERT_THROTTLE_MS: '60000',
    });

    logger.error('throttled same message', { component: 'TEST' });
    logger.error('throttled same message', { component: 'TEST' });
    logger.error('throttled same message', { component: 'TEST' });
    logger.error('different message', { component: 'TEST' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('webhook 故障 → 不反噬日志管线（不 throw、不 unhandledRejection）', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('webhook down'));
    vi.stubGlobal('fetch', fetchMock);
    const { logger } = await importFreshLogger({ BAMBOOK_ALERT_WEBHOOK_URL: 'https://hooks.example.com/alert' });

    expect(() => logger.error('alert channel failure tolerated', { component: 'TEST' })).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // 等待 catch 分支结算，确认无 unhandledRejection 抛出到测试进程
    await new Promise(resolve => setTimeout(resolve, 20));
  });
});
