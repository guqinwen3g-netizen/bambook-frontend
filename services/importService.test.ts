import { describe, expect, it, vi, afterEach } from 'vitest';

// Mock apiService before importing services（与 serviceRouteAlignment.test.ts 同一范式）
vi.mock('./apiService', () => ({
  apiService: {
    getStoredConfig: () => ({ cloudEndpoint: 'https://test.example.com' }),
    getApiKey: () => 'test-api-key',
    getAuthHeaders: () => ({ 'Content-Type': 'application/json', 'X-Bambook-API-Key': 'test-api-key' }),
    buildApiUrl: (path: string) => `https://test.example.com/api${path}`,
  },
}));

import { updateOrderFields, createManualOrder, deleteOrder } from './importService';

/** 造一个 fetch 应答：ok=false 时走错误分支 */
function mockErrorResponse(body: unknown, status = 400, opts: { notJson?: boolean } = {}) {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => {
      if (opts.notJson) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  })) as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * ★★ 第 2 批 C 连带（2026-09-26）：服务端写的中文说明必须能到屏面。
 *
 * 病根：`services/importService.ts` 的 5 个函数原先读响应体**顶层** `message`，
 *   而本仓服务端（`orders/route.ts` 等）的形状是 `{ ok:false, error:{ code, message } }`
 *   ⇒ 服务端精心写的中文说明**被丢弃**，用户只看到 `Update failed (HTTP 400)`。
 *   本文件是 `services/apiService.ts`（读 `data?.error?.message`）的**唯一例外**。
 *
 * ★ 本组用例的判别力由**突变自检**证明（把 `extractErrorDetail` 退回旧写法 ⇒ 第 1 条咬红）。
 */
describe('importService · 失败响应的人话必须到屏面（第 2 批 C 连带）', () => {
  it('★ 服务端形状 { ok:false, error:{ code, message } } ⇒ 抛出的错误必须带上那句中文', async () => {
    vi.stubGlobal(
      'fetch',
      mockErrorResponse({
        ok: false,
        error: { code: 'ORDER_HAS_NO_LINES', message: '本订单没有任何明细行，无法确定金额来源。' },
      }),
    );

    await expect(updateOrderFields('O1', { contractAmount: 10020 })).rejects.toThrow(
      /本订单没有任何明细行/,
    );
  });

  it('★ 同一条口径覆盖全部 5 个函数（不只是 updateOrderFields）', async () => {
    const serverBody = { ok: false, error: { code: 'X', message: '中文人话在此' } };
    vi.stubGlobal('fetch', mockErrorResponse(serverBody));
    await expect(createManualOrder({})).rejects.toThrow(/中文人话在此/);

    vi.stubGlobal('fetch', mockErrorResponse(serverBody));
    await expect(deleteOrder('O1')).rejects.toThrow(/中文人话在此/);
  });

  it('★ 反面对照：旧形状（顶层 message）仍然可用 —— 兜底不许被改坏', async () => {
    vi.stubGlobal('fetch', mockErrorResponse({ ok: false, message: '旧形状的说明' }));
    await expect(updateOrderFields('O1', {})).rejects.toThrow(/旧形状的说明/);
  });

  it('★ 只有 code 没有 message ⇒ 至少把码带出来（不许只剩 HTTP 状态码）', async () => {
    vi.stubGlobal('fetch', mockErrorResponse({ ok: false, error: { code: 'SOME_CODE' } }));
    await expect(updateOrderFields('O1', {})).rejects.toThrow(/SOME_CODE/);
  });

  it('★ 反面对照：响应体不是 JSON ⇒ 退回只报 HTTP 状态，不许抛二次错', async () => {
    vi.stubGlobal('fetch', mockErrorResponse(null, 502, { notJson: true }));
    await expect(updateOrderFields('O1', {})).rejects.toThrow(/HTTP 502/);
  });
});
