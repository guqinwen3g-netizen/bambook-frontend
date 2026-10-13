import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { techPackService } from './techPackService';

const ENDPOINT = 'https://test.example.com';
const panelSource = readFileSync(new URL('../components/orders/TechPackPanel.tsx', import.meta.url), 'utf8');
const orderManagerSource = readFileSync(new URL('../components/OrderManager.tsx', import.meta.url), 'utf8');

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => { values.clear(); }),
  };
}

describe('techPackService（REQ2-18 contract，DR-059）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('parse 文本通道 POST JSON { text }', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ parsed: { styleNo: 'ST-1' }, fileName: null, sourceType: 'text' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await techPackService.parse('ORD-1', { text: 'Style No: ST-1 ...' }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v2/orders/ORD-1/techpack/parse');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'Style No: ST-1 ...' });
    expect(r.parsed.styleNo).toBe('ST-1');
  });

  it('save POST parsed + apply；get 回读快照；fileUrl 生成下载链接', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: true,
      json: async () => ({ ok: true, order: { id: 'ORD-1' }, applied: ['product', 'quantity'] }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await techPackService.save('ORD-1', { parsed: { styleNo: 'ST-1' }, apply: { product: 'ST-1', quantity: 600 } }, ENDPOINT);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v2/orders/ORD-1/techpack');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body.apply).toEqual({ product: 'ST-1', quantity: 600 });
    expect(r.applied).toEqual(['product', 'quantity']);

    expect(techPackService.fileUrl('ORD-1', ENDPOINT)).toContain('/v2/orders/ORD-1/techpack/file');
  });

  it('失败响应透传（NO_TEXT_LAYER → 422）', async () => {
    const fetchMock = vi.fn(async (..._args: any[]) => ({
      ok: false,
      status: 422,
      json: async () => ({ error: 'NO_TEXT_LAYER', message: 'PDF 无有效文本层——扫描件需 OCR' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(techPackService.parse('ORD-1', { text: 'x' }, ENDPOINT))
      .rejects.toMatchObject({ status: 422, code: 'NO_TEXT_LAYER' });
  });
});

describe('TechPackPanel REQ2-18（DR-059 UI 契约）', () => {
  it('双通道入口：上传 PDF + 粘贴文本；解析预览不落库提示', () => {
    expect(panelSource).toContain('上传规格书解析');
    expect(panelSource).toContain('粘贴文本');
    expect(panelSource).toContain('解析预览（保存前不落库）');
    expect(panelSource).toContain('type="file"');
  });

  it('逐字段置信度徽章 + 回填勾选（现值为空才默认勾选，不盲写）', () => {
    expect(panelSource).toContain("CONFIDENCE_LABELS[conf] ?? conf");
    expect(panelSource).toContain('回填{current != null && current !== \'\' ? `（覆盖现值 ${String(current)}）` : \'\'}');
    expect(panelSource).toContain("!order?.product");
    expect(panelSource).toContain('!order?.quantity');
  });

  it('保存前 bdsConfirm（覆盖字段明示）+ 保存后刷新', () => {
    expect(panelSource).toContain("'保存 Tech Pack 并回填'");
    expect(panelSource).toContain('将覆盖现有字段');
    expect(panelSource).toContain('onOrderUpdated?.()');
    expect(panelSource).toContain('techPackService.save(orderId,');
  });

  it('已存快照六格摘要 + 尺码分布 chips + 附件下载', () => {
    expect(panelSource).toContain('已存快照');
    expect(panelSource).toContain('尺码分布');
    expect(panelSource).toContain('下载附件');
    expect(panelSource).toContain('techPackService.fileUrl(orderId)');
  });

  it('挂载：OrderManager 订单详情仅 Garment 类型显示（成衣线优先）', () => {
    expect(orderManagerSource).toContain("import { TechPackPanel } from './orders/TechPackPanel'");
    expect(orderManagerSource).toContain("selectedOrder.type === 'Garment' && (");
    expect(orderManagerSource).toContain('id="order-detail-techpack"');
    expect(orderManagerSource).toContain('REQ2-18 Tech Pack 结构化解析');
  });
});
