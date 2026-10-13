import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleRoomService } from './sampleRoomService';

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

describe('sampleRoomService（REQ2-16 样品间 contract，DR-057）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('createItem POST /v1/samples/room/items 返回 item', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ ok: true, item: { id: 'SCI__1', code: 'SC-20260820-001', name: '样卡' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const item = await sampleRoomService.createItem({ name: '样卡', cardType: 'fabric' }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/samples/room/items');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ name: '样卡', cardType: 'fabric' });
    expect(item.code).toBe('SC-20260820-001');
  });

  it('listItems GET 带 status/search/code 过滤；loans/return/retire 路径正确', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ ok: true, items: [], total: 0 }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await sampleRoomService.listItems({ status: 'borrowed', search: '苎麻', code: 'SC-1' }, ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('status=borrowed');
    expect(url).toContain('search=');
    expect(url).toContain('code=SC-1');

    await sampleRoomService.returnLoan('SCL__1', '磨损', ENDPOINT);
    const [url2, init2] = fetchMock.mock.calls[1];
    expect(url2).toContain('/v1/samples/room/loans/SCL__1/return');
    expect(init2?.method).toBe('POST');

    await sampleRoomService.retireItem('SCI__1', '报废', ENDPOINT);
    const [url3, init3] = fetchMock.mock.calls[2];
    expect(url3).toContain('/v1/samples/room/items/SCI__1/retire');
    expect(init3?.method).toBe('POST');
  });

  it('createLoan POST items/:id/loans（borrow 带 dueAt / viewing 带 relationId）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ ok: true, loan: { id: 'SCL__1' }, item: { id: 'SCI__1' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await sampleRoomService.createLoan('SCI__1', { loanType: 'viewing', borrowerName: 'Alice', relationId: 'REL-1' }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/samples/room/items/SCI__1/loans');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ loanType: 'viewing', borrowerName: 'Alice', relationId: 'REL-1' });
  });

  it('失败响应透传 error code 与 status', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'LOAN_ALREADY_ACTIVE', message: '样卡已在借中（先归还再借出）' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sampleRoomService.createLoan('SCI__1', { loanType: 'borrow', borrowerName: 'X' }, ENDPOINT))
      .rejects.toMatchObject({ status: 409, code: 'LOAN_ALREADY_ACTIVE' });
  });
});
