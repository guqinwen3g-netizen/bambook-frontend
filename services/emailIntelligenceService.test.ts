import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emailIntelligenceService,
  extractTemplateVariables,
  renderEmailTemplate,
  deriveTemplateVars,
} from './emailIntelligenceService';

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

describe('emailIntelligenceService · F5 意图可视化', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('fetchEmailIntents 按 mailbox+uids 聚合为 uid→info 映射', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        ok: true,
        items: [
          { uid: 11, intent: 'inquiry', customerSignal: 'positive', summary: '询价 3 款' },
          { uid: 12, intent: 'complaint', customerSignal: null, summary: null },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const map = await emailIntelligenceService.fetchEmailIntents('INBOX', ['11', '12', '13'], ENDPOINT);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/email/intents');
    expect(url).toContain('mailbox=INBOX');
    expect(url).toContain('uids=11,12,13');
    expect(map['11'].intent).toBe('inquiry');
    expect(map['11'].customerSignal).toBe('positive');
    expect(map['12'].intent).toBe('complaint');
    expect(map['13']).toBeUndefined(); // 未抽取的不出现
  });

  it('空 mailbox / 空 uids 直接返回空映射，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await emailIntelligenceService.fetchEmailIntents('', ['1'], ENDPOINT)).toEqual({});
    expect(await emailIntelligenceService.fetchEmailIntents('INBOX', [], ENDPOINT)).toEqual({});
    expect(await emailIntelligenceService.fetchEmailIntents('INBOX', ['abc', 'OUT__x'], ENDPOINT)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HTTP 失败静默返回空映射（增强层不阻断列表）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect(await emailIntelligenceService.fetchEmailIntents('INBOX', ['1'], ENDPOINT)).toEqual({});
  });

  it('uids 超 200 截断且非数字被过滤', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true, items: [] }) }));
    vi.stubGlobal('fetch', fetchMock);
    const uids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    await emailIntelligenceService.fetchEmailIntents('INBOX', uids, ENDPOINT);
    const [url] = fetchMock.mock.calls[0];
    const uidsParam = decodeURIComponent(String(url).match(/uids=([^&]*)/)![1]);
    expect(uidsParam.split(',')).toHaveLength(200);
  });
});

describe('emailIntelligenceService · F5 模板引擎', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', createStorage());
    vi.stubGlobal('sessionStorage', createStorage());
  });

  it('fetchEmailTemplates 归一化字段并兜底非数组 variables', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        items: [
          { id: 'EMTPL__1', type: 'quote', name: '标准报价函', subject: 'Quote {{quotationNo}}', body: 'Dear {{customerName}}', variables: ['quotationNo', 'customerName'] },
          { id: 'EMTPL__2', type: 'greeting', name: '问候', subject: 'Hi', body: 'Hi', variables: null },
        ],
      }),
    })));
    const items = await emailIntelligenceService.fetchEmailTemplates(ENDPOINT);
    expect(items).toHaveLength(2);
    expect(items[0].variables).toEqual(['quotationNo', 'customerName']);
    expect(items[1].variables).toEqual([]);
  });

  it('extractTemplateVariables 去重且跨 subject+body 合并', () => {
    expect(extractTemplateVariables('Quote {{quotationNo}} for {{customerName}}', 'Dear {{customerName}}, ref {{quotationNo}} and {{orderNo}}'))
      .toEqual(['quotationNo', 'customerName', 'orderNo']);
    expect(extractTemplateVariables('no vars')).toEqual([]);
  });

  it('renderEmailTemplate 替换已给变量，缺失变量保留占位符', () => {
    const tpl = 'Dear {{customerName}}, your order {{orderNo}} ships {{date}}.';
    expect(renderEmailTemplate(tpl, { customerName: 'Alice', orderNo: 'PO-1' }))
      .toBe('Dear Alice, your order PO-1 ships {{date}}.');
  });

  it('deriveTemplateVars 从 Display Name <addr> 提取 customerName，并注入 date/today', () => {
    const vars = deriveTemplateVars({ to: 'Alice Wang <alice@brand.com>' });
    expect(vars.customerName).toBe('Alice Wang');
    expect(vars.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(vars.today).toBe(vars.date);
  });

  it('deriveTemplateVars 裸邮箱回退 @ 前缀', () => {
    expect(deriveTemplateVars({ to: 'buyer@brand.com' }).customerName).toBe('buyer');
    expect(deriveTemplateVars({}).customerName).toBeUndefined();
  });
});
