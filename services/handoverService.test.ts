import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handoverService } from './handoverService';

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

describe('handoverService（REQ2-13 离职一键交接 contract，DR-056）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('preview GET /v2/handover/preview（fromUserId 必带；toUserId 可选追加）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({
        fromUser: { id: 'u_from', displayName: '离职业务员', status: 'active' },
        counts: { relationsOwned: 2, relationsCoFollowed: 1, opportunities: 1, followUpRecords: 2, unanchoredOrders: 1 },
        warnings: ['警示一'],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const p = await handoverService.preview('u_from', 'u_to', ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v2/handover/preview?fromUserId=u_from&toUserId=u_to');
    expect(p.counts.relationsOwned).toBe(2);
    expect(p.warnings).toEqual(['警示一']);

    await handoverService.preview('u_from', undefined, ENDPOINT);
    const [url2] = fetchMock.mock.calls[1];
    expect(url2).toContain('/v2/handover/preview?fromUserId=u_from');
    expect(url2).not.toContain('toUserId');
  });

  it('execute POST /v2/handover（携带 fromUserId/toUserId/disableAccount/note）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({
        ok: true,
        handoverId: 'HO__TEST1',
        counts: { relationsOwned: 1, relationsCoFollowed: 0, opportunities: 0, followUpRecords: 0, unanchoredOrders: 0 },
        accountDisabled: true,
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await handoverService.execute({ fromUserId: 'u_from', toUserId: 'u_to', disableAccount: true, note: '测试' }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v2/handover');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ fromUserId: 'u_from', toUserId: 'u_to', disableAccount: true, note: '测试' });
    expect(r.handoverId).toBe('HO__TEST1');
    expect(r.accountDisabled).toBe(true);
  });

  it('listRecords GET /v2/handover/records?limit= 并归一 records 数组', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ records: [{ id: 'HO__1', fromUserName: 'A', toUserName: 'B' }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await handoverService.listRecords(10, ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v2/handover/records?limit=10');
    expect(r.records).toHaveLength(1);
    expect(r.records[0].fromUserName).toBe('A');
  });

  it('失败响应透传 error code 与 HTTP status（不静默）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'FORBIDDEN', message: 'INSUFFICIENT_SCOPE: need one of [users:admin].' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(handoverService.preview('u_from', undefined, ENDPOINT)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });
});
