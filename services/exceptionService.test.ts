import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exceptionService,
  openExceptionEntry,
  EXCEPTION_ENTRY_EVENT,
  EXCEPTION_CATEGORIES,
  EXCEPTION_CATEGORY_LABEL,
  EXCEPTION_STATUS_LABEL,
  EXCEPTION_ENTRY_HINT,
} from './exceptionService';

const ENDPOINT = 'https://test.example.com';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => { values.clear(); }),
  };
}

describe('exceptionService（DR-013 受控例外 contract）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('createException POST /v1/exceptions 携带必填 5 字段契约', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({
        exception: { id: 'EXC__1', exceptionNumber: 'EXC-20260816-001', status: 'Pending' },
        approvalRequestId: 'APR__1',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      exceptionCategory: 'shipment_release' as const,
      exceptionReason: '客户产线停线待料，QC 报告仍在途中，风险由责任业务员跟进闭环',
      riskMitigationPlan: '到港后 48 小时内补 QC 终检，不合格全额赔付',
      targetType: 'Shipment',
      targetId: 'SHIP_001',
      action: 'shipment:release',
      responsibleOwnerId: 'USR_owner1',
    };
    const result = await exceptionService.createException(input, ENDPOINT);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/exceptions');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject(input);
    expect(result.approvalRequestId).toBe('APR__1');
    expect(result.exception.exceptionNumber).toBe('EXC-20260816-001');
  });

  it('createException 透出 fail-closed 错误码（EXCEPTION_REASON_TOO_SHORT）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'EXCEPTION_REASON_TOO_SHORT', message: 'exceptionReason 至少 30 字' }),
    })));

    await expect(
      exceptionService.createException({
        exceptionCategory: 'other',
        exceptionReason: '太短',
        riskMitigationPlan: 'plan',
        targetType: 'Order',
        targetId: 'SO_1',
        action: 'order:change',
        responsibleOwnerId: 'USR_x',
      }, ENDPOINT),
    ).rejects.toThrow('exceptionReason 至少 30 字');
  });

  it('listExceptions 拼接 status / exceptionCategory 过滤参数', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ items: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await exceptionService.listExceptions({ status: 'Pending', exceptionCategory: 'moq_exemption', limit: 50 }, ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/exceptions/?');
    expect(url).toContain('status=Pending');
    expect(url).toContain('exceptionCategory=moq_exemption');
    expect(url).toContain('limit=50');
  });

  it('gateCheck GET /v1/exceptions/gate-check 精确三元组（且不被 /:id 捕获）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({
        active: true,
        exception: { id: 'EXC__1', exceptionNumber: 'EXC-20260816-001', bossFinalBypass: true, validUntil: null },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exceptionService.gateCheck({ targetType: 'Shipment', targetId: 'SHIP_001', action: 'shipment:release' }, ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/exceptions/gate-check?');
    expect(url).toContain('targetType=Shipment');
    expect(url).toContain('targetId=SHIP_001');
    expect(url).toContain('action=shipment%3Arelease');
    expect(result.active).toBe(true);
    expect(result.exception?.bossFinalBypass).toBe(true);
  });

  it('withdrawException POST /:id/withdraw', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ exception: { id: 'EXC__1', status: 'Cancelled' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const exc = await exceptionService.withdrawException('EXC__1', ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/exceptions/EXC__1/withdraw');
    expect(init?.method).toBe('POST');
    expect(exc.status).toBe('Cancelled');
  });

  it('bossBypassException POST /:id/boss-bypass 携带 reason；透出 403', async () => {
    const reason = '客户停线损失重大，风险我兜底，特批本例外放行一次';
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ exception: { id: 'EXC__1', status: 'BossFinalBypass', bossFinalBypassBy: 'USR_boss' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const exc = await exceptionService.bossBypassException('EXC__1', reason, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/exceptions/EXC__1/boss-bypass');
    expect(JSON.parse(String(init?.body))).toEqual({ reason });
    expect(exc.status).toBe('BossFinalBypass');

    vi.stubGlobal('fetch', vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'BOSS_BYPASS_REQUIRES_OWNER', message: '仅超级管理员（BOSS）可最终兜底特批受控例外' }),
    })));
    await expect(exceptionService.bossBypassException('EXC__1', reason, ENDPOINT)).rejects.toThrow('BOSS_BYPASS_REQUIRES_OWNER');
  });

  it('类别/状态映射完整且与后端枚举一致', () => {
    expect(EXCEPTION_CATEGORIES).toHaveLength(8);
    for (const c of EXCEPTION_CATEGORIES) {
      expect(EXCEPTION_CATEGORY_LABEL[c]).toBeTruthy();
    }
    for (const s of ['Pending', 'ReviewerApproved', 'ReviewerRejected', 'BossFinalBypass', 'Consumed', 'Expired', 'Cancelled'] as const) {
      expect(EXCEPTION_STATUS_LABEL[s]).toBeTruthy();
    }
    expect(EXCEPTION_ENTRY_HINT).toContain('DR-013');
    expect(EXCEPTION_ENTRY_HINT).toContain('/api/v1/exceptions');
  });

  it('openExceptionEntry 派发 EXCEPTION_ENTRY_EVENT 自定义事件（门禁阻断入口联动）', () => {
    const listeners: any[] = [];
    const addEventListener = vi.fn((name: string, fn: any) => listeners.push([name, fn]));
    const dispatchEvent = vi.fn((event: any) => {
      for (const [name, fn] of listeners) if (name === event.type) fn(event);
      return true;
    });
    vi.stubGlobal('window', { addEventListener, dispatchEvent, CustomEvent: globalThis.CustomEvent });

    const received: any[] = [];
    window.addEventListener(EXCEPTION_ENTRY_EVENT, (e: any) => received.push(e.detail));
    openExceptionEntry({ targetType: 'Shipment', targetId: 'SHIP_001', action: 'shipment:release', gate: 'shipment_release', blockingReasons: ['SS_NOT_CONFIRMED'] });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ targetType: 'Shipment', targetId: 'SHIP_001', action: 'shipment:release' });
  });
});
