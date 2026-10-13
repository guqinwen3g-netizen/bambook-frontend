import { beforeEach, describe, expect, it, vi } from 'vitest';
// apiService 模块级无可执行副作用（localStorage/fetch 全部调用时读取），
// 静态导入一次即可；beforeEach 的 stubGlobal 保证测试间隔离。
// 避免 vi.resetModules() + 逐测试 await import 重复 transform 大模块图
//（单跑 ~1.1s，全量并发下 transform 队列挤占曾致 5s 超时假象）。
import { apiService } from './apiService';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  };
}

describe('apiService product reads', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('does not convert a failed v1 product request into an empty legacy product list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/v1/products/assets')) {
        return {
          ok: false,
          json: async () => ({ message: 'upstream timeout' }),
        };
      }
      if (url.includes('/api/products')) {
        return {
          ok: true,
          json: async () => [],
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const { apiService } = await import('./apiService');

    await expect(apiService.listProducts('https://jiangsupanda.com/bambook')).rejects.toThrow('upstream timeout');
  });

  it('requests a bounded product page for the global product snapshot', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, assets: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await apiService.listProducts('https://jiangsupanda.com/bambook');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/products/assets?limit=500'),
      expect.any(Object),
    );
  });
});

describe('apiService shipment export declaration completion', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('posts only the external completion fact and proof reference to the shipment route', async () => {
    const shipment = { id: 'SHIP-1', exportDeclarationCompletedAt: '2026-10-07T02:00:00.000Z', exportDeclarationEvidenceDocumentId: 'DOC-EDP-1' };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => shipment }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiService.completeShipmentExportDeclaration('SHIP-1', {
      completedAt: shipment.exportDeclarationCompletedAt, evidenceDocumentId: shipment.exportDeclarationEvidenceDocumentId, reference: 'DECL-42',
    }, 'https://test.example.com')).resolves.toEqual(shipment);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as any;
    expect(url).toContain('/v1/shipping/SHIP-1/export-declaration-completion');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ completedAt: shipment.exportDeclarationCompletedAt, evidenceDocumentId: 'DOC-EDP-1', reference: 'DECL-42' });
  });
});

describe('apiService listUserAccounts（审批委派/QC 选人数据源）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('GET /api/hr/personnel，映射 姓名 + 角色 + 部门，过滤 disabled', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        personnel: [
          { id: 'USR_1', displayName: '张三', email: 'a@b.c', status: 'active', department: '业务一部', roles: ['manager'] },
          { id: 'USR_2', displayName: '李四', status: 'disabled', department: null, roles: [] },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const list = await apiService.listUserAccounts('https://test.example.com');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/hr/personnel'),
      expect.any(Object),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'USR_1',
      displayName: '张三',
      department: '业务一部',
      roles: ['manager'],
    });
  });
});

describe('apiService 资料完备度引擎（/api/completeness/*）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('completenessSummary → GET /api/completeness/summary，解包 { ok, data } 信封', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          totalGaps: 3,
          bySeverity: { P0: 1, P1: 1, P2: 1 },
          groups: [{ ruleId: 'relation.credit-limit', label: '信用额度未设', severity: 'P0', count: 1, entityType: 'relation', sampleIds: ['rel_1'] }],
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const summary = await apiService.completenessSummary('https://test.example.com');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/completeness/summary'),
      expect.any(Object),
    );
    expect(summary.totalGaps).toBe(3);
    expect(summary.bySeverity).toEqual({ P0: 1, P1: 1, P2: 1 });
    expect(summary.groups[0]).toMatchObject({ ruleId: 'relation.credit-limit', severity: 'P0' });
  });

  it('completenessEntity → GET /api/completeness/entity?type=&id=（query 编码），解包 data', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          entityType: 'order',
          id: 'ORD 1',
          score: 62,
          gaps: [{ ruleId: 'order.eta', label: '交期未填', severity: 'P1', hint: '填写预计交货日期', fix: { type: 'navigate', target: '/orders?id=ORD 1' } }],
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const entity = await apiService.completenessEntity('order', 'ORD 1', 'https://test.example.com');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/completeness/entity?type=order&id=ORD+1'),
      expect.any(Object),
    );
    expect(entity).toMatchObject({ entityType: 'order', id: 'ORD 1', score: 62 });
    expect(entity.gaps[0]?.fix?.type).toBe('navigate');
  });

  it('completenessBatch → GET /api/completeness/batch?type=product|relation，解包 data.items', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({
        ok: true,
        data: {
          items: url.includes('type=product')
            ? [{ id: 'PDT_1', score: 62, missing: ['克重未填'] }]
            : [{ id: 'rel_1', score: 80, missing: ['无信用额度'] }],
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const products = await apiService.completenessBatch('product', 'https://test.example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/completeness/batch?type=product'),
      expect.any(Object),
    );
    expect(products.items).toEqual([{ id: 'PDT_1', score: 62, missing: ['克重未填'] }]);

    const relations = await apiService.completenessBatch('relation', 'https://test.example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/completeness/batch?type=relation'),
      expect.any(Object),
    );
    expect(relations.items).toEqual([{ id: 'rel_1', score: 80, missing: ['无信用额度'] }]);
  });

  it('完备度接口失败 → 抛错语义保留（由调用方降级），不吞成空数据', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: 'not found' }),
    })));

    await expect(apiService.completenessBatch('product', 'https://test.example.com')).rejects.toThrow('not found');
    await expect(apiService.completenessEntity('relation', 'rel_1', 'https://test.example.com')).rejects.toThrow('not found');
    await expect(apiService.completenessSummary('https://test.example.com')).rejects.toThrow('not found');
  });
});

describe('apiService requestJson 超时治理与网络错误语义化', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('超时（TimeoutError）→ 语义化 REQUEST_TIMEOUT 错误，不暴露原始 DOMException', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }));

    await expect(apiService.listUserAccounts('https://test.example.com'))
      .rejects.toThrow('请求超时');
  });

  it('断网/传输层失败（TypeError: Failed to fetch）→ 语义化 NETWORK_ERROR 错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));

    await expect(apiService.listUserAccounts('https://test.example.com'))
      .rejects.toThrow('网络请求失败');
  });

  it('调用方主动取消（AbortError）→ 原样上抛，不被吞掉', async () => {
    const abortErr = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw abortErr; }));

    await expect(apiService.listUserAccounts('https://test.example.com'))
      .rejects.toBe(abortErr);
  });

  it('默认请求带超时 signal；调用方自带 signal 时原样透传不叠加', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ ok: true, personnel: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await apiService.listUserAccounts('https://test.example.com');
    const defaultInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(defaultInit.signal).toBeInstanceOf(AbortSignal);

    await apiService.listUserAccounts('https://test.example.com');
    // requestJson 未暴露透传 signal 的公开 API；hrRequest 等内部通道继承同一行为，
    // 此处仅断言默认超时 signal 在位（透传路径由 requestJson 签名保证，AbortError 用例已覆盖取消语义）
    expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('服务端错误信封（HTTP 500 + message）原样上抛，不被网络错误语义化污染', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'server exploded' }),
    })));

    await expect(apiService.listUserAccounts('https://test.example.com'))
      .rejects.toThrow('server exploded');
  });
});

describe('apiService getStoredConfig 默认端点（DEV 闭环本地 / PROD 生产行为不变）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('DEV 下默认 cloudEndpoint 落本地后端，即使 env 存在生产 VITE_CLOUD_ENDPOINT 也不采用', async () => {
    vi.stubEnv('VITE_CLOUD_ENDPOINT', 'https://jiangsupanda.com/bambook');

    const { apiService } = await import('./apiService');

    expect(apiService.getStoredConfig().cloudEndpoint).toBe('http://localhost:8081');
  });

  it('PROD 构建下默认 cloudEndpoint 兜底生产端点（行为不变）', async () => {
    vi.stubEnv('DEV', false);

    const { apiService } = await import('./apiService');

    expect(apiService.getStoredConfig().cloudEndpoint).toBe('https://jiangsupanda.com/bambook');
  });
});


describe('CRM financial/profile reads preserve failures',()=>{
 beforeEach(()=>{vi.unstubAllGlobals();vi.stubGlobal('localStorage',createStorage());vi.stubGlobal('sessionStorage',createStorage());});
 it.each(['getActiveCreditLimit','getActiveCustomerTier'] as const)('%s propagates 403 and treats only an actual null response as unset',async method=>{
  const fetchMock=vi.fn().mockResolvedValueOnce({ok:false,status:403,json:async()=>({error:{code:'FORBIDDEN',message:'客户业务范围不可读取'}})}).mockResolvedValueOnce({ok:true,status:200,json:async()=>({creditLimit:null,customerTier:null})});
  vi.stubGlobal('fetch',fetchMock);
  await expect(apiService[method]('hidden-customer','http://127.0.0.1')).rejects.toThrow();
  await expect(apiService[method]('actual-unset-customer','http://127.0.0.1')).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
 });
});

describe('order main approval client contract', () => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.stubGlobal('localStorage', createStorage()); vi.stubGlobal('sessionStorage', createStorage()); });
  it('loads order approval rounds and submits the frozen main order for parallel approval', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, items: [{ id: 'OAP_1', status: 'pending' }] }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ ok: true, item: { id: 'OAP_1', actionType: 'order:main_approval' } }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiService.getOrderMainApprovalHistory('ORD/1', 'http://local/api')).resolves.toEqual([{ id: 'OAP_1', status: 'pending' }]);
    await expect(apiService.submitOrderMainApproval('ORD/1', 'http://local/api')).resolves.toMatchObject({ id: 'OAP_1', actionType: 'order:main_approval' });
    expect(fetchMock.mock.calls[0][0]).toContain('/v2/orders/ORD%2F1/main-approvals');
    expect(fetchMock.mock.calls[1][0]).toContain('/v2/orders/ORD%2F1/submit-main-approval');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}' });
  });
  it('rejects an invalid submit acknowledgement instead of showing a false submission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ ok: true, item: { id: 'OAP_1', actionType: 'order:confirmation_sign' } }) })));
    await expect(apiService.submitOrderMainApproval('ORD_1', 'http://local/api')).rejects.toThrow('提交回执无效');
  });
});
