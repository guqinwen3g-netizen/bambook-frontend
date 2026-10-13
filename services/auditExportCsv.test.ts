// @vitest-environment jsdom
/**
 * G4.3 变更史导出 · 前端半边（apiService.exportEntityAuditLogsCsv）
 *
 * 测**行为**（打到哪个 URL / 下载用的文件名 / 各类失败怎么抛），不钉实现字面。
 * 反向纪律来自台账里那批"契约测试别钉实现字面"的教训：这里每一条都能被"换一种写法但行为一样"的实现满足。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { apiService } from './apiService';

const realFetch = globalThis.fetch;

function fakeResponse(opts: { ok?: boolean; status?: number; disposition?: string | null } = {}) {
  const { ok = true, status = 200, disposition = null } = opts;
  return {
    ok,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-disposition' ? disposition : null) },
    blob: async () => new Blob(['\ufeff时间,操作人\r\n'], { type: 'text/csv' }),
  } as any;
}

describe('G4.3 exportEntityAuditLogsCsv', () => {
  const anchors: any[] = [];

  beforeEach(() => {
    anchors.length = 0;
    (URL as any).createObjectURL = vi.fn(() => 'blob:fake');
    (URL as any).revokeObjectURL = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: any) => {
      const el = origCreate(tag);
      if (String(tag) === 'a') {
        (el as any).click = vi.fn();
        anchors.push(el);
      }
      return el;
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('① 打到导出端点（带 targetType/targetId），用服务端给的中文文件名下载，并清理 objectURL', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      urls.push(String(url));
      return fakeResponse({
        disposition:
          "attachment; filename=\"change-history-Order-ORD_1.csv\"; filename*=UTF-8''%E5%8F%98%E6%9B%B4%E5%8F%B2-Order-ORD_1.csv",
      });
    }) as any;

    await apiService.exportEntityAuditLogsCsv('Order', 'ORD_1');

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/v1/audit/entity/export?targetType=Order&targetId=ORD_1');
    expect(anchors, '没有触发下载').toHaveLength(1);
    expect(anchors[0].download, '文件名该取服务端 Content-Disposition 里的 filename*（中文不乱码）').toBe(
      '变更史-Order-ORD_1.csv',
    );
    expect(anchors[0].click).toHaveBeenCalledTimes(1);
    expect((URL as any).revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('② 服务端没给 Content-Disposition 时要有兜底文件名（不许下载成 undefined）', async () => {
    globalThis.fetch = (async () => fakeResponse({ disposition: null })) as any;
    await apiService.exportEntityAuditLogsCsv('Shipment', 'SHP_9');
    expect(anchors[0].download).toBe('变更史-Shipment.csv');
  });

  it('③ 403 ⇒ 抛"无权限"语义（与查询端同门禁的可见后果），且**不**触发下载', async () => {
    globalThis.fetch = (async () => fakeResponse({ ok: false, status: 403 })) as any;
    await expect(apiService.exportEntityAuditLogsCsv('Order', 'ORD_1')).rejects.toThrow(/无权限/);
    expect(anchors, '403 还下载了一个空文件 ⇒ 用户以为导出成功了').toHaveLength(0);
  });

  it('④ 其余失败 ⇒ 带上 HTTP 码（便于定位，不许吞成"导出失败"四个字）', async () => {
    globalThis.fetch = (async () => fakeResponse({ ok: false, status: 500 })) as any;
    await expect(apiService.exportEntityAuditLogsCsv('Order', 'ORD_1')).rejects.toThrow(/HTTP 500/);
    expect(anchors).toHaveLength(0);
  });
});
